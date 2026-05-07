package svclist

import (
	"os/exec"
	"strconv"
	"strings"

	"github.com/itcake/agent/internal/syspath"
)

// Prefixes for Apple/system-internal services that are noise in an RMM context.
var skipPrefixes = []string{
	"com.apple.",
	"[0x",           // anonymous mach services
	"application.",   // launched GUI app entries
}

// List returns launchd services on macOS, excluding Apple internals.
func List() ([]ServiceInfo, error) {
	out, err := exec.Command(syspath.Launchctl(), "list").Output()
	if err != nil {
		return nil, err
	}

	var services []ServiceInfo
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		if fields[2] == "Label" {
			continue
		}
		name := fields[2]

		skip := false
		for _, prefix := range skipPrefixes {
			if strings.HasPrefix(name, prefix) {
				skip = true
				break
			}
		}
		if skip {
			continue
		}

		pid, _ := strconv.Atoi(fields[0])
		status := "stopped"
		if pid > 0 {
			status = "running"
		}

		services = append(services, ServiceInfo{
			Name:   name,
			Status: status,
		})
	}

	// Also list LaunchDaemons and LaunchAgents from filesystem for completeness
	// (launchctl list only shows loaded services)
	addPlists(&services, "/Library/LaunchDaemons")
	addPlists(&services, "/Library/LaunchAgents")

	return services, nil
}

func addPlists(services *[]ServiceInfo, dir string) {
	out, err := exec.Command(syspath.LS(), dir).Output()
	if err != nil {
		return
	}
	existing := make(map[string]bool)
	for _, s := range *services {
		existing[s.Name] = true
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		name := strings.TrimSuffix(line, ".plist")
		if name == "" || existing[name] {
			continue
		}
		for _, prefix := range skipPrefixes {
			if strings.HasPrefix(name, prefix) {
				name = ""
				break
			}
		}
		if name == "" {
			continue
		}
		*services = append(*services, ServiceInfo{
			Name:   name,
			Status: "installed",
		})
	}
}
