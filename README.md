# 𝍌 Argus

**The all-seeing, open-source agent observability platform.** Traces, analytics, monitoring, behavioral issue detection, and alerting for AI agents — OpenTelemetry-native, single service, SQLite, **zero dependencies**.

An open-source alternative to Raindrop: it doesn't just track latency and errors, it watches your agents' *behavior* — loops, tool failures, refusals, runaway token usage — and alerts you when they fail silently.

## Quickstart (60 seconds)

```bash
node bin/argus.js          # starts the dashboard + ingest on http://localhost:4317
node seed.js               # (optional) fill it with realistic demo traces
# open http://localhost:4317
```

No database to install, no build step, no dependencies — it uses Node's built-in `node:sqlite`.

## Send it your agents' telemetry

**OpenTelemetry (any language):** point your OTLP/HTTP exporter at `POST http://localhost:4317/v1/traces`. Argus understands the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) (`gen_ai.*`) — agent, model, and tool spans, token usage, status — with zero mapping.

**JS SDK:**
```js
import { Argus } from './sdk/argus.js';
const argus = new Argus({ url: 'http://localhost:4317', service: 'support-agent' });
const t = argus.trace('handle_ticket', { session: 's1', user: 'u42' });
const llm = t.span('chat', { kind: 'llm', model: 'gpt-4o', input: prompt });
llm.end({ output: answer, inputTokens: 800, outputTokens: 120 });
const tool = t.span('web_search', { kind: 'tool', tool: 'web_search' });
tool.end({ output: results });
await t.end();
```

**Python SDK:** `from argus import Argus` — same shape (see `sdk/argus.py`).

## What you get

- **Analytics** — requests over time, tokens, estimated cost, latency p50/p95/p99, error rate, breakdown by model. Live-updating dashboard.
- **Trace explorer + trajectory viewer** — every trace as a span tree (LLM calls, tool calls, nested agent steps) with timings, inputs/outputs, tokens, and a timeline.
- **Behavioral issue detection** — auto-surfaces tool loops, tool errors, latency spikes, refusals/empty responses, and runaway token usage. The agent-specific stuff infra monitoring misses.
- **Alerting** — configurable rules (issue detected, slow trace, error-rate %, traffic spike) that fire to a **webhook or Slack**. Alert history in the dashboard.
- **Sessions & users** — group traces, see cost/tokens per session.
- **Signals** — 👍/👎 feedback on any trace.

## Config

- `PORT` (default 4317), `ARGUS_DB` (default `./argus.db`), `ARGUS_WEBHOOK` (default alert destination — a Slack incoming-webhook URL or any HTTP endpoint).

## Architecture

```
bin/argus.js   → CLI, starts the server
src/server.js  → http server: OTLP + JSON ingest, analytics/alerting API, dashboard
src/ingest.js  → normalize OTel GenAI + SDK JSON → spans + trace rollups
src/analyze.js → cost model, issue detectors, alert rules, analytics queries
src/db.js      → node:sqlite schema (spans, traces, issues, signals, alerts)
public/        → buildless dashboard (vanilla JS + inline SVG charts)
sdk/           → JS + Python SDKs
seed.js        → realistic demo data
```

MIT.
