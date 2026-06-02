// seed.js — generate realistic demo agent traces and send them to Argus, so the
// dashboard is populated (and at least one of each issue type gets detected).
const URL = process.argv[2] || process.env.ARGUS_URL || 'http://localhost:4317';
const rid = (n = 16) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const MODELS = ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4', 'deepseek-v4-flash', 'gemini-2.5-flash'];
const TOOLS = ['web_search', 'read_file', 'run_sql', 'send_email', 'calculator', 'vector_search'];
const QUERIES = ['summarize Q3 revenue', 'book a flight to Tokyo', 'debug the failing test', 'find similar customers', 'draft the launch email', 'what is our refund policy'];

function trace(startMs, variant) {
  const traceId = rid(16), rootId = rid(8), session = 'sess-' + (1 + Math.floor(Math.random() * 8)), user = 'u-' + (1 + Math.floor(Math.random() * 20));
  const model = pick(MODELS), spans = []; let t = startMs;
  const add = (s) => { spans.push({ trace_id: traceId, session_id: session, user_id: user, service: 'support-agent', ...s }); };
  const llm = (name, dur, inTok, outTok, output, status) => { add({ span_id: rid(8), parent_id: rootId, name, kind: 'llm', model, start_ms: t, end_ms: t + dur, input_tokens: inTok, output_tokens: outTok, output, status: status || 'ok' }); t += dur; };
  const tool = (name, dur, status, err) => { add({ span_id: rid(8), parent_id: rootId, name, kind: 'tool', tool_name: name, start_ms: t, end_ms: t + dur, status: status || 'ok', error: err, output: status === 'error' ? null : 'ok: 12 results' }); t += dur; };

  add({ span_id: rootId, parent_id: null, name: 'agent.run', kind: 'agent', model, start_ms: startMs, end_ms: startMs }); // root, end fixed below
  const q = pick(QUERIES);
  llm('plan', 300 + Math.random() * 400, 600 + Math.random() * 400, 80, `I'll ${q}. Let me use ${pick(TOOLS)}.`);

  if (variant === 'loop') { const tl = pick(TOOLS); for (let i = 0; i < 4; i++) { tool(tl, 400 + Math.random() * 300); llm('reflect', 200, 700, 60, 'still not enough, trying again'); } }
  else if (variant === 'error') { tool(pick(TOOLS), 500, 'error', 'ECONNREFUSED: tool backend unavailable'); llm('recover', 300, 900, 50, 'the tool failed, I cannot continue'); }
  else if (variant === 'refusal') { llm('answer', 400, 1200, 30, "I'm sorry, but I can't help with that request."); }
  else if (variant === 'slow') { tool(pick(TOOLS), 9000 + Math.random() * 8000); llm('answer', 1500, 1800, 400, 'Here is the detailed answer you requested.'); }
  else if (variant === 'big') { llm('answer', 1200, 40000 + Math.random() * 20000, 3000, 'Large context answer.'); }
  else { tool(pick(TOOLS), 400 + Math.random() * 600); llm('answer', 400 + Math.random() * 600, 900, 150 + Math.random() * 200, `Done: ${q}.`); }

  spans[0].end_ms = t; spans[0].status = spans.some((s) => s.status === 'error') ? 'error' : 'ok';
  return spans;
}

async function send(spans) { await fetch(URL + '/api/v1/traces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spans }) }); }

const variants = ['normal', 'normal', 'normal', 'normal', 'normal', 'loop', 'error', 'refusal', 'slow', 'big', 'normal', 'error'];
const now = Date.now();
let count = 0;
const all = [];
for (let i = 0; i < 60; i++) { const startMs = now - Math.random() * 3600_000; all.push(trace(startMs, pick(variants))); }
// guarantee one of each interesting variant so every detector fires
for (const v of ['loop', 'error', 'refusal', 'slow', 'big']) all.push(trace(now - Math.random() * 600_000, v));

const run = async () => {
  for (const spans of all) { await send(spans); count++; }
  console.log(`✓ seeded ${count} traces into Argus at ${URL}`);
  console.log('  open the dashboard — you should see traffic, latency, by-model, issues, and alerts.');
};
run();
