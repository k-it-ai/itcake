//go:build windows

package cis

import "testing"

func TestWindowsCatalogueSize(t *testing.T) {
	checks := platformChecks()
	if len(checks) < 18 {
		t.Errorf("Windows catalogue too small: %d, want ≥ 18", len(checks))
	}
	ids := make(map[string]bool, len(checks))
	for _, c := range checks {
		ids[c.ID] = true
	}
	want := []string{"1.1.4", "1.2.1", "1.2.2", "2.3.1.1", "2.3.1.2", "2.3.10.1", "9.1.1", "17.1.1", "17.5.1", "17.7.1", "17.7.3", "18.3.1", "18.5.4.1", "18.5.5.1"}
	for _, w := range want {
		if !ids[w] {
			t.Errorf("missing CIS check %s in Windows catalogue", w)
		}
	}
}
