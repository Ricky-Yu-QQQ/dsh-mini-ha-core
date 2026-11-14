# DeepSeek Harness plugin

The plugin exposes enrolled devices and local automations as `ha_*` tools
and keeps `ctx.homeAssistant` for existing integrations. The in-process
[HomeCore](core/index.js) owns device I/O, event dispatch and the SQLite ledger.
It can also run directly under Node.js. Published device-action rules run
from Core events without opening an Agent Session.

Tested with DSH 0.2.2-alpha.2, Cordis 4.0.6-alpha.1, and Node.js 24.9 or newer.

## Install

1. Build the Go tools and create a private configuration as described in
   the [repository README](../README.md). Start with
   [the local gateway template](../examples/dsh.json).
2. Set `HOME_ASSISTANT_SETTINGS` in the DSH host environment to the absolute
   path to that configuration. Set `state` to a dedicated directory under
   `.local` for this backend.
3. Install this folder using the host's `plugin_manager` tool.

```json
{"action":"install_bundle","target":"/absolute/workspace/dsh-plugin"}
```

Restart the host if the manager reports `restart-required`. Once the Go
subscriber has connected and the plugin has read its initial state, the
`ha_status` tool reports `connection.ready: true`.

The local backend subscribes with one gateway identity and accepts up to 32
enrolled entities. `local_verified` enables reading. `control_allowed` and
`actions` determine which writes are available. To enroll a boolean light,
switch, fan or climate channel, add `"miot_power": {"siid": 3, "piid": 1}` using the verified
property IDs. Its private configuration uses `device` and `power` as
described in the [repository README](../README.md).

Use [simulated.example.json](simulated.example.json) to try the tools with
in-process devices. [settings.example.json](settings.example.json) is for an
installation that connects to a separate Home Assistant server.

## Standalone adapters and device updates

Set `ha_backend: "mixed"` and configure any combination of standalone
adapters. Put the gateway settings under `adapters.miot_lan`.
For the existing Nomi appliance bridge, set `adapters.vendor` to
`{"endpoint":"http://127.0.0.1:8315","config_path":"/absolute/.local/vendor.private.json"}`.
The bridge keeps the previously authorized Haier and Dreame sessions.
Enroll its washer as `source: "vendor", vendor: "haier"` with domain
`washer`, and its vacuum as `source: "vendor", vendor: "dreame"` with
domain `vacuum`. The adapter reads the bridge reports and forwards
state changes to Core automations. Allow the washer's `select_program`
or the vacuum's `start`, `pause` and `return_to_base` per entity.
The washer's selector takes a drum number and a program ID from state.

The optional `adapters.live` connects to an existing Home Assistant for
legacy installations. Standalone installations use the Xiaomi and vendor
adapters on their own. Each stable `entity_id` has one adapter owner.

Set `discover: true` in the Xiaomi adapter and build the current
`mips-watch`. On connection it reads the authorized local gateway's
inventory, refreshes on device-list notification and checks every 30 seconds.
`ha_discover_devices` reports the device and room names and whether each DID
has a local binding. Core uses gateway names and rooms when the enrollment
omits them. Explicit zone labels such as `沙发侧` come from the enrollment.

An optional absolute `catalog_path` under `.local` points to an owner-only
JSON file containing `{"entities":[]}`. Publish changes by writing a new
0600 file and renaming it into place. The file is the cumulative overlay:
entries can add devices or override metadata of a base entity. Include each
previously added entity on subsequent writes. Core checks for file changes
once a second. Adding a Xiaomi device resubscribes the Xiaomi watcher and
seeds its baseline again. An invalid update leaves the last accepted catalog
in memory and exposes `catalog_error` through `ha_status`.

To enable control and event subscription for a newly discovered Xiaomi
device, add its verified DID and local property binding to the catalog.
An existing binding keeps its entity ID and transport mapping during a reload.

Use `ha_control_group` with `device_type`, `action` and `area` or `zone`.
For example, `{"area":"卧室","device_type":"light","action":"turn_on"}`.
Core resolves the targets once and writes the group receipt plus individual
receipts to SQLite. If a zone occurs in several rooms, specify a room.
`ha_control_lights` remains available to existing callers.

## Device tools

- `ha_search` and `ha_get_state` find and read enrolled entities.
- `ha_control` runs enrolled device actions, including power, light settings,
  and the supported vendor commands. Use
  the exact entity ID returned by discovery. `confirmed` requires readback.
- `ha_control_receipt` looks up the stored result by `operation_id`.
- If configured, `ha_configure_light` sets light brightness or color temperature
  while preserving power. `ha_run_logic` is the compatibility tool for an
  enrolled external Home Assistant script, scene or automation. Its
  `accepted` receipt records dispatch acceptance.

## Author an automation

1. Use `ha_search` and `ha_get_state` to resolve the trigger, conditions and
   action targets. For an existing rule, read its revision with `ha_rule_get`.
2. Use `ha_rule_draft` to save a disabled draft against `expected_revision`.
3. Use `ha_rule_test` with a sample event and simulated states. Check both
   matching and non-matching cases. The tool returns condition values and
   planned actions. A `for_ms` check reports the required duration.
4. Publish the exact draft with `ha_rule_publish`. Supply `enabled: true`
   when activating the rule. A concurrent change to its base revision
   requires a fresh draft. Use `ha_rule_set_enabled` to pause or enable a
   published version.

For example, a new draft for the simulation profile:

```json
{
  "expected_revision": 0,
  "rule": {
    "id": "living-occupancy",
    "name": "Turn on the living room light when occupied and dark",
    "enabled": false,
    "trigger": {
      "type": "state",
      "entity_id": "binary_sensor.living_presence",
      "from": "off",
      "to": "on"
    },
    "conditions": [{"entity_id": "sensor.living_illuminance", "below": 30}],
    "actions": [{"type": "control", "entity_id": "light.living", "action": "turn_on"}]
  }
}
```

Core rules use a state transition or configured event type, optional
conditions, and ordered actions. State triggers can require continuous
state with `for_ms`. A disconnect clears that timer and the next connection
takes a fresh baseline.

## Inspect and restore

- `ha_rule_history` pages through revisions and their originating Session and
  tool call when available. `ha_rule_rollback` restores a version as a new
  disabled revision. Deleted IDs keep their last revision.
- `ha_rule_runs` lists runs and skips. `ha_rule_run` returns the exact event,
  revision, condition evidence, action timing and device receipts.
- `ha_rule_draft_get` shows the saved definition and its recent simulations.
  `ha_status` shows transport health, recent runs and event gaps.

Stop the old plugin instance before upgrading a state directory. Core stores
this data in owner-only `rules.sqlite` under the configured
`state` directory. The first open imports the old `rules.private.json`
snapshot and preserves it. An in-flight action with no settled receipt is
visible after restart. Core leaves it for inspection without replaying the
write. Fresh events can still trigger an enabled rule.

Existing `ha_rule_put`, `ha_rule_delete` and `ha_rule_dry_run` integrations
continue to work. External Home Assistant deployments can keep their
`native_automations` and callback configuration.
