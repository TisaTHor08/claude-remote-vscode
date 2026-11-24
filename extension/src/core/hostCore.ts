import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { Keys, open, seal } from './protocol';
import { ReconnectingSocket } from './transport';
import { ClaudeRunner } from './claudeRunner';

export interface HostOptions {
  url: string; token: string; projectId: string; name: string; root: string; keys: Keys; runner: ClaudeRunner;
  log?: (m: string) => void;
}

const FT = { File: 1, Directory: 2, SymbolicLink: 64 };
const MAX_READ = 12 * 1024 * 1024;
const MAX_SKEW = 5 * 60 * 1000;

class FsError extends Error { constructor(public code: string, msg: string) { super(msg); } }

export class HostCore extends EventEmitter {
  private sock: ReconnectingSocket;
  private seenRids = new Map<string, number>();
  private realRoot = '';
  private pending: Array<[string, number]> = [];
  private flushTimer?: NodeJS.Timeout;
  private win = process.platform === 'win32';

  constructor(private o: HostOptions) {
    super();
    this.sock = new ReconnectingSocket(o.url, 'host', o.token);
    this.sock.on('ready', () => {
      this.sock.send({ t: 'register', projectId: o.projectId, name: o.name, salt: o.keys.salt, authKey: o.keys.authKey.toString('hex') });
    });
    this.sock.on('message', (m) => this.onMessage(m));
    this.sock.on('down', () => { o.log?.('hôte : connexion au relais perdue, reconnexion…'); this.emit('status', 'reconnecting'); });
    this.sock.on('fatal', (msg) => { this.emit('status', 'fatal', msg); });
    o.runner.on('event', (runId: string, ev: any) => this.broadcast({ k: 'claude', runId, seq: ev.seq, ev }));
  }

  start() { this.realRoot = fs.realpathSync.native(this.o.root); this.sock.start(); }
  stop(unregister = false) { if (unregister) this.sock.send({ t: 'unregister' }); this.sock.stop(); this.o.runner.stopAll(); }
  kick() { this.sock.kick(); }

  /** À appeler depuis le watcher de fichiers (chemins relatifs à la racine, séparateur quelconque). */
  notifyFsChange(rel: string, kind: 1 | 2 | 3) {
    this.pending.push(['/' + rel.split(/[\\/]/).filter(Boolean).join('/'), kind]);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      const changes = this.pending.splice(0, 500);
      this.broadcast({ k: 'fs', changes });
    }, 150);
  }

  private broadcast(obj: unknown) { this.sock.send({ t: 'evt', p: seal(this.o.keys.encKey, 'e', obj) }); }

  private async onMessage(m: any) {
    if (m.t === 'registered') { this.o.log?.('hôte : enregistré sur le relais'); this.emit('status', 'online'); return; }
    if (m.t === 'error') { this.emit('status', 'error', m.code); return; }
    if (m.t !== 'req') return;
    let reply: { ok: boolean; v?: unknown; code?: string; msg?: string };
    try {
      const q = open<{ op: string; a: any; ts: number; rid: string }>(this.o.keys.encKey, 'q', m.p);
      const now = Date.now();
      if (Math.abs(now - q.ts) > MAX_SKEW) throw new FsError('Unavailable', 'horodatage hors tolérance (horloges désynchronisées ?)');
      if (this.seenRids.has(q.rid)) throw new FsError('Unavailable', 'requête rejouée');
      this.seenRids.set(q.rid, now);
      for (const [k, t] of this.seenRids) if (now - t > 2 * MAX_SKEW) this.seenRids.delete(k);
      reply = { ok: true, v: await this.dispatch(q.op, q.a || {}) };
    } catch (e: any) {
      reply = { ok: false, code: e instanceof FsError ? e.code : (e?.code === 'ENOENT' ? 'FileNotFound' : e?.code === 'EEXIST' ? 'FileExists' : e?.code === 'EACCES' || e?.code === 'EPERM' ? 'NoPermissions' : 'Unavailable'), msg: String(e?.message || e) };
    }
    this.sock.send({ t: 'res', vid: m.vid, id: m.id, p: seal(this.o.keys.encKey, 'r', reply) });
  }

  // ---------------------------------------------------------------- chemins sûrs
  private async safe(vpath: string, mustExist = true): Promise<string> {
    if (typeof vpath !== 'string' || vpath.includes('\0')) throw new FsError('NoPermissions', 'chemin invalide');
    const parts = vpath.split('/').filter(Boolean);
    for (const p of parts) {
      if (p === '..' || p === '.') throw new FsError('NoPermissions', 'chemin invalide');
      if (this.win && /[\\:<>"|?*]/.test(p)) throw new FsError('NoPermissions', 'chemin invalide');
    }
    const abs = path.join(this.o.root, ...parts);
    // résout les liens symboliques sur le plus profond ancêtre existant
    let probe = abs; let tail: string[] = [];
    for (;;) {
      try { const real = await fs.promises.realpath(probe); this.within(path.join(real, ...tail)); if (mustExist && tail.length) throw new FsError('FileNotFound', 'introuvable'); return path.join(real, ...tail); }
      catch (e: any) {
        if (e instanceof FsError) throw e;
        const parent = path.dirname(probe);
        if (parent === probe) throw new FsError('FileNotFound', 'introuvable');
        tail = [path.basename(probe), ...tail]; probe = parent;
      }
    }
  }
  private within(abs: string) {
    const a = this.win ? abs.toLowerCase() : abs, r = this.win ? this.realRoot.toLowerCase() : this.realRoot;
    const rel = path.relative(r, a);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new FsError('NoPermissions', 'hors du projet');
  }

  private async dispatch(op: string, a: any): Promise<unknown> {
    switch (op) {
      case 'meta': return { name: this.o.name, platform: process.platform, root: path.basename(this.o.root) };
      case 'fs.stat': {
        const p = await this.safe(a.path);
        const l = await fs.promises.lstat(p).catch(() => undefined);
        const s = await fs.promises.stat(p);
        return { type: (s.isDirectory() ? FT.Directory : FT.File) | (l?.isSymbolicLink() ? FT.SymbolicLink : 0), size: s.size, ctime: s.ctimeMs, mtime: s.mtimeMs };
      }
      case 'fs.readDirectory': {
        const p = await this.safe(a.path);
        const ents = await fs.promises.readdir(p, { withFileTypes: true });
        return ents.map((e) => [e.name, (e.isDirectory() ? FT.Directory : FT.File) | (e.isSymbolicLink() ? FT.SymbolicLink : 0)]);
      }
      case 'fs.readFile': {
        const p = await this.safe(a.path);
        const s = await fs.promises.stat(p);
        if (s.size > MAX_READ) throw new FsError('Unavailable', `fichier trop gros (${(s.size / 1048576).toFixed(1)} Mo, max 12 Mo)`);
        return { data: (await fs.promises.readFile(p)).toString('base64') };
      }
      case 'fs.writeFile': {
        const p = await this.safe(a.path, false);
        const exists = await fs.promises.stat(p).then(() => true, () => false);
        if (!exists && !a.create) throw new FsError('FileNotFound', 'introuvable');
        if (exists && a.create && !a.overwrite) throw new FsError('FileExists', 'existe déjà');
        await fs.promises.writeFile(p, Buffer.from(String(a.data || ''), 'base64'));
        return null;
      }
      case 'fs.mkdir': await fs.promises.mkdir(await this.safe(a.path, false), { recursive: false }); return null;
      case 'fs.delete': {
        const p = await this.safe(a.path);
        if (path.resolve(p) === path.resolve(this.realRoot)) throw new FsError('NoPermissions', 'racine protégée');
        await fs.promises.rm(p, { recursive: !!a.recursive, force: false }); return null;
      }
      case 'fs.rename': {
        const from = await this.safe(a.from), to = await this.safe(a.to, false);
        if (!a.overwrite && await fs.promises.stat(to).then(() => true, () => false)) throw new FsError('FileExists', 'existe déjà');
        await fs.promises.rename(from, to); return null;
      }
      case 'claude.sessions': return this.o.runner.listSessions();
      case 'claude.history': return this.o.runner.history(String(a.sessionId));
      case 'claude.runs': return this.o.runner.activeRuns();
      case 'claude.poll': return this.o.runner.poll(String(a.runId), Number(a.after) || 0);
      case 'claude.send': return this.o.runner.send(String(a.text || ''), a.sessionId ? String(a.sessionId) : undefined);
      case 'claude.stop': this.o.runner.stop(String(a.runId)); return null;
      default: throw new FsError('Unavailable', 'opération inconnue: ' + op);
    }
  }
}
