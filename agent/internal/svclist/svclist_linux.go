package svclist

import (
	"os/exec"
	"strings"

	"github.com/itcake/agent/internal/syspath"
)

// List returns systemd services on Linux.
func List() ([]ServiceInfo, error) {
	out, err := exec.Command(syspath.Systemctl(), "list-units", "--type=service", "--all", "--no-pager", "--no-legend").Output()
	if err != nil {
		return nil, err
	}

	var services []ServiceInfo
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		name := strings.TrimSuffix(fields[0], ".service")
		// LOAD ACTIVE SUB
		sub := fields[3] // "running", "exited", "dead", "failed"
		status := sub
		if sub == "exited" {
			status = "stopped"
		}

		active := fields[2] // "active", "inactive", "failed"
		enabled := active == "active"

		services = append(services, ServiceInfo{
			Name:    name,
			Status:  status,
			Enabled: &enabled,
		})
	}
	return services, nil
}
