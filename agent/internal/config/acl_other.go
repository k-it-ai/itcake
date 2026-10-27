//go:build !windows

package config

import "os"

// lockdownPath tightens permissions on the config file or directory.
// The Windows build has an explicit ACL implementation; Unix relies on
// POSIX mode bits.
func lockdownPath(p string) error {
	fi, err := os.Stat(p)
	if err != nil {
		return err
	}
	mode := os.FileMode(0o600)
	if fi.IsDir() {
		mode = 0o700
	}
	return os.Chmod(p, mode)
}
