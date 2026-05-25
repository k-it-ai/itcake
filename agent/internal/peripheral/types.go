// Package peripheral enumerates connected USB/Thunderbolt/Bluetooth devices
// and evaluates each against an operator-set policy. Detection only — no
// OS-layer blocking (that would need a kernel driver).
package peripheral

// Device shape matches osquery's `usb_devices` columns. busType, mounted,
// and mountPoint are itcake-specific.
type Device struct {
	Vendor     string `json:"vendor"`
	VendorID   string `json:"vendorId"`
	Model      string `json:"model"`
	ModelID    string `json:"modelId"`
	Serial     string `json:"serial"`
	BusType    string `json:"busType"`
	Class      string `json:"class"`
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
	Category   string      `json:"category"`
	Action     string      `json:"action"`
	Exceptions []Exception `json:"exceptions"`
}

type ScanResult struct {
	Devices       []Device `json:"devices"`
	PolicyVersion string   `json:"policyVersion,omitempty"`
}
