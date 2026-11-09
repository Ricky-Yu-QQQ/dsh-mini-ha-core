package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"time"
)

// Both models publish 0 for vacant and 1 for occupied. Other values are unknown.
var occupancyProperties = map[string]int{
	"linp.sensor_occupy.hb01": 1,
	"linp.sensor_occupy.es4b": 1078,
}

func runPresence(args []string) error {
	flags := flag.NewFlagSet("presence", flag.ContinueOnError)
	path := flags.String("config", "", "owner-only presence enrollment")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || !privateFile(*path) {
		return errors.New("invalid presence request")
	}
	var config struct {
		Gateway, Identity string
		Sensors           []struct{ ID, Device, Model string }
	}
	if err := readJSON(*path, &config); err != nil {
		return err
	}
	if !privateFile(config.Gateway) || !privateFile(config.Identity) ||
		len(config.Sensors) == 0 || len(config.Sensors) > 16 {
		return errors.New("invalid presence enrollment")
	}
	states := make(map[string]*bool, len(config.Sensors))
	seen := make(map[string]bool, len(config.Sensors))
	for _, sensor := range config.Sensors {
		if !motorDID.MatchString(sensor.ID) || !motorDID.MatchString(sensor.Device) ||
			occupancyProperties[sensor.Model] == 0 || seen[sensor.Device] {
			return errors.New("invalid presence sensor binding")
		}
		if _, exists := states[sensor.ID]; exists {
			return errors.New("duplicate presence sensor")
		}
		seen[sensor.Device] = true
		states[sensor.ID] = nil
	}
	return withMIPSClient(config.Gateway, config.Identity, func(ctx context.Context, client *powerClient) error {
		for _, sensor := range config.Sensors {
			if ctx.Err() != nil {
				break
			}
			poll, cancel := context.WithTimeout(ctx, 520*time.Millisecond)
			raw, err := client.read(poll, powerProperty{sensor.Device, 2, occupancyProperties[sensor.Model]})
			cancel()
			if err == nil {
				states[sensor.ID] = occupancyState(raw)
			}
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"phase": "presence-readback", "states": states})
	})
}

func occupancyState(raw json.RawMessage) *bool {
	switch string(raw) {
	case "0":
		value := false
		return &value
	case "1":
		value := true
		return &value
	default:
		return nil
	}
}
