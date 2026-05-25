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
	"runtime"
	"sync"
)

const redacted = "[REDACTED]"

// SecureString wraps a byte slice. Replace/Zero overwrite the previous
// plaintext so it doesn't linger on the heap until GC sweeps.
type SecureString struct {
	mu   sync.Mutex
	data []byte
}

// Wrap takes ownership of b — caller MUST NOT retain or mutate after this call.
func Wrap(b []byte) *SecureString {
	return &SecureString{data: b}
}

// WrapString copies s into a fresh SecureString.
func WrapString(s string) *SecureString {
	b := make([]byte, len(s))
	copy(b, s)
	return &SecureString{data: b}
}

// Reveal returns the internal slice. Do NOT log.
func (s *SecureString) Reveal() []byte {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data
}

// RevealString allocates a fresh copy. Caller must not retain or log it.
func (s *SecureString) RevealString() string {
	if s == nil {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return string(s.data)
}

// Replace zeros the previous buffer and takes ownership of next.
//
//go:noinline
func (s *SecureString) Replace(next []byte) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.data {
		s.data[i] = 0
	}
	// KeepAlive prevents dead-store elimination of the zeroing loop.
	runtime.KeepAlive(s.data)
	s.data = next
}

// Zero overwrites the buffer with zeros. Idempotent; nil-safe.
//
//go:noinline
func (s *SecureString) Zero() {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	prev := s.data
	for i := range prev {
		prev[i] = 0
	}
	// KeepAlive prevents dead-store elimination of the zeroing loop.
	runtime.KeepAlive(prev)
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

func (s *SecureString) String() string   { return redacted }
func (s *SecureString) GoString() string { return redacted }

// Format catches every fmt verb (%q, %x, %d, ...).
func (s *SecureString) Format(f fmt.State, verb rune) {
	_, _ = f.Write([]byte(redacted))
}

func (s *SecureString) MarshalJSON() ([]byte, error) { return json.Marshal(redacted) }
func (s *SecureString) MarshalText() ([]byte, error) { return []byte(redacted), nil }

// UnmarshalJSON refuses JSON input — prevents an attacker-influenced
// response from setting the agent's bearer token via deserialisation.
func (s *SecureString) UnmarshalJSON(_ []byte) error {
	return errors.New("secmem: SecureString cannot be populated from JSON")
}
