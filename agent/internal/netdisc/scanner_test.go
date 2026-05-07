package netdisc

import (
	"testing"
)

func TestNormalizeOptionsAppliesDefaults(t *testing.T) {
	o := normalizeOptions(Options{})
	if o.TimeoutSeconds != defaultTimeoutSeconds {
		t.Errorf("default timeout, got %d", o.TimeoutSeconds)
	}
	if o.Concurrency != defaultConcurrency {
		t.Errorf("default concurrency, got %d", o.Concurrency)
	}
	if o.PortTopN != defaultPortTopN {
		t.Errorf("default portTopN, got %d", o.PortTopN)
	}
	if len(o.Methods) != len(defaultMethods()) {
		t.Errorf("default methods, got %v", o.Methods)
	}
}

func TestNormalizeOptionsClampsMaxima(t *testing.T) {
	o := normalizeOptions(Options{TimeoutSeconds: 9999, Concurrency: 9999, PortTopN: 9999})
	if o.TimeoutSeconds != maxTimeoutSeconds {
		t.Errorf("clamped timeout, got %d", o.TimeoutSeconds)
	}
	if o.Concurrency != maxConcurrency {
		t.Errorf("clamped concurrency, got %d", o.Concurrency)
	}
	if o.PortTopN != maxPortTopN {
		t.Errorf("clamped portTopN, got %d", o.PortTopN)
	}
}

func TestExpandSubnetSlash30(t *testing.T) {
	ips, err := expandSubnet("10.0.0.0/30")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(ips) != 4 {
		t.Errorf("/30 has 4 addrs, got %d", len(ips))
	}
}

func TestExpandSubnetSingleIP(t *testing.T) {
	ips, err := expandSubnet("10.0.0.5")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(ips) != 1 || ips[0].String() != "10.0.0.5" {
		t.Errorf("want [10.0.0.5], got %v", ips)
	}
}

func TestExpandSubnetIPv6Rejected(t *testing.T) {
	_, err := expandSubnet("fe80::/64")
	if err == nil {
		t.Error("IPv6 should be rejected")
	}
}

func TestExpandSubnetCappedAtMax(t *testing.T) {
	ips, err := expandSubnet("10.0.0.0/16")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(ips) > maxAutoSubnetHosts {
		t.Errorf("expansion exceeded cap %d: got %d", maxAutoSubnetHosts, len(ips))
	}
}

func TestExpandSubnetInvalid(t *testing.T) {
	if _, err := expandSubnet("not-a-cidr"); err == nil {
		t.Error("expected err on garbage")
	}
}

func TestTopPortsBounded(t *testing.T) {
	got := topPorts(5)
	if len(got) != 5 {
		t.Errorf("want 5, got %d", len(got))
	}
	if got := topPorts(9999); len(got) != len(DefaultTopPorts) {
		t.Errorf("over-cap should clamp to len(DefaultTopPorts)=%d, got %d", len(DefaultTopPorts), len(got))
	}
}

func TestIPLessOrders(t *testing.T) {
	if !ipLess("10.0.0.1", "10.0.0.2") {
		t.Error("10.0.0.1 < 10.0.0.2")
	}
	if ipLess("10.0.0.2", "10.0.0.1") {
		t.Error("10.0.0.2 > 10.0.0.1")
	}
	if ipLess("10.0.0.1", "10.0.0.1") {
		t.Error("equal IPs not <")
	}
}
