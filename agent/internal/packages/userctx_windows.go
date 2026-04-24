//go:build windows

package packages

// ConsoleUser is not used on Windows — package managers run fine as
// LocalSystem (winget, choco) and scoop refuses service context anyway.
func ConsoleUser() string { return "" }
