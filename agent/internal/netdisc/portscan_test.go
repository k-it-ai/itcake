package netdisc

import (
	"context"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestScanPortsHitsListener(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer l.Close()
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	addr := l.Addr().String()
	colon := strings.LastIndex(addr, ":")
	port, _ := strconv.Atoi(addr[colon+1:])

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	open := ScanPorts(ctx, "127.0.0.1", []int{port}, 4)
	if len(open) != 1 || open[0] != port {
		t.Errorf("want [%d] open, got %v", port, open)
	}
}

func TestScanPortsMissesClosed(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	open := ScanPorts(ctx, "127.0.0.1", []int{1}, 4)
	if len(open) != 0 {
		t.Errorf("port 1 closed locally; want empty, got %v", open)
	}
}

func TestPingDeadHostReturnsNotAlive(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	r := Ping(ctx, "192.0.2.123")
	if r.Alive {
		t.Errorf("TEST-NET-1 host should not be alive")
	}
}
