//go:build linux

package hwinfo

import (
	"os"
	"strings"
)

// /sys/class/dmi/id/* is readable by everyone for the non-sensitive fields
// (manufacturer, model, BIOS) but product_serial / board_serial require root.
// We run as root in the systemd unit, so this works.

func collect() Snapshot {
	return Snapshot{
		Manufacturer: readDMI("sys_vendor"),
		Model:        readDMI("product_name"),
		SerialNumber: readDMI("product_serial"),
		BiosVersion:  readDMI("bios_version"),
		BiosDate:     readDMI("bios_date"),
		ChassisType:  readDMI("chassis_type"),
	}
}

func readDMI(key string) string {
	raw, err := os.ReadFile("/sys/class/dmi/id/" + key)
	if err != nil {
		return ""
	}
	s := strings.TrimSpace(string(raw))
	// dmidecode uses "Default string" and "To be filled by O.E.M." for empty
	// vendor-set fields. Treat these as missing.
	switch strings.ToLower(s) {
	case "default string", "to be filled by o.e.m.", "system serial number", "system manufacturer", "system product name":
		return ""
	}
	return s
}
