package filescan

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCleanupRejectsRelativePath(t *testing.T) {
	res, err := ExecuteCleanup(categoryTempFiles, []string{"relative/path"})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if res.Skipped != 1 || res.Deleted != 0 {
		t.Errorf("want 1 skipped, got %+v", res)
	}
}

func TestCleanupRejectsUnknownCategory(t *testing.T) {
	_, err := ExecuteCleanup("not_a_real_category", []string{"/tmp/x"})
	if err == nil {
		t.Errorf("expected error for unknown category")
	}
}

func TestCleanupRejectsUnrotatedLogsCategory(t *testing.T) {
	_, err := ExecuteCleanup(categoryUnrotatedLogs, []string{"/var/log/x"})
	if err == nil {
		t.Errorf("unrotated_logs is read-only; should be rejected")
	}
}

func TestCleanupRejectsPathOutsideRoot(t *testing.T) {
	res, err := ExecuteCleanup(categoryTempFiles, []string{"/etc/passwd"})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if res.Skipped != 1 {
		t.Errorf("want 1 skipped, got %+v", res)
	}
	if !anyContains(res.Errors, "not inside") {
		t.Errorf("want 'not inside' error, got %v", res.Errors)
	}
}

func TestCleanupRejectsSymlinkResolvingOutsideRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on Windows")
	}
	tmp := t.TempDir()
	target := filepath.Join(tmp, "target.txt")
	if err := os.WriteFile(target, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	tmpRoot := os.TempDir()
	link := filepath.Join(tmpRoot, "filescan-test-symlink-"+t.Name())
	defer os.Remove(link)
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	res, _ := ExecuteCleanup(categoryTempFiles, []string{link})
	if res.Deleted > 0 {
		t.Errorf("symlink resolving outside should NOT be deleted, got %+v", res)
	}
}

func TestCleanupRejectsLargeFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("temp prefix detection differs on Windows tests")
	}
	tmp := os.TempDir()
	bigPath := filepath.Join(tmp, "filescan-test-big-"+t.Name())
	defer os.Remove(bigPath)
	f, err := os.OpenFile(bigPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := f.Truncate(cleanupMaxFileSize + 1); err != nil {
		f.Close()
		t.Skipf("cannot create sparse file > %d bytes here: %v", cleanupMaxFileSize, err)
	}
	f.Close()
	res, err := ExecuteCleanup(categoryTempFiles, []string{bigPath})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res.Deleted > 0 {
		t.Errorf("large file should be skipped, got %+v", res)
	}
	if !anyContains(res.Errors, "cap") {
		t.Errorf("want 'cap' in errors, got %v", res.Errors)
	}
}

func TestCleanupAcceptsValidTempFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("temp prefix layout differs on Windows tests")
	}
	tmp := os.TempDir()
	target := filepath.Join(tmp, "filescan-test-valid-"+t.Name()+".log")
	if err := os.WriteFile(target, []byte("delete me"), 0o600); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(target)
	res, err := ExecuteCleanup(categoryTempFiles, []string{target})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res.Deleted != 1 || res.FreedBytes != int64(len("delete me")) {
		t.Errorf("want 1 deleted, got %+v", res)
	}
	if _, statErr := os.Stat(target); !os.IsNotExist(statErr) {
		t.Errorf("file should be gone, stat err: %v", statErr)
	}
}

func TestIsValidCleanupCategory(t *testing.T) {
	if !IsValidCleanupCategory(categoryTempFiles) {
		t.Error("temp_files should be valid")
	}
	if IsValidCleanupCategory("nope") {
		t.Error("nope should be invalid")
	}
	if IsValidCleanupCategory(categoryUnrotatedLogs) {
		t.Error("unrotated_logs is read-only")
	}
}

func anyContains(errs []string, sub string) bool {
	for _, e := range errs {
		if strings.Contains(e, sub) {
			return true
		}
	}
	return false
}
