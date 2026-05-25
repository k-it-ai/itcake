//go:build windows

package checkin

import "errors"

// Windows: checkBinaryPathWritable returns early on this platform; the open
// flags are unused. O_NOFOLLOW has no Windows equivalent.
const probeOpenFlags = 0

// syscallETXTBSY: Windows doesn't have a "text file busy" errno (the SCM
// rename-aside path handles the equivalent). Use a sentinel error that
// errors.Is will never match against an os.Rename error so the Unix
// fallback branch is unreachable on this platform.
var syscallETXTBSY = errors.New("etxtbsy (windows sentinel — unreachable)")
