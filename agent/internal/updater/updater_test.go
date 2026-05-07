package updater

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"strings"
	"testing"
)

func TestLoadPubkeysFromEnv_Empty(t *testing.T) {
	t.Setenv("ITCAKE_UPDATE_MANIFEST_PUBKEYS", "")
	reset()
	if len(ManifestPubKeys) != 0 {
		t.Fatalf("expected no keys for empty env, got %d", len(ManifestPubKeys))
	}
}

func TestLoadPubkeysFromEnv_Good(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	enc := base64.StdEncoding.EncodeToString(pub)
	t.Setenv("ITCAKE_UPDATE_MANIFEST_PUBKEYS", enc)
	reset()
	if len(ManifestPubKeys) != 1 {
		t.Fatalf("expected 1 key, got %d", len(ManifestPubKeys))
	}
	if !ManifestPubKeys[0].Equal(pub) {
		t.Errorf("loaded pubkey does not match original")
	}
}

func TestLoadPubkeysFromEnv_Malformed(t *testing.T) {
	// Three entries: invalid base64, valid base64 but wrong byte length,
	// and one good key — we should end up with exactly 1 loaded.
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	enc := base64.StdEncoding.EncodeToString(pub)
	tooShort := base64.StdEncoding.EncodeToString([]byte("nope"))
	mix := strings.Join([]string{"!@#$not-base64", tooShort, enc}, ",")
	t.Setenv("ITCAKE_UPDATE_MANIFEST_PUBKEYS", mix)
	reset()
	if len(ManifestPubKeys) != 1 {
		t.Fatalf("expected 1 valid key after filtering, got %d", len(ManifestPubKeys))
	}
}

func TestVerifyManifestSignature_NoKeysConfigured(t *testing.T) {
	t.Setenv("ITCAKE_UPDATE_MANIFEST_PUBKEYS", "")
	reset()
	ok, err := VerifyManifestSignature("agent-1", "abc", "2026-05-06T00:00:00Z", "")
	if !ok || err != nil {
		t.Fatalf("no-keys path should return (true, nil); got (%v, %v)", ok, err)
	}
}

func TestVerifyManifestSignature_GoodSignatureAccepted(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ITCAKE_UPDATE_MANIFEST_PUBKEYS", base64.StdEncoding.EncodeToString(pub))
	reset()

	agentID := "agent-1"
	binaryHash := "deadbeef"
	issuedAt := "2026-05-06T00:00:00Z"
	msg := []byte(ManifestSignedMessage(agentID, binaryHash, issuedAt))
	sig := ed25519.Sign(priv, msg)
	sigB64 := base64.StdEncoding.EncodeToString(sig)

	ok, err := VerifyManifestSignature(agentID, binaryHash, issuedAt, sigB64)
	if !ok || err != nil {
		t.Fatalf("expected success; got (%v, %v)", ok, err)
	}
}

func TestVerifyManifestSignature_TamperedHashRejected(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ITCAKE_UPDATE_MANIFEST_PUBKEYS", base64.StdEncoding.EncodeToString(pub))
	reset()

	agentID := "agent-1"
	binaryHash := "deadbeef"
	issuedAt := "2026-05-06T00:00:00Z"
	msg := []byte(ManifestSignedMessage(agentID, binaryHash, issuedAt))
	sig := ed25519.Sign(priv, msg)
	sigB64 := base64.StdEncoding.EncodeToString(sig)

	ok, err := VerifyManifestSignature(agentID, "TAMPERED", issuedAt, sigB64)
	if ok {
		t.Fatal("tampered hash should fail verification")
	}
	if err == nil {
		t.Fatal("expected an error explaining the failure")
	}
}

func TestVerifyManifestSignature_MissingSignatureWhenKeysConfigured(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ITCAKE_UPDATE_MANIFEST_PUBKEYS", base64.StdEncoding.EncodeToString(pub))
	reset()
	ok, err := VerifyManifestSignature("a", "b", "c", "")
	if ok {
		t.Fatal("missing sig with keys configured should fail")
	}
	if err == nil {
		t.Fatal("expected an error")
	}
}

func TestVerifyManifestSignature_MalformedB64Rejected(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ITCAKE_UPDATE_MANIFEST_PUBKEYS", base64.StdEncoding.EncodeToString(pub))
	reset()
	ok, _ := VerifyManifestSignature("a", "b", "c", "!!!not-base64!!!")
	if ok {
		t.Fatal("malformed base64 sig must not verify")
	}
}

func TestVerifyManifestSignature_WrongLengthRejected(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ITCAKE_UPDATE_MANIFEST_PUBKEYS", base64.StdEncoding.EncodeToString(pub))
	reset()
	short := base64.StdEncoding.EncodeToString([]byte("too short"))
	ok, _ := VerifyManifestSignature("a", "b", "c", short)
	if ok {
		t.Fatal("wrong-length sig must not verify")
	}
}
