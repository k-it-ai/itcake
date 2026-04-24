package commands

import "bytes"

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
