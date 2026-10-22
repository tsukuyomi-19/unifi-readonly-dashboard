import { integrationsGet, integrationsGetAll } from '../src/unifiClient.js';

console.log('Testing read-only Integrations API access...\n');

const sites = await integrationsGet('/sites');
console.log(`Connected. Found ${sites.data?.length ?? 0} site(s):`);
for (const site of sites.data ?? []) {
  console.log(`  - ${site.name ?? site.id} (id: ${site.id})`);
}

const siteId = sites.data?.[0]?.id;
if (siteId) {
  const devices = await integrationsGetAll(`/sites/${siteId}/devices`);
  console.log(`\nDevices on site "${sites.data[0].name}": ${devices.length}`);
  for (const d of devices) {
    console.log(`  - ${d.name ?? d.model} [${d.model}] state=${d.state}`);
  }
}

console.log('\nRead-only access confirmed.');
