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

func TestEnrolledSwitchRejectsOtherRelayChannels(t *testing.T) {
	config := fixtureConfig
	config.Light = ""
	config.Device = "panel"
	config.Power = &PowerBinding{SIID: 15, PIID: 1}
	session := Session{config: config}
	if !config.allowsWrite(Property{"panel", 15, 1}, json.RawMessage("true")) {
		t.Fatal("enrolled channel rejected")
	}
	for _, p := range []Property{{"panel", 14, 1}, {"panel", 15, 2}, {"other", 15, 1}} {
		if _, err := session.write(p, json.RawMessage("true")); err == nil {
			t.Fatalf("unregistered property accepted: %+v", p)
		}
	}
	if _, err := session.write(Property{"panel", 15, 1}, json.RawMessage("1")); err == nil {
		t.Fatal("numeric power value accepted")
	}
}

func TestColorTemperatureCeilingAppliesOnlyToEnrolledLight(t *testing.T) {
	config := fixtureConfig
	target := Property{"lamp", 2, 3}
	if config.allowsWrite(target, json.RawMessage("6500")) {
		t.Fatal("default light must retain its original ceiling")
	}
	config.KelvinMax = 6500
	if !config.allowsWrite(target, json.RawMessage("6500")) ||
		config.allowsWrite(target, json.RawMessage("6501")) ||
		config.allowsWrite(Property{"another-light", 2, 3}, json.RawMessage("6500")) {
		t.Fatal("extended ceiling must apply only to the enrolled light")
	}
}

func TestNativeBrightnessRangeAppliesOnlyToEnrolledLight(t *testing.T) {
	config := fixtureConfig
	target := Property{"lamp", 2, 2}
	if config.allowsWrite(target, json.RawMessage("65535")) {
		t.Fatal("standard light must keep the original brightness range")
	}
	config.BrightnessMax = 65535
	if !config.allowsWrite(target, json.RawMessage("65535")) ||
		config.allowsWrite(target, json.RawMessage("65536")) ||
		config.allowsWrite(Property{"another-light", 2, 2}, json.RawMessage("65535")) {
		t.Fatal("native brightness range must apply only to the enrolled light")
	}
}

func TestDirectWifiLightRejectsModeAndOutOfRangeWrites(t *testing.T) {
	c := Config{Light: "12345", LightProfile: ftdWifiLight}
	for _, tc := range []struct {
		piid  int
		value string
		allow bool
	}{
		{1, "false", true}, {2, "1", false}, {3, "100", true}, {3, "101", false},
		{4, "2999", false}, {4, "3000", true}, {4, "6500", true}, {4, "6501", false},
		{5, "true", false},
	} {
		if got := c.allowsWrite(Property{c.Light, 2, tc.piid}, json.RawMessage(tc.value)); got != tc.allow {
			t.Errorf("property 2/%d = %s: allow = %v", tc.piid, tc.value, got)
		}
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
