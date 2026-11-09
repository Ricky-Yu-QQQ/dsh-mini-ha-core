package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"dsh-mini-ha-core/internal/mipsidentity"
	"github.com/eclipse/paho.golang/paho"
)

type gatewayRequest struct {
	Topic    string
	Body     json.RawMessage
	Deadline time.Time
}

func proxyRequest(ctx context.Context, address, topic string, body json.RawMessage) ([]byte, error) {
	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", address)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	deadline, _ := ctx.Deadline()
	if err = conn.SetDeadline(deadline); err != nil {
		return nil, err
	}
	if err = json.NewEncoder(conn).Encode(gatewayRequest{topic, body, deadline}); err != nil {
		return nil, err
	}
	var reply json.RawMessage
	if err = json.NewDecoder(io.LimitReader(conn, 65536)).Decode(&reply); err != nil {
		return nil, err
	}
	if string(reply) == "null" {
		return nil, errors.New("local gateway request failed")
	}
	return reply, nil
}

func answerGateway(ctx context.Context, conn net.Conn, client *powerClient) {
	defer conn.Close()
	deadline := time.Now().Add(3 * time.Second)
	if conn.SetDeadline(deadline) != nil {
		return
	}
	var req gatewayRequest
	if json.NewDecoder(io.LimitReader(conn, 65536)).Decode(&req) != nil ||
		(req.Topic != "proxy/get" && req.Topic != "proxy/rpcReq") ||
		len(req.Body) == 0 || !req.Deadline.After(time.Now()) {
		return
	}
	if req.Deadline.Before(deadline) {
		deadline = req.Deadline
	}
	call, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	body, err := client.request(call, req.Topic, req.Body)
	if err != nil || !json.Valid(body) {
		body = []byte("null")
	}
	_ = json.NewEncoder(conn).Encode(json.RawMessage(body))
}

func serveGateway(ctx context.Context, g gateway, id mipsidentity.Identity, devices map[string]bool, address string, renewed <-chan struct{}) error {
	config, err := verifiedTLS(g, id)
	if err != nil {
		return err
	}
	setup, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	dialer := tls.Dialer{Config: config}
	socket, err := dialer.DialContext(setup, "tcp", net.JoinHostPort(g.Host, strconv.Itoa(g.Port)))
	if err != nil {
		return err
	}
	defer socket.Close()

	var targets []string
	for did := range devices {
		targets = append(targets, did)
	}
	var output sync.Mutex
	out := json.NewEncoder(os.Stdout)
	emit := func(row any) {
		output.Lock()
		defer output.Unlock()
		_ = out.Encode(row)
	}
	replyTopic := id.VirtualDID + "/reply"
	onReport := func(packet *paho.Publish) bool {
		if packet.Topic == replyTopic {
			return false
		}
		parts := strings.Split(packet.Topic, "/")
		if !packet.Retain && len(parts) == 7 && devices[parts[4]] {
			report, err := parseNotification(packet.Topic, packet.Payload, id.VirtualDID, parts[4], "property")
			if err == nil {
				emit(struct {
					Phase string `json:"phase"`
					notification
				}{"device-property", report})
			}
		}
		return true
	}
	client, messages, err := connectWithReports(setup, socket, id.VirtualDID, targets, "property", onReport)
	if err != nil {
		return err
	}
	defer client.Disconnect(&paho.Disconnect{})
	listener, err := net.Listen("unix", address)
	if err != nil {
		return err
	}
	defer listener.Close()
	var randomID [4]byte
	if _, err = rand.Read(randomID[:]); err != nil {
		return err
	}
	rpc := &powerClient{client: client, messages: messages, reply: replyTopic, mid: binary.LittleEndian.Uint32(randomID[:])}
	ready, stop := context.WithCancel(ctx)
	defer stop()
	go func() {
		select {
		case <-ready.Done():
		case <-renewed:
		case <-client.Done():
		}
		stop()
		_ = listener.Close()
	}()
	emit(map[string]string{"phase": "subscribed"})
	cancel()
	for ready.Err() == nil {
		conn, err := listener.Accept()
		if err != nil {
			break
		}
		answerGateway(ready, conn, rpc)
	}
	emit(map[string]string{"phase": "gap"})
	if ctx.Err() != nil {
		return nil
	}
	select {
	case <-renewed:
		return errIdentityRenewed
	default:
		return errors.New("gateway subscription closed")
	}
}

func runServe(args []string) error {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	gatewayPath := flags.String("gateway", "", "owner-only gateway settings")
	identityPath := flags.String("identity", "", "owner-only gateway identity")
	dids := flags.String("device", "", "comma-separated device IDs")
	address := flags.String("socket", "", "Unix socket in a private directory")
	if err := flags.Parse(args); err != nil {
		return err
	}
	dir, err := os.Stat(filepath.Dir(*address))
	if flags.NArg() != 0 || !filepath.IsAbs(*address) || err != nil ||
		!dir.IsDir() || dir.Mode().Perm()&0077 != 0 || !privateFile(*gatewayPath) || !privateFile(*identityPath) {
		return errors.New("private gateway, identity and socket directory required")
	}
	devices := make(map[string]bool)
	for _, did := range strings.Split(*dids, ",") {
		if !motorDID.MatchString(did) || devices[did] || len(devices) >= 256 {
			return errors.New("invalid gateway subscription")
		}
		devices[did] = true
	}
	var g gateway
	if err = readJSON(*gatewayPath, &g); err != nil {
		return err
	}
	lock, err := os.OpenFile(*identityPath+".watch.lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("MIPS identity is busy")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		stop()
	}()
	return withRenewal(ctx, *identityPath, func(id mipsidentity.Identity, renewed <-chan struct{}) error {
		return serveGateway(ctx, g, id, devices, *address, renewed)
	})
}
