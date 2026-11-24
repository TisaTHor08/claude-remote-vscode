import * as vscode from 'vscode';
import { ProjectInfo, listProjects, ProjectConnection } from './core';
import { RemoteFs, Relay, SCHEME } from './remoteFs';

export class ProjectsProvider implements vscode.TreeDataProvider<ProjectInfo | string> {
  private _e = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._e.event;
  private timer?: NodeJS.Timeout;
  constructor(private getRelay: () => Promise<Relay | undefined>, private log: (m: string) => void) {
    this.timer = setInterval(() => this.refresh(), 15000);
  }
  refresh() { this._e.fire(); }
  dispose() { clearInterval(this.timer); }

  async getChildren(): Promise<Array<ProjectInfo | string>> {
    const relay = await this.getRelay();
    if (!relay) return [];
    try {
      const l = await listProjects(relay.url, relay.token);
      return l.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    } catch (e: any) { this.log('liste des projets : ' + e.message); return ['⚠ ' + e.message]; }
  }
  getTreeItem(el: ProjectInfo | string): vscode.TreeItem {
    if (typeof el === 'string') { const t = new vscode.TreeItem(el); t.command = { command: 'claudeRemote.refresh', title: 'Réessayer' }; return t; }
    const t = new vscode.TreeItem(el.name, vscode.TreeItemCollapsibleState.None);
    t.description = el.online ? 'en ligne' : 'hors ligne';
    t.iconPath = new vscode.ThemeIcon(el.online ? 'vm-running' : 'vm-outline');
    t.tooltip = `${el.id}\n${el.online ? 'La machine hôte est connectée.' : 'La machine hôte est hors ligne (ouverture possible dès son retour).'}`;
    t.command = { command: 'claudeRemote.openProject', title: 'Ouvrir', arguments: [el] };
    return t;
  }
}

type FromWebview =
  | { type: 'ready' } | { type: 'newChat' } | { type: 'select'; id: string }
  | { type: 'send'; text: string } | { type: 'stop' };

/** Panneau de chat : tout l'état vit sur l'hôte ; ce panneau se resynchronise (curseur `seq`) après chaque coupure. */
export class ChatView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private conn?: ProjectConnection;
  private authority?: string;
  private sessionId?: string;
  private runId?: string;
  private lastSeq = 0;
  private offs: Array<() => void> = [];

  constructor(private ctx: vscode.ExtensionContext, private fs: RemoteFs, private log: (m: string) => void) {}

  resolveWebviewView(v: vscode.WebviewView) {
    this.view = v;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    v.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = [...Array(24)].map(() => Math.random().toString(36)[2]).join('');
    const w = v.webview;
    w.html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${w.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css'))}"></head>
<body><div id="bar"><span id="status">…</span><select id="sessions"></select><button id="new" title="Nouveau chat">+ Nouveau</button></div>
<div id="log"></div>
<div id="composer"><textarea id="input" rows="3" placeholder="Message pour Claude (Ctrl+Entrée pour envoyer)"></textarea>
<div><button id="send">Envoyer</button><button id="stop" hidden>Arrêter</button></div></div>
<script nonce="${nonce}" src="${w.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js'))}"></script></body></html>`;
    w.onDidReceiveMessage((m: FromWebview) => this.onMsg(m).catch((e) => this.post({ type: 'error', text: String(e?.message || e) })));
    v.onDidDispose(() => { this.view = undefined; this.detach(); });
  }

  private post(m: unknown) { this.view?.webview.postMessage(m); }
  private detach() { this.offs.forEach((f) => f()); this.offs = []; this.conn = undefined; }

  private async attach() {
    const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === SCHEME);
    if (!folder) { this.post({ type: 'status', text: 'Ouvre un projet distant pour discuter.' }); return; }
    if (this.authority === folder.uri.authority && this.conn) return;
    this.detach();
    this.authority = folder.uri.authority;
    const c = await this.fs.conn(this.authority);
    this.conn = c;
    const onStatus = (s: string, d?: string) => this.post({ type: 'status', text: ({ connected: '● connecté', 'host-offline': '○ machine hôte hors ligne', connecting: '… reconnexion', 'auth-failed': '✖ ' + (d || 'mot de passe'), closed: '✖ fermé' } as any)[s] || s });
    const onAttached = (online: boolean) => { if (online) void this.resync(); };
    const onEvent = (e: any) => { if (e?.k === 'claude') this.onClaude(e); };
    c.on('status', onStatus); c.on('attached', onAttached); c.on('event', onEvent);
    this.offs.push(() => { c.off('status', onStatus); c.off('attached', onAttached); c.off('event', onEvent); });
    onStatus(c.state);
    if (c.state === 'connected') await this.resync();
  }

  private async resync() {
    if (!this.conn) return;
    try {
      const sessions = await this.conn.request<Array<{ id: string; title: string; mtime: number }>>('claude.sessions');
      this.post({ type: 'sessions', sessions, current: this.sessionId });
      if (this.runId) await this.catchUp();
      else {
        const runs = await this.conn.request<Array<{ runId: string; sessionId?: string; done: boolean }>>('claude.runs');
        const live = runs.find((r) => !r.done);
        if (live) { this.runId = live.runId; this.sessionId = live.sessionId; this.lastSeq = 0; this.post({ type: 'clear' }); await this.catchUp(); }
      }
    } catch (e: any) { this.log('chat resync : ' + e.message); }
  }

  private async catchUp() {
    if (!this.conn || !this.runId) return;
    const r = await this.conn.request<{ events: any[]; done: boolean }>('claude.poll', { runId: this.runId, after: this.lastSeq });
    for (const ev of r.events) this.applyEvent(ev);
  }

  private onClaude(e: { runId: string; seq: number; ev: any }) {
    if (e.runId !== this.runId) return;
    this.applyEvent({ ...e.ev, seq: e.seq });
  }
  private applyEvent(ev: any) {
    if (typeof ev.seq === 'number') { if (ev.seq <= this.lastSeq) return; this.lastSeq = ev.seq; }
    if ((ev.k === 'init' || ev.k === 'result') && ev.sessionId) this.sessionId = ev.sessionId;
    this.post({ type: 'ev', ev });
    if (ev.k === 'done') { this.post({ type: 'running', value: false }); void this.resync(); }
    else this.post({ type: 'running', value: true });
  }

  private async onMsg(m: FromWebview) {
    if (m.type === 'ready') return this.attach();
    if (!this.conn) await this.attach();
    if (!this.conn) return;
    if (m.type === 'newChat') { this.sessionId = undefined; this.runId = undefined; this.lastSeq = 0; this.post({ type: 'clear' }); this.post({ type: 'sessions-select', id: '' }); return; }
    if (m.type === 'select') {
      this.sessionId = m.id || undefined; this.runId = undefined; this.lastSeq = 0; this.post({ type: 'clear' });
      if (m.id) { const h = await this.conn.request<any[]>('claude.history', { sessionId: m.id }); this.post({ type: 'history', events: h }); }
      return;
    }
    if (m.type === 'send') {
      const r = await this.conn.request<{ runId: string }>('claude.send', { text: m.text, sessionId: this.sessionId });
      this.runId = r.runId; this.lastSeq = 0; this.post({ type: 'running', value: true });
      await this.catchUp();
      return;
    }
    if (m.type === 'stop' && this.runId) await this.conn.request('claude.stop', { runId: this.runId });
  }
}
