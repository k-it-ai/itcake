package peripheral

import (
	"strings"
	"time"
)

// EvaluateDevice returns the policy verdict for a single device. Mirrors
// `evaluateDevice` in src/services/peripheral.ts — both sides MUST reach
// the same verdict for the same input. The duplication is intentional:
// server's verdict drives findings; agent's verdict is informational
// (no kernel driver means we don't actually block at the OS layer).
//
// If the device class doesn't match the policy, the device is allowed
// implicitly (the policy doesn't apply). If it does match, exceptions
// are scanned in order; first non-expired exception with at least one
// matching field and allow=true wins. Otherwise the policy.Action is
// returned.
func EvaluateDevice(d Device, p Policy) (action string, matched *Exception) {
	if !classMatches(p.DeviceClass, d) {
		return "allow", nil
	}
	for i := range p.Exceptions {
		ex := &p.Exceptions[i]
		if exceptionExpired(ex) {
			continue
		}
		if ex.Vendor == "" && ex.Product == "" && ex.SerialNumber == "" {
			continue
		}
		if !caseEqualsOrEmpty(ex.Vendor, d.Vendor) {
			continue
		}
		if !caseEqualsOrEmpty(ex.Product, d.Product) {
			continue
		}
		if !caseEqualsOrEmpty(ex.SerialNumber, d.SerialNumber) {
			continue
		}
		if ex.Allow {
			return "allow", ex
		}
	}
	return p.Action, nil
}

func classMatches(policyClass string, d Device) bool {
	switch policyClass {
	case "storage":
		return d.DeviceClass == "storage"
	case "all_usb":
		return d.BusType == "usb"
	case "bluetooth":
		return d.BusType == "bluetooth"
	case "thunderbolt":
		return d.BusType == "thunderbolt"
	}
	return false
}

func caseEqualsOrEmpty(rule, value string) bool {
	if rule == "" {
		return true
	}
	return strings.EqualFold(rule, value)
}

func exceptionExpired(ex *Exception) bool {
	if ex.ExpiresAt == "" {
		return false
	}
	t, err := time.Parse(time.RFC3339, ex.ExpiresAt)
	if err != nil {
		return false
	}
	return time.Now().After(t)
}
