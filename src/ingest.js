// ingest.js — normalize OpenTelemetry GenAI spans and the simpler JSON SDK shape
// into Argus's span model, maintain trace rollups, and trigger detection + alerts.
import { costOf, detectIssues, evaluateTraceAlerts } from './analyze.js';

function attrVal(v) {
  if (v == null) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue) return (v.arrayValue.values || []).map(attrVal);
  return undefined;
}
function attrsToMap(arr) { const m = {}; for (const a of arr || []) m[a.key] = attrVal(a.value); return m; }
const nanoToMs = (n) => (n == null ? null : Math.round(Number(n) / 1e6));

// OTLP/HTTP JSON → normalized spans (GenAI semantic conventions).
export function otlpToSpans(body) {
  const out = [];
  for (const rs of body.resourceSpans || []) {
    const res = attrsToMap(rs.resource?.attributes);
    const service = res['service.name'] || res['gen_ai.agent.name'];
    for (const ss of rs.scopeSpans || rs.instrumentationLibrarySpans || []) {
      for (const sp of ss.spans || []) {
        const a = attrsToMap(sp.attributes);
        const op = a['gen_ai.operation.name'];
        const tool = a['gen_ai.tool.name'];
        const model = a['gen_ai.request.model'] || a['gen_ai.response.model'] || a['llm.model_name'];
        let kind = 'other';
        if (tool || op === 'execute_tool') kind = 'tool';
        else if (op === 'invoke_agent' || op === 'agent') kind = 'agent';
        else if (model || /chat|completion|generate|embedding/i.test(op || sp.name || '')) kind = 'llm';
        const inTok = a['gen_ai.usage.input_tokens'] ?? a['gen_ai.usage.prompt_tokens'] ?? 0;
        const outTok = a['gen_ai.usage.output_tokens'] ?? a['gen_ai.usage.completion_tokens'] ?? 0;
        const status = sp.status?.code === 2 || sp.status?.code === 'STATUS_CODE_ERROR' ? 'error' : 'ok';
        out.push({
          span_id: sp.spanId, trace_id: sp.traceId, parent_id: sp.parentSpanId || null,
          name: sp.name, kind, service: service || a['gen_ai.agent.name'], model,
          start_ms: nanoToMs(sp.startTimeUnixNano), end_ms: nanoToMs(sp.endTimeUnixNano),
          status, input: a['gen_ai.prompt'] || a['gen_ai.input.messages'], output: a['gen_ai.completion'] || a['gen_ai.output.messages'],
          input_tokens: inTok, output_tokens: outTok, session_id: a['session.id'] || a['gen_ai.conversation.id'],
          user_id: a['user.id'] || a['enduser.id'], tool_name: tool, error: sp.status?.message, attributes: a,
        });
      }
    }
  }
  return out;
}

// Simple JSON SDK shape: { spans:[ {...} ] } or a single span.
export function jsonToSpans(body) {
  const arr = Array.isArray(body) ? body : body.spans ? body.spans : [body];
  return arr.map((s) => ({
    span_id: s.span_id || s.id || randId(), trace_id: s.trace_id || s.traceId, parent_id: s.parent_id || s.parentId || null,
    name: s.name || s.kind || 'span', kind: s.kind || (s.tool_name ? 'tool' : s.model ? 'llm' : 'other'),
    service: s.service || s.agent, model: s.model,
    start_ms: s.start_ms ?? (s.start ? new Date(s.start).getTime() : null), end_ms: s.end_ms ?? (s.end ? new Date(s.end).getTime() : null),
    status: s.status || (s.error ? 'error' : 'ok'), input: stringify(s.input), output: stringify(s.output),
    input_tokens: s.input_tokens || s.prompt_tokens || 0, output_tokens: s.output_tokens || s.completion_tokens || 0,
    session_id: s.session_id || s.session, user_id: s.user_id || s.user, tool_name: s.tool_name || s.tool, error: s.error, attributes: s.attributes || {},
  }));
}
function stringify(v) { return v == null ? null : typeof v === 'string' ? v : JSON.stringify(v); }
function randId() { return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join(''); }

const insertSpanSql = `INSERT OR REPLACE INTO spans
  (span_id,trace_id,parent_id,name,kind,service,model,start_ms,end_ms,duration_ms,status,input,output,input_tokens,output_tokens,cost,session_id,user_id,tool_name,error,attributes,ts)
  VALUES (@span_id,@trace_id,@parent_id,@name,@kind,@service,@model,@start_ms,@end_ms,@duration_ms,@status,@input,@output,@input_tokens,@output_tokens,@cost,@session_id,@user_id,@tool_name,@error,@attributes,@ts)`;

// Insert normalized spans, recompute affected trace rollups, detect issues + alerts.
export function ingestSpans(db, spans) {
  const stmt = db.prepare(insertSpanSql);
  const touched = new Set();
  const now = Date.now();
  for (const s of spans) {
    if (!s.trace_id || !s.span_id) continue;
    const duration = s.start_ms != null && s.end_ms != null ? Math.max(0, s.end_ms - s.start_ms) : null;
    const cost = costOf(s.model, s.input_tokens, s.output_tokens);
    stmt.run({
      span_id: s.span_id, trace_id: s.trace_id, parent_id: s.parent_id ?? null, name: s.name ?? 'span', kind: s.kind ?? 'other',
      service: s.service ?? null, model: s.model ?? null, start_ms: s.start_ms ?? null, end_ms: s.end_ms ?? null, duration_ms: duration,
      status: s.status ?? 'ok', input: s.input ?? null, output: s.output ?? null, input_tokens: s.input_tokens || 0, output_tokens: s.output_tokens || 0,
      cost, session_id: s.session_id ?? null, user_id: s.user_id ?? null, tool_name: s.tool_name ?? null, error: s.error ?? null,
      attributes: JSON.stringify(s.attributes || {}), ts: s.start_ms || now,
    });
    touched.add(s.trace_id);
  }
  const events = [];
  for (const traceId of touched) {
    rollupTrace(db, traceId);
    const fresh = detectIssues(db, traceId);
    events.push(...evaluateTraceAlerts(db, traceId, fresh));
  }
  return { traces: touched.size, spans: spans.length, alerts: events };
}

function rollupTrace(db, traceId) {
  const spans = db.prepare('SELECT * FROM spans WHERE trace_id=?').all(traceId);
  if (!spans.length) return;
  const trueRoot = spans.find((s) => !s.parent_id);
  const root = trueRoot || spans[0];
  const starts = spans.map((s) => s.start_ms).filter((x) => x != null);
  const ends = spans.map((s) => s.end_ms).filter((x) => x != null);
  const start = starts.length ? Math.min(...starts) : root.ts;
  const end = ends.length ? Math.max(...ends) : start;
  const model = spans.find((s) => s.model)?.model || null;
  // A trace is "error" only if the OVERALL operation failed (its root span), not if
  // some child span had a recovered error. Recovered tool errors still surface as issues.
  const status = trueRoot ? trueRoot.status || 'ok' : spans.some((s) => s.status === 'error') ? 'error' : 'ok';
  db.prepare(`INSERT OR REPLACE INTO traces
     (trace_id,root_name,service,model,start_ms,end_ms,duration_ms,span_count,input_tokens,output_tokens,cost,status,session_id,user_id,ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    traceId, root.name, root.service || spans.find((s) => s.service)?.service || null, model,
    start, end, Math.max(0, end - start), spans.length,
    spans.reduce((a, s) => a + (s.input_tokens || 0), 0), spans.reduce((a, s) => a + (s.output_tokens || 0), 0),
    spans.reduce((a, s) => a + (s.cost || 0), 0), spans.some((s) => s.status === 'error') ? 'error' : 'ok',
    spans.find((s) => s.session_id)?.session_id || null, spans.find((s) => s.user_id)?.user_id || null, start,
  );
}
