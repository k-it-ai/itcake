//go:build windows

package filescan

import "os"

// Windows: ownership checks would require ACL parsing via SECURITY_DESCRIPTOR
// + LookupAccountSidW; not worth the syscall surface for a defense-in-depth
// check. The path-prefix denylist already excludes C:\Windows, C:\ProgramData,
// C:\Program Files, etc. Agent normally runs as SYSTEM so the OS will let
// it delete almost anything; the protection here is the prefix allowlist.
func mayDeleteByOwner(_ os.FileInfo) bool { return true }
