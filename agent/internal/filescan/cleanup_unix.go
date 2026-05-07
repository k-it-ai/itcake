//go:build !windows

package filescan

import (
	"os"
	"syscall"
)

func mayDeleteByOwner(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return true
	}
	if stat.Uid == 0 {
		return os.Geteuid() == 0
	}
	return true
}
