// db.js — Argus storage. Zero-dependency: uses Node's built-in node:sqlite.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(file) {
  if (file && file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file || ':memory:');
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS spans (
      span_id TEXT PRIMARY KEY, trace_id TEXT, parent_id TEXT,
      name TEXT, kind TEXT, service TEXT, model TEXT,
      start_ms INTEGER, end_ms INTEGER, duration_ms INTEGER,
      status TEXT, input TEXT, output TEXT,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cost REAL DEFAULT 0, session_id TEXT, user_id TEXT,
      tool_name TEXT, error TEXT, attributes TEXT, ts INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);
    CREATE INDEX IF NOT EXISTS idx_spans_ts ON spans(ts);
    CREATE TABLE IF NOT EXISTS traces (
      trace_id TEXT PRIMARY KEY, root_name TEXT, service TEXT, model TEXT,
      start_ms INTEGER, end_ms INTEGER, duration_ms INTEGER, span_count INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, cost REAL,
      status TEXT, session_id TEXT, user_id TEXT, ts INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_traces_ts ON traces(ts);
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trace_id TEXT, type TEXT,
      severity TEXT, message TEXT, ts INTEGER
    );
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trace_id TEXT, session_id TEXT,
      value INTEGER, comment TEXT, ts INTEGER
    );
    CREATE TABLE IF NOT EXISTS alert_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, type TEXT,
      threshold REAL, window_sec INTEGER, channel TEXT, enabled INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS alert_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, rule_id INTEGER, rule_name TEXT,
      severity TEXT, message TEXT, value REAL, trace_id TEXT, ts INTEGER, delivered INTEGER DEFAULT 0
    );
  `);
  // Seed default alert rules once.
  const n = db.prepare('SELECT COUNT(*) c FROM alert_rules').get().c;
  if (n === 0) {
    const ins = db.prepare('INSERT INTO alert_rules (name,type,threshold,window_sec,channel,enabled) VALUES (?,?,?,?,?,1)');
    ins.run('Any agent issue detected', 'issue', 0, 0, process.env.ARGUS_WEBHOOK || '');
    ins.run('Slow trace (> 15s)', 'latency', 15000, 0, process.env.ARGUS_WEBHOOK || '');
    ins.run('Error rate > 20% (5 min)', 'error_rate', 0.2, 300, process.env.ARGUS_WEBHOOK || '');
    ins.run('Traffic spike > 100 traces (1 min)', 'volume', 100, 60, process.env.ARGUS_WEBHOOK || '');
  }
  return db;
}
