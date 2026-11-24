import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

/** Évènement simplifié, identique dans l'historique et en direct. */
export type UiEvent =
  | { k: 'user'; text: string }
  | { k: 'text'; text: string }
  | { k: 'tool'; id: string; name: string; input: string }
  | { k: 'toolres'; id: string; ok: boolean; text: string }
  | { k: 'init'; sessionId: string }
  | { k: 'result'; ok: boolean; text: string; cost?: number; sessionId?: string }
  | { k: 'error'; text: string }
  | { k: 'done'; code: number | null };

export interface RunnerOptions {
  claudePath?: string;
  permissionMode: string;
  allowedTools: string[];
  log?: (m: string) => void;
}

interface Run { id: string; sessionId?: string; events: Array<UiEvent & { seq: number }>; seq: number; done: boolean; child?: ChildProcess; endedAt?: number }

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

export function resolveClaudeBinary(configured?: string): string {
  if (configured) return configured;
  const win = process.platform === 'win32';
  const exe = win ? 'claude.exe' : 'claude';
  const cands: string[] = [path.join(os.homedir(), '.local', 'bin', exe)];
  // binaire natif livré avec l'extension officielle Claude Code pour VS Code
  const extDir = path.join(os.homedir(), '.vscode', 'extensions');
  try {
    const dirs = fs.readdirSync(extDir).filter((d) => d.startsWith('anthropic.claude-code-')).sort().reverse();
    for (const d of dirs) cands.push(path.join(extDir, d, 'resources', 'native-binary', exe));
  } catch { /* pas d'extension */ }
  for (const p of (process.env.PATH || '').split(path.delimiter)) if (p) cands.push(path.join(p, exe));
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ } }
  throw new Error(
    "Binaire 'claude' introuvable. Renseigne le réglage claudeRemote.claude.path " +
    "(sous Windows : le chemin de claude.exe ; un claude.cmd npm n'est pas supporté)."
  );
}

export function sessionsDirFor(cwd: string): string {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** Convertit un message brut du CLI (stream-json ou transcript .jsonl) en évènements simplifiés. */
export function toUiEvents(m: any): UiEvent[] {
  const out: UiEvent[] = [];
  if (!m || typeof m !== 'object') return out;
  if (m.type === 'system' && m.subtype === 'init' && m.session_id) out.push({ k: 'init', sessionId: m.session_id });
  else if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
    for (const b of m.message.content) {
      if (b.type === 'text' && b.text) out.push({ k: 'text', text: b.text });
      else if (b.type === 'tool_use') out.push({ k: 'tool', id: b.id, name: b.name, input: trunc(JSON.stringify(b.input ?? {}), 400) });
    }
  } else if (m.type === 'user' && !m.isMeta) {
    const c = m.message?.content;
    if (typeof c === 'string') out.push({ k: 'user', text: c });
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text' && b.text) out.push({ k: 'user', text: b.text });
        else if (b.type === 'tool_result') {
          const t = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x: any) => x.text || '').join('\n') : '';
          out.push({ k: 'toolres', id: b.tool_use_id, ok: !b.is_error, text: trunc(t, 600) });
        }
      }
    }
  } else if (m.type === 'result') {
    out.push({ k: 'result', ok: m.subtype === 'success' && !m.is_error, text: typeof m.result === 'string' ? m.result : '', cost: m.total_cost_usd, sessionId: m.session_id });
  }
  return out;
}

export class ClaudeRunner extends EventEmitter {
  private runs = new Map<string, Run>();
  constructor(private cwd: string, private opts: RunnerOptions) { super(); }

  updateOptions(o: Partial<RunnerOptions>) { Object.assign(this.opts, o); }

  async listSessions(): Promise<Array<{ id: string; title: string; mtime: number }>> {
    const dir = sessionsDirFor(this.cwd);
    let names: string[] = [];
    try { names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.jsonl')); } catch { return []; }
    const rows = await Promise.all(names.map(async (n) => {
      const file = path.join(dir, n);
      try {
        const st = await fs.promises.stat(file);
        const fh = await fs.promises.open(file, 'r');
        const buf = Buffer.alloc(Math.min(65536, st.size));
        await fh.read(buf, 0, buf.length, 0); await fh.close();
        let title = '';
        for (const line of buf.toString('utf8').split('\n')) {
          try { const ev = toUiEvents(JSON.parse(line)).find((e) => e.k === 'user') as any; if (ev) { title = ev.text; break; } } catch { /* ligne coupée */ }
        }
        return { id: n.replace(/\.jsonl$/, ''), title: trunc(title.replace(/\s+/g, ' ').trim() || '(sans titre)', 80), mtime: st.mtimeMs };
      } catch { return undefined; }
    }));
    return rows.filter((r): r is NonNullable<typeof r> => !!r).sort((a, b) => b.mtime - a.mtime).slice(0, 100);
  }

  async history(sessionId: string): Promise<UiEvent[]> {
    if (!/^[0-9a-f-]{8,}$/i.test(sessionId)) throw new Error('session invalide');
    const file = path.join(sessionsDirFor(this.cwd), sessionId + '.jsonl');
    const txt = await fs.promises.readFile(file, 'utf8');
    const evs: UiEvent[] = [];
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      try { const j = JSON.parse(line); if (!j.isSidechain) evs.push(...toUiEvents(j).filter((e) => e.k !== 'init' && e.k !== 'result')); } catch { /* ignore */ }
    }
    return evs.slice(-400);
  }

  activeRuns() {
    this.gc();
    return [...this.runs.values()].map((r) => ({ runId: r.id, sessionId: r.sessionId, done: r.done, lastSeq: r.seq }));
  }

  poll(runId: string, after: number) {
    const r = this.runs.get(runId);
    if (!r) throw new Error('run inconnu');
    return { events: r.events.filter((e) => e.seq > after), done: r.done, sessionId: r.sessionId };
  }

  stop(runId: string) {
    const r = this.runs.get(runId);
    if (r?.child && !r.done) r.child.kill(process.platform === 'win32' ? undefined : 'SIGINT');
  }

  stopAll() { for (const r of this.runs.values()) if (r.child && !r.done) r.child.kill(); }

  send(text: string, sessionId?: string): { runId: string } {
    if (sessionId && !/^[0-9a-f-]{8,}$/i.test(sessionId)) throw new Error('session invalide');
    if (!text.trim()) throw new Error('message vide');
    for (const r of this.runs.values()) if (r.sessionId && r.sessionId === sessionId && !r.done) throw new Error('Un message est déjà en cours dans ce chat.');
    const bin = resolveClaudeBinary(this.opts.claudePath);
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (sessionId) args.push('--resume', sessionId);
    if (this.opts.permissionMode && this.opts.permissionMode !== 'default') args.push('--permission-mode', this.opts.permissionMode);
    if (this.opts.allowedTools.length) args.push('--allowedTools', this.opts.allowedTools.join(','));

    const run: Run = { id: crypto.randomBytes(6).toString('hex'), sessionId, events: [], seq: 0, done: false };
    this.runs.set(run.id, run);
    this.opts.log?.(`claude run ${run.id} (${sessionId ? 'resume ' + sessionId : 'nouveau chat'})`);
    const push = (e: UiEvent) => {
      if (e.k === 'init') run.sessionId = e.sessionId;
      if (e.k === 'result' && e.sessionId) run.sessionId = e.sessionId;
      const ev = { ...e, seq: ++run.seq };
      run.events.push(ev);
      if (run.events.length > 3000) run.events.splice(0, run.events.length - 3000);
      this.emit('event', run.id, ev);
    };
    push({ k: 'user', text });

    let stderr = '';
    const isJs = /\.(c|m)?js$/i.test(bin);
    const child = spawn(isJs ? process.execPath : bin, isJs ? [bin, ...args] : args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, NO_COLOR: '1' } });
    run.child = child;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try { for (const e of toUiEvents(JSON.parse(line))) push(e); } catch { /* ligne non JSON */ }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (err) => { push({ k: 'error', text: `Impossible de lancer claude : ${err.message}` }); finish(null); });
    const finish = (code: number | null) => {
      if (run.done) return;
      run.done = true; run.endedAt = Date.now();
      if (code && stderr.trim()) push({ k: 'error', text: trunc(stderr.trim(), 1500) });
      push({ k: 'done', code });
    };
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => { /* le process peut se fermer avant */ });
    child.stdin.end(text);
    return { runId: run.id };
  }

  private gc() {
    const now = Date.now();
    for (const [id, r] of this.runs) if (r.done && r.endedAt && now - r.endedAt > 3600_000) this.runs.delete(id);
  }
}
