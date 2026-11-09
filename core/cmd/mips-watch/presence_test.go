package main

import (
	"encoding/json"
	"testing"
)

func TestOccupancyState(t *testing.T) {
	for raw, expected := range map[string]bool{"0": false, "1": true} {
		if state := occupancyState(json.RawMessage(raw)); state == nil || *state != expected {
			t.Fatalf("unexpected presence state for %s: %v", raw, state)
		}
	}
	for _, raw := range []string{"2", "3", "null", `"0"`, "true", ""} {
		if occupancyState(json.RawMessage(raw)) != nil {
			t.Fatalf("unexpected presence state for %q", raw)
		}
	}
}
