//go:build !windows

package packages

// detectExtra appends no extra managers on non-Windows; Linux/macOS
// rely on the cross-platform brew/apt/etc. already listed in detect.go.
func detectExtra() []Manager { return nil }
