//go:build windows

package hwinfo

import (
	"context"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/itcake/agent/internal/syspath"
)

func collect() Snapshot {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	out := Snapshot{}

	script := `$bios = Get-CimInstance Win32_BIOS; $cs = Get-CimInstance Win32_ComputerSystem; $sysencl = Get-CimInstance Win32_SystemEnclosure | Select-Object -First 1; $obj = [pscustomobject]@{ manufacturer = $cs.Manufacturer; model = $cs.Model; serialNumber = $bios.SerialNumber; biosVersion = $bios.SMBIOSBIOSVersion; biosDate = ($bios.ReleaseDate.ToString('yyyy-MM-dd')); chassisType = ($sysencl.ChassisTypes -join ',') }; $obj | ConvertTo-Json -Compress`
	cmd := exec.CommandContext(ctx, syspath.PowerShell(), "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	raw, err := cmd.Output()
	if err != nil {
		return out
	}
	body := strings.TrimSpace(string(raw))
	out.Manufacturer = pluck(body, "manufacturer")
	out.Model = pluck(body, "model")
	out.SerialNumber = pluck(body, "serialNumber")
	out.BiosVersion = pluck(body, "biosVersion")
	out.BiosDate = pluck(body, "biosDate")
	out.ChassisType = pluck(body, "chassisType")
	return out
}

// pluck extracts a JSON string field without pulling in encoding/json.
func pluck(body, field string) string {
	needle := "\"" + field + "\":"
	i := strings.Index(body, needle)
	if i < 0 {
		return ""
	}
	rest := body[i+len(needle):]
	rest = strings.TrimLeft(rest, " ")
	if strings.HasPrefix(rest, "null") {
		return ""
	}
	if !strings.HasPrefix(rest, "\"") {
		return ""
	}
	rest = rest[1:]
	end := strings.Index(rest, "\"")
	if end < 0 {
		return ""
	}
	return strings.TrimSpace(rest[:end])
}

var _ = time.Now
