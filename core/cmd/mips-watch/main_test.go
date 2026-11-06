package main

import (
	"encoding/binary"
	"testing"
)

func TestParseMIPSEvent(t *testing.T) {
	const prefix = "10/appMsg/notify/iot/blt.test/event/"
	payload := []byte(`{"did":"blt.test","siid":6,"eiid":1,"arguments":[]}` + "\x00")
	frame := append(binary.LittleEndian.AppendUint32(nil, uint32(len(payload))), 2)
	frame = append(frame, payload...)
	got, err := parseNotification(prefix+"6.1", frame, "10", "blt.test", "event")
	if err != nil || got.SIID != 6 || got.EIID != 1 {
		t.Fatalf("parse click: %+v, %v", got, err)
	}
	for _, bad := range []struct {
		topic string
		frame []byte
	}{
		{prefix + "6.2", frame},
		{prefix + "6.1", frame[:len(frame)-1]},
		{prefix + "6.1", payload},
	} {
		if _, err := parseNotification(bad.topic, bad.frame, "10", "blt.test", "event"); err == nil {
			t.Fatalf("accepted invalid event on %s", bad.topic)
		}
	}
}

func TestParseMIPSProperty(t *testing.T) {
	const topic = "10/appMsg/notify/iot/light/property/2.1"
	frame := func(json string) []byte {
		payload := []byte(json + "\x00")
		return append(append(binary.LittleEndian.AppendUint32(nil, uint32(len(payload))), 2), payload...)
	}
	got, err := parseNotification(topic, frame(`{"did":"light","siid":2,"piid":1,"value":false}`), "10", "light", "property")
	if err != nil || got.PIID != 1 || string(got.Value) != "false" {
		t.Fatalf("parse power off: %+v, %v", got, err)
	}
	if _, err := parseNotification(topic, frame(`{"did":"light","siid":2,"piid":1}`), "10", "light", "property"); err == nil {
		t.Fatal("accepted a property notification without a value")
	}
}
