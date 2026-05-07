package state

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestPathInDir(t *testing.T) {
	got := PathInDir("/some/dir")
	want := filepath.Join("/some/dir", "state.json")
	if got != want {
		t.Errorf("PathInDir = %q, want %q", got, want)
	}
}

func TestRead_MissingFileReturnsStoppedNoError(t *testing.T) {
	dir := t.TempDir()
	path := PathInDir(dir)
	got, err := Read(path)
	if err != nil {
		t.Fatalf("Read on missing file should be no-error, got: %v", err)
	}
	if got == nil {
		t.Fatal("Read on missing file returned nil state")
	}
	if got.Status != StatusStopped {
		t.Errorf("default status = %q, want %q", got.Status, StatusStopped)
	}
}

func TestRead_CorruptReturnsError(t *testing.T) {
	dir := t.TempDir()
	path := PathInDir(dir)
	if err := os.WriteFile(path, []byte("not json {{{"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := Read(path)
	if err == nil {
		t.Fatal("Read on corrupt JSON should return error")
	}
}

func TestWriteRunningReadRoundtrip(t *testing.T) {
	dir := t.TempDir()
	path := PathInDir(dir)
	if err := WriteRunning(path, "1.2.3"); err != nil {
		t.Fatalf("WriteRunning: %v", err)
	}
	got, err := Read(path)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if got.Status != StatusRunning {
		t.Errorf("Status = %q, want %q", got.Status, StatusRunning)
	}
	if got.Version != "1.2.3" {
		t.Errorf("Version = %q, want 1.2.3", got.Version)
	}
	if got.PID != os.Getpid() {
		t.Errorf("PID = %d, want %d", got.PID, os.Getpid())
	}
}

func TestWriteHeartbeat_PreservesVersionAndStatus(t *testing.T) {
	dir := t.TempDir()
	path := PathInDir(dir)
	if err := WriteRunning(path, "9.9.9"); err != nil {
		t.Fatalf("WriteRunning: %v", err)
	}
	before := time.Now().UTC()
	if err := WriteHeartbeat(path); err != nil {
		t.Fatalf("WriteHeartbeat: %v", err)
	}
	after := time.Now().UTC()

	got, err := Read(path)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if got.Status != StatusRunning {
		t.Errorf("Status changed by WriteHeartbeat: got %q, want %q", got.Status, StatusRunning)
	}
	if got.Version != "9.9.9" {
		t.Errorf("Version changed by WriteHeartbeat: got %q, want 9.9.9", got.Version)
	}
	if got.LastHeartbeatAt.Before(before.Add(-time.Second)) || got.LastHeartbeatAt.After(after.Add(time.Second)) {
		t.Errorf("LastHeartbeatAt = %v, expected ~now (%v..%v)", got.LastHeartbeatAt, before, after)
	}
}

func TestWriteStopping_PreservesHeartbeat(t *testing.T) {
	dir := t.TempDir()
	path := PathInDir(dir)
	if err := WriteRunning(path, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	if err := WriteHeartbeat(path); err != nil {
		t.Fatal(err)
	}
	pre, err := Read(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteStopping(path); err != nil {
		t.Fatalf("WriteStopping: %v", err)
	}
	got, err := Read(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusStopping {
		t.Errorf("Status = %q, want %q", got.Status, StatusStopping)
	}
	if !got.LastHeartbeatAt.Equal(pre.LastHeartbeatAt) {
		t.Errorf("LastHeartbeatAt clobbered by WriteStopping: got %v, want %v", got.LastHeartbeatAt, pre.LastHeartbeatAt)
	}
	if got.Version != "1.0.0" {
		t.Errorf("Version clobbered by WriteStopping: got %q, want 1.0.0", got.Version)
	}
}

// 50 readers + 1 hot writer must never observe a half-written file:
// every read either errors with ErrNotExist (returned as Stopped) or
// successfully parses with a non-empty Status. A torn JSON read would
// surface as a parse error.
func TestAtomicWrite_NoTornReads(t *testing.T) {
	dir := t.TempDir()
	path := PathInDir(dir)
	if err := WriteRunning(path, "1.0.0"); err != nil {
		t.Fatal(err)
	}

	stop := make(chan struct{})
	var wg sync.WaitGroup

	const readers = 50
	wg.Add(readers)
	parseErrs := make(chan error, readers*1024)
	for i := 0; i < readers; i++ {
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				// Direct file read so we exercise the bytes on disk.
				// A torn read would be flagged by json.Unmarshal.
				data, err := os.ReadFile(path)
				if err != nil {
					if !os.IsNotExist(err) {
						parseErrs <- err
					}
					continue
				}
				var s State
				if err := json.Unmarshal(data, &s); err != nil {
					parseErrs <- err
					continue
				}
				if s.Status == "" {
					parseErrs <- &emptyStatusErr{}
				}
			}
		}()
	}

	// Hot writer: alternate WriteHeartbeat and WriteRunning to vary the
	// payload size each iteration.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 500; i++ {
			if i%2 == 0 {
				_ = WriteHeartbeat(path)
			} else {
				_ = WriteRunning(path, "1.0.0")
			}
		}
		close(stop)
	}()

	wg.Wait()
	close(parseErrs)
	if err, ok := <-parseErrs; ok {
		t.Fatalf("torn read or parse error during concurrent writes: %v", err)
	}
}

type emptyStatusErr struct{}

func (e *emptyStatusErr) Error() string { return "read state had empty Status" }
