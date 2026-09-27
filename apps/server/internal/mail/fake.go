package mail

import (
	"context"
	"sync"
	"time"
)

// Fake is an in-memory Sender for tests: it records messages and can fail on demand.
type Fake struct {
	mu       sync.Mutex
	sent     []Message
	failures int
	failErr  error
	notify   chan struct{}
}

// NewFake returns an empty Fake.
func NewFake() *Fake { return &Fake{notify: make(chan struct{})} }

// Send implements Sender.
func (f *Fake) Send(_ context.Context, m Message) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failures > 0 {
		f.failures--
		return f.failErr
	}
	f.sent = append(f.sent, m)
	close(f.notify)
	f.notify = make(chan struct{})
	return nil
}

// FailNext makes the next n sends return err.
func (f *Fake) FailNext(n int, err error) {
	f.mu.Lock()
	f.failures, f.failErr = n, err
	f.mu.Unlock()
}

// Sent returns a copy of the delivered messages.
func (f *Fake) Sent() []Message {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Message(nil), f.sent...)
}

// Wait returns the first delivered message matching pred, waiting up to timeout.
func (f *Fake) Wait(timeout time.Duration, pred func(Message) bool) (Message, bool) {
	return f.WaitN(timeout, 1, pred)
}

// WaitN returns the n-th (1-based, in delivery order) message matching pred, waiting up to
// timeout for it.
func (f *Fake) WaitN(timeout time.Duration, n int, pred func(Message) bool) (Message, bool) {
	deadline := time.After(timeout)
	for {
		f.mu.Lock()
		k := 0
		for _, m := range f.sent {
			if pred(m) {
				if k++; k == n {
					f.mu.Unlock()
					return m, true
				}
			}
		}
		ch := f.notify
		f.mu.Unlock()
		select {
		case <-ch:
		case <-deadline:
			return Message{}, false
		}
	}
}

// Count returns how many delivered messages match pred.
func (f *Fake) Count(pred func(Message) bool) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, m := range f.sent {
		if pred(m) {
			n++
		}
	}
	return n
}
