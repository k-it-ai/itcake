package filescan

import (
	"fmt"
	"sort"
	"testing"
	"time"
)

func TestFileMinHeapKeepsLargest(t *testing.T) {
	h := newFileTop(5)
	for i := 0; i < 50; i++ {
		h.consider(FileEntry{Path: fmt.Sprintf("/f/%d", i), SizeBytes: int64(i * 100), ModTime: time.Now()})
	}
	got := h.drain()
	if len(got) != 5 {
		t.Fatalf("want 5, got %d", len(got))
	}
	if got[0].SizeBytes != 4900 {
		t.Errorf("largest should be 4900, got %d", got[0].SizeBytes)
	}
	for i := 1; i < len(got); i++ {
		if got[i-1].SizeBytes < got[i].SizeBytes {
			t.Errorf("not sorted desc: %v", got)
		}
	}
}

func TestFileMinHeapBoundedAtThousand(t *testing.T) {
	h := newFileTop(50)
	for i := 0; i < 1000; i++ {
		h.consider(FileEntry{Path: fmt.Sprintf("/f/%d", i), SizeBytes: int64(i + 1), ModTime: time.Now()})
	}
	got := h.drain()
	if len(got) != 50 {
		t.Fatalf("want 50, got %d", len(got))
	}
}

func TestFileMinHeapZeroCap(t *testing.T) {
	h := newFileTop(0)
	h.consider(FileEntry{Path: "/x", SizeBytes: 100})
	if h.Len() != 0 {
		t.Errorf("zero-cap heap should not store")
	}
}

func TestDirAccumulatorRollsUpByParent(t *testing.T) {
	a := newDirTop(2)
	a.addFile("/a/b/file1", 100)
	a.addFile("/a/b/file2", 200)
	a.addFile("/c/d/file3", 50)
	top := a.topK()
	if len(top) != 2 {
		t.Fatalf("want 2 dirs, got %d", len(top))
	}
	sort.Slice(top, func(i, j int) bool { return top[i].TotalBytes > top[j].TotalBytes })
	if top[0].Path != "/a/b" {
		t.Errorf("top dir should be /a/b, got %s", top[0].Path)
	}
	if top[0].TotalBytes != 300 {
		t.Errorf("/a/b bytes = 300, got %d", top[0].TotalBytes)
	}
	if top[0].FileCount != 2 {
		t.Errorf("/a/b count = 2, got %d", top[0].FileCount)
	}
}
