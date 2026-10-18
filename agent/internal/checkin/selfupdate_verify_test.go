package checkin

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func hashFileForTest(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// The darwin quarantine/codesign fixup must run BEFORE the smoke test:
// signing after verification used to rewrite the file, so the bytes that
// replaced the running binary were never the bytes that were smoke-tested.
// The seam records its call instead of invoking codesign.
func TestVerifySelfUpdateBinary_PreparesBeforeSmokeTest(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("smoke script needs a POSIX shell")
	}
	dir := t.TempDir()
	orderLog := filepath.Join(dir, "order.log")
	bin := filepath.Join(dir, "itcake-agent-test")
	script := "#!/bin/sh\necho smoke >> '" + orderLog + "'\necho itcake-agent v9.9.9\n"
	if err := os.WriteFile(bin, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}

	orig := prepareSelfUpdateBinary
	prepareSelfUpdateBinary = func(path string) {
		f, err := os.OpenFile(orderLog, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			t.Errorf("cannot record prepare step: %v", err)
			return
		}
		defer f.Close()
		_, _ = f.WriteString("prepare:" + filepath.Base(path) + "\n")
	}
	defer func() { prepareSelfUpdateBinary = orig }()

	if err := verifySelfUpdateBinary(bin, hashFileForTest(t, bin)); err != nil {
		t.Fatalf("verifySelfUpdateBinary: %v", err)
	}

	data, err := os.ReadFile(orderLog)
	if err != nil {
		t.Fatalf("read order log: %v", err)
	}
	if got := string(data); got != "prepare:itcake-agent-test\nsmoke\n" {
		t.Fatalf("prepare must run before smoke, got %q", got)
	}
}

// A hash mismatch must abort before any preparation or execution.
func TestVerifySelfUpdateBinary_HashMismatchAbortsBeforePrep(t *testing.T) {
	dir := t.TempDir()
	orderLog := filepath.Join(dir, "order.log")
	bin := filepath.Join(dir, "itcake-agent-test")
	if err := os.WriteFile(bin, []byte("not the expected bytes"), 0o700); err != nil {
		t.Fatal(err)
	}

	orig := prepareSelfUpdateBinary
	prepareSelfUpdateBinary = func(path string) {
		_ = os.WriteFile(orderLog, []byte("prepare\n"), 0o600)
	}
	defer func() { prepareSelfUpdateBinary = orig }()

	err := verifySelfUpdateBinary(bin, strings.Repeat("0", 64))
	if err == nil || !strings.Contains(err.Error(), "hash mismatch") {
		t.Fatalf("want hash mismatch error, got %v", err)
	}
	if _, statErr := os.Stat(orderLog); statErr == nil {
		t.Fatal("prep must not run for a mismatched download")
	}
}
