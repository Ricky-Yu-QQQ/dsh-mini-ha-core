import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {once} from 'node:events';

const key = /^[a-z][a-z0-9_-]{0,63}$/;
const frameLimit = 512 * 1024;

async function* jpegFrames(body, boundary) {
  const divider = Buffer.from('--' + boundary + '\r\n');
  const lineEnd = Buffer.from('\r\n');
  const emptyLine = Buffer.from('\r\n\r\n');
  let pending = Buffer.alloc(0);
  let length;
  for await (const chunk of body) {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (length === undefined) {
        const end = pending.indexOf(emptyLine);
        if (end === -1) {
          if (pending.length > 4096) throw new Error('camera-headers');
          break;
        }
        const start = pending.subarray(0, 2).equals(lineEnd) ? 2 : 0;
        const headers = pending.toString('latin1', start + divider.length, end);
        const size = /^content-length:\s*([0-9]+)\r?$/im.exec(headers)?.[1];
        length = Number(size);
        if (end > 4096 || !pending.subarray(start, start + divider.length).equals(divider) ||
          !/^content-type:\s*image\/jpeg\s*$/im.test(headers) ||
          !Number.isInteger(length) || length < 4 || length > frameLimit) throw new Error('camera-headers');
        pending = pending.subarray(end + emptyLine.length);
      }
      if (pending.length < length) break;
      const frame = pending.subarray(0, length);
      pending = pending.subarray(length);
      length = undefined;
      if (frame.readUInt16BE(0) !== 0xffd8 || frame.readUInt16BE(frame.length - 2) !== 0xffd9)
        throw new Error('camera-frame');
      yield frame;
    }
  }
}

export async function openCameraStreams(file) {
  if (!path.isAbsolute(file) || !path.normalize(file).split(path.sep).includes('.local'))
    throw new Error('HA_PRIVATE_CAMERA_CONFIG_REQUIRED');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let config;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 16384)
      throw new Error('HA_PRIVATE_CAMERA_CONFIG_REQUIRED');
    config = JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(config?.go2rtc) ||
    Number(config.go2rtc.split(':').at(-1)) > 65535 || !Array.isArray(config.cameras) || config.cameras.length > 16)
    throw new Error('HA_INVALID_CAMERA_CONFIG');
  const cameras = new Map();
  for (const {id, name, room, source} of config.cameras) {
    if (typeof id !== 'string' || !key.test(id) || cameras.has(id) ||
      [name, room].some(value => typeof value !== 'string' || !value.trim() || value.length > 80) ||
      (source !== undefined && (typeof source !== 'string' || !key.test(source)))) throw new Error('HA_INVALID_CAMERA_CONFIG');
    cameras.set(id, {id, name, room, source});
  }
  let active = 0;
  return {
    list: () => [...cameras.values()].map(({id, name, room, source}) => ({id, name, room, configured: source !== undefined})),
    async serve(id, res) {
      const camera = cameras.get(id);
      if (!camera?.source || active >= 2) {
        res.writeHead(!camera?.source ? 404 : 429, {'Cache-Control': 'no-store'}).end();
        return;
      }
      active++;
      const stop = new AbortController();
      const closed = () => stop.abort();
      res.once('close', closed);
      const idle = setTimeout(closed, 12000);
      try {
        const url = new URL('/api/stream.mjpeg', config.go2rtc);
        url.searchParams.set('src', camera.source);
        const response = await fetch(url, {signal: stop.signal, redirect: 'error'});
        const type = response.headers.get('content-type') ?? '';
        const boundary = /^multipart\/x-mixed-replace;\s*boundary="?([a-z0-9_.-]{1,70})"?$/i.exec(type)?.[1];
        if (!response.ok || !boundary || !response.body) throw new Error('camera-source');
        let last = -Infinity;
        for await (const jpeg of jpegFrames(response.body, boundary)) {
          idle.refresh();
          const now = performance.now();
          if (now - last < 180) continue;
          last = now;
          if (!res.headersSent) res.writeHead(200, {
            'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff',
          });
          if (!res.write(JSON.stringify({jpeg: jpeg.toString('base64')}) + '\n'))
            await once(res, 'drain', {signal: stop.signal});
        }
        if (!res.headersSent) res.writeHead(502, {'Cache-Control': 'no-store'});
        res.end();
      } catch {
        if (!res.destroyed) {
          if (!res.headersSent) res.writeHead(502, {'Cache-Control': 'no-store'}).end();
          else res.destroy();
        }
      } finally {
        stop.abort();
        clearTimeout(idle);
        res.off('close', closed);
        active--;
      }
    },
  };
}
