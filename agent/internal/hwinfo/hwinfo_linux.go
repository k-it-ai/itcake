//go:build linux

package hwinfo

import (
	"os"
	"strings"
)

// product_serial / board_serial under /sys/class/dmi/id need root —
// the agent runs as root via systemd.
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
	// Treat DMI placeholders ("Default string", "To be filled by O.E.M.") as missing.
	switch strings.ToLower(s) {
	case "default string", "to be filled by o.e.m.", "system serial number", "system manufacturer", "system product name":
		return ""
	}
	return s
}
