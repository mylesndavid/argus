// analyze.js — cost model, behavioral issue detection, alerting, and analytics.

// Rough $/1M-token prices for cost estimation when a span doesn't carry cost.
const PRICES = [
  [/gpt-4o-mini|gpt-5.*mini|haiku/i, { in: 0.15, out: 0.6 }],
  [/gpt-4o|gpt-5|opus/i, { in: 2.5, out: 10 }],
  [/sonnet/i, { in: 3, out: 15 }],
  [/gemini.*flash|deepseek.*flash/i, { in: 0.1, out: 0.3 }],
  [/deepseek|llama|qwen|gemma|mistral|hermes/i, { in: 0.2, out: 0.4 }],
];
export function costOf(model, inTok, outTok) {
  if (!model) return 0;
  for (const [re, p] of PRICES) if (re.test(model)) return (inTok || 0) * p.in / 1e6 + (outTok || 0) * p.out / 1e6;
  return (inTok || 0) * 1e-6 + (outTok || 0) * 2e-6;
}

const REFUSAL = /\b(i can('|no)?t (help|assist|do|provide)|i('m| am) (unable|not able)|as an ai|i cannot comply|sorry,? but i)\b/i;

// Detect agent-specific failures in a finished trace. Returns new issue rows.
export function detectIssues(db, traceId) {
  const spans = db.prepare('SELECT * FROM spans WHERE trace_id=? ORDER BY start_ms').all(traceId);
  if (!spans.length) return [];
  const trace = db.prepare('SELECT * FROM traces WHERE trace_id=?').get(traceId);
  const found = [];

  // 1) tool loop — same tool called many times
  const toolCounts = {};
  for (const s of spans) if (s.kind === 'tool' && s.tool_name) toolCounts[s.tool_name] = (toolCounts[s.tool_name] || 0) + 1;
  for (const [tool, c] of Object.entries(toolCounts)) {
    if (c >= 3) found.push({ type: 'tool_loop', severity: 'high', message: `Possible loop: tool "${tool}" called ${c}× in one trace` });
  }
  // 2) tool errors
  for (const s of spans) if (s.kind === 'tool' && s.status === 'error') found.push({ type: 'tool_error', severity: 'high', message: `Tool "${s.tool_name || s.name}" failed: ${(s.error || '').slice(0, 120)}` });
  // 3) latency spike
  if (trace && trace.duration_ms > 15000) found.push({ type: 'latency_spike', severity: 'medium', message: `Slow trace: ${(trace.duration_ms / 1000).toFixed(1)}s end-to-end` });
  // 4) refusal / empty output on an LLM span
  for (const s of spans) {
    if (s.kind === 'llm') {
      const out = (s.output || '').trim();
      if (!out) found.push({ type: 'empty_response', severity: 'medium', message: `LLM span "${s.name}" produced an empty response` });
      else if (REFUSAL.test(out)) found.push({ type: 'refusal', severity: 'medium', message: `Possible refusal: "${out.slice(0, 80)}…"` });
    }
  }
  // 5) runaway tokens
  if (trace && (trace.input_tokens + trace.output_tokens) > 50000) found.push({ type: 'high_tokens', severity: 'medium', message: `High token usage: ${(trace.input_tokens + trace.output_tokens).toLocaleString()} tokens` });
  // 6) error trace
  if (trace && trace.status === 'error') found.push({ type: 'error', severity: 'high', message: 'Trace ended in an error state' });

  // insert, de-duped by (trace,type,message)
  const exists = db.prepare('SELECT 1 FROM issues WHERE trace_id=? AND type=? AND message=?');
  const ins = db.prepare('INSERT INTO issues (trace_id,type,severity,message,ts) VALUES (?,?,?,?,?)');
  const now = Date.now();
  const fresh = [];
  for (const f of found) {
    if (!exists.get(traceId, f.type, f.message)) { ins.run(traceId, f.type, f.severity, f.message, now); fresh.push({ ...f, trace_id: traceId, ts: now }); }
  }
  return fresh;
}

async function deliver(channel, event) {
  if (!channel) return;
  try {
    const isSlack = /hooks\.slack\.com/.test(channel);
    const body = isSlack ? { text: `:rotating_light: *Argus alert* — ${event.rule_name}\n${event.message}` } : event;
    await fetch(channel, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {}
}

function fireAlert(db, rule, message, value, traceId) {
  const sev = rule.type === 'error_rate' || rule.type === 'issue' ? 'high' : 'medium';
  const r = db.prepare('INSERT INTO alert_events (rule_id,rule_name,severity,message,value,trace_id,ts,delivered) VALUES (?,?,?,?,?,?,?,0)')
    .run(rule.id, rule.name, sev, message, value, traceId || null, Date.now());
  const event = { id: r.lastInsertRowid, rule_name: rule.name, severity: sev, message, value, trace_id: traceId, ts: Date.now() };
  if (rule.channel) deliver(rule.channel, event).then(() => db.prepare('UPDATE alert_events SET delivered=1 WHERE id=?').run(event.id));
  return event;
}

// Per-trace alert rules (issue / latency), evaluated right after ingest.
export function evaluateTraceAlerts(db, traceId, freshIssues) {
  const rules = db.prepare('SELECT * FROM alert_rules WHERE enabled=1').all();
  const trace = db.prepare('SELECT * FROM traces WHERE trace_id=?').get(traceId);
  const fired = [];
  for (const rule of rules) {
    if (rule.type === 'issue' && freshIssues.length) {
      for (const iss of freshIssues) fired.push(fireAlert(db, rule, `${iss.type}: ${iss.message}`, 1, traceId));
    } else if (rule.type === 'latency' && trace && trace.duration_ms >= rule.threshold) {
      fired.push(fireAlert(db, rule, `Trace ${traceId.slice(0, 8)} took ${(trace.duration_ms / 1000).toFixed(1)}s (≥ ${(rule.threshold / 1000)}s)`, trace.duration_ms, traceId));
    }
  }
  return fired;
}

// Windowed alert rules (error_rate / volume), evaluated on a timer.
export function evaluateWindowedAlerts(db) {
  const rules = db.prepare("SELECT * FROM alert_rules WHERE enabled=1 AND type IN ('error_rate','volume')").all();
  const fired = [];
  for (const rule of rules) {
    const since = Date.now() - (rule.window_sec || 300) * 1000;
    const rows = db.prepare('SELECT status FROM traces WHERE ts>=?').all(since);
    if (rule.type === 'volume' && rows.length >= rule.threshold) {
      // avoid spamming: only fire if none in last window
      const recent = db.prepare('SELECT 1 FROM alert_events WHERE rule_id=? AND ts>=?').get(rule.id, since);
      if (!recent) fired.push(fireAlert(db, rule, `Traffic spike: ${rows.length} traces in ${rule.window_sec}s`, rows.length));
    }
    if (rule.type === 'error_rate' && rows.length >= 5) {
      const errs = rows.filter((r) => r.status === 'error').length;
      const rate = errs / rows.length;
      if (rate >= rule.threshold) {
        const recent = db.prepare('SELECT 1 FROM alert_events WHERE rule_id=? AND ts>=?').get(rule.id, since);
        if (!recent) fired.push(fireAlert(db, rule, `Error rate ${(rate * 100).toFixed(0)}% over last ${rule.window_sec}s (${errs}/${rows.length})`, rate));
      }
    }
  }
  return fired;
}

// ---- analytics (filter-aware: f = {since, model, agent, status}) ----
function traceWhere(f) {
  const w = ['ts >= @since']; const p = { since: f.since };
  if (f.model) { w.push('model = @model'); p.model = f.model; }
  if (f.agent) { w.push('service = @agent'); p.agent = f.agent; }
  if (f.status) { w.push('status = @status'); p.status = f.status; }
  return ['WHERE ' + w.join(' AND '), p];
}

export function overview(db, f) {
  const [w, p] = traceWhere(f);
  const t = db.prepare(`SELECT COUNT(*) traces, COALESCE(SUM(input_tokens+output_tokens),0) tokens, COALESCE(SUM(input_tokens),0) in_tok, COALESCE(SUM(output_tokens),0) out_tok, COALESCE(SUM(cost),0) cost, COALESCE(AVG(duration_ms),0) avg_ms, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors FROM traces ${w}`).get(p);
  const durs = db.prepare(`SELECT duration_ms FROM traces ${w} AND duration_ms IS NOT NULL ORDER BY duration_ms`).all(p).map((r) => r.duration_ms);
  const pct = (q) => (durs.length ? durs[Math.min(durs.length - 1, Math.floor((q / 100) * durs.length))] : 0);
  const toolCalls = db.prepare("SELECT COUNT(*) c FROM spans WHERE kind='tool' AND ts>=@since").get({ since: f.since }).c;
  const agents = db.prepare(`SELECT COUNT(DISTINCT service) c FROM traces ${w}`).get(p).c;
  const issues = db.prepare('SELECT COUNT(*) c FROM issues WHERE ts>=@since').get({ since: f.since }).c;
  const alerts = db.prepare('SELECT COUNT(*) c FROM alert_events WHERE ts>=@since').get({ since: f.since }).c;
  // Per-CALL latency (LLM calls + tool calls), which is the latency people expect —
  // separate from whole agent-session duration (the trace-level p50/p95 above).
  const sp = { since: f.since }; let sw = 'ts>=@since AND duration_ms IS NOT NULL';
  if (f.agent) { sw += ' AND service=@agent'; sp.agent = f.agent; }
  if (f.model) { sw += ' AND model=@model'; sp.model = f.model; }
  const llmDurs = db.prepare(`SELECT duration_ms d FROM spans WHERE kind='llm' AND ${sw} ORDER BY duration_ms`).all(sp).map((r) => r.d);
  const toolDurs = db.prepare(`SELECT duration_ms d FROM spans WHERE kind='tool' AND ${sw} ORDER BY duration_ms`).all(sp).map((r) => r.d);
  const pc = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((q / 100) * arr.length))] : 0);
  return {
    traces: t.traces, tokens: t.tokens, inTokens: t.in_tok, outTokens: t.out_tok, cost: t.cost, errors: t.errors,
    errorRate: t.traces ? t.errors / t.traces : 0,
    sessP50: pct(50), sessP95: pct(95), sessP99: pct(99), avg: Math.round(t.avg_ms),
    llmP50: pc(llmDurs, 50), llmP95: pc(llmDurs, 95), llmP99: pc(llmDurs, 99),
    toolP50: pc(toolDurs, 50), toolP95: pc(toolDurs, 95),
    toolCalls, agents, issues, alerts,
  };
}

export function timeseries(db, f, buckets = 40) {
  const [w, p] = traceWhere(f); const size = Math.max(1, Math.floor((Date.now() - f.since) / buckets));
  const rows = db.prepare(`SELECT ts,duration_ms,status,input_tokens,output_tokens,cost FROM traces ${w}`).all(p);
  const out = Array.from({ length: buckets }, (_, i) => ({ t: f.since + i * size, count: 0, errors: 0, inTok: 0, outTok: 0, cost: 0, durs: [] }));
  for (const r of rows) { const i = Math.min(buckets - 1, Math.floor((r.ts - f.since) / size)); if (i < 0) continue; const b = out[i]; b.count++; b.inTok += r.input_tokens || 0; b.outTok += r.output_tokens || 0; b.cost += r.cost || 0; if (r.duration_ms != null) b.durs.push(r.duration_ms); if (r.status === 'error') b.errors++; }
  return out.map((b) => { b.durs.sort((a, c) => a - c); const pc = (q) => (b.durs.length ? b.durs[Math.min(b.durs.length - 1, Math.floor((q / 100) * b.durs.length))] : 0); return { t: b.t, count: b.count, errors: b.errors, tokens: b.inTok + b.outTok, inTok: b.inTok, outTok: b.outTok, cost: b.cost, p50: pc(50), p95: pc(95), avg: b.durs.length ? Math.round(b.durs.reduce((a, c) => a + c, 0) / b.durs.length) : 0 }; });
}

export function latencyHistogram(db, f) {
  const [w, p] = traceWhere(f);
  const durs = db.prepare(`SELECT duration_ms FROM traces ${w} AND duration_ms IS NOT NULL`).all(p).map((r) => r.duration_ms);
  const edges = [50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, Infinity]; const labels = ['<50ms', '<100', '<250', '<500', '<1s', '<2s', '<5s', '<10s', '<30s', '30s+'];
  const counts = new Array(edges.length).fill(0);
  for (const d of durs) for (let i = 0; i < edges.length; i++) if (d < edges[i]) { counts[i]++; break; }
  return labels.map((l, i) => ({ label: l, count: counts[i] }));
}

export function byModel(db, f) { const [w, p] = traceWhere(f); return db.prepare(`SELECT COALESCE(model,'unknown') model, COUNT(*) traces, COALESCE(SUM(input_tokens+output_tokens),0) tokens, COALESCE(SUM(cost),0) cost, COALESCE(AVG(duration_ms),0) avg_ms, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors FROM traces ${w} GROUP BY model ORDER BY traces DESC`).all(p); }

export function byAgent(db, f) {
  const [w, p] = traceWhere(f);
  const traces = db.prepare(`SELECT COALESCE(service,'unknown') agent, COUNT(*) traces, COALESCE(SUM(input_tokens+output_tokens),0) tokens, COALESCE(SUM(cost),0) cost, COALESCE(AVG(duration_ms),0) avg_ms, COALESCE(MAX(duration_ms),0) max_ms, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors FROM traces ${w} GROUP BY service ORDER BY traces DESC`).all(p);
  const tools = db.prepare("SELECT COALESCE(service,'unknown') agent, COUNT(*) tool_calls FROM spans WHERE kind='tool' AND ts>=@since GROUP BY service").all({ since: f.since });
  const tm = Object.fromEntries(tools.map((t) => [t.agent, t.tool_calls]));
  return traces.map((a) => ({ ...a, tool_calls: tm[a.agent] || 0, errorRate: a.traces ? a.errors / a.traces : 0 }));
}

export function byTool(db, f) {
  const w = ["kind='tool'", 'tool_name IS NOT NULL', 'ts>=@since']; const p = { since: f.since };
  if (f.agent) { w.push('service=@agent'); p.agent = f.agent; }
  if (f.model) { w.push('model=@model'); p.model = f.model; }
  return db.prepare(`SELECT tool_name, COUNT(*) calls, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors, COALESCE(AVG(duration_ms),0) avg_ms, COALESCE(MAX(duration_ms),0) max_ms FROM spans WHERE ${w.join(' AND ')} GROUP BY tool_name ORDER BY calls DESC`).all(p);
}

export function issueBreakdown(db, f) { return db.prepare('SELECT type, COUNT(*) count FROM issues WHERE ts>=@since GROUP BY type ORDER BY count DESC').all({ since: f.since }); }

export function sessions(db, f) { const [w, p] = traceWhere(f); return db.prepare(`SELECT session_id, COUNT(*) traces, COALESCE(SUM(cost),0) cost, COALESCE(SUM(input_tokens+output_tokens),0) tokens, COALESCE(AVG(duration_ms),0) avg_ms, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors, MAX(ts) last, MIN(ts) first FROM traces ${w} AND session_id IS NOT NULL GROUP BY session_id ORDER BY last DESC LIMIT 100`).all(p); }

export function sessionDetail(db, sid) {
  const traces = db.prepare('SELECT * FROM traces WHERE session_id=? ORDER BY ts').all(sid);
  const totals = db.prepare("SELECT COUNT(*) traces, COALESCE(SUM(cost),0) cost, COALESCE(SUM(input_tokens+output_tokens),0) tokens, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors FROM traces WHERE session_id=?").get(sid);
  return { traces, totals };
}

export function agentDetail(db, service, f) {
  const a = { s: service, since: f.since };
  const tools = db.prepare("SELECT tool_name, COUNT(*) calls, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors, COALESCE(AVG(duration_ms),0) avg_ms FROM spans WHERE kind='tool' AND service=@s AND ts>=@since GROUP BY tool_name ORDER BY calls DESC").all(a);
  const traces = db.prepare('SELECT * FROM traces WHERE service=@s AND ts>=@since ORDER BY ts DESC LIMIT 100').all(a);
  const issues = db.prepare('SELECT i.* FROM issues i JOIN traces t ON t.trace_id=i.trace_id WHERE t.service=@s AND i.ts>=@since ORDER BY i.ts DESC LIMIT 50').all(a);
  const llm = db.prepare("SELECT COUNT(*) calls, COALESCE(SUM(input_tokens),0) in_tok, COALESCE(SUM(output_tokens),0) out_tok, COALESCE(AVG(duration_ms),0) avg_ms, COALESCE(SUM(cost),0) cost FROM spans WHERE kind='llm' AND service=@s AND ts>=@since").get(a);
  const totals = db.prepare("SELECT COUNT(*) traces, COALESCE(SUM(cost),0) cost, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors FROM traces WHERE service=@s AND ts>=@since").get(a);
  return { service, tools, traces, issues, llm, totals };
}

export function filterOptions(db, f) {
  const q = { since: f.since };
  return {
    models: db.prepare('SELECT DISTINCT model FROM traces WHERE ts>=@since AND model IS NOT NULL').all(q).map((r) => r.model),
    agents: db.prepare('SELECT DISTINCT service FROM traces WHERE ts>=@since AND service IS NOT NULL').all(q).map((r) => r.service),
    tools: db.prepare("SELECT DISTINCT tool_name FROM spans WHERE kind='tool' AND ts>=@since AND tool_name IS NOT NULL").all(q).map((r) => r.tool_name),
  };
}
