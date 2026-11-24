#!/usr/bin/env node
// Faux CLI `claude -p --output-format stream-json` pour les tests.
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const ri = args.indexOf('--resume');
  const sid = ri >= 0 ? args[ri + 1] : '11111111-2222-3333-4444-555555555555';
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  out({ type: 'system', subtype: 'init', session_id: sid });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'echo: ' + input.trim() }] } });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.txt' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'contenu' }] } });
  out({ type: 'result', subtype: 'success', result: 'fini', session_id: sid, total_cost_usd: 0.01 });
  process.stderr.write('args=' + args.join(' ') + '\n');
});
