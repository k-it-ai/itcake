// Package peripheral enumerates connected USB / Thunderbolt / Bluetooth
// devices and evaluates each against an operator-set policy.
//
// Detection-only: we report what is plugged in and what the policy
// verdict would be, but we do NOT block at the OS layer. Real blocking
// requires a kernel driver. The exception list + per-vendor allowlist
// is the operator value-add.
package peripheral

// Device matches osquery's `usb_devices` shape (vendor/vendorId/model/
// modelId/serial/class) so operators can grep itcake data with osquery
// muscle memory. busType / mounted / mountPoint are itcake-specific.
type Device struct {
	Vendor     string `json:"vendor"`
	VendorID   string `json:"vendorId"`
	Model      string `json:"model"`
	ModelID    string `json:"modelId"`
	Serial     string `json:"serial"`
	BusType    string `json:"busType"` // usb | thunderbolt | bluetooth
	Class      string `json:"class"`   // storage | hid | audio | network | video | printer | unknown
	Mounted    bool   `json:"mounted"`
	MountPoint string `json:"mountPoint"`
}

type Exception struct {
	Vendor    string `json:"vendor,omitempty"`
	Model     string `json:"model,omitempty"`
	Serial    string `json:"serial,omitempty"`
	Allow     bool   `json:"allow"`
	ExpiresAt string `json:"expiresAt,omitempty"`
}

type Policy struct {
	Category   string      `json:"category"` // storage | all_usb | bluetooth | thunderbolt
	Action     string      `json:"action"`   // allow | block | read_only | alert
	Exceptions []Exception `json:"exceptions"`
}

type ScanResult struct {
	Devices       []Device `json:"devices"`
	PolicyVersion string   `json:"policyVersion,omitempty"`
}
