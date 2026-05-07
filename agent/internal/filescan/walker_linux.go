//go:build linux

package filescan

import (
	"bufio"
	"os"
	"strings"
	"sync"
)

var (
	netMountsOnce  sync.Once
	netMountPoints map[string]struct{}
)

func loadLinuxNetMounts() {
	netMountPoints = map[string]struct{}{}
	f, err := os.Open("/proc/mounts")
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 3 {
			continue
		}
		fstype := fields[2]
		switch fstype {
		case "nfs", "nfs4", "cifs", "smbfs", "smb3", "afp", "fuse.sshfs", "davfs":
			netMountPoints[fields[1]] = struct{}{}
		}
	}
}

func platformIsNetworkMount(dir string) bool {
	netMountsOnce.Do(loadLinuxNetMounts)
	_, ok := netMountPoints[dir]
	return ok
}
