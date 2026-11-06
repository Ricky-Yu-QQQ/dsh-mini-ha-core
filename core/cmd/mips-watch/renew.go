package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"

	"dsh-mini-ha-core/internal/mipsidentity"
)

func watchWithRenewal(ctx context.Context, g gateway, path string, devices []string, kind string) error {
	id, err := mipsidentity.Load(path)
	if err != nil {
		return err
	}
	expires, err := id.ExpiresAt()
	if err != nil {
		return err
	}
	client := mipsidentity.NewHTTPClient()
	if !time.Now().Before(expires) {
		id, err = mipsidentity.Renew(ctx, client, path, time.Now(), false)
		if err != nil {
			return err
		}
	}
	if id.RefreshToken == "" {
		fmt.Fprintln(os.Stderr, mipsidentity.ErrLegacy)
		return watch(ctx, g, id, devices, kind, nil)
	}
	for ctx.Err() == nil {
		updated, stop := context.WithCancel(ctx)
		done := make(chan struct{})
		go func() {
			defer close(done)
			renewWhenDue(updated, client, path, id, stop)
		}()
		// Keep the MQTT session alive during HTTPS signing and retry.
		err := watch(ctx, g, id, devices, kind, updated.Done())
		stop()
		<-done
		if ctx.Err() != nil {
			return nil
		}
		if !errors.Is(err, errIdentityRenewed) {
			return err
		}
		id, err = mipsidentity.Load(path)
		if err != nil {
			return err
		}
	}
	return nil
}

func renewWhenDue(ctx context.Context, client *http.Client, path string, current mipsidentity.Identity, renewed func()) {
	expires, err := current.ExpiresAt()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return
	}
	delay := time.Until(expires.Add(-mipsidentity.RenewBefore))
	for {
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		next, err := mipsidentity.Renew(ctx, client, path, time.Now(), false)
		if ctx.Err() != nil {
			return
		}
		if err == nil && next.Cert != current.Cert {
			fmt.Fprintln(os.Stderr, "MIPS certificate renewed; reconnecting MQTT")
			renewed()
			return
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "MIPS certificate renewal:", err)
		}
		delay = 5 * time.Minute
	}
}
