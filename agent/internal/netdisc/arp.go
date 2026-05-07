package netdisc

// ARPTable returns the IP→MAC map from the OS's ARP cache. Per-platform
// implementation lives in arp_{linux,darwin,windows}.go.
func ARPTable() map[string]string {
	return platformARPTable()
}
