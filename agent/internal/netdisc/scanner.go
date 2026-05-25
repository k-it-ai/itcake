package netdisc

import (
	"context"
	"fmt"
	"net"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	defaultTimeoutSeconds = 30
	maxTimeoutSeconds     = 300
	defaultConcurrency    = 32
	maxConcurrency        = 256
	defaultPortTopN       = 12
	maxPortTopN           = 50
)

func defaultMethods() []string { return []string{"arp", "ping", "port_scan", "mdns"} }

// Scan runs a single discovery pass. Over-budget scans return Truncated=true.
func Scan(opts Options) (Result, error) {
	opts = normalizeOptions(opts)
	subnets := opts.Subnets
	if len(subnets) == 0 {
		subnets = AutoSubnets()
	}
	if len(subnets) == 0 {
		return Result{}, fmt.Errorf("no subnets to scan and auto-detect found none")
	}

	methodSet := make(map[string]struct{}, len(opts.Methods))
	for _, m := range opts.Methods {
		methodSet[strings.ToLower(strings.TrimSpace(m))] = struct{}{}
	}

	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(opts.TimeoutSeconds)*time.Second)
	defer cancel()

	var allErrs []string
	allTargets := make([]string, 0, 256)
	for _, sn := range subnets {
		ips, err := expandSubnet(sn)
		if err != nil {
			allErrs = append(allErrs, sn+": "+err.Error())
			continue
		}
		for _, ip := range ips {
			allTargets = append(allTargets, ip.String())
			if len(allTargets) >= maxTargetIPs {
				break
			}
		}
		if len(allTargets) >= maxTargetIPs {
			break
		}
	}

	hosts := make(map[string]*Host)
	var hostsMu sync.Mutex
	get := func(ip string) *Host {
		hostsMu.Lock()
		defer hostsMu.Unlock()
		h, ok := hosts[ip]
		if !ok {
			h = &Host{Address: ip, LastSeen: time.Now()}
			hosts[ip] = h
		}
		return h
	}

	if _, on := methodSet["arp"]; on {
		for ip, mac := range ARPTable() {
			h := get(ip)
			h.MAC = mac
			h.Vendor = LookupVendor(mac)
		}
	}

	alive := allTargets
	if _, on := methodSet["ping"]; on {
		alive = pingSweep(ctx, allTargets, opts.Concurrency)
		for _, ip := range alive {
			get(ip).LastSeen = time.Now()
		}
	}

	var ports []int
	if _, on := methodSet["port_scan"]; on {
		ports = topPorts(opts.PortTopN)
		var wg sync.WaitGroup
		sem := make(chan struct{}, opts.Concurrency)
		for _, ip := range alive {
			wg.Add(1)
			go func(target string) {
				defer wg.Done()
				select {
				case sem <- struct{}{}:
				case <-ctx.Done():
					return
				}
				defer func() { <-sem }()
				op := ScanPorts(ctx, target, ports, 8)
				if len(op) > 0 {
					h := get(target)
					h.OpenPorts = op
				}
			}(ip)
		}
		wg.Wait()
	}

	if _, on := methodSet["mdns"]; on {
		for _, ip := range alive {
			select {
			case <-ctx.Done():
				goto skipMdns
			default:
			}
			if name := lookupHostname(ctx, ip); name != "" {
				get(ip).Hostname = name
			}
		}
	skipMdns:
	}

	for ip, mac := range ARPTable() {
		hostsMu.Lock()
		h, ok := hosts[ip]
		hostsMu.Unlock()
		if ok && h.MAC == "" {
			h.MAC = mac
			h.Vendor = LookupVendor(mac)
		}
	}

	devs := make([]Host, 0, len(hosts))
	for _, h := range hosts {
		devs = append(devs, *h)
	}
	sort.Slice(devs, func(i, j int) bool { return ipLess(devs[i].Address, devs[j].Address) })

	res := Result{
		ScannedAt:       start,
		DurationSeconds: int(time.Since(start).Seconds()),
		SubnetsScanned:  subnets,
		MethodsUsed:     opts.Methods,
		Devices:         devs,
		Truncated:       ctx.Err() != nil,
		Errors:          allErrs,
	}
	return res, nil
}

func normalizeOptions(o Options) Options {
	if o.TimeoutSeconds <= 0 {
		o.TimeoutSeconds = defaultTimeoutSeconds
	}
	if o.TimeoutSeconds > maxTimeoutSeconds {
		o.TimeoutSeconds = maxTimeoutSeconds
	}
	if o.Concurrency <= 0 {
		o.Concurrency = defaultConcurrency
	}
	if o.Concurrency > maxConcurrency {
		o.Concurrency = maxConcurrency
	}
	if o.PortTopN <= 0 {
		o.PortTopN = defaultPortTopN
	}
	if o.PortTopN > maxPortTopN {
		o.PortTopN = maxPortTopN
	}
	if len(o.Methods) == 0 {
		o.Methods = defaultMethods()
	}
	return o
}

func topPorts(n int) []int {
	if n <= 0 || n > len(DefaultTopPorts) {
		n = len(DefaultTopPorts)
	}
	if n > maxPortTopN {
		n = maxPortTopN
	}
	out := make([]int, n)
	copy(out, DefaultTopPorts[:n])
	return out
}

func pingSweep(ctx context.Context, targets []string, concurrency int) []string {
	if concurrency <= 0 {
		concurrency = 32
	}
	resCh := make(chan string, len(targets))
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	for _, ip := range targets {
		wg.Add(1)
		go func(target string) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()
			r := Ping(ctx, target)
			if r.Alive {
				resCh <- target
			}
		}(ip)
	}
	wg.Wait()
	close(resCh)
	out := []string{}
	for ip := range resCh {
		out = append(out, ip)
	}
	return out
}

func lookupHostname(ctx context.Context, ip string) string {
	r := net.Resolver{PreferGo: true}
	rctx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer cancel()
	names, err := r.LookupAddr(rctx, ip)
	if err != nil || len(names) == 0 {
		return ""
	}
	return strings.TrimSuffix(names[0], ".")
}

func ipLess(a, b string) bool {
	ipA := net.ParseIP(a)
	ipB := net.ParseIP(b)
	if ipA == nil || ipB == nil {
		return a < b
	}
	a4 := ipA.To4()
	b4 := ipB.To4()
	if a4 == nil || b4 == nil {
		return a < b
	}
	for i := 0; i < 4; i++ {
		if a4[i] != b4[i] {
			return a4[i] < b4[i]
		}
	}
	return false
}
