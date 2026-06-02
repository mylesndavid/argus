#!/usr/bin/env node
// argus — start the observability server (and open the dashboard).
import { spawn } from 'node:child_process';
import { startServer } from '../src/server.js';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : args.includes('--' + n) ? true : d; };
const port = parseInt(flag('port', process.env.PORT || 4317), 10);
const host = flag('host', '127.0.0.1');

const { url } = await startServer({ port, host, dbFile: flag('db', process.env.ARGUS_DB) });

console.log(`
  𝍌  A R G U S   —  the all-seeing agent observability platform
  ───────────────────────────────────────────────────────────
  dashboard   ${url}
  OTLP ingest POST ${url}/v1/traces        (OpenTelemetry GenAI)
  JSON ingest POST ${url}/api/v1/traces    (Argus SDK)
  db          ${process.env.ARGUS_DB || 'argus.db'}

  Seed demo data:  node seed.js
  Point your agents here and watch everything they do.
`);

if (!args.includes('--no-open')) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref(); } catch {}
}
