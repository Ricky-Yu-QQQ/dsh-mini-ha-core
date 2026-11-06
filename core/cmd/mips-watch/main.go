package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/eclipse/paho.golang/paho"
	"dsh-mini-ha-core/internal/mipsidentity"
)

type gateway struct {
	Host        string
	Port        int
	CA          string
	Fingerprint string
}

type notification struct {
	DID       string          `json:"did"`
	SIID      int             `json:"siid"`
	EIID      int             `json:"eiid,omitempty"`
	PIID      int             `json:"piid,omitempty"`
	Value     json.RawMessage `json:"value,omitempty"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

func readJSON(path string, result any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if json.Unmarshal(data, result) != nil {
		return fmt.Errorf("invalid JSON in %s", path)
	}
	return nil
}

func verifiedTLS(g gateway, id mipsidentity.Identity) (*tls.Config, error) {
	ip := net.ParseIP(g.Host)
	pin, err := hex.DecodeString(g.Fingerprint)
	if ip == nil || !ip.IsPrivate() || g.Port < 1 || g.Port > 65535 || err != nil || len(pin) != sha256.Size {
		return nil, errors.New("a fixed private gateway and SHA256 leaf pin are required")
	}
	ca, err := os.ReadFile(g.CA)
	if err != nil {
		return nil, err
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(ca) {
		return nil, errors.New("invalid gateway CA")
	}
	pair, err := tls.X509KeyPair([]byte(id.Cert), []byte(id.Key))
	if err != nil {
		return nil, errors.New("invalid gateway client certificate or key")
	}
	return &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{pair},
		// The gateway leaf has no DNS SAN. Verify its CA chain and pinned identity below.
		InsecureSkipVerify: true,
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 {
				return errors.New("missing gateway certificate")
			}
			leaf := state.PeerCertificates[0]
			hash := sha256.Sum256(leaf.Raw)
			if !bytes.Equal(hash[:], pin) {
				return errors.New("gateway certificate pin mismatch")
			}
			intermediates := x509.NewCertPool()
			for _, cert := range state.PeerCertificates[1:] {
				intermediates.AddCert(cert)
			}
			_, err := leaf.Verify(x509.VerifyOptions{Roots: roots, Intermediates: intermediates})
			return err
		},
	}, nil
}

func notificationTopic(device, kind string) string {
	return "appMsg/notify/iot/" + device + "/" + kind + "/"
}

func parseNotification(topic string, frame []byte, virtualDID, device, kind string) (notification, error) {
	var payload []byte
	for len(frame) >= 5 {
		size := binary.LittleEndian.Uint32(frame)
		tag := frame[4]
		frame = frame[5:]
		if uint64(size) > uint64(len(frame)) {
			return notification{}, errors.New("truncated MIPS field")
		}
		if tag == 2 {
			if payload != nil {
				return notification{}, errors.New("duplicate MIPS payload")
			}
			payload = bytes.TrimRight(frame[:size], "\x00")
		}
		frame = frame[size:]
	}
	var data notification
	if len(frame) != 0 || json.Unmarshal(payload, &data) != nil {
		return notification{}, errors.New("invalid MIPS payload")
	}
	instance := data.EIID
	if kind == "property" {
		if len(data.Value) == 0 || data.EIID != 0 {
			return notification{}, errors.New("invalid MIPS property")
		}
		instance = data.PIID
	} else if data.PIID != 0 {
		return notification{}, errors.New("invalid MIPS event")
	}
	expected := fmt.Sprintf("%s/%s%d.%d", virtualDID, notificationTopic(device, kind), data.SIID, instance)
	if data.DID != device || data.SIID < 1 || instance < 1 || topic != expected {
		return notification{}, errors.New("notification does not match subscribed device and topic")
	}
	return data, nil
}

func connect(ctx context.Context, socket net.Conn, id string, devices []string, kind string) (*paho.Client, <-chan *paho.Publish, error) {
	messages := make(chan *paho.Publish, 64)
	client := paho.NewClient(paho.ClientConfig{
		Conn: socket, PacketTimeout: 5 * time.Second,
		OnPublishReceived: []func(paho.PublishReceived) (bool, error){func(msg paho.PublishReceived) (bool, error) {
			select {
			case messages <- msg.Packet:
				return true, nil
			default:
				_ = socket.Close()
				return false, errors.New("MIPS event queue full")
			}
		}},
	})
	ack, err := client.Connect(ctx, &paho.Connect{ClientID: id, CleanStart: true, KeepAlive: 30})
	if err != nil {
		if ack != nil {
			return nil, nil, fmt.Errorf("MQTT CONNACK 0x%02x: %w", ack.ReasonCode, err)
		}
		return nil, nil, fmt.Errorf("MQTT CONNECT: %w", err)
	}
	topics := []paho.SubscribeOptions{{Topic: id + "/#", QoS: 2}}
	for _, device := range devices {
		topics = append(topics, paho.SubscribeOptions{Topic: "master/" + notificationTopic(device, kind) + "#", QoS: 2})
	}
	sub, err := client.Subscribe(ctx, &paho.Subscribe{Subscriptions: topics})
	if err != nil {
		return nil, nil, fmt.Errorf("MQTT SUBSCRIBE: %w", err)
	}
	if len(sub.Reasons) != len(topics) {
		return nil, nil, errors.New("incomplete MQTT SUBACK")
	}
	for _, reason := range sub.Reasons {
		if reason >= 0x80 {
			return nil, nil, fmt.Errorf("MQTT SUBACK refused: 0x%02x", reason)
		}
	}
	return client, messages, nil
}

var errIdentityRenewed = errors.New("MIPS identity renewed")

func watch(ctx context.Context, g gateway, id mipsidentity.Identity, devices []string, kind string, renewed <-chan struct{}) error {
	config, err := verifiedTLS(g, id)
	if err != nil {
		return err
	}
	setup, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	dialer := tls.Dialer{Config: config}
	socket, err := dialer.DialContext(setup, "tcp", net.JoinHostPort(g.Host, strconv.Itoa(g.Port)))
	if err != nil {
		return fmt.Errorf("local TLS: %w", err)
	}
	defer socket.Close()
	client, messages, err := connect(setup, socket, id.VirtualDID, devices, kind)
	if err != nil {
		return err
	}
	defer client.Disconnect(&paho.Disconnect{})
	cancel()
	out := json.NewEncoder(os.Stdout)
	if err := out.Encode(map[string]any{"phase": "subscribed", "at": time.Now(), "source": "local-mips"}); err != nil {
		return err
	}
	allowed := make(map[string]bool, len(devices))
	for _, device := range devices {
		allowed[device] = true
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-renewed:
			if err := out.Encode(map[string]string{"phase": "gap", "reason": "certificate_renewed"}); err != nil {
				return err
			}
			return errIdentityRenewed
		case <-client.Done():
			return errors.New("gateway MQTT disconnected")
		case packet := <-messages:
			if packet.Retain {
				continue
			}
			parts := strings.Split(packet.Topic, "/")
			if len(parts) != 7 || !allowed[parts[4]] {
				continue
			}
			e, err := parseNotification(packet.Topic, packet.Payload, id.VirtualDID, parts[4], kind)
			if err != nil {
				continue
			}
			if err := out.Encode(struct {
				Phase  string    `json:"phase"`
				At     time.Time `json:"at"`
				Source string    `json:"source"`
				notification
			}{"device-" + kind, time.Now(), "local-mips", e}); err != nil {
				return err
			}
		}
	}
}

func run() error {
	gatewayPath := flag.String("gateway", "", "private JSON with host, port, CA path and SHA256 leaf fingerprint")
	identityPath := flag.String("identity", "", "private JSON from mips-enroll")
	device := flag.String("device", "", "comma-separated MIoT device DIDs to watch")
	kind := flag.String("kind", "event", "event or property")
	duration := flag.Duration("duration", 5*time.Minute, "maximum observation window (0 runs until interrupted)")
	flag.Parse()
	if *gatewayPath == "" || *identityPath == "" || *duration < 0 {
		return errors.New("provide -gateway, -identity and a valid -device")
	}
	devices := strings.Split(*device, ",")
	if len(devices) > 256 {
		return errors.New("too many device subscriptions")
	}
	validDID := regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,64}$`)
	seen := make(map[string]bool, len(devices))
	for _, did := range devices {
		if !validDID.MatchString(did) || seen[did] {
			return errors.New("invalid or duplicate device DID")
		}
		seen[did] = true
	}
	if *kind != "event" && *kind != "property" {
		return errors.New("kind must be event or property")
	}
	var g gateway
	if err := readJSON(*gatewayPath, &g); err != nil {
		return err
	}
	lock, err := os.OpenFile(*identityPath+".watch.lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("a watcher already owns this MIPS identity")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *duration > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, *duration)
		defer cancel()
	}
	return watchWithRenewal(ctx, g, *identityPath, devices, *kind)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
