package workerpool

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestNew_RejectsBadParams(t *testing.T) {
	if _, err := New(0, 1); err == nil {
		t.Fatal("New(0,1) should return error")
	}
	if _, err := New(1, 0); err == nil {
		t.Fatal("New(1,0) should return error")
	}
	if _, err := New(-1, -1); err == nil {
		t.Fatal("New(-1,-1) should return error")
	}
}

func TestSubmit_ParallelExecutionUnderCap(t *testing.T) {
	p, err := New(4, 16)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	var running atomic.Int32
	var maxRunning atomic.Int32
	hold := make(chan struct{})
	const N = 8
	for i := 0; i < N; i++ {
		if err := p.Submit(func(ctx context.Context) {
			cur := running.Add(1)
			for {
				old := maxRunning.Load()
				if cur <= old || maxRunning.CompareAndSwap(old, cur) {
					break
				}
			}
			<-hold
			running.Add(-1)
		}); err != nil {
			t.Fatalf("Submit %d: %v", i, err)
		}
	}

	// Wait until all 4 workers are concurrently busy (or 1s elapses).
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && maxRunning.Load() < 4 {
		time.Sleep(5 * time.Millisecond)
	}
	if got := maxRunning.Load(); got < 4 {
		t.Errorf("expected at least 4 concurrent workers, saw max=%d", got)
	}
	close(hold)

	if err := p.Drain(2 * time.Second); err != nil {
		t.Fatalf("Drain: %v", err)
	}
}

func TestSubmit_QueueFull(t *testing.T) {
	p, err := New(1, 1)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer p.Drain(2 * time.Second)

	hold := make(chan struct{})
	if err := p.Submit(func(ctx context.Context) { <-hold }); err != nil {
		t.Fatalf("Submit#1: %v", err)
	}
	// Give the worker a moment to pick up the first task.
	time.Sleep(20 * time.Millisecond)
	// Fill the queue (size 1).
	if err := p.Submit(func(ctx context.Context) {}); err != nil {
		t.Fatalf("Submit#2 (should fill queue): %v", err)
	}
	// Now the next Submit must hit the bounded queue full case.
	err = p.Submit(func(ctx context.Context) {})
	if !errors.Is(err, ErrQueueFull) {
		t.Fatalf("expected ErrQueueFull, got %v", err)
	}
	close(hold)
}

func TestSubmit_AfterDrainReturnsErrPoolClosed(t *testing.T) {
	p, err := New(1, 4)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := p.Drain(2 * time.Second); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	err = p.Submit(func(ctx context.Context) {})
	if !errors.Is(err, ErrPoolClosed) {
		t.Fatalf("expected ErrPoolClosed, got %v", err)
	}
}

func TestPanicInOneTask_DoesNotKillSiblings(t *testing.T) {
	p, err := New(1, 8)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	var afterCount atomic.Int32
	if err := p.Submit(func(ctx context.Context) { panic("boom") }); err != nil {
		t.Fatalf("Submit panic task: %v", err)
	}
	if err := p.Submit(func(ctx context.Context) { afterCount.Add(1) }); err != nil {
		t.Fatalf("Submit follow-up: %v", err)
	}
	if err := p.Submit(func(ctx context.Context) { afterCount.Add(1) }); err != nil {
		t.Fatalf("Submit follow-up 2: %v", err)
	}
	if err := p.Drain(2 * time.Second); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	if got := afterCount.Load(); got != 2 {
		t.Fatalf("after-panic siblings completed = %d, want 2", got)
	}
}

func TestDrain_WaitsForInFlight(t *testing.T) {
	p, err := New(2, 4)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	var done atomic.Int32
	for i := 0; i < 4; i++ {
		if err := p.Submit(func(ctx context.Context) {
			time.Sleep(40 * time.Millisecond)
			done.Add(1)
		}); err != nil {
			t.Fatalf("Submit: %v", err)
		}
	}
	if err := p.Drain(2 * time.Second); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	if got := done.Load(); got != 4 {
		t.Fatalf("after Drain done = %d, want 4", got)
	}
}

func TestDrain_TimeoutReturnsErrDrainTimeout(t *testing.T) {
	p, err := New(1, 4)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	hold := make(chan struct{})
	defer close(hold)
	if err := p.Submit(func(ctx context.Context) { <-hold }); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	start := time.Now()
	err = p.Drain(80 * time.Millisecond)
	elapsed := time.Since(start)
	if !errors.Is(err, ErrDrainTimeout) {
		t.Fatalf("expected ErrDrainTimeout, got %v", err)
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("Drain took %v, expected ~80ms", elapsed)
	}
}

func TestSubsequentDrainIsNoop(t *testing.T) {
	p, err := New(1, 4)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := p.Drain(2 * time.Second); err != nil {
		t.Fatalf("first Drain: %v", err)
	}
	if err := p.Drain(2 * time.Second); err != nil {
		t.Fatalf("second Drain should be no-op, got %v", err)
	}
}

func TestDrain_CancelsContextForQueuedTasks(t *testing.T) {
	// Single worker, blocked on `hold`. Queue more than 1 task, then
	// Drain — the queued tasks should observe ctx cancellation.
	p, err := New(1, 8)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	hold := make(chan struct{})
	if err := p.Submit(func(ctx context.Context) { <-hold }); err != nil {
		t.Fatalf("Submit blocker: %v", err)
	}
	time.Sleep(20 * time.Millisecond)
	var sawCancel atomic.Int32
	for i := 0; i < 3; i++ {
		if err := p.Submit(func(ctx context.Context) {
			if ctx.Err() != nil {
				sawCancel.Add(1)
			}
		}); err != nil {
			t.Fatalf("Submit queued: %v", err)
		}
	}
	close(hold)
	if err := p.Drain(2 * time.Second); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	if sawCancel.Load() != 3 {
		t.Fatalf("queued tasks that observed cancellation = %d, want 3", sawCancel.Load())
	}
}
