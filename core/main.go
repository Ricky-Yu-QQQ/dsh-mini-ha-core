package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type Log func(string, map[string]any) error

type Tracker struct {
	values map[Property]json.RawMessage
}

func newTracker() *Tracker { return &Tracker{make(map[Property]json.RawMessage)} }

// A first sample is a baseline, including the first sample after any gap.
func (t *Tracker) observe(p Property, value json.RawMessage) (json.RawMessage, bool) {
	old, known := t.values[p]
	t.values[p] = bytes.Clone(value)
	return old, known && !bytes.Equal(old, value)
}

type runner struct {
	endpoint   *net.UDPAddr
	config     Config
	id         uint64
	session    *Session
	generation int
	log        Log
	tracker    *Tracker
}

func (r *runner) connect(subscribe bool) error {
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		endpoint := r.endpoint
		if endpoint == nil {
			endpoint = &net.UDPAddr{IP: net.ParseIP(r.config.Host), Port: 54321}
		}
		r.session, err = open(r.config, endpoint, r.id)
		if err == nil {
			break
		}
		time.Sleep(time.Duration(attempt+1) * 100 * time.Millisecond)
	}
	if err != nil {
		return err
	}
	r.generation++
	r.tracker = newTracker()
	port := r.session.socket.LocalAddr().(*net.UDPAddr).Port
	if err = r.log("connected", map[string]any{"generation": r.generation, "port": port, "advertisesPush": r.session.advertised}); err != nil {
		return err
	}
	if subscribe {
		err = r.session.subscribe()
		fields := map[string]any{"accepted": err == nil}
		if err != nil {
			fields["error"] = err.Error()
		}
		return r.log("subscription", fields)
	}
	return nil
}
func (r *runner) close() error {
	if r.session == nil {
		return nil
	}
	c := r.session
	r.session = nil
	defer c.socket.Close()
	if c.sub == nil {
		return nil
	}
	err := c.unsubscribe()
	result := map[string]any{"confirmed": err == nil}
	if err != nil {
		result["error"] = err.Error()
	}
	return errors.Join(err, r.log("unsubscription", result))
}
func (r *runner) report(p Property, value json.RawMessage, source string) error {
	old, changed := r.tracker.observe(p, value)
	if !changed {
		return nil
	}
	name := "occupancy"
	if p.DID == r.config.Light {
		name = map[int]string{1: "power", 2: "brightness", 3: "kelvin"}[p.PIID]
	}
	return r.log("property-change", map[string]any{
		"property": name, "source": source, "old": old, "new": value, "generation": r.generation})
}
func (r *runner) drain() error {
	for _, n := range r.session.pushed {
		if n.EIID > 0 {
			if err := r.log("device-event", map[string]any{"source": "push", "siid": n.SIID,
				"eiid": n.EIID, "generation": r.generation}); err != nil {
				return err
			}
			continue
		}
		if !r.watched(n.Property) || !validObservation(n.Value) {
			continue
		}
		if err := r.report(n.Property, n.Value, "push"); err != nil {
			return err
		}
	}
	r.session.pushed = r.session.pushed[:0]
	return nil
}
func validObservation(v json.RawMessage) bool {
	return len(v) > 0 && string(v) != "null" && json.Valid(v)
}
func (r *runner) watched(p Property) bool {
	return p.SIID == 2 && (p.DID == r.config.Light && p.PIID >= 1 && p.PIID <= 3 ||
		r.config.Presence != "" && p.DID == r.config.Presence && p.PIID == r.config.PresencePiid)
}
func (r *runner) sample(p Property) (json.RawMessage, error) {
	value, err := r.session.read(p)
	if err != nil {
		return nil, err
	}
	if err = r.drain(); err != nil {
		return nil, err
	}
	return value, r.report(p, value, "poll")
}
func (r *runner) watch(p Property, duration time.Duration, stop <-chan os.Signal) error {
	deadline := time.Now().Add(duration)
	for time.Now().Before(deadline) {
		select {
		case <-stop:
			return nil
		default:
		}
		if _, err := r.sample(p); err != nil {
			if err = r.log("gap", map[string]any{"generation": r.generation}); err != nil {
				return err
			}
			_ = r.close()
			if err = r.connect(true); err != nil {
				return err
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	return r.log("watch-summary", map[string]any{"authenticatedPushFrames": r.session.pushFrames})
}
func (r *runner) await(p Property, target string, duration time.Duration) error {
	deadline := time.Now().Add(duration)
	for {
		v, err := r.sample(p)
		if err != nil {
			return err
		}
		if string(v) == target {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("readback did not converge")
		}
		time.Sleep(150 * time.Millisecond)
	}
}
func (r *runner) update(p Property, value string) error {
	if err := r.log("write-intent", map[string]any{"piid": p.PIID, "value": json.RawMessage(value), "previous": r.tracker.values[p]}); err != nil {
		return err
	}
	ack, err := r.session.write(p, json.RawMessage(value))
	if err != nil {
		return errors.Join(err, r.log("write-unconfirmed", map[string]any{"piid": p.PIID}))
	}
	if err = r.log("write-ack", map[string]any{"piid": p.PIID, "code": ack}); err != nil {
		return err
	}
	if err = r.await(p, value, 3*time.Second); err != nil {
		return err
	}
	return r.log("write-confirmed", map[string]any{"piid": p.PIID, "value": json.RawMessage(value), "code": ack})
}
func (r *runner) powerProbe(stop <-chan os.Signal) (result error) {
	p := Property{r.config.Light, 2, 1}
	original, err := r.sample(p)
	if err != nil {
		return err
	}
	if string(original) != "false" {
		return errors.New("enrolled test light must start off")
	}
	// Restore only this enrolled property. A timed-out write may still settle.
	defer func() {
		restore := func() error {
			var current json.RawMessage
			deadline := time.Now().Add(3 * time.Second)
			for {
				var err error
				if r.session != nil {
					current, err = r.sample(p)
				}
				if r.session == nil || err != nil {
					_ = r.close()
					if err = r.connect(true); err != nil {
						return err
					}
					current, err = r.sample(p)
					if err != nil {
						return err
					}
				}
				if string(current) == "true" {
					// The original off state is already in the durable probe log.
					// A later logging failure must not suppress restoration.
					ack, writeErr := r.session.write(p, json.RawMessage("false"))
					readErr := r.await(p, "false", 3*time.Second)
					logErr := r.log("restore-receipt", map[string]any{"code": ack, "confirmed": readErr == nil})
					if err = errors.Join(writeErr, readErr, logErr); err != nil {
						return err
					}
					break
				}
				if string(current) != "false" {
					return errors.New("unrecognized light power")
				}
				if time.Now().After(deadline) {
					break
				}
				time.Sleep(200 * time.Millisecond)
			}
			time.Sleep(1200 * time.Millisecond)
			value, err := r.sample(p)
			if err != nil {
				return err
			}
			if string(value) != "false" {
				return errors.New("light power changed after restore")
			}
			return r.log("restored", map[string]any{"power": false, "generation": r.generation,
				"authenticatedPushFrames": r.session.pushFrames})
		}()
		result = errors.Join(result, restore)
	}()
	select {
	case <-stop:
		return errors.New("test interrupted")
	default:
	}
	if err = r.update(p, "true"); err != nil {
		return err
	}
	// Allow the real gateway to forward any unsolicited power notification.
	timer := time.NewTimer(850 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-stop:
		return errors.New("test interrupted")
	case <-timer.C:
	}
	if _, err = r.sample(p); err != nil {
		return err
	}
	if err = r.log("push-window", map[string]any{"authenticatedPushFrames": r.session.pushFrames}); err != nil {
		return err
	}
	if err = r.close(); err != nil {
		return err
	}
	start := time.Now()
	if err = r.connect(true); err != nil {
		return err
	}
	power, err := r.sample(p)
	if err != nil {
		return err
	}
	if string(power) != "true" {
		return errors.New("test light changed across reconnect")
	}
	return r.log("reconnected", map[string]any{"elapsedMs": time.Since(start).Milliseconds(), "power": true})
}

func run() (result error) {
	if len(os.Args) > 1 && (os.Args[1] == "compile" || os.Args[1] == "plan") {
		return runRules(os.Args[1:])
	}
	configFile := flag.String("config", "", "owner-only local configuration")
	journalFile := flag.String("journal", "", "new JSONL log under .local")
	expectedLight := flag.String("expected-light", "", "require the enrolled light DID to match")
	mode := flag.String("mode", "read", "read, watch, set, or power-demo")
	field := flag.String("property", "", "set: power, brightness or kelvin")
	value := flag.String("value", "", "set: JSON value")
	duration := flag.Duration("duration", 10*time.Second, "watch duration, at most two minutes")
	apply := flag.Bool("apply", false, "authorize a write for the selected light")
	flag.Parse()
	if *configFile == "" || *journalFile == "" {
		return errors.New("config and journal are required")
	}
	if *journalFile == "-" {
		if (*mode != "read" && *mode != "set") || *expectedLight == "" {
			return errors.New("stdout requires read or set and -expected-light")
		}
	} else if !strings.Contains(filepath.Clean("/"+*journalFile), "/.local/") {
		return errors.New("private journal must be under .local")
	}
	if (*mode == "set" || *mode == "power-demo") && !*apply {
		return errors.New("writes require -apply")
	}
	config, err := loadConfig(*configFile)
	if err != nil {
		return err
	}
	if *expectedLight != "" && config.Light != *expectedLight {
		return errors.New("enrolled light does not match")
	}
	id, err := newID()
	if err != nil {
		return err
	}
	journal := os.Stdout
	if *journalFile != "-" {
		journal, err = os.OpenFile(*journalFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return err
		}
		defer journal.Close()
	}
	enc := json.NewEncoder(journal)
	r := runner{config: config, id: id, log: func(phase string, fields map[string]any) error {
		fields["phase"] = phase
		fields["at"] = time.Now().Format(time.RFC3339Nano)
		if err := enc.Encode(fields); err != nil {
			return err
		}
		if journal != os.Stdout {
			return journal.Sync()
		}
		return nil
	}}
	defer func() { result = errors.Join(result, r.close()) }()
	if err = r.connect(*mode == "watch" || *mode == "power-demo"); err != nil {
		return err
	}
	switch *mode {
	case "read":
		fields := map[string]any{}
		for i, name := range []string{"power", "brightness", "kelvin"} {
			v, err := r.sample(Property{config.Light, 2, i + 1})
			if err != nil {
				return err
			}
			fields[name] = v
		}
		return r.log("readback", fields)
	case "watch":
		if *duration <= 0 || *duration > 2*time.Minute {
			return errors.New("invalid watch duration")
		}
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
		defer signal.Stop(stop)
		p := Property{config.Light, 2, 1}
		switch *field {
		case "", "power":
		case "brightness":
			p.PIID = 2
		case "kelvin":
			p.PIID = 3
		case "occupancy":
			p = Property{config.Presence, 2, config.PresencePiid}
		default:
			return errors.New("unknown watch property")
		}
		if p.DID == "" {
			return errors.New("watch property not enrolled")
		}
		return r.watch(p, *duration, stop)
	case "set":
		piid := map[string]int{"power": 1, "brightness": 2, "kelvin": 3}[*field]
		if !allowedLightValue(piid, json.RawMessage(*value)) {
			return errors.New("invalid light value")
		}
		p := Property{config.Light, 2, piid}
		if _, err := r.sample(p); err != nil {
			return err
		}
		return r.update(p, *value)
	case "power-demo":
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
		defer signal.Stop(stop)
		return r.powerProbe(stop)
	default:
		return errors.New("unknown mode")
	}
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
