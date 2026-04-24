//go:build windows

package packages

// detectExtra appends Windows-specific package managers to the candidate
// list. Ordering matters — we want winget first (Microsoft official) so
// UI dropdowns default to it for new installs.
func detectExtra() []Manager {
	return []Manager{
		&Winget{},
		&Choco{},
		&Scoop{},
	}
}
