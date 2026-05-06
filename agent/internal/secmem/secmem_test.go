package secmem

import (
	"bytes"
	"encoding/json"
	"fmt"
	"testing"
)

func TestWrapAndReveal(t *testing.T) {
	s := WrapString("hunter2")
	if got := string(s.Reveal()); got != "hunter2" {
		t.Fatalf("Reveal=%q want hunter2", got)
	}
	if got := s.RevealString(); got != "hunter2" {
		t.Fatalf("RevealString=%q want hunter2", got)
	}
	if s.Len() != 7 {
		t.Fatalf("Len=%d want 7", s.Len())
	}
}

func TestWrapTakesOwnership(t *testing.T) {
	buf := []byte("secret")
	s := Wrap(buf)
	if got := string(s.Reveal()); got != "secret" {
		t.Fatalf("Reveal=%q want secret", got)
	}
	s.Zero()
	for i, b := range buf {
		if b != 0 {
			t.Fatalf("Wrap did not take ownership: byte %d=%d after Zero()", i, b)
		}
	}
}

func TestZeroAfterReplace(t *testing.T) {
	s := WrapString("old-token")
	old := s.Reveal()
	if !bytes.Equal(old, []byte("old-token")) {
		t.Fatalf("pre-Replace Reveal mismatch")
	}
	s.Replace([]byte("new-token"))
	// The slice header old is the same backing array; check it was zeroed.
	for i, b := range old {
		if b != 0 {
			t.Fatalf("old buffer not zeroed after Replace: byte %d=%d", i, b)
		}
	}
	if got := s.RevealString(); got != "new-token" {
		t.Fatalf("post-Replace Reveal=%q want new-token", got)
	}
}

func TestZeroIdempotent(t *testing.T) {
	s := WrapString("x")
	s.Zero()
	s.Zero() // must not panic
	if s.Len() != 0 {
		t.Fatalf("Len after Zero=%d want 0", s.Len())
	}
	if r := s.Reveal(); r != nil {
		t.Fatalf("Reveal after Zero=%v want nil", r)
	}
}

func TestNilReceiver(t *testing.T) {
	var s *SecureString
	if r := s.Reveal(); r != nil {
		t.Fatalf("nil Reveal=%v want nil", r)
	}
	if r := s.RevealString(); r != "" {
		t.Fatalf("nil RevealString=%q want empty", r)
	}
	s.Zero()                  // must not panic
	s.Replace([]byte("x"))    // must not panic
	if l := s.Len(); l != 0 { // must not panic
		t.Fatalf("nil Len=%d want 0", l)
	}
}

func TestFormatRedacts(t *testing.T) {
	s := WrapString("super-secret-token")
	cases := []string{
		fmt.Sprintf("%v", s),
		fmt.Sprintf("%s", s),
		fmt.Sprintf("%q", s),
		fmt.Sprintf("%#v", s),
		fmt.Sprintf("%x", s),
		fmt.Sprintf("%+v", s),
	}
	for i, got := range cases {
		if got != "[REDACTED]" && got != `"[REDACTED]"` {
			t.Errorf("case %d: %q leaked: %q", i, []string{"%v", "%s", "%q", "%#v", "%x", "%+v"}[i], got)
		}
	}
}

func TestMarshalJSONRedacts(t *testing.T) {
	s := WrapString("super-secret-token")
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if string(b) != `"[REDACTED]"` {
		t.Fatalf("MarshalJSON=%q want \"[REDACTED]\"", string(b))
	}
	// Embedded inside a struct.
	wrapper := struct {
		Token *SecureString `json:"token"`
	}{Token: s}
	b, err = json.Marshal(&wrapper)
	if err != nil {
		t.Fatalf("Marshal wrapper: %v", err)
	}
	if string(b) != `{"token":"[REDACTED]"}` {
		t.Fatalf("wrapped MarshalJSON=%q", string(b))
	}
}

func TestMarshalTextRedacts(t *testing.T) {
	s := WrapString("xyz")
	b, err := s.MarshalText()
	if err != nil {
		t.Fatalf("MarshalText: %v", err)
	}
	if string(b) != "[REDACTED]" {
		t.Fatalf("MarshalText=%q", string(b))
	}
}

func TestUnmarshalJSONErrors(t *testing.T) {
	var s SecureString
	if err := json.Unmarshal([]byte(`"attacker-controlled"`), &s); err == nil {
		t.Fatalf("UnmarshalJSON accepted input; want error")
	}
	// And the SecureString must not have been populated.
	if r := s.RevealString(); r != "" {
		t.Fatalf("SecureString populated despite UnmarshalJSON error: %q", r)
	}
}
