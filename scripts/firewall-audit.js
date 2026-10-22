import { buildFirewallSnapshot } from '../src/firewallData.js';

// Uses the same permanent local API key as everything else in this project —
// no session cookie, no MFA. Port forwards have no equivalent in this API
// yet, so a periodic manual look at
// Settings -> Port Forwarding on the console covers that gap for now.

const snap = await buildFirewallSnapshot();

console.log('Firewall analysis (read-only)\n' + '='.repeat(50));
console.log(`Zones: ${[...snap.zoneName.values()].join(', ')}`);
console.log(`Policies: ${snap.policies.length} total (${snap.custom.length} custom, ${snap.policies.length - snap.custom.length} vendor-predefined)`);
console.log(`Networks: ${snap.networkById.size}`);

console.log(`\n--- Broad WAN-inbound custom rules (${snap.broadWanInbound.length}) ---`);
console.log('Enabled custom ALLOW rules with an unrestricted source in the External zone, allowing any destination port, not scoped to established/related return traffic.');
if (!snap.broadWanInbound.length) console.log('  None found.');
for (const p of snap.broadWanInbound) {
  console.log(`\n  ! "${p.name}"  (protocol: ${p.ipProtocolScope?.protocolFilter?.protocol?.name ?? 'all'})`);
  console.log(`      source:      ${snap.describeEndpoint(p.source)}`);
  console.log(`      destination: ${snap.describeEndpoint(p.destination)}  <- ${snap.describePort(p.destination.trafficFilter)}`);
  const others = (snap.custom.filter((s) => s.name === p.name && s.id !== p.id)).map((s) => snap.zoneName.get(s.source?.zoneId));
  if (others.length) console.log(`      also applies to source zones: ${others.join(', ')} (same rule, auto-expanded)`);
}

console.log(`\n--- Redundant / duplicate custom rules (${snap.redundantGroups.length} pair/group(s)) ---`);
console.log('Differently-named rules that match on identical criteria (zone-expansion instances of the same rule are excluded — those are expected, not a bug).');
if (!snap.redundantGroups.length) console.log('  None found.');
for (const names of snap.redundantGroups) {
  console.log(`  ! ${names.length} rules do exactly the same thing: ${names.map((n) => `"${n}"`).join(', ')}`);
}

console.log(`\n--- Dangling references (${snap.danglingPolicies.length}) ---`);
console.log('Policies pointing at a network id that no longer exists.');
if (!snap.danglingPolicies.length) console.log('  None found.');
for (const { policy, missing } of snap.danglingPolicies) {
  console.log(`  ! "${policy.name}" references missing: ${missing.join(', ')}`);
}

console.log(`\n--- Default zone trust (vendor-predefined, informational) ---`);
console.log('Zone pairs Ubiquiti ships as blanket-allow by default — not something you configured, but worth knowing:');
for (const t of snap.defaultZoneTrust) console.log(`   ${t.from} -> ${t.to}: allowed by default`);

console.log(`\n--- Networks worth a second look (${snap.networkFindings.length}) ---`);
if (!snap.networkFindings.length) console.log('  None found.');
for (const f of snap.networkFindings) console.log(`  ! ${f.name}: ${f.reasons.join('; ')}`);

console.log(
  '\nDone. Port forwards are not covered here (no API for them yet) — check Settings -> Port Forwarding directly.',
);
