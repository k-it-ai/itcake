//go:build windows

package packages

func detectExtra() []Manager {
	return []Manager{
		&Winget{},
		&Choco{},
		&Scoop{},
	}
}
