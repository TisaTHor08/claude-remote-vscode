import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { Keys, ProjectInfo, open, proof, seal } from './protocol';
import { ReconnectingSocket } from './transport';
import WebSocket from 'ws';

/** Liste les projets partagés (connexion courte, authentifiée par le token du relais). */
export function listProjects(url: string, token: string, timeoutMs = 8000): Promise<ProjectInfo[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
    const t = setTimeout(() => { ws.terminate(); reject(new Error('relais injoignable (délai dépassé)')); }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', role: 'viewer', token })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'welcome') ws.send(JSON.stringify({ t: 'list' }));
      else if (m.t === 'projects') { clearTimeout(t); ws.close(); resolve(m.projects); }
      else if (m.t === 'error') { clearTimeout(t); ws.close(); reject(new Error(m.code === 'unauthorized' ? 'token du relais refusé' : m.code)); }
    });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

export type ConnStatus = 'connecting' | 'connected' | 'host-offline' | 'auth-failed' | 'closed';
export class RemoteError extends Error { constructor(public code: string, msg: string) { super(msg); } }

/** Fournit les clés pour un sel donné. `retry` = le précédent essai a échoué (mauvais mot de passe). */
export type KeysProvider = (salt: string, retry: boolean) => Promise<Keys | undefined>;

interface Pending { id: string; op: string; a: unknown; idempotent: boolean; resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; sent: boolean }

/**
 * Connexion viewer ↔ un projet. Se reconnecte, se ré-authentifie et rejoue les lectures en attente.
 * Évènements : 'status' (ConnStatus, détail?), 'event' (évènement déchiffré de l'hôte), 'attached' (après chaque (re)connexion réussie).
 */
export class ProjectConnection extends EventEmitter {
  private sock: ReconnectingSocket;
  private keys?: Keys;
  private status: ConnStatus = 'connecting';
  private pend = new Map<string, Pending>();
  private waiters: Array<() => void> = [];
  private authTries = 0;
  private attachedOnce = false;

  constructor(url: string, token: string, private projectId: string, private getKeys: KeysProvider) {
    super();
    this.sock = new ReconnectingSocket(url, 'viewer', token);
    this.sock.on('ready', () => { this.sock.send({ t: 'attach', projectId }); });
    this.sock.on('down', () => { this.setStatus('connecting'); this.failNonIdempotent('connexion perdue'); });
    this.sock.on('fatal', (msg) => { this.setStatus('closed', msg); this.failAll(msg); });
    this.sock.on('message', (m) => this.onMessage(m));
  }

  get state() { return this.status; }
  start() { this.sock.start(); }
  stop() { this.sock.stop(); this.setStatus('closed'); this.failAll('fermé'); }
  kick() { this.sock.kick(); }

  private setStatus(s: ConnStatus, detail?: string) { if (this.status !== s || detail) { this.status = s; this.emit('status', s, detail); } }

  private async onMessage(m: any) {
    switch (m.t) {
      case 'challenge': {
        try {
          const retry = this.authTries > 0;
          if (!this.keys || this.keys.salt !== m.salt || retry) this.keys = await this.getKeys(m.salt, retry);
          if (!this.keys) { this.setStatus('auth-failed', 'mot de passe non fourni'); this.stop(); return; }
          this.sock.send({ t: 'auth', proof: proof(this.keys.authKey, m.nonce) });
        } catch (e: any) { this.setStatus('auth-failed', e.message); this.stop(); }
        return;
      }
      case 'attached':
        this.authTries = 0;
        this.setStatus(m.online ? 'connected' : 'host-offline');
        this.emit('attached', !!m.online);
        this.attachedOnce = true;
        if (m.online) this.flush();
        return;
      case 'host-status':
        this.setStatus(m.online ? 'connected' : 'host-offline');
        if (m.online) { this.emit('attached', true); this.flush(); } else this.failNonIdempotent('hôte hors ligne');
        return;
      case 'error':
        if (m.code === 'bad-password') {
          this.authTries++; this.keys = undefined;
          if (this.authTries >= 3) { this.setStatus('auth-failed', 'mot de passe incorrect'); this.stop(); }
          else this.sock.send({ t: 'attach', projectId: this.projectId });
        } else if (m.code === 'locked') { this.setStatus('auth-failed', 'trop d\'essais, réessaie dans 10 min'); this.stop(); }
        else if (m.code === 'password-changed') { this.keys = undefined; this.authTries = 1; }   // le relais ferme, on se ré-authentifie à la reconnexion
        else if (m.code === 'no-such-project' || m.code === 'project-removed') { this.setStatus('closed', 'projet introuvable ou retiré'); this.stop(); }
        return;
      case 'res': {
        const p = this.pend.get(m.id);
        if (!p) return;
        if (m.err === 'host-offline' && p.idempotent) { p.sent = false; return; }   // rejouée dès le retour de l'hôte
        this.pend.delete(m.id); clearTimeout(p.timer);
        if (m.err) return p.reject(new RemoteError('Unavailable', m.err === 'host-offline' ? 'La machine hôte est hors ligne.' : m.err));
        try {
          const r = open<{ ok: boolean; v?: any; code?: string; msg?: string }>(this.keys!.encKey, 'r', m.p);
          r.ok ? p.resolve(r.v) : p.reject(new RemoteError(r.code || 'Unavailable', r.msg || 'erreur'));
        } catch (e: any) { p.reject(new RemoteError('Unavailable', 'réponse illisible : ' + e.message)); }
        return;
      }
      case 'evt':
        try { if (this.keys) this.emit('event', open(this.keys.encKey, 'e', m.p)); } catch { /* ignoré */ }
        return;
    }
  }

  /** Envoie une requête chiffrée. Les opérations idempotentes (lectures) sont rejouées après reconnexion. */
  request<T = any>(op: string, a: unknown = {}, opts: { idempotent?: boolean; timeoutMs?: number } = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = crypto.randomBytes(8).toString('hex');
      const timer = setTimeout(() => { this.pend.delete(id); reject(new RemoteError('Unavailable', 'délai dépassé (connexion instable ?)')); }, opts.timeoutMs ?? 45000);
      const p: Pending = { id, op, a, idempotent: opts.idempotent ?? (op.startsWith('fs.read') || op === 'fs.stat' || (op.startsWith('claude.') && op !== 'claude.send' && op !== 'claude.stop')), resolve, reject, timer, sent: false };
      this.pend.set(id, p);
      if (this.status === 'connected') this.transmit(p);
    });
  }

  private transmit(p: Pending) {
    if (!this.keys) return;
    const payload = seal(this.keys.encKey, 'q', { op: p.op, a: p.a, ts: Date.now(), rid: crypto.randomBytes(12).toString('hex') });
    p.sent = this.sock.send({ t: 'req', id: p.id, p: payload });
  }
  private flush() { for (const p of this.pend.values()) if (!p.sent) this.transmit(p); }
  private failNonIdempotent(why: string) {
    for (const [id, p] of this.pend) {
      if (p.idempotent) { p.sent = false; continue; }
      if (p.sent) { this.pend.delete(id); clearTimeout(p.timer); p.reject(new RemoteError('Unavailable', why)); }
    }
  }
  private failAll(why: string) { for (const [id, p] of this.pend) { this.pend.delete(id); clearTimeout(p.timer); p.reject(new RemoteError('Unavailable', why)); } }
}
