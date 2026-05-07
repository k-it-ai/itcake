//go:build darwin

package peripheral

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"time"
)

// Enumerate runs `system_profiler SPUSBDataType -json` and walks the
// nested `_items` tree extracting USB devices. macOS doesn't expose
// idVendor / idProduct as separate fields; the JSON has `vendor_id`
// like "0x1234  (Foo Inc.)" — we strip everything past the hex.
func Enumerate() []Device {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, "system_profiler", "SPUSBDataType", "-json").Output()
	if err != nil {
		return nil
	}

	var top map[string]any
	if err := json.Unmarshal(out, &top); err != nil {
		return nil
	}

	usb, _ := top["SPUSBDataType"].([]any)
	devices := make([]Device, 0, 16)
	for _, n := range usb {
		walkSPUSB(n, &devices)
	}
	return devices
}

func walkSPUSB(node any, out *[]Device) {
	m, ok := node.(map[string]any)
	if !ok {
		return
	}
	// Recurse into _items first — root entries are buses, only their
	// children are real devices.
	if items, ok := m["_items"].([]any); ok {
		for _, item := range items {
			walkSPUSB(item, out)
		}
	}
	vid := strings.TrimSpace(stripPastSpace(asString(m["vendor_id"])))
	pid := strings.TrimSpace(stripPastSpace(asString(m["product_id"])))
	if vid == "" && pid == "" {
		return
	}
	dev := Device{
		Vendor:       asString(m["manufacturer"]),
		VendorID:     vid,
		Product:      asString(m["_name"]),
		ProductID:    pid,
		SerialNumber: asString(m["serial_num"]),
		BusType:      "usb",
		DeviceClass:  classifySPUSB(m),
	}
	if media, ok := m["Media"].([]any); ok && len(media) > 0 {
		dev.DeviceClass = "storage"
		if first, ok := media[0].(map[string]any); ok {
			if vols, ok := first["volumes"].([]any); ok && len(vols) > 0 {
				if v, ok := vols[0].(map[string]any); ok {
					if mp := asString(v["mount_point"]); mp != "" {
						dev.Mounted = true
						dev.MountPoint = mp
					}
				}
			}
		}
	}
	*out = append(*out, dev)
}

func classifySPUSB(m map[string]any) string {
	name := strings.ToLower(asString(m["_name"]))
	switch {
	case strings.Contains(name, "keyboard"), strings.Contains(name, "mouse"), strings.Contains(name, "trackpad"):
		return "hid"
	case strings.Contains(name, "audio"), strings.Contains(name, "headset"), strings.Contains(name, "microphone"):
		return "audio"
	case strings.Contains(name, "camera"), strings.Contains(name, "webcam"):
		return "video"
	case strings.Contains(name, "printer"):
		return "printer"
	case strings.Contains(name, "ethernet"), strings.Contains(name, "wireless"):
		return "network"
	}
	return "unknown"
}

func asString(v any) string {
	if s, ok := v.(string); ok {
		return strings.TrimSpace(s)
	}
	return ""
}

func stripPastSpace(s string) string {
	if i := strings.IndexByte(s, ' '); i >= 0 {
		return s[:i]
	}
	return s
}
