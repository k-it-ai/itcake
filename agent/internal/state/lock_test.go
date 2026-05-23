package state

import (
	"errors"
	"testing"
)

// First AcquireLock succeeds; second concurrent AcquireLock on the same
// directory must fail with ErrLockHeld. Without this defence, two agent
// instances would race on replay-cache.json, self-update, and config
// writes — silently corrupting shared on-disk state.
func TestAcquireLock_RejectsSecondCaller(t *testing.T) {
	dir := t.TempDir()

	release1, err := AcquireLock(dir)
	if err != nil {
		t.Fatalf("first AcquireLock failed: %v", err)
	}
	defer release1()

	_, err = AcquireLock(dir)
	if err == nil {
		t.Fatal("second AcquireLock should have failed, but succeeded")
	}
	if !errors.Is(err, ErrLockHeld) {
		t.Errorf("expected ErrLockHeld, got: %v", err)
	}
}

// Releasing the lock allows the next caller to acquire it. Confirms the
// returned closer actually frees the lock (regression — earlier drafts
// of the Windows code path forgot to close the handle).
func TestAcquireLock_ReleasePermitsNextCaller(t *testing.T) {
	dir := t.TempDir()

	release1, err := AcquireLock(dir)
	if err != nil {
		t.Fatalf("first AcquireLock failed: %v", err)
	}
	release1()

	release2, err := AcquireLock(dir)
	if err != nil {
		t.Fatalf("AcquireLock after release should succeed; got: %v", err)
	}
	defer release2()
}

// Per-directory isolation: locks in different config dirs are
// independent. The lockfile is keyed by the parent state directory, so
// running two agents against different configs (a multi-fleet test
// setup, for example) does NOT cross-block.
func TestAcquireLock_IndependentDirs(t *testing.T) {
	dir1 := t.TempDir()
	dir2 := t.TempDir()

	release1, err := AcquireLock(dir1)
	if err != nil {
		t.Fatalf("dir1: %v", err)
	}
	defer release1()

	release2, err := AcquireLock(dir2)
	if err != nil {
		t.Fatalf("dir2: %v", err)
	}
	defer release2()
}
