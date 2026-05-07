package netdisc

import "testing"

func TestLookupVendorKnown(t *testing.T) {
	cases := []struct {
		mac    string
		vendor string
	}{
		{"b8:27:eb:12:34:56", "Raspberry Pi"},
		{"B8-27-EB-12-34-56", "Raspberry Pi"},
		{"b827eb123456", "Raspberry Pi"},
		{"00:0c:29:de:ad:be", "VMware"},
		{"08:00:27:01:02:03", "Oracle VirtualBox"},
	}
	for _, c := range cases {
		if got := LookupVendor(c.mac); got != c.vendor {
			t.Errorf("LookupVendor(%q) = %q, want %q", c.mac, got, c.vendor)
		}
	}
}

func TestLookupVendorUnknown(t *testing.T) {
	if got := LookupVendor("ff:ff:ff:00:00:00"); got != "" {
		t.Errorf("unknown OUI should return empty, got %q", got)
	}
}

func TestLookupVendorEmptyOrShort(t *testing.T) {
	if got := LookupVendor(""); got != "" {
		t.Errorf("empty MAC should return empty, got %q", got)
	}
	if got := LookupVendor("ab:cd"); got != "" {
		t.Errorf("short MAC should return empty, got %q", got)
	}
}
