import {strict as assert} from 'node:assert';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {openVacuumProgress} from '../core/vacuum-progress.js';

test('vacuum progress reads the enrolled transport and rejects stale or invalid frames', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mini-ha-vacuum-'));
  const privateDir = path.join(root, '.local');
  await mkdir(privateDir);
  const configPath = path.join(privateDir, 'vendor.json');
  const token = 'a'.repeat(43);
  await writeFile(configPath, JSON.stringify({token}), {mode: 0o600});
  const frame = {
    available: true, mapId: 1, floorMapId: 9, frameId: 12, capturedAt: Date.now(),
    points: [[-600, -324, 'W'], [-601, -325, 'L']], roomOrder: [1, 9, 13],
  };
  let reply = frame;
  const received = [];
  const server = createServer((req, res) => {
    received.push([req.method, req.url, req.headers.authorization]);
    res.end(JSON.stringify(reply));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.close();
    await rm(root, {recursive: true});
  });
  const reader = openVacuumProgress({
    endpoint: 'http://127.0.0.1:' + server.address().port,
    config_path: configPath,
  });
  assert.deepEqual(await reader.read(), frame);
  assert.deepEqual(received, [['GET', '/api/vendor/dreame/progress', 'Bearer ' + token]]);

  reply = {...frame, capturedAt: frame.capturedAt - 181000};
  assert.deepEqual(await reader.read(), {available: false});
  reply = {...frame, roomOrder: [9, 9]};
  assert.deepEqual(await reader.read(), {available: false});
});
