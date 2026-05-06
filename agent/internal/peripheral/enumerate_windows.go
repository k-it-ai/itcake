//go:build windows

package peripheral

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// Enumerate uses `wmic` to list USB hubs / devices then `Get-PnpDevice`
// to recover serial numbers. AV-friendly: no Invoke-Expression, no
// inline scripts — both are exec'd subcommands with bounded args.
//
// wmic is deprecated in newer Windows versions, but still ships and is
// far less suspicious than spawning powershell.exe. If wmic returns no
// output we fall back to a single Get-PnpDevice call.
func Enumerate() []Device {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "wmic", "path", "Win32_PnPEntity",
		"where", `PNPDeviceID like 'USB%'`, "get",
		"DeviceID,Name,Manufacturer,Description", "/format:csv")
	out, err := cmd.Output()
	if err != nil {
		return enumerateViaPowershell()
	}
	devices := parseWmicCsv(string(out))
	if len(devices) == 0 {
		return enumerateViaPowershell()
	}
	return devices
}

func enumerateViaPowershell() []Device {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive",
		"-Command",
		"Get-PnpDevice -PresentOnly -Class USB | Select-Object Manufacturer,FriendlyName,InstanceId | ConvertTo-Csv -NoTypeInformation").Output()
	if err != nil {
		return nil
	}
	return parsePnpCsv(string(out))
}

func parseWmicCsv(text string) []Device {
	lines := strings.Split(text, "\n")
	if len(lines) < 2 {
		return nil
	}
	header := splitCsvLine(strings.TrimSpace(lines[0]))
	idx := func(name string) int {
		for i, h := range header {
			if strings.EqualFold(h, name) {
				return i
			}
		}
		return -1
	}
	deviceIDIdx := idx("DeviceID")
	nameIdx := idx("Name")
	mfrIdx := idx("Manufacturer")
	out := make([]Device, 0, 16)
	for _, line := range lines[1:] {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := splitCsvLine(line)
		if deviceIDIdx < 0 || deviceIDIdx >= len(fields) {
			continue
		}
		devID := fields[deviceIDIdx]
		vid, pid, serial := parseUSBDeviceID(devID)
		if vid == "" {
			continue
		}
		mfr := ""
		if mfrIdx >= 0 && mfrIdx < len(fields) {
			mfr = fields[mfrIdx]
		}
		nm := ""
		if nameIdx >= 0 && nameIdx < len(fields) {
			nm = fields[nameIdx]
		}
		out = append(out, Device{
			Vendor:       mfr,
			VendorID:     vid,
			Product:      nm,
			ProductID:    pid,
			SerialNumber: serial,
			BusType:      "usb",
			DeviceClass:  classifyByName(nm),
		})
	}
	return out
}

func parsePnpCsv(text string) []Device {
	lines := strings.Split(text, "\n")
	if len(lines) < 2 {
		return nil
	}
	out := make([]Device, 0, 16)
	for _, line := range lines[1:] {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := splitCsvLine(line)
		if len(fields) < 3 {
			continue
		}
		mfr := strings.TrimSpace(fields[0])
		name := strings.TrimSpace(fields[1])
		instance := strings.TrimSpace(fields[2])
		vid, pid, serial := parseUSBDeviceID(instance)
		if vid == "" {
			continue
		}
		out = append(out, Device{
			Vendor: mfr, VendorID: vid,
			Product: name, ProductID: pid,
			SerialNumber: serial,
			BusType:      "usb",
			DeviceClass:  classifyByName(name),
		})
	}
	return out
}

// parseUSBDeviceID extracts vid/pid/serial from a Windows USB device
// instance ID like "USB\VID_1234&PID_5678\ABC123". Returns empty strings
// when the format doesn't match.
func parseUSBDeviceID(id string) (vid, pid, serial string) {
	id = strings.ToUpper(id)
	parts := strings.Split(id, `\`)
	for _, p := range parts {
		if strings.HasPrefix(p, "VID_") {
			fragments := strings.Split(p, "&")
			for _, f := range fragments {
				if strings.HasPrefix(f, "VID_") && len(f) >= 8 {
					vid = strings.ToLower(f[4:8])
				}
				if strings.HasPrefix(f, "PID_") && len(f) >= 8 {
					pid = strings.ToLower(f[4:8])
				}
			}
		}
	}
	if len(parts) >= 3 {
		serial = parts[2]
		if strings.Contains(serial, "&") {
			serial = ""
		}
	}
	return
}

func classifyByName(name string) string {
	low := strings.ToLower(name)
	switch {
	case strings.Contains(low, "mass storage"), strings.Contains(low, "disk"):
		return "storage"
	case strings.Contains(low, "keyboard"), strings.Contains(low, "mouse"), strings.Contains(low, "hid"):
		return "hid"
	case strings.Contains(low, "audio"), strings.Contains(low, "headset"), strings.Contains(low, "microphone"):
		return "audio"
	case strings.Contains(low, "camera"), strings.Contains(low, "webcam"):
		return "video"
	case strings.Contains(low, "printer"):
		return "printer"
	case strings.Contains(low, "ethernet"), strings.Contains(low, "wireless"), strings.Contains(low, "network"):
		return "network"
	}
	return "unknown"
}

func splitCsvLine(line string) []string {
	out := make([]string, 0, 8)
	var sb strings.Builder
	inQuote := false
	for i := 0; i < len(line); i++ {
		c := line[i]
		if c == '"' {
			inQuote = !inQuote
			continue
		}
		if c == ',' && !inQuote {
			out = append(out, sb.String())
			sb.Reset()
			continue
		}
		sb.WriteByte(c)
	}
	out = append(out, sb.String())
	return out
}
