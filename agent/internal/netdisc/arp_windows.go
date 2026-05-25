//go:build windows

package netdisc

import (
	"context"
	"os/exec"
	"strings"
	"time"

	"github.com/itcake/agent/internal/syspath"
)

// platformARPTable parses `arp -a` output (columns: Internet Address /
// Physical Address / Type).
func platformARPTable() map[string]string {
	out := map[string]string{}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	b, err := exec.CommandContext(ctx, syspath.Arp(), "-a").Output()
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(b), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		ip := fields[0]
		mac := strings.ToLower(strings.ReplaceAll(fields[1], "-", ":"))
		if !looksLikeIPv4(ip) || !looksLikeMac(mac) {
			continue
		}
		out[ip] = mac
	}
	return out
}

func looksLikeIPv4(s string) bool {
	parts := strings.Split(s, ".")
	if len(parts) != 4 {
		return false
	}
	for _, p := range parts {
		if len(p) == 0 || len(p) > 3 {
			return false
		}
		for _, c := range p {
			if c < '0' || c > '9' {
				return false
			}
		}
	}
	return true
}

func looksLikeMac(s string) bool {
	if len(s) != 17 {
		return false
	}
	for i, c := range s {
		if i%3 == 2 {
			if c != ':' {
				return false
			}
			continue
		}
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}
