package main

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"time"

	"github.com/eclipse/paho.golang/paho"
)

type inventoryDevice struct {
	DID      string `json:"did"`
	Name     string `json:"name"`
	Model    string `json:"model"`
	URN      string `json:"urn"`
	RoomID   string `json:"roomId"`
	RoomName string `json:"roomName"`
	Online   bool   `json:"online"`
}

func parseInventory(body []byte) ([]inventoryDevice, error) {
	var response struct {
		Devices map[string]inventoryDevice `json:"devList"`
	}
	if len(body) > 2<<20 || json.Unmarshal(body, &response) != nil || response.Devices == nil || len(response.Devices) > 1024 {
		return nil, errors.New("invalid gateway inventory")
	}
	devices := make([]inventoryDevice, 0, len(response.Devices))
	for did, device := range response.Devices {
		if !motorDID.MatchString(did) || len(device.Name) > 320 || len(device.Model) > 200 || len(device.URN) > 320 ||
			len(device.RoomID) > 120 || len(device.RoomName) > 320 {
			continue
		}
		device.DID = did
		devices = append(devices, device)
	}
	sort.Slice(devices, func(i, j int) bool { return devices[i].DID < devices[j].DID })
	return devices, nil
}

func newInventoryClient(client *paho.Client, messages <-chan *paho.Publish, did string) (*powerClient, error) {
	var seed [4]byte
	if _, err := rand.Read(seed[:]); err != nil {
		return nil, err
	}
	return &powerClient{client: client, messages: messages, reply: did + "/reply", mid: binary.LittleEndian.Uint32(seed[:])}, nil
}

func reportInventory(ctx context.Context, scan *powerClient, writer io.Writer, changed <-chan struct{}) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	out := json.NewEncoder(writer)
	for ctx.Err() == nil {
		body, err := scan.request(ctx, "proxy/getDevList", struct{}{})
		devices, parseErr := parseInventory(body)
		row := map[string]any{"phase": "inventory-error", "source": "local-mips"}
		if err == nil && parseErr == nil {
			row["phase"], row["devices"] = "inventory", devices
		}
		if ctx.Err() != nil || out.Encode(row) != nil {
			return
		}
		select {
		case <-ticker.C:
		case <-changed:
			// Notifications during a scan coalesce into one refresh.
		case <-ctx.Done():
		}
	}
}
