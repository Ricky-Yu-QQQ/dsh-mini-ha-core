package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"regexp"
	"strconv"
)

var motorDID = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,64}$`)

type motorProfile struct {
	command, status, fault, position int
	start, end                       string
}

// The write-only command and the independent readback are defined by MIoT
// service 2 on the enrolled airer and curtain models.
var motorProfiles = map[string]motorProfile{
	"airer":   {command: 2, status: 6, fault: 1, start: "raise", end: "lower"},
	"curtain": {command: 1, status: 2, fault: 9, position: 3, start: "open", end: "close"},
}

func runMotor(args []string) error {
	flags := flag.NewFlagSet("motor", flag.ContinueOnError)
	path := flags.String("config", "", "owner-only motor enrollment")
	device := flags.String("expected-device", "", "enrolled device DID")
	kind := flags.String("expected-motor", "", "enrolled motor profile")
	action := flags.String("action", "", "empty reads state")
	position := flags.String("position", "", "curtain target opening from 0 to 100")
	apply := flags.Bool("apply", false, "authorize one motor command")
	if err := flags.Parse(args); err != nil {
		return err
	}
	profile, known := motorProfiles[*kind]
	if flags.NArg() != 0 || !known || !privateFile(*path) ||
		(*action != "" || *position != "") != *apply ||
		*action != "" && *position != "" {
		return errors.New("invalid enrolled motor request")
	}
	var config struct{ Device, Motor, Gateway, Identity string }
	if err := readJSON(*path, &config); err != nil {
		return err
	}
	if config.Device != *device || config.Motor != *kind ||
		!motorDID.MatchString(config.Device) ||
		!privateFile(config.Gateway) || !privateFile(config.Identity) {
		return errors.New("motor target did not match private enrollment")
	}
	var command int
	switch *action {
	case "", "stop":
	case profile.start:
		command = 1
	case profile.end:
		command = 2
	default:
		return errors.New("unsupported motor command")
	}
	piid := profile.command
	if *position != "" {
		var err error
		command, err = strconv.Atoi(*position)
		if *kind != "curtain" || err != nil || command < 0 || command > 100 {
			return errors.New("invalid curtain target position")
		}
		piid = 4
	}
	return withMIPSClient(config.Gateway, config.Identity, func(ctx context.Context, client *powerClient) error {
		read := func(piid int, max int) (int, error) {
			raw, err := client.read(ctx, powerProperty{config.Device, 2, piid})
			if err != nil {
				return 0, err
			}
			var value *int
			if json.Unmarshal(raw, &value) != nil || value == nil || *value < 0 || *value > max {
				return 0, errors.New("invalid motor readback")
			}
			return *value, nil
		}
		out := json.NewEncoder(os.Stdout)
		if !*apply {
			status, err := read(profile.status, 2)
			if err != nil {
				return err
			}
			fault, err := read(profile.fault, 1)
			if err != nil {
				return err
			}
			row := map[string]any{"phase": "readback", "motion": status, "fault": fault}
			if profile.position != 0 {
				position, err := read(profile.position, 100)
				if err != nil {
					return err
				}
				row["position"] = position
			}
			return out.Encode(row)
		}
		// A fault blocks movement. Stop remains available even when state is stale.
		if *action != "stop" {
			fault, err := read(profile.fault, 1)
			if err != nil {
				return err
			}
			if fault != 0 {
				return out.Encode(map[string]any{"phase": "motor-fault"})
			}
		}
		target := powerProperty{config.Device, 2, piid}
		code, err := client.write(ctx, target, json.RawMessage(strconv.Itoa(command)))
		if err != nil {
			return err
		}
		row := map[string]any{"phase": "motor-ack", "siid": 2, "piid": piid, "code": code}
		if *position != "" {
			row["target"] = command
		} else {
			row["action"] = *action
		}
		return out.Encode(row)
	})
}
