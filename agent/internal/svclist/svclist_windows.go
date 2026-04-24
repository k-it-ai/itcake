//go:build windows

package svclist

import (
	"fmt"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// List enumerates Windows services via the Service Control Manager.
// Uses the read-only SC_MANAGER_CONNECT/ENUMERATE_SERVICE right so we
// don't need admin to list (though agent normally runs as LocalSystem).
func List() ([]ServiceInfo, error) {
	m, err := mgr.Connect()
	if err != nil {
		return nil, fmt.Errorf("connect scm: %w", err)
	}
	defer m.Disconnect()

	names, err := m.ListServices()
	if err != nil {
		return nil, fmt.Errorf("list services: %w", err)
	}

	out := make([]ServiceInfo, 0, len(names))
	for _, name := range names {
		s, err := openRead(m, name)
		if err != nil {
			continue
		}
		status, _ := s.Query()
		cfg, _ := s.Config()
		_ = s.Close()

		enabled := cfg.StartType != mgr.StartDisabled
		out = append(out, ServiceInfo{
			Name:    name,
			Status:  windowsSvcStateString(status.State),
			Enabled: &enabled,
		})
	}
	return out, nil
}

func openRead(m *mgr.Mgr, name string) (*mgr.Service, error) {
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, err
	}
	// SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS — least privilege
	h, err := windows.OpenService(m.Handle, namePtr,
		windows.SERVICE_QUERY_CONFIG|windows.SERVICE_QUERY_STATUS)
	if err != nil {
		return nil, err
	}
	return &mgr.Service{Name: name, Handle: h}, nil
}

func windowsSvcStateString(s svc.State) string {
	switch s {
	case svc.Stopped:
		return "stopped"
	case svc.StartPending:
		return "start-pending"
	case svc.StopPending:
		return "stop-pending"
	case svc.Running:
		return "running"
	case svc.ContinuePending:
		return "continue-pending"
	case svc.PausePending:
		return "pause-pending"
	case svc.Paused:
		return "paused"
	default:
		return "unknown"
	}
}
