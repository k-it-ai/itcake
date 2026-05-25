// Package updater holds optional Ed25519 manifest-signature
// verification for the agent's self-update path. The HMAC advisory
// already protects the binary hash with a per-agent shared key (which
// is enough to defend against a CA-trusted MITM). The Ed25519 layer is
// additive: if the operator generates and configures a server-side
// keypair, the agent additionally requires a valid signature over the
// `agentID:binaryHash:issuedAt` triple under one of its trusted public
// keys. With no keys configured, behaviour is unchanged (true, nil) so
// existing deployments aren't broken.
package updater

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strings"
)

// ManifestPubKeys is the in-process trust store of Ed25519 public keys
// used to verify update-manifest signatures. Populated at process
// start by parsing ITCAKE_UPDATE_MANIFEST_PUBKEYS (comma-separated
// base64 raw 32-byte keys). Mutated only at startup; concurrent reads
// after that are safe.
var ManifestPubKeys []ed25519.PublicKey

func init() {
	loadPubkeysFromEnv()
}

// loadPubkeysFromEnv reads ITCAKE_UPDATE_MANIFEST_PUBKEYS and appends
// every well-formed key. Empty / malformed entries log a warning and
// are skipped; we never crash on a misconfigured env var because that
// would block agent startup on operator typos.
func loadPubkeysFromEnv() {
	raw := strings.TrimSpace(os.Getenv("ITCAKE_UPDATE_MANIFEST_PUBKEYS"))
	if raw == "" {
		return
	}
	for _, part := range strings.Split(raw, ",") {
		s := strings.TrimSpace(part)
		if s == "" {
			continue
		}
		decoded, err := base64.StdEncoding.DecodeString(s)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[updater] ITCAKE_UPDATE_MANIFEST_PUBKEYS contained invalid base64; skipping entry\n")
			continue
		}
		if len(decoded) != ed25519.PublicKeySize {
			fmt.Fprintf(os.Stderr, "[updater] ITCAKE_UPDATE_MANIFEST_PUBKEYS entry was %d bytes (want %d); skipping\n", len(decoded), ed25519.PublicKeySize)
			continue
		}
		ManifestPubKeys = append(ManifestPubKeys, ed25519.PublicKey(decoded))
	}
}

// VerifyManifestSignature is the public verifier used by the
// self-update path. It returns:
//
//   - (true, nil)  if no public keys are configured (backward-compat)
//   - (true, nil)  if a signature is supplied AND verifies under any
//     configured public key
//   - (false, err) if pubkeys are configured but the signature is
//     missing, malformed, or fails verification
//
// The signed message is canonical: "binary-manifest:<agentID>:<binaryHash>:<issuedAt>".
// The same string is reproduced server-side; any change here MUST be
// matched by getOrCreateUpdateManifestKey/signManifest in
// services/agent-auto-update.ts.
func VerifyManifestSignature(agentID, binaryHash, issuedAt, signatureB64 string) (bool, error) {
	if len(ManifestPubKeys) == 0 {
		return true, nil
	}
	if signatureB64 == "" {
		return false, errors.New("manifest signature missing but pubkeys are configured")
	}
	sig, err := base64.StdEncoding.DecodeString(signatureB64)
	if err != nil {
		return false, fmt.Errorf("manifest signature: invalid base64: %w", err)
	}
	if len(sig) != ed25519.SignatureSize {
		return false, fmt.Errorf("manifest signature: wrong length %d (want %d)", len(sig), ed25519.SignatureSize)
	}
	msg := []byte(ManifestSignedMessage(agentID, binaryHash, issuedAt))
	for _, key := range ManifestPubKeys {
		if ed25519.Verify(key, msg, sig) {
			return true, nil
		}
	}
	return false, errors.New("manifest signature did not verify under any configured pubkey")
}

// ManifestSignedMessage is exported so the test suite — and any future
// helper — can reproduce the exact bytes server and agent agree on.
func ManifestSignedMessage(agentID, binaryHash, issuedAt string) string {
	return fmt.Sprintf("binary-manifest:%s:%s:%s", agentID, binaryHash, issuedAt)
}

// reset is used by tests to clear and re-parse env without restarting
// the binary. Not part of the public API.
func reset() {
	ManifestPubKeys = nil
	loadPubkeysFromEnv()
}

// AddTrustedPubKeys appends additional Ed25519 public keys to the trust
// store. Used to merge keys persisted in the encrypted agent config (set
// during enrollment) with whatever the env var provided. Skips invalid
// or duplicate entries silently; logs malformed base64 to stderr.
//
// Called from checkin.Run() at startup; concurrent access during normal
// operation is read-only, so this is safe as long as nothing else mutates
// ManifestPubKeys after Run() begins.
func AddTrustedPubKeys(b64Keys []string) {
	for _, s := range b64Keys {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		decoded, err := base64.StdEncoding.DecodeString(s)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[updater] persisted manifest pubkey invalid base64; skipping\n")
			continue
		}
		if len(decoded) != ed25519.PublicKeySize {
			fmt.Fprintf(os.Stderr, "[updater] persisted manifest pubkey was %d bytes (want %d); skipping\n", len(decoded), ed25519.PublicKeySize)
			continue
		}
		key := ed25519.PublicKey(decoded)
		dup := false
		for _, existing := range ManifestPubKeys {
			if len(existing) == len(key) && string(existing) == string(key) {
				dup = true
				break
			}
		}
		if dup {
			continue
		}
		ManifestPubKeys = append(ManifestPubKeys, key)
	}
}

// RotationAnnouncement is the server's signed notice that the manifest
// pubkey has been rotated. The new public key (`PubKey`) is signed by
// the PREVIOUS private key over the canonical message
// `manifest-pubkey-rotation:<pubKey>:<issuedAt>`. Agents accept the
// announcement only when the signature verifies under a pubkey already
// in their trust store.
type RotationAnnouncement struct {
	PubKey   string `json:"pubKey"`
	Sig      string `json:"sig"`
	IssuedAt string `json:"issuedAt"`
}

// RotationSignedMessage returns the canonical bytes signed by the
// previous private key for a rotation announcement.
func RotationSignedMessage(pubKey, issuedAt string) string {
	return fmt.Sprintf("manifest-pubkey-rotation:%s:%s", pubKey, issuedAt)
}

// AcceptRotationAnnouncement verifies `ann` against the current trust
// set and, on success, appends the announced pubkey to ManifestPubKeys.
//
// Returns:
//   - added=true,err=nil  → the announced pubkey is now trusted (or was
//     already trusted, no-op)
//   - added=false,err=nil → the announced pubkey is already in the trust
//     set; nothing to do
//   - added=false,err=...  → the announcement is malformed OR the
//     signature did not verify under any trusted key
//
// The chain-of-trust property: a network attacker (even one with the
// per-agent HMAC) cannot forge a rotation announcement because they
// don't have the previous Ed25519 private key. This preserves the
// Atera-grade property "CA-trusted MITM with per-agent HMAC cannot
// substitute the binary on pubkey-protected agents" across rotations.
func AcceptRotationAnnouncement(ann RotationAnnouncement) (added bool, err error) {
	pubKeyBytes, err := base64.StdEncoding.DecodeString(strings.TrimSpace(ann.PubKey))
	if err != nil {
		return false, fmt.Errorf("rotation announcement: invalid pubKey base64: %w", err)
	}
	if len(pubKeyBytes) != ed25519.PublicKeySize {
		return false, fmt.Errorf("rotation announcement: pubKey wrong length %d", len(pubKeyBytes))
	}
	newKey := ed25519.PublicKey(pubKeyBytes)

	for _, existing := range ManifestPubKeys {
		if string(existing) == string(newKey) {
			return false, nil
		}
	}

	sigBytes, err := base64.StdEncoding.DecodeString(strings.TrimSpace(ann.Sig))
	if err != nil {
		return false, fmt.Errorf("rotation announcement: invalid sig base64: %w", err)
	}
	if len(sigBytes) != ed25519.SignatureSize {
		return false, fmt.Errorf("rotation announcement: sig wrong length %d", len(sigBytes))
	}

	msg := []byte(RotationSignedMessage(ann.PubKey, ann.IssuedAt))
	for _, trusted := range ManifestPubKeys {
		if ed25519.Verify(trusted, msg, sigBytes) {
			ManifestPubKeys = append(ManifestPubKeys, newKey)
			return true, nil
		}
	}
	return false, errors.New("rotation announcement: signature did not verify under any trusted pubkey")
}

// TrustedPubKeysB64 returns the current trust set as a list of base64
// strings, suitable for persisting back into the agent config.
func TrustedPubKeysB64() []string {
	out := make([]string, 0, len(ManifestPubKeys))
	for _, k := range ManifestPubKeys {
		out = append(out, base64.StdEncoding.EncodeToString(k))
	}
	return out
}
