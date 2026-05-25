package updater

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"testing"
)

// Helpers --------------------------------------------------------------

func mustKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

func signRotation(t *testing.T, signer ed25519.PrivateKey, newPubB64, issuedAt string) string {
	t.Helper()
	msg := []byte(RotationSignedMessage(newPubB64, issuedAt))
	sig := ed25519.Sign(signer, msg)
	return base64.StdEncoding.EncodeToString(sig)
}

// Tests ----------------------------------------------------------------

// AcceptRotationAnnouncement: happy path — new pubkey signed by the
// currently-trusted key is appended to the trust set.
func TestAcceptRotation_HappyPath(t *testing.T) {
	t.Setenv("ITCAKE_UPDATE_MANIFEST_PUBKEYS", "")
	reset()
	oldPub, oldPriv := mustKey(t)
	newPub, _ := mustKey(t)

	t.Setenv("ITCAKE_UPDATE_MANIFEST_PUBKEYS", base64.StdEncoding.EncodeToString(oldPub))
	reset()

	newPubB64 := base64.StdEncoding.EncodeToString(newPub)
	issuedAt := "2026-05-23T10:00:00Z"
	sig := signRotation(t, oldPriv, newPubB64, issuedAt)

	added, err := AcceptRotationAnnouncement(RotationAnnouncement{
		PubKey: newPubB64, Sig: sig, IssuedAt: issuedAt,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !added {
		t.Fatal("expected new pubkey to be added")
	}
	if len(ManifestPubKeys) != 2 {
		t.Fatalf("expected trust set size 2, got %d", len(ManifestPubKeys))
	}
}

// AcceptRotationAnnouncement: signature by an UNTRUSTED key must fail.
// This is the load-bearing security check — a bearer+HMAC-compromised
// attacker shouldn't be able to substitute the manifest pubkey.
func TestAcceptRotation_SigByUntrustedKey_Rejected(t *testing.T) {
	t.Setenv("ITCAKE_UPDATE_MANIFEST_PUBKEYS", "")
	reset()
	oldPub, _ := mustKey(t)
	_, attackerPriv := mustKey(t)
	newPub, _ := mustKey(t)

	t.Setenv("ITCAKE_UPDATE_MANIFEST_PUBKEYS", base64.StdEncoding.EncodeToString(oldPub))
	reset()

	newPubB64 := base64.StdEncoding.EncodeToString(newPub)
	issuedAt := "2026-05-23T10:00:00Z"
	// Attacker signs with a key the agent does NOT trust.
	sig := signRotation(t, attackerPriv, newPubB64, issuedAt)

	added, err := AcceptRotationAnnouncement(RotationAnnouncement{
		PubKey: newPubB64, Sig: sig, IssuedAt: issuedAt,
	})
	if err == nil {
		t.Fatal("expected error for untrusted-key signature")
	}
	if added {
		t.Fatal("untrusted-key sig must not add a key")
	}
	if len(ManifestPubKeys) != 1 {
		t.Fatalf("trust set must remain size 1, got %d", len(ManifestPubKeys))
	}
}

// Re-presenting an already-trusted pubkey is a no-op (idempotent).
func TestAcceptRotation_AlreadyTrusted_NoOp(t *testing.T) {
	t.Setenv("ITCAKE_UPDATE_MANIFEST_PUBKEYS", "")
	reset()
	pub, priv := mustKey(t)
	t.Setenv("ITCAKE_UPDATE_MANIFEST_PUBKEYS", base64.StdEncoding.EncodeToString(pub))
	reset()

	pubB64 := base64.StdEncoding.EncodeToString(pub)
	sig := signRotation(t, priv, pubB64, "ts")

	added, err := AcceptRotationAnnouncement(RotationAnnouncement{
		PubKey: pubB64, Sig: sig, IssuedAt: "ts",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if added {
		t.Fatal("already-trusted key must not be re-added")
	}
	if len(ManifestPubKeys) != 1 {
		t.Fatalf("trust set should stay size 1, got %d", len(ManifestPubKeys))
	}
}

// Chained rotation K0 → K1 → K2: agent has K0 in trust set; receives
// the announcements oldest-first (caller-side responsibility). After
// processing both, all three keys are in the trust set.
func TestAcceptRotation_ChainedRotation_OldestFirst(t *testing.T) {
	t.Setenv("ITCAKE_UPDATE_MANIFEST_PUBKEYS", "")
	reset()
	k0Pub, k0Priv := mustKey(t)
	k1Pub, k1Priv := mustKey(t)
	k2Pub, _ := mustKey(t)

	t.Setenv("ITCAKE_UPDATE_MANIFEST_PUBKEYS", base64.StdEncoding.EncodeToString(k0Pub))
	reset()

	k1B64 := base64.StdEncoding.EncodeToString(k1Pub)
	k2B64 := base64.StdEncoding.EncodeToString(k2Pub)

	// K1 announced first, signed by K0; then K2 signed by K1.
	annK1 := RotationAnnouncement{PubKey: k1B64, Sig: signRotation(t, k0Priv, k1B64, "t1"), IssuedAt: "t1"}
	annK2 := RotationAnnouncement{PubKey: k2B64, Sig: signRotation(t, k1Priv, k2B64, "t2"), IssuedAt: "t2"}

	added1, err1 := AcceptRotationAnnouncement(annK1)
	if err1 != nil || !added1 {
		t.Fatalf("K1 acceptance failed: added=%v err=%v", added1, err1)
	}
	added2, err2 := AcceptRotationAnnouncement(annK2)
	if err2 != nil || !added2 {
		t.Fatalf("K2 acceptance failed: added=%v err=%v", added2, err2)
	}
	if len(ManifestPubKeys) != 3 {
		t.Fatalf("expected trust set size 3 after chained rotation, got %d", len(ManifestPubKeys))
	}
}

// Malformed pubKey base64 / wrong-length signature must yield an error
// without mutating the trust set. The new pubkey must be distinct from
// any already-trusted key so the validation paths actually execute (an
// already-trusted pubkey short-circuits with added=false,err=nil).
func TestAcceptRotation_MalformedInputsRejected(t *testing.T) {
	t.Setenv("ITCAKE_UPDATE_MANIFEST_PUBKEYS", "")
	reset()
	trustedPub, _ := mustKey(t)
	freshPub, _ := mustKey(t)
	t.Setenv("ITCAKE_UPDATE_MANIFEST_PUBKEYS", base64.StdEncoding.EncodeToString(trustedPub))
	reset()
	before := len(ManifestPubKeys)
	freshB64 := base64.StdEncoding.EncodeToString(freshPub)

	cases := []RotationAnnouncement{
		{PubKey: "!!!not-base64!!!", Sig: "AAAA", IssuedAt: "t"},
		{PubKey: base64.StdEncoding.EncodeToString([]byte("short")), Sig: "AAAA", IssuedAt: "t"},
		{PubKey: freshB64, Sig: "!!not-base64", IssuedAt: "t"},
		{PubKey: freshB64, Sig: base64.StdEncoding.EncodeToString([]byte("short-sig")), IssuedAt: "t"},
	}
	for i, c := range cases {
		added, err := AcceptRotationAnnouncement(c)
		if err == nil {
			t.Errorf("case %d: expected error", i)
		}
		if added {
			t.Errorf("case %d: malformed input must not add a key", i)
		}
	}
	if len(ManifestPubKeys) != before {
		t.Fatalf("trust set mutated despite malformed inputs (before=%d after=%d)", before, len(ManifestPubKeys))
	}
}

// TrustedPubKeysB64 returns the in-memory trust set serialised. The
// agent persists this back to its encrypted config after each
// AcceptRotationAnnouncement that returns added=true.
func TestTrustedPubKeysB64(t *testing.T) {
	t.Setenv("ITCAKE_UPDATE_MANIFEST_PUBKEYS", "")
	reset()
	p1, _ := mustKey(t)
	p2, _ := mustKey(t)
	t.Setenv("ITCAKE_UPDATE_MANIFEST_PUBKEYS",
		base64.StdEncoding.EncodeToString(p1)+","+base64.StdEncoding.EncodeToString(p2))
	reset()

	out := TrustedPubKeysB64()
	if len(out) != 2 {
		t.Fatalf("expected 2 base64 keys, got %d", len(out))
	}
}
