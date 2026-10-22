import { integrationsGet, integrationsGetAll } from './unifiClient.js';

function describeTrafficFilter(tf, networkById) {
  if (!tf) return 'any';
  switch (tf.type) {
    case 'NETWORK': {
      const names = (tf.networkFilter?.networkIds ?? []).map((id) => networkById.get(id)?.name ?? id);
      return `network: ${names.join(', ')}`;
    }
    case 'IP_ADDRESS': {
      const items = (tf.ipAddressFilter?.items ?? []).map((i) => i.value).join(', ');
      return `IP: ${items || 'specific'}`;
    }
    case 'APPLICATION':
      return `${tf.applicationFilter?.items?.length ?? 0} specific app(s)`;
    case 'APPLICATION_CATEGORY':
      return 'app categor(y/ies)';
    case 'DOMAIN': {
      const items = (tf.domainFilter?.items ?? []).map((i) => i.value).join(', ');
      return `domains: ${items}`;
    }
    default:
      return tf.type;
  }
}

function describePort(tf) {
  const pf = tf?.portFilter;
  if (!pf) return 'any port';
  const items = (pf.items ?? []).map((i) => (i.value != null ? i.value : `${i.rangeStart}-${i.rangeEnd}`));
  return `port ${items.join(', ')}`;
}

function normSide(side) {
  const tf = side.trafficFilter;
  return JSON.stringify({
    zone: side.zoneId,
    type: tf?.type ?? 'ANY',
    networks: [...(tf?.networkFilter?.networkIds ?? [])].sort(),
    ips: (tf?.ipAddressFilter?.items ?? []).map((i) => i.value).sort(),
    apps: (tf?.applicationFilter?.items ?? []).map((i) => i.id ?? i.value).sort(),
    appCats: (tf?.applicationCategoryFilter?.items ?? []).map((i) => i.id ?? i.value).sort(),
    domains: (tf?.domainFilter?.items ?? []).map((i) => i.value).sort(),
    ports: (tf?.portFilter?.items ?? []).map((i) => (i.value != null ? i.value : `${i.rangeStart}-${i.rangeEnd}`)).sort(),
  });
}

function policySignature(p) {
  return JSON.stringify({
    action: p.action?.type,
    allowReturn: p.action?.allowReturnTraffic,
    ipVersion: p.ipProtocolScope?.ipVersion,
    protocol: p.ipProtocolScope?.protocolFilter?.protocol?.name ?? 'ANY',
    cst: [...(p.connectionStateFilter ?? [])].sort().join(','),
    src: normSide(p.source ?? {}),
    dst: normSide(p.destination ?? {}),
  });
}

function danglingRefs(side, networkById) {
  const missing = [];
  for (const id of side.trafficFilter?.networkFilter?.networkIds ?? []) {
    if (!networkById.has(id)) missing.push(`network ${id}`);
  }
  return missing;
}

function subnetOf(net) {
  const v4 = net.ipv4Configuration;
  if (!v4?.hostIpAddress) return null;
  return `${v4.hostIpAddress}/${v4.prefixLength}`;
}

/**
 * Pulls the Zone-Based Firewall config (zones, policies, networks) from the
 * modern, permanent-API-key Integrations API — no session cookie, no MFA,
 * same credential as everything else in this project. Every call here is a
 * GET; nothing in this module can modify configuration.
 *
 * Note: port forwards have no equivalent in this API yet (404 as of Network
 * app 10.5.67) — that data only exists behind the old session-auth Classic
 * API, which this project no longer uses. Port forward lists are typically
 * short, so a periodic manual look at Settings -> Port Forwarding covers it.
 */
export async function buildFirewallSnapshot(site = 'default') {
  const sitesRes = await integrationsGet('/sites');
  const siteId = sitesRes.data?.[0]?.id;
  if (!siteId) throw new Error('No sites returned from the Integrations API.');

  const [zones, policies, networkList] = await Promise.all([
    integrationsGetAll(`/sites/${siteId}/firewall/zones`),
    integrationsGetAll(`/sites/${siteId}/firewall/policies`),
    integrationsGetAll(`/sites/${siteId}/networks`),
  ]);

  // The list view lacks subnet/isolation detail; fetch full detail per
  // network (only ~20 of them, cheap on the local network).
  const networksDetailed = await Promise.all(
    networkList.map((n) => integrationsGet(`/sites/${siteId}/networks/${n.id}`).catch(() => n)),
  );

  const zoneName = new Map(zones.map((z) => [z.id, z.name]));
  const networkById = new Map(networksDetailed.map((n) => [n.id, n]));
  const externalZoneId = zones.find((z) => z.name === 'External')?.id;

  function describeEndpoint(side) {
    const zone = zoneName.get(side.zoneId) ?? side.zoneId;
    return `${zone} (${describeTrafficFilter(side.trafficFilter, networkById)})`;
  }

  const custom = policies.filter((p) => p.metadata?.origin === 'USER_DEFINED');
  const enabledCustom = custom.filter((p) => p.enabled);

  // Dangling references: a policy pointing at a network id that no longer
  // exists (e.g. deleted after the rule was created).
  const danglingPolicies = policies.flatMap((p) => {
    const missing = [...danglingRefs(p.source ?? {}, networkById), ...danglingRefs(p.destination ?? {}, networkById)];
    return missing.length ? [{ policy: p, missing }] : [];
  });

  // The ZBF UI silently expands one logical rule into one policy per source
  // zone whenever its source isn't pinned to a specific zone — so the same
  // rule name can appear multiple times, identical except source.zoneId.
  // Group by name so those read as one finding, not N near-duplicates.
  const byName = new Map();
  for (const p of custom) {
    if (!byName.has(p.name)) byName.set(p.name, []);
    byName.get(p.name).push(p);
  }

  // Redundancy: two *differently named* custom rules that match on
  // everything except name/id/index/schedule are genuinely redundant —
  // same-named zone-expansion instances of one rule are not (handled above).
  const bySignature = new Map();
  for (const p of enabledCustom) {
    const sig = policySignature(p);
    if (!bySignature.has(sig)) bySignature.set(sig, new Set());
    bySignature.get(sig).add(p.name);
  }
  const namePairsSeen = new Set();
  const redundantGroups = [];
  for (const names of bySignature.values()) {
    if (names.size < 2) continue;
    const key = [...names].sort().join('|||');
    if (namePairsSeen.has(key)) continue;
    namePairsSeen.add(key);
    redundantGroups.push([...names]);
  }

  // Broad WAN-inbound: custom, enabled ALLOW rules from the External zone,
  // with NO source restriction at all (a true wildcard, not e.g. a specific
  // printer IP group that merely got a dormant External-zone variant from
  // the auto-expansion above), not scoped to established/related return
  // traffic, and allowing any destination port.
  const broadWanInboundRaw = enabledCustom.filter(
    (p) =>
      p.action?.type === 'ALLOW' &&
      p.source?.zoneId === externalZoneId &&
      !p.source?.trafficFilter &&
      !(p.connectionStateFilter?.length) &&
      !p.destination?.trafficFilter?.portFilter,
  );
  const broadWanInbound = broadWanInboundRaw.map((p) => ({
    ...p,
    otherZones: (byName.get(p.name) ?? [])
      .filter((sibling) => sibling.id !== p.id)
      .map((sibling) => zoneName.get(sibling.source?.zoneId) ?? sibling.source?.zoneId),
  }));

  // Vendor-default zone trust worth knowing about (not a misconfiguration):
  // at least one system-defined, enabled, cross-zone ALLOW rule with no
  // restriction on either side and no established/related-only scoping.
  // This says "a blanket-allow rule exists for this pair" — a narrower
  // custom rule elsewhere could still restrict specific traffic within it,
  // so treat this as informational, not a definitive "nothing is filtered".
  const zoneTrustSeen = new Set();
  const defaultZoneTrust = [];
  for (const p of policies) {
    if (
      p.metadata?.origin === 'SYSTEM_DEFINED' &&
      p.enabled &&
      p.action?.type === 'ALLOW' &&
      !p.source?.trafficFilter &&
      !p.destination?.trafficFilter &&
      !(p.connectionStateFilter?.length) &&
      p.source?.zoneId !== p.destination?.zoneId
    ) {
      const key = `${p.source.zoneId}->${p.destination.zoneId}`;
      if (zoneTrustSeen.has(key)) continue;
      zoneTrustSeen.add(key);
      defaultZoneTrust.push({ from: zoneName.get(p.source.zoneId), to: zoneName.get(p.destination.zoneId) });
    }
  }

  // Networks worth a second look: name suggests "guest" but client isolation
  // isn't actually on, or name suggests "test"/"temp" but still enabled.
  const networkFindings = networksDetailed
    .map((n) => {
      const reasons = [];
      if (/guest/i.test(n.name) && n.isolationEnabled === false) {
        reasons.push('named "guest" but client isolation is not enabled');
      }
      if (/\btest\b|\btemp\b/i.test(n.name) && n.enabled) {
        reasons.push('name suggests temporary/test, but it is still enabled');
      }
      return reasons.length ? { name: n.name, reasons } : null;
    })
    .filter(Boolean);

  return {
    zones,
    zoneName,
    policies,
    custom,
    networkById,
    networksDetailed,
    danglingPolicies,
    redundantGroups,
    broadWanInbound,
    defaultZoneTrust,
    networkFindings,
    describeEndpoint,
    describePort,
  };
}

/**
 * JSON-safe version of buildFirewallSnapshot() for the web dashboard — the
 * snapshot itself holds Maps and a closure (describeEndpoint) that don't
 * serialize, so this resolves everything to plain strings/arrays first.
 */
export async function buildFirewallReport(site = 'default') {
  const snap = await buildFirewallSnapshot(site);

  const zones = snap.zones.map((z) => ({ id: z.id, name: z.name }));

  const policyCounts = {
    total: snap.policies.length,
    custom: snap.custom.length,
    predefined: snap.policies.length - snap.custom.length,
    enabled: snap.policies.filter((p) => p.enabled).length,
    disabled: snap.policies.filter((p) => !p.enabled).length,
  };

  const broadWanInbound = snap.broadWanInbound.map((p) => ({
    name: p.name,
    protocol: p.ipProtocolScope?.protocolFilter?.protocol?.name ?? 'all',
    source: snap.describeEndpoint(p.source),
    destination: snap.describeEndpoint(p.destination),
    otherZones: p.otherZones,
  }));

  const danglingPolicies = snap.danglingPolicies.map(({ policy, missing }) => ({ name: policy.name, missing }));

  const networks = snap.networksDetailed.map((n) => ({
    name: n.name,
    vlan: n.vlanId ?? null,
    subnet: subnetOf(n),
    zone: snap.zoneName.get(n.zoneId) ?? null,
    enabled: n.enabled,
    isolationEnabled: n.isolationEnabled ?? null,
  }));

  return {
    zones,
    policyCounts,
    broadWanInbound,
    redundantGroups: snap.redundantGroups,
    danglingPolicies,
    defaultZoneTrust: snap.defaultZoneTrust,
    networkFindings: snap.networkFindings,
    networks,
  };
}
