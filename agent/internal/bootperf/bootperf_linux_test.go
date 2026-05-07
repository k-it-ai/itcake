//go:build linux

package bootperf

import "testing"

func TestParseSystemdAnalyze_FullPhases(t *testing.T) {
	in := "Startup finished in 4.123s (firmware) + 1.456s (loader) + 2.234s (kernel) + 12.789s (userspace) = 20.602s\n"
	var m Metrics
	parseSystemdAnalyze(in, &m)
	if m.BiosSeconds != 4.123 {
		t.Errorf("BiosSeconds = %v, want 4.123", m.BiosSeconds)
	}
	if m.OsLoaderSeconds != 1.456 {
		t.Errorf("OsLoaderSeconds = %v, want 1.456", m.OsLoaderSeconds)
	}
	if m.DesktopReadySeconds != 12.789 {
		t.Errorf("DesktopReadySeconds = %v, want 12.789", m.DesktopReadySeconds)
	}
	// Total = 4.123 + 1.456 + 2.234 + 12.789
	want := 20.602
	if d := m.TotalBootSeconds - want; d > 0.001 || d < -0.001 {
		t.Errorf("TotalBootSeconds = %v, want %v", m.TotalBootSeconds, want)
	}
}

func TestParseSystemdAnalyze_EuropeanLocale(t *testing.T) {
	// Some installs print with European decimals despite LC_ALL=C; we tolerate.
	in := "Startup finished in 4,123s (firmware) + 12,789s (userspace) = 16,912s\n"
	var m Metrics
	parseSystemdAnalyze(in, &m)
	if m.BiosSeconds != 4.123 {
		t.Errorf("BiosSeconds = %v, want 4.123", m.BiosSeconds)
	}
	if m.DesktopReadySeconds != 12.789 {
		t.Errorf("DesktopReadySeconds = %v, want 12.789", m.DesktopReadySeconds)
	}
}

func TestParseSystemdAnalyze_NoFirmware_VM(t *testing.T) {
	// VMs typically don't expose firmware/loader phases.
	in := "Startup finished in 1.234s (kernel) + 8.901s (userspace) = 10.135s\n"
	var m Metrics
	parseSystemdAnalyze(in, &m)
	if m.BiosSeconds != 0 {
		t.Errorf("BiosSeconds = %v, want 0", m.BiosSeconds)
	}
	if m.OsLoaderSeconds != 0 {
		t.Errorf("OsLoaderSeconds = %v, want 0", m.OsLoaderSeconds)
	}
	if m.DesktopReadySeconds != 8.901 {
		t.Errorf("DesktopReadySeconds = %v, want 8.901", m.DesktopReadySeconds)
	}
}

func TestParseSystemdAnalyze_MinutesAndMs(t *testing.T) {
	in := "Startup finished in 1min 12.456s (firmware) + 250ms (loader) + 30.5s (userspace) = 1min 43.206s\n"
	var m Metrics
	parseSystemdAnalyze(in, &m)
	if m.BiosSeconds < 72.4 || m.BiosSeconds > 72.5 {
		t.Errorf("BiosSeconds = %v, want ~72.456", m.BiosSeconds)
	}
	if m.OsLoaderSeconds != 0.25 {
		t.Errorf("OsLoaderSeconds = %v, want 0.25", m.OsLoaderSeconds)
	}
	if m.DesktopReadySeconds != 30.5 {
		t.Errorf("DesktopReadySeconds = %v, want 30.5", m.DesktopReadySeconds)
	}
}

func TestParseSystemdAnalyze_NoMatch(t *testing.T) {
	in := "some unrelated noise\nBootup is not yet finished\n"
	var m Metrics
	parseSystemdAnalyze(in, &m)
	if m.TotalBootSeconds != 0 {
		t.Errorf("TotalBootSeconds = %v, want 0", m.TotalBootSeconds)
	}
}
