import * as vscode from 'vscode';
import * as path from 'path';
import {
  ClaudeRunner, HostCore, Keys, StoredKeys, deriveKeys, newProjectId, newSalt, parseKeys, passwordProblem, serializeKeys, ProjectInfo,
} from './core';
import { RemoteFs, SCHEME, Relay, makeKeysProvider } from './remoteFs';
import { ChatView, ProjectsProvider } from './views';
import { ProjectConnection } from './core';

interface HostRecord { projectId: string; name: string; root: string }
const HOSTS_KEY = 'claudeRemote.hosts';
const TOKEN_KEY = 'claudeRemote.token';
const hostSecretKey = (id: string) => `claudeRemote.host.${id}`;

export function activate(ctx: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel('Claude Remote');
  const log = (m: string) => out.appendLine(`${new Date().toLocaleTimeString()} ${m}`);
  ctx.subscriptions.push(out);

  const getRelay = async (): Promise<Relay | undefined> => {
    const url = vscode.workspace.getConfiguration('claudeRemote').get<string>('relayUrl', '').trim();
    const token = await ctx.secrets.get(TOKEN_KEY);
    return url && token ? { url, token } : undefined;
  };

  // ------------------------------------------------------------------ côté « visionneur »
  const remoteFs = new RemoteFs(ctx.secrets, getRelay, log);
  ctx.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, remoteFs, { isCaseSensitive: true }),
    { dispose: () => remoteFs.dispose() },
  );
  const projects = new ProjectsProvider(getRelay, log);
  ctx.subscriptions.push(
    { dispose: () => projects.dispose() },
    vscode.window.registerTreeDataProvider('claudeRemote.projects', projects),
    vscode.window.registerWebviewViewProvider('claudeRemote.chat', new ChatView(ctx, remoteFs, log), { webviewOptions: { retainContextWhenHidden: true } }),
  );

  const remoteFolder = () => vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === SCHEME);
  const setCtx = () => vscode.commands.executeCommand('setContext', 'claudeRemote.inRemote', !!remoteFolder());
  setCtx();
  ctx.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(setCtx));

  // barre d'état
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  ctx.subscriptions.push(bar);
  let hostState = '';
  const refreshBar = () => {
    const rf = remoteFolder();
    if (rf) {
      const st = remoteFs.existing(rf.uri.authority)?.state ?? 'connecting';
      const label = ({ connected: 'connecté', 'host-offline': 'machine hôte hors ligne', connecting: 'reconnexion…', 'auth-failed': 'mot de passe refusé', closed: 'fermé' } as any)[st];
      bar.text = `$(plug) ${rf.name}: ${label}`; bar.command = 'claudeRemote.showLog'; bar.show(); return;
    }
    if (hostState) { bar.text = `$(cloud) Claude Remote: ${hostState}`; bar.command = 'claudeRemote.stopSharing'; bar.tooltip = 'Cliquer pour arrêter la synchronisation'; bar.show(); return; }
    if (vscode.workspace.workspaceFolders?.length) { bar.text = '$(cloud-upload) Synchroniser'; bar.command = 'claudeRemote.share'; bar.tooltip = 'Rendre ce projet accessible depuis un autre VS Code'; bar.show(); return; }
    bar.hide();
  };
  remoteFs.statusEmitter.on('status', refreshBar);
  ctx.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(refreshBar));
  const barTimer = setInterval(refreshBar, 3000); ctx.subscriptions.push({ dispose: () => clearInterval(barTimer) });

  // ------------------------------------------------------------------ côté « hôte »
  let host: HostCore | undefined;
  let watcher: vscode.FileSystemWatcher | undefined;

  const runnerFor = (root: string) => {
    const cfg = () => vscode.workspace.getConfiguration('claudeRemote.claude');
    const opts = () => ({ claudePath: cfg().get<string>('path') || undefined, permissionMode: cfg().get<string>('permissionMode', 'acceptEdits'), allowedTools: cfg().get<string[]>('allowedTools', []), log });
    const r = new ClaudeRunner(root, opts());
    ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('claudeRemote.claude')) r.updateOptions(opts()); }));
    return r;
  };

  async function startHost(rec: HostRecord, keys: Keys) {
    const relay = await getRelay();
    if (!relay) { vscode.window.showWarningMessage('Claude Remote : relais non configuré.'); return; }
    host?.stop(); watcher?.dispose();
    host = new HostCore({ url: relay.url, token: relay.token, projectId: rec.projectId, name: rec.name, root: rec.root, keys, runner: runnerFor(rec.root), log });
    host.on('status', (s: string, d?: string) => {
      hostState = s === 'online' ? 'partagé' : s === 'reconnecting' ? 'reconnexion…' : s === 'fatal' ? 'token refusé' : 'erreur ' + (d || '');
      if (s === 'fatal') vscode.window.showErrorMessage('Claude Remote : ' + d + ' Vérifie « Configurer le relais ».');
      refreshBar();
    });
    host.start();
    hostState = 'connexion…'; refreshBar();
    const pat = new vscode.RelativePattern(rec.root, '**/*');
    watcher = vscode.workspace.createFileSystemWatcher(pat);
    const fwd = (kind: 1 | 2 | 3) => (u: vscode.Uri) => {
      const rel = path.relative(rec.root, u.fsPath);
      if (rel.startsWith('..') || /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(rel)) return;
      host?.notifyFsChange(rel, kind);
    };
    watcher.onDidChange(fwd(1)); watcher.onDidCreate(fwd(2)); watcher.onDidDelete(fwd(3));
    log(`partage de ${rec.root} sous ${rec.projectId}`);
  }

  ctx.subscriptions.push({ dispose: () => { host?.stop(); watcher?.dispose(); } });
  const hosts = () => ctx.globalState.get<HostRecord[]>(HOSTS_KEY, []);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeRemote.configure', async () => {
      const cur = vscode.workspace.getConfiguration('claudeRemote').get<string>('relayUrl', '');
      const url = await vscode.window.showInputBox({ title: 'URL du relais', value: cur, placeHolder: 'wss://remote.exemple.fr/claude-remote/ws', ignoreFocusOut: true,
        validateInput: (v) => (/^wss?:\/\/.+/.test(v.trim()) ? undefined : 'Doit commencer par wss:// (ou ws:// en local).') });
      if (!url) return;
      const token = await vscode.window.showInputBox({ title: 'Token du relais (RELAY_TOKEN)', password: true, ignoreFocusOut: true, validateInput: (v) => (v.length >= 24 ? undefined : 'Au moins 24 caractères.') });
      if (!token) return;
      await vscode.workspace.getConfiguration('claudeRemote').update('relayUrl', url.trim(), vscode.ConfigurationTarget.Global);
      await ctx.secrets.store(TOKEN_KEY, token);
      vscode.window.showInformationMessage('Claude Remote : relais configuré.');
      projects.refresh();
    }),

    vscode.commands.registerCommand('claudeRemote.share', async () => {
      const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file');
      if (!folder) { vscode.window.showWarningMessage('Ouvre d\'abord un dossier de projet.'); return; }
      if (!(await getRelay())) { await vscode.commands.executeCommand('claudeRemote.configure'); if (!(await getRelay())) return; }
      const name = await vscode.window.showInputBox({ title: 'Nom du projet partagé', value: path.basename(folder.uri.fsPath), ignoreFocusOut: true });
      if (!name) return;
      const pw = await vscode.window.showInputBox({ title: 'Mot de passe de synchronisation', prompt: 'Il sera exigé sur tout autre poste pour ouvrir ce projet. 12 caractères minimum.', password: true, ignoreFocusOut: true, validateInput: (v) => passwordProblem(v) });
      if (!pw) return;
      const pw2 = await vscode.window.showInputBox({ title: 'Confirme le mot de passe', password: true, ignoreFocusOut: true, validateInput: (v) => (v === pw ? undefined : 'Ne correspond pas.') });
      if (!pw2) return;
      const existing = hosts().find((h) => h.root === folder.uri.fsPath);
      const rec: HostRecord = { projectId: existing?.projectId ?? newProjectId(name), name, root: folder.uri.fsPath };
      const keys = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Dérivation de la clé…' }, () => deriveKeys(pw, newSalt()));
      await ctx.secrets.store(hostSecretKey(rec.projectId), JSON.stringify(serializeKeys(keys)));
      await ctx.globalState.update(HOSTS_KEY, [...hosts().filter((h) => h.root !== rec.root), rec]);
      await startHost(rec, keys);
      vscode.window.showInformationMessage(`« ${name} » est synchronisé. Depuis un autre VS Code : Claude Remote > Projets connectés.`);
    }),

    vscode.commands.registerCommand('claudeRemote.stopSharing', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      const rec = folder && hosts().find((h) => h.root === folder.uri.fsPath);
      host?.stop(true); host = undefined; watcher?.dispose(); watcher = undefined; hostState = '';
      if (rec) { await ctx.secrets.delete(hostSecretKey(rec.projectId)); await ctx.globalState.update(HOSTS_KEY, hosts().filter((h) => h.projectId !== rec.projectId)); }
      refreshBar();
      vscode.window.showInformationMessage('Synchronisation arrêtée : le projet n\'est plus accessible à distance.');
    }),

    vscode.commands.registerCommand('claudeRemote.refresh', () => projects.refresh()),

    vscode.commands.registerCommand('claudeRemote.openProject', async (p?: ProjectInfo) => {
      const relay = await getRelay();
      if (!relay) { await vscode.commands.executeCommand('claudeRemote.configure'); return; }
      if (!p) {
        const { listProjects } = await import('./core');
        const l = await listProjects(relay.url, relay.token).catch((e) => { vscode.window.showErrorMessage('Relais : ' + e.message); return [] as ProjectInfo[]; });
        const pick = await vscode.window.showQuickPick(l.map((x) => ({ label: x.name, description: x.online ? 'en ligne' : 'hors ligne', p: x })), { title: 'Projet à ouvrir' });
        if (!pick) return; p = pick.p;
      }
      // authentification dans cette fenêtre (les clés vont dans le trousseau partagé), puis ouverture dans une nouvelle fenêtre
      const ok = await new Promise<boolean>((resolve) => {
        const c = new ProjectConnection(relay.url, relay.token, p!.id, makeKeysProvider(ctx.secrets, p!.id, p!.name));
        const t = setTimeout(() => { c.stop(); vscode.window.showErrorMessage('Relais injoignable.'); resolve(false); }, 30000);
        c.on('status', (s: string, d?: string) => {
          if (s === 'connected' || s === 'host-offline') { clearTimeout(t); c.stop(); resolve(true); }
          else if (s === 'auth-failed' || s === 'closed') { clearTimeout(t); vscode.window.showErrorMessage('Claude Remote : ' + (d || s)); resolve(false); }
        });
        c.start();
      });
      if (!ok) return;
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.from({ scheme: SCHEME, authority: p.id, path: '/' }), { forceNewWindow: true });
    }),

    vscode.commands.registerCommand('claudeRemote.forgetPassword', async () => {
      const rf = remoteFolder();
      if (!rf) { vscode.window.showInformationMessage('Aucun projet distant ouvert dans cette fenêtre.'); return; }
      await ctx.secrets.delete(`claudeRemote.viewer.${rf.uri.authority}`);
      remoteFs.existing(rf.uri.authority)?.stop();
      vscode.window.showInformationMessage('Mot de passe oublié. Il sera redemandé à la prochaine connexion (recharge la fenêtre).');
    }),

    vscode.commands.registerCommand('claudeRemote.showLog', () => out.show()),
  );

  // reprise automatique du partage au démarrage (clés dérivées mémorisées : pas de mot de passe à ressaisir)
  const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file');
  const rec = folder && hosts().find((h) => h.root === folder.uri.fsPath);
  if (rec && vscode.workspace.getConfiguration('claudeRemote').get<boolean>('autoResume', true)) {
    Promise.resolve(ctx.secrets.get(hostSecretKey(rec.projectId))).then((raw) => { if (raw) return startHost(rec, parseKeys(JSON.parse(raw) as StoredKeys)); }).catch((e: unknown) => log('reprise : ' + e));
  }
  refreshBar();
}

export function deactivate() { /* les connexions sont fermées via ctx.subscriptions */ }
