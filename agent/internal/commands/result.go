package commands

import (
	"bytes"
	"io"
	"os/exec"
)

// Result represents the output of a command execution.
type Result struct {
	Status      string  `json:"status"`
	ExitCode    *int    `json:"exitCode"`
	Stdout      string  `json:"stdout"`
	Stderr      string  `json:"stderr"`
	StartedAt   string  `json:"startedAt"`
	CompletedAt *string `json:"completedAt"`
	// Transient signals the server to re-deliver next checkin (worker pool full).
	Transient bool `json:"transient,omitempty"`
}

// Caps match the server's checkinPayloadSchema limits.
const (
	MaxStdoutSize = 1 << 20
	MaxStderrSize = 1 << 18
)

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

// CappedBuffer accepts at most `cap` bytes; further writes are dropped
// (returning len(p) so the writer doesn't abort).
type CappedBuffer struct {
	buf       bytes.Buffer
	cap       int
	truncated bool
}

// NewCappedBuffer returns a CappedBuffer holding at most `cap` bytes.
func NewCappedBuffer(cap int) *CappedBuffer {
	return &CappedBuffer{cap: cap}
}

func (b *CappedBuffer) Write(p []byte) (int, error) {
	remaining := b.cap - b.buf.Len()
	if remaining <= 0 {
		b.truncated = true
		return len(p), nil
	}
	if len(p) <= remaining {
		return b.buf.Write(p)
	}
	b.buf.Write(p[:remaining])
	b.truncated = true
	return len(p), nil
}

// String returns the captured bytes with `…[truncated]` appended when capped.
func (b *CappedBuffer) String() string {
	if b.truncated {
		return b.buf.String() + "…[truncated]"
	}
	return b.buf.String()
}

func (b *CappedBuffer) Truncated() bool { return b.truncated }

// MaxCappedOutput is the default cap for RunCappedOutput.
const MaxCappedOutput = 256 * 1024

// RunCappedOutput runs cmd and returns up to cap bytes of stdout. Replaces
// bare cmd.Output() so a runaway subprocess can't OOM the agent.
func RunCappedOutput(cmd *exec.Cmd, cap int) ([]byte, error) {
	if cap <= 0 {
		cap = MaxCappedOutput
	}
	var buf bytes.Buffer
	cmd.Stdout = &limitedWriter{buf: &buf, limit: cap}
	cmd.Stderr = io.Discard
	err := cmd.Run()
	return buf.Bytes(), err
}
