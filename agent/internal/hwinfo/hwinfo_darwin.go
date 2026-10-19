//go:build darwin

package hwinfo

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/itcake/agent/internal/syspath"
)

func collect() Snapshot {
	out := Snapshot{}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	if raw, err := exec.CommandContext(ctx, syspath.SystemProfiler(), "SPHardwareDataType", "-json").Output(); err == nil {
		var parsed struct {
			SPHardwareDataType []map[string]any `json:"SPHardwareDataType"`
		}
		if json.Unmarshal(raw, &parsed) == nil && len(parsed.SPHardwareDataType) > 0 {
			h := parsed.SPHardwareDataType[0]
			out.Manufacturer = "Apple"
			out.Model, _ = h["machine_model"].(string)
			if out.Model == "" {
				out.Model, _ = h["model_name"].(string)
			}
			out.SerialNumber, _ = h["serial_number"].(string)
			out.BiosVersion, _ = h["boot_rom_version"].(string)
			out.ChassisType, _ = h["chip_type"].(string)
		}
	}

	if out.SerialNumber != "" {
		populateAppleCareWarranty(&out, out.SerialNumber)
	}
	return out
}

var datePrefixRE = regexp.MustCompile(`(?i)^(?:Renews|Expires)\s+(.+)$`)

// populateAppleCareWarranty reads <serial>.json from the AppleCare
// coverageDetails cache (same data as System Settings → Coverage).
func populateAppleCareWarranty(out *Snapshot, serial string) {
	matches, err := filepath.Glob("/Users/*/Library/Application Support/com.apple.NewDeviceOutreach/caches/coverageDetails/*.json")
	if err != nil || len(matches) == 0 {
		return
	}
	var candidates []string
	for _, m := range matches {
		base := strings.TrimSuffix(filepath.Base(m), ".json")
		if strings.EqualFold(base, serial) {
			candidates = append([]string{m}, candidates...)
		} else {
			candidates = append(candidates, m)
		}
	}
	for _, path := range candidates {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var doc map[string]any
		if json.Unmarshal(raw, &doc) != nil {
			continue
		}
		out.WarrantySource = "AppleCare"
		if label, ok := doc["coverageLabel"].(string); ok {
			out.WarrantyLabel = label
		}
		if scs, ok := doc["settingsCoverageSection"].(map[string]any); ok {
			if offer, ok := scs["offer"].(map[string]any); ok {
				if exp, ok := offer["expiration"]; ok {
					switch v := exp.(type) {
					case float64:
						out.WarrantyEndDate = time.Unix(int64(v), 0).UTC().Format("2006-01-02")
					case string:
						if n, err := strconv.ParseInt(v, 10, 64); err == nil {
							out.WarrantyEndDate = time.Unix(n, 0).UTC().Format("2006-01-02")
						} else if t, err := time.Parse("2006-01-02", v); err == nil {
							out.WarrantyEndDate = t.UTC().Format("2006-01-02")
						}
					}
				}
			}
		}
		if out.WarrantyEndDate == "" {
			if label, ok := doc["coverageExpirationLabel"].(string); ok {
				if m := datePrefixRE.FindStringSubmatch(strings.TrimSpace(label)); m != nil {
					if t, err := time.Parse("January 2, 2006", strings.TrimSpace(m[1])); err == nil {
						out.WarrantyEndDate = t.UTC().Format("2006-01-02")
					}
				}
			}
		}
		if out.WarrantyEndDate != "" {
			return
		}
	}
}
