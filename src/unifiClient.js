import { Agent, fetch } from 'undici';

process.loadEnvFile(new URL('../.env', import.meta.url));

const { UDM_HOST, UNIFI_API_KEY } = process.env;

if (!UDM_HOST) {
  throw new Error('UDM_HOST is not set. Copy .env.example to .env and fill it in.');
}

// The UDM Pro Max presents a self-signed cert on the local network.
// This dispatcher is only ever pointed at UDM_HOST, never at a third-party host.
const localAgent = new Agent({ connect: { rejectUnauthorized: false } });

const INTEGRATION_BASE = `https://${UDM_HOST}/proxy/network/integration/v1`;

/**
 * GET a path from the Network Integrations API. This project only ever
 * calls GET here — never issue a write (POST/PUT/DELETE) against this
 * client, even though the underlying key has whatever permissions its
 * owning admin account has. Read-only is enforced by this code path never
 * doing writes, not by the key itself.
 */
export async function integrationsGet(path) {
  if (!UNIFI_API_KEY) {
    throw new Error('UNIFI_API_KEY is not set in .env.');
  }
  const res = await fetch(`${INTEGRATION_BASE}${path}`, {
    headers: { 'X-API-KEY': UNIFI_API_KEY, Accept: 'application/json' },
    dispatcher: localAgent,
  });
  if (!res.ok) {
    throw new Error(`Integrations API ${path} -> HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/**
 * GET every page of a paginated list endpoint (e.g. devices, clients,
 * firewall policies) and return the combined `data` array. The API defaults
 * to a 25-item page — a plain integrationsGet() call silently truncates
 * larger lists.
 */
export async function integrationsGetAll(path, { pageSize = 200 } = {}) {
  const sep = path.includes('?') ? '&' : '?';
  let offset = 0;
  let all = [];
  while (true) {
    const page = await integrationsGet(`${path}${sep}limit=${pageSize}&offset=${offset}`);
    all = all.concat(page.data ?? []);
    if (all.length >= (page.totalCount ?? all.length)) break;
    offset += pageSize;
  }
  return all;
}
