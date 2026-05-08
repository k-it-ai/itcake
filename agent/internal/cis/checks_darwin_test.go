//go:build darwin

package cis

import "testing"

func TestDarwinCatalogueSize(t *testing.T) {
	checks := platformChecks()
	if len(checks) < 16 {
		t.Errorf("macOS catalogue too small: %d, want ≥ 16", len(checks))
	}
	ids := make(map[string]bool, len(checks))
	for _, c := range checks {
		ids[c.ID] = true
	}
	want := []string{"2.2.1", "2.2.2", "2.4.2", "2.4.3", "2.4.4", "2.4.7", "2.4.8", "2.5.1", "5.1.1", "5.1.4"}
	for _, w := range want {
		if !ids[w] {
			t.Errorf("missing CIS check %s in macOS catalogue", w)
		}
	}
}
