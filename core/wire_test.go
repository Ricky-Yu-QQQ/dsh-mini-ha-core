package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"net"
	"testing"
	"time"
)

var fixtureConfig = Config{Host: "127.0.0.1", ExpectedDid: 42, Token: "00112233445566778899aabbccddeeff", Light: "lamp"}

func TestCodecRejectsWrongKeyTruncationAndTampering(t *testing.T) {
	c, _ := newCodec(fixtureConfig)
	p, _ := c.encode(message{ID: 7, Result: json.RawMessage(`{"code":0}`)}, 99)
	got, err := c.decode(p)
	if err != nil || got.ID != 7 {
		t.Fatalf("valid packet rejected: %v", err)
	}
	for _, bad := range [][]byte{p[:len(p)-1], append(bytes.Clone(p[:16]), make([]byte, len(p)-16)...)} {
		if _, err := c.decode(bad); err == nil {
			t.Fatal("invalid packet accepted")
		}
	}
	other := fixtureConfig
	other.ExpectedDid++
	foreign, _ := newCodec(other)
	if _, err := foreign.decode(p); err == nil {
		t.Fatal("wrong gateway accepted")
	}
}

func TestWriteRequiresMatchingReceiptAndReadback(t *testing.T) {
	p := Property{"lamp", 2, 1}
	code := json.RawMessage(`[{"did":"lamp","siid":2,"piid":1,"code":1}]`)
	if _, err := propertyReceipt(p, code, true); err != nil {
		t.Fatal(err)
	}
	if _, err := propertyReceipt(p, code, false); err == nil {
		t.Fatal("write acknowledgement accepted as readback")
	}
	if _, err := propertyReceipt(Property{"other", 2, 1}, code, true); err == nil {
		t.Fatal("wrong device accepted")
	}
}

func TestPollFallbackRecoversSocketWithoutPhantomEdge(t *testing.T) {
	peer, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	c, _ := newCodec(fixtureConfig)
	done := make(chan struct{})
	defer func() { _ = peer.Close(); <-done }()
	go func() {
		defer close(done)
		var b [8192]byte
		reads := 0
		for {
			n, addr, err := peer.ReadFromUDP(b[:])
			if err != nil {
				return
			}
			if n == 32 {
				reply := make([]byte, 32)
				binary.BigEndian.PutUint16(reply, 0x2131)
				binary.BigEndian.PutUint16(reply[2:], 32)
				binary.BigEndian.PutUint64(reply[4:], 42)
				_, _ = peer.WriteToUDP(reply, addr)
				continue
			}
			m, err := c.decode(b[:n])
			if err != nil {
				continue
			}
			result := json.RawMessage(`{"code":0}`)
			if m.Method == "get_properties" {
				reads++
				if reads == 3 {
					continue
				}
				if reads == 2 {
					push, _ := c.encode(message{ID: 77, Method: "properties_changed", Params: json.RawMessage(`[{"did":"lamp","siid":2,"piid":1,"value":true}]`)}, 0)
					_, _ = peer.WriteToUDP(push, addr)
				}
				result = json.RawMessage(`[{"did":"lamp","siid":2,"piid":1,"code":0,"value":false}]`)
				if reads == 2 {
					result = json.RawMessage(`[{"did":"lamp","siid":2,"piid":1,"code":0,"value":true}]`)
				}
			}
			frame, _ := c.encode(message{ID: m.ID, Result: result}, 0)
			_, _ = peer.WriteToUDP(frame, addr)
		}
	}()
	var gaps, edges int
	var edgeSource any
	r := runner{config: fixtureConfig, endpoint: peer.LocalAddr().(*net.UDPAddr), id: 7, log: func(phase string, fields map[string]any) error {
		if phase == "gap" {
			gaps++
		}
		if phase == "property-change" {
			edges++
			edgeSource = fields["source"]
		}
		return nil
	}}
	if err = r.connect(true); err != nil {
		t.Fatal(err)
	}
	defer r.close()
	if err = r.watch(Property{"lamp", 2, 1}, 4*time.Second, nil); err != nil {
		t.Fatal(err)
	}
	if gaps != 1 || r.generation != 2 || edges != 1 || edgeSource != "push" {
		t.Fatalf("unexpected gaps=%d generations=%d edges=%d", gaps, r.generation, edges)
	}
}

func TestPushAndPollOfSameChangeCountOnce(t *testing.T) {
	p := Property{"lamp", 2, 1}
	tracker := newTracker()
	if _, changed := tracker.observe(p, json.RawMessage("false")); changed {
		t.Fatal("snapshot counted")
	}
	if _, changed := tracker.observe(p, json.RawMessage("true")); !changed {
		t.Fatal("push change lost")
	}
	if _, changed := tracker.observe(p, json.RawMessage("true")); changed {
		t.Fatal("duplicate poll edge")
	}
}
