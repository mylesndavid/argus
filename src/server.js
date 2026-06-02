// server.js — Argus HTTP server: OTLP + JSON ingest, analytics/monitoring/alerting
// API, and the dashboard. Zero external dependencies (node:http + node:sqlite).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { otlpToSpans, jsonToSpans, ingestSpans } from './ingest.js';
import { overview, timeseries, byModel, byTool, byAgent, agentDetail, latencyHistogram, issueBreakdown, sessions, sessionDetail, filterOptions, evaluateWindowedAlerts } from './analyze.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const RANGES = { '15m': 9e5, '1h': 36e5, '6h': 216e5, '24h': 864e5, '7d': 6048e5, all: 3.15e11 };
const sinceFor = (r) => Date.now() - (RANGES[r] || RANGES['1h']);

export function startServer({ port = 4317, host = '127.0.0.1', dbFile } = {}) {
  const db = openDb(dbFile || process.env.ARGUS_DB || path.join(process.cwd(), 'argus.db'));

  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); };
  const readBody = (req) => new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } }); });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    const range = url.searchParams.get('range') || '1h';
    const since = sinceFor(range);
    const f = { since, model: url.searchParams.get('model') || null, agent: url.searchParams.get('agent') || null, status: url.searchParams.get('status') || null };
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }); return res.end(); }

      // ---- ingest ----
      if (p === '/v1/traces' && req.method === 'POST') { const r = ingestSpans(db, otlpToSpans(await readBody(req))); return json(res, 200, { partialSuccess: {}, ...r }); }
      if ((p === '/api/v1/traces' || p === '/api/v1/events') && req.method === 'POST') { const r = ingestSpans(db, jsonToSpans(await readBody(req))); return json(res, 200, { ok: true, ...r }); }

      // ---- analytics ----
      if (p === '/api/overview') return json(res, 200, overview(db, f));
      if (p === '/api/timeseries') return json(res, 200, timeseries(db, f));
      if (p === '/api/bymodel') return json(res, 200, byModel(db, f));
      if (p === '/api/bytool') return json(res, 200, byTool(db, f));
      if (p === '/api/byagent') return json(res, 200, byAgent(db, f));
      if (p === '/api/agent') return json(res, 200, agentDetail(db, url.searchParams.get('service'), f));
      if (p === '/api/lat-histogram') return json(res, 200, latencyHistogram(db, f));
      if (p === '/api/issue-breakdown') return json(res, 200, issueBreakdown(db, f));
      if (p === '/api/filter-options') return json(res, 200, filterOptions(db, f));
      if (p === '/api/session') return json(res, 200, sessionDetail(db, url.searchParams.get('id')));

      // ---- traces ----
      if (p === '/api/traces') {
        const model = url.searchParams.get('model'); const status = url.searchParams.get('status'); const q = url.searchParams.get('q');
        const agent = url.searchParams.get('agent');
        let sql = 'SELECT * FROM traces WHERE ts>=?'; const args = [since];
        if (model) { sql += ' AND model=?'; args.push(model); }
        if (status) { sql += ' AND status=?'; args.push(status); }
        if (agent) { sql += ' AND service=?'; args.push(agent); }
        sql += ' ORDER BY ts DESC LIMIT 300';
        let rows = db.prepare(sql).all(...args);
        if (q) { const needle = q.toLowerCase(); const ids = db.prepare('SELECT DISTINCT trace_id FROM spans WHERE lower(input) LIKE ? OR lower(output) LIKE ? OR lower(name) LIKE ?').all(`%${needle}%`, `%${needle}%`, `%${needle}%`).map((r) => r.trace_id); rows = rows.filter((r) => ids.includes(r.trace_id)); }
        return json(res, 200, rows);
      }
      if (p === '/api/trace') {
        const id = url.searchParams.get('id');
        const trace = db.prepare('SELECT * FROM traces WHERE trace_id=?').get(id);
        const spans = db.prepare('SELECT * FROM spans WHERE trace_id=? ORDER BY start_ms').all(id);
        const issues = db.prepare('SELECT * FROM issues WHERE trace_id=? ORDER BY ts').all(id);
        return json(res, 200, { trace, spans, issues });
      }

      // ---- issues / alerts / signals / sessions ----
      if (p === '/api/issues') return json(res, 200, db.prepare('SELECT i.*, t.model, t.service FROM issues i LEFT JOIN traces t ON t.trace_id=i.trace_id WHERE i.ts>=? ORDER BY i.ts DESC LIMIT 200').all(since));
      if (p === '/api/alerts') return json(res, 200, db.prepare('SELECT * FROM alert_events WHERE ts>=? ORDER BY ts DESC LIMIT 200').all(since));
      if (p === '/api/alert-rules' && req.method === 'GET') return json(res, 200, db.prepare('SELECT * FROM alert_rules ORDER BY id').all());
      if (p === '/api/alert-rules' && req.method === 'POST') {
        const b = await readBody(req);
        if (b.id) db.prepare('UPDATE alert_rules SET name=?,threshold=?,window_sec=?,channel=?,enabled=? WHERE id=?').run(b.name, b.threshold, b.window_sec, b.channel || '', b.enabled ? 1 : 0, b.id);
        else db.prepare('INSERT INTO alert_rules (name,type,threshold,window_sec,channel,enabled) VALUES (?,?,?,?,?,?)').run(b.name, b.type, b.threshold, b.window_sec || 0, b.channel || '', b.enabled ? 1 : 0);
        return json(res, 200, { ok: true });
      }
      if (p === '/api/signals' && req.method === 'POST') { const b = await readBody(req); db.prepare('INSERT INTO signals (trace_id,session_id,value,comment,ts) VALUES (?,?,?,?,?)').run(b.trace_id || null, b.session_id || null, b.value || 0, b.comment || null, Date.now()); return json(res, 200, { ok: true }); }
      if (p === '/api/sessions') return json(res, 200, sessions(db, f));

      // ---- static dashboard ----
      let rel = p === '/' ? '/index.html' : p;
      const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
      if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        return fs.createReadStream(file).pipe(res);
      }
      res.writeHead(404).end('not found');
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });

  // windowed alert evaluation (error rate / volume)
  const timer = setInterval(() => { try { evaluateWindowedAlerts(db); } catch {} }, 15000);
  timer.unref?.();

  return new Promise((resolve) => server.listen(port, host, () => resolve({ server, db, url: `http://${host}:${port}` })));
}
