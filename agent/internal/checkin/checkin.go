package checkin

import (
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/itcake/agent/internal/commands"
	"github.com/itcake/agent/internal/config"
	"github.com/itcake/agent/internal/metrics"
	"github.com/itcake/agent/internal/packages"
	"github.com/itcake/agent/internal/svclist"
)

// PendingCommand is a command received from the server.
type PendingCommand struct {
	ID             string                 `json:"id"`
	Type           string                 `json:"type"`
	Payload        map[string]interface{} `json:"payload"`
	Signature      string                 `json:"signature"`
	TimeoutSeconds int                    `json:"timeoutSeconds"`
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
	client := &http.Client{Timeout: 30 * time.Second}
	if cfg.Insecure {
		client.Transport = &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // user-requested for self-signed certs
		}
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
	inventoryTicker := 9 // Start at 9 so first check-in (increments to 10) sends inventory

	// Immediate first check-in with basic info (before slow inventory collection)
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

		// Send package inventory every 10 check-ins
		inventoryTicker++
		if inventoryTicker >= 10 {
			inventoryTicker = 0
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

			// Also send service inventory
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
				processCommands(client, cfg, resp.Commands)
				// After package operations, force inventory refresh on next check-in
				if hadPackageCmd {
					inventoryTicker = 9
				}
			}
		}

		// Check for self-update if server provided a binary hash
		if resp != nil && resp.BinaryHash != "" {
			selfUpdate(client, cfg, resp.BinaryHash)
		}

		// Add jitter (±10%)
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

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("server %d: %s", resp.StatusCode, string(respBody))
	}

	var result CheckinResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	return &result, nil
}

func processCommands(client *http.Client, cfg *config.Config, cmds []PendingCommand) {
	for _, cmd := range cmds {
		timeout := cmd.TimeoutSeconds
		if timeout <= 0 {
			timeout = 300
		}

		var result *commands.Result
		switch cmd.Type {
		case "shell", "script":
			command, _ := cmd.Payload["command"].(string)
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
			result = handlePackageCommand(cmd)

		case "software_update":
			result = handleSoftwareUpdate(timeout)

		case "os_update":
			result = handleOSUpdate(timeout)

		case "check_os_updates":
			result = handleCheckOSUpdates(timeout)

		default:
			continue
		}

		if result != nil {
			reportResult(client, cfg, cmd.ID, result)
		}
	}
}

func handlePackageCommand(cmd PendingCommand) *commands.Result {
	mgrs := packages.DetectManagers()
	managerName, _ := cmd.Payload["manager"].(string)
	pkgName, _ := cmd.Payload["package"].(string)

	for _, mgr := range mgrs {
		if managerName != "" && mgr.Name() != managerName {
			continue
		}
		var cmdStr string
		switch cmd.Type {
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
			timeout := cmd.TimeoutSeconds
			if timeout <= 0 {
				timeout = 600
			}
			// App uninstall needs root (removing /Applications/*.app + system files)
			if cmd.Type == "package_uninstall" && mgr.Name() == "apps" {
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
		// App uninstall needs root, but upgrade runs as console user (brew) or root (apt)
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
		// Detect package manager and use the user's preferred full upgrade chain
		cmd = "if command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo apt-get upgrade -y && sudo apt-get autoremove --purge -y && sudo apt-get clean; " +
			"elif command -v dnf >/dev/null 2>&1; then sudo dnf upgrade -y && sudo dnf autoremove -y; " +
			"elif command -v pacman >/dev/null 2>&1; then sudo pacman -Syu --noconfirm; " +
			"elif command -v apk >/dev/null 2>&1; then sudo apk upgrade; " +
			"else echo 'No supported package manager found'; exit 1; fi"
	default:
		now := time.Now().UTC().Format(time.RFC3339)
		code := 1
		return &commands.Result{
			Status: "failed", ExitCode: &code,
			Stderr: "OS update not supported on " + runtime.GOOS,
			StartedAt: now, CompletedAt: &now,
		}
	}
	// OS updates need root
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

// selfUpdate checks if the running binary differs from the server's latest version
// and replaces itself if needed. The agent restarts via the service manager (LaunchDaemon/systemd).
func selfUpdate(client *http.Client, cfg *config.Config, serverHash string) {
	// Compute hash of running binary
	self, err := os.Executable()
	if err != nil {
		return
	}
	selfPath, err := filepath.EvalSymlinks(self)
	if err != nil {
		selfPath = self
	}

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
	localHash := fmt.Sprintf("%x", h.Sum(nil))

	if localHash == serverHash {
		return
	}

	fmt.Fprintf(os.Stderr, "[self-update] Binary hash mismatch: local=%s server=%s, downloading update...\n", localHash[:12], serverHash[:12])

	// Download new binary
	dlURL := fmt.Sprintf("%s/api/rmm/download/%s/%s", cfg.ServerURL, runtime.GOOS, goArch())
	req, err := http.NewRequest("GET", dlURL, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[self-update] failed to create request: %v\n", err)
		return
	}

	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[self-update] download failed: %v\n", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		fmt.Fprintf(os.Stderr, "[self-update] download returned HTTP %d\n", resp.StatusCode)
		return
	}

	// Write to temp file
	tmpPath := selfPath + ".update"
	tmp, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[self-update] failed to create temp file: %v\n", err)
		return
	}
	if _, err := io.Copy(tmp, resp.Body); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		fmt.Fprintf(os.Stderr, "[self-update] download write failed: %v\n", err)
		return
	}
	tmp.Close()

	// Verify the new binary runs
	out, err := exec.Command(tmpPath, "version").CombinedOutput()
	if err != nil {
		os.Remove(tmpPath)
		fmt.Fprintf(os.Stderr, "[self-update] new binary verification failed: %v (%s)\n", err, strings.TrimSpace(string(out)))
		return
	}
	fmt.Fprintf(os.Stderr, "[self-update] verified new binary: %s\n", strings.TrimSpace(string(out)))

	// macOS: clear quarantine + re-sign
	if runtime.GOOS == "darwin" {
		exec.Command("xattr", "-rd", "com.apple.quarantine", tmpPath).Run()
		exec.Command("codesign", "--sign", "-", "--force", tmpPath).Run()
	}

	// Atomic replace: rename new over old
	if err := os.Rename(tmpPath, selfPath); err != nil {
		os.Remove(tmpPath)
		fmt.Fprintf(os.Stderr, "[self-update] replace failed: %v\n", err)
		return
	}

	fmt.Fprintf(os.Stderr, "[self-update] updated successfully, restarting...\n")

	// Restart via service manager — the LaunchDaemon/systemd will restart the process
	os.Exit(0)
}

func goArch() string {
	switch runtime.GOARCH {
	case "amd64":
		return "amd64"
	case "arm64":
		return "arm64"
	default:
		return runtime.GOARCH
	}
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
	// Strip domain suffix (e.g. "MacBookAir.fritz.box" → "MacBookAir")
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
	}
	return runtime.GOOS
}

func detectLocalIP() string {
	// Get the preferred outbound IP by connecting to a public DNS (doesn't actually send data)
	conn, err := net.DialTimeout("udp", "1.1.1.1:53", 2*time.Second)
	if err != nil {
		return ""
	}
	defer conn.Close()
	addr := conn.LocalAddr().(*net.UDPAddr)
	return addr.IP.String()
}
