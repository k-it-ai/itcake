// Package secmem provides a SecureString wrapper for sensitive bytes
// (bearer tokens, HMAC keys) that:
//
//   - returns "[REDACTED]" through every fmt.Stringer / json.Marshaler /
//     fmt.Formatter path so a stray %v or json.Marshal can't leak it.
//   - refuses to be populated from network input via UnmarshalJSON.
//   - exposes Reveal() / RevealString() at explicit call sites only.
//
// Go's GC may copy the backing slice, so Zero() is best-effort defense
// in depth — not a hard guarantee against a memory-disclosure attacker.
package secmem

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
)

const redacted = "[REDACTED]"

// SecureString wraps a byte slice owned by the SecureString. The
// internal slice is overwritten with zeros on Replace() / Zero(),
// preventing the previous plaintext from lingering on the heap as
// readable memory until GC sweeps it.
type SecureString struct {
	mu   sync.Mutex
	data []byte
}

// Wrap takes ownership of b. The caller MUST NOT retain or mutate b
// after this call — the SecureString may zero it at any time.
func Wrap(b []byte) *SecureString {
	return &SecureString{data: b}
}

// WrapString copies s into a fresh SecureString. Use this when you
// only have a string (e.g. from JSON deserialisation upstream).
func WrapString(s string) *SecureString {
	b := make([]byte, len(s))
	copy(b, s)
	return &SecureString{data: b}
}

// Reveal returns the internal byte slice for direct use (e.g.
// constructing an Authorization header). Do NOT log the returned
// slice. Returns nil if the receiver is nil or has been zeroed.
func (s *SecureString) Reveal() []byte {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data
}

// RevealString allocates a fresh string copy. The caller is responsible
// for not retaining or logging it.
func (s *SecureString) RevealString() string {
	if s == nil {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return string(s.data)
}

// Replace zeros the previous buffer and takes ownership of next.
// The caller MUST NOT retain or mutate next after this call.
func (s *SecureString) Replace(next []byte) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.data {
		s.data[i] = 0
	}
	s.data = next
}

// Zero overwrites the buffer with zeros and clears the length so a
// subsequent Reveal() returns nil. Idempotent; safe on a nil receiver.
func (s *SecureString) Zero() {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.data {
		s.data[i] = 0
	}
	s.data = nil
}

// Len returns the current plaintext length.
func (s *SecureString) Len() int {
	if s == nil {
		return 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.data)
}

// String guarantees fmt.Sprintf("%s"|"%v", s) returns "[REDACTED]".
func (s *SecureString) String() string { return redacted }

// GoString guarantees fmt.Sprintf("%#v", s) returns "[REDACTED]".
func (s *SecureString) GoString() string { return redacted }

// Format catches every other fmt verb (%q, %x, %d, ...).
func (s *SecureString) Format(f fmt.State, verb rune) {
	_, _ = f.Write([]byte(redacted))
}

// MarshalJSON ensures json.Marshal(struct containing *SecureString)
// emits "[REDACTED]" rather than the plaintext bytes.
func (s *SecureString) MarshalJSON() ([]byte, error) {
	return json.Marshal(redacted)
}

// MarshalText catches encoding.TextMarshaler-aware formats (e.g. some
// log/key=value encoders).
func (s *SecureString) MarshalText() ([]byte, error) {
	return []byte(redacted), nil
}

// UnmarshalJSON refuses to populate the SecureString from JSON input.
// This prevents an attacker-influenced server response from setting
// the agent's bearer token via a misconfigured deserialisation path.
func (s *SecureString) UnmarshalJSON(_ []byte) error {
	return errors.New("secmem: SecureString cannot be populated from JSON")
}
