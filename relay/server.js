'use strict';
/**
 * Claude Remote relay.
 *
 * The relay is deliberately "dumb": it authenticates peers, keeps a registry of
 * shared projects and forwards opaque, end-to-end encrypted payloads between a
 * project's host (the machine running VS Code) and its viewers. It never sees
 * the project password nor any file/chat content (only project name + online state).
 *
 * Layers of protection:
 *   1. RELAY_TOKEN  : shared secret needed to even talk to the relay / list projects.
 *   2. Per-project password : challenge/response (HMAC) to attach to a project,
 *      plus AES-256-GCM end-to-end encryption derived from the same password
 *      (the relay only stores a one-way "authKey", never the encryption key).
 */
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '8787', 10);
const TOKEN = process.env.RELAY_TOKEN || '';
const MAX_PAYLOAD = parseInt(process.env.MAX_PAYLOAD_BYTES || String(32 * 1024 * 1024), 10);
const MAX_FAILS = 5;                 // wrong passwords before lockout
const LOCK_MS = 10 * 60 * 1000;      // lockout window
const HEARTBEAT_MS = 20000;

if (TOKEN.length < 24) {
  console.error('RELAY_TOKEN must be set and at least 24 characters long (e.g. `openssl rand -hex 32`).');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const tokenBuf = Buffer.from(TOKEN);
function tokenOk(t) {
  if (typeof t !== 'string') return false;
  const b = Buffer.from(t);
  return b.length === tokenBuf.length && crypto.timingSafeEqual(b, tokenBuf);
}
const safeEq = (a, b) => {
  const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

/** @type {Map<string, {id:string,name:string,salt:string,authKey:string,host:any,viewers:Set<any>,lastSeen:number}>} */
const rooms = new Map();
/** failed attempts: key -> {n, until} */
const fails = new Map();
let nextVid = 1;

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_PAYLOAD });

const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const clientIp = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').toString().split(',')[0].trim();

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.ip = clientIp(req);
  ws.role = null;
  ws.room = null;
  ws.vid = 0;
  ws.pendingNonce = null;

  const helloTimer = setTimeout(() => { if (!ws.role) ws.close(4408, 'hello-timeout'); }, 10000);

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return ws.close(4400, 'bad-json'); }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'ping') return send(ws, { t: 'pong' });

    // ---- handshake
    if (!ws.role) {
      if (m.t !== 'hello' || (m.role !== 'host' && m.role !== 'viewer') || !tokenOk(m.token)) {
        log('auth refused', ws.ip);
        send(ws, { t: 'error', code: 'unauthorized' });
        return ws.close(4401, 'unauthorized');
      }
      clearTimeout(helloTimer);
      ws.role = m.role;
      return send(ws, { t: 'welcome', role: ws.role });
    }

    if (ws.role === 'host') return onHost(ws, m);
    return onViewer(ws, m);
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (ws.role === 'host' && ws.room && ws.room.host === ws) {
      ws.room.host = null;
      ws.room.lastSeen = Date.now();
      for (const v of ws.room.viewers) send(v, { t: 'host-status', online: false });
      log('host offline', ws.room.id);
    } else if (ws.role === 'viewer' && ws.room) {
      ws.room.viewers.delete(ws);
    }
  });
  ws.on('error', () => {});
});

function onHost(ws, m) {
  if (m.t === 'register') {
    const ok = /^[a-z0-9][a-z0-9-]{2,63}$/.test(m.projectId || '')
      && typeof m.name === 'string' && m.name.length <= 100
      && /^[0-9a-f]{32}$/.test(m.salt || '') && /^[0-9a-f]{64}$/.test(m.authKey || '');
    if (!ok) return send(ws, { t: 'error', code: 'bad-register' });
    let room = rooms.get(m.projectId);
    if (!room) {
      room = { id: m.projectId, name: m.name, salt: m.salt, authKey: m.authKey, host: null, viewers: new Set(), lastSeen: Date.now() };
      rooms.set(room.id, room);
    } else {
      if (room.host && room.host !== ws) { try { room.host.close(4409, 'replaced'); } catch {} }
      const changed = room.authKey !== m.authKey;
      room.name = m.name; room.salt = m.salt; room.authKey = m.authKey;
      if (changed) { // password was re-set on the host: kick all viewers, they must re-authenticate
        for (const v of room.viewers) { send(v, { t: 'error', code: 'password-changed' }); v.close(4403, 'password-changed'); }
        room.viewers.clear();
      }
    }
    room.host = ws; ws.room = room; room.lastSeen = Date.now();
    for (const v of room.viewers) send(v, { t: 'host-status', online: true });
    log('host registered', room.id);
    return send(ws, { t: 'registered', projectId: room.id });
  }
  if (!ws.room) return;
  const room = ws.room;
  if (m.t === 'res') {                       // reply to one viewer
    for (const v of room.viewers) if (v.vid === m.vid) return send(v, { t: 'res', id: m.id, p: m.p, err: m.err });
  } else if (m.t === 'evt') {                // event for everyone attached
    for (const v of room.viewers) send(v, { t: 'evt', p: m.p });
  } else if (m.t === 'unregister') {
    for (const v of room.viewers) { send(v, { t: 'error', code: 'project-removed' }); v.close(4404, 'removed'); }
    rooms.delete(room.id);
    ws.room = null;
  }
}

function lockKey(ws, id) { return ws.ip + '|' + id; }

function onViewer(ws, m) {
  if (m.t === 'list') {
    const projects = [...rooms.values()].map((r) => ({ id: r.id, name: r.name, online: !!r.host, lastSeen: r.lastSeen }));
    return send(ws, { t: 'projects', projects });
  }
  if (m.t === 'attach') {
    const room = rooms.get(m.projectId);
    if (!room) return send(ws, { t: 'error', code: 'no-such-project' });
    const f = fails.get(lockKey(ws, room.id));
    if (f && f.n >= MAX_FAILS && f.until > Date.now()) return send(ws, { t: 'error', code: 'locked', retryInMs: f.until - Date.now() });
    ws.pendingNonce = crypto.randomBytes(16).toString('hex');
    ws.pendingRoom = room;
    return send(ws, { t: 'challenge', nonce: ws.pendingNonce, salt: room.salt });
  }
  if (m.t === 'auth') {
    const room = ws.pendingRoom, nonce = ws.pendingNonce;
    if (!room || !nonce) return;
    ws.pendingNonce = null; ws.pendingRoom = null;
    const expected = crypto.createHmac('sha256', Buffer.from(room.authKey, 'hex')).update(nonce).digest('hex');
    if (!safeEq(m.proof, expected)) {
      const k = lockKey(ws, room.id);
      const f = fails.get(k) || { n: 0, until: 0 };
      f.n += 1; f.until = Date.now() + LOCK_MS; fails.set(k, f);
      log('bad password', room.id, ws.ip, f.n);
      return send(ws, { t: 'error', code: 'bad-password' });
    }
    fails.delete(lockKey(ws, room.id));
    ws.room = room; ws.vid = nextVid++;
    room.viewers.add(ws);
    log('viewer attached', room.id, ws.vid);
    return send(ws, { t: 'attached', projectId: room.id, online: !!room.host });
  }
  if (!ws.room) return;
  if (m.t === 'req') {
    if (!ws.room.host) return send(ws, { t: 'res', id: m.id, err: 'host-offline' });
    return send(ws.room.host, { t: 'req', vid: ws.vid, id: m.id, p: m.p });
  }
}

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
  const now = Date.now();
  for (const [k, f] of fails) if (f.until < now) fails.delete(k);
  // forget projects whose host has been gone for 7 days
  for (const [id, r] of rooms) if (!r.host && r.viewers.size === 0 && now - r.lastSeen > 7 * 864e5) rooms.delete(id);
}, HEARTBEAT_MS).unref();

server.listen(PORT, () => log(`claude-remote relay listening on :${PORT} (path /ws)`));
