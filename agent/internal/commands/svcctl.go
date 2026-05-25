package commands

import (
	"errors"
	"fmt"
	"regexp"
	"runtime"

	"github.com/itcake/agent/internal/syspath"
)

// ValidServiceActions mirrors the server-side Zod allowlist.
var ValidServiceActions = []string{"start", "stop", "restart", "enable", "disable"}

var serviceNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._@\-]{0,254}$`)

// ServicePlan is a single argv-form execution.
type ServicePlan struct {
	Bin  string
	Args []string
}

// BuildServicePlans returns the argv-form executions that perform action on
// service name. Windows restart is two plans (stop then start).
func BuildServicePlans(goos, action, name string) ([]ServicePlan, error) {
	if goos == "" {
		goos = runtime.GOOS
	}
	if !isValidAction(action) {
		return nil, fmt.Errorf("invalid service action %q (allowed: start/stop/restart/enable/disable)", action)
	}
	if !serviceNameRe.MatchString(name) {
		return nil, errors.New("invalid service name (allowed charset: [A-Za-z0-9._@-], 1–255 chars, must start alphanumeric)")
	}

	switch goos {
	case "linux":
		return []ServicePlan{{Bin: syspath.Systemctl(), Args: []string{action, name}}}, nil
	case "darwin":
		lc := syspath.Launchctl()
		switch action {
		case "start":
			return []ServicePlan{{Bin: lc, Args: []string{"start", name}}}, nil
		case "stop":
			return []ServicePlan{{Bin: lc, Args: []string{"stop", name}}}, nil
		case "restart":
			return []ServicePlan{{Bin: lc, Args: []string{"kickstart", "-k", "system/" + name}}}, nil
		case "enable":
			return []ServicePlan{{Bin: lc, Args: []string{"enable", "system/" + name}}}, nil
		case "disable":
			return []ServicePlan{{Bin: lc, Args: []string{"disable", "system/" + name}}}, nil
		}
	case "windows":
		sc := syspath.ScExe()
		switch action {
		case "start":
			return []ServicePlan{{Bin: sc, Args: []string{"start", name}}}, nil
		case "stop":
			return []ServicePlan{{Bin: sc, Args: []string{"stop", name}}}, nil
		case "restart":
			return []ServicePlan{
				{Bin: sc, Args: []string{"stop", name}},
				{Bin: sc, Args: []string{"start", name}},
			}, nil
		case "enable":
			// SCM's `start= auto` syntax requires the literal `start=` token + space.
			return []ServicePlan{{Bin: sc, Args: []string{"config", name, "start=", "auto"}}}, nil
		case "disable":
			return []ServicePlan{{Bin: sc, Args: []string{"config", name, "start=", "disabled"}}}, nil
		}
	}
	return nil, fmt.Errorf("unsupported OS %q for service_action", goos)
}

func isValidAction(a string) bool {
	for _, x := range ValidServiceActions {
		if x == a {
			return true
		}
	}
	return false
}
