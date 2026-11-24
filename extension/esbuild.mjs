import { build } from 'esbuild';
const test = process.argv.includes('--test');
if (test) {
  // cœur sans vscode, compilé séparément pour les tests d'intégration
  await build({
    entryPoints: ['src/core/index.ts'], bundle: true, platform: 'node', target: 'node20',
    outfile: 'out-test/core.js', format: 'cjs', external: [], logLevel: 'warning'
  });
} else {
  await build({
    entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', target: 'node20',
    outfile: 'out/extension.js', format: 'cjs', external: ['vscode'], sourcemap: false, minify: false, logLevel: 'info'
  });
}
