import http from 'node:http';
import fs from 'node:fs/promises';
import { buildSnapshot } from './src/collectData.js';
import { buildFirewallReport } from './src/firewallData.js';

const PORT = process.env.PORT || 4173;
const CACHE_MS = 15_000; // device/client data changes fast — short cache
const FIREWALL_CACHE_MS = 60_000; // firewall config changes rarely — longer cache

let cache = null; // { at: number, data: object }
let firewallCache = null; // { at: number, data: object }

async function getSnapshot() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const data = await buildSnapshot();
  cache = { at: Date.now(), data };
  return data;
}

async function getFirewallReport() {
  if (firewallCache && Date.now() - firewallCache.at < FIREWALL_CACHE_MS) return firewallCache.data;
  const data = await buildFirewallReport();
  firewallCache = { at: Date.now(), data };
  return data;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/api/summary') {
      const data = await getSnapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...data, generatedAt: new Date(cache.at).toISOString() }));
      return;
    }
    if (req.url === '/api/firewall') {
      const data = await getFirewallReport();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...data, generatedAt: new Date(firewallCache.at).toISOString() }));
      return;
    }
    // Everything else serves the static dashboard page.
    const html = await fs.readFile(new URL('./public/dashboard.html', import.meta.url));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
