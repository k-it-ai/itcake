// Package hwinfo collects SMBIOS / hardware identity info plus, on macOS,
// any locally-cached AppleCare warranty data. The server pairs this with
// an optional operator-set warrantyEndDate to compute warranty status
// (active / expiring / expired) and emit findings when expiry is near.
//
// Per-platform implementations live in hwinfo_{linux,darwin,windows}.go.
package hwinfo

import "time"

// Snapshot is the JSON the agent emits on stdout for a hardware_warranty_collect
// command. Fields are best-effort; missing data yields empty strings rather
// than an error so the command still completes successfully.
type Snapshot struct {
	Manufacturer    string `json:"manufacturer"`
	Model           string `json:"model"`
	SerialNumber    string `json:"serialNumber"`
	BiosVersion     string `json:"biosVersion"`
	BiosDate        string `json:"biosDate"`
	ChassisType     string `json:"chassisType"`

	// Warranty (only macOS auto-detects via AppleCare cache; others stay empty)
	WarrantyEndDate string `json:"warrantyEndDate"`
	WarrantyLabel   string `json:"warrantyLabel"`
	WarrantySource  string `json:"warrantySource"`

	CollectedAt     string `json:"collectedAt"`
}

// Collect returns hardware identity + (where available) warranty info.
func Collect() Snapshot {
	out := collect()
	if out.CollectedAt == "" {
		out.CollectedAt = time.Now().UTC().Format(time.RFC3339)
	}
	return out
}
