package main

import (
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"

	"dsh-mini-ha-core/internal/mipsidentity"
)

const callbackHost = mipsidentity.CallbackHost

type enrollment struct {
	deviceID string
	did      string
	path     string
	state    string
}

func newEnrollment(did string) enrollment {
	var seed [24]byte
	rand.Read(seed[:])
	if did == "" {
		did = strconv.FormatUint(binary.BigEndian.Uint64(seed[:8]), 10)
	}
	deviceID := "ha." + hex.EncodeToString(seed[8:])
	state := sha1.Sum([]byte("d=" + deviceID))
	return enrollment{deviceID, did, "/api/webhook/" + did, hex.EncodeToString(state[:])}
}

func (e enrollment) authURL(upgrade bool) string {
	query := url.Values{
		"client_id":     {strconv.FormatInt(mipsidentity.ClientID, 10)},
		"redirect_uri":  {mipsidentity.RedirectURI(e.did)},
		"response_type": {"code"},
		"device_id":     {e.deviceID},
		"state":         {e.state},
		"skip_confirm":  {"False"},
	}
	if upgrade {
		query.Set("skip_confirm", "True")
	}
	return "https://account.xiaomi.com/oauth2/authorize?" + query.Encode()
}

func oauthCallback(path, state string, codes chan<- string) http.Handler {
	var used atomic.Bool
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if r.Method != http.MethodGet || r.URL.Path != path || r.Host != callbackHost {
			http.NotFound(w, r)
			return
		}
		query := r.URL.Query()
		code := query.Get("code")
		if subtle.ConstantTimeCompare([]byte(state), []byte(query.Get("state"))) != 1 || code == "" || len(code) > 4096 {
			http.Error(w, "Invalid Xiaomi authorization callback", http.StatusBadRequest)
			return
		}
		if !used.CompareAndSwap(false, true) {
			http.Error(w, "Authorization already received", http.StatusConflict)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintln(w, "已收到小米授权。可以关闭此窗口，Go 正在申请中枢证书。")
		codes <- code
	})
}

func runBrowser(ctx context.Context, dir, upgradePath string) (mipsidentity.Identity, error) {
	var did string
	if upgradePath == "" {
		if err := os.Mkdir(dir, 0700); err != nil {
			return mipsidentity.Identity{}, fmt.Errorf("create a new private enrollment directory: %w", err)
		}
	} else {
		id, err := mipsidentity.Load(upgradePath)
		if err != nil {
			return mipsidentity.Identity{}, err
		}
		did, dir = id.VirtualDID, filepath.Dir(upgradePath)
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:8123")
	if err != nil {
		return mipsidentity.Identity{}, err
	}
	defer listener.Close()
	e := newEnrollment(did)
	codes := make(chan string, 1)
	server := &http.Server{Handler: oauthCallback(e.path, e.state, codes), ReadHeaderTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second}
	defer server.Close()
	go server.Serve(listener)

	profile := filepath.Join(dir, "chrome")
	if err := exec.Command("/usr/bin/open", "-na", "Google Chrome", "--args",
		"--user-data-dir="+profile, "--incognito", "--no-first-run", "--no-default-browser-check",
		"--host-resolver-rules=MAP homeassistant.local 127.0.0.1", e.authURL(upgradePath != "")).Run(); err != nil {
		return mipsidentity.Identity{}, fmt.Errorf("open isolated Chrome: %w", err)
	}
	fmt.Println("Waiting for Xiaomi authorization in the isolated Chrome window")
	select {
	case <-ctx.Done():
		return mipsidentity.Identity{}, ctx.Err()
	case code := <-codes:
		fmt.Println("Xiaomi callback verified")
		client := mipsidentity.NewHTTPClient()
		if upgradePath != "" {
			return mipsidentity.Upgrade(ctx, client, upgradePath, e.deviceID, code)
		}
		id, err := mipsidentity.Enroll(ctx, client, mipsidentity.Identity{VirtualDID: e.did, DeviceID: e.deviceID}, code)
		if err != nil {
			return mipsidentity.Identity{}, err
		}
		return id, mipsidentity.SaveNew(filepath.Join(dir, "identity.json"), id)
	}
}

func run() error {
	dir := flag.String("dir", "", "new directory under the private .local workspace")
	upgrade := flag.String("upgrade", "", "existing identity.json to authorize for renewal")
	renew := flag.String("renew", "", "existing renewable identity.json to renew now")
	flag.Parse()
	var mode, path string
	for _, arg := range []struct{ mode, path string }{{"enroll", *dir}, {"upgrade", *upgrade}, {"renew", *renew}} {
		if arg.path == "" {
			continue
		}
		if path != "" {
			return errors.New("provide exactly one of -dir, -upgrade or -renew")
		}
		mode, path = arg.mode, arg.path
	}
	if path == "" {
		return errors.New("provide exactly one of -dir, -upgrade or -renew")
	}
	path, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	var id mipsidentity.Identity
	switch mode {
	case "enroll":
		id, err = runBrowser(ctx, path, "")
	case "upgrade":
		id, err = runBrowser(ctx, "", path)
	case "renew":
		id, err = mipsidentity.Renew(ctx, mipsidentity.NewHTTPClient(), path, time.Now(), true)
	}
	if err != nil {
		return err
	}
	expires, err := id.ExpiresAt()
	if err != nil {
		return err
	}
	fmt.Printf("Private gateway identity saved. Certificate valid until %s\n", expires.UTC().Format(time.RFC3339))
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
