package filescan

import (
	"container/heap"
	"path/filepath"
)

// fileMinHeap keeps the K largest files seen so far. The heap min is the
// current threshold for displacement — anything smaller than the root is
// discarded without allocation. Bounded memory regardless of total files.
type fileMinHeap struct {
	items []FileEntry
	cap   int
}

func newFileTop(capN int) *fileMinHeap { return &fileMinHeap{cap: capN} }

func (h *fileMinHeap) Len() int           { return len(h.items) }
func (h *fileMinHeap) Less(i, j int) bool { return h.items[i].SizeBytes < h.items[j].SizeBytes }
func (h *fileMinHeap) Swap(i, j int)      { h.items[i], h.items[j] = h.items[j], h.items[i] }
func (h *fileMinHeap) Push(x interface{}) { h.items = append(h.items, x.(FileEntry)) }
func (h *fileMinHeap) Pop() interface{} {
	n := len(h.items)
	x := h.items[n-1]
	h.items = h.items[:n-1]
	return x
}

func (h *fileMinHeap) consider(f FileEntry) {
	if h.cap <= 0 {
		return
	}
	if h.Len() < h.cap {
		heap.Push(h, f)
		return
	}
	if f.SizeBytes <= h.items[0].SizeBytes {
		return
	}
	h.items[0] = f
	heap.Fix(h, 0)
}

// drain returns the heap items sorted descending by size.
func (h *fileMinHeap) drain() []FileEntry {
	out := make([]FileEntry, h.Len())
	for i := h.Len() - 1; i >= 0; i-- {
		out[i] = heap.Pop(h).(FileEntry)
	}
	return out
}

// dirAccumulator rolls up per-directory totals during the walk and then
// reports the top-K largest directories. We aggregate on the immediate
// parent only — multi-level rollup would explode memory on deep trees.
type dirAccumulator struct {
	totals map[string]*DirEntry
	cap    int
}

func newDirTop(capN int) *dirAccumulator {
	return &dirAccumulator{totals: make(map[string]*DirEntry), cap: capN}
}

func (a *dirAccumulator) addFile(path string, size int64) {
	dir := filepath.Dir(path)
	d, ok := a.totals[dir]
	if !ok {
		d = &DirEntry{Path: dir}
		a.totals[dir] = d
	}
	d.TotalBytes += size
	d.FileCount++
}

func (a *dirAccumulator) topK() []DirEntry {
	if a.cap <= 0 {
		return nil
	}
	h := &dirMinHeap{cap: a.cap}
	for _, d := range a.totals {
		h.consider(*d)
	}
	return h.drain()
}

type dirMinHeap struct {
	items []DirEntry
	cap   int
}

func (h *dirMinHeap) Len() int           { return len(h.items) }
func (h *dirMinHeap) Less(i, j int) bool { return h.items[i].TotalBytes < h.items[j].TotalBytes }
func (h *dirMinHeap) Swap(i, j int)      { h.items[i], h.items[j] = h.items[j], h.items[i] }
func (h *dirMinHeap) Push(x interface{}) { h.items = append(h.items, x.(DirEntry)) }
func (h *dirMinHeap) Pop() interface{} {
	n := len(h.items)
	x := h.items[n-1]
	h.items = h.items[:n-1]
	return x
}

func (h *dirMinHeap) consider(d DirEntry) {
	if h.cap <= 0 {
		return
	}
	if h.Len() < h.cap {
		heap.Push(h, d)
		return
	}
	if d.TotalBytes <= h.items[0].TotalBytes {
		return
	}
	h.items[0] = d
	heap.Fix(h, 0)
}

func (h *dirMinHeap) drain() []DirEntry {
	out := make([]DirEntry, h.Len())
	for i := h.Len() - 1; i >= 0; i-- {
		out[i] = heap.Pop(h).(DirEntry)
	}
	return out
}
