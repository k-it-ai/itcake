package netdisc

import (
	"context"
	"fmt"
	"net"
	"sort"
	"sync"
	"time"
)

const portConnectTimeout = 500 * time.Millisecond

// DefaultTopPorts covers common services across server/desktop/network kit.
var DefaultTopPorts = []int{
	22, 80, 443, 445, 3389, 5900, 8080, 139, 53, 21, 25, 110, 143, 161,
	5985, 5986, 8443, 1433, 3306, 5432, 8000, 8888, 9100, 631, 6443,
	2375, 2376, 27017, 6379, 11211, 9000, 5000, 4444,
}

func ScanPorts(ctx context.Context, ip string, ports []int, concurrency int) []int {
	if concurrency <= 0 {
		concurrency = 16
	}
	openCh := make(chan int, len(ports))
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	for _, p := range ports {
		wg.Add(1)
		go func(port int) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()
			d := net.Dialer{Timeout: portConnectTimeout}
			addr := fmt.Sprintf("%s:%d", ip, port)
			conn, err := d.DialContext(ctx, "tcp", addr)
			if err != nil {
				return
			}
			conn.Close()
			select {
			case openCh <- port:
			default:
			}
		}(p)
	}
	wg.Wait()
	close(openCh)
	out := []int{}
	for p := range openCh {
		out = append(out, p)
	}
	sort.Ints(out)
	return out
}
