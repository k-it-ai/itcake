//go:build windows

package services

import (
	"fmt"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// ServiceName is the SCM identifier used for the ITCake agent.
const ServiceName = "ITCakeAgent"

// Install registers the agent as a LocalSystem auto-start service with
// progressive recovery actions on crash.
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

	// Idempotent re-install: drop any prior registration so path/args refresh.
	if s, err := m.OpenService(ServiceName); err == nil {
		_, _ = s.Control(svc.Stop)
		// Brief wait avoids MARKED_FOR_DELETE on the immediate Delete.
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

	if err := s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 2 * time.Minute},
	}, 86400); err != nil {
		// Non-fatal — service is installed without recovery actions.
		_ = err
	}

	if err := s.Start(); err != nil {
		return fmt.Errorf("start service: %w", err)
	}
	return nil
}

// Uninstall stops the service and deletes its registration. Idempotent.
func Uninstall() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect scm: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(ServiceName)
	if err != nil {
		return nil
	}
	defer s.Close()
	_, _ = s.Control(svc.Stop)
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
