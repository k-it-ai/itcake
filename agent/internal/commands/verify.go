package commands

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

// Message format signed by the server: id:agentId:type:payloadJSON:timestamp
// The exact payload string (as signed by the server) MUST be passed in —
// re-marshaling on the agent side would produce a different signature for
// semantically equal JSON.
func canonicalMessage(commandID, agentID, cmdType, payload, timestamp string) string {
	return fmt.Sprintf("%s:%s:%s:%s:%s", commandID, agentID, cmdType, payload, timestamp)
}

// VerifySignature checks the HMAC-SHA256 signature of a command.
// Rejects commands older than maxAge (replay protection) and rejects
// anything signed with a clock in the future (> 1 min skew).
//
// Security:
//   - Fails CLOSED if secret is empty — no "dev-only" fallback.
//   - Uses constant-time comparison.
//   - Parses timestamp strictly (RFC3339 / RFC3339Nano only).
func VerifySignature(commandID, agentID, cmdType, payload, timestamp, signature, secret string, maxAge time.Duration) error {
	if secret == "" {
		return errors.New("cannot verify: shared HMAC secret is empty (reenroll required)")
	}
	if commandID == "" || agentID == "" || cmdType == "" || timestamp == "" || signature == "" {
		return errors.New("command is missing required fields for signature verification")
	}

	t, err := time.Parse(time.RFC3339Nano, timestamp)
	if err != nil {
		t, err = time.Parse(time.RFC3339, timestamp)
		if err != nil {
			return errors.New("invalid timestamp format (expect RFC3339)")
		}
	}
	now := time.Now()
	if diff := now.Sub(t); diff > maxAge {
		return fmt.Errorf("command too old (issued %s ago, max %s) — possible replay", diff.Round(time.Second), maxAge)
	}
	if t.After(now.Add(1 * time.Minute)) {
		return errors.New("command timestamp is in the future — clock skew or forgery")
	}

	// Decode signature as hex first; compare bytes in constant time.
	sigBytes, err := hex.DecodeString(signature)
	if err != nil {
		return errors.New("signature is not valid hex")
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(canonicalMessage(commandID, agentID, cmdType, payload, timestamp)))
	expected := mac.Sum(nil)

	if !hmac.Equal(expected, sigBytes) {
		return errors.New("signature mismatch")
	}
	return nil
}
