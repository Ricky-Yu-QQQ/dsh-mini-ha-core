/** Explicit read-only connectivity and capability check; never calls services. */
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {HAClient} from './client.js';
import {validateSettings} from './model.js';
import {errorCode} from './engine.js';

export async function probe(settings) {
  const entities = validateSettings(settings), client = new HAClient(settings);
  const report = {checked_at: new Date().toISOString(), mode: 'read-only', sent_service_calls: 0};
  try {
    const states = await client.request('/api/states');
    const enrolled = states.filter(state => entities.has(state.entity_id));
    const lights = enrolled.filter(state => state.entity_id.startsWith('light.'));
    Object.assign(report, {states: states.length, enrolled: enrolled.length,
      available_lights: lights.filter(state => !['unknown', 'unavailable'].includes(state.state)).length,
      brightness_capable: lights.filter(state => (state.attributes.supported_color_modes ?? []).some(mode =>
        ['brightness', 'color_temp', 'hs', 'xy', 'rgb', 'rgbw', 'rgbww', 'white'].includes(mode))).length,
      kelvin_capable: lights.filter(state => (state.attributes.supported_color_modes ?? []).includes('color_temp')
        && Number.isFinite(state.attributes.min_color_temp_kelvin) && Number.isFinite(state.attributes.max_color_temp_kelvin)).length,
      presence_sensors: enrolled.filter(state => state.entity_id.startsWith('binary_sensor.')
        && ['occupancy', 'presence', 'motion'].includes(state.attributes.device_class)).length,
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('HA_PROBE_WS_TIMEOUT')), (settings.request_timeout_ms ?? 8000) + 2000);
      client.once('ready', () => { clearTimeout(timer); resolve(); });
      client.start();
    });
    report.websocket = 'subscribed'; report.connection_generation = client.generation;
  } catch (error) { report.error = errorCode(error); report.connection_error = client.health.last_error; }
  finally { await client.close(); }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const settings = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  const report = await probe(settings);
  console.log(JSON.stringify(report, null, 2));
  if (report.error) process.exitCode = 1;
}
