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
	if !strings.Contains(disk, `"tokenEnc": "v3:`) {
		t.Error("expected encrypted token with v3: prefix in config file")
	}
	if !strings.Contains(disk, `"hmacSecretEnc": "v3:`) {
		t.Error("expected encrypted hmac secret with v3: prefix in config file")
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

func TestConfigSaveLoad_ManifestPubKeysEncryptedRoundtrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	t.Setenv("ITCAKE_ALLOW_HTTP", "1")

	const k1 = "Zm9vYmFyMTIzZm9vYmFyMTIzZm9vYmFyMTIzZm9v"  // 32 bytes b64
	const k2 = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQ" // bogus b64; passes round-trip but not Ed25519 verify

	original := &Config{
		ServerURL:       "http://127.0.0.1:3000",
		Token:           "c0ffee00c0ffee00c0ffee00c0ffee00",
		HMACSecret:      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		AgentID:         "agent-test-pubkeys",
		CheckinInterval: 30,
		ManifestPubKeys: []string{k1, k2},
	}
	if err := original.Save(path); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// Plaintext keys must not appear in the on-disk JSON — the field is
	// AAD-bound encrypted so a local non-root tamper can't swap them.
	disk, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	d := string(disk)
	if strings.Contains(d, k1) || strings.Contains(d, k2) {
		t.Fatal("on-disk config leaks plaintext manifest pubkey — AAD-binding broken")
	}
	if !strings.Contains(d, `"manifestPubKeysEnc": "v3:`) {
		t.Error("expected encrypted manifestPubKeys with v3: prefix")
	}

	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(loaded.ManifestPubKeys) != 2 || loaded.ManifestPubKeys[0] != k1 || loaded.ManifestPubKeys[1] != k2 {
		t.Errorf("ManifestPubKeys round-trip mismatch: %v", loaded.ManifestPubKeys)
	}
}

func TestConfigSaveLoad_EmptyManifestPubKeysOmitsEncryption(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	t.Setenv("ITCAKE_ALLOW_HTTP", "1")

	original := &Config{
		ServerURL:       "http://127.0.0.1:3000",
		Token:           "c0ffee00c0ffee00c0ffee00c0ffee00",
		HMACSecret:      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		AgentID:         "agent-no-pubkeys",
		CheckinInterval: 30,
	}
	if err := original.Save(path); err != nil {
		t.Fatalf("Save: %v", err)
	}
	disk, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if strings.Contains(string(disk), "manifestPubKeysEnc") {
		t.Errorf("expected no manifestPubKeysEnc field when ManifestPubKeys is empty; got %s", string(disk))
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(loaded.ManifestPubKeys) != 0 {
		t.Errorf("expected zero pubkeys after empty save/load; got %v", loaded.ManifestPubKeys)
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

// v1 ciphertexts must be rejected with a clear error so the operator
// re-enrolls. Without this, an old blob carried forward across the
// crypto-format upgrade would either "work" against a weaker KDF or
// silently surface as an opaque GCM failure.
func TestDecryptSecret_RejectsV1Prefix(t *testing.T) {
	// Construct a syntactically-plausible v1 blob (base64 of nothing
	// useful — we never get past the prefix check).
	bogus := "v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
	_, err := decryptSecret(bogus, "tokenEnc")
	if err == nil {
		t.Fatal("v1 ciphertext should be rejected")
	}
	if !strings.Contains(err.Error(), "re-enroll") {
		t.Errorf("error message should tell the operator to re-enroll: %v", err)
	}
}

// Each encrypt call must produce a fresh per-blob salt (and nonce); two
// encryptions of the same plaintext must therefore produce different
// ciphertexts. Without this property, an attacker who saw two blobs
// known to encrypt the same value could detect that they match — which
// is harmless for the bearer token (each agent's is unique anyway) but
// is the canonical IND-CPA property we want from any AEAD usage.
func TestEncryptSecret_FreshSaltAndNoncePerCall(t *testing.T) {
	t.Setenv("ITCAKE_ALLOW_HTTP", "1")
	a, err := encryptSecret("the-same-value", "tokenEnc")
	if err != nil {
		t.Fatal(err)
	}
	b, err := encryptSecret("the-same-value", "tokenEnc")
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatal("two encryptSecret calls returned identical ciphertext — salt/nonce are not random")
	}
	// Both must still round-trip on the same host.
	pa, err := decryptSecret(a, "tokenEnc")
	if err != nil {
		t.Fatalf("first decrypt: %v", err)
	}
	pb, err := decryptSecret(b, "tokenEnc")
	if err != nil {
		t.Fatalf("second decrypt: %v", err)
	}
	if pa != "the-same-value" || pb != "the-same-value" {
		t.Fatalf("round-trip mismatch: pa=%q pb=%q", pa, pb)
	}
}

// Regression: v3 binds each ciphertext to its field name via the GCM AAD,
// so a file-write attacker can't swap the `tokenEnc` and `hmacSecretEnc`
// blobs (which previously had no AAD binding in v2). The blob encrypted
// under `tokenEnc` must fail GCM verification when decrypted under
// `hmacSecretEnc`.
func TestEncryptSecret_FieldAADBindingBlocksSwap(t *testing.T) {
	t.Setenv("ITCAKE_ALLOW_HTTP", "1")
	tokenCt, err := encryptSecret("bearer-token-plaintext", "tokenEnc")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(tokenCt, "v3:") {
		t.Fatalf("expected v3 ciphertext, got %q", tokenCt[:3])
	}
	// Same-field decrypt succeeds.
	if pt, err := decryptSecret(tokenCt, "tokenEnc"); err != nil || pt != "bearer-token-plaintext" {
		t.Fatalf("same-AAD decrypt failed: pt=%q err=%v", pt, err)
	}
	// Cross-field decrypt MUST fail GCM verification.
	if _, err := decryptSecret(tokenCt, "hmacSecretEnc"); err == nil {
		t.Fatal("cross-AAD decrypt should fail — field-swap attack would succeed")
	}
}

func TestApplyConcurrencyDefaults_ZeroFallsBackToDefaults(t *testing.T) {
	c := &Config{}
	c.applyConcurrencyDefaults()
	if c.MaxConcurrentCommands != DefaultMaxConcurrentCommands {
		t.Errorf("MaxConcurrentCommands = %d, want %d", c.MaxConcurrentCommands, DefaultMaxConcurrentCommands)
	}
	if c.CommandQueueSize != DefaultCommandQueueSize {
		t.Errorf("CommandQueueSize = %d, want %d", c.CommandQueueSize, DefaultCommandQueueSize)
	}
}

func TestApplyConcurrencyDefaults_OutOfRangeIsClamped(t *testing.T) {
	cases := []struct {
		name                           string
		max, queue, wantMax, wantQueue int
	}{
		{"negative", -5, -10, DefaultMaxConcurrentCommands, DefaultCommandQueueSize},
		{"too high max", 33, 64, DefaultMaxConcurrentCommands, 64},
		{"too high queue", 8, 257, 8, DefaultCommandQueueSize},
		{"in range", 8, 64, 8, 64},
		{"min legal", 1, 1, 1, 1},
		{"max legal", 32, 256, 32, 256},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := &Config{MaxConcurrentCommands: tc.max, CommandQueueSize: tc.queue}
			c.applyConcurrencyDefaults()
			if c.MaxConcurrentCommands != tc.wantMax {
				t.Errorf("MaxConcurrentCommands = %d, want %d", c.MaxConcurrentCommands, tc.wantMax)
			}
			if c.CommandQueueSize != tc.wantQueue {
				t.Errorf("CommandQueueSize = %d, want %d", c.CommandQueueSize, tc.wantQueue)
			}
		})
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
	// GCM tag check fails. We find "v2:" and change the first char after it.
	data, _ := os.ReadFile(path)
	s := string(data)
	idx := strings.Index(s, `"tokenEnc": "v3:`)
	if idx < 0 {
		t.Fatal("could not locate tokenEnc in config")
	}
	// Offset to the first ciphertext char and flip it.
	pos := idx + len(`"tokenEnc": "v3:`)
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
