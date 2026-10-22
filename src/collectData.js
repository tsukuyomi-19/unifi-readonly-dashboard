import { integrationsGet, integrationsGetAll } from './unifiClient.js';

const RETRY_WARN_PCT = 10;
const MEM_WARN_PCT = 75;
const CPU_WARN_PCT = 75;

function classifyState(state) {
  if (state === 'ONLINE') return 'good';
  if (state === 'OFFLINE') return 'critical';
  return 'warning'; // CONNECTION_INTERRUPTED, ISOLATED, or anything unrecognized
}

function summarizePorts(ports) {
  if (!ports?.length) return null;
  const up = ports.filter((p) => p.state === 'UP').length;
  const poeActive = ports.filter((p) => p.poe?.state === 'UP').length;
  return { total: ports.length, up, down: ports.length - up, poeActive };
}

/**
 * Builds one full snapshot of the site: devices (with live stats/ports/radios
 * for anything ONLINE), clients, and a few derived views useful to IT
 * (needs-attention, firmware status, resource/radio health, busiest devices).
 * Read-only — every call here is a GET.
 */
export async function buildSnapshot() {
  const [{ applicationVersion }, sitesRes] = await Promise.all([
    integrationsGet('/info'),
    integrationsGet('/sites'),
  ]);
  const site = sitesRes.data?.[0];
  if (!site) {
    return { appVersion: applicationVersion, site: null, devices: [], clients: { total: 0, wired: 0, wireless: 0 } };
  }

  const [deviceList, clientList] = await Promise.all([
    integrationsGetAll(`/sites/${site.id}/devices`),
    integrationsGetAll(`/sites/${site.id}/clients`),
  ]);

  const clientCountByDevice = new Map();
  for (const c of clientList) {
    if (!c.uplinkDeviceId) continue;
    clientCountByDevice.set(c.uplinkDeviceId, (clientCountByDevice.get(c.uplinkDeviceId) ?? 0) + 1);
  }

  const online = deviceList.filter((d) => d.state === 'ONLINE');
  const [details, stats] = await Promise.all([
    Promise.all(online.map((d) => integrationsGet(`/sites/${site.id}/devices/${d.id}`).catch(() => null))),
    Promise.all(online.map((d) => integrationsGet(`/sites/${site.id}/devices/${d.id}/statistics/latest`).catch(() => null))),
  ]);
  const detailById = new Map(online.map((d, i) => [d.id, details[i]]));
  const statsById = new Map(online.map((d, i) => [d.id, stats[i]]));

  const devices = deviceList.map((d) => {
    const detail = detailById.get(d.id);
    const stat = statsById.get(d.id);
    return {
      id: d.id,
      name: d.name ?? d.model,
      model: d.model,
      ipAddress: d.ipAddress,
      state: d.state,
      statusLevel: classifyState(d.state),
      firmwareVersion: d.firmwareVersion,
      firmwareUpdatable: !!d.firmwareUpdatable,
      isSwitch: d.features?.includes('switching') ?? false,
      clientCount: clientCountByDevice.get(d.id) ?? 0,
      uptimeSec: stat?.uptimeSec ?? null,
      cpuPct: stat?.cpuUtilizationPct ?? null,
      memPct: stat?.memoryUtilizationPct ?? null,
      ports: summarizePorts(detail?.interfaces?.ports),
      radios: (detail?.interfaces?.radios ?? []).map((r) => ({
        frequencyGHz: r.frequencyGHz,
        channel: r.channel ?? null,
        channelWidthMHz: r.channelWidthMHz ?? null,
        txRetriesPct: stat?.interfaces?.radios?.find((s) => s.frequencyGHz === r.frequencyGHz)?.txRetriesPct ?? null,
      })),
    };
  });

  const needsAttention = devices
    .filter((d) => d.statusLevel !== 'good')
    .sort((a, b) => a.name.localeCompare(b.name));

  const firmwareOutdated = devices.filter((d) => d.firmwareUpdatable);

  const topByClients = [...devices]
    .filter((d) => d.clientCount > 0)
    .sort((a, b) => b.clientCount - a.clientCount)
    .slice(0, 10);

  const resourceHealth = devices
    .filter((d) => d.cpuPct !== null || d.memPct !== null)
    .map((d) => ({ ...d, hot: (d.cpuPct ?? 0) >= CPU_WARN_PCT || (d.memPct ?? 0) >= MEM_WARN_PCT }))
    .sort((a, b) => Math.max(b.cpuPct ?? 0, b.memPct ?? 0) - Math.max(a.cpuPct ?? 0, a.memPct ?? 0));

  const radioHealth = devices
    .filter((d) => d.radios.length)
    .flatMap((d) => d.radios.map((r) => ({ device: d.name, ...r, warn: (r.txRetriesPct ?? 0) >= RETRY_WARN_PCT })))
    .sort((a, b) => (b.txRetriesPct ?? 0) - (a.txRetriesPct ?? 0));

  const portCapacity = devices
    .filter((d) => d.ports && d.isSwitch)
    .sort((a, b) => a.ports.down - b.ports.down);

  const wired = clientList.filter((c) => c.type === 'WIRED').length;

  return {
    appVersion: applicationVersion,
    site: { id: site.id, name: site.name },
    devices,
    clients: { total: clientList.length, wired, wireless: clientList.length - wired },
    needsAttention,
    firmwareOutdated,
    topByClients,
    resourceHealth,
    radioHealth,
    portCapacity,
    thresholds: { retryWarnPct: RETRY_WARN_PCT, memWarnPct: MEM_WARN_PCT, cpuWarnPct: CPU_WARN_PCT },
  };
}
