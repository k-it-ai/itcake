//go:build windows

package packages

// ConsoleUser is unused on Windows; package managers run fine as LocalSystem.
func ConsoleUser() string { return "" }
