# DSH Mini HA Core

A Go client for local Xiaomi gateway control and a DeepSeek Harness plugin for
persistent automations. The plugin reads gateway notifications, matches rules,
and records each command's device acknowledgement and readback.

| Directory | Purpose |
| --- | --- |
| [core](core) | Go tools for miIO reads and writes, MIPS MQTT subscriptions, and Xiaomi gateway certificate enrollment and renewal |
| [dsh-plugin](dsh-plugin) | DeepSeek Harness plugin with device enrollment, controls, rule management, and execution history |
| [examples](examples) | Configuration templates with placeholder values |

The local backend supports enrolled lights that expose power, brightness, and
color temperature in MIoT service 2. The control CLI also supports a single
registered boolean power property on a light or switch. Reads and writes use local miIO. Property
notifications use the gateway's MIPS MQTT broker. Certificate enrollment and
renewal use Xiaomi's authorization service. Running the local backend requires
no Home Assistant server.

## Build

Use Go 1.24 or newer on macOS or Linux. The DSH plugin requires Node.js 24.9+
and a running [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
host. Browser enrollment currently uses Google Chrome on macOS.

```sh
mkdir -p bin
(
  cd core
  go build -o ../bin/miot-control .
  go build -o ../bin/mips-watch ./cmd/mips-watch
  go build -o ../bin/mips-enroll ./cmd/mips-enroll
)
```

## Configure

1. Create an owner-only `.local` directory and copy the JSON templates from
   [examples](examples) into it. Set the local gateway address, gateway DID,
   local miIO token, and light DID. Set the gateway's trusted CA path and
   SHA-256 leaf certificate fingerprint for MQTT. The light configuration and
   identity files must be readable only by their owner.
2. On macOS, run `bin/mips-enroll -dir "$PWD/.local/enrollment"` and complete
   Xiaomi authorization in the browser. The command writes `identity.json`
   into a new private directory. The local watcher renews a certificate when
   it enters its final 72 hours and reconnects using the renewed certificate.
3. Set the absolute paths in `.local/dsh.json`. Follow the
   [plugin installation instructions](dsh-plugin/README.md).

You can check the selected light without starting DSH. Replace
`REPLACE_WITH_MIOT_DEVICE_DID` with the same DID as in the light configuration.

```sh
bin/miot-control -config "$PWD/.local/light.json" -mode read \
  -expected-light REPLACE_WITH_MIOT_DEVICE_DID -journal -
bin/mips-watch -gateway "$PWD/.local/gateway.json" \
  -identity "$PWD/.local/enrollment/identity.json" \
  -device REPLACE_WITH_MIOT_DEVICE_DID -kind property -duration 30s
```

The watcher emits `subscribed` after the gateway acknowledges the subscription
and `device-property` for a property notification. The control tool requires
`-apply` for a device write. Keep local tokens, keys, and generated identities
in `.local`.

For an enrolled switch channel, replace the light and presence fields in the
private control config with `"device": "DEVICE_DID"` and
`"power": {"siid": 3, "piid": 1}` using the device's verified property IDs.
Use `-expected-device DEVICE_DID -expected-power 3/1` in place of
`-expected-light`. The CLI accepts `-mode read` or a boolean
`-mode set -property power -apply` for that exact channel.

For power properties exposed only through the local MIPS proxy, use
`mips-watch power` with the same flags. Its enrollment file contains
`device`, `power`, and the absolute owner-only `gateway` and `identity`
JSON paths. It uses the same pinned TLS and exclusive identity lock as the
watcher. A write is sent once and verified by a fresh property read.

## Test

```sh
(cd core && go test -race ./... && go vet ./...)
(cd dsh-plugin && npm ci && npm test)
```

See [LICENSE](LICENSE) for the MIT license. External dependencies retain their
own licenses.
