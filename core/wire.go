package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/md5"
	"crypto/rand"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"regexp"
	"strconv"
	"time"
)

const rpcTimeout = 2500 * time.Millisecond

type Config struct {
	Host         string
	ExpectedDid  uint32
	Token        string
	Light        string
	Presence     string
	PresencePiid int
}

type Property struct {
	DID  string `json:"did"`
	SIID int    `json:"siid"`
	PIID int    `json:"piid"`
}

type Notification struct {
	Property
	EIID  int             `json:"eiid,omitempty"`
	Value json.RawMessage `json:"value"`
}

type message struct {
	ID     uint32              `json:"id"`
	Method string              `json:"method,omitempty"`
	Params json.RawMessage     `json:"params,omitempty"`
	Result json.RawMessage     `json:"result,omitempty"`
	Error  *struct{ Code int } `json:"error,omitempty"`
}

func loadConfig(path string) (Config, error) {
	var s Config
	info, err := os.Stat(path)
	if err != nil {
		return s, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return s, errors.New("configuration must be an owner-only regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return s, err
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 65536))
	if err = decoder.Decode(&s); err != nil {
		return s, err
	}
	ip := net.ParseIP(s.Host)
	did := regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,64}$`)
	token, err := hex.DecodeString(s.Token)
	if ip == nil || ip.To4() == nil || !ip.IsPrivate() || s.ExpectedDid == 0 || err != nil || len(token) != 16 ||
		bytes.Equal(token, make([]byte, 16)) || !did.MatchString(s.Light) ||
		(s.Presence != "" && (!did.MatchString(s.Presence) || s.Presence == s.Light)) {
		return s, errors.New("invalid private gateway enrollment")
	}
	if s.PresencePiid == 0 {
		s.PresencePiid = 1
	}
	if s.PresencePiid < 1 || s.PresencePiid > 65535 {
		return s, errors.New("invalid presence property")
	}
	return s, nil
}

type codec struct {
	did   uint32
	token []byte
	block cipher.Block
	iv    []byte
}

func digest(parts ...[]byte) []byte {
	h := md5.New()
	for _, part := range parts {
		_, _ = h.Write(part)
	}
	return h.Sum(nil)
}
func newCodec(s Config) (codec, error) {
	token, err := hex.DecodeString(s.Token)
	if err != nil || len(token) != 16 {
		return codec{}, errors.New("invalid token")
	}
	key := digest(token)
	block, err := aes.NewCipher(key)
	return codec{s.ExpectedDid, token, block, digest(key, token)}, err
}
func (c codec) header(b []byte) bool {
	return len(b) >= 32 && binary.BigEndian.Uint16(b) == 0x2131 &&
		int(binary.BigEndian.Uint16(b[2:])) == len(b) && binary.BigEndian.Uint64(b[4:]) == uint64(c.did)
}
func (c codec) encode(m message, stamp uint32) ([]byte, error) {
	body, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	pad := aes.BlockSize - len(body)%aes.BlockSize
	body = append(body, bytes.Repeat([]byte{byte(pad)}, pad)...)
	if len(body) > 8192-32 {
		return nil, errors.New("miIO message budget")
	}
	cipher.NewCBCEncrypter(c.block, c.iv).CryptBlocks(body, body)
	head := make([]byte, 16)
	binary.BigEndian.PutUint16(head, 0x2131)
	binary.BigEndian.PutUint16(head[2:], uint16(len(body)+32))
	binary.BigEndian.PutUint64(head[4:], uint64(c.did))
	binary.BigEndian.PutUint32(head[12:], stamp)
	return append(append(head, digest(head, c.token, body)...), body...), nil
}
func (c codec) decode(frame []byte) (message, error) {
	var m message
	if !c.header(frame) || len(frame) < 48 || len(frame) > 8192 || (len(frame)-32)%aes.BlockSize != 0 ||
		subtle.ConstantTimeCompare(frame[16:32], digest(frame[:16], c.token, frame[32:])) != 1 {
		return m, errors.New("invalid miIO frame authentication")
	}
	body := bytes.Clone(frame[32:])
	cipher.NewCBCDecrypter(c.block, c.iv).CryptBlocks(body, body)
	pad := int(body[len(body)-1])
	if pad < 1 || pad > aes.BlockSize || !bytes.Equal(body[len(body)-pad:], bytes.Repeat([]byte{byte(pad)}, pad)) {
		return m, errors.New("invalid miIO frame padding")
	}
	err := json.Unmarshal(bytes.TrimRight(body[:len(body)-pad], "\x00"), &m)
	if err == nil && m.ID == 0 {
		err = errors.New("missing miIO message ID")
	}
	return m, err
}

type subscription struct {
	Version string `json:"version"`
	DID     string `json:"did"`
	Updated int64  `json:"update_ts"`
	Method  string `json:"sub_method"`
}

type Session struct {
	socket     *net.UDPConn
	codec      codec
	config     Config
	identity   uint64
	next       uint32
	stamp      int64
	sub        *subscription
	advertised bool
	pushed     []Notification
	seen       map[uint32]struct{}
	pushFrames int
}

func newID() (uint64, error) {
	var r [8]byte
	_, err := rand.Read(r[:])
	return binary.BigEndian.Uint64(r[:]) | 1, err
}
func open(s Config, endpoint *net.UDPAddr, id uint64) (*Session, error) {
	c, err := newCodec(s)
	if err != nil {
		return nil, err
	}
	socket, err := net.DialUDP("udp4", nil, endpoint)
	if err != nil {
		return nil, err
	}
	requestSeed, err := newID()
	if err != nil {
		_ = socket.Close()
		return nil, err
	}
	candidate := &Session{socket: socket, codec: c, config: s, identity: id, next: uint32(requestSeed) & 0x7fffffff, seen: make(map[uint32]struct{})}
	hello := bytes.Repeat([]byte{255}, 32)
	binary.BigEndian.PutUint16(hello, 0x2131)
	binary.BigEndian.PutUint16(hello[2:], 32)
	copy(hello[16:20], "MDID")
	binary.BigEndian.PutUint64(hello[20:], id)
	clear(hello[28:])
	deadline := time.Now().Add(rpcTimeout)
	if err = socket.SetDeadline(deadline); err == nil {
		_, err = socket.Write(hello)
	}
	buf := make([]byte, 8193)
	var n int
	if err == nil {
		n, err = socket.Read(buf)
	}
	if err != nil || n != 32 || !c.header(buf[:n]) {
		_ = socket.Close()
		if err != nil {
			return nil, err
		}
		return nil, errors.New("gateway identity mismatch")
	}
	candidate.stamp = int64(binary.BigEndian.Uint32(buf[12:])) - time.Now().Unix()
	candidate.advertised = string(buf[16:20]) == "MSUB" && string(buf[24:27]) == "PUB"
	return candidate, nil
}

func (c *Session) send(m message) error {
	raw, err := c.codec.encode(m, uint32(time.Now().Unix()+c.stamp))
	if err != nil {
		return err
	}
	_, err = c.socket.Write(raw)
	return err
}
func (c *Session) receive(deadline time.Time) (message, error) {
	if err := c.socket.SetReadDeadline(deadline); err != nil {
		return message{}, err
	}
	var buf [8193]byte
	for {
		n, err := c.socket.Read(buf[:])
		if err != nil {
			return message{}, err
		}
		if m, err := c.codec.decode(buf[:n]); err == nil {
			return m, nil
		}
	}
}
func (c *Session) accept(m message) {
	var notifications []Notification
	switch m.Method {
	case "properties_changed":
		if json.Unmarshal(m.Params, &notifications) != nil {
			return
		}
	case "event_occured":
		var n Notification
		if json.Unmarshal(m.Params, &n) != nil || n.EIID < 1 {
			return
		}
		notifications = []Notification{n}
	default:
		return
	}
	c.pushFrames++
	if _, ok := c.seen[m.ID]; !ok {
		if len(c.seen) >= 256 {
			clear(c.seen)
		}
		c.seen[m.ID] = struct{}{}
		for _, n := range notifications {
			if (n.DID == c.config.Light || n.DID != "" && n.DID == c.config.Presence) && len(c.pushed) < 128 {
				c.pushed = append(c.pushed, n)
			}
		}
	}
	// The acknowledgment belongs to this gateway session, not to an individual device.
	_ = c.send(message{ID: m.ID, Result: json.RawMessage(`{"code":0}`)})
}
func (c *Session) request(method string, params any) (json.RawMessage, error) {
	c.next++
	data, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(rpcTimeout)
	if err = c.socket.SetWriteDeadline(deadline); err != nil {
		return nil, err
	}
	if err = c.send(message{ID: c.next, Method: method, Params: data}); err != nil {
		return nil, err
	}
	for {
		m, err := c.receive(deadline)
		if err != nil {
			return nil, err
		}
		if m.Method != "" {
			c.accept(m)
			continue
		}
		if m.ID != c.next {
			continue
		}
		if m.Error != nil {
			return nil, fmt.Errorf("%s rejected: %d", method, m.Error.Code)
		}
		if len(m.Result) == 0 {
			return nil, errors.New("missing gateway reply")
		}
		return m.Result, nil
	}
}

type subscriptionDenied int

func (d subscriptionDenied) Error() string { return fmt.Sprintf("subscription status %d", int(d)) }

func (c *Session) subscriptionCall(method string) error {
	result, err := c.request(method, c.sub)
	if err != nil {
		return err
	}
	var code struct{ Code *int }
	if json.Unmarshal(result, &code) != nil || code.Code == nil {
		return errors.New("missing subscription receipt")
	}
	if *code.Code != 0 {
		return subscriptionDenied(*code.Code)
	}
	return nil
}
func (c *Session) subscribe() error {
	c.sub = &subscription{"2.0", strconv.FormatUint(c.identity, 10), time.Now().Unix(), "."}
	err := c.subscriptionCall("miIO.sub")
	var denied subscriptionDenied
	if errors.As(err, &denied) {
		c.sub = nil
	}
	return err
}
func (c *Session) unsubscribe() error {
	if c.sub == nil {
		return nil
	}
	err := c.subscriptionCall("miIO.unsub")
	if err == nil {
		c.sub = nil
	}
	return err
}
func (c *Session) read(p Property) (json.RawMessage, error) {
	data, err := c.request("get_properties", []Property{p})
	if err != nil {
		return nil, err
	}
	row, err := propertyReceipt(p, data, false)
	return row.Value, err
}

type receipt struct {
	Property
	Code  *int
	Value json.RawMessage
}

func propertyReceipt(p Property, data json.RawMessage, write bool) (receipt, error) {
	var rows []receipt
	if json.Unmarshal(data, &rows) != nil || len(rows) != 1 || rows[0].Property != p || rows[0].Code == nil {
		return receipt{}, errors.New("property receipt mismatch")
	}
	r := rows[0]
	if *r.Code != 0 && (!write || *r.Code != 1) || !write && (len(r.Value) == 0 || string(r.Value) == "null") {
		return receipt{}, fmt.Errorf("device property status %d", *r.Code)
	}
	return r, nil
}
func (c *Session) write(p Property, value json.RawMessage) (int, error) {
	if p.DID != c.config.Light || p.SIID != 2 || !allowedLightValue(p.PIID, value) {
		return -1, errors.New("property outside enrolled light or value range")
	}
	data, err := c.request("set_properties", []Notification{{Property: p, Value: value}})
	if err != nil {
		return -1, err
	}
	row, err := propertyReceipt(p, data, true)
	if err != nil {
		return -1, err
	}
	return *row.Code, nil
}
func allowedLightValue(piid int, value json.RawMessage) bool {
	if piid == 1 {
		return string(value) == "true" || string(value) == "false"
	}
	var n int
	if json.Unmarshal(value, &n) != nil {
		return false
	}
	return piid == 2 && n >= 1 && n <= 100 || piid == 3 && n >= 2700 && n <= 6000
}
