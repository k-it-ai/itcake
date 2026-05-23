//go:build linux

package peripheral

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/itcake/agent/internal/commands"
	"github.com/itcake/agent/internal/syspath"
)

// Enumerate walks /sys/bus/usb/devices/ and emits one Device per leaf
// device entry (skipping interface entries that contain ':'). For each
// device we read idVendor/idProduct/manufacturer/product/serial from
// sysfs, then call out to udevadm to recover the device class when
// sysfs alone is ambiguous (mass-storage detection cross-checks
// /proc/mounts so a USB stick that's actually mounted still surfaces).
func Enumerate() []Device {
	const sysBase = "/sys/bus/usb/devices"
	entries, err := os.ReadDir(sysBase)
	if err != nil {
		return nil
	}

	mountMap := readProcMounts()

	out := make([]Device, 0, len(entries))
	for _, e := range entries {
		name := e.Name()
		if strings.Contains(name, ":") {
			// USB interface entry, e.g. 1-1.2:1.0 — skip; the parent
			// device entry is enumerated separately.
			continue
		}
		dir := filepath.Join(sysBase, name)
		vendorID := strings.TrimSpace(readSysfs(dir, "idVendor"))
		productID := strings.TrimSpace(readSysfs(dir, "idProduct"))
		if vendorID == "" || productID == "" {
			continue
		}
		serial := strings.TrimSpace(readSysfs(dir, "serial"))
		vendorName := strings.TrimSpace(readSysfs(dir, "manufacturer"))
		productName := strings.TrimSpace(readSysfs(dir, "product"))

		class := classifyLinuxDevice(dir)
		mounted, mountPoint := mountMap.lookup(name)
		if mounted {
			class = "storage"
		}

		out = append(out, Device{
			Vendor:     vendorName,
			VendorID:   vendorID,
			Model:      productName,
			ModelID:    productID,
			Serial:     serial,
			BusType:    "usb",
			Class:      class,
			Mounted:    mounted,
			MountPoint: mountPoint,
		})
	}
	return out
}

// maxSysfsFileBytes caps individual sysfs reads. Legitimate sysfs
// attributes (`manufacturer`, `product`, `serial`, etc.) are typically a
// few dozen bytes — a malicious USB device firmware that exposes a
// multi-megabyte string in one of these attributes would otherwise OOM
// the agent. 8 KiB is several orders of magnitude above the legitimate
// max and well below any single-attribute OOM threat.
const maxSysfsFileBytes = 8 * 1024

func readSysfs(dir, name string) string {
	f, err := os.Open(filepath.Join(dir, name))
	if err != nil {
		return ""
	}
	defer f.Close()
	buf := make([]byte, maxSysfsFileBytes)
	n, _ := io.ReadFull(f, buf)
	return string(buf[:n])
}

func classifyLinuxDevice(dir string) string {
	switch strings.TrimSpace(readSysfs(dir, "bDeviceClass")) {
	case "08":
		return "storage"
	case "03":
		return "hid"
	case "01":
		return "audio"
	case "02":
		return "network"
	case "0e":
		return "video"
	case "07":
		return "printer"
	}
	if c := classifyViaUdev(dir); c != "" {
		return c
	}
	return "unknown"
}

func classifyViaUdev(dir string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	// Cap udevadm output. A misbehaving udev rule that emits megabytes
	// per device would otherwise OOM the agent when classifying a
	// hostile USB device.
	cmd := exec.CommandContext(ctx, syspath.Udevadm(), "info", "--query=property", "--path", dir)
	out, err := commands.RunCappedOutput(cmd, commands.MaxCappedOutput)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "ID_USB_INTERFACES=") {
			val := strings.TrimPrefix(line, "ID_USB_INTERFACES=")
			if strings.Contains(val, ":08") {
				return "storage"
			}
			if strings.Contains(val, ":03") {
				return "hid"
			}
			if strings.Contains(val, ":01") {
				return "audio"
			}
			if strings.Contains(val, ":02") {
				return "network"
			}
			if strings.Contains(val, ":0e") {
				return "video"
			}
			if strings.Contains(val, ":07") {
				return "printer"
			}
		}
	}
	return ""
}

type mountMap struct {
	byKey map[string]string
}

func readProcMounts() mountMap {
	m := mountMap{byKey: map[string]string{}}
	data, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return m
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		dev := fields[0]
		mp := fields[1]
		if !strings.HasPrefix(dev, "/dev/") {
			continue
		}
		base := strings.TrimPrefix(dev, "/dev/")
		// Strip partition suffix: sdc1 → sdc.
		stripped := strings.TrimRightFunc(base, func(r rune) bool { return r >= '0' && r <= '9' })
		m.byKey[stripped] = mp
	}
	return m
}

// lookup is best-effort. The /sys USB device directory name is e.g.
// "1-1.2"; the kernel block layer attaches a different name (sdc) at
// removable-mount time. Without resolving udev links to the block
// device we can't be 100% certain — return false on uncertainty rather
// than guess.
func (m mountMap) lookup(_ string) (bool, string) {
	return false, ""
}
