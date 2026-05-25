package commands

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

// canonicalMessage builds the signing string `id:agentId:type:payloadJSON:timestamp`.
// payload MUST be the exact bytes the server signed — re-marshaling would
// produce a different signature for semantically equal JSON.
func canonicalMessage(commandID, agentID, cmdType, payload, timestamp string) string {
	return fmt.Sprintf("%s:%s:%s:%s:%s", commandID, agentID, cmdType, payload, timestamp)
}

// VerifySignature checks the HMAC-SHA256 signature, rejects commands older
// than maxAge or signed >1 min in the future. Fails closed on empty secret.
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
