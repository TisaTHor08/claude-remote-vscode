import { EventEmitter } from 'events';
import WebSocket from 'ws';

export type Role = 'host' | 'viewer';

/**
 * WebSocket client qui se reconnecte tout seul (backoff exponentiel + jitter) et détecte les
 * connexions « zombies » (typiques d'une box 5G/CGNAT qui change d'IP) via ping/pong.
 * Évènements : 'ready' (à chaque (re)connexion authentifiée), 'message', 'down', 'fatal'.
 */
export class ReconnectingSocket extends EventEmitter {
  private ws?: WebSocket;
  private attempt = 0;
  private timer?: NodeJS.Timeout;
  private hb?: NodeJS.Timeout;
  private lastSeen = 0;
  private stopped = false;
  private ready = false;

  constructor(private url: string, private role: Role, private token: string,
              private pingMs = 10000, private deadMs = 30000) { super(); }

  get isReady() { return this.ready; }

  start() { this.stopped = false; this.connect(); }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer); clearInterval(this.hb);
    try { this.ws?.close(1000); } catch { /* ignore */ }
    this.ws = undefined; this.ready = false;
  }

  send(obj: unknown): boolean {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  /** Force une reconnexion immédiate (ex. retour du réseau). */
  kick() { try { this.ws?.terminate(); } catch { /* ignore */ } }

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket(this.url, { handshakeTimeout: 10000, maxPayload: 64 * 1024 * 1024 });
    this.ws = ws;
    ws.on('open', () => {
      this.lastSeen = Date.now();
      ws.send(JSON.stringify({ t: 'hello', role: this.role, token: this.token }));
    });
    ws.on('pong', () => { this.lastSeen = Date.now(); });
    ws.on('message', (raw) => {
      this.lastSeen = Date.now();
      let m: any;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.t === 'welcome') { this.attempt = 0; this.ready = true; this.startHeartbeat(ws); this.emit('ready'); return; }
      if (m.t === 'error' && m.code === 'unauthorized') { this.emit('fatal', 'Token du relais refusé.'); this.stop(); return; }
      this.emit('message', m);
    });
    ws.on('error', () => { /* 'close' suit toujours */ });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      const was = this.ready;
      this.ready = false; clearInterval(this.hb);
      if (was) this.emit('down');
      if (!this.stopped) this.schedule();
    });
  }

  private startHeartbeat(ws: WebSocket) {
    clearInterval(this.hb);
    this.hb = setInterval(() => {
      if (Date.now() - this.lastSeen > this.deadMs) { ws.terminate(); return; }
      try { ws.ping(); } catch { /* ignore */ }
    }, this.pingMs);
    this.hb.unref?.();
  }

  private schedule() {
    const base = Math.min(15000, 500 * 2 ** Math.min(this.attempt++, 6));
    const delay = base / 2 + Math.random() * base / 2;
    this.timer = setTimeout(() => this.connect(), delay);
  }
}
