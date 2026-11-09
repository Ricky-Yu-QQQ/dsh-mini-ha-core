package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestPowerIdentityWaitsForCurrentOwner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity.lock")
	first, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := os.OpenFile(path, os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if err := syscall.Flock(int(first.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	blocked, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	if err := lockPowerIdentity(blocked, second); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("occupied identity must stay exclusive: %v", err)
	}
	waiting, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	result := make(chan error, 1)
	go func() { result <- lockPowerIdentity(waiting, second) }()
	select {
	case err := <-result:
		t.Fatalf("second caller returned before the lock was released: %v", err)
	case <-time.After(75 * time.Millisecond):
	}
	if err := syscall.Flock(int(first.Fd()), syscall.LOCK_UN); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err != nil {
		t.Fatalf("waiting caller did not acquire the released identity: %v", err)
	}
}

func TestPowerReplyCorrelatesMQTTAndDeviceReceipts(t *testing.T) {
	target := powerProperty{"group.1", 15, 1}
	body := []byte(`{"id":42,"result":[{"did":"group.1","siid":15,"piid":1,"code":1}]}`)
	frame := powerMessage(42, "fixture/reply", body)
	if code, err := writeReceipt(powerReply(frame, 42), target, 42); err != nil || code != 1 {
		t.Fatalf("matching receipt rejected: %d, %v", code, err)
	}
	if powerReply(frame, 43) != nil || powerReply(frame[:len(frame)-1], 42) != nil {
		t.Fatal("wrong request or truncated frame accepted")
	}
	for _, raw := range []string{
		`{"id":43,"result":[{"did":"group.1","code":0}]}`,
		`{"result":[{"did":"group.1","siid":14,"piid":1,"code":0}]}`,
		`{"result":[{"did":"group.2","code":0}]}`,
		`{"result":[{"did":"group.1","code":-1}]}`,
	} {
		if _, err := writeReceipt([]byte(raw), target, 42); err == nil {
			t.Fatal("mismatched or rejected receipt accepted")
		}
	}
}
