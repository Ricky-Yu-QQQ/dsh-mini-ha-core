# DSH Mini HA Core

Mini HA Core discovers devices on the authorized Xiaomi gateway, handles
enrolled devices and events, and runs persistent local automations. It can
also use the Nomi direct appliance bridge for Haier and Dreame devices.
The DeepSeek Harness plugin exposes Core as tools. An agent can author
rules, then Core matches events, evaluates conditions, runs device actions,
and records their readbacks.

| Directory | Purpose |
| --- | --- |
| [core](core) | Go transport for miIO reads and writes, MIPS MQTT subscriptions, and gateway certificate enrollment and renewal |
| [dsh-plugin/core](dsh-plugin/core) | Node.js Core for device operations, local rule execution and SQLite persistence |
| [dsh-plugin](dsh-plugin) | DeepSeek Harness tool adapter and installation instructions |
| [examples](examples) | Configuration templates with placeholder values |

The local backend supports enrolled lights with MIoT service 2 power,
brightness, and color temperature. Light, switch, fan and air conditioner
channels can register a verified boolean power property. Control uses local miIO and
property notifications use MIPS MQTT. Certificate enrollment and renewal
use Xiaomi's authorization service. The local backend runs without a Home
Assistant server.

## Build

Use Go 1.24 or newer on macOS or Linux. The rule runtime uses Node.js 24.9+
and its bundled SQLite. The plugin runs inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Browser enrollment currently uses Google Chrome on macOS.

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

## Benchmark

`node scripts/benchmark-rules.mjs` measures indexed matching and the local
event-to-receipt path using 256 definitions, 256 historical runs, and a
simulated device. Pass the absolute `dsh-plugin` directory from commit
`7a568bd` to compare against the JSON store. The timings cover Core only.

## Test

```sh
(cd core && go test -race ./... && go vet ./...)
(cd dsh-plugin && npm ci && npm test)
```

See [LICENSE](LICENSE) for the MIT license. External dependencies retain their
own licenses.
