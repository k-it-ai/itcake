//go:build darwin

package netdisc

import (
	"context"
	"os/exec"
	"strings"
	"time"

	"github.com/itcake/agent/internal/syspath"
)

// macOS doesn't expose the ARP table via /proc; `arp -an` is the only
// portable read. Output: "? (192.168.1.1) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]"
func platformARPTable() map[string]string {
	out := map[string]string{}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	b, err := exec.CommandContext(ctx, syspath.Arp(), "-an").Output()
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(b), "\n") {
		// expect "(IP) at MAC on ..."
		op := strings.Index(line, "(")
		cl := strings.Index(line, ")")
		if op < 0 || cl < 0 || cl < op {
			continue
		}
		ip := line[op+1 : cl]
		atIdx := strings.Index(line, " at ")
		if atIdx < 0 {
			continue
		}
		rest := strings.TrimSpace(line[atIdx+4:])
		mac := strings.SplitN(rest, " ", 2)[0]
		mac = strings.ToLower(mac)
		if mac == "" || mac == "(incomplete)" {
			continue
		}
		out[ip] = normalizeDarwinMac(mac)
	}
	return out
}

// macOS arp drops leading zeros (e.g. "1:2:3:4:5:6") — re-pad to canonical form.
func normalizeDarwinMac(mac string) string {
	parts := strings.Split(mac, ":")
	if len(parts) != 6 {
		return mac
	}
	out := make([]string, 6)
	for i, p := range parts {
		if len(p) == 1 {
			out[i] = "0" + p
		} else {
			out[i] = p
		}
	}
	return strings.Join(out, ":")
}
