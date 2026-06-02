// @argus/sdk — tiny JS SDK to send agent traces to Argus.
// Usage:
//   import { Argus } from './sdk/argus.js';
//   const argus = new Argus({ url: 'http://localhost:4317', service: 'my-agent' });
//   const t = argus.trace('handle_request', { session: 'sess-1', user: 'u-42' });
//   const llm = t.span('chat', { kind: 'llm', model: 'gpt-4o', input: prompt });
//   llm.end({ output: answer, inputTokens: 800, outputTokens: 120 });
//   const tool = t.span('search', { kind: 'tool', tool: 'web_search' });
//   tool.end({ output: results });
//   await t.end();
import { AsyncLocalStorage } from 'node:async_hooks';
const als = new AsyncLocalStorage(); // tracks the "current trace" so wrappers auto-nest

function rid(n = 16) { return Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join(''); }
const msgPreview = (m) => { try { return typeof m === 'string' ? m.slice(0, 800) : JSON.stringify(m).slice(0, 800); } catch { return ''; } };

class Span {
  constructor(trace, name, opts = {}) {
    this.trace = trace; this.data = {
      span_id: rid(8), trace_id: trace.traceId, parent_id: opts.parent || trace.rootId,
      name, kind: opts.kind || 'other', service: trace.service, model: opts.model,
      tool_name: opts.tool, start_ms: Date.now(), session_id: trace.session, user_id: trace.user,
      input: opts.input, attributes: opts.attributes || {},
    };
  }
  end(opts = {}) {
    Object.assign(this.data, {
      end_ms: Date.now(), output: opts.output, input_tokens: opts.inputTokens || opts.input_tokens || 0,
      output_tokens: opts.outputTokens || opts.output_tokens || 0, status: opts.error ? 'error' : 'ok', error: opts.error,
    });
    this.trace.spans.push(this.data); return this;
  }
}

class Trace {
  constructor(argus, name, opts = {}) {
    this.argus = argus; this.traceId = rid(16); this.rootId = rid(8); this.service = argus.service;
    this.session = opts.session; this.user = opts.user; this.spans = [];
    this.spans.push({ span_id: this.rootId, trace_id: this.traceId, parent_id: null, name, kind: 'agent', service: this.service, start_ms: Date.now(), session_id: this.session, user_id: this.user });
  }
  span(name, opts = {}) { return new Span(this, name, opts); }
  async end(opts = {}) {
    const root = this.spans[0]; root.end_ms = Date.now(); root.status = opts.error ? 'error' : 'ok'; root.error = opts.error;
    return this.argus.send(this.spans);
  }
}

export class Argus {
  // flushMs/maxBatch control background batching. Telemetry is captured in-memory
  // during your call and shipped asynchronously AFTER — never in the request path.
  constructor({ url = 'http://localhost:4317', service = 'agent', flushMs = 2000, maxBatch = 50, sampleRate = 1 } = {}) {
    this.url = url.replace(/\/$/, ''); this.service = service; this.flushMs = flushMs; this.maxBatch = maxBatch; this.sampleRate = sampleRate;
    this._queue = []; this._timer = null;
  }
  trace(name, opts = {}) { return new Trace(this, name, opts); }

  // Non-blocking: just enqueue. A background flush ships batches; your code returns immediately.
  send(spans) {
    if (this.sampleRate < 1 && Math.random() > this.sampleRate) return; // optional sampling at scale
    this._queue.push(...spans);
    if (this._queue.length >= this.maxBatch) this.flush();
    else if (!this._timer) { this._timer = setTimeout(() => { this._timer = null; this.flush(); }, this.flushMs); this._timer.unref?.(); }
  }
  // Ship whatever's buffered. Fire-and-forget; failures are swallowed so observability
  // can never slow down or crash the host app. Call this before process exit to drain.
  async flush() {
    if (!this._queue.length) return;
    const batch = this._queue.splice(0, this._queue.length);
    try { await fetch(this.url + '/api/v1/traces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spans: batch }), keepalive: true }); } catch { /* swallow */ }
  }

  // ---- auto-instrumentation wrappers (the drop-in experience) ----

  // Wrap an async function so the WHOLE call becomes a trace. Anything traced/tool/
  // instrumented inside it auto-nests. Errors are captured and re-thrown.
  //   const handle = argus.traced('handle_request', async (req) => {...});
  traced(name, fn, opts = {}) {
    const self = this;
    return async function (...args) {
      const t = self.trace(typeof name === 'function' ? name(...args) : name, opts);
      return als.run(t, async () => {
        try { const r = await fn.apply(this, args); t.end(); return r; }
        catch (e) { t.end({ error: e?.message || String(e) }); throw e; }
      });
    };
  }

  // Run an async block as a span of the current trace (or its own trace if none).
  //   const docs = await argus.span('lookup', { kind:'tool', tool:'search' }, () => search(q));
  async span(name, opts, fn) {
    if (typeof opts === 'function') { fn = opts; opts = {}; }
    const t = als.getStore() || this.trace(name); const standalone = !als.getStore();
    const s = t.span(name, opts);
    try { const r = await fn(); s.end({ output: opts.output ?? (typeof r === 'string' ? r.slice(0, 500) : undefined) }); if (standalone) await t.end(); return r; }
    catch (e) { s.end({ error: e?.message || String(e) }); if (standalone) await t.end({ error: e?.message }); throw e; }
  }

  // Wrap a tool/function so every call becomes a tool span automatically.
  //   const search = argus.tool('web_search', async (q) => {...});
  tool(name, fn, opts = {}) {
    const self = this;
    return async function (...args) {
      return self.span(name, { kind: 'tool', tool: name, input: msgPreview(args), ...opts }, () => fn.apply(this, args));
    };
  }

  // Monkey-patch an OpenAI client: every chat.completions.create becomes an LLM span
  // with model, messages, output, token usage, and latency — ZERO per-call code.
  //   const openai = argus.instrumentOpenAI(new OpenAI());
  instrumentOpenAI(client) {
    const self = this; const orig = client.chat.completions.create.bind(client.chat.completions);
    client.chat.completions.create = async function (params = {}, ...rest) {
      const t = als.getStore() || self.trace(`chat ${params.model || ''}`); const standalone = !als.getStore();
      const s = t.span(`chat ${params.model || ''}`, { kind: 'llm', model: params.model, input: msgPreview(params.messages) });
      try { const res = await orig(params, ...rest); const u = res.usage || {}; s.end({ output: res.choices?.[0]?.message?.content || '', inputTokens: u.prompt_tokens || 0, outputTokens: u.completion_tokens || 0 }); if (standalone) await t.end(); return res; }
      catch (e) { s.end({ error: e?.message || String(e) }); if (standalone) await t.end({ error: e?.message }); throw e; }
    };
    return client;
  }

  // Same for an Anthropic client: every messages.create becomes an LLM span.
  //   const anthropic = argus.instrumentAnthropic(new Anthropic());
  instrumentAnthropic(client) {
    const self = this; const orig = client.messages.create.bind(client.messages);
    client.messages.create = async function (params = {}, ...rest) {
      const t = als.getStore() || self.trace(`chat ${params.model || ''}`); const standalone = !als.getStore();
      const s = t.span(`chat ${params.model || ''}`, { kind: 'llm', model: params.model, input: msgPreview(params.messages) });
      try { const res = await orig(params, ...rest); const u = res.usage || {}; const out = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''); s.end({ output: out, inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0 }); if (standalone) await t.end(); return res; }
      catch (e) { s.end({ error: e?.message || String(e) }); if (standalone) await t.end({ error: e?.message }); throw e; }
    };
    return client;
  }
}
export default Argus;
