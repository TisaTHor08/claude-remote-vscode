import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Mises à jour via les GitHub Releases du dépôt (claudeRemote.updates.repo).
 * Au démarrage puis toutes les 12 h : si une release plus récente contient un .vsix,
 * on propose de l'installer (téléchargement + installation + rechargement de la fenêtre).
 */
const IGNORED_KEY = 'claudeRemote.updates.ignored';
const INTERVAL = 12 * 60 * 60 * 1000;

interface Release { tag_name: string; html_url: string; draft: boolean; prerelease: boolean; assets: { name: string; browser_download_url: string }[] }

/** -1 si a < b, 0 si égal, 1 si a > b (semver simple x.y.z, préfixe v toléré). */
export function compareVersions(a: string, b: string): number {
  const p = (v: string) => v.replace(/^v/i, '').split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) { if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1; }
  return 0;
}

export function setupUpdater(ctx: vscode.ExtensionContext, log: (m: string) => void) {
  const cfg = () => vscode.workspace.getConfiguration('claudeRemote.updates');
  const current = String(ctx.extension.packageJSON.version);
  let busy = false;

  async function latest(): Promise<Release> {
    const repo = cfg().get<string>('repo', 'TisaTHor08/claude-remote-vscode').trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`dépôt invalide : ${repo}`);
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'claude-remote-vscode-updater' },
    });
    if (r.status === 404) throw new Error('aucune release publiée (ou dépôt privé)');
    if (!r.ok) throw new Error(`GitHub a répondu ${r.status}`);
    return (await r.json()) as Release;
  }

  async function install(rel: Release, asset: Release['assets'][number]) {
    const url = new URL(asset.browser_download_url);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') throw new Error('URL de téléchargement inattendue : ' + url.href);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Claude Remote : installation de ${rel.tag_name}…` }, async () => {
      const r = await fetch(url, { headers: { 'User-Agent': 'claude-remote-vscode-updater' } });
      if (!r.ok) throw new Error(`téléchargement : HTTP ${r.status}`);
      const dir = ctx.globalStorageUri.fsPath;
      await fs.promises.mkdir(dir, { recursive: true });
      const file = path.join(dir, `claude-remote-vscode-${rel.tag_name.replace(/[^\w.-]/g, '')}.vsix`);
      await fs.promises.writeFile(file, Buffer.from(await r.arrayBuffer()));
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
    });
    log(`mise à jour ${current} → ${rel.tag_name} installée`);
    const a = await vscode.window.showInformationMessage(`Claude Remote ${rel.tag_name} installé. Recharger la fenêtre pour l'activer ?`, 'Recharger');
    if (a === 'Recharger') await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  async function check(manual: boolean) {
    if (busy) return; busy = true;
    try {
      const rel = await latest();
      const asset = rel.assets.find((a) => a.name.endsWith('.vsix'));
      if (rel.draft || rel.prerelease || !asset || compareVersions(rel.tag_name, current) <= 0) {
        log(`mises à jour : ${current} est à jour (dernière : ${rel.tag_name})`);
        if (manual) vscode.window.showInformationMessage(`Claude Remote ${current} est à jour.`);
        return;
      }
      if (!manual && ctx.globalState.get<string>(IGNORED_KEY) === rel.tag_name) return;
      const choice = await vscode.window.showInformationMessage(
        `Claude Remote ${rel.tag_name} est disponible (installée : ${current}).`, 'Mettre à jour', 'Notes de version', 'Ignorer cette version');
      if (choice === 'Mettre à jour') await install(rel, asset);
      else if (choice === 'Notes de version') { await vscode.env.openExternal(vscode.Uri.parse(rel.html_url)); }
      else if (choice === 'Ignorer cette version') await ctx.globalState.update(IGNORED_KEY, rel.tag_name);
    } catch (e: any) {
      log('mises à jour : ' + (e?.message || e));
      if (manual) vscode.window.showWarningMessage('Claude Remote : vérification impossible — ' + (e?.message || e));
    } finally { busy = false; }
  }

  ctx.subscriptions.push(vscode.commands.registerCommand('claudeRemote.checkUpdates', () => check(true)));
  if (ctx.extensionMode !== vscode.ExtensionMode.Production) return; // pas de vérification auto en dev / tests
  const auto = () => { if (cfg().get<boolean>('check', true)) void check(false); };
  const first = setTimeout(auto, 15000);
  const every = setInterval(auto, INTERVAL);
  ctx.subscriptions.push({ dispose: () => { clearTimeout(first); clearInterval(every); } });
}
