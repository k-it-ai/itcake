package commands

import (
	"bytes"
	"io"
	"os/exec"
)

// Result represents the output of a command execution. Shared across
// every platform's executor so handlers/reporters don't need build tags.
type Result struct {
	Status      string  `json:"status"` // "running", "completed", "failed"
	ExitCode    *int    `json:"exitCode"`
	Stdout      string  `json:"stdout"`
	Stderr      string  `json:"stderr"`
	StartedAt   string  `json:"startedAt"`
	CompletedAt *string `json:"completedAt"`
}

// Caps match the server's checkinPayloadSchema limits exactly so the
// agent never buffers data the server will reject.
const (
	MaxStdoutSize = 1 << 20 // 1MB
	MaxStderrSize = 1 << 18 // 256KB
)

// limitedWriter caps bytes written to a buffer. Excess writes are
// silently dropped rather than failing — this lets a chatty command
// finish with its exit code preserved even if it overflows the cap.
type limitedWriter struct {
	buf   *bytes.Buffer
	limit int
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	remaining := w.limit - w.buf.Len()
	if remaining <= 0 {
		return len(p), nil
	}
	if len(p) > remaining {
		p = p[:remaining]
	}
	return w.buf.Write(p)
}

// MaxCappedOutput is the default cap for `RunCappedOutput`. Smaller than
// MaxStdoutSize because the use case (sysfs / wmic / system_profiler /
// journalctl output read into memory) wants to be conservative — a
// malicious peripheral exposing crafted multi-MB sysfs strings or a
// poisoned `wmic` result must not OOM the agent.
const MaxCappedOutput = 256 * 1024 // 256 KiB

// RunCappedOutput runs `cmd` and returns up to `cap` bytes of its
// combined stdout, caller's choice. Replaces the bare `cmd.Output()`
// idiom used across enumerate_*.go, eventlog_*.go, svclist_*.go, and
// every package-manager probe — those swallow the FULL stdout into a
// bytes.Buffer with no limit, so a subprocess that pushes gigabytes
// (malicious USB sysfs, corrupted journald file, hijacked package list)
// OOMs the agent.
//
// On timeout / non-zero exit, returns whatever was buffered so the
// caller can surface partial output for debugging. Returns the exec
// error so callers can still distinguish "didn't run" from "ran but
// failed."
func RunCappedOutput(cmd *exec.Cmd, cap int) ([]byte, error) {
	if cap <= 0 {
		cap = MaxCappedOutput
	}
	var buf bytes.Buffer
	cmd.Stdout = &limitedWriter{buf: &buf, limit: cap}
	// Discard stderr to keep callers' existing semantics (`.Output()`
	// returned only stdout). Callers that want stderr can build a
	// separate limitedWriter and assign cmd.Stderr explicitly.
	cmd.Stderr = io.Discard
	err := cmd.Run()
	return buf.Bytes(), err
}
