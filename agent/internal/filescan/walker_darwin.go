//go:build darwin

package filescan

import (
	"bytes"
	"sync"

	"golang.org/x/sys/unix"
)

var (
	darwinNetTypes = map[string]struct{}{
		"nfs":    {},
		"smbfs":  {},
		"afpfs":  {},
		"webdav": {},
	}
	darwinSeenMu sync.Mutex
	darwinSeen   = map[string]bool{}
)

func platformIsNetworkMount(dir string) bool {
	darwinSeenMu.Lock()
	if v, ok := darwinSeen[dir]; ok {
		darwinSeenMu.Unlock()
		return v
	}
	darwinSeenMu.Unlock()
	var st unix.Statfs_t
	if err := unix.Statfs(dir, &st); err != nil {
		return false
	}
	name := bytesToString(st.Fstypename[:])
	_, ok := darwinNetTypes[name]
	darwinSeenMu.Lock()
	darwinSeen[dir] = ok
	darwinSeenMu.Unlock()
	return ok
}

func bytesToString(b []byte) string {
	if i := bytes.IndexByte(b, 0); i >= 0 {
		b = b[:i]
	}
	return string(b)
}
