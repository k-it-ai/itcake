package checkin

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/itcake/agent/internal/commands"
)

// TestAdvisoryReplay_RejectedAfterFirstUse verifies the advisory replay
// defence: the same `(serverHash, issuedAt)` pair MUST NOT pass the cache
// twice within the TTL window. Captured advisories within the ±10 min
// freshness window would otherwise pass verifyBinaryAdvisory and let an
// attacker re-trigger a download with a stale signed payload.
func TestAdvisoryReplay_RejectedAfterFirstUse(t *testing.T) {
	dir := t.TempDir()
	replay := commands.NewPersistentReplayCache(10*time.Minute, filepath.Join(dir, "replay.json"), []byte("test-key"))

	const hash = "abcd1234"
	const issuedAt = "2026-05-22T15:00:00Z"
	key := "advisory:" + hash + ":" + issuedAt

	if !replay.Check(key) {
		t.Fatal("first presentation of an advisory must succeed")
	}
	if replay.Check(key) {
		t.Fatal("replay of the same advisory must be rejected")
	}
}

// TestAdvisoryReplay_DifferentHashOrTimestampNotConfused verifies that the
// cache key is unique per (hash, issuedAt). A different hash (a real new
// binary) or a different issuedAt (a re-issued advisory after a server
// restart) must NOT collide with a prior key.
func TestAdvisoryReplay_DifferentHashOrTimestampNotConfused(t *testing.T) {
	dir := t.TempDir()
	replay := commands.NewPersistentReplayCache(10*time.Minute, filepath.Join(dir, "replay.json"), []byte("test-key"))

	if !replay.Check("advisory:hashA:2026-05-22T15:00:00Z") {
		t.Fatal("first hash should pass")
	}
	if !replay.Check("advisory:hashB:2026-05-22T15:00:00Z") {
		t.Fatal("different hash must NOT collide with prior cache entry")
	}
	if !replay.Check("advisory:hashA:2026-05-22T15:00:01Z") {
		t.Fatal("different issuedAt must NOT collide with prior cache entry")
	}
}

// TestAdvisoryReplay_NamespaceDisjointFromCommandIDs makes sure the
// `advisory:` prefix prevents a server-issued command whose ID happens to
// equal a hash+issuedAt concat from poisoning the advisory cache (or
// vice-versa). This is a near-zero-probability collision but the namespace
// prefix is the defence; the test pins it.
func TestAdvisoryReplay_NamespaceDisjointFromCommandIDs(t *testing.T) {
	dir := t.TempDir()
	replay := commands.NewPersistentReplayCache(10*time.Minute, filepath.Join(dir, "replay.json"), []byte("test-key"))

	// Command IDs go through Check() bare; advisories carry the prefix.
	const cmdID = "abcd1234:2026-05-22T15:00:00Z"
	if !replay.Check(cmdID) {
		t.Fatal("first cmdID must pass")
	}
	// An advisory with the SAME tail but the namespace prefix must still
	// pass (and burn its own slot).
	if !replay.Check("advisory:" + cmdID) {
		t.Fatal("namespace-prefixed advisory must NOT collide with bare command ID")
	}
}
