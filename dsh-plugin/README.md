# DeepSeek Harness plugin

This plugin registers `ctx.homeAssistant` and the `ha_*` tools in DeepSeek
Harness. It uses the existing DSH Agent Loop for optional agent actions.

Tested with DSH 0.2.2-alpha.2, Cordis 4.0.6-alpha.1, and Node.js 24.9 or newer.
The host supplies the `tools`, `agents`, `sessions`, `systemPrompt`, and
`sessionPersistence` services.

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

The local backend shares one gateway MQTT identity and supports up to 32
enrolled lights. Each light has its own read and control configuration.
`local_verified` enrolls it for reading and `control_allowed` permits only
the configured `actions`. For in-process development use
[simulated.example.json](simulated.example.json). To connect a separate Home
Assistant installation use [settings.example.json](settings.example.json).
The HA backend's power-preserving configuration service
`nomi_automation.configure_light` is an optional HA-side integration.

## Rule and control tools

- `ha_search` and `ha_get_state` find enrolled entities and read their state.
- `ha_control` switches power or sets brightness or color temperature.
- `ha_configure_light` sets brightness and color temperature while preserving
  power. In local mode it also works while the light is off.
- `ha_rule_list`, `ha_rule_put`, `ha_rule_delete`, and `ha_rule_dry_run` manage
  rules. Use revision 0 to create a rule and its current revision to update it.
- `ha_status` returns connection status, recent rule runs, and event gaps.

For example, create a disabled rule that turns an enrolled light off after
it has been on for one second. Replace the example entity ID before saving.

```json
{
  "expected_revision": 0,
  "rule": {
    "id": "example-light",
    "name": "Example light shutoff",
    "enabled": false,
    "trigger": {"type": "state", "entity_id": "light.example", "from": "off", "to": "on", "for_ms": 1000},
    "conditions": [],
    "actions": [{"type": "control", "entity_id": "light.example", "action": "turn_off"}]
  }
}
```

The plugin records the local device code, requested property value, and
readback confirmation in `results[].result.receipts`. It establishes a fresh
state baseline after a disconnect or certificate change. An uncertain device
write stops the remaining rule actions and is never replayed automatically.
