import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import handler from '../api/analyze-gpx.js';

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

const cwd = process.cwd();
const loadedLocal = loadEnvFile(path.join(cwd, '.env.local'));
const loadedEnv = loadEnvFile(path.join(cwd, '.env'));

const port = Number(process.env.TRAILPSI_API_PORT || 8787);

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/api/analyze-gpx')) {
    handler(req, res);
    return;
  }
  if (req.url?.startsWith('/api/health')) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, orsApiKey: Boolean(process.env.ORS_API_KEY || process.env.OPENROUTESERVICE_API_KEY) }));
    return;
  }
  res.statusCode = 404;
  res.end('Not found');
});

server.listen(port, () => {
  console.log(`TrailPSI API dev server listening on http://localhost:${port}`);
  console.log(`Env loaded: .env.local=${loadedLocal}, .env=${loadedEnv}, ORS_API_KEY=${(process.env.ORS_API_KEY || process.env.OPENROUTESERVICE_API_KEY) ? 'set' : 'missing'}`);
});
