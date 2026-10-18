package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
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
  --server URL     ITCake server URL (required, must be https unless ITCAKE_ALLOW_HTTP=1)
  --token TOKEN    One-time enrollment token (required)
  --config PATH    Config file path (default: OS-specific)
  --pin-tls        Pin the server's TLS public key; subsequent runs refuse any
                   other certificate. Recommended for production.
  --insecure       Skip TLS verification during enrollment ONLY (for bootstrap
                   behind a self-signed cert). Never persisted. After enroll,
                   TLS verification is always enforced.

Run:
  --config PATH    Config file path (default: OS-specific)

Service:
  install          Install as system service
  uninstall        Remove system service`)
}

type cliFlags struct {
	serverURL  string
	token      string
	configPath string
	insecure   bool
	pinTLS     bool
}

func parseEnrollFlags() cliFlags {
	f := cliFlags{configPath: config.DefaultPath()}
	for i := 2; i < len(os.Args); i++ {
		switch os.Args[i] {
		case "--server":
			i++
			if i < len(os.Args) {
				f.serverURL = os.Args[i]
			}
		case "--token":
			i++
			if i < len(os.Args) {
				f.token = os.Args[i]
			}
		case "--config":
			i++
			if i < len(os.Args) {
				f.configPath = os.Args[i]
			}
		case "--insecure":
			f.insecure = true
		case "--pin-tls":
			f.pinTLS = true
		}
	}
	return f
}

func cmdEnroll() {
	f := parseEnrollFlags()
	if f.serverURL == "" || f.token == "" {
		fmt.Fprintln(os.Stderr, "error: --server and --token are required")
		os.Exit(1)
	}
	f.serverURL = strings.TrimRight(f.serverURL, "/")
	if err := config.ValidateServerURL(f.serverURL); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	// If pinning is requested, capture the SPKI now while we can still verify
	// against the public CA chain (unless --insecure, for self-signed bootstrap).
	// This is the one and only window where --insecure is honored.
	var pin string
	if f.pinTLS {
		p, err := checkin.FetchServerPin(serverHostPort(f.serverURL), f.insecure)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: TLS pin capture failed: %v\n", err)
			os.Exit(1)
		}
		pin = p
	}

	client := buildEnrollClient(pin, f.insecure)

	hostname, _ := os.Hostname()
	if idx := strings.IndexByte(hostname, '.'); idx > 0 {
		hostname = hostname[:idx]
	}

	// The agent generates its own half of a shared secret and sends it to the
	// server during enrollment. This means the agent never needs to know the
	// server's master SESSION_SECRET; compromise of one agent reveals only
	// that agent's per-device secret.
	hmacSecret := randHex(32)

	payload := map[string]string{
		"token":        f.token,
		"hostname":     hostname,
		"os":           runtime.GOOS,
		"arch":         runtime.GOARCH,
		"osVersion":    "",
		"agentVersion": version,
		"hmacSecret":   hmacSecret,
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequest("POST", f.serverURL+"/api/rmm/enroll", bytes.NewReader(body))
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "itcake-agent/"+version)

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
		AgentID         string   `json:"agentId"`
		Token           string   `json:"token"`
		Name            string   `json:"name"`
		ManifestPubKey  string   `json:"manifestPubKey,omitempty"`
		ManifestPubKeys []string `json:"manifestPubKeys,omitempty"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		fmt.Fprintf(os.Stderr, "error parsing response: %v\n", err)
		os.Exit(1)
	}

	// Capture the server's Ed25519 manifest pubkey(s) at enrollment time
	// and persist them encrypted in the config. The server may send a
	// single `manifestPubKey` (current key) or a list `manifestPubKeys`
	// (current + previous, useful during a rotation window). Both are
	// accepted; the agent merges them with env-var pubkeys at startup.
	var manifestKeys []string
	if result.ManifestPubKey != "" {
		manifestKeys = append(manifestKeys, result.ManifestPubKey)
	}
	for _, k := range result.ManifestPubKeys {
		if k != "" && k != result.ManifestPubKey {
			manifestKeys = append(manifestKeys, k)
		}
	}

	cfg := &config.Config{
		ServerURL:       f.serverURL,
		Token:           result.Token,
		HMACSecret:      hmacSecret,
		AgentID:         result.AgentID,
		CheckinInterval: 60,
		TLSPinSHA256:    pin,
		ManifestPubKeys: manifestKeys,
	}
	if err := cfg.Save(f.configPath); err != nil {
		fmt.Fprintf(os.Stderr, "error saving config: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Enrolled successfully as \"%s\" (ID: %s)\n", result.Name, result.AgentID)
	if pin != "" {
		fmt.Printf("TLS pinned: %s...\n", pin[:16])
	}
	fmt.Printf("Config saved to %s\n", f.configPath)
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
	clean := func(path string) {
		if err := os.RemoveAll(path); err == nil {
			fmt.Printf("  Removed: %s\n", path)
			removed++
		}
	}
	_ = services.Uninstall()
	fmt.Println("  Service stopped and removed.")

	configPath := config.DefaultPath()
	clean(configPath)
	_ = os.Remove(filepath.Dir(configPath))

	switch runtime.GOOS {
	case "windows":
		pd := os.Getenv("ProgramData")
		if pd == "" {
			pd = `C:\ProgramData`
		}
		clean(filepath.Join(pd, "ITCake"))
		clean(filepath.Join(pd, "ITCake", "agent.log"))
	default:
		clean("/usr/local/bin/itcake-agent")
		clean("/var/log/itcake-agent.log")
		clean("/Library/LaunchDaemons/com.itcake.agent.plist")
		clean("/etc/systemd/system/itcake-agent.service")
		clean("/etc/itcake-agent")
		clean("/Library/Caches/com.itcake.agent")
		clean("/Library/Application Support/ITCake")
	}
	fmt.Printf("ITCake Agent uninstalled completely. (%d items removed)\n", removed)
}

func serverHostPort(serverURL string) string {
	// Very small URL split to avoid importing net/url side-effects here.
	s := strings.TrimPrefix(strings.TrimPrefix(serverURL, "https://"), "http://")
	if i := strings.IndexByte(s, '/'); i >= 0 {
		s = s[:i]
	}
	return s
}

func randHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		// Very narrow failure mode — rand.Read on any modern OS only errors
		// when entropy is truly broken. Best to bail rather than proceed with
		// a weak secret that would silently disable HMAC security.
		fmt.Fprintf(os.Stderr, "fatal: crypto/rand.Read failed: %v\n", err)
		os.Exit(1)
	}
	return hex.EncodeToString(buf)
}

// buildEnrollClient returns a one-off client used only for the enrollment
// POST. Lives here (not checkin.buildHTTPClient) because the pin is being
// captured right now — we can't pin to something we haven't yet seen.
func buildEnrollClient(pin string, insecure bool) *http.Client {
	if pin != "" {
		// We already captured the pin above — enforce it on the enroll request
		// itself so the enrollment can't be MITM'd after the pin step.
		return checkin.ClientWithPin(pin, 15*time.Second)
	}
	return checkin.PlainHTTPSClient(insecure, 15*time.Second)
}
