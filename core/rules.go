package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type nativeTrigger struct {
	ID        string
	Kind      string `json:"trigger"`
	Entity    string `json:"entity_id"`
	To        *string
	Above     *float64
	EventType string            `json:"event_type"`
	EventData map[string]string `json:"event_data"`
}
type nativeCondition struct {
	Kind       string `json:"condition"`
	ID         string
	Entity     string `json:"entity_id"`
	State      string
	Conditions []nativeCondition
	After      string
	Before     string
	Template   string `json:"value_template"`
}
type nativeBranch struct {
	Conditions []nativeCondition
	Sequence   []nativeAction
}
type nativeAction struct {
	Alias  string
	Action string
	Target struct {
		Entity string `json:"entity_id"`
	}
	Data     map[string]json.RawMessage
	If       []nativeCondition
	Then     []nativeAction
	Else     []nativeAction
	Parallel []nativeBranch
	Choose   []nativeBranch
	Delay    *struct{ Seconds float64 }
	Stop     *string
}
type nativeRule struct {
	ID          string
	Alias       string
	Description string
	Initial     bool `json:"initial_state"`
	Mode        string
	Max         int
	Triggers    []nativeTrigger
	Conditions  []nativeCondition
	Actions     []nativeAction
	Trace       json.RawMessage
}
type sourceRules struct {
	Version     int
	SourceHash  string `json:"source_sha256"`
	Automations []nativeRule
	Helpers     []json.RawMessage
	Bindings    json.RawMessage
	Entities    []string
	AllDisabled bool `json:"all_disabled"`
}

// Compact typed records contain only trigger and action semantics, not HA metadata.
type term struct {
	Op        string            `json:"op"`
	Key       int               `json:"k,omitempty"`
	Text      string            `json:"s,omitempty"`
	End       string            `json:"end,omitempty"`
	Compare   string            `json:"cmp,omitempty"`
	Threshold float64           `json:"n,omitempty"`
	Data      map[string]string `json:"data,omitempty"`
	Or        []term            `json:"or,omitempty"`
}
type instruction struct {
	Op       string                     `json:"op"`
	Key      int                        `json:"k,omitempty"`
	Service  string                     `json:"service,omitempty"`
	Data     map[string]json.RawMessage `json:"data,omitempty"`
	If       []term                     `json:"if,omitempty"`
	Then     []instruction              `json:"then,omitempty"`
	Else     []instruction              `json:"else,omitempty"`
	Parallel [][]instruction            `json:"par,omitempty"`
	Seconds  float64                    `json:"sec,omitempty"`
}
type branch struct {
	Trigger    term          `json:"trigger"`
	Conditions []term        `json:"when,omitempty"`
	Sequence   []instruction `json:"do"`
}
type rule struct {
	ID       string   `json:"id"`
	Title    string   `json:"name"`
	Max      int      `json:"max"`
	Branches []branch `json:"branches"`
}
type Program struct {
	Version  int               `json:"version"`
	Enabled  bool              `json:"enabled"`
	Entities []string          `json:"entities"`
	Helpers  []json.RawMessage `json:"helpers"`
	Rules    []rule            `json:"rules"`
}

type compiler map[string]int

func (c compiler) key(entity string) (int, error) {
	key, ok := c[entity]
	if !ok {
		return 0, errors.New("rule references an unenrolled entity")
	}
	return key, nil
}
func (c compiler) trigger(t nativeTrigger) (term, error) {
	switch t.Kind {
	case "event":
		if t.EventType == "" || t.Entity != "" || t.To != nil || t.Above != nil {
			return term{}, errors.New("invalid event trigger")
		}
		return term{Op: "event", Text: t.EventType, Data: t.EventData}, nil
	case "state", "numeric_state":
		if t.EventType != "" || len(t.EventData) > 0 {
			return term{}, errors.New("invalid state trigger")
		}
		key, err := c.key(t.Entity)
		if err != nil {
			return term{}, err
		}
		if t.Kind == "state" && t.To != nil && t.Above == nil {
			return term{Op: "state", Key: key, Text: *t.To}, nil
		}
		if t.Kind == "numeric_state" && t.Above != nil && t.To == nil {
			return term{Op: "above", Key: key, Threshold: *t.Above}, nil
		}
	}
	return term{}, errors.New("unsupported trigger")
}

var knownPattern = regexp.MustCompile(`^\{\{ states\('([a-z0-9_.]+)'\) not in \['unknown', 'unavailable'\](.*?) \}\}$`)
var numberPattern = regexp.MustCompile(`^ and \(states\('([a-z0-9_.]+)'\) \| float\) (<=|>=|<|>) (-?\d+(?:\.\d+)?)$`)

const edgeSuffix = " and trigger.event.data.old_state is not none and trigger.event.data.new_state.state != trigger.event.data.old_state.state"

func (c compiler) conditions(nodes []nativeCondition) ([]term, error) {
	var result []term
	for _, n := range nodes {
		var t term
		var err error
		switch n.Kind {
		case "state":
			t.Op, t.Text = "eq", n.State
			t.Key, err = c.key(n.Entity)
		case "or":
			t.Op = "or"
			t.Or, err = c.conditions(n.Conditions)
		case "time":
			if _, err = time.Parse("15:04:05", n.After); err != nil {
				return nil, err
			}
			if _, err = time.Parse("15:04:05", n.Before); err != nil {
				return nil, err
			}
			t = term{Op: "time", Text: n.After, End: n.Before}
		case "template":
			match := knownPattern.FindStringSubmatch(n.Template)
			if match == nil {
				return nil, errors.New("unsupported condition template")
			}
			t.Key, err = c.key(match[1])
			if err != nil {
				return nil, err
			}
			switch match[2] {
			case "":
				t.Op = "known"
			case edgeSuffix:
				t.Op = "edge"
			default:
				number := numberPattern.FindStringSubmatch(match[2])
				if number == nil || number[1] != match[1] {
					return nil, errors.New("unsupported numeric template")
				}
				t.Op, t.Compare = "num", number[2]
				t.Threshold, err = strconv.ParseFloat(number[3], 64)
			}
		default:
			return nil, errors.New("unsupported condition")
		}
		if err != nil {
			return nil, err
		}
		result = append(result, t)
	}
	return result, nil
}

func (c compiler) action(n nativeAction) (instruction, error) {
	if len(n.Choose) > 0 {
		return instruction{}, errors.New("unsupported nested choose")
	}
	out := instruction{}
	forms := 0
	for _, present := range []bool{n.Action != "", n.If != nil, n.Parallel != nil, n.Delay != nil, n.Stop != nil} {
		if present {
			forms++
		}
	}
	if forms != 1 {
		return out, errors.New("expected one instruction form")
	}
	switch {
	case n.Action != "":
		allowed := map[string]string{"input_select.select_option": "option", "nomi_automation.configure_light": "brightness_pct color_temp_kelvin",
			"light.turn_on": "", "light.turn_off": "", "switch.turn_on": "", "switch.turn_off": "", "cover.open_cover": "", "climate.turn_off": ""}
		fields, ok := allowed[n.Action]
		if !ok {
			return out, errors.New("unsupported service")
		}
		entity := n.Target.Entity
		if raw, exists := n.Data["entity_id"]; exists {
			if entity != "" || json.Unmarshal(raw, &entity) != nil {
				return out, errors.New("invalid action target")
			}

		}
		data := make(map[string]json.RawMessage)
		for key, value := range n.Data {
			if key == "entity_id" {
				continue
			}
			if !strings.Contains(" "+fields+" ", " "+key+" ") {
				return out, errors.New("unsupported action data")
			}
			data[key] = value
		}
		key, err := c.key(entity)
		if err != nil {
			return out, err
		}
		return instruction{Op: "call", Service: n.Action, Key: key, Data: data}, nil
	case n.If != nil:
		conditions, err := c.conditions(n.If)
		if err != nil {
			return out, err
		}
		yes, err := c.sequence(n.Then)
		if err != nil {
			return out, err
		}
		no, err := c.sequence(n.Else)
		return instruction{Op: "if", If: conditions, Then: yes, Else: no}, err
	case n.Parallel != nil:
		out.Op = "parallel"
		for _, b := range n.Parallel {
			if len(b.Conditions) > 0 {
				return out, errors.New("parallel branch has unexpected conditions")
			}
			seq, err := c.sequence(b.Sequence)
			if err != nil {
				return out, err
			}
			out.Parallel = append(out.Parallel, seq)
		}
		return out, nil
	case n.Delay != nil:
		if n.Delay.Seconds < 0 {
			return out, errors.New("invalid delay")
		}
		return instruction{Op: "delay", Seconds: n.Delay.Seconds}, nil
	case n.Stop != nil:
		return instruction{Op: "stop"}, nil
	default:
		return out, errors.New("unsupported rule instruction")
	}
}
func (c compiler) sequence(nodes []nativeAction) ([]instruction, error) {
	out := make([]instruction, 0, len(nodes))
	for _, n := range nodes {
		a, err := c.action(n)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, nil
}
func compile(source sourceRules) (Program, error) {
	p := Program{Version: 1, Entities: source.Entities, Helpers: source.Helpers}
	if source.Version != 1 || !source.AllDisabled || len(source.Automations) > 256 || len(source.Entities) > 4096 {
		return p, errors.New("expected a bounded disabled migration")
	}
	sort.Strings(p.Entities)
	c := compiler{}
	for i, e := range p.Entities {
		if _, ok := c[e]; ok {
			return p, errors.New("duplicate entity")
		}
		c[e] = i
	}
	ids := map[string]bool{}
	for _, n := range source.Automations {
		if n.ID == "" || ids[n.ID] || n.Initial || n.Mode != "parallel" || len(n.Conditions) != 0 || len(n.Actions) != 1 || len(n.Triggers) == 0 {
			return p, errors.New("unsupported rule header")
		}
		ids[n.ID] = true
		r := rule{ID: n.ID, Title: n.Alias, Max: n.Max}
		options := map[string]nativeBranch{}
		for _, b := range n.Actions[0].Choose {
			if len(b.Conditions) == 0 || b.Conditions[0].Kind != "trigger" {
				return p, errors.New("missing trigger branch")
			}
			id := b.Conditions[0].ID
			if _, ok := options[id]; ok {
				return p, errors.New("duplicate trigger branch")
			}
			options[id] = b
		}
		for _, t := range n.Triggers {
			b, ok := options[t.ID]
			if !ok {
				return p, errors.New("missing trigger branch")
			}
			delete(options, t.ID)
			trigger, err := c.trigger(t)
			if err != nil {
				return p, err
			}
			when, err := c.conditions(b.Conditions[1:])
			if err != nil {
				return p, err
			}
			seq, err := c.sequence(b.Sequence)
			if err != nil {
				return p, err
			}
			r.Branches = append(r.Branches, branch{trigger, when, seq})
		}
		if len(options) > 0 {
			return p, errors.New("unmatched trigger branch")
		}
		p.Rules = append(p.Rules, r)
	}
	return p, nil
}

type Case struct {
	RuleID string `json:"rule_id"`
	Event  struct {
		Type      string
		Entity    string `json:"entity_id"`
		Old       *string
		New       *string
		Data      map[string]string
		LocalTime string `json:"local_time"`
	}
	States map[string]string
}

func number(value string) (float64, bool) {
	n, err := strconv.ParseFloat(value, 64)
	return n, err == nil && !math.IsNaN(n) && !math.IsInf(n, 0)
}
func (c Case) trigger(p Program, t term) bool {
	if t.Op == "event" {
		if c.Event.Type != t.Text {
			return false
		}
		for k, v := range t.Data {
			if c.Event.Data[k] != v {
				return false
			}
		}
		return true
	}
	if t.Key < 0 || t.Key >= len(p.Entities) || c.Event.Entity != p.Entities[t.Key] || c.Event.Old == nil || c.Event.New == nil {
		return false
	}
	if t.Op == "state" {
		return *c.Event.Old != *c.Event.New && *c.Event.New == t.Text
	}
	a, validA := number(*c.Event.Old)
	b, validB := number(*c.Event.New)
	return t.Op == "above" && validA && validB && a <= t.Threshold && b > t.Threshold
}
func (c Case) conditions(p Program, conditions []term) bool {
	for _, t := range conditions {
		if !c.condition(p, t) {
			return false
		}
	}
	return true
}
func (c Case) condition(p Program, t term) bool {
	switch t.Op {
	case "or":
		for _, other := range t.Or {
			if c.condition(p, other) {
				return true
			}
		}
		return false
	case "time":
		if _, err := time.Parse("15:04:05", c.Event.LocalTime); err != nil {
			return false
		}
		s := c.Event.LocalTime
		if t.Text <= t.End {
			return s >= t.Text && s < t.End
		}
		return s >= t.Text || s < t.End
	}
	if t.Key < 0 || t.Key >= len(p.Entities) {
		return false
	}
	entity := p.Entities[t.Key]
	value, known := c.States[entity]
	if !known || value == "unknown" || value == "unavailable" {
		return false
	}
	switch t.Op {
	case "known":
		return true
	case "eq":
		return value == t.Text
	case "edge":
		return c.Event.Data["entity_id"] == entity && c.Event.Old != nil && c.Event.New != nil && *c.Event.Old != *c.Event.New
	case "num":
		v, ok := number(value)
		if !ok {
			return false
		}
		switch t.Compare {
		case "<":
			return v < t.Threshold
		case "<=":
			return v <= t.Threshold
		case ">":
			return v > t.Threshold
		case ">=":
			return v >= t.Threshold
		}
	}
	return false
}
func (c Case) planSequence(p Program, seq []instruction) ([]any, bool, error) {
	out := []any{}
	for _, n := range seq {
		switch n.Op {
		case "stop":
			return out, true, nil
		case "call":
			if n.Key < 0 || n.Key >= len(p.Entities) {
				return nil, false, errors.New("invalid compiled target")
			}
			data := n.Data
			if data == nil {
				data = map[string]json.RawMessage{}
			}
			out = append(out, map[string]any{"service": n.Service, "entity_id": p.Entities[n.Key], "data": data})
		case "delay":
			out = append(out, map[string]any{"delay_seconds": n.Seconds})
		case "if":
			selected := n.Else
			if c.conditions(p, n.If) {
				selected = n.Then
			}
			steps, stop, err := c.planSequence(p, selected)
			if err != nil {
				return nil, false, err
			}
			out = append(out, steps...)
			if stop {
				return out, true, nil
			}
		case "parallel":
			branches := [][]any{}
			for _, b := range n.Parallel {
				steps, _, err := c.planSequence(p, b)
				if err != nil {
					return nil, false, err
				}
				branches = append(branches, steps)
			}
			out = append(out, map[string]any{"parallel": branches})
		default:
			return nil, false, errors.New("unsupported compiled instruction")
		}
	}
	return out, false, nil
}
func (c Case) Plan(p Program) ([][]any, error) {
	if p.Version != 1 || p.Enabled {
		return nil, errors.New("only disabled programs can be replayed")
	}
	out := [][]any{}
	for _, r := range p.Rules {
		if r.ID != c.RuleID {
			continue
		}
		for _, b := range r.Branches {
			if !c.trigger(p, b.Trigger) || !c.conditions(p, b.Conditions) {
				continue
			}
			steps, _, err := c.planSequence(p, b.Sequence)
			if err != nil {
				return nil, err
			}
			out = append(out, steps)
		}
		return out, nil
	}
	return nil, errors.New("unknown replay rule")
}
func readJSON(path string, value any) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	const maxBytes = 2 << 20
	raw, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return err
	}
	if len(raw) > maxBytes {
		return errors.New("rule input exceeds size budget")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(value); err != nil {
		return err
	}
	if err = decoder.Decode(new(any)); err != io.EOF {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}
func runRules(args []string) error {
	if len(args) != 3 {
		return errors.New("compile SOURCE OUTPUT or plan PROGRAM CASE")
	}
	switch args[0] {
	case "compile":
		var s sourceRules
		if err := readJSON(args[1], &s); err != nil {
			return err
		}
		p, err := compile(s)
		if err != nil {
			return err
		}
		raw, err := json.Marshal(p)
		if err != nil {
			return err
		}
		file, err := os.OpenFile(args[2], os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return err
		}
		_, err = file.Write(raw)
		err = errors.Join(err, file.Close())
		if err != nil {
			return err
		}
		branches := 0
		for _, r := range p.Rules {
			branches += len(r.Branches)
		}
		fmt.Printf("compiled %d rules, %d branches, %d entities, %d bytes\n", len(p.Rules), branches, len(p.Entities), len(raw))
		return nil
	case "plan":
		var p Program
		var c Case
		if err := readJSON(args[1], &p); err != nil {
			return err
		}
		if err := readJSON(args[2], &c); err != nil {
			return err
		}
		plan, err := c.Plan(p)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"dry_run": true, "plan": plan})
	}
	return errors.New("unknown rules command")
}
