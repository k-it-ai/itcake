//go:build !windows

package services

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/itcake/agent/internal/syspath"
)

// Install registers the agent as a system service.
func Install(binaryPath, configPath string) error {
	absPath, err := filepath.Abs(binaryPath)
	if err != nil {
		return fmt.Errorf("resolve binary path: %w", err)
	}

	switch runtime.GOOS {
	case "linux":
		return installSystemd(absPath, configPath)
	case "darwin":
		return installLaunchd(absPath, configPath)
	default:
		return fmt.Errorf("unsupported OS: %s", runtime.GOOS)
	}
}

// Uninstall removes the system service.
func Uninstall() error {
	switch runtime.GOOS {
	case "linux":
		return uninstallSystemd()
	case "darwin":
		return uninstallLaunchd()
	default:
		return fmt.Errorf("unsupported OS: %s", runtime.GOOS)
	}
}

// --- systemd ---

// Sandboxing: agent runs as root (package installs, OS updates, reboots all
// require it) but we tighten the blast radius of a compromised binary.
// NOT included: ProtectHome (linuxbrew lives in /home), ProtectSystem=strict
// (would need an exhaustive ReadWritePaths covering every distro's package
// manager state), MemoryDenyWriteExecute (some package managers spawn
// interpreters that need W+X). These are deferred to operator drop-ins.
const systemdUnit = `[Unit]
Description=ITCake RMM Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%s run --config %s
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
NoNewPrivileges=yes
PrivateTmp=yes
RestrictSUIDSGID=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
`

const systemdPath = "/etc/systemd/system/itcake-agent.service"

func installSystemd(binaryPath, configPath string) error {
	systemctl := syspath.Systemctl()
	// Stop existing service first (idempotent re-enrollment)
	_ = exec.Command(systemctl, "stop", "itcake-agent").Run()
	_ = exec.Command(systemctl, "disable", "itcake-agent").Run()

	content := fmt.Sprintf(systemdUnit, binaryPath, configPath)
	if err := os.WriteFile(systemdPath, []byte(content), 0644); err != nil {
		return fmt.Errorf("write unit file: %w", err)
	}
	cmds := [][]string{
		{systemctl, "daemon-reload"},
		{systemctl, "enable", "itcake-agent"},
		{systemctl, "start", "itcake-agent"},
	}
	for _, args := range cmds {
		if err := exec.Command(args[0], args[1:]...).Run(); err != nil {
			return fmt.Errorf("running %s: %w", strings.Join(args, " "), err)
		}
	}
	return nil
}

func uninstallSystemd() error {
	systemctl := syspath.Systemctl()
	_ = exec.Command(systemctl, "stop", "itcake-agent").Run()
	_ = exec.Command(systemctl, "disable", "itcake-agent").Run()
	os.Remove(systemdPath)
	_ = exec.Command(systemctl, "daemon-reload").Run()
	return nil
}

// --- launchd ---

const launchdPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.itcake.agent</string>
	<key>ProgramArguments</key>
	<array>
		<string>%s</string>
		<string>run</string>
		<string>--config</string>
		<string>%s</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>/var/log/itcake-agent.log</string>
	<key>StandardErrorPath</key>
	<string>/var/log/itcake-agent.log</string>
</dict>
</plist>
`

const launchdPath = "/Library/LaunchDaemons/com.itcake.agent.plist"

func installLaunchd(binaryPath, configPath string) error {
	launchctl := syspath.Launchctl()
	// Unload existing service first (idempotent re-enrollment)
	_ = exec.Command(launchctl, "unload", launchdPath).Run()

	content := fmt.Sprintf(launchdPlist, binaryPath, configPath)
	if err := os.WriteFile(launchdPath, []byte(content), 0644); err != nil {
		return fmt.Errorf("write plist: %w", err)
	}
	if err := exec.Command(launchctl, "load", launchdPath).Run(); err != nil {
		return fmt.Errorf("launchctl load: %w", err)
	}
	return nil
}

func uninstallLaunchd() error {
	_ = exec.Command(syspath.Launchctl(), "unload", launchdPath).Run()
	os.Remove(launchdPath)
	return nil
}
