// Publie une release GitHub depuis ce poste (sans GitHub Actions).
// Prérequis : gh connecté (gh auth login), arbre git propre, version bumpée + section CHANGELOG.
// Usage (dans extension/) : npm run release            → tests + build + tag + release
//                            npm run release -- --skip-e2e
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(ext, '..');
const sh = (cmd, cwd = ext) => { console.log(`\n$ ${cmd}`); execSync(cmd, { cwd, stdio: 'inherit' }); };
const out = (cmd, cwd = ext) => execSync(cmd, { cwd, encoding: 'utf8' }).trim();
const die = (m) => { console.error('\n✗ ' + m); process.exit(1); };

const version = JSON.parse(readFileSync(path.join(ext, 'package.json'), 'utf8')).version;
const tag = `v${version}`;
console.log(`Release ${tag}`);

if (out('git status --porcelain', root)) die('arbre git non propre : commite d\'abord.');
if (out(`git tag -l ${tag}`, root)) die(`le tag ${tag} existe déjà : bumpe la version dans package.json.`);
const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
// section « ## [X.Y.Z] … » jusqu'au prochain titre « ## »
const lines = changelog.split(/\r?\n/);
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`) || l.startsWith(`## ${version}`));
const end = start < 0 ? -1 : lines.findIndex((l, i) => i > start && l.startsWith('## '));
const section = start < 0 ? '' : lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
if (!section) die(`aucune section « ## [${version}] » dans CHANGELOG.md.`);

sh('npm ci', path.join(root, 'relay'));
sh('npm ci');
sh('npm run typecheck');
sh('npm test');
if (!process.argv.includes('--skip-e2e')) sh('npm run test:e2e');
sh('npm run package');
const vsix = path.join(ext, `claude-remote-vscode-${version}.vsix`);
if (!existsSync(vsix)) die('vsix introuvable : ' + vsix);

const notes = path.join(ext, '.release-notes.md');
writeFileSync(notes, section + '\n');
sh(`git tag -a ${tag} -m "${tag}"`, root);
sh('git push', root);
sh(`git push origin ${tag}`, root);
sh(`gh release create ${tag} "${vsix}" --title ${tag} --notes-file "${notes}"`, root);
console.log(`\n✓ ${tag} publiée. Les extensions installées la proposeront à leur prochaine vérification.`);
