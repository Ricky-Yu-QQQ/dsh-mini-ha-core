package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"time"
)

const climateModel = "yj1226.airc.air"

// MIoT properties of the air conditioner itself (yj1226-air).
var climateProperties = []struct {
	name       string
	siid, piid int
}{
	{"power", 2, 1},
	{"mode", 2, 2},
	{"temperature", 2, 3},
	{"fan-speed", 5, 2},
	{"room-temperature", 4, 7},
}

func validClimateValue(field string, raw json.RawMessage) bool {
	if field == "power" {
		return string(raw) == "true" || string(raw) == "false"
	}
	var value *int
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return false
	}
	switch field {
	case "mode":
		return *value == 1 || *value == 2 || *value == 4 || *value == 8
	case "temperature":
		return *value >= 16 && *value <= 32
	case "fan-speed":
		return *value == 0 || *value == 1 || *value == 3 || *value == 5
	case "room-temperature":
		return *value >= -30 && *value <= 100
	default:
		return false
	}
}

func runClimate(args []string) error {
	flags := flag.NewFlagSet("climate", flag.ContinueOnError)
	path := flags.String("config", "", "owner-only air conditioner enrollment")
	device := flags.String("expected-device", "", "enrolled air conditioner DID")
	field := flags.String("field", "", "empty reads air conditioner state")
	value := flags.String("value", "", "one requested air conditioner property value")
	apply := flags.Bool("apply", false, "authorize one air conditioner write")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || !privateFile(*path) || (*field != "") != *apply || (*value != "") != *apply {
		return errors.New("invalid air conditioner request")
	}
	var config struct{ Device, Model, Gateway, Identity string }
	if err := readJSON(*path, &config); err != nil {
		return err
	}
	if config.Device != *device || config.Model != climateModel || !motorDID.MatchString(config.Device) ||
		!privateFile(config.Gateway) || !privateFile(config.Identity) {
		return errors.New("air conditioner target did not match private enrollment")
	}
	var target powerProperty
	wanted := json.RawMessage(*value)
	if *apply {
		for _, property := range climateProperties {
			if property.name == *field && *field != "room-temperature" {
				target = powerProperty{config.Device, property.siid, property.piid}
				break
			}
		}
		if target.DID == "" || !validClimateValue(*field, wanted) {
			return errors.New("unsupported air conditioner property or value")
		}
	}
	return withMIPSClient(config.Gateway, config.Identity, func(ctx context.Context, client *powerClient) error {
		out := json.NewEncoder(os.Stdout)
		state := make(map[string]json.RawMessage)
		response := map[string]any{"phase": "climate-readback", "state": state}
		if *apply {
			before, err := client.read(ctx, target)
			if err != nil || !validClimateValue(*field, before) {
				return errors.New("air conditioner property state unavailable")
			}
			code := 0
			if !bytes.Equal(before, wanted) {
				code, err = client.write(ctx, target, wanted)
				if err != nil {
					return err
				}
				verify, cancel := context.WithTimeout(ctx, 3*time.Second)
				defer cancel()
				for {
					actual, err := client.read(verify, target)
					if err != nil {
						return err
					}
					if bytes.Equal(actual, wanted) {
						break
					}
					time.Sleep(150 * time.Millisecond)
				}
			}
			state[*field] = wanted
			response["phase"] = "climate-confirmed"
			response["field"] = *field
			response["siid"] = target.SIID
			response["piid"] = target.PIID
			response["code"] = code
		}
		for _, property := range climateProperties {
			if ctx.Err() != nil || state[property.name] != nil {
				continue
			}
			poll, cancel := context.WithTimeout(ctx, 600*time.Millisecond)
			raw, err := client.read(poll, powerProperty{config.Device, property.siid, property.piid})
			cancel()
			if err == nil && validClimateValue(property.name, raw) {
				state[property.name] = raw
			}
		}
		if !*apply && state["power"] == nil {
			return errors.New("air conditioner power state unavailable")
		}
		return out.Encode(response)
	})
}
