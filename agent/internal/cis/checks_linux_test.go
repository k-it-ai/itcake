//go:build linux

package cis

import "testing"

func TestLinuxCatalogueSize(t *testing.T) {
	checks := platformChecks()
	if len(checks) < 20 {
		t.Errorf("Linux catalogue too small: %d, want ≥ 20", len(checks))
	}
	ids := make(map[string]bool, len(checks))
	for _, c := range checks {
		ids[c.ID] = true
	}
	want := []string{"1.1.1.1", "1.1.1.2", "1.1.1.3", "1.5.3", "3.2.1", "3.2.2", "3.2.3", "3.2.7", "5.2.4", "5.2.5", "5.2.6", "5.2.7", "5.2.10", "6.1.2", "6.1.3"}
	for _, w := range want {
		if !ids[w] {
			t.Errorf("missing CIS check %s in Linux catalogue", w)
		}
	}
}
