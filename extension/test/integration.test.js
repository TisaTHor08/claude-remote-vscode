const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const core = require('../out-test/core.js');

const PORT = 18787, URL = `ws://127.0.0.1:${PORT}/ws`, TOKEN = 'x'.repeat(40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await f(); if (v) return v; await sleep(50); } throw new Error('timeout until()'); };
let pass = 0; const ok = (name) => { pass++; console.log('  ✓', name); };

(async () => {
  const relay = spawn('node', [path.join(__dirname, '../../relay/server.js')], { env: { ...process.env, PORT, RELAY_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'inherit'] });
  await until(() => new Promise((r) => { const w = new (require('ws'))(URL); w.on('open', () => { w.close(); r(true); }); w.on('error', () => r(false)); }), 8000);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-proj-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-out-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'bonjour');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
  try { fs.symlinkSync(outside, path.join(root, 'evil')); } catch {}
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-home-'));
  process.env.HOME = home; process.env.USERPROFILE = home;

  const password = 'correct horse battery';
  const keys = await core.deriveKeys(password, core.newSalt());
  const runner = new core.ClaudeRunner(root, { claudePath: path.join(__dirname, 'fake-claude.js'), permissionMode: 'acceptEdits', allowedTools: ['Read', 'Bash(git status *)'] });
  const id = core.newProjectId('Mon Projet');
  const host = new core.HostCore({ url: URL, token: TOKEN, projectId: id, name: 'Mon Projet', root, keys, runner });
  host.start();

  // 0. mauvais token refusé
  await new Promise((res, rej) => { const w = new (require('ws'))(URL); w.on('open', () => w.send(JSON.stringify({ t: 'hello', role: 'viewer', token: 'nope' }))); w.on('close', (c) => (c === 4401 ? res() : rej(new Error('code ' + c)))); });
  ok('token relais invalide refusé');

  // 1. liste
  const projects = await until(async () => { const l = await core.listProjects(URL, TOKEN); return l.find((p) => p.id === id && p.online) && l; });
  assert.equal(projects[0].name, 'Mon Projet'); ok('projet listé et en ligne');

  // 2. mauvais mot de passe
  const bad = new core.ProjectConnection(URL, TOKEN, id, async (salt) => core.deriveKeys('mauvais mot de passe!!', salt));
  const badStatus = new Promise((r) => bad.on('status', (s) => s === 'auth-failed' && r(true)));
  bad.start(); await badStatus; ok('mauvais mot de passe refusé'); bad.stop();

  // 3. bon mot de passe
  const conn = new core.ProjectConnection(URL, TOKEN, id, async (salt) => core.deriveKeys(password, salt));
  const events = []; conn.on('event', (e) => events.push(e));
  conn.start(); await until(() => conn.state === 'connected'); ok('connexion avec le bon mot de passe');

  const rd = await conn.request('fs.readDirectory', { path: '/' });
  assert.ok(rd.find(([n]) => n === 'a.txt')); ok('readDirectory');
  assert.equal(Buffer.from((await conn.request('fs.readFile', { path: '/a.txt' })).data, 'base64').toString(), 'bonjour'); ok('readFile');
  await conn.request('fs.writeFile', { path: '/sub/new.txt', data: Buffer.from('salut').toString('base64'), create: true, overwrite: true });
  assert.equal(fs.readFileSync(path.join(root, 'sub/new.txt'), 'utf8'), 'salut'); ok('writeFile (création)');
  await assert.rejects(conn.request('fs.writeFile', { path: '/sub/new.txt', data: '', create: true, overwrite: false }), /existe/); ok('création sans overwrite refusée');
  await conn.request('fs.rename', { from: '/sub/new.txt', to: '/sub/renamed.txt', overwrite: false });
  const st = await conn.request('fs.stat', { path: '/sub/renamed.txt' }); assert.equal(st.type, 1); ok('rename + stat');
  await conn.request('fs.delete', { path: '/sub/renamed.txt', recursive: false }); assert.ok(!fs.existsSync(path.join(root, 'sub/renamed.txt'))); ok('delete');

  // 4. sécurité des chemins
  for (const p of ['/../etc/passwd', '/sub/../../x', '/evil/secret.txt', '/a.txt\0']) {
    await assert.rejects(conn.request('fs.readFile', { path: p }), (e) => ['NoPermissions', 'FileNotFound'].includes(e.code), 'devrait refuser ' + p);
  }
  await assert.rejects(conn.request('fs.delete', { path: '/', recursive: true }), /prot/); ok('traversée de répertoire, symlink sortant et racine bloqués');
  await assert.rejects(conn.request('fs.readFile', { path: '/nexiste.pas' }), (e) => e.code === 'FileNotFound'); ok('FileNotFound propagé');

  // 5. évènements fichiers
  host.notifyFsChange('sub\\x.txt', 1);
  const fsev = await until(() => events.find((e) => e.k === 'fs')); assert.deepEqual(fsev.changes[0], ['/sub/x.txt', 1]); ok('évènements fichiers (chemins Windows normalisés)');

  // 6. chat Claude
  const { runId } = await conn.request('claude.send', { text: 'Dis bonjour', sessionId: undefined });
  await until(() => events.find((e) => e.k === 'claude' && e.ev.k === 'done'));
  const ce = events.filter((e) => e.k === 'claude').map((e) => e.ev);
  assert.ok(ce.find((e) => e.k === 'text' && e.text === 'echo: Dis bonjour')); assert.ok(ce.find((e) => e.k === 'tool' && e.name === 'Read'));
  assert.ok(ce.find((e) => e.k === 'toolres' && e.ok)); assert.ok(ce.find((e) => e.k === 'result' && e.ok)); ok('chat Claude en streaming (texte, outil, résultat)');
  const polled = await conn.request('claude.poll', { runId, after: 0 }); assert.ok(polled.done && polled.events.length >= 5); ok('rattrapage par poll après coupure');
  const sessId = '11111111-2222-3333-4444-555555555555';
  // transcript factice pour lister/relire l'historique
  const sdir = core.sessionsDirFor(root); fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, sessId + '.jsonl'), [{ type: 'user', message: { role: 'user', content: 'Première question' } }, { type: 'assistant', message: { content: [{ type: 'text', text: 'Réponse' }] } }].map((x) => JSON.stringify(x)).join('\n'));
  const sess = await conn.request('claude.sessions'); assert.equal(sess[0].title, 'Première question'); ok('liste des chats existants');
  const hist = await conn.request('claude.history', { sessionId: sessId }); assert.equal(hist.length, 2); ok('historique d\'un chat');
  events.length = 0;
  await conn.request('claude.send', { text: 'suite', sessionId: sessId });
  await until(() => events.find((e) => e.k === 'claude' && e.ev.k === 'done')); ok('reprise d\'un chat (--resume)');

  // 7. coupure réseau côté viewer : reconnexion + ré-authentification automatiques
  let attached = 0; conn.on('attached', () => attached++);
  conn.kick(); await until(() => attached >= 1, 10000);
  assert.equal(Buffer.from((await conn.request('fs.readFile', { path: '/a.txt' })).data, 'base64').toString(), 'bonjour'); ok('reconnexion viewer automatique');

  // 8. coupure côté hôte : requête en attente rejouée dès son retour
  host.kick();
  const r = await conn.request('fs.readFile', { path: '/a.txt' }, { timeoutMs: 15000 }); assert.ok(r.data); ok('reconnexion hôte automatique (lecture rejouée)');

  // 9. hôte arrêté -> offline ; relancé -> reprend
  host.stop();
  await until(() => conn.state === 'host-offline'); ok('hôte hors ligne détecté');
  await assert.rejects(conn.request('fs.readDirectory', { path: '/' }, { timeoutMs: 500 }), /délai|hors ligne/);
  const host2 = new core.HostCore({ url: URL, token: TOKEN, projectId: id, name: 'Mon Projet', root, keys, runner }); host2.start();
  await until(() => conn.state === 'connected'); assert.ok((await conn.request('fs.readDirectory', { path: '/' })).length); ok('hôte relancé : session reprise sans nouvelle saisie');

  // 10. changement de mot de passe côté hôte : l'ancien viewer ne passe plus
  host2.stop();
  const keys2 = await core.deriveKeys('un tout nouveau mot de passe', core.newSalt());
  const host3 = new core.HostCore({ url: URL, token: TOKEN, projectId: id, name: 'Mon Projet', root, keys: keys2, runner }); host3.start();
  const stale = new core.ProjectConnection(URL, TOKEN, id, async (salt) => core.deriveKeys(password, salt));
  const sp = new Promise((r2) => stale.on('status', (s) => s === 'auth-failed' && r2(true)));
  await sleep(300); stale.start(); await sp; ok('ancien mot de passe invalide après re-synchronisation'); stale.stop();

  // 11. verrouillage anti brute-force (5 échecs)
  let locked = false;
  for (let i = 0; i < 3 && !locked; i++) {
    const c = new core.ProjectConnection(URL, TOKEN, id, async (salt) => core.deriveKeys('essai numero ' + i + ' xxxx', salt));
    c.on('status', (s, d) => { if (s === 'auth-failed' && /essais/.test(d || '')) locked = true; });
    c.start(); await until(() => c.state === 'auth-failed' || c.state === 'closed', 20000); c.stop();
  }
  assert.ok(locked); ok('verrouillage après trop d\'essais');

  conn.stop(); host3.stop(); relay.kill();
  console.log(`\n${pass} vérifications OK`);
  process.exit(0);
})().catch((e) => { console.error('ÉCHEC :', e); process.exit(1); });
