package checkin

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/itcake/agent/internal/bootperf"
	"github.com/itcake/agent/internal/cis"
	"github.com/itcake/agent/internal/commands"
	"github.com/itcake/agent/internal/config"
	"github.com/itcake/agent/internal/eventlog"
	"github.com/itcake/agent/internal/filescan"
	"github.com/itcake/agent/internal/hwinfo"
	"github.com/itcake/agent/internal/metrics"
	"github.com/itcake/agent/internal/netdisc"
	"github.com/itcake/agent/internal/packages"
	"github.com/itcake/agent/internal/peripheral"
	"github.com/itcake/agent/internal/reliability"
	"github.com/itcake/agent/internal/secscan"
	"github.com/itcake/agent/internal/secmem"
	"github.com/itcake/agent/internal/state"
	"github.com/itcake/agent/internal/svclist"
	"github.com/itcake/agent/internal/syspath"
	"github.com/itcake/agent/internal/updater"
	"github.com/itcake/agent/internal/workerpool"
)

// setBearer writes "Bearer <token>" into the Authorization header without
// concatenating into a Go string the GC can't move/zero. We wrap the input
// in a SecureString (so the wrapped buffer is zeroed when this function
// returns) and copy bytes into a single header value. The cfg.Token string
// itself remains until config rotation — promoting it to SecureString is
// a separate refactor.
func setBearer(req *http.Request, token string) {
	if token == "" {
		return
	}
	s := secmem.WrapString(token)
	defer s.Zero()
	plain := s.Reveal()
	buf := make([]byte, 0, 7+len(plain))
	buf = append(buf, "Bearer "...)
	buf = append(buf, plain...)
	req.Header.Set("Authorization", string(buf))
	for i := range buf {
		buf[i] = 0
	}
}

// Transport caps — mirror the server's 1MB body limit. Protects against
// a compromised or impersonating server trying to exhaust agent memory.
const (
	maxResponseBody = 1 << 20 // 1 MiB
	maxErrorBody    = 4 << 10 // 4 KiB — enough for any real error payload
)

// Signature validity window. Shorter than any legitimate checkin interval,
// long enough to tolerate minor clock skew between agent and server.
const commandMaxAge = 10 * time.Minute

// PendingCommand is a command received from the server.
// PayloadRaw is the exact byte-for-byte JSON string the server HMAC'd over
// at dispatch — re-encoding it would break signature verification.
type PendingCommand struct {
	ID             string `json:"id"`
	AgentID        string `json:"agentId"`
	Type           string `json:"type"`
	PayloadRaw     string `json:"payloadRaw"` // canonical signed bytes
	Signature      string `json:"signature"`
	IssuedAt       string `json:"issuedAt"` // RFC3339, part of HMAC input
	TimeoutSeconds int    `json:"timeoutSeconds"`
}

// CheckinResponse is the server's response to a check-in.
type CheckinResponse struct {
	Commands                []PendingCommand `json:"commands"`
	CheckinInterval         int              `json:"checkinInterval"`
	BinaryHash              string           `json:"binaryHash,omitempty"`
	BinaryAdvisoryIssuedAt  string           `json:"binaryAdvisoryIssuedAt,omitempty"`
	BinaryAdvisorySignature string           `json:"binaryAdvisorySignature,omitempty"`
	// BinaryManifestSignature is an optional Ed25519 signature over
	// "binary-manifest:<agentId>:<binaryHash>:<issuedAt>". When the
	// agent has at least one ITCAKE_UPDATE_MANIFEST_PUBKEYS entry,
	// the signature is required and must verify before the binary
	// download starts. With no pubkeys configured, the field is
	// ignored — preserves backward compat.
	BinaryManifestSignature string `json:"binaryManifestSignature,omitempty"`
}

// CheckinPayload is sent to the server on each check-in.
type CheckinPayload struct {
	Metrics         *metrics.SystemMetrics `json:"metrics,omitempty"`
	CommandResults  []commandResult        `json:"commandResults,omitempty"`
	Packages        interface{}            `json:"packages,omitempty"`
	Services        interface{}            `json:"services,omitempty"`
	Events          []eventlog.Event       `json:"events,omitempty"`
	Hostname        string                 `json:"hostname,omitempty"`
	OSVersion       string                 `json:"osVersion,omitempty"`
	AgentVersion    string                 `json:"agentVersion,omitempty"`
	PackageManagers []string               `json:"packageManagers,omitempty"`
	CPUModel        string                 `json:"cpuModel,omitempty"`
	LocalIP         string                 `json:"localIp,omitempty"`
}

type commandResult struct {
	ID          string  `json:"id"`
	Status      string  `json:"status"`
	ExitCode    *int    `json:"exitCode"`
	Stdout      string  `json:"stdout"`
	Stderr      string  `json:"stderr"`
	StartedAt   string  `json:"startedAt"`
	CompletedAt *string `json:"completedAt"`
}

// cmdPool is the package-level bounded worker pool used to run commands
// asynchronously. Initialised once on the first Run() call so the
// check-in HTTP request can return promptly even while a long-running
// command is executing on a worker. Tests that want a dedicated pool
// should use the unexported helpers in checkin_test.go.
var (
	cmdPool     *workerpool.Pool
	cmdPoolOnce sync.Once
)

// initCommandPool wires up the singleton pool from cfg-supplied caps.
// Called from Run; callers should not assume the pool is up before the
// first Run invocation.
func initCommandPool(cfg *config.Config) {
	cmdPoolOnce.Do(func() {
		p, err := workerpool.New(cfg.MaxConcurrentCommands, cfg.CommandQueueSize)
		if err != nil {
			// Fall back to defaults if the validated config somehow
			// still produces an invalid pool. We bail loudly because
			// no pool means no command execution.
			fmt.Fprintf(os.Stderr, "[checkin] worker pool init failed (%v) — falling back to defaults\n", err)
			p, _ = workerpool.New(config.DefaultMaxConcurrentCommands, config.DefaultCommandQueueSize)
		}
		cmdPool = p
	})
}

// Run starts the check-in loop. It blocks indefinitely.
func Run(cfg *config.Config, configPath, version string) {
	initCommandPool(cfg)
	statePath := state.PathInDir(filepath.Dir(configPath))
	client := buildHTTPClient(cfg.TLSPinSHA256)
	// Per-agent HMAC secret double-duties as the replay-cache MAC key, so
	// a local user with brief filesystem write access can't plant `{}` to
	// erase replay protection (the load-side HMAC check rejects the
	// tampered file). Cache resets on mismatch + log loudly.
	replay := commands.NewPersistentReplayCache(commandMaxAge*3, commands.ReplayCachePath(configPath), []byte(cfg.HMACSecret))
	// Merge enrollment-time persisted pubkeys (encrypted in cfg) with any
	// env-var pubkeys loaded in updater.init(). Persisted keys mean the
	// trust set survives env-var tampering — a local attacker who can
	// strip ITCAKE_UPDATE_MANIFEST_PUBKEYS can no longer silently downgrade
	// to advisory-only verification.
	if len(cfg.ManifestPubKeys) > 0 {
		updater.AddTrustedPubKeys(cfg.ManifestPubKeys)
	}

	hostname := shortHostname()
	osVersion := detectOSVersion()
	cpuModel := detectCPUModel()
	localIP := detectLocalIP()

	detectedManagers := packages.DetectManagers()
	managerNames := make([]string, 0, len(detectedManagers))
	for _, m := range detectedManagers {
		managerNames = append(managerNames, m.Name())
	}

	interval := time.Duration(cfg.CheckinInterval) * time.Second
	inventoryTicker := 9 // first cycle increments to 10 → send inventory

	quickPayload := &CheckinPayload{
		Hostname:        hostname,
		OSVersion:       osVersion,
		AgentVersion:    version,
		PackageManagers: managerNames,
		CPUModel:        cpuModel,
		LocalIP:         localIP,
	}
	if _, err := doCheckin(client, cfg, quickPayload); err != nil {
		fmt.Fprintf(os.Stderr, "initial check-in failed: %v\n", err)
	}

	for {
		m, err := metrics.Collect()
		if err != nil {
			fmt.Fprintf(os.Stderr, "metrics collection failed: %v\n", err)
		}
		payload := &CheckinPayload{
			Metrics:         m,
			Hostname:        hostname,
			OSVersion:       osVersion,
			AgentVersion:    version,
			PackageManagers: managerNames,
			CPUModel:        cpuModel,
			LocalIP:         localIP,
		}

		inventoryTicker++
		if inventoryTicker >= 10 {
			inventoryTicker = 0
			// Event log collection rides the inventory cycle so we don't
			// spawn `journalctl` / `wevtutil` every minute. Empty slice on
			// platforms without a working backend — no error, server just
			// gets no events that round.
			if events := eventlog.Collect(); len(events) > 0 {
				payload.Events = events
			}

			var allPkgs []map[string]interface{}
			for _, mgr := range detectedManagers {
				pkgs, err := mgr.ListInstalled()
				if err != nil {
					continue
				}
				for _, p := range pkgs {
					allPkgs = append(allPkgs, map[string]interface{}{
						"manager":         mgr.Name(),
						"name":            p.Name,
						"version":         p.Version,
						"latestVersion":   p.LatestVersion,
						"updateAvailable": p.UpdateAvailable,
					})
				}
			}
			if len(allPkgs) > 0 {
				payload.Packages = allPkgs
			}

			svcs, err := svclist.List()
			if err == nil && len(svcs) > 0 {
				var svcData []map[string]interface{}
				for _, s := range svcs {
					entry := map[string]interface{}{
						"name":   s.Name,
						"status": s.Status,
						"data":   map[string]interface{}{},
					}
					if s.Enabled != nil {
						entry["enabled"] = *s.Enabled
					}
					svcData = append(svcData, entry)
				}
				payload.Services = svcData
			}
		}

		resp, err := doCheckin(client, cfg, payload)
		if err != nil {
			fmt.Fprintf(os.Stderr, "check-in failed: %v\n", err)
		} else {
			// Heartbeat AFTER a successful checkin so a long offline
			// stretch is visible to the supervisor (state file's
			// LastHeartbeatAt only advances when we genuinely talked
			// to the server).
			if hbErr := state.WriteHeartbeat(statePath); hbErr != nil {
				fmt.Fprintf(os.Stderr, "[state] heartbeat write failed: %v\n", hbErr)
			}
			if resp.CheckinInterval > 0 {
				interval = time.Duration(resp.CheckinInterval) * time.Second
			}
			if len(resp.Commands) > 0 {
				hadPackageCmd := false
				for _, c := range resp.Commands {
					if strings.HasPrefix(c.Type, "package_") {
						hadPackageCmd = true
					}
				}
				processCommands(client, cfg, replay, resp.Commands)
				if hadPackageCmd {
					inventoryTicker = 9
				}
			}
		}

		if resp != nil && resp.BinaryHash != "" {
			selfUpdate(client, cfg, replay, resp.BinaryHash, resp.BinaryAdvisoryIssuedAt, resp.BinaryAdvisorySignature, resp.BinaryManifestSignature)
		}

		// Jitter ±10% so a fleet of agents enrolled at the same time doesn't
		// stampede the server on the same second.
		jitter := time.Duration(rand.Int63n(int64(interval) / 5))
		time.Sleep(interval - interval/10 + jitter)
	}
}

func doCheckin(client *http.Client, cfg *config.Config, payload *CheckinPayload) (*CheckinResponse, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal: %w", err)
	}

	req, err := http.NewRequest("POST", cfg.ServerURL+"/api/rmm/checkin", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	setBearer(req, cfg.Token)
	req.Header.Set("User-Agent", "itcake-agent/"+cfg.AgentID[:min(8, len(cfg.AgentID))])

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
		return nil, fmt.Errorf("server %d: %s", resp.StatusCode, string(respBody))
	}

	// Cap response body so a rogue or confused server can't blow up agent memory.
	limited := io.LimitReader(resp.Body, maxResponseBody+1)
	raw, err := io.ReadAll(limited)
	if err != nil {
		return nil, fmt.Errorf("read: %w", err)
	}
	if len(raw) > maxResponseBody {
		return nil, fmt.Errorf("response body exceeds %d bytes", maxResponseBody)
	}
	var result CheckinResponse
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	return &result, nil
}

// processCommands verifies every command's HMAC signature against the
// per-agent shared secret established at enrollment, then (if OK and not
// a replay) dispatches to the command handler.
//
// Verification + replay-checks happen synchronously on the check-in
// goroutine (they're cheap). The actual handler — which may shell out
// for several minutes — runs on the bounded worker pool so the next
// check-in tick isn't blocked. ErrQueueFull is reported back as a
// synthetic "failed" result so the server can see and retry the command
// rather than have it stuck pending.
func processCommands(client *http.Client, cfg *config.Config, replay *commands.ReplayCache, cmds []PendingCommand) {
	for _, cmd := range cmds {
		// Bind check: the server must be sending OUR agent ID. An outer
		// attacker who replayed an intercepted command to a different agent
		// would trip this. Reject empty agentId outright — the previous
		// `cmd.AgentID != "" && ...` was opt-out, so a server that omitted
		// the field (or had it stripped by a buggy proxy) skipped the
		// binding check entirely. Defense-in-depth in addition to HMAC.
		if cmd.AgentID == "" || cmd.AgentID != cfg.AgentID {
			fmt.Fprintf(os.Stderr, "[security] rejecting cmd %s: agentId mismatch (got %q, want %q)\n", cmd.ID, cmd.AgentID, cfg.AgentID)
			reportFailure(client, cfg, cmd.ID, "agentId mismatch")
			continue
		}
		// 1. Verify HMAC + freshness using the EXACT payload bytes as signed.
		if err := commands.VerifySignature(
			cmd.ID, cfg.AgentID, cmd.Type, cmd.PayloadRaw,
			cmd.IssuedAt, cmd.Signature, cfg.HMACSecret, commandMaxAge,
		); err != nil {
			fmt.Fprintf(os.Stderr, "[security] rejecting cmd %s (type=%s): %v\n", cmd.ID, cmd.Type, err)
			reportFailure(client, cfg, cmd.ID, "signature verification failed: "+err.Error())
			continue
		}
		// 2. Nonce replay protection — catches a server that accidentally or
		//    maliciously replays a still-fresh signed command. Report the
		//    failure so the server clears the pending row instead of
		//    handing the same command out on every checkin until expiry.
		if !replay.Check(cmd.ID) {
			fmt.Fprintf(os.Stderr, "[security] replay blocked: cmd %s\n", cmd.ID)
			reportFailure(client, cfg, cmd.ID, "command replay rejected")
			continue
		}

		// Decode payload object for handlers that need fields.
		var payloadObj map[string]interface{}
		if cmd.PayloadRaw != "" {
			if err := json.Unmarshal([]byte(cmd.PayloadRaw), &payloadObj); err != nil {
				reportFailure(client, cfg, cmd.ID, "bad payload JSON")
				continue
			}
		}

		timeout := cmd.TimeoutSeconds
		if timeout <= 0 {
			timeout = 300
		}

		// Capture loop variables — Submit's task closure runs later on a
		// worker goroutine, so each task needs its own copy.
		c := cmd
		obj := payloadObj
		to := timeout
		task := func(ctx context.Context) {
			runCommandTask(ctx, client, cfg, c, obj, to)
		}

		if cmdPool == nil {
			// Defensive fallback if Run wasn't called (shouldn't happen
			// in production but tests sometimes invoke processCommands
			// directly).
			task(context.Background())
			continue
		}

		if err := cmdPool.Submit(task); err != nil {
			if errors.Is(err, workerpool.ErrQueueFull) {
				fmt.Fprintf(os.Stderr, "[checkin] cmd %s rejected: worker pool queue full\n", c.ID)
				reportFailure(client, cfg, c.ID, "agent overloaded; command rejected")
				continue
			}
			// ErrPoolClosed during shutdown — surface as a failure so
			// the server isn't left with a perpetually-pending command.
			fmt.Fprintf(os.Stderr, "[checkin] cmd %s rejected: %v\n", c.ID, err)
			reportFailure(client, cfg, c.ID, "agent shutting down")
		}
	}
}

// runCommandTask is the per-command execution body — runs on a worker
// goroutine. Kept separate so the tests can construct it directly.
func runCommandTask(_ context.Context, client *http.Client, cfg *config.Config, cmd PendingCommand, payloadObj map[string]interface{}, timeout int) {
	var result *commands.Result
	switch cmd.Type {
	case "shell", "script":
		command, _ := payloadObj["command"].(string)
		if command == "" {
			return
		}
		result = commands.Execute(command, timeout)

	case "system_info_refresh":
		code := 0
		now := time.Now().UTC().Format(time.RFC3339)
		result = &commands.Result{
			Status: "completed", ExitCode: &code,
			Stdout: "system info refreshed", StartedAt: now, CompletedAt: &now,
		}

	case "package_update", "package_upgrade", "package_install", "package_uninstall":
		result = handlePackageCommand(cmd.Type, payloadObj, timeout)

	case "service_action":
		result = handleServiceAction(payloadObj, timeout)

	case "software_update":
		result = handleSoftwareUpdate(timeout)

	case "os_update":
		result = handleOSUpdate(timeout)

	case "check_os_updates":
		result = handleCheckOSUpdates(timeout)

	case "reboot":
		result = handleReboot(payloadObj)

	case "collect_reliability":
		result = handleCollectReliability()

	case "boot_performance_collect":
		result = handleBootPerformance()

	case "hardware_warranty_collect":
		result = handleHardwareWarranty()

	case "cis_audit":
		result = handleCISAudit()

	case "peripheral_scan":
		result = handlePeripheralScan(payloadObj)

	case "sensitive_data_scan":
		result = handleSensitiveDataScan(payloadObj)

	case "filesystem_analysis":
		result = handleFilesystemAnalysis(payloadObj)

	case "filesystem_cleanup":
		result = handleFilesystemCleanup(payloadObj)

	case "network_discovery", "network_baseline_compare":
		result = handleNetworkDiscovery(payloadObj)

	default:
		reportFailure(client, cfg, cmd.ID, fmt.Sprintf("unknown command type %q (agent does not implement it)", cmd.Type))
		return
	}

	if result != nil {
		reportResult(client, cfg, cmd.ID, result)
	}
}

// handleServiceAction routes a service_action command (start/stop/restart/enable/disable)
// to the platform-specific service manager. Service control requires root on
// Linux/macOS and is already root on Windows service context, so we always
// use ExecuteAsRoot — which is a no-op alias on Windows and bypasses the
// console-user drop on Unix.
func handleServiceAction(payloadObj map[string]interface{}, timeoutSec int) *commands.Result {
	action, _ := payloadObj["action"].(string)
	name, _ := payloadObj["service"].(string)

	cmdStr, err := commands.BuildServiceCommand("", action, name)
	if err != nil {
		now := time.Now().UTC().Format(time.RFC3339)
		code := 1
		return &commands.Result{
			Status: "failed", ExitCode: &code,
			Stderr:    "service_action: " + err.Error(),
			StartedAt: now, CompletedAt: &now,
		}
	}

	// Service control returns quickly — 60s is plenty and prevents a wedged
	// service from holding a check-in slot for the full default timeout.
	if timeoutSec <= 0 || timeoutSec > 120 {
		timeoutSec = 60
	}
	return commands.ExecuteAsRoot(cmdStr, timeoutSec)
}

func handlePackageCommand(cmdType string, payloadObj map[string]interface{}, timeoutSec int) *commands.Result {
	mgrs := packages.DetectManagers()
	managerName, _ := payloadObj["manager"].(string)
	pkgName, _ := payloadObj["package"].(string)

	if cmdType != "package_upgrade" {
		if err := packages.ValidatePackageName(pkgName); err != nil {
			now := time.Now().UTC().Format(time.RFC3339)
			code := 1
			return &commands.Result{
				Status: "failed", ExitCode: &code,
				Stderr:    "package name rejected: " + err.Error(),
				StartedAt: now, CompletedAt: &now,
			}
		}
	}

	for _, mgr := range mgrs {
		if managerName != "" && mgr.Name() != managerName {
			continue
		}
		var plan *packages.ExecPlan
		switch cmdType {
		case "package_update":
			plan = mgr.UpdatePlan(pkgName)
		case "package_upgrade":
			plan = mgr.UpgradePlan()
		case "package_install":
			plan = mgr.InstallPlan(pkgName)
		case "package_uninstall":
			plan = mgr.UninstallPlan(pkgName)
		}
		if plan.IsEmpty() {
			continue
		}
		timeout := timeoutSec
		if timeout <= 0 {
			timeout = 600
		}
		return runPlan(plan, timeout)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	code := 1
	return &commands.Result{
		Status: "failed", ExitCode: &code,
		Stderr: "no suitable package manager found", StartedAt: now, CompletedAt: &now,
	}
}

func handleSoftwareUpdate(timeout int) *commands.Result {
	if timeout <= 0 {
		timeout = 600
	}
	mgrs := packages.DetectManagers()
	var allOutput, allErrors strings.Builder
	overallStatus := "completed"
	var lastCode int

	for _, mgr := range mgrs {
		plan := mgr.UpgradePlan()
		if plan.IsEmpty() {
			continue
		}
		allOutput.WriteString("=== " + mgr.Name() + " ===\n")
		result := runPlan(plan, timeout)
		allOutput.WriteString(result.Stdout)
		allOutput.WriteString("\n")
		if result.Stderr != "" {
			allErrors.WriteString(mgr.Name() + ": " + result.Stderr + "\n")
		}
		if result.Status == "failed" {
			overallStatus = "failed"
			if result.ExitCode != nil {
				lastCode = *result.ExitCode
			}
		}
	}

	now := time.Now().UTC().Format(time.RFC3339)
	code := lastCode
	return &commands.Result{
		Status: overallStatus, ExitCode: &code,
		Stdout: allOutput.String(), Stderr: allErrors.String(),
		StartedAt: now, CompletedAt: &now,
	}
}

// runPlan dispatches an ExecPlan to the right commands executor.
// Argv plans bypass /bin/sh; ShellScript plans go through the legacy
// shell-string path. AsRoot picks between the ...AsRoot variants
// (no-op on Windows, skips the console-user drop on Unix).
func runPlan(plan *packages.ExecPlan, timeoutSec int) *commands.Result {
	if plan.IsArgv() {
		if plan.AsRoot {
			return commands.ExecuteArgvAsRoot(plan.Binary, plan.Argv, timeoutSec)
		}
		return commands.ExecuteArgv(plan.Binary, plan.Argv, timeoutSec)
	}
	if plan.AsRoot {
		return commands.ExecuteAsRoot(plan.ShellScript, timeoutSec)
	}
	return commands.Execute(plan.ShellScript, timeoutSec)
}

func handleOSUpdate(timeout int) *commands.Result {
	if timeout <= 0 {
		timeout = 1800
	}
	var cmd string
	switch runtime.GOOS {
	case "darwin":
		// softwareupdate lives under /usr/sbin (SIP-protected) — pin the
		// absolute path so a planted binary on the extended PATH can't
		// hijack the call.
		cmd = syspath.Softwareupdate() + " --install --all --agree-to-license 2>&1"
	case "linux":
		// Linux service runs as root under systemd; `sudo` is unnecessary
		// and can fail when the unit's `User=` doesn't have sudo rights.
		// Use the absolute paths from syspath directly.
		cmd = "if [ -x " + syspath.AptGet() + " ]; then " + syspath.AptGet() + " update && " + syspath.AptGet() + " upgrade -y && " + syspath.AptGet() + " autoremove --purge -y && " + syspath.AptGet() + " clean; " +
			"elif [ -x " + syspath.Dnf() + " ]; then " + syspath.Dnf() + " upgrade -y && " + syspath.Dnf() + " autoremove -y; " +
			"elif [ -x " + syspath.Pacman() + " ]; then " + syspath.Pacman() + " -Syu --noconfirm; " +
			"elif [ -x " + syspath.Apk() + " ]; then " + syspath.Apk() + " upgrade; " +
			"else echo 'No supported package manager found'; exit 1; fi"
	case "windows":
		// PowerShell PSWindowsUpdate: install missing updates from Microsoft Update.
		// Falls back to a clear error when the module is absent so operators see
		// the actionable remediation (install PSWindowsUpdate on the endpoint).
		cmd = `"` + syspath.PowerShell() + `" -NoProfile -NonInteractive -Command "` +
			`if (Get-Module -ListAvailable -Name PSWindowsUpdate) { ` +
			`Import-Module PSWindowsUpdate; Get-WindowsUpdate -AcceptAll -Install -AutoReboot:$false -IgnoreReboot ` +
			`} else { Write-Error 'PSWindowsUpdate module not installed'; exit 2 }"`
	default:
		now := time.Now().UTC().Format(time.RFC3339)
		code := 1
		return &commands.Result{
			Status: "failed", ExitCode: &code,
			Stderr: "OS update not supported on " + runtime.GOOS,
			StartedAt: now, CompletedAt: &now,
		}
	}
	return commands.ExecuteAsRoot(cmd, timeout)
}

func handleCheckOSUpdates(timeout int) *commands.Result {
	if timeout <= 0 {
		timeout = 120
	}
	var cmd string
	switch runtime.GOOS {
	case "darwin":
		cmd = syspath.Softwareupdate() + " --list 2>&1"
	case "linux":
		cmd = "if [ -x " + syspath.AptGet() + " ]; then " + syspath.AptGet() + " update -qq && " + syspath.Apt() + " list --upgradable 2>/dev/null; " +
			"elif [ -x " + syspath.Dnf() + " ]; then " + syspath.Dnf() + " check-update 2>/dev/null || true; " +
			"elif [ -x " + syspath.Pacman() + " ]; then " + syspath.Pacman() + " -Qu 2>/dev/null; " +
			"elif [ -x " + syspath.Apk() + " ]; then " + syspath.Apk() + " version -l '<' 2>/dev/null; " +
			"else echo 'No supported package manager found'; exit 1; fi"
	case "windows":
		cmd = `"` + syspath.PowerShell() + `" -NoProfile -NonInteractive -Command "` +
			`if (Get-Module -ListAvailable -Name PSWindowsUpdate) { ` +
			`Import-Module PSWindowsUpdate; Get-WindowsUpdate } else { Write-Output 'PSWindowsUpdate not installed' }"`
	default:
		now := time.Now().UTC().Format(time.RFC3339)
		code := 1
		return &commands.Result{
			Status: "failed", ExitCode: &code,
			Stderr: "OS update check not supported on " + runtime.GOOS,
			StartedAt: now, CompletedAt: &now,
		}
	}
	return commands.Execute(cmd, timeout)
}

// handleReboot dispatches an OS-level shutdown command. The shutdown is
// scheduled rather than immediate so the agent has time to ack the
// command back to the server before the system actually reboots —
// otherwise the result stays "running" forever and the operator can't
// tell from the UI whether the request landed.
//
// `delaySeconds` (clamped 0..86400) is honored on each platform via the
// platform's native shutdown scheduler. The server-side validator
// already bounds it; we re-clamp here as defense-in-depth so a forged
// signed command (e.g. cryptanalytic break) can't request a reboot
// in 5 years.
func handleReboot(payloadObj map[string]interface{}) *commands.Result {
	delay := 60
	if v, ok := payloadObj["delaySeconds"].(float64); ok {
		d := int(v)
		if d < 0 {
			d = 0
		}
		if d > 86400 {
			d = 86400
		}
		delay = d
	}
	message := "ITCake RMM scheduled reboot"
	if v, ok := payloadObj["message"].(string); ok && v != "" {
		// Truncate aggressively — Windows shutdown.exe rejects > 511 chars
		// outright; Unix `shutdown -r` will accept long messages but they
		// are wall-broadcast to logged-in users so keep them tidy.
		if len(v) > 200 {
			v = v[:200]
		}
		message = v
	}

	// Build argv directly. Going through /bin/sh -c with a `%q` quoted
	// message left `$`, backticks, `&` etc. live in the message field and
	// shell-expanded as root. exec.Command with a raw argv slice does not
	// invoke any shell — every arg is passed as-is to the OS, no metacharacter
	// interpretation. The server-side validator also restricts message to a
	// printable charset (defense-in-depth).
	var name string
	var args []string
	switch runtime.GOOS {
	case "darwin", "linux":
		// `shutdown -r +<minutes>` — the only granularity macOS gives
		// without daemonizing a sleeper. When the operator explicitly
		// asked for `delaySeconds: 0`, honor it via `shutdown -r now`
		// instead of silently coercing to +1 minute (the previous
		// behavior, which diverged from Windows where /t 0 fires
		// immediately). Any non-zero positive delay rounds UP to the
		// next whole minute so a 30 s request produces +1 not +0.
		name = syspath.Shutdown()
		if delay == 0 {
			args = []string{"-r", "now"}
		} else {
			mins := (delay + 59) / 60
			args = []string{"-r", fmt.Sprintf("+%d", mins)}
		}
		if message != "" {
			args = append(args, message)
		}
	case "windows":
		// shutdown.exe takes seconds directly. /t accepts 0..315360000 but
		// our payload validator already capped it at 86400. /c takes the
		// message as a separate argv element — no quoting required.
		name = syspath.Shutdown()
		args = []string{"/r", "/t", fmt.Sprintf("%d", delay), "/f"}
		if message != "" {
			args = append(args, "/c", message)
		}
	default:
		now := time.Now().UTC().Format(time.RFC3339)
		code := 1
		return &commands.Result{
			Status: "failed", ExitCode: &code,
			Stderr: "reboot not supported on " + runtime.GOOS,
			StartedAt: now, CompletedAt: &now,
		}
	}

	// Reboot is privileged everywhere. ExecuteArgvAsRoot bypasses /bin/sh
	// (Unix) and cmd.exe (Windows) so attacker-supplied content in the
	// message arg cannot inject additional commands. Short timeout:
	// scheduling a shutdown returns immediately; the actual reboot fires
	// AFTER our process is gone.
	return commands.ExecuteArgvAsRoot(name, args, 30)
}

// handleCollectReliability runs the daily reliability aggregator and returns
// the JSON-encoded result in stdout. The server side parses stdout when the
// command type is collect_reliability.
func handleCollectReliability() *commands.Result {
	agg := reliability.Collect()
	body, err := json.Marshal(agg)
	now := time.Now().UTC().Format(time.RFC3339)
	if err != nil {
		code := 1
		return &commands.Result{
			Status: "failed", ExitCode: &code,
			Stderr: "marshal: " + err.Error(),
			StartedAt: now, CompletedAt: &now,
		}
	}
	code := 0
	return &commands.Result{
		Status: "completed", ExitCode: &code,
		Stdout: string(body),
		StartedAt: now, CompletedAt: &now,
	}
}

// handleBootPerformance gathers per-boot timing (firmware/loader/userspace
// on Linux, MainPath/PostBoot on Windows, loginwindow-first-event on macOS)
// and emits the aggregate as JSON. Idempotent within a boot session — the
// server dedups by bootTimestamp.
func handleBootPerformance() *commands.Result {
	m := bootperf.Collect()
	body, err := json.Marshal(m)
	now := time.Now().UTC().Format(time.RFC3339)
	if err != nil {
		code := 1
		return &commands.Result{
			Status: "failed", ExitCode: &code,
			Stderr: "marshal: " + err.Error(),
			StartedAt: now, CompletedAt: &now,
		}
	}
	code := 0
	return &commands.Result{
		Status: "completed", ExitCode: &code,
		Stdout: string(body),
		StartedAt: now, CompletedAt: &now,
	}
}

// handleCISAudit runs the platform-specific CIS Benchmark check list and
// emits the aggregate as JSON. Detection-only — no remediation. Server
// stores the snapshot in agent_collector_results and emits one finding per
// failed check.
func handleCISAudit() *commands.Result {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	out := cis.RunBenchmark(ctx)
	body, err := json.Marshal(out)
	now := time.Now().UTC().Format(time.RFC3339)
	if err != nil {
		code := 1
		return &commands.Result{
			Status: "failed", ExitCode: &code,
			Stderr: "marshal: " + err.Error(),
			StartedAt: now, CompletedAt: &now,
		}
	}
	code := 0
	return &commands.Result{
		Status: "completed", ExitCode: &code,
		Stdout: string(body),
		StartedAt: now, CompletedAt: &now,
	}
}

// handleHardwareWarranty reads SMBIOS identity (vendor / model / serial /
// BIOS version) and, on macOS, any cached AppleCare warranty data. Emits
// the snapshot as JSON. Server stores in agent_collector_results and
// pairs with an optional operator override to determine warranty status.
func handleHardwareWarranty() *commands.Result {
	snap := hwinfo.Collect()
	body, err := json.Marshal(snap)
	now := time.Now().UTC().Format(time.RFC3339)
	if err != nil {
		code := 1
		return &commands.Result{
			Status: "failed", ExitCode: &code,
			Stderr: "marshal: " + err.Error(),
			StartedAt: now, CompletedAt: &now,
		}
	}
	code := 0
	return &commands.Result{
		Status: "completed", ExitCode: &code,
		Stdout: string(body),
		StartedAt: now, CompletedAt: &now,
	}
}

// handleSensitiveDataScan walks the operator-supplied paths, applies
// the regex catalogue, and emits findings as JSON in stdout. Detection
// only — no remediation.
func handleSensitiveDataScan(payloadObj map[string]interface{}) *commands.Result {
	scope := secscan.Scope{}
	if rawScope, ok := payloadObj["scope"].(map[string]interface{}); ok {
		if paths, ok := rawScope["paths"].([]interface{}); ok {
			for _, p := range paths {
				if s, ok := p.(string); ok && s != "" {
					scope.Paths = append(scope.Paths, s)
				}
			}
		}
		if sup, ok := rawScope["suppressPaths"].([]interface{}); ok {
			for _, p := range sup {
				if s, ok := p.(string); ok && s != "" {
					scope.SuppressPaths = append(scope.SuppressPaths, s)
				}
			}
		}
		if sup, ok := rawScope["suppressPatternIds"].([]interface{}); ok {
			for _, p := range sup {
				if s, ok := p.(string); ok && s != "" {
					scope.SuppressPatternIDs = append(scope.SuppressPatternIDs, s)
				}
			}
		}
		if v, ok := rawScope["maxFileSizeBytes"].(float64); ok {
			scope.MaxFileSizeBytes = int64(v)
		}
		if v, ok := rawScope["timeoutSeconds"].(float64); ok {
			scope.TimeoutSeconds = int(v)
		}
		if v, ok := rawScope["workers"].(float64); ok {
			scope.Workers = int(v)
		}
	}
	if len(scope.Paths) == 0 {
		now := time.Now().UTC().Format(time.RFC3339)
		code := 1
		return &commands.Result{
			Status: "failed", ExitCode: &code,
			Stderr: "scope.paths is required",
			StartedAt: now, CompletedAt: &now,
		}
	}
	res := secscan.Scan(scope)
	body, err := json.Marshal(res)
	now := time.Now().UTC().Format(time.RFC3339)
	if err != nil {
		code := 1
		return &commands.Result{
			Status: "failed", ExitCode: &code,
			Stderr: "marshal: " + err.Error(),
			StartedAt: now, CompletedAt: &now,
		}
	}
	code := 0
	return &commands.Result{
		Status: "completed", ExitCode: &code,
		Stdout:    string(body),
		StartedAt: now, CompletedAt: &now,
	}
}

// handlePeripheralScan enumerates connected peripherals and emits the
// inventory as JSON in stdout. The server applies its policy and
// records findings; the agent does not block at the OS layer.
func handlePeripheralScan(payloadObj map[string]interface{}) *commands.Result {
	devices := peripheral.Enumerate()
	if devices == nil {
		devices = []peripheral.Device{}
	}
	res := peripheral.ScanResult{Devices: devices}
	if v, ok := payloadObj["policyVersion"].(string); ok {
		res.PolicyVersion = v
	}
	body, err := json.Marshal(res)
	now := time.Now().UTC().Format(time.RFC3339)
	if err != nil {
		code := 1
		return &commands.Result{
			Status: "failed", ExitCode: &code,
			Stderr: "marshal: " + err.Error(),
			StartedAt: now, CompletedAt: &now,
		}
	}
	code := 0
	return &commands.Result{
		Status: "completed", ExitCode: &code,
		Stdout:    string(body),
		StartedAt: now, CompletedAt: &now,
	}
}

// handleFilesystemAnalysis walks operator-supplied paths, categorises
// disposable file groups, and emits the result as JSON in stdout.
// Detection only — no deletion happens here.
func handleFilesystemAnalysis(payloadObj map[string]interface{}) *commands.Result {
	scope := filescan.ScopeConfig{}
	if rawScope, ok := payloadObj["scope"].(map[string]interface{}); ok {
		if paths, ok := rawScope["paths"].([]interface{}); ok {
			for _, p := range paths {
				if s, ok := p.(string); ok && s != "" {
					scope.Paths = append(scope.Paths, s)
				}
			}
		}
		if pats, ok := rawScope["skipPatterns"].([]interface{}); ok {
			for _, p := range pats {
				if s, ok := p.(string); ok && s != "" {
					scope.SkipPatterns = append(scope.SkipPatterns, s)
				}
			}
		}
		if v, ok := rawScope["maxFileSizeBytes"].(float64); ok {
			scope.MaxFileSizeBytes = int64(v)
		}
		if v, ok := rawScope["timeoutSeconds"].(float64); ok {
			scope.TimeoutSeconds = int(v)
		}
		if v, ok := rawScope["workers"].(float64); ok {
			scope.Workers = int(v)
		}
	}
	if len(scope.Paths) == 0 {
		now := time.Now().UTC().Format(time.RFC3339)
		code := 1
		return &commands.Result{
			Status: "failed", ExitCode: &code,
			Stderr: "scope.paths is required",
			StartedAt: now, CompletedAt: &now,
		}
	}
	res, err := filescan.Walk(scope)
	now := time.Now().UTC().Format(time.RFC3339)
	if err != nil {
		code := 1
		return &commands.Result{
			Status: "failed", ExitCode: &code,
			Stderr: "walk: " + err.Error(),
			StartedAt: now, CompletedAt: &now,
		}
	}
	body, err := json.Marshal(res)
	if err != nil {
		code := 1
		return &commands.Result{
			Status: "failed", ExitCode: &code,
			Stderr: "marshal: " + err.Error(),
			StartedAt: now, CompletedAt: &now,
		}
	}
	code := 0
	return &commands.Result{
		Status: "completed", ExitCode: &code,
		Stdout: string(body),
		StartedAt: now, CompletedAt: &now,
	}
}

// handleFilesystemCleanup deletes a small set of operator-supplied paths
// inside one of the well-known cleanup-category roots. Server gates the
// dispatch with operator MFA + category allowlist; agent re-validates
// every input (absolute path, inside category root after EvalSymlinks,
// not in system denylist, owner check, 1 GiB cap).
func handleFilesystemCleanup(payloadObj map[string]interface{}) *commands.Result {
	category, _ := payloadObj["category"].(string)
	rawPaths, _ := payloadObj["paths"].([]interface{})
	paths := make([]string, 0, len(rawPaths))
	for _, p := range rawPaths {
		if s, ok := p.(string); ok && s != "" {
			paths = append(paths, s)
		}
	}
	if category == "" || len(paths) == 0 {
		now := time.Now().UTC().Format(time.RFC3339)
		code := 1
		return &commands.Result{
			Status: "failed", ExitCode: &code,
			Stderr: "category and paths are required",
			StartedAt: now, CompletedAt: &now,
		}
	}
	res, err := filescan.ExecuteCleanup(category, paths)
	now := time.Now().UTC().Format(time.RFC3339)
	if err != nil {
		code := 1
		return &commands.Result{
			Status: "failed", ExitCode: &code,
			Stderr: "cleanup: " + err.Error(),
			StartedAt: now, CompletedAt: &now,
		}
	}
	body, err := json.Marshal(res)
	if err != nil {
		code := 1
		return &commands.Result{
			Status: "failed", ExitCode: &code,
			Stderr: "marshal: " + err.Error(),
			StartedAt: now, CompletedAt: &now,
		}
	}
	code := 0
	return &commands.Result{
		Status: "completed", ExitCode: &code,
		Stdout: string(body),
		StartedAt: now, CompletedAt: &now,
	}
}

// handleNetworkDiscovery enumerates reachable hosts on the agent's
// LAN, returning the inventory as JSON in stdout. The same handler
// covers `network_discovery` and `network_baseline_compare` —
// payload shape is identical; the server differentiates by command
// type when processing the result and only the compare variant runs
// the diff against the stored baseline.
func handleNetworkDiscovery(payloadObj map[string]interface{}) *commands.Result {
	opts := netdisc.Options{}
	if rawOpts, ok := payloadObj["opts"].(map[string]interface{}); ok {
		if subnets, ok := rawOpts["subnets"].([]interface{}); ok {
			for _, s := range subnets {
				if str, ok := s.(string); ok && str != "" {
					opts.Subnets = append(opts.Subnets, str)
				}
			}
		}
		if methods, ok := rawOpts["methods"].([]interface{}); ok {
			for _, s := range methods {
				if str, ok := s.(string); ok && str != "" {
					opts.Methods = append(opts.Methods, str)
				}
			}
		}
		if v, ok := rawOpts["timeoutSeconds"].(float64); ok {
			opts.TimeoutSeconds = int(v)
		}
		if v, ok := rawOpts["concurrency"].(float64); ok {
			opts.Concurrency = int(v)
		}
		if v, ok := rawOpts["portTopN"].(float64); ok {
			opts.PortTopN = int(v)
		}
	}
	res, err := netdisc.Scan(opts)
	now := time.Now().UTC().Format(time.RFC3339)
	if err != nil {
		code := 1
		return &commands.Result{
			Status: "failed", ExitCode: &code,
			Stderr: "scan: " + err.Error(),
			StartedAt: now, CompletedAt: &now,
		}
	}
	body, err := json.Marshal(res)
	if err != nil {
		code := 1
		return &commands.Result{
			Status: "failed", ExitCode: &code,
			Stderr: "marshal: " + err.Error(),
			StartedAt: now, CompletedAt: &now,
		}
	}
	code := 0
	return &commands.Result{
		Status: "completed", ExitCode: &code,
		Stdout: string(body),
		StartedAt: now, CompletedAt: &now,
	}
}

// selfUpdate checks if the running binary differs from the server's latest
// version and replaces itself when needed. The server-supplied hash is the
// SHA-256 of the binary; the agent downloads the new binary over the SAME
// pinned TLS channel, verifies its SHA-256 matches what the server told us,
// then atomically swaps and exits so the service manager restarts it.
// hashPrefix returns the first up-to-12 hex characters of `h`, safe for
// untrusted-length inputs (server-supplied hash, response header). Avoids a
// runtime panic on a misconfigured server that returns a short hash.
func hashPrefix(h string) string {
	return h[:min(12, len(h))]
}

// RFC 9530 Content-Digest sha-256 entry: sha-256=:<base64>:
var contentDigestSha256RE = regexp.MustCompile(`sha-256=:([A-Za-z0-9+/=]+):`)

func contentDigestSha256Matches(headerVal string, expectedHexHash string) (matches bool, present bool) {
	m := contentDigestSha256RE.FindStringSubmatch(headerVal)
	if m == nil {
		return false, false
	}
	got, err := base64.StdEncoding.DecodeString(m[1])
	if err != nil {
		return false, false
	}
	expected, err := hex.DecodeString(expectedHexHash)
	if err != nil {
		return false, false
	}
	return bytes.Equal(got, expected), true
}

type cappedBuffer struct {
	buf       bytes.Buffer
	cap       int
	truncated bool
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	remaining := b.cap - b.buf.Len()
	if remaining <= 0 {
		b.truncated = true
		return len(p), nil
	}
	if len(p) <= remaining {
		return b.buf.Write(p)
	}
	b.buf.Write(p[:remaining])
	b.truncated = true
	return len(p), nil
}

func (b *cappedBuffer) String() string {
	if b.truncated {
		return b.buf.String() + "…[truncated]"
	}
	return b.buf.String()
}

func verifyBinaryAdvisory(agentID, hmacSecret, binaryHash, issuedAt, sigHex string) bool {
	if hmacSecret == "" || sigHex == "" || issuedAt == "" {
		return false
	}
	if t, err := time.Parse(time.RFC3339, issuedAt); err != nil {
		return false
	} else if delta := time.Since(t); delta < -time.Minute || delta > 10*time.Minute {
		return false
	}
	got, err := hex.DecodeString(sigHex)
	if err != nil || len(got) != sha256.Size {
		return false
	}
	message := fmt.Sprintf("binary-advisory:%s:%s:%s", agentID, binaryHash, issuedAt)
	mac := hmac.New(sha256.New, []byte(hmacSecret))
	mac.Write([]byte(message))
	expected := mac.Sum(nil)
	return hmac.Equal(expected, got)
}

// checkBinaryPathWritable verifies we can create-and-remove a sentinel
// file alongside the target binary path. ProtectSystem=strict in
// systemd or other read-only mount configurations would let us happily
// download 50+ MiB only to fail the write at the end. EACCES / ENOENT
// on the parent dir surface here as a clear log line instead.
//
// Skipped on Windows: the running .exe is locked by the OS and we use
// a different rename-aside flow there anyway.
func checkBinaryPathWritable(binaryPath string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	probe := binaryPath + ".update.test"
	// Clean any stale probe so O_EXCL has a guaranteed-fresh path. Removing
	// a possibly-symlinked stale probe is safe — unlink(2) does not follow
	// symlinks. The actual open below uses O_EXCL|O_NOFOLLOW so a freshly
	// planted symlink would be refused.
	_ = os.Remove(probe)
	f, err := os.OpenFile(probe, os.O_CREATE|os.O_WRONLY|os.O_EXCL|probeOpenFlags, 0o600)
	if err != nil {
		return err
	}
	_ = f.Close()
	_ = os.Remove(probe)
	return nil
}

func selfUpdate(client *http.Client, cfg *config.Config, replay *commands.ReplayCache, serverHash, advisoryIssuedAt, advisorySig, manifestSig string) {
	if !verifyBinaryAdvisory(cfg.AgentID, cfg.HMACSecret, serverHash, advisoryIssuedAt, advisorySig) {
		fmt.Fprintf(os.Stderr, "[self-update] refused: binaryHash advisory failed HMAC verification\n")
		return
	}
	// Replay defence: bind the advisory to (hash, issuedAt). A captured
	// advisory replayed within the ±10 min freshness window would otherwise
	// pass verifyBinaryAdvisory above. The HMAC-keyed replay cache (same
	// store used for command IDs) rejects the second presentation. Prefix
	// keeps the namespace disjoint from command IDs.
	if replay != nil {
		advisoryKey := "advisory:" + serverHash + ":" + advisoryIssuedAt
		if !replay.Check(advisoryKey) {
			fmt.Fprintf(os.Stderr, "[self-update] refused: advisory replay (hash=%s issuedAt=%s)\n", hashPrefix(serverHash), advisoryIssuedAt)
			return
		}
	}
	// Optional Ed25519 manifest signature. With no operator-configured
	// pubkeys this is a (true, nil) no-op; with pubkeys it's mandatory.
	if ok, vErr := updater.VerifyManifestSignature(cfg.AgentID, serverHash, advisoryIssuedAt, manifestSig); !ok {
		fmt.Fprintf(os.Stderr, "[self-update] update rejected: manifest signature invalid (%v)\n", vErr)
		return
	}
	self, err := os.Executable()
	if err != nil {
		return
	}
	selfPath, err := filepath.EvalSymlinks(self)
	if err != nil {
		selfPath = self
	}

	if err := checkBinaryPathWritable(selfPath); err != nil {
		fmt.Fprintf(os.Stderr, "[self-update] update aborted: binary path not writable (%v)\n", err)
		return
	}

	// Hash the currently-running binary.
	f, err := os.Open(selfPath)
	if err != nil {
		return
	}
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		f.Close()
		return
	}
	f.Close()
	localHash := hex.EncodeToString(h.Sum(nil))
	if localHash == serverHash {
		return
	}

	fmt.Fprintf(os.Stderr, "[self-update] binary hash mismatch: local=%s server=%s, fetching...\n", hashPrefix(localHash), hashPrefix(serverHash))

	dlURL := fmt.Sprintf("%s/api/rmm/download/%s/%s", cfg.ServerURL, runtime.GOOS, runtime.GOARCH)
	req, err := http.NewRequest("GET", dlURL, nil)
	if err != nil {
		return
	}
	setBearer(req, cfg.Token)
	req.Header.Set("User-Agent", "itcake-agent-updater")

	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[self-update] download failed: %v\n", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		fmt.Fprintf(os.Stderr, "[self-update] HTTP %d\n", resp.StatusCode)
		return
	}
	if hdr := resp.Header.Get("X-Binary-SHA256"); hdr != "" && hdr != serverHash {
		fmt.Fprintf(os.Stderr, "[self-update] X-Binary-SHA256 mismatch (header=%s checkin=%s) — refusing update\n", hashPrefix(hdr), hashPrefix(serverHash))
		return
	}
	if cd := resp.Header.Get("Content-Digest"); cd != "" {
		if matches, present := contentDigestSha256Matches(cd, serverHash); present && !matches {
			fmt.Fprintf(os.Stderr, "[self-update] Content-Digest sha-256 mismatch — refusing update\n")
			return
		}
	}

	tmpPath := selfPath + ".update"
	// Cap self-update download size at 128 MiB — well beyond any legitimate
	// agent binary (current is ~10 MiB), refuses to host a runaway payload.
	const maxUpdate = 128 << 20
	// Remove any stale tempfile from a previous aborted update so the
	// O_EXCL open below can succeed cleanly. unlink(2) does NOT follow
	// symlinks; it removes the link entry itself, so a pre-planted
	// symlink is unlinked (not the target).
	_ = os.Remove(tmpPath)
	// O_EXCL refuses to follow a symlink AND refuses to overwrite an
	// existing file — defends against symlink-pre-plant attacks if the
	// install dir is ever group-writable. 0o700 keeps the in-flight
	// binary readable only by the owner (root/SYSTEM); the final
	// rename promotes it to the right mode for execution.
	tmp, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o700)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[self-update] cannot open temp: %v\n", err)
		return
	}
	hh := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, hh), io.LimitReader(resp.Body, maxUpdate+1))
	tmp.Close()
	if err != nil || n > maxUpdate {
		os.Remove(tmpPath)
		fmt.Fprintf(os.Stderr, "[self-update] download aborted (err=%v size=%d)\n", err, n)
		return
	}
	got := hex.EncodeToString(hh.Sum(nil))
	if got != serverHash {
		os.Remove(tmpPath)
		fmt.Fprintf(os.Stderr, "[self-update] hash mismatch after download (got %s want %s) — possible tampering\n", hashPrefix(got), hashPrefix(serverHash))
		return
	}

	smokeCtx, smokeCancel := context.WithTimeout(context.Background(), 10*time.Second)
	smokeCmd := exec.CommandContext(smokeCtx, tmpPath, "version")
	smokeOut := &cappedBuffer{cap: 4096}
	smokeCmd.Stdout = smokeOut
	smokeCmd.Stderr = smokeOut
	err = smokeCmd.Run()
	smokeCancel()
	if err != nil {
		os.Remove(tmpPath)
		fmt.Fprintf(os.Stderr, "[self-update] verification failed: %v (%s)\n", err, strings.TrimSpace(smokeOut.String()))
		return
	}
	fmt.Fprintf(os.Stderr, "[self-update] verified: %s\n", strings.TrimSpace(smokeOut.String()))

	if runtime.GOOS == "darwin" {
		exec.Command(syspath.Xattr(), "-rd", "com.apple.quarantine", tmpPath).Run()
		exec.Command(syspath.Codesign(), "--sign", "-", "--force", tmpPath).Run()
	}

	// Windows cannot rename over a running .exe; rename the live binary aside
	// first, then move the new one into place. The service manager will
	// restart us, picking up the new binary.
	movedOld := false
	oldPath := selfPath + ".old"
	if runtime.GOOS == "windows" {
		_ = os.Remove(oldPath)
		if err := os.Rename(selfPath, oldPath); err != nil {
			os.Remove(tmpPath)
			fmt.Fprintf(os.Stderr, "[self-update] could not move old binary: %v\n", err)
			return
		}
		movedOld = true
	}

	// Unix: try a direct rename first so the live binary stays present
	// until the new one is in place. The kernel keeps the running
	// process's mmap'd text segment alive via the original inode, so
	// rename-over a live exec is fine on most filesystems. Only on
	// ETXTBSY (rare — some filesystems refuse rename-over-busy-text) do
	// we fall back to the unlink-then-rename dance, which is *not* atomic
	// against a crash but only triggers when the direct rename failed.
	// The previous Remove-then-Rename order left a window where a crash
	// or FS-read-only event between the two syscalls would leave the
	// service with no binary.
	if runtime.GOOS != "windows" {
		if err := os.Rename(tmpPath, selfPath); err == nil {
			afterSelfUpdateRename(selfPath)
			fmt.Fprintln(os.Stderr, "[self-update] updated, exiting for service manager restart")
			os.Exit(0)
		} else if errors.Is(err, syscallETXTBSY) {
			// Filesystem refused the rename — fall back to unlink + rename.
			// Same crash-window risk as before, but only on ETXTBSY paths.
			fmt.Fprintf(os.Stderr, "[self-update] direct rename ETXTBSY; falling back to unlink+rename\n")
			_ = os.Remove(selfPath)
			if err := os.Rename(tmpPath, selfPath); err != nil {
				os.Remove(tmpPath)
				fmt.Fprintf(os.Stderr, "[self-update] CRITICAL: fallback rename failed (%v) — service may not restart. Manual intervention required.\n", err)
				return
			}
			afterSelfUpdateRename(selfPath)
			fmt.Fprintln(os.Stderr, "[self-update] updated, exiting for service manager restart")
			os.Exit(0)
		} else {
			os.Remove(tmpPath)
			fmt.Fprintf(os.Stderr, "[self-update] rename failed: %v\n", err)
			return
		}
	}
	// Windows path: rename-aside already done above; just put the new
	// binary in place.
	if err := os.Rename(tmpPath, selfPath); err != nil {
		os.Remove(tmpPath)
		// Roll back the .old → selfPath move so we don't leave the
		// service with no executable. The previous code only logged the
		// error and exited the function; the SCM-supervised process
		// would then fail to restart on the next reboot.
		if movedOld {
			if rbErr := os.Rename(oldPath, selfPath); rbErr != nil {
				fmt.Fprintf(os.Stderr, "[self-update] CRITICAL: rollback FAILED (%v) — service may not restart. Manual intervention required.\n", rbErr)
			} else {
				fmt.Fprintln(os.Stderr, "[self-update] rolled back to previous binary")
			}
		}
		fmt.Fprintf(os.Stderr, "[self-update] replace failed: %v\n", err)
		return
	}
	afterSelfUpdateRename(selfPath)
	fmt.Fprintln(os.Stderr, "[self-update] updated, exiting for service manager restart")
	os.Exit(0)
}

// afterSelfUpdateRename re-applies platform-specific hardening to the
// newly-renamed binary. On Windows, the new file inherits the parent dir's
// inheritable ACEs rather than the install-time explicit-ACE-with-inheritance-
// disabled lockdown, so EnsureLockdown re-applies the explicit ACL. On Unix
// this is a no-op (lockdownPath is empty on non-Windows).
func afterSelfUpdateRename(selfPath string) {
	if runtime.GOOS != "windows" {
		return
	}
	if err := config.EnsureLockdown(selfPath); err != nil {
		fmt.Fprintf(os.Stderr, "[self-update] WARNING: re-applying ACL on %s failed: %v\n", selfPath, err)
	}
}

// reportFailure is a thin helper to push a synthetic "failed" result back to
// the server so signature-rejected commands show up clearly in the audit log.
func reportFailure(client *http.Client, cfg *config.Config, cmdID, reason string) {
	now := time.Now().UTC().Format(time.RFC3339)
	code := -1
	reportResult(client, cfg, cmdID, &commands.Result{
		Status: "failed", ExitCode: &code,
		Stderr: reason, StartedAt: now, CompletedAt: &now,
	})
}

func reportResult(client *http.Client, cfg *config.Config, cmdID string, result *commands.Result) {
	payload := &CheckinPayload{
		CommandResults: []commandResult{{
			ID: cmdID, Status: result.Status, ExitCode: result.ExitCode,
			Stdout: result.Stdout, Stderr: result.Stderr,
			StartedAt: result.StartedAt, CompletedAt: result.CompletedAt,
		}},
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequest("POST", cfg.ServerURL+"/api/rmm/checkin", bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	setBearer(req, cfg.Token)
	resp, err := client.Do(req)
	if err != nil {
		return
	}
	resp.Body.Close()
}

func shortHostname() string {
	h, _ := os.Hostname()
	if idx := strings.IndexByte(h, '.'); idx > 0 {
		h = h[:idx]
	}
	return h
}

func detectCPUModel() string {
	switch runtime.GOOS {
	case "darwin":
		out, err := exec.Command(syspath.Sysctl(), "-n", "machdep.cpu.brand_string").Output()
		if err == nil {
			return strings.TrimSpace(string(out))
		}
	case "linux":
		data, err := os.ReadFile("/proc/cpuinfo")
		if err == nil {
			for _, line := range strings.Split(string(data), "\n") {
				if strings.HasPrefix(line, "model name") {
					parts := strings.SplitN(line, ":", 2)
					if len(parts) == 2 {
						return strings.TrimSpace(parts[1])
					}
				}
			}
		}
	case "windows":
		out, err := exec.Command(syspath.RegExe(), "query",
			`HKLM\HARDWARE\DESCRIPTION\System\CentralProcessor\0`, "/v", "ProcessorNameString").Output()
		if err == nil {
			for _, line := range strings.Split(string(out), "\n") {
				if strings.Contains(line, "ProcessorNameString") {
					// tail-trim REG_SZ marker
					idx := strings.Index(line, "REG_SZ")
					if idx >= 0 {
						return strings.TrimSpace(line[idx+len("REG_SZ"):])
					}
				}
			}
		}
	}
	return ""
}

func detectOSVersion() string {
	switch runtime.GOOS {
	case "darwin":
		out, err := exec.Command(syspath.SwVers(), "-productVersion").Output()
		if err == nil {
			return "macOS " + strings.TrimSpace(string(out))
		}
	case "linux":
		data, err := os.ReadFile("/etc/os-release")
		if err == nil {
			for _, line := range strings.Split(string(data), "\n") {
				if strings.HasPrefix(line, "PRETTY_NAME=") {
					val := strings.TrimPrefix(line, "PRETTY_NAME=")
					return strings.Trim(val, "\"")
				}
			}
		}
	case "windows":
		out, err := exec.Command(syspath.CmdExe(), "/c", "ver").Output()
		if err == nil {
			return strings.TrimSpace(string(out))
		}
	}
	return runtime.GOOS
}

func detectLocalIP() string {
	// UDP "connect" to a public DNS; nothing is actually sent, the kernel
	// just picks the outbound interface's address for us.
	conn, err := net.DialTimeout("udp", "1.1.1.1:53", 2*time.Second)
	if err != nil {
		return ""
	}
	defer conn.Close()
	addr := conn.LocalAddr().(*net.UDPAddr)
	return addr.IP.String()
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
