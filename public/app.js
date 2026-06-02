// app.js — Argus dashboard. Chart.js interactive charts, global filters, drilldowns,
// per-agent / per-tool / per-session analytics, and full trace context replay.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : Math.round(n || 0));
const ms = (n) => (n >= 1000 ? (n / 1000).toFixed(2) + 's' : Math.round(n || 0) + 'ms');
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? Math.round(s) + 's' : s < 3600 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h'; };
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

Chart.defaults.color = '#7d8aa0';
Chart.defaults.borderColor = '#1b2430';
Chart.defaults.font.family = 'ui-monospace, Menlo, monospace';
Chart.defaults.font.size = 11;
Chart.defaults.animation = false;
const COL = { cyan: '#22d3ee', purple: '#a78bfa', green: '#34d399', red: '#f87171', amber: '#fbbf24', blue: '#60a5fa', pink: '#f472b6' };
const PALETTE = Object.values(COL);

// ---- filter state ----
const filter = { range: '1h', model: '', agent: '', status: '' };
function qs(extra = {}) { const o = { range: filter.range, ...(filter.model && { model: filter.model }), ...(filter.agent && { agent: filter.agent }), ...(filter.status && { status: filter.status }), ...extra }; return '?' + new URLSearchParams(o); }
const api = (p, extra) => fetch(p + qs(extra)).then((r) => r.json());

['range', 'model', 'agent', 'status'].forEach((k) => $('#f-' + k).onchange = () => { filter[k] = $('#f-' + k).value; refresh(); });
$('#f-clear').onclick = () => { filter.model = filter.agent = filter.status = ''; ['model', 'agent', 'status'].forEach((k) => $('#f-' + k).value = ''); refresh(); };
$('#drawer-close').onclick = () => $('#drawer').classList.add('hidden');
$('#t-q').oninput = debounce(() => loadTraces(), 350);
function debounce(fn, d) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), d); }; }

let tab = 'overview';
document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => { tab = b.dataset.tab; document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b)); document.querySelectorAll('.pane').forEach((x) => x.classList.toggle('active', x.id === 'tab-' + tab)); refresh(); });

// ---- chart registry ----
const charts = {};
function upsert(id, cfg) {
  const el = document.getElementById(id); if (!el) return;
  if (charts[id]) { charts[id].data = cfg.data; charts[id].options = { ...charts[id].options, ...cfg.options }; charts[id].update(); }
  else charts[id] = new Chart(el, cfg);
}
const baseLine = (extra = {}) => ({ responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: true, labels: { boxWidth: 10 } }, tooltip: { enabled: true } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true } }, ...extra });
const baseBar = (onClick) => ({ responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: true } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true } }, onClick });

// ---- main refresh ----
async function refresh() {
  const ov = await api('/api/overview');
  badge('#issue-badge', ov.issues); badge('#alert-badge', ov.alerts);
  await loadFilterOptions();
  if (tab === 'overview') renderOverview(ov);
  else if (tab === 'traces') loadTraces();
  else if (tab === 'agents') loadAgents();
  else if (tab === 'tools') loadTools();
  else if (tab === 'sessions') loadSessions();
  else if (tab === 'issues') loadIssues();
  else if (tab === 'alerts') loadAlerts();
}
function badge(sel, n) { const e = $(sel); e.textContent = n || ''; e.classList.toggle('show', !!n); }

async function loadFilterOptions() {
  const o = await api('/api/filter-options');
  fillSelect('#f-model', o.models, 'all models'); fillSelect('#f-agent', o.agents, 'all agents');
}
function fillSelect(sel, opts, allLabel) { const el = $(sel); const cur = el.value; el.innerHTML = `<option value="">${allLabel}</option>` + opts.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join(''); el.value = cur; }

// ---- overview ----
function card(k, v, cls = '') { return `<div class="card"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`; }
async function renderOverview(ov) {
  $('#cards').innerHTML = [
    card('Traces', fmt(ov.traces)), card('Agents', ov.agents), card('Tool calls', fmt(ov.toolCalls)),
    card('Tokens', fmt(ov.tokens)), card('Est. cost', '$' + (ov.cost || 0).toFixed(4)),
    card('Error rate', (ov.errorRate * 100).toFixed(1) + '%', ov.errorRate > 0.1 ? 'err' : 'ok'),
    card('LLM call p50', ms(ov.llmP50)), card('LLM call p95', ms(ov.llmP95)),
    card('Tool call p95', ms(ov.toolP95)), card('Session p95', ms(ov.sessP95)),
    card('Issues', fmt(ov.issues), ov.issues ? 'err' : 'ok'), card('Alerts', fmt(ov.alerts), ov.alerts ? 'err' : ''),
  ].join('');
  const ts = await api('/api/timeseries');
  const L = ts.map((b) => hhmm(b.t));
  upsert('c-throughput', { type: 'line', data: { labels: L, datasets: [ds('requests', ts.map((b) => b.count), COL.cyan, true), ds('errors', ts.map((b) => b.errors), COL.red, true)] }, options: baseLine() });
  upsert('c-latency', { type: 'line', data: { labels: L, datasets: [ds('p95', ts.map((b) => b.p95), COL.red), ds('p50', ts.map((b) => b.p50), COL.cyan), ds('avg', ts.map((b) => b.avg), COL.purple)] }, options: baseLine({ scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: (v) => v + 'ms' } } } }) });
  upsert('c-cost', { type: 'line', data: { labels: L, datasets: [ds('cost', ts.map((b) => +b.cost.toFixed(5)), COL.green, true)] }, options: baseLine({ plugins: { legend: { display: false } } }) });
  upsert('c-tokens', { type: 'bar', data: { labels: L, datasets: [{ label: 'input', data: ts.map((b) => b.inTok), backgroundColor: COL.blue, stack: 's' }, { label: 'output', data: ts.map((b) => b.outTok), backgroundColor: COL.purple, stack: 's' }] }, options: baseLine({ scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true } } }) });
  const hg = await api('/api/lat-histogram');
  upsert('c-histogram', { type: 'bar', data: { labels: hg.map((h) => h.label), datasets: [{ data: hg.map((h) => h.count), backgroundColor: COL.amber }] }, options: baseBar() });
  const ib = await api('/api/issue-breakdown');
  upsert('c-issues', { type: 'doughnut', data: { labels: ib.map((i) => i.type), datasets: [{ data: ib.map((i) => i.count), backgroundColor: PALETTE }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { boxWidth: 10, font: { size: 10 } } } } } });
  const bm = await api('/api/bymodel');
  upsert('c-models', { type: 'bar', data: { labels: bm.map((m) => m.model), datasets: [{ data: bm.map((m) => m.traces), backgroundColor: COL.cyan }] }, options: baseBar((e, els) => { if (els[0]) setFilter('model', bm[els[0].index].model); }) });
  upsert('c-costmodel', { type: 'doughnut', data: { labels: bm.map((m) => `${m.model} ($${m.cost.toFixed(3)})`), datasets: [{ data: bm.map((m) => +m.cost.toFixed(5)), backgroundColor: PALETTE }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { boxWidth: 10, font: { size: 10 } } }, tooltip: { callbacks: { label: (c) => ' $' + c.raw.toFixed(4) } } } } });
  const bt = await api('/api/bytool');
  upsert('c-tools', { type: 'bar', data: { labels: bt.map((t) => t.tool_name), datasets: [{ label: 'calls', data: bt.map((t) => t.calls), backgroundColor: COL.purple }, { label: 'errors', data: bt.map((t) => t.errors), backgroundColor: COL.red }] }, options: baseLine({ plugins: { legend: { display: true } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true } } }) });
  const ba = await api('/api/byagent');
  upsert('c-agents', { type: 'bar', data: { labels: ba.map((a) => a.agent), datasets: [{ data: ba.map((a) => a.traces), backgroundColor: ba.map((a) => (a.errorRate > 0.1 ? COL.red : COL.green)) }] }, options: baseBar((e, els) => { if (els[0]) openAgent(ba[els[0].index].agent); }) });
}
function ds(label, data, color, fill) { return { label, data, borderColor: color, backgroundColor: fill ? color + '22' : color, fill: !!fill, tension: 0.3, pointRadius: 0, borderWidth: 2 }; }
function setFilter(k, v) { filter[k] = v; $('#f-' + k).value = v; refresh(); }

// ---- traces ----
async function loadTraces() {
  const q = $('#t-q').value;
  const rows = await api('/api/traces', q ? { q } : {});
  $('#trace-count').textContent = rows.length + ' traces';
  $('#traces-table').innerHTML = table(['time', 'agent', 'root', 'model', 'spans', 'tokens', 'cost', 'latency', 'status'],
    rows.map((t) => [`${ago(t.ts)} ago`, esc(t.service || '-'), esc(t.root_name || '-'), esc(t.model || '-'), t.span_count, fmt(t.input_tokens + t.output_tokens), '$' + (t.cost || 0).toFixed(4), ms(t.duration_ms), pill(t.status, t.status)]), rows.map((t) => t.trace_id));
  document.querySelectorAll('#traces-table tr.row').forEach((r) => r.onclick = () => openTrace(r.dataset.id));
}

// ---- trace explorer (waterfall + collapsible spans + replay) ----
async function openTrace(id) {
  $('#drawer').classList.remove('hidden');
  $('#drawer-title').textContent = 'trace ' + id.slice(0, 12);
  $('#drawer-body').innerHTML = 'loading…';
  const { trace, spans, issues } = await fetch('/api/trace?id=' + id).then((r) => r.json());
  if (!trace || !spans.length) { $('#drawer-body').innerHTML = '<div class="muted">no spans for this trace</div>'; return; }
  const t0 = Math.min(...spans.map((s) => s.start_ms || trace.start_ms));
  const total = Math.max(1, Math.max(...spans.map((s) => s.end_ms || s.start_ms || 0)) - t0);
  // build the span tree (depth-first, ordered by start time)
  const ids = new Set(spans.map((s) => s.span_id));
  const kids = {}; spans.forEach((s) => { const k = s.parent_id && ids.has(s.parent_id) ? s.parent_id : '__root'; (kids[k] ||= []).push(s); });
  const order = []; const walk = (s, depth) => { order.push({ s, depth }); (kids[s.span_id] || []).sort((a, b) => (a.start_ms || 0) - (b.start_ms || 0)).forEach((c) => walk(c, depth + 1)); };
  (kids.__root || []).sort((a, b) => (a.start_ms || 0) - (b.start_ms || 0)).forEach((r) => walk(r, 0));
  const ICON = { llm: '🧠', tool: '🔧', agent: '🤖', other: '•' };
  const rows = order.map(({ s, depth }, i) => {
    const off = ((s.start_ms - t0) / total) * 100, w = Math.max(0.6, ((s.duration_ms || 0) / total) * 100);
    const color = s.status === 'error' ? COL.red : s.kind === 'tool' ? COL.purple : s.kind === 'llm' ? COL.cyan : COL.green;
    const meta = [ms(s.duration_ms), s.input_tokens + s.output_tokens ? (s.input_tokens + s.output_tokens) + ' tok' : '', s.model ? esc(s.model) : ''].filter(Boolean).join(' · ');
    const payload = (s.input ? `<div class="io"><span class="iolbl">input →</span>\n${esc(String(s.input).slice(0, 2000))}</div>` : '') + (s.output ? `<div class="io"><span class="iolbl">output ←</span>\n${esc(String(s.output).slice(0, 2000))}</div>` : '') + (s.error ? `<div class="io err">⚠ ${esc(s.error)}</div>` : '') + (!s.input && !s.output && !s.error ? '<div class="muted" style="padding:6px 0">no payload captured for this span</div>' : '');
    return `<div class="wf-row" data-i="${i}" onclick="this.classList.toggle('open')">
      <div class="wf-label" style="padding-left:${4 + depth * 16}px"><span class="caret">▸</span> ${ICON[s.kind] || '•'} <span class="pill ${s.kind}">${s.kind}</span> <b>${esc(s.name)}</b> <span class="muted">${meta}</span>${s.status === 'error' ? ' <span class="pill error">error</span>' : ''}</div>
      <div class="wf-track"><div class="wf-bar" style="left:${off}%;width:${w}%;background:${color}" title="${ms(s.duration_ms)}"></div></div>
      <div class="wf-detail">${payload}</div>
    </div>`;
  }).join('');
  $('#drawer-body').innerHTML =
    `<div class="trace-sum">${esc(trace.service || '')} · ${esc(trace.model || '')} · <b>${ms(trace.duration_ms)}</b> · ${order.length} spans · ${trace.input_tokens + trace.output_tokens} tok · $${(trace.cost || 0).toFixed(4)} · ${pill(trace.status, trace.status)}</div>` +
    (issues.length ? `<div class="issuebox">${issues.map((i) => `<div class="item issue"><b class="sev-${i.severity}">${i.type}</b> ${esc(i.message)}</div>`).join('')}</div>` : '') +
    `<div class="wf-axis"><span>0</span><span>${ms(total / 2)}</span><span>${ms(total)}</span></div>` +
    `<div class="waterfall">${rows}</div>` +
    `<div style="margin-top:10px"><button class="mini" onclick="document.querySelectorAll('#drawer-body .wf-row').forEach(r=>r.classList.add('open'))">expand all</button> <button class="mini" onclick="document.querySelectorAll('#drawer-body .wf-row').forEach(r=>r.classList.remove('open'))">collapse all</button> <button class="mini" onclick="signal('${id}',1)">👍</button> <button class="mini" onclick="signal('${id}',-1)">👎</button></div>`;
}
$('#drawer-replay').onclick = () => {
  const rows = [...document.querySelectorAll('#drawer-body .wf-row')]; if (!rows.length) return;
  let i = 0; rows.forEach((r) => { r.classList.add('dim'); r.classList.remove('open'); });
  const step = () => { if (i >= rows.length) { rows.forEach((r) => r.classList.remove('dim', 'hot')); return; } rows.forEach((r, j) => { r.classList.toggle('hot', j === i); r.classList.toggle('dim', j > i); }); rows[i].classList.add('open'); rows[i].scrollIntoView({ block: 'center', behavior: 'smooth' }); i++; setTimeout(step, 750); };
  step();
};
window.signal = (id, v) => { fetch('/api/signals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trace_id: id, value: v }) }); $('#drawer-title').textContent += ' · feedback ✓'; };

// ---- agents ----
async function loadAgents() {
  const rows = await api('/api/byagent');
  $('#agents-table').innerHTML = table(['agent', 'traces', 'tool calls', 'tokens', 'cost', 'avg latency', 'max', 'errors'],
    rows.map((a) => [`<b>${esc(a.agent)}</b>`, a.traces, a.tool_calls, fmt(a.tokens), '$' + a.cost.toFixed(4), ms(a.avg_ms), ms(a.max_ms), `<span class="${a.errors ? 'sev-high' : ''}">${(a.errorRate * 100).toFixed(0)}%</span>`]), rows.map((a) => a.agent));
  document.querySelectorAll('#agents-table tr.row').forEach((r) => r.onclick = () => openAgent(r.dataset.id));
}
async function openAgent(service) {
  $('#drawer').classList.remove('hidden'); $('#drawer-title').textContent = '👤 ' + service; $('#drawer-body').innerHTML = 'loading…';
  const d = await api('/api/agent', { service });
  $('#drawer-body').innerHTML =
    `<div class="cards">${card('Traces', d.totals.traces)}${card('LLM calls', d.llm.calls)}${card('Tokens', fmt(d.llm.in_tok + d.llm.out_tok))}${card('Cost', '$' + (d.totals.cost || 0).toFixed(4))}${card('Avg LLM', ms(d.llm.avg_ms))}${card('Errors', d.totals.errors, d.totals.errors ? 'err' : 'ok')}</div>` +
    `<h3>Tools used</h3>${d.tools.length ? table(['tool', 'calls', 'errors', 'avg'], d.tools.map((t) => [pill('tool', t.tool_name), t.calls, t.errors, ms(t.avg_ms)])) : '<div class="muted">none</div>'}` +
    `<h3>Recent traces</h3>${table(['time', 'root', 'latency', 'status'], d.traces.slice(0, 20).map((t) => [`${ago(t.ts)} ago`, esc(t.root_name), ms(t.duration_ms), pill(t.status, t.status)]), d.traces.slice(0, 20).map((t) => t.trace_id))}` +
    (d.issues.length ? `<h3>Issues</h3>${d.issues.map((i) => `<div class="item issue"><b class="sev-${i.severity}">${i.type}</b> ${esc(i.message)}</div>`).join('')}` : '');
  document.querySelectorAll('#drawer-body tr.row').forEach((r) => r.onclick = () => openTrace(r.dataset.id));
}

// ---- tools ----
async function loadTools() {
  const rows = await api('/api/bytool');
  upsert('c-tools2', { type: 'bar', data: { labels: rows.map((t) => t.tool_name), datasets: [{ label: 'calls', data: rows.map((t) => t.calls), backgroundColor: COL.purple }, { label: 'errors', data: rows.map((t) => t.errors), backgroundColor: COL.red }] }, options: baseLine({ plugins: { legend: { display: true } } }) });
  $('#tools-table').innerHTML = table(['tool', 'calls', 'errors', 'err %', 'avg latency', 'max'],
    rows.map((t) => [pill('tool', t.tool_name), t.calls, t.errors, `<span class="${t.errors ? 'sev-high' : ''}">${((t.errors / t.calls) * 100).toFixed(0)}%</span>`, ms(t.avg_ms), ms(t.max_ms)]));
}

// ---- sessions ----
async function loadSessions() {
  const rows = await api('/api/sessions');
  $('#sessions-table').innerHTML = table(['session', 'traces', 'tokens', 'cost', 'avg latency', 'errors', 'last'],
    rows.map((s) => [esc(s.session_id), s.traces, fmt(s.tokens), '$' + s.cost.toFixed(4), ms(s.avg_ms), s.errors, `${ago(s.last)} ago`]), rows.map((s) => s.session_id));
  document.querySelectorAll('#sessions-table tr.row').forEach((r) => r.onclick = () => openSession(r.dataset.id));
}
async function openSession(sid) {
  $('#drawer').classList.remove('hidden'); $('#drawer-title').textContent = '🗂 session ' + sid; $('#drawer-body').innerHTML = 'loading…';
  const d = await fetch('/api/session?id=' + encodeURIComponent(sid)).then((r) => r.json());
  $('#drawer-body').innerHTML = `<div class="cards">${card('Traces', d.totals.traces)}${card('Tokens', fmt(d.totals.tokens))}${card('Cost', '$' + (d.totals.cost || 0).toFixed(4))}${card('Errors', d.totals.errors, d.totals.errors ? 'err' : 'ok')}</div>` +
    `<h3>Timeline</h3>${table(['time', 'agent', 'root', 'latency', 'status'], d.traces.map((t) => [`${ago(t.ts)} ago`, esc(t.service || '-'), esc(t.root_name), ms(t.duration_ms), pill(t.status, t.status)]), d.traces.map((t) => t.trace_id))}`;
  document.querySelectorAll('#drawer-body tr.row').forEach((r) => r.onclick = () => openTrace(r.dataset.id));
}

// ---- issues / alerts ----
async function loadIssues() {
  const ib = await api('/api/issue-breakdown');
  upsert('c-issues2', { type: 'bar', data: { labels: ib.map((i) => i.type), datasets: [{ data: ib.map((i) => i.count), backgroundColor: PALETTE }] }, options: baseBar() });
  const rows = await api('/api/issues');
  $('#issues-list').innerHTML = rows.length ? rows.map((i) => `<div class="item issue"><b class="sev-${i.severity}">${i.type}</b> — ${esc(i.message)}<div class="meta">${esc(i.service || '')} ${esc(i.model || '')} · ${ago(i.ts)} ago · <a href="#" onclick="openTrace('${i.trace_id}');return false">trace ${i.trace_id.slice(0, 8)}</a></div></div>`).join('') : '<div class="muted">no issues 🎉</div>';
}
async function loadAlerts() {
  const rules = await fetch('/api/alert-rules').then((r) => r.json());
  $('#rules-list').innerHTML = rules.map((r) => `<div class="rule"><input type="checkbox" ${r.enabled ? 'checked' : ''} onchange="saveRule(${r.id},'enabled',this.checked)"><b>${esc(r.name)}</b><span class="muted">[${r.type}]</span><input type="text" placeholder="webhook / slack url" value="${esc(r.channel || '')}" onchange="saveRule(${r.id},'channel',this.value)"></div>`).join('');
  const ev = await api('/api/alerts');
  $('#alerts-list').innerHTML = ev.length ? ev.map((a) => `<div class="item alert"><b class="sev-${a.severity}">${esc(a.rule_name)}</b> — ${esc(a.message)}<div class="meta">${ago(a.ts)} ago ${a.delivered ? '· delivered ✓' : ''} ${a.trace_id ? `· <a href="#" onclick="openTrace('${a.trace_id}');return false">trace</a>` : ''}</div></div>`).join('') : '<div class="muted">no alerts fired</div>';
}
window.saveRule = (id, field, val) => { fetch('/api/alert-rules').then((r) => r.json()).then((rules) => { const r = rules.find((x) => x.id === id); r[field] = field === 'enabled' ? (val ? 1 : 0) : val; fetch('/api/alert-rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r) }); }); };

// ---- helpers ----
function pill(cls, txt) { return `<span class="pill ${cls}">${esc(txt)}</span>`; }
function table(cols, rows, ids) { return `<table><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>${rows.map((r, i) => `<tr class="${ids ? 'row' : ''}" ${ids ? `data-id="${esc(ids[i])}"` : ''}>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`; }

refresh();
setInterval(() => { if ($('#f-auto').checked) refresh(); }, 5000);
