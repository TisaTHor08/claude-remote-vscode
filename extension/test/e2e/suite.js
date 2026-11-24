// Exécuté À L'INTÉRIEUR de chaque VS Code de test (rôle via E2E_ROLE).
'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const E = process.env;
const BASE = E.E2E_BASE, PROJECT = E.E2E_PROJECT, PW = E.E2E_PASSWORD, ROLE = E.E2E_ROLE;
const READY = path.join(BASE, 'host-ready.json'), DONE = path.join(BASE, 'client-done.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${ROLE}] ${m}`);
const ok = (m) => console.log(`[${ROLE}]   ✓ ${m}`);
async function until(fn, ms = 60000, what = 'condition') {
  const t = Date.now();
  for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t > ms) throw new Error('délai dépassé : ' + what); await sleep(250); }
}

async function activate() {
  const ext = vscode.extensions.getExtension('tisathor08.claude-remote-vscode');
  assert.ok(ext, 'extension introuvable');
  await ext.activate();
  ok('extension activée');
}

async function host() {
  await activate();
  assert.equal(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath.toLowerCase(), PROJECT.toLowerCase());
  const projectId = await vscode.commands.executeCommand('claudeRemote.share', { name: 'Projet E2E', password: PW });
  assert.ok(projectId, 'partage non démarré');
  ok(`projet partagé (${projectId})`);
  fs.writeFileSync(READY, JSON.stringify({ projectId }));
  const res = await until(() => fs.existsSync(DONE) && JSON.parse(fs.readFileSync(DONE, 'utf8')), 180000, 'fin du client');
  if (!res.ok) throw new Error('le client a échoué : ' + res.error);
  // l'hôte vérifie de son côté ce que le client a écrit
  assert.equal(fs.readFileSync(path.join(PROJECT, 'src', 'depuis-client.txt'), 'utf8'), 'écrit depuis le client');
  assert.equal(fs.readFileSync(path.join(PROJECT, 'README.md'), 'utf8'), '# Projet E2E\nLigne ajoutée dans l\'éditeur du client\n');
  ok('modifications du client présentes sur le disque de l\'hôte');
  await vscode.commands.executeCommand('claudeRemote.stopSharing');
}

async function client() {
  await activate();
  const { projectId } = await until(() => fs.existsSync(READY) && JSON.parse(fs.readFileSync(READY, 'utf8')), 120000, 'hôte prêt');
  const p = { id: projectId, name: 'Projet E2E', online: true };

  const first = await vscode.commands.executeCommand('claudeRemote.openProject', p, { password: PW, open: false });
  assert.equal(first, true); ok('relais joignable, bon mot de passe accepté');
  const bad = await vscode.commands.executeCommand('claudeRemote.openProject', p, { password: 'mauvais-mot-de-passe', open: false });
  assert.equal(bad, false); ok('mauvais mot de passe refusé');
  const good = await vscode.commands.executeCommand('claudeRemote.openProject', p, { password: PW, open: false });
  assert.equal(good, true); ok('connexion avec le bon mot de passe');

  const root = vscode.Uri.from({ scheme: 'claude-remote', authority: projectId, path: '/' });
  const at = (p) => vscode.Uri.joinPath(root, p);
  const dec = (b) => Buffer.from(b).toString('utf8');

  const entries = (await vscode.workspace.fs.readDirectory(root)).map(([n]) => n).sort();
  assert.deepEqual(entries, ['README.md', 'src']); ok('arborescence lue : ' + entries.join(', '));
  assert.equal(dec(await vscode.workspace.fs.readFile(at('src/app.js'))), 'module.exports = 42;\n'); ok('lecture de fichier');

  await vscode.workspace.fs.writeFile(at('src/depuis-client.txt'), Buffer.from('écrit depuis le client'));
  ok('écriture de fichier');
  await vscode.workspace.fs.createDirectory(at('dossier'));
  await vscode.workspace.fs.writeFile(at('dossier/a.txt'), Buffer.from('a'));
  await vscode.workspace.fs.rename(at('dossier/a.txt'), at('dossier/b.txt'));
  const st = await vscode.workspace.fs.stat(at('dossier/b.txt'));
  assert.equal(st.type, vscode.FileType.File); assert.equal(st.size, 1); ok('création de dossier, renommage, stat');
  await vscode.workspace.fs.delete(at('dossier'), { recursive: true });
  await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(at('dossier'))), (e) => e.code === 'FileNotFound'); ok('suppression + FileNotFound');

  // modification faite sur la machine hôte → visible côté client
  fs.writeFileSync(path.join(PROJECT, 'src', 'app.js'), 'module.exports = 43;\n');
  assert.equal(dec(await vscode.workspace.fs.readFile(at('src/app.js'))), 'module.exports = 43;\n'); ok('modification côté hôte visible côté client');

  // vrai éditeur : ouvrir le dossier distant dans l'espace de travail, éditer dans un onglet, enregistrer
  vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders.length, 0, { uri: root, name: 'Projet E2E (distant)' });
  await until(() => vscode.workspace.workspaceFolders?.some((f) => f.uri.scheme === 'claude-remote'), 20000, 'dossier distant ajouté');
  ok('dossier distant ouvert dans l\'espace de travail');
  const doc = await vscode.workspace.openTextDocument(at('README.md'));
  const editor = await vscode.window.showTextDocument(doc);
  assert.equal(doc.getText(), '# Projet E2E\n');
  await editor.edit((e) => e.insert(new vscode.Position(1, 0), 'Ligne ajoutée dans l\'éditeur du client\n'));
  assert.ok(await doc.save(), 'enregistrement refusé'); ok('fichier distant ouvert, édité et enregistré dans l\'éditeur');
}

exports.run = async function () {
  log('démarrage');
  try {
    if (ROLE === 'host') await host(); else await client();
    if (ROLE === 'client') fs.writeFileSync(DONE, JSON.stringify({ ok: true }));
    log('TERMINÉ OK');
  } catch (e) {
    console.error(`[${ROLE}] ÉCHEC :`, e && e.stack || e);
    if (ROLE === 'client') fs.writeFileSync(DONE, JSON.stringify({ ok: false, error: String(e && e.message || e) }));
    throw e;
  }
};
