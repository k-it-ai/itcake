//go:build windows

package services

import (
	"fmt"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// ServiceName is the SCM identifier used for the ITCake agent. Single
// identifier across install/uninstall/start/stop so the user-visible
// name and the registry key align.
const ServiceName = "ITCakeAgent"

// Install registers the agent binary as a Windows service running as
// LocalSystem with auto-start. Recovery actions retry on failure so a
// transient crash doesn't leave the machine unmonitored.
func Install(binaryPath, configPath string) error {
	abs, err := filepath.Abs(binaryPath)
	if err != nil {
		return fmt.Errorf("resolve binary path: %w", err)
	}
	absCfg, err := filepath.Abs(configPath)
	if err != nil {
		return fmt.Errorf("resolve config path: %w", err)
	}

	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect scm: %w", err)
	}
	defer m.Disconnect()

	// Idempotent re-install: remove any previous registration first so
	// the path/args are refreshed if the binary moved.
	if s, err := m.OpenService(ServiceName); err == nil {
		_, _ = s.Control(svc.Stop)
		// Brief wait for Stop before delete to avoid MARKED_FOR_DELETE.
		time.Sleep(500 * time.Millisecond)
		_ = s.Delete()
		s.Close()
	}

	cfg := mgr.Config{
		StartType:        mgr.StartAutomatic,
		DisplayName:      "ITCake Agent",
		Description:      "ITCake remote monitoring & management endpoint agent.",
		ServiceType:      0x10, // SERVICE_WIN32_OWN_PROCESS
		ServiceStartName: "",   // LocalSystem
	}
	s, err := m.CreateService(ServiceName, abs, cfg, "run", "--config", absCfg)
	if err != nil {
		return fmt.Errorf("create service: %w", err)
	}
	defer s.Close()

	// Automatic recovery: restart on crash, progressively spaced out.
	// Prevents a boot-loop hammer if something's wrong, but recovers
	// quickly from a transient issue.
	if err := s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 2 * time.Minute},
	}, 86400 /* reset crash counter after 24h */); err != nil {
		// Non-fatal — service is still installed, just without recovery.
		// Don't refuse install on this one failure.
		_ = err
	}

	if err := s.Start(); err != nil {
		return fmt.Errorf("start service: %w", err)
	}
	return nil
}

// Uninstall stops the service if running and deletes its registration.
// Safe to call when the service is already absent (idempotent).
func Uninstall() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect scm: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(ServiceName)
	if err != nil {
		return nil // already gone
	}
	defer s.Close()
	_, _ = s.Control(svc.Stop)
	// Poll briefly for stop so Delete succeeds cleanly.
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		st, err := s.Query()
		if err != nil || st.State == svc.Stopped {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	return s.Delete()
}
