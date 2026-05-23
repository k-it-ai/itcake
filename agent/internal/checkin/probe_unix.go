//go:build !windows

package checkin

import "syscall"

// probeOpenFlags adds O_NOFOLLOW on Unix so checkBinaryPathWritable refuses
// to follow a pre-planted symlink at the probe path. On Windows the flag
// doesn't exist (and the probe function itself returns early); defined as 0
// in probe_windows.go.
const probeOpenFlags = syscall.O_NOFOLLOW

// syscallETXTBSY is the Unix "text file busy" errno (filesystem refused to
// rename over a binary whose text segment is mmap'd by a running process).
// Windows doesn't have this concept — defined as a sentinel error there so
// errors.Is never matches on the Windows path.
var syscallETXTBSY = syscall.ETXTBSY
