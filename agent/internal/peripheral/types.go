// Package peripheral enumerates connected USB / Thunderbolt / Bluetooth
// devices and evaluates each against an operator-set policy.
//
// Detection-only: we report what is plugged in and what the policy
// verdict would be, but we do NOT block at the OS layer. Real blocking
// requires a kernel driver. The exception list + per-vendor allowlist
// is the operator value-add.
package peripheral

// Device is the on-the-wire shape sent to the server. Matches the
// PeripheralDevice schema on the TS side.
type Device struct {
	Vendor       string `json:"vendor"`
	VendorID     string `json:"vendorId"`
	Product      string `json:"product"`
	ProductID    string `json:"productId"`
	SerialNumber string `json:"serialNumber"`
	BusType      string `json:"busType"`     // usb | thunderbolt | bluetooth
	DeviceClass  string `json:"deviceClass"` // storage | hid | audio | network | video | printer | unknown
	Mounted      bool   `json:"mounted"`
	MountPoint   string `json:"mountPoint"`
}

// Exception mirrors the server's PeripheralPolicy.exceptions item.
type Exception struct {
	Vendor       string `json:"vendor,omitempty"`
	Product      string `json:"product,omitempty"`
	SerialNumber string `json:"serialNumber,omitempty"`
	Allow        bool   `json:"allow"`
	ExpiresAt    string `json:"expiresAt,omitempty"`
}

// Policy mirrors the server's PeripheralPolicy.
type Policy struct {
	DeviceClass string      `json:"deviceClass"` // storage | all_usb | bluetooth | thunderbolt
	Action      string      `json:"action"`      // allow | block | read_only | alert
	Exceptions  []Exception `json:"exceptions"`
}

// ScanResult is the JSON the agent emits in commandResult.stdout when
// running a `peripheral_scan` command.
type ScanResult struct {
	Devices       []Device `json:"devices"`
	PolicyVersion string   `json:"policyVersion,omitempty"`
}
