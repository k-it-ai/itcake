package netdisc

import (
	"context"
	"net"
	"time"
)

const pingDialTimeout = 800 * time.Millisecond

// PingResult records a single host probe outcome. RTT is wall-clock from
// dial-start to TCP handshake completion (or DNS-style ping response in
// future ICMP backends).
type PingResult struct {
	IP      string
	Alive   bool
	Method  string
	RTT     time.Duration
}

// Ping uses TCP-connect to a small probe-port set as the liveness
// signal. ICMP requires raw sockets / CAP_NET_RAW on Linux which we
// don't want to require — and the agent process privilege model
// (LocalSystem on Windows, root via systemd on Linux) makes it
// portable, but the additional dependency surface (golang.org/x/net
// /icmp) isn't on go.sum so we deliberately stick to TCP probes.
//
// Probe ports are chosen for breadth: 80/443/22/445/3389 covers most
// active hosts on a corporate LAN. A miss on all of them is reported
// as "not alive" — false negatives are acceptable for this collector
// (operator can re-scan with custom ports).
func Ping(ctx context.Context, ip string) PingResult {
	probePorts := []int{80, 443, 22, 445, 3389}
	for _, p := range probePorts {
		select {
		case <-ctx.Done():
			return PingResult{IP: ip, Alive: false}
		default:
		}
		start := time.Now()
		d := net.Dialer{Timeout: pingDialTimeout}
		conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(ip, intToStr(p)))
		if err != nil {
			continue
		}
		conn.Close()
		return PingResult{IP: ip, Alive: true, Method: "tcp_connect", RTT: time.Since(start)}
	}
	return PingResult{IP: ip, Alive: false}
}

func intToStr(n int) string {
	if n == 0 {
		return "0"
	}
	out := []byte{}
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		out = append([]byte{byte('0' + n%10)}, out...)
		n /= 10
	}
	if neg {
		out = append([]byte{'-'}, out...)
	}
	return string(out)
}
