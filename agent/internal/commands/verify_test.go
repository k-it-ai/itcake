package commands

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"testing"
	"time"
)

func TestVerifySignature_Valid(t *testing.T) {
	secret := "test-secret"
	cmdID := "cmd-1"
	agentID := "agent-1"
	cmdType := "shell"
	payload := `{"command":"echo hello"}`
	timestamp := time.Now().UTC().Format(time.RFC3339)

	// Generate a valid signature
	message := fmt.Sprintf("%s:%s:%s:%s:%s", cmdID, agentID, cmdType, payload, timestamp)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(message))
	signature := hex.EncodeToString(mac.Sum(nil))

	err := VerifySignature(cmdID, agentID, cmdType, payload, timestamp, signature, secret, 5*time.Minute)
	if err != nil {
		t.Fatalf("expected valid signature, got error: %v", err)
	}
}

func TestVerifySignature_Invalid(t *testing.T) {
	secret := "test-secret"
	timestamp := time.Now().UTC().Format(time.RFC3339)

	err := VerifySignature("cmd-1", "agent-1", "shell", "{}", timestamp, "invalid-hex", secret, 5*time.Minute)
	if err == nil {
		t.Fatal("expected error for invalid signature")
	}
}

func TestVerifySignature_Expired(t *testing.T) {
	secret := "test-secret"
	oldTime := time.Now().Add(-10 * time.Minute).UTC().Format(time.RFC3339)

	message := fmt.Sprintf("cmd-1:agent-1:shell:{}:%s", oldTime)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(message))
	signature := hex.EncodeToString(mac.Sum(nil))

	err := VerifySignature("cmd-1", "agent-1", "shell", "{}", oldTime, signature, secret, 5*time.Minute)
	if err == nil {
		t.Fatal("expected error for expired command")
	}
}
