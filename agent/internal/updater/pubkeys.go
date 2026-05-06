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
