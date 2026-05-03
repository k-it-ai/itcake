//go:build !windows

package config

// On non-Windows platforms, file-mode bits (0o700 on dir, 0o600 on
// file) already restrict access to the service identity, so this is
// a no-op. The Windows variant in acl_windows.go does the work that
// Go's os.WriteFile mode bits silently skip on Windows.
func lockdownPath(_ string) error { return nil }
