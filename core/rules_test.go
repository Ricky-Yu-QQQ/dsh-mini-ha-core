package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCompilerRejectsUnsupportedTriggerOptions(t *testing.T) {
	file := filepath.Join(t.TempDir(), "input.json")
	body := `{"version":1,"all_disabled":true,"entities":[],"automations":[{"triggers":[{"id":"x","trigger":"state","for":"00:01:00"}]}]}`
	if err := os.WriteFile(file, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	var source sourceRules
	if err := readJSON(file, &source); err == nil {
		t.Fatal("unsupported timing accepted")
	}
}

func TestCompiledPlannerRejectsSnapshotAndUnknownState(t *testing.T) {
	c := compiler{"motion": 0, "lux": 1, "light.strip": 2}
	condition := nativeCondition{Kind: "template", Template: "{{ states('lux') not in ['unknown', 'unavailable'] and (states('lux') | float) < 60 }}"}
	action := nativeAction{If: []nativeCondition{condition}, Then: []nativeAction{{Action: "light.turn_on"}}}
	action.Then[0].Target.Entity = "light.strip"
	step, err := c.action(action)
	if err != nil {
		t.Fatal(err)
	}
	p := Program{Version: 1, Entities: []string{"motion", "lux", "light.strip"}, Rules: []rule{
		{ID: "r", Branches: []branch{{Trigger: term{Op: "state", Key: 0, Text: "on"}, Sequence: []instruction{step}}}},
	}}
	var input Case
	old, next := "off", "on"
	input.RuleID = "r"
	input.Event.Entity = "motion"
	input.Event.Old = &old
	input.Event.New = &next
	input.States = map[string]string{"lux": "12"}
	plan, err := input.Plan(p)
	if err != nil || len(plan) != 1 || len(plan[0]) != 1 {
		t.Fatalf("expected one action: %v %v", plan, err)
	}
	for _, value := range []string{"60", "unknown", "NaN", "unavailable"} {
		input.States["lux"] = value
		plan, err = input.Plan(p)
		if err != nil || len(plan) != 1 || len(plan[0]) != 0 {
			t.Fatalf("unsafe action for %s: %v %v", value, plan, err)
		}
	}
	input.Event.Old = nil
	plan, err = input.Plan(p)
	if err != nil || len(plan) != 0 {
		t.Fatalf("snapshot activated: %v %v", plan, err)
	}
}
