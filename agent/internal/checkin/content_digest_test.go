package checkin

import (
	"encoding/base64"
	"encoding/hex"
	"testing"
)

// L5 regression: Content-Digest (RFC 9530) must be parsed and verified
// against serverHash so the self-update download has the same loud-failure
// guarantee as X-Binary-SHA256.

func TestContentDigestSha256Matches_Match(t *testing.T) {
	hashBytes := make([]byte, 32)
	for i := range hashBytes {
		hashBytes[i] = byte(i)
	}
	hexHash := hex.EncodeToString(hashBytes)
	header := "sha-256=:" + base64.StdEncoding.EncodeToString(hashBytes) + ":"

	matches, present := contentDigestSha256Matches(header, hexHash)
	if !present {
		t.Fatal("expected present=true for well-formed sha-256 header")
	}
	if !matches {
		t.Fatal("expected matches=true for matching hash")
	}
}

func TestContentDigestSha256Matches_Mismatch(t *testing.T) {
	headerBytes := make([]byte, 32)
	for i := range headerBytes {
		headerBytes[i] = 0xAA
	}
	otherBytes := make([]byte, 32)
	for i := range otherBytes {
		otherBytes[i] = 0xBB
	}
	otherHash := hex.EncodeToString(otherBytes)
	header := "sha-256=:" + base64.StdEncoding.EncodeToString(headerBytes) + ":"

	matches, present := contentDigestSha256Matches(header, otherHash)
	if !present {
		t.Fatal("expected present=true")
	}
	if matches {
		t.Fatal("expected matches=false on hash mismatch")
	}
}

func TestContentDigestSha256Matches_NotPresent(t *testing.T) {
	for _, hdr := range []string{"", "md5=:abc:", "sha-512=:abc:", "garbage", "sha-256=:not-base64!:"} {
		matches, present := contentDigestSha256Matches(hdr, hex.EncodeToString(make([]byte, 32)))
		// "not-base64!" returns present=false because base64 decode fails — that's the contract
		if hdr == "" || hdr == "md5=:abc:" || hdr == "sha-512=:abc:" || hdr == "garbage" || hdr == "sha-256=:not-base64!:" {
			if present {
				t.Errorf("expected present=false for header %q", hdr)
			}
			if matches {
				t.Errorf("expected matches=false for header %q", hdr)
			}
		}
	}
}

func TestContentDigestSha256Matches_MultipleAlgorithms(t *testing.T) {
	hashBytes := make([]byte, 32)
	for i := range hashBytes {
		hashBytes[i] = byte(0xA5)
	}
	hexHash := hex.EncodeToString(hashBytes)
	// RFC 9530 allows multiple digests in a single header
	header := "md5=:" + base64.StdEncoding.EncodeToString([]byte("ignored")) + ":, sha-256=:" + base64.StdEncoding.EncodeToString(hashBytes) + ":"
	matches, present := contentDigestSha256Matches(header, hexHash)
	if !present || !matches {
		t.Fatalf("expected to extract sha-256 entry from multi-algorithm header (matches=%v present=%v)", matches, present)
	}
}
