// Test manuel avec le VRAI Claude Code de la machine hôte (consomme quelques tokens du compte connecté).
// relais + hôte (ClaudeRunner réel, binaire détecté automatiquement) + client distant.
// Usage : npm run test:claude    (CLAUDE_PATH=… pour forcer le binaire)
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const core = require('../out-test/core.js');

const PORT = 18788, URL = `ws://127.0.0.1:${PORT}/ws`, TOKEN = 'y'.repeat(40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await f(); if (v) return v; await sleep(200); } throw new Error('délai dépassé'); };
const ok = (m) => console.log('  ✓', m);

async function ask(conn, text, sessionId) {
  const { runId } = await conn.request('claude.send', { text, sessionId });
  const evs = [];
  let after = 0;
  for (const t = Date.now(); Date.now() - t < 180000;) {
    const r = await conn.request('claude.poll', { runId, after });
    for (const e of r.events) { evs.push(e); after = e.seq; if (e.k === 'tool') console.log('    [outil]', e.name || '', String(e.input).slice(0, 100)); }
    if (r.done) break;
    await sleep(500);
  }
  const res = evs.find((e) => e.k === 'result');
  const answer = evs.filter((e) => e.k === 'text').map((e) => e.text).join('');
  return { evs, res, text: answer, sessionId: evs.find((e) => e.sessionId)?.sessionId };
}

(async () => {
  const relay = spawn(process.execPath, [path.join(__dirname, '../../relay/server.js')], { env: { ...process.env, PORT, RELAY_TOKEN: TOKEN }, stdio: 'ignore' });
  try {
    await until(async () => (await core.listProjects(URL, TOKEN).catch(() => null)) !== null, 8000);
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-claude-')));
    const secret = 'ZEBRE-' + Math.floor(Math.random() * 1e6);
    fs.writeFileSync(path.join(root, 'secret.txt'), secret + '\n');

    const bin = core.resolveClaudeBinary(process.env.CLAUDE_PATH);
    console.log('  binaire claude de l\'hôte :', bin);
    const keys = await core.deriveKeys('mot-de-passe-test-claude', core.newSalt());
    const runner = new core.ClaudeRunner(root, { claudePath: bin, permissionMode: 'acceptEdits', allowedTools: ['Read', 'Glob', 'Grep'] });
    const id = core.newProjectId('Test Claude');
    const host = new core.HostCore({ url: URL, token: TOKEN, projectId: id, name: 'Test Claude', root, keys, runner });
    host.start();
    await until(async () => (await core.listProjects(URL, TOKEN)).some((p) => p.id === id && p.online), 10000);

    const conn = new core.ProjectConnection(URL, TOKEN, id, async (salt) => core.deriveKeys('mot-de-passe-test-claude', salt));
    conn.start();
    await until(() => conn.state === 'connected', 15000);
    ok('client distant connecté');

    const a = await ask(conn, 'Lis le fichier secret.txt de ce projet et réponds UNIQUEMENT par son contenu exact, sans rien d\'autre.');
    if (!a.res || !a.res.ok) console.log('    évènements :', JSON.stringify(a.evs).slice(0, 1500));
    assert.ok(a.text.includes(secret), `réponse inattendue : ${a.text}`);
    assert.ok(a.evs.some((e) => e.k === 'tool'), 'aucun outil utilisé');
    ok(`Claude (sur l'hôte) a lu le fichier via un outil et répondu : ${a.text.trim()}`);

    const b = await ask(conn, 'Quel était ce contenu ? Réponds uniquement par lui.', a.sessionId);
    assert.ok(b.text.includes(secret), `reprise sans contexte : ${b.text}`);
    ok('reprise du même chat (--resume) : le contexte est conservé');

    const sessions = await conn.request('claude.sessions');
    assert.ok(sessions.some((s) => s.id === a.sessionId || s.sessionId === a.sessionId), 'chat absent de la liste');
    ok('le chat apparaît dans la liste des chats de l\'hôte');

    conn.stop(); host.stop();
    console.log('\nCLAUDE RÉEL OK : le Claude Code de l\'hôte est utilisable depuis le client distant.');
    process.exitCode = 0;
  } catch (e) {
    console.error('ÉCHEC :', e); process.exitCode = 1;
  } finally { relay.kill(); setTimeout(() => process.exit(), 300); }
})();
