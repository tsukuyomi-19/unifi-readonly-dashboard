import { buildSnapshot } from '../src/collectData.js';

// Firewall rules, VLANs, and port forwards are only exposed through UniFi's
// older session-login "Classic" API, which this project deliberately does
// not use (see README). This audit is scoped to what the API-key-only
// Integrations API exposes: device/client health, resource usage, radio
// quality, port capacity, and firmware status.

const snap = await buildSnapshot();

console.log('Network hygiene check\n' + '='.repeat(50));
console.log(`Site: ${snap.site?.name} — UniFi Network ${snap.appVersion}`);
console.log(`Devices: ${snap.devices.length}  |  Clients: ${snap.clients.total} (${snap.clients.wired} wired, ${snap.clients.wireless} wireless)`);

console.log(`\n--- Needs attention (${snap.needsAttention.length}) ---`);
if (!snap.needsAttention.length) console.log('  None — every device reports ONLINE.');
for (const d of snap.needsAttention) console.log(`  ! ${d.name} [${d.model}]: ${d.state}`);

console.log(`\n--- Firmware (${snap.firmwareOutdated.length} update(s) available) ---`);
if (!snap.firmwareOutdated.length) console.log('  All devices are on their current firmware.');
for (const d of snap.firmwareOutdated) console.log(`  ! ${d.name}: ${d.firmwareVersion} (update available)`);

console.log(`\n--- Resource health (top 5 by CPU/memory) ---`);
for (const d of snap.resourceHealth.slice(0, 5)) {
  const flag = d.hot ? '  !' : '   ';
  console.log(`${flag} ${d.name} [${d.model}]: CPU ${d.cpuPct}%  Mem ${d.memPct}%  uptime ${Math.round((d.uptimeSec ?? 0) / 3600)}h`);
}

const noisyRadios = snap.radioHealth.filter((r) => r.warn);
console.log(`\n--- Wi-Fi radio quality (retry rate >= ${snap.thresholds.retryWarnPct}%) ---`);
if (!noisyRadios.length) console.log('  No radios above the retry-rate threshold.');
for (const r of noisyRadios) console.log(`  ! ${r.device}: ${r.frequencyGHz}GHz ch${r.channel} — ${r.txRetriesPct}% retries (possible interference/congestion)`);

console.log(`\n--- Switch port capacity ---`);
for (const d of snap.portCapacity) {
  const note = d.ports.down === 0 ? '  (full — no free ports)' : '';
  console.log(`   ${d.name}: ${d.ports.up}/${d.ports.total} ports up, ${d.ports.down} free${note}`);
}

console.log(
  '\nDone. This does not cover firewall rules, VLANs, or port forwards — ' +
    'those require the Classic API session login, which this project does not use.',
);
