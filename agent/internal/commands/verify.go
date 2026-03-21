package commands

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"
)

// VerifySignature checks the HMAC-SHA256 signature of a command.
// Rejects commands older than maxAge (replay protection).
func VerifySignature(commandID, agentID, cmdType, payload, timestamp, signature, secret string, maxAge time.Duration) error {
	// Replay protection: reject commands older than maxAge
	t, err := time.Parse(time.RFC3339Nano, timestamp)
	if err != nil {
		// Try ISO format without nanos
		t, err = time.Parse("2006-01-02T15:04:05.000Z", timestamp)
		if err != nil {
			// Accept any parseable format
			t, err = time.Parse(time.RFC3339, timestamp)
			if err != nil {
				return fmt.Errorf("invalid timestamp format")
			}
		}
	}
	if time.Since(t) > maxAge {
		return fmt.Errorf("command too old (issued %v ago, max %v)", time.Since(t).Round(time.Second), maxAge)
	}

	// Compute expected HMAC
	message := fmt.Sprintf("%s:%s:%s:%s:%s", commandID, agentID, cmdType, payload, timestamp)
	key := secret
	if key == "" {
		key = "dev-only-key"
	}
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(message))
	expected := hex.EncodeToString(mac.Sum(nil))

	if !hmac.Equal([]byte(expected), []byte(signature)) {
		return fmt.Errorf("signature mismatch")
	}

	return nil
}
