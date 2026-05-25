package netdisc

import (
	"fmt"
	"net"
	"strings"
)

const (
	maxAutoSubnetHosts = 1024
	maxTargetIPs       = 8192
)

// AutoSubnets returns usable local IPv4 CIDRs, skipping loopback,
// link-local, and anything larger than /22.
func AutoSubnets() []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	out := []string{}
	seen := map[string]struct{}{}
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 {
			continue
		}
		if ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		if ifc.Flags&net.FlagPointToPoint != 0 {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipNet, ok := a.(*net.IPNet)
			if !ok || ipNet.IP.To4() == nil {
				continue
			}
			if ipNet.IP.IsLinkLocalUnicast() {
				continue
			}
			ones, bits := ipNet.Mask.Size()
			if bits != 32 || ones < 22 {
				continue
			}
			cidr := ipNet.String()
			if _, dup := seen[cidr]; dup {
				continue
			}
			seen[cidr] = struct{}{}
			out = append(out, cidr)
		}
	}
	return out
}

// expandSubnet returns per-host IPs, capped at maxAutoSubnetHosts.
func expandSubnet(cidr string) ([]net.IP, error) {
	cidr = strings.TrimSpace(cidr)
	if cidr == "" {
		return nil, fmt.Errorf("empty cidr")
	}
	if !strings.Contains(cidr, "/") {
		ip := net.ParseIP(cidr)
		if ip == nil {
			return nil, fmt.Errorf("invalid IP %q", cidr)
		}
		if ip.To4() == nil {
			return nil, fmt.Errorf("IPv6 not supported")
		}
		return []net.IP{ip.To4()}, nil
	}
	_, ipNet, err := net.ParseCIDR(cidr)
	if err != nil {
		return nil, err
	}
	if ipNet.IP.To4() == nil {
		return nil, fmt.Errorf("IPv6 not supported")
	}
	ones, bits := ipNet.Mask.Size()
	if bits != 32 {
		return nil, fmt.Errorf("only IPv4 supported")
	}
	hosts := uint64(1) << uint(bits-ones)
	if hosts > maxAutoSubnetHosts {
		hosts = maxAutoSubnetHosts
	}
	ips := make([]net.IP, 0, hosts)
	ip := ipNet.IP.Mask(ipNet.Mask).To4()
	for i := uint64(0); i < hosts; i++ {
		c := make(net.IP, 4)
		copy(c, ip)
		ips = append(ips, c)
		incIP(ip)
		if !ipNet.Contains(ip) {
			break
		}
	}
	return ips, nil
}

func incIP(ip net.IP) {
	for j := len(ip) - 1; j >= 0; j-- {
		ip[j]++
		if ip[j] != 0 {
			break
		}
	}
}
