// Package workerpool provides a bounded goroutine pool with a fixed-size
// task queue. Designed for the agent's command-execution loop: cap how
// many shell commands the agent will run in parallel and reject excess
// rather than spawning unbounded goroutines.
package workerpool

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"
)

// ErrQueueFull is returned by Submit when the bounded queue is at capacity.
// Callers should NACK the task back to whatever produced it so it can be
// retried later or surfaced as a failure.
var ErrQueueFull = errors.New("workerpool: queue full")

// ErrPoolClosed is returned by Submit after Drain has begun. The pool no
// longer accepts work.
var ErrPoolClosed = errors.New("workerpool: pool closed")

// ErrDrainTimeout is returned by Drain when the deadline elapses before
// all in-flight tasks complete. Tasks may still be running after Drain
// returns this error — the pool-wide context has been cancelled.
var ErrDrainTimeout = errors.New("workerpool: drain timeout")

// Pool is a bounded goroutine pool with a fixed-size task queue. Once
// Drain begins, the pool refuses new submissions and waits for in-flight
// work to finish (or the supplied timeout to elapse).
type Pool struct {
	queue     chan func(context.Context)
	wg        sync.WaitGroup
	accepting atomic.Bool
	drainOnce sync.Once
	closeOnce sync.Once
	stopChan  chan struct{}
	ctx       context.Context
	cancel    context.CancelFunc
}

// New constructs a pool with the given worker count and queue size.
// Both must be >= 1; otherwise an error is returned (the caller is
// almost certainly misconfigured if they pass 0).
func New(workers, queueSize int) (*Pool, error) {
	if workers < 1 {
		return nil, fmt.Errorf("workerpool: workers must be >= 1, got %d", workers)
	}
	if queueSize < 1 {
		return nil, fmt.Errorf("workerpool: queueSize must be >= 1, got %d", queueSize)
	}
	ctx, cancel := context.WithCancel(context.Background())
	p := &Pool{
		queue:    make(chan func(context.Context), queueSize),
		stopChan: make(chan struct{}),
		ctx:      ctx,
		cancel:   cancel,
	}
	p.accepting.Store(true)
	for i := 0; i < workers; i++ {
		go p.worker()
	}
	return p, nil
}

// Submit enqueues a task. Returns ErrPoolClosed once Drain has begun
// or ErrQueueFull when the queue is at capacity.
//
// wg.Add is performed BEFORE the channel send so a Drain that runs
// concurrently with Submit cannot return early: either we successfully
// enqueue (wg.Add stays accounted for and a worker will eventually
// call wg.Done) or we fail and undo the Add.
func (p *Pool) Submit(task func(ctx context.Context)) error {
	if !p.accepting.Load() {
		return ErrPoolClosed
	}
	p.wg.Add(1)
	select {
	case p.queue <- task:
		return nil
	default:
		p.wg.Done()
		return ErrQueueFull
	}
}

// Drain stops accepting new work, cancels the pool-wide context so
// queued-but-not-started tasks can short-circuit, and waits up to
// `timeout` for in-flight tasks to finish. Returns ErrDrainTimeout
// when the deadline elapses; subsequent Drain calls are no-ops that
// return nil (the pool is already drained).
func (p *Pool) Drain(timeout time.Duration) error {
	var firstCall bool
	p.drainOnce.Do(func() {
		firstCall = true
		p.accepting.Store(false)
		close(p.stopChan)
		// Cancelling the context lets queued tasks see ctx.Err() and
		// short-circuit. In-flight tasks see it on their next
		// context-aware call.
		p.cancel()
	})
	if !firstCall {
		return nil
	}

	done := make(chan struct{})
	go func() {
		p.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		p.closeOnce.Do(func() { close(p.queue) })
		return nil
	case <-time.After(timeout):
		// Don't close the channel — workers may still drain it
		// (the context cancellation should make them exit voluntarily).
		return ErrDrainTimeout
	}
}

// worker is the main goroutine loop. It exits when the stop channel
// is closed AND the queue is empty.
func (p *Pool) worker() {
	for {
		select {
		case task, ok := <-p.queue:
			if !ok {
				return
			}
			p.runTask(task)
		case <-p.stopChan:
			// Drain remaining queued tasks until the channel is
			// closed (or empty if it never gets closed).
			for {
				select {
				case task, ok := <-p.queue:
					if !ok {
						return
					}
					p.runTask(task)
				default:
					return
				}
			}
		}
	}
}

// runTask executes one task with panic recovery. wg.Done pairs with the
// wg.Add in Submit. A panic in one task must not take down siblings.
func (p *Pool) runTask(task func(ctx context.Context)) {
	defer p.wg.Done()
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr, "[workerpool] task panicked: %v\n%s\n", r, debug.Stack())
		}
	}()
	task(p.ctx)
}
