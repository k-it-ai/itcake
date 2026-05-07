//go:build linux

package netdisc

import (
	"bufio"
	"os"
	"strings"
)

func platformARPTable() map[string]string {
	out := map[string]string{}
	f, err := os.Open("/proc/net/arp")
	if err != nil {
		return out
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	first := true
	for sc.Scan() {
		if first {
			first = false
			continue
		}
		fields := strings.Fields(sc.Text())
		if len(fields) < 4 {
			continue
		}
		ip := fields[0]
		mac := strings.ToLower(fields[3])
		if mac == "00:00:00:00:00:00" || mac == "" {
			continue
		}
		out[ip] = mac
	}
	return out
}
