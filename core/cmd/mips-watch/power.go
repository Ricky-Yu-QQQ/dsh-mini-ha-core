package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"dsh-mini-ha-core/internal/mipsidentity"
	"github.com/eclipse/paho.golang/paho"
)

type powerProperty struct {
	DID  string `json:"did"`
	SIID int    `json:"siid"`
	PIID int    `json:"piid"`
}

type powerConfig struct {
	Device            string
	Gateway, Identity string
	Power             struct{ SIID, PIID int }
	Light             bool
	KelvinMax         int
}

var lightFields = []string{"power", "brightness", "kelvin"}

func (c powerConfig) acceptsValue(field string, value json.RawMessage, reading bool) bool {
	if field == "power" {
		return bytes.Equal(value, []byte("true")) || bytes.Equal(value, []byte("false"))
	}
	if !c.Light {
		return false
	}
	var n *int
	if json.Unmarshal(value, &n) != nil || n == nil {
		return false
	}
	switch field {
	case "brightness":
		return (*n >= 1 || reading && *n == 0) && *n <= 100
	case "kelvin":
		if reading {
			return *n >= 1000 && *n <= 20000
		}
		maximum := c.KelvinMax
		if maximum == 0 {
			maximum = 6000
		}
		return *n >= 2700 && *n <= maximum
	default:
		return false
	}
}

func privateFile(path string) bool {
	info, err := os.Lstat(path)
	return filepath.IsAbs(path) && strings.Contains(filepath.Clean(path), "/.local/") &&
		err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0077 == 0 && info.Size() <= 65536
}

func lockPowerIdentity(ctx context.Context, file *os.File) error {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("MIPS identity is busy: %w", err)
		}
		err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if !errors.Is(err, syscall.EWOULDBLOCK) {
			return err
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("MIPS identity is busy: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}

func powerMessage(mid uint32, reply string, payload []byte) []byte {
	var frame []byte
	field := func(tag byte, value []byte) {
		frame = binary.LittleEndian.AppendUint32(frame, uint32(len(value)))
		frame = append(frame, tag)
		frame = append(frame, value...)
	}
	field(0, binary.LittleEndian.AppendUint32(nil, mid))
	field(3, []byte("local\x00"))
	field(1, []byte(reply+"\x00"))
	field(2, append(payload, 0))
	return frame
}

func powerReply(frame []byte, mid uint32) []byte {
	var payload []byte
	var hasID bool
	for len(frame) >= 5 {
		n, tag := binary.LittleEndian.Uint32(frame), frame[4]
		frame = frame[5:]
		if uint64(n) > uint64(len(frame)) {
			return nil
		}
		switch tag {
		case 0:
			if hasID || n != 4 || binary.LittleEndian.Uint32(frame) != mid {
				return nil
			}
			hasID = true
		case 2:
			if payload != nil {
				return nil
			}
			payload = bytes.TrimRight(frame[:n], "\x00")
		}
		frame = frame[n:]
	}
	if !hasID || len(frame) != 0 {
		return nil
	}
	return payload
}

type powerClient struct {
	client   *paho.Client
	messages <-chan *paho.Publish
	reply    string
	mid      uint32
}

func (c *powerClient) request(ctx context.Context, topic string, input any) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	body, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	c.mid++
	if _, err = c.client.Publish(ctx, &paho.Publish{
		Topic: "master/" + topic, Payload: powerMessage(c.mid, c.reply, body), QoS: 2,
	}); err != nil {
		return nil, err
	}
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-c.client.Done():
			return nil, errors.New("gateway disconnected")
		case packet := <-c.messages:
			if packet.Topic == c.reply && !packet.Retain {
				if payload := powerReply(packet.Payload, c.mid); payload != nil {
					return payload, nil
				}
			}
		}
	}
}

func (c *powerClient) read(ctx context.Context, target powerProperty) (json.RawMessage, error) {
	data, err := c.request(ctx, "proxy/get", target)
	if err != nil {
		return nil, err
	}
	var body struct {
		Value json.RawMessage
		Code  int
	}
	if json.Unmarshal(data, &body) != nil || body.Value == nil || body.Code != 0 {
		return nil, errors.New("invalid gateway property readback")
	}
	return body.Value, nil
}

func writeReceipt(data []byte, target powerProperty, rpcID uint32) (int, error) {
	var body struct {
		ID     *uint32
		Result []struct {
			DID        string
			SIID, PIID *int
			Code       *int
		}
	}
	if json.Unmarshal(data, &body) != nil || len(body.Result) != 1 ||
		body.ID != nil && *body.ID != rpcID {
		return -1, errors.New("invalid gateway power receipt")
	}
	row := body.Result[0]
	if row.DID != target.DID || row.SIID != nil && *row.SIID != target.SIID ||
		row.PIID != nil && *row.PIID != target.PIID ||
		row.Code == nil || (*row.Code != 0 && *row.Code != 1) {
		return -1, errors.New("gateway power receipt did not match enrolled channel")
	}
	return *row.Code, nil
}

func (c *powerClient) write(ctx context.Context, target powerProperty, value json.RawMessage) (int, error) {
	rpcID := c.mid + 1
	data, err := c.request(ctx, "proxy/rpcReq", map[string]any{
		"did": target.DID, "rpc": map[string]any{
			"id": rpcID, "method": "set_properties",
			"params": []struct {
				powerProperty
				Value json.RawMessage `json:"value"`
			}{{target, value}},
		},
	})
	if err != nil {
		return -1, err
	}
	return writeReceipt(data, target, rpcID)
}

func runPower(args []string) error {
	flags := flag.NewFlagSet("power", flag.ContinueOnError)
	configPath := flags.String("config", "", "owner-only power enrollment")
	device := flags.String("expected-device", "", "enrolled device DID")
	channel := flags.String("expected-power", "", "enrolled SIID/PIID")
	journal := flags.String("journal", "", "stdout journal (-)")
	mode := flags.String("mode", "read", "read or set")
	property := flags.String("property", "", "set: power, or brightness/kelvin for an enrolled light")
	value := flags.String("value", "", "set: JSON value")
	apply := flags.Bool("apply", false, "authorize one enrolled property write")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *journal != "-" || !privateFile(*configPath) ||
		(*mode != "read" && *mode != "set") || (*mode == "set" && !*apply) {
		return errors.New("invalid enrolled power request")
	}
	var config powerConfig
	if err := readJSON(*configPath, &config); err != nil {
		return err
	}
	target := powerProperty{config.Device, config.Power.SIID, config.Power.PIID}
	did := regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,64}$`)
	if !did.MatchString(target.DID) || *device != target.DID || target.SIID < 1 || target.SIID > 65535 ||
		target.PIID < 1 || target.PIID > 65535 || *channel != fmt.Sprintf("%d/%d", target.SIID, target.PIID) ||
		!privateFile(config.Gateway) || !privateFile(config.Identity) {
		return errors.New("power target did not match private enrollment")
	}
	if (config.Light && (target.SIID != 2 || target.PIID != 1)) ||
		(config.KelvinMax != 0 && (!config.Light || config.KelvinMax < 6000 || config.KelvinMax > 6500)) {
		return errors.New("invalid light enrollment")
	}
	fields := lightFields[:1]
	if config.Light {
		fields = lightFields
	}
	wanted := json.RawMessage(bytes.TrimSpace([]byte(*value)))
	if *mode == "set" {
		if !config.acceptsValue(*property, wanted, false) {
			return errors.New("property outside enrollment or value range")
		}
		for index, field := range fields {
			if field == *property && index > 0 {
				target.PIID = index + 1
			}
		}
	}
	return withMIPSClient(config.Gateway, config.Identity, func(ctx context.Context, c *powerClient) error {
		return runPowerRequest(ctx, c, config, target, fields, *mode, *property, wanted)
	})
}

func withMIPSClient(gatewayPath, identityPath string, use func(context.Context, *powerClient) error) error {
	var g gateway
	if err := readJSON(gatewayPath, &g); err != nil {
		return err
	}
	lock, err := os.OpenFile(identityPath+".watch.lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err = lockPowerIdentity(ctx, lock); err != nil {
		return err
	}
	identity, err := mipsidentity.Load(identityPath)
	if err != nil {
		return err
	}
	tlsConfig, err := verifiedTLS(g, identity)
	if err != nil {
		return err
	}
	dialer := tls.Dialer{Config: tlsConfig}
	socket, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(g.Host, strconv.Itoa(g.Port)))
	if err != nil {
		return err
	}
	defer socket.Close()
	client, messages, err := connect(ctx, socket, identity.VirtualDID, nil, "property")
	if err != nil {
		return err
	}
	defer client.Disconnect(&paho.Disconnect{})
	var randomID [4]byte
	if _, err = rand.Read(randomID[:]); err != nil {
		return err
	}
	return use(ctx, &powerClient{client, messages, identity.VirtualDID + "/reply", binary.LittleEndian.Uint32(randomID[:])})
}

func runPowerRequest(ctx context.Context, c *powerClient, config powerConfig, target powerProperty, fields []string, mode, property string, wanted json.RawMessage) error {
	out := json.NewEncoder(os.Stdout)
	read := func(p powerProperty, field string) (json.RawMessage, error) {
		actual, err := c.read(ctx, p)
		if err == nil && !config.acceptsValue(field, actual, true) {
			err = errors.New("invalid gateway property value")
		}
		return actual, err
	}
	if mode == "read" {
		report := map[string]any{"phase": "readback", "siid": target.SIID, "piid": target.PIID}
		for index, field := range fields {
			p := target
			if index > 0 {
				p.PIID = index + 1
			}
			actual, err := read(p, field)
			if err != nil {
				return err
			}
			report[field] = actual
		}
		return out.Encode(report)
	}
	if _, err := read(target, property); err != nil {
		return err
	}
	code, err := c.write(ctx, target, wanted)
	if err != nil {
		return err
	}
	if err = out.Encode(map[string]any{"phase": "write-ack", "siid": target.SIID, "piid": target.PIID, "code": code}); err != nil {
		return err
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		actual, readErr := read(target, property)
		if readErr != nil {
			return readErr
		}
		if bytes.Equal(actual, wanted) {
			return out.Encode(map[string]any{"phase": "write-confirmed", "siid": target.SIID, "piid": target.PIID, "code": code, "value": actual})
		}
		if time.Now().After(deadline) {
			return errors.New("power write readback did not converge")
		}
		time.Sleep(150 * time.Millisecond)
	}
}
