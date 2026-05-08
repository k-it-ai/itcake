package peripheral

import (
	"strings"
	"time"
)

func EvaluateDevice(d Device, p Policy) (action string, matched *Exception) {
	if !classMatches(p.Category, d) {
		return "allow", nil
	}
	for i := range p.Exceptions {
		ex := &p.Exceptions[i]
		if exceptionExpired(ex) {
			continue
		}
		if ex.Vendor == "" && ex.Model == "" && ex.Serial == "" {
			continue
		}
		if !caseEqualsOrEmpty(ex.Vendor, d.Vendor) {
			continue
		}
		if !caseEqualsOrEmpty(ex.Model, d.Model) {
			continue
		}
		if !caseEqualsOrEmpty(ex.Serial, d.Serial) {
			continue
		}
		if ex.Allow {
			return "allow", ex
		}
	}
	return p.Action, nil
}

func classMatches(category string, d Device) bool {
	switch category {
	case "storage":
		return d.Class == "storage"
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
