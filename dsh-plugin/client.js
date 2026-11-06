/** Fixed-LAN transport. No proxy, redirect, action retry, or cloud fallback. */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';

export function lanURL(value) {
  const u = new URL(value), octets = u.hostname.split('.').map(Number);
  const privateIP = octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (octets[0] === 10 || octets[0] === 127 || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
  if (!privateIP || !['http:', 'https:'].includes(u.protocol) || u.username || u.password
    || !['', '/'].includes(u.pathname) || u.search || u.hash) throw new Error('HA_FIXED_LAN_IPV4_REQUIRED');
  return u.origin;
}

export class HAClient extends EventEmitter {
  constructor(settings, options = {}) {
    super();
    this.url = lanURL(settings.url);
    this.credentialsPath = settings.credentials_path;
    this.eventTypes = [...new Set(['state_changed', ...(settings.event_types ?? [])])];
    this.timeoutMs = settings.request_timeout_ms ?? 8000;
    this.reconnectMin = options.reconnectMin ?? 1000;
    this.reconnectMax = options.reconnectMax ?? 30000;
    this.heartbeatMs = options.heartbeatMs ?? 20000;
    this.WebSocket = options.WebSocket ?? globalThis.WebSocket;
    this.stopped = false;
    this.ready = false;
    this.generation = 0;
    this.requests = new Set();
    this.life = new AbortController();
    this.health = {ready: false, generation: 0, gaps: 0, last_event_at: null, last_error: null};
  }

  async credential() {
    // Read the file again after credentials are rotated. Refreshed tokens stay in RAM.
    const source = JSON.parse(await fs.readFile(this.credentialsPath, 'utf8'));
    if (typeof source.access_token !== 'string' || !source.access_token) throw new Error('HA_CREDENTIAL_MISSING');
    const key = JSON.stringify(source);
    if (key !== this.credentialKey) { this.credentialKey = key; this.token = source; }
    if (this.token.expires_at && Date.now() / 1000 >= this.token.expires_at - 60) {
      let refresh = this.refreshing;
      if (!refresh || refresh.key !== key) {
        refresh = {key};
        refresh.promise = (async () => {
          if (!source.refresh_token || !source.client_id) throw new Error('HA_CREDENTIAL_EXPIRED');
          const result = await this.raw('/auth/token', new URLSearchParams({grant_type: 'refresh_token',
            refresh_token: source.refresh_token, client_id: source.client_id}).toString(), null, true);
          if (!result.access_token || !Number.isFinite(result.expires_in)) throw new Error('HA_REFRESH_INVALID');
          // An older response cannot replace credentials observed after file rotation.
          if (this.credentialKey === key) this.token = {...source, access_token: result.access_token,
            expires_at: Date.now() / 1000 + result.expires_in};
        })().finally(() => { if (this.refreshing === refresh) this.refreshing = null; });
        this.refreshing = refresh;
      }
      await refresh.promise;
    }
    return this.token.access_token;
  }

  raw(route, body, token, form = false, signal, method) {
    if (this.stopped || signal?.aborted) return Promise.reject(new Error('HA_CANCELLED'));
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? undefined : form ? body : JSON.stringify(body);
      const headers = token ? {Authorization: `Bearer ${token}`} : {};
      if (encoded !== undefined) {
        headers['Content-Type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
        headers['Content-Length'] = Buffer.byteLength(encoded);
      }
      const transport = this.url.startsWith('https:') ? https : http;
      const request = transport.request(this.url + route, {method: method ?? (encoded === undefined ? 'GET' : 'POST'),
        headers, agent: false, signal: AbortSignal.any([this.life.signal, AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])])}, response => {
        // Native http never follows redirects or reads HTTP(S)_PROXY.
        if (response.statusCode !== 200 && response.statusCode !== 201) {
          response.resume(); reject(new Error(`HA_HTTP_${response.statusCode}`)); return;
        }
        const chunks = []; let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) request.destroy(new Error('HA_RESPONSE_TOO_LARGE'));
          else chunks.push(chunk);
        });
        response.on('error', () => reject(new Error('HA_RESPONSE_INTERRUPTED')));
        response.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(new Error('HA_INVALID_JSON')); }
        });
      });
      this.requests.add(request);
      request.setTimeout(this.timeoutMs, () => request.destroy(new Error('HA_TIMEOUT')));
      request.once('error', () => reject(new Error(signal?.aborted || this.stopped ? 'HA_CANCELLED' : 'HA_TRANSPORT_UNCERTAIN')));
      request.once('close', () => this.requests.delete(request));
      request.end(encoded);
    });
  }

  async request(route, body, signal) {
    const read = /^\/api\/states(?:\/[a-z0-9_]+\.[a-z0-9_]+)?$/.test(route);
    const service = /^\/api\/services\/[a-z0-9_]+\/[a-z0-9_]+$/.test(route) || /^\/api\/services\/nomi_automation\/(configure_light|read_light)\?return_response$/.test(route);
    if ((!read && !service) || (read && body !== undefined) || (service && body === undefined))
      throw new Error('HA_ROUTE_DENIED');
    return this.raw(route, body, await this.credential(), false, signal);
  }
  state(id, signal) { return this.request(`/api/states/${id}`, undefined, signal); }

  automationConfig(id, body, signal) {
    if (!/^nomi_[a-z0-9_]{1,100}$/.test(id)) throw new Error('HA_NATIVE_INVALID_ID');
    return this.credential().then(token => this.raw(`/api/config/automation/config/${id}`, body, token, false, signal));
  }
  deleteAutomation(id, signal) {
    if (!/^nomi_[a-z0-9_]{1,100}$/.test(id)) throw new Error('HA_NATIVE_INVALID_ID');
    return this.credential().then(token => this.raw(`/api/config/automation/config/${id}`, undefined, token, false, signal, 'DELETE'));
  }

  start() {
    if (this.loop) return;
    this.loop = this.connectLoop();
  }
  async connectLoop() {
    let backoff = this.reconnectMin;
    while (!this.stopped) {
      const began = Date.now();
      try { await this.connection(); }
      catch (error) { this.health.last_error = /^HA_[A-Z0-9_]+$/.test(error.message) ? error.message : 'HA_WS_FAILED'; }
      if (this.stopped) break;
      this.ready = this.health.ready = false;
      this.health.gaps++;
      this.emit('gap', {...this.health, at: new Date().toISOString()});
      if (Date.now() - began > this.heartbeatMs * 2) backoff = this.reconnectMin;
      try { await delay(backoff + Math.floor(Math.random() * backoff / 5), undefined, {signal: this.life.signal}); }
      catch { break; }
      backoff = Math.min(backoff * 2, this.reconnectMax);
    }
  }

  connection() {
    return new Promise((resolve, reject) => {
      const generation = ++this.generation;
      this.health.generation = generation;
      const socket = new this.WebSocket(this.url.replace(/^http/, 'ws') + '/api/websocket');
      this.socket = socket;
      let settled = false, authenticated = false, pendingPing = null, nextId = 1;
      const subscriptions = new Map();
      const handshake = setTimeout(() => finish(new Error('HA_WS_HANDSHAKE_TIMEOUT')), this.timeoutMs);
      const beat = setInterval(() => {
        if (!this.ready) return;
        if (pendingPing) { finish(new Error('HA_WS_HEARTBEAT_TIMEOUT')); return; }
        pendingPing = nextId++;
        send({id: pendingPing, type: 'ping'});
      }, this.heartbeatMs);
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(handshake); clearInterval(beat);
        this.ready = this.health.ready = false;
        socket.close(); error ? reject(error) : resolve();
      };
      const send = value => { if (!settled && socket.readyState === 1) socket.send(JSON.stringify(value)); };
      socket.addEventListener('error', () => finish(new Error('HA_WS_TRANSPORT')));
      socket.addEventListener('close', () => finish(new Error('HA_WS_DISCONNECTED')));
      socket.addEventListener('message', async message => {
        try {
          if (settled || this.stopped) return;
          if (typeof message.data !== 'string' || Buffer.byteLength(message.data) > 2 * 1024 * 1024)
            throw new Error('HA_WS_MESSAGE_INVALID');
          const data = JSON.parse(message.data);
          if (data.type === 'auth_required' && !authenticated) {
            const access_token = await this.credential();
            send({type: 'auth', access_token});
          } else if (data.type === 'auth_invalid') throw new Error('HA_WS_AUTH_DENIED');
          else if (data.type === 'auth_ok' && !authenticated) {
            authenticated = true;
            for (const event_type of this.eventTypes) {
              const id = nextId++; subscriptions.set(id, false); send({id, type: 'subscribe_events', event_type});
            }
          } else if (data.type === 'result' && subscriptions.has(data.id)) {
            if (!data.success) throw new Error('HA_WS_SUBSCRIPTION_DENIED');
            subscriptions.set(data.id, true);
            if ([...subscriptions.values()].every(Boolean)) {
              clearTimeout(handshake);
              this.ready = this.health.ready = true; this.health.last_error = null;
              this.emit('ready', {generation});
            }
          } else if (data.type === 'pong' && data.id === pendingPing) pendingPing = null;
          else if (data.type === 'event' && subscriptions.get(data.id) && this.ready) {
            this.health.last_event_at = new Date().toISOString();
            this.emit('event', data.event, generation);
          }
        } catch (error) { finish(error); }
      });
    });
  }

  async close() {
    this.stopped = true; this.ready = this.health.ready = false;
    this.life.abort(); this.socket?.close();
    for (const request of this.requests) request.destroy();
    await this.loop;
  }
}
