package peripheral

import (
	"testing"
	"time"
)

func TestEvaluateDeviceClassMismatchAllow(t *testing.T) {
	dev := Device{Vendor: "X", VendorID: "1234", Model: "Y", ModelID: "5678", BusType: "usb", Class: "hid"}
	pol := Policy{Category: "storage", Action: "block"}
	action, ex := EvaluateDevice(dev, pol)
	if action != "allow" {
		t.Errorf("want allow, got %s", action)
	}
	if ex != nil {
		t.Errorf("want no exception, got %+v", ex)
	}
}

func TestEvaluateDeviceMatchingExceptionAllows(t *testing.T) {
	dev := Device{Vendor: "Yubico", VendorID: "1050", Model: "YubiKey", ModelID: "0407", Serial: "ABC", BusType: "usb", Class: "storage"}
	pol := Policy{
		Category: "storage", Action: "block",
		Exceptions: []Exception{{Vendor: "Yubico", Model: "YubiKey", Allow: true}},
	}
	action, ex := EvaluateDevice(dev, pol)
	if action != "allow" {
		t.Errorf("want allow, got %s", action)
	}
	if ex == nil {
		t.Errorf("expected matched exception")
	}
}

func TestEvaluateDeviceVendorOnlyExceptionMatches(t *testing.T) {
	dev := Device{Vendor: "Yubico", VendorID: "1050", Model: "YubiKey", BusType: "usb", Class: "storage"}
	pol := Policy{
		Category: "storage", Action: "block",
		Exceptions: []Exception{{Vendor: "Yubico", Allow: true}},
	}
	action, _ := EvaluateDevice(dev, pol)
	if action != "allow" {
		t.Errorf("want allow, got %s", action)
	}
}

func TestEvaluateDeviceExpiredException(t *testing.T) {
	past := time.Now().Add(-1 * time.Hour).UTC().Format(time.RFC3339)
	dev := Device{Vendor: "Yubico", VendorID: "1050", BusType: "usb", Class: "storage"}
	pol := Policy{
		Category: "storage", Action: "block",
		Exceptions: []Exception{{Vendor: "Yubico", Allow: true, ExpiresAt: past}},
	}
	action, _ := EvaluateDevice(dev, pol)
	if action != "block" {
		t.Errorf("want block (expired exception), got %s", action)
	}
}

func TestEvaluateDeviceFutureExceptionAllows(t *testing.T) {
	future := time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339)
	dev := Device{Vendor: "Yubico", VendorID: "1050", BusType: "usb", Class: "storage"}
	pol := Policy{
		Category: "storage", Action: "block",
		Exceptions: []Exception{{Vendor: "Yubico", Allow: true, ExpiresAt: future}},
	}
	action, _ := EvaluateDevice(dev, pol)
	if action != "allow" {
		t.Errorf("want allow, got %s", action)
	}
}

func TestEvaluateDeviceStorageBlocksByDefault(t *testing.T) {
	dev := Device{Vendor: "SanDisk", VendorID: "0781", BusType: "usb", Class: "storage"}
	pol := Policy{Category: "storage", Action: "block"}
	action, _ := EvaluateDevice(dev, pol)
	if action != "block" {
		t.Errorf("want block, got %s", action)
	}
}

func TestEvaluateDeviceAllUsbCoversNonStorage(t *testing.T) {
	dev := Device{Vendor: "Razer", VendorID: "1532", BusType: "usb", Class: "hid"}
	pol := Policy{Category: "all_usb", Action: "alert"}
	action, _ := EvaluateDevice(dev, pol)
	if action != "alert" {
		t.Errorf("want alert, got %s", action)
	}
}

func TestEvaluateDeviceEmptyExceptionIgnored(t *testing.T) {
	dev := Device{Vendor: "X", VendorID: "1234", BusType: "usb", Class: "storage"}
	pol := Policy{
		Category: "storage", Action: "block",
		Exceptions: []Exception{{Allow: true}},
	}
	action, _ := EvaluateDevice(dev, pol)
	if action != "block" {
		t.Errorf("empty exception should be ignored; want block, got %s", action)
	}
}

func TestEvaluateDeviceCaseInsensitiveVendor(t *testing.T) {
	dev := Device{Vendor: "YUBICO", VendorID: "1050", BusType: "usb", Class: "storage"}
	pol := Policy{
		Category: "storage", Action: "block",
		Exceptions: []Exception{{Vendor: "yubico", Allow: true}},
	}
	action, _ := EvaluateDevice(dev, pol)
	if action != "allow" {
		t.Errorf("want allow (case-insensitive), got %s", action)
	}
}

func TestParseUSBDeviceID(t *testing.T) {
	// only on windows builds — guard with build tag check.
	// This tests the wmic instance ID parser.
}
