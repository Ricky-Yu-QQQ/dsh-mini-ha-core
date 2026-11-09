package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"strconv"
)

const bedModel = "mlily.bed.001"

type bedField struct {
	name             string
	siid, piid       int
	minimum, maximum int
}

// MLily 001 properties exposed by the published MIoT instance.
var bedFields = []bedField{
	{"mode", 2, 4, 0, 13},
	{"lumbar", 2, 6, 0, 100},
	{"backrest", 3, 1, 0, 60},
	{"legrest", 4, 1, 0, 40},
	{"back-massage", 7, 1, 0, 3},
	{"leg-massage", 7, 2, 0, 3},
	{"massage-pattern", 7, 3, 1, 3},
	{"massage-timer", 7, 4, 1, 3},
}

func (field bedField) decode(raw json.RawMessage) (int, bool) {
	var value *int
	if json.Unmarshal(raw, &value) != nil || value == nil || *value < field.minimum || *value > field.maximum {
		return 0, false
	}
	return *value, true
}

func bedLocked(raw json.RawMessage) (bool, bool) {
	switch string(raw) {
	case "false", "0":
		return false, true
	case "true", "1":
		return true, true
	default:
		return false, false
	}
}

// A single request avoids spending the connection deadline on separate BLE
// queries. The gateway can leave individual fields out of the batch.
func readBedProperties(ctx context.Context, client *powerClient, device string, properties []powerProperty) map[powerProperty]json.RawMessage {
	values := make(map[powerProperty]json.RawMessage)
	rpcID := client.mid + 1
	data, err := client.request(ctx, "proxy/rpcReq", map[string]any{
		"did": device, "rpc": map[string]any{"id": rpcID, "method": "get_properties", "params": properties},
	})
	if err == nil {
		var receipt struct {
			ID     *uint32
			Result []struct {
				powerProperty
				Code  *int
				Value json.RawMessage
			}
		}
		if json.Unmarshal(data, &receipt) == nil && (receipt.ID == nil || *receipt.ID == rpcID) {
			for _, row := range receipt.Result {
				if row.DID == device && row.Code != nil && *row.Code == 0 && row.Value != nil {
					values[row.powerProperty] = row.Value
				}
			}
		}
	}
	for _, property := range properties {
		if ctx.Err() != nil {
			break
		}
		if _, ok := values[property]; !ok {
			if raw, err := client.read(ctx, property); err == nil {
				values[property] = raw
			}
		}
	}
	return values
}

func runBed(args []string) error {
	flags := flag.NewFlagSet("bed", flag.ContinueOnError)
	path := flags.String("config", "", "owner-only bed enrollment")
	device := flags.String("expected-device", "", "enrolled device DID")
	field := flags.String("field", "", "empty reads bed state")
	value := flags.String("value", "", "one requested bed property value")
	apply := flags.Bool("apply", false, "authorize one bed write")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || !privateFile(*path) || (*field != "") != *apply || (*value != "") != *apply {
		return errors.New("invalid enrolled bed request")
	}
	var config struct{ Device, Model, Gateway, Identity string }
	if err := readJSON(*path, &config); err != nil {
		return err
	}
	if config.Device != *device || config.Model != bedModel || !motorDID.MatchString(config.Device) ||
		!privateFile(config.Gateway) || !privateFile(config.Identity) {
		return errors.New("bed target did not match private enrollment")
	}
	var target bedField
	var wanted int
	if *apply {
		for _, candidate := range bedFields {
			if candidate.name == *field {
				target = candidate
				break
			}
		}
		var err error
		wanted, err = strconv.Atoi(*value)
		if target.name == "" || err != nil || wanted < target.minimum || wanted > target.maximum {
			return errors.New("unsupported bed property or value")
		}
	}
	return withMIPSClient(config.Gateway, config.Identity, func(ctx context.Context, client *powerClient) error {
		out := json.NewEncoder(os.Stdout)
		faultProperty, lockProperty := powerProperty{*device, 2, 1}, powerProperty{*device, 5, 1}
		fields := bedFields
		if *apply {
			fields = []bedField{target}
		}
		properties := []powerProperty{faultProperty, lockProperty}
		for _, field := range fields {
			properties = append(properties, powerProperty{*device, field.siid, field.piid})
		}
		values := readBedProperties(ctx, client, *device, properties)
		fault, knownFault := (bedField{"fault", 2, 1, 0, 255}).decode(values[faultProperty])
		locked, knownLock := bedLocked(values[lockProperty])
		if *apply {
			if !knownFault || !knownLock {
				return errors.New("bed protection state unavailable")
			}
			if fault != 0 || locked {
				reason := "fault"
				if locked {
					reason = "locked"
				}
				return out.Encode(map[string]any{"phase": "bed-blocked", "reason": reason})
			}
			property := powerProperty{*device, target.siid, target.piid}
			before, known := target.decode(values[property])
			if !known {
				return errors.New("bed property state unavailable")
			}
			code := 0
			if before != wanted {
				var err error
				code, err = client.write(ctx, property,
					json.RawMessage(strconv.Itoa(wanted)))
				if err != nil {
					return err
				}
			}
			return out.Encode(map[string]any{"phase": "bed-ack", "field": *field,
				"siid": target.siid, "piid": target.piid, "value": wanted, "code": code})
		}
		state := make(map[string]any)
		for _, field := range bedFields {
			if value, ok := field.decode(values[powerProperty{*device, field.siid, field.piid}]); ok {
				state[field.name] = value
			}
		}
		if len(state) == 0 {
			return errors.New("no verified bed readback")
		}
		if knownFault {
			state["fault"] = fault
		}
		if knownLock {
			state["locked"] = locked
		}
		return out.Encode(map[string]any{"phase": "readback", "state": state})
	})
}
