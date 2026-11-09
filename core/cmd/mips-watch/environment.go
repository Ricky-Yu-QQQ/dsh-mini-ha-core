package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"time"
)

type environmentUnit struct {
	Device, Model, Gateway, Identity string
}

func runEnvironment(args []string) error {
	flags := flag.NewFlagSet("environment", flag.ContinueOnError)
	var units []environmentUnit
	seen := make(map[string]bool)
	flags.Func("unit", "owner-only air conditioner or purifier enrollment", func(path string) error {
		if len(units) >= 16 || !privateFile(path) {
			return errors.New("invalid room environment enrollment")
		}
		var unit environmentUnit
		if err := readJSON(path, &unit); err != nil {
			return err
		}
		switch unit.Model {
		case climateModel, "xiaomi.airp.va3", "xiaomi.airp.mp5":
		default:
			return errors.New("unsupported environment model")
		}
		if !motorDID.MatchString(unit.Device) || seen[unit.Device] ||
			!privateFile(unit.Gateway) || !privateFile(unit.Identity) ||
			(len(units) > 0 && (units[0].Gateway != unit.Gateway || units[0].Identity != unit.Identity)) {
			return errors.New("invalid room environment target")
		}
		seen[unit.Device] = true
		units = append(units, unit)
		return nil
	})
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(units) == 0 || flags.NArg() != 0 {
		return errors.New("no room environment targets")
	}
	return withMIPSClient(units[0].Gateway, units[0].Identity, func(ctx context.Context, client *powerClient) error {
		states := make(map[string]map[string]json.RawMessage, len(units))
		for _, unit := range units {
			if ctx.Err() != nil {
				break
			}
			state := make(map[string]json.RawMessage)
			read := func(name string, siid, piid int) {
				poll, cancel := context.WithTimeout(ctx, 350*time.Millisecond)
				defer cancel()
				if value, err := client.read(poll, powerProperty{unit.Device, siid, piid}); err == nil {
					state[name] = value
				}
			}
			if unit.Model == climateModel {
				read("room-temperature", 4, 7)
			} else {
				read("power", 2, 1)
				read("room-temperature", 3, 7)
				read("air-quality", 3, 3)
				read("pm25", 3, 4)
			}
			states[unit.Device] = state
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"phase": "environment-readback", "states": states})
	})
}
