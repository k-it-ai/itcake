package secscan

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestScanFindsAndSuppresses(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "secrets.env"),
		[]byte("password = \"realsecretpasswordvalue\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	subDir := filepath.Join(dir, "skip")
	if err := os.MkdirAll(subDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(subDir, "ignored.env"),
		[]byte(`api_key = "abc12345xyz"`), 0o600); err != nil {
		t.Fatal(err)
	}

	res := Scan(Scope{
		Paths:            []string{dir},
		SuppressPaths:    []string{subDir},
		MaxFileSizeBytes: 1 << 20,
		TimeoutSeconds:   10,
		Workers:          1,
	})
	if len(res.Findings) == 0 {
		t.Fatalf("expected at least one finding")
	}
	for _, f := range res.Findings {
		if strings.HasPrefix(f.Path, subDir) {
			t.Errorf("suppressed path leaked finding: %s", f.Path)
		}
	}
	if res.Summary.FilesScanned == 0 {
		t.Errorf("FilesScanned not updated")
	}
}

func TestScanSkipsBinaryFiles(t *testing.T) {
	dir := t.TempDir()
	body := append([]byte("password=\"realsecretpassword\"\n"), 0x00, 0x01, 0x02)
	if err := os.WriteFile(filepath.Join(dir, "blob.bin"), body, 0o600); err != nil {
		t.Fatal(err)
	}
	res := Scan(Scope{
		Paths:            []string{dir},
		MaxFileSizeBytes: 1 << 20,
		TimeoutSeconds:   10,
		Workers:          1,
	})
	if len(res.Findings) != 0 {
		t.Errorf("binary file should be skipped, got findings: %+v", res.Findings)
	}
}

func TestScanLuhnRejectsFalsePositives(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "fake.txt"),
		[]byte("ID 1234567890123 is not a card\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	res := Scan(Scope{
		Paths:            []string{dir},
		MaxFileSizeBytes: 1 << 20,
		TimeoutSeconds:   10,
		Workers:          1,
	})
	for _, f := range res.Findings {
		if f.PatternID == "pci_card_number" {
			t.Errorf("Luhn should have rejected %+v", f)
		}
	}
}

func TestScanBoundaryOverlap(t *testing.T) {
	dir := t.TempDir()
	// Build a file where a valid AWS key sits across the chunk boundary.
	// We pad with spaces (non-word) so the regex's `\b` at AKIA's
	// start matches once the boundary-overlap feeds the missing tail.
	prefix := strings.Repeat(" ", chunkSize-7)
	awsKey := "AKIAIOSFODNN7EXAMPLE"
	body := prefix + awsKey + "\n"
	if err := os.WriteFile(filepath.Join(dir, "boundary.txt"),
		[]byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	res := Scan(Scope{
		Paths:            []string{dir},
		MaxFileSizeBytes: 1 << 20,
		TimeoutSeconds:   10,
		Workers:          1,
	})
	found := false
	for _, f := range res.Findings {
		if f.PatternID == "credential_aws_access_key" {
			found = true
		}
	}
	if !found {
		t.Errorf("boundary-spanning key not detected; findings=%+v", res.Findings)
	}
}

func TestScanSuppressPatternIDs(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "f.txt"),
		[]byte("Email me at user@example.com please.\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	res := Scan(Scope{
		Paths:              []string{dir},
		SuppressPatternIDs: []string{"pii_email"},
		MaxFileSizeBytes:   1 << 20,
		TimeoutSeconds:     10,
		Workers:            1,
	})
	for _, f := range res.Findings {
		if f.PatternID == "pii_email" {
			t.Errorf("pii_email should be suppressed: %+v", f)
		}
	}
}
