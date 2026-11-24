// Test de bout en bout : un vrai relais + deux VRAIS VS Code (hôte et client) avec l'extension chargée.
// Usage : npm run test:e2e   (CODE_EXE=chemin\Code.exe pour utiliser un VS Code installé, sinon téléchargé)
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const { runTests } = require('@vscode/test-electron');

// lancé depuis un terminal VS Code, ces variables feraient démarrer Code.exe en mode Node, sans fenêtre
for (const k of Object.keys(process.env)) if (/^(ELECTRON_|VSCODE_)/.test(k)) delete process.env[k];

const EXT = path.resolve(__dirname, '../..');
const TOKEN = 'e2e-token-' + require('crypto').randomBytes(16).toString('hex');
const PASSWORD = 'mot-de-passe-e2e-solide';

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  // dossier court : le canal IPC de VS Code dérive du user-data-dir et casse sur les chemins trop longs (Windows)
  const base = process.platform === 'win32' ? fs.mkdtempSync('C:\\crE2E-') : fs.mkdtempSync(path.join(os.tmpdir(), 'crE2E-'));
  const project = path.join(base, 'projet');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'README.md'), '# Projet E2E\n');
  fs.writeFileSync(path.join(project, 'src', 'app.js'), 'module.exports = 42;\n');
  // le client a déjà un dossier local en 1er : ajouter le dossier distant en 2e ne redémarre pas l'hôte d'extensions
  fs.mkdirSync(path.join(base, 'local-client'));
  fs.writeFileSync(path.join(base, 'client.code-workspace'), JSON.stringify({ folders: [{ path: 'local-client' }] }));

  const port = await freePort();
  const relay = spawn(process.execPath, [path.resolve(EXT, '../relay/server.js')], { env: { ...process.env, PORT: String(port), RELAY_TOKEN: TOKEN }, stdio: 'inherit' });
  await new Promise((r) => setTimeout(r, 800));
  const relayUrl = `ws://127.0.0.1:${port}/ws`;

  const profile = (role, extra = {}) => {
    const ud = path.join(base, role);
    fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
    fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({ 'claudeRemote.relayUrl': relayUrl, 'security.workspace.trust.enabled': false, ...extra }));
    return ud;
  };
  const env = { CLAUDE_REMOTE_RELAY_TOKEN: TOKEN, E2E_BASE: base, E2E_PROJECT: project, E2E_PASSWORD: PASSWORD, E2E_RELAY: relayUrl };
  const common = { extensionDevelopmentPath: EXT, extensionTestsPath: path.join(__dirname, 'suite.js') };
  if (process.env.CODE_EXE) common.vscodeExecutablePath = process.env.CODE_EXE;

  const run = (role, workspace, extraSettings) => runTests({
    ...common,
    extensionTestsEnv: { ...env, E2E_ROLE: role },
    launchArgs: [workspace, '--user-data-dir', profile(role, extraSettings), '--extensions-dir', path.join(base, role + '-ext'), '--disable-extensions', '--disable-workspace-trust', '--new-window'],
  }).then(() => 0, (e) => { console.error(`[${role}] échec :`, e?.message || e); return 1; });

  let code = 1;
  try {
    const fake = path.join(EXT, 'test', 'fake-claude.js');
    const results = await Promise.all([
      run('host', project, { 'claudeRemote.claude.path': fake }),
      run('client', path.join(base, 'client.code-workspace')),
    ]);
    code = results.every((r) => r === 0) ? 0 : 1;
  } finally {
    relay.kill();
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  }
  console.log(code === 0 ? '\nE2E OK : hôte et client VS Code réels communiquent via le relais.' : '\nE2E EN ÉCHEC');
  process.exit(code);
})().catch((e) => { console.error(e); process.exit(1); });
