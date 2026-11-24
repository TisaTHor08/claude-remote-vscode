(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $('log'), input = $('input'), sel = $('sessions');
  const tools = new Map();
  let running = false;

  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function md(s) {
    const parts = s.split(/```/);
    return parts.map((p, i) => {
      if (i % 2) return '<pre>' + esc(p.replace(/^[a-zA-Z0-9_-]*\n/, '')) + '</pre>';
      return esc(p).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    }).join('');
  }
  function add(cls, html) {
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const d = document.createElement('div'); d.className = cls; d.innerHTML = html; log.appendChild(d);
    if (nearBottom) log.scrollTop = log.scrollHeight;
    return d;
  }
  function render(ev) {
    switch (ev.k) {
      case 'user': add('msg user', esc(ev.text)); break;
      case 'text': add('msg assistant', md(ev.text)); break;
      case 'tool': tools.set(ev.id, add('tool run', '<b>' + esc(ev.name) + '</b> ' + esc(ev.input))); break;
      case 'toolres': { const t = tools.get(ev.id); if (t) t.className = 'tool ' + (ev.ok ? 'ok' : 'ko'); break; }
      case 'result': if (ev.cost) add('meta', 'coût ≈ $' + ev.cost.toFixed(3)); break;
      case 'error': add('msg err', esc(ev.text)); break;
      case 'done': break;
    }
  }
  function setRunning(v) { running = v; $('send').hidden = v; $('stop').hidden = !v; }

  function send() { const text = input.value.trim(); if (!text || running) return; input.value = ''; vscode.postMessage({ type: 'send', text }); }
  $('send').onclick = send;
  $('stop').onclick = () => vscode.postMessage({ type: 'stop' });
  $('new').onclick = () => vscode.postMessage({ type: 'newChat' });
  sel.onchange = () => vscode.postMessage({ type: 'select', id: sel.value });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });

  window.addEventListener('message', (e) => {
    const m = e.data;
    switch (m.type) {
      case 'status': $('status').textContent = m.text; break;
      case 'sessions': {
        sel.innerHTML = '<option value="">— nouveau chat —</option>' + m.sessions.map((s) => '<option value="' + s.id + '">' + esc(s.title) + '</option>').join('');
        sel.value = m.current || ''; break;
      }
      case 'sessions-select': sel.value = m.id; break;
      case 'clear': log.innerHTML = ''; tools.clear(); setRunning(false); break;
      case 'history': m.events.forEach(render); log.scrollTop = log.scrollHeight; break;
      case 'ev': render(m.ev); break;
      case 'running': setRunning(m.value); break;
      case 'error': add('msg err', esc(m.text)); break;
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
