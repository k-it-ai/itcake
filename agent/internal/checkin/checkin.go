package checkin

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
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
	"time"

	"github.com/itcake/agent/internal/commands"
	"github.com/itcake/agent/internal/config"
	"github.com/itcake/agent/internal/eventlog"
	"github.com/itcake/agent/internal/metrics"
	"github.com/itcake/agent/internal/packages"
	"github.com/itcake/agent/internal/svclist"
)

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
	Commands        []PendingCommand `json:"commands"`
	CheckinInterval int              `json:"checkinInterval"`
	BinaryHash      string           `json:"binaryHash,omitempty"`
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

// Run starts the check-in loop. It blocks indefinitely.
func Run(cfg *config.Config, version string) {
	client := buildHTTPClient(cfg.TLSPinSHA256)
	replay := commands.NewReplayCache(commandMaxAge * 3)

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
			selfUpdate(client, cfg, resp.BinaryHash)
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
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
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
// Commands that fail verification are reported back as "failed" with a
// clear error in stderr, so operators can see tampering attempts in the
// audit log. They are NEVER executed.
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
		//    maliciously replays a still-fresh signed command.
		if !replay.Check(cmd.ID) {
			fmt.Fprintf(os.Stderr, "[security] replay blocked: cmd %s\n", cmd.ID)
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

		var result *commands.Result
		switch cmd.Type {
		case "shell", "script":
			command, _ := payloadObj["command"].(string)
			if command == "" {
				continue
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

		default:
			// Unknown type — report back so the command doesn't stay pending forever,
			// and the operator sees WHY it failed in the audit log.
			reportFailure(client, cfg, cmd.ID, fmt.Sprintf("unknown command type %q (agent does not implement it)", cmd.Type))
			continue
		}

		if result != nil {
			reportResult(client, cfg, cmd.ID, result)
		}
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

	for _, mgr := range mgrs {
		if managerName != "" && mgr.Name() != managerName {
			continue
		}
		var cmdStr string
		switch cmdType {
		case "package_update":
			cmdStr = mgr.UpdateCommand(pkgName)
		case "package_upgrade":
			cmdStr = mgr.UpgradeCommand()
		case "package_install":
			cmdStr = mgr.InstallCommand(pkgName)
		case "package_uninstall":
			cmdStr = mgr.UninstallCommand(pkgName)
		}
		if cmdStr != "" {
			timeout := timeoutSec
			if timeout <= 0 {
				timeout = 600
			}
			if cmdType == "package_uninstall" && mgr.Name() == "apps" {
				return commands.ExecuteAsRoot(cmdStr, timeout)
			}
			return commands.Execute(cmdStr, timeout)
		}
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
		upgradeCmd := mgr.UpgradeCommand()
		if upgradeCmd == "" {
			continue
		}
		allOutput.WriteString("=== " + mgr.Name() + " ===\n")
		result := commands.Execute(upgradeCmd, timeout)
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

func handleOSUpdate(timeout int) *commands.Result {
	if timeout <= 0 {
		timeout = 1800
	}
	var cmd string
	switch runtime.GOOS {
	case "darwin":
		cmd = "softwareupdate --install --all --agree-to-license 2>&1"
	case "linux":
		cmd = "if command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo apt-get upgrade -y && sudo apt-get autoremove --purge -y && sudo apt-get clean; " +
			"elif command -v dnf >/dev/null 2>&1; then sudo dnf upgrade -y && sudo dnf autoremove -y; " +
			"elif command -v pacman >/dev/null 2>&1; then sudo pacman -Syu --noconfirm; " +
			"elif command -v apk >/dev/null 2>&1; then sudo apk upgrade; " +
			"else echo 'No supported package manager found'; exit 1; fi"
	case "windows":
		// PowerShell PSWindowsUpdate: install missing updates from Microsoft Update.
		// Falls back to a clear error when the module is absent so operators see
		// the actionable remediation (install PSWindowsUpdate on the endpoint).
		cmd = `powershell -NoProfile -NonInteractive -Command "` +
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
		cmd = "softwareupdate --list 2>&1"
	case "linux":
		cmd = "if command -v apt-get >/dev/null 2>&1; then sudo apt-get update -qq && apt list --upgradable 2>/dev/null; " +
			"elif command -v dnf >/dev/null 2>&1; then dnf check-update 2>/dev/null || true; " +
			"elif command -v pacman >/dev/null 2>&1; then pacman -Qu 2>/dev/null; " +
			"elif command -v apk >/dev/null 2>&1; then apk version -l '<' 2>/dev/null; " +
			"else echo 'No supported package manager found'; exit 1; fi"
	case "windows":
		cmd = `powershell -NoProfile -NonInteractive -Command "` +
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
		name = "shutdown"
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
		name = `C:\Windows\System32\shutdown.exe`
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
// Returns (matches, present). When the header has no parseable sha-256
// entry we return (false, false) — caller treats that as "not checked".
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

func selfUpdate(client *http.Client, cfg *config.Config, serverHash string) {
	self, err := os.Executable()
	if err != nil {
		return
	}
	selfPath, err := filepath.EvalSymlinks(self)
	if err != nil {
		selfPath = self
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
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
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
	// Defense-in-depth: cross-check the response's X-Binary-SHA256 header
	// against the server-supplied serverHash from check-in. Both must
	// match before we'll even start writing the temp file. If they
	// disagree, the server config drifted (or someone is intercepting)
	// — refuse the update rather than risk swapping in a binary that
	// the check-in path won't subsequently recognize as current.
	if hdr := resp.Header.Get("X-Binary-SHA256"); hdr != "" && hdr != serverHash {
		fmt.Fprintf(os.Stderr, "[self-update] X-Binary-SHA256 mismatch (header=%s checkin=%s) — refusing update\n", hashPrefix(hdr), hashPrefix(serverHash))
		return
	}
	// Same cross-check for RFC 9530 Content-Digest. Parses the
	// `sha-256=:<base64>:` form the server emits; ignores other algos
	// or non-parseable values rather than failing on them.
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
	// O_EXCL open below can succeed cleanly. If a malicious party planted
	// a symlink at this path, Remove will follow it but only delete the
	// symlink itself (not the target), so we still get a clean slot.
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

	// Smoke-test the new binary before swapping.
	out, err := exec.Command(tmpPath, "version").CombinedOutput()
	if err != nil {
		os.Remove(tmpPath)
		fmt.Fprintf(os.Stderr, "[self-update] verification failed: %v (%s)\n", err, strings.TrimSpace(string(out)))
		return
	}
	fmt.Fprintf(os.Stderr, "[self-update] verified: %s\n", strings.TrimSpace(string(out)))

	if runtime.GOOS == "darwin" {
		exec.Command("xattr", "-rd", "com.apple.quarantine", tmpPath).Run()
		exec.Command("codesign", "--sign", "-", "--force", tmpPath).Run()
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
	fmt.Fprintln(os.Stderr, "[self-update] updated, exiting for service manager restart")
	os.Exit(0)
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
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
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
		out, err := exec.Command("sysctl", "-n", "machdep.cpu.brand_string").Output()
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
		out, err := exec.Command("reg", "query",
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
		out, err := exec.Command("sw_vers", "-productVersion").Output()
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
		out, err := exec.Command("cmd", "/c", "ver").Output()
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
