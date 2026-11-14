package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestGatewayInventoryIncludesRoomsAndOmitsPrivateFields(t *testing.T) {
	rows, err := parseInventory([]byte(`{"devList":{"2":{"name":"开关","roomName":"客厅","roomId":"1","online":true},
	  "1":{"name":"灯","roomName":"卧室","roomId":"2","token":"private","online":true},"invalid/did":{}}}`))
	if err != nil || len(rows) != 2 || rows[0].DID != "1" || rows[0].RoomName != "卧室" || !rows[0].Online {
		t.Fatalf("bad inventory: %+v, %v", rows, err)
	}
	data, err := json.Marshal(rows)
	if err != nil || strings.Contains(string(data), "private") {
		t.Fatal("gateway credentials reached public device information")
	}
	for _, body := range []string{`{"devList":[]}`, `{"devList":null}`, `{}`} {
		if _, err := parseInventory([]byte(body)); err == nil {
			t.Fatal("accepted invalid inventory", body)
		}
	}
}
