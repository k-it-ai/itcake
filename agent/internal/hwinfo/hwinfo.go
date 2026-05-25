// Package hwinfo collects SMBIOS/hardware identity plus, on macOS,
// locally-cached AppleCare warranty data.
package hwinfo

import "time"

// Snapshot is the JSON emitted for hardware_warranty_collect.
// Only macOS auto-detects WarrantyEndDate (via AppleCare cache).
type Snapshot struct {
	Manufacturer    string `json:"manufacturer"`
	Model           string `json:"model"`
	SerialNumber    string `json:"serialNumber"`
	BiosVersion     string `json:"biosVersion"`
	BiosDate        string `json:"biosDate"`
	ChassisType     string `json:"chassisType"`

	WarrantyEndDate string `json:"warrantyEndDate"`
	WarrantyLabel   string `json:"warrantyLabel"`
	WarrantySource  string `json:"warrantySource"`

	CollectedAt string `json:"collectedAt"`
}

// Collect returns hardware identity + (where available) warranty info.
func Collect() Snapshot {
	out := collect()
	if out.CollectedAt == "" {
		out.CollectedAt = time.Now().UTC().Format(time.RFC3339)
	}
	return out
}
