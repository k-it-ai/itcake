package commands

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"
)

func sign(t *testing.T, secret, cmdID, agentID, cmdType, payload, ts string) string {
	t.Helper()
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(canonicalMessage(cmdID, agentID, cmdType, payload, ts)))
	return hex.EncodeToString(mac.Sum(nil))
}

func TestVerifySignature_Valid(t *testing.T) {
	secret := "test-secret"
	ts := time.Now().UTC().Format(time.RFC3339)
	sig := sign(t, secret, "cmd-1", "agent-1", "shell", `{"command":"echo hi"}`, ts)
	if err := VerifySignature("cmd-1", "agent-1", "shell", `{"command":"echo hi"}`, ts, sig, secret, 5*time.Minute); err != nil {
		t.Fatalf("expected valid, got %v", err)
	}
}

func TestVerifySignature_Mismatch(t *testing.T) {
	ts := time.Now().UTC().Format(time.RFC3339)
	// Signed with one payload, verified against another.
	sig := sign(t, "k", "cmd-1", "a", "shell", `{"command":"ls"}`, ts)
	if err := VerifySignature("cmd-1", "a", "shell", `{"command":"rm -rf /"}`, ts, sig, "k", 5*time.Minute); err == nil {
		t.Fatal("expected mismatch error")
	}
}

func TestVerifySignature_BadHex(t *testing.T) {
	ts := time.Now().UTC().Format(time.RFC3339)
	if err := VerifySignature("cmd", "a", "shell", "{}", ts, "not-hex", "k", 5*time.Minute); err == nil {
		t.Fatal("expected hex decode error")
	}
}

func TestVerifySignature_Expired(t *testing.T) {
	secret := "k"
	ts := time.Now().Add(-10 * time.Minute).UTC().Format(time.RFC3339)
	sig := sign(t, secret, "cmd", "a", "shell", "{}", ts)
	if err := VerifySignature("cmd", "a", "shell", "{}", ts, sig, secret, 5*time.Minute); err == nil {
		t.Fatal("expected expiry error")
	}
}

func TestVerifySignature_FutureSkew(t *testing.T) {
	secret := "k"
	ts := time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339)
	sig := sign(t, secret, "cmd", "a", "shell", "{}", ts)
	if err := VerifySignature("cmd", "a", "shell", "{}", ts, sig, secret, 5*time.Minute); err == nil {
		t.Fatal("expected future-skew rejection")
	}
}

func TestVerifySignature_EmptySecret_FailsClosed(t *testing.T) {
	// Fail closed: an agent with no shared secret must refuse all signatures,
	// even if they happen to match a fallback key.
	ts := time.Now().UTC().Format(time.RFC3339)
	if err := VerifySignature("cmd", "a", "shell", "{}", ts, "deadbeef", "", 5*time.Minute); err == nil {
		t.Fatal("expected empty-secret rejection")
	}
}

func TestVerifySignature_MissingFields(t *testing.T) {
	ts := time.Now().UTC().Format(time.RFC3339)
	cases := []struct {
		name                                           string
		id, agent, typ, payload, timestamp, signature string
	}{
		{"noID", "", "a", "shell", "{}", ts, "ab"},
		{"noAgent", "c", "", "shell", "{}", ts, "ab"},
		{"noType", "c", "a", "", "{}", ts, "ab"},
		{"noTS", "c", "a", "shell", "{}", "", "ab"},
		{"noSig", "c", "a", "shell", "{}", ts, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := VerifySignature(tc.id, tc.agent, tc.typ, tc.payload, tc.timestamp, tc.signature, "secret", 5*time.Minute)
			if err == nil {
				t.Fatalf("expected error for %s", tc.name)
			}
		})
	}
}

func TestReplayCache_BlocksDuplicates(t *testing.T) {
	rc := NewReplayCache(5 * time.Minute)
	if !rc.Check("cmd-1") {
		t.Fatal("first call must succeed")
	}
	if rc.Check("cmd-1") {
		t.Fatal("replay must be blocked")
	}
	if !rc.Check("cmd-2") {
		t.Fatal("distinct id must succeed")
	}
}
