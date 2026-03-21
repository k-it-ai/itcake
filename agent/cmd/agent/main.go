package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/itcake/agent/internal/checkin"
	"github.com/itcake/agent/internal/config"
	"github.com/itcake/agent/internal/services"
)

var version = "dev"

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	switch os.Args[1] {
	case "enroll":
		cmdEnroll()
	case "run":
		cmdRun()
	case "service":
		cmdService()
	case "uninstall":
		cmdUninstall()
	case "version":
		fmt.Printf("itcake-agent %s %s/%s\n", version, runtime.GOOS, runtime.GOARCH)
	case "help", "--help", "-h":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", os.Args[1])
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println(`Usage: itcake-agent <command> [options]

Commands:
  enroll    Register this agent with an ITCake server
  run       Start the agent (foreground)
  service   Manage system service (install/uninstall)
  uninstall Remove agent completely (service, binary, config)
  version   Print version information

Enroll:
  --server URL     ITCake server URL (required)
  --token TOKEN    Enrollment token (required)
  --config PATH    Config file path (default: auto)
  --insecure       Skip TLS certificate verification

Run:
  --config PATH    Config file path (default: auto)

Service:
  install          Install as system service
  uninstall        Remove system service`)
}

func cmdEnroll() {
	var serverURL, token, configPath string
	var insecure bool

	configPath = config.DefaultPath()

	for i := 2; i < len(os.Args); i++ {
		switch os.Args[i] {
		case "--server":
			i++
			if i < len(os.Args) {
				serverURL = os.Args[i]
			}
		case "--token":
			i++
			if i < len(os.Args) {
				token = os.Args[i]
			}
		case "--config":
			i++
			if i < len(os.Args) {
				configPath = os.Args[i]
			}
		case "--insecure":
			insecure = true
		}
	}

	if serverURL == "" || token == "" {
		fmt.Fprintln(os.Stderr, "error: --server and --token are required")
		os.Exit(1)
	}

	hostname, _ := os.Hostname()
	// Strip domain suffix (e.g. "MacBookAir.fritz.box" → "MacBookAir")
	if idx := strings.IndexByte(hostname, '.'); idx > 0 {
		hostname = hostname[:idx]
	}

	payload := map[string]string{
		"token":        token,
		"hostname":     hostname,
		"os":           runtime.GOOS,
		"arch":         normalizeArch(runtime.GOARCH),
		"osVersion":    "",
		"agentVersion": version,
	}

	body, _ := json.Marshal(payload)

	client := &http.Client{Timeout: 15 * time.Second}
	if insecure {
		client.Transport = &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec
		}
	}

	req, err := http.NewRequest("POST", serverURL+"/api/rmm/enroll", bytes.NewReader(body))
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "enrollment failed: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))

	if resp.StatusCode != 201 {
		fmt.Fprintf(os.Stderr, "enrollment failed (HTTP %d): %s\n", resp.StatusCode, string(respBody))
		os.Exit(1)
	}

	var result struct {
		AgentID string `json:"agentId"`
		Token   string `json:"token"`
		Name    string `json:"name"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		fmt.Fprintf(os.Stderr, "error parsing response: %v\n", err)
		os.Exit(1)
	}

	cfg := &config.Config{
		ServerURL:       serverURL,
		Token:           result.Token,
		AgentID:         result.AgentID,
		CheckinInterval: 60,
		Insecure:        insecure,
	}

	if err := cfg.Save(configPath); err != nil {
		fmt.Fprintf(os.Stderr, "error saving config: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Enrolled successfully as \"%s\" (ID: %s)\n", result.Name, result.AgentID)
	fmt.Printf("Config saved to %s\n", configPath)
}

func cmdRun() {
	configPath := config.DefaultPath()

	for i := 2; i < len(os.Args); i++ {
		if os.Args[i] == "--config" && i+1 < len(os.Args) {
			i++
			configPath = os.Args[i]
		}
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error loading config: %v\n", err)
		fmt.Fprintln(os.Stderr, "Run 'itcake-agent enroll' first.")
		os.Exit(1)
	}

	fmt.Printf("ITCake Agent %s starting (server: %s, interval: %ds)\n", version, cfg.ServerURL, cfg.CheckinInterval)
	checkin.Run(cfg, version)
}

func cmdService() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: itcake-agent service install|uninstall")
		os.Exit(1)
	}

	binaryPath, _ := os.Executable()
	configPath := config.DefaultPath()

	switch os.Args[2] {
	case "install":
		if err := services.Install(binaryPath, configPath); err != nil {
			fmt.Fprintf(os.Stderr, "service install failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Service installed and started.")

	case "uninstall":
		if err := services.Uninstall(); err != nil {
			fmt.Fprintf(os.Stderr, "service uninstall failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Service uninstalled.")

	default:
		fmt.Fprintf(os.Stderr, "unknown service action: %s\n", os.Args[2])
		os.Exit(1)
	}
}

func cmdUninstall() {
	fmt.Println("Uninstalling ITCake Agent...")
	removed := 0

	clean := func(path, label string) {
		if err := os.RemoveAll(path); err == nil {
			fmt.Printf("  Removed: %s\n", path)
			removed++
		}
	}

	// 1. Stop and remove service (LaunchDaemon/systemd)
	_ = services.Uninstall()
	fmt.Println("  Service stopped and removed.")

	// 2. Config file + directory
	configPath := config.DefaultPath()
	clean(configPath, "config")
	configDir := filepath.Dir(configPath)
	_ = os.Remove(configDir) // only if empty

	// 3. Binary
	clean("/usr/local/bin/itcake-agent", "binary")

	// 4. Logs
	clean("/var/log/itcake-agent.log", "log")

	// 5. macOS-specific: LaunchDaemon plist (belt-and-suspenders, services.Uninstall should handle)
	clean("/Library/LaunchDaemons/com.itcake.agent.plist", "plist")

	// 6. Linux-specific: systemd unit
	clean("/etc/systemd/system/itcake-agent.service", "systemd unit")

	// 7. Any leftover config locations
	clean("/etc/itcake-agent", "linux config dir")

	// 8. macOS receipts/caches (if any future version creates them)
	clean("/Library/Caches/com.itcake.agent", "cache")
	clean("/Library/Application Support/ITCake", "app support")

	fmt.Printf("ITCake Agent uninstalled completely. (%d items removed)\n", removed)

	fmt.Println("ITCake Agent uninstalled completely.")
}

func normalizeArch(arch string) string {
	switch arch {
	case "amd64":
		return "amd64"
	case "arm64":
		return "arm64"
	default:
		return arch
	}
}
