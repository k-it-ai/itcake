package netdisc

import (
	"context"
	"net"
	"time"
)

const pingDialTimeout = 800 * time.Millisecond

// PingResult records a single host probe outcome.
type PingResult struct {
	IP     string
	Alive  bool
	Method string
	RTT    time.Duration
}

// Ping uses TCP-connect (no ICMP — avoids CAP_NET_RAW + extra deps) to
// 80/443/22/445/3389; miss on all = not alive.
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
