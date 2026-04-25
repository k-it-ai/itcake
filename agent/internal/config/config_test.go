package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateServerURL_AcceptsHTTPS(t *testing.T) {
	if err := ValidateServerURL("https://itcake.example.com"); err != nil {
		t.Fatalf("https should be accepted: %v", err)
	}
	if err := ValidateServerURL("https://itcake.local:8443/"); err != nil {
		t.Fatalf("https with port + trailing slash should be accepted: %v", err)
	}
}

func TestValidateServerURL_RejectsHTTPByDefault(t *testing.T) {
	_ = os.Unsetenv("ITCAKE_ALLOW_HTTP")
	err := ValidateServerURL("http://itcake.example.com")
	if err == nil {
		t.Fatal("http:// must be rejected without ITCAKE_ALLOW_HTTP")
	}
	if !strings.Contains(err.Error(), "ITCAKE_ALLOW_HTTP") {
		t.Errorf("error message should mention the override flag: %v", err)
	}
}

func TestValidateServerURL_AcceptsHTTPWithOverride(t *testing.T) {
	t.Setenv("ITCAKE_ALLOW_HTTP", "1")
	if err := ValidateServerURL("http://localhost:3000"); err != nil {
		t.Fatalf("http should be accepted with ITCAKE_ALLOW_HTTP=1: %v", err)
	}
}

func TestValidateServerURL_RejectsOtherSchemes(t *testing.T) {
	bad := []string{
		"ftp://itcake.example.com",
		"file:///etc/passwd",
		"javascript:alert(1)",
		"gopher://itcake.example.com",
	}
	for _, u := range bad {
		if err := ValidateServerURL(u); err == nil {
			t.Errorf("scheme in %q should have been rejected", u)
		}
	}
}

func TestValidateServerURL_RejectsMissingHost(t *testing.T) {
	bad := []string{
		"https://",
		"https:///path",
		"://no-scheme",
	}
	for _, u := range bad {
		if err := ValidateServerURL(u); err == nil {
			t.Errorf("empty host in %q should have been rejected", u)
		}
	}
}

// Load/Save round-trip: proves the AES-GCM machine-bound encryption works
// end-to-end and that the bearer token + HMAC secret survive a write/read
// cycle without plaintext leakage.
func TestConfigSaveLoadRoundtrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")

	// Allow http for this test so we can use a localhost URL without
	// depending on TLS certs.
	t.Setenv("ITCAKE_ALLOW_HTTP", "1")

	original := &Config{
		ServerURL:       "http://127.0.0.1:3000",
		Token:           "c0ffee00c0ffee00c0ffee00c0ffee00",
		HMACSecret:      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		AgentID:         "agent-test-001",
		CheckinInterval: 45,
		TLSPinSHA256:    "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
	}

	if err := original.Save(path); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	// The on-disk file must NEVER contain the plaintext token or HMAC secret.
	diskBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config file: %v", err)
	}
	disk := string(diskBytes)
	if strings.Contains(disk, original.Token) {
		t.Fatal("on-disk config leaks plaintext bearer token — encryption broken")
	}
	if strings.Contains(disk, original.HMACSecret) {
		t.Fatal("on-disk config leaks plaintext hmac secret — encryption broken")
	}
	// The encrypted blobs should have the `v1:` prefix the package uses.
	if !strings.Contains(disk, `"tokenEnc": "v1:`) {
		t.Error("expected encrypted token with v1: prefix in config file")
	}
	if !strings.Contains(disk, `"hmacSecretEnc": "v1:`) {
		t.Error("expected encrypted hmac secret with v1: prefix in config file")
	}

	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if loaded.Token != original.Token {
		t.Errorf("token round-trip: got %q, want %q", loaded.Token, original.Token)
	}
	if loaded.HMACSecret != original.HMACSecret {
		t.Errorf("hmacSecret round-trip: got %q, want %q", loaded.HMACSecret, original.HMACSecret)
	}
	if loaded.AgentID != original.AgentID {
		t.Errorf("agentID: got %q, want %q", loaded.AgentID, original.AgentID)
	}
	if loaded.TLSPinSHA256 != original.TLSPinSHA256 {
		t.Errorf("TLS pin: got %q, want %q", loaded.TLSPinSHA256, original.TLSPinSHA256)
	}
	if loaded.CheckinInterval != original.CheckinInterval {
		t.Errorf("checkinInterval: got %d, want %d", loaded.CheckinInterval, original.CheckinInterval)
	}
}

func TestConfigLoad_RejectsMissingToken(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	t.Setenv("ITCAKE_ALLOW_HTTP", "1")

	// Write a config with no token (simulates a half-written file or a
	// config that was never successfully enrolled).
	empty := `{"serverUrl":"http://127.0.0.1:3000","agentId":"a","checkinInterval":60}`
	if err := os.WriteFile(path, []byte(empty), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := Load(path)
	if err == nil {
		t.Fatal("Load should reject config with no bearer token")
	}
}

func TestConfigLoad_RejectsInvalidServerURL(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")

	original := &Config{
		ServerURL:       "https://itcake.example.com",
		Token:           "c0ffee00c0ffee00c0ffee00c0ffee00",
		HMACSecret:      "0123456789abcdef0123456789abcdef",
		AgentID:         "agent-rej-001",
		CheckinInterval: 60,
	}
	if err := original.Save(path); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	// Manually corrupt the server URL to a file:// scheme — Load should refuse.
	data, _ := os.ReadFile(path)
	corrupted := strings.Replace(string(data), "https://itcake.example.com", "file:///etc/passwd", 1)
	if err := os.WriteFile(path, []byte(corrupted), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := Load(path)
	if err == nil {
		t.Fatal("Load should reject file:// URL")
	}
}

func TestConfigLoad_FailsIfMachineIDChanges(t *testing.T) {
	// This test is informational: on a real system, the machine-id is fixed.
	// We can't change it here, but we can verify that decryption of a
	// ciphertext produced with a different key (simulated via a different
	// salt/nonce boundary) fails cleanly rather than returning garbage.
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	t.Setenv("ITCAKE_ALLOW_HTTP", "1")

	// Save with the real machine key.
	orig := &Config{
		ServerURL: "http://127.0.0.1:3000",
		Token:     "c0ffee00c0ffee00c0ffee00c0ffee00",
		AgentID:   "a",
	}
	if err := orig.Save(path); err != nil {
		t.Fatal(err)
	}
	// Now corrupt the ciphertext — flip a byte in the base64 payload so the
	// GCM tag check fails. We find "v1:" and change the first char after it.
	data, _ := os.ReadFile(path)
	s := string(data)
	idx := strings.Index(s, `"tokenEnc": "v1:`)
	if idx < 0 {
		t.Fatal("could not locate tokenEnc in config")
	}
	// Offset to the first ciphertext char and flip it.
	pos := idx + len(`"tokenEnc": "v1:`)
	b := []byte(s)
	if b[pos] == 'A' {
		b[pos] = 'B'
	} else {
		b[pos] = 'A'
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := Load(path)
	if err == nil {
		t.Fatal("Load should fail for tampered ciphertext (GCM tag mismatch)")
	}
}
