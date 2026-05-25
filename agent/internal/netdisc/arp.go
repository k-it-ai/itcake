package netdisc

// ARPTable returns IP→MAC from the OS ARP cache.
func ARPTable() map[string]string {
	return platformARPTable()
}
