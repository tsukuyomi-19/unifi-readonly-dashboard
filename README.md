# UniFi Read-Only Dashboard

A small, dependency-light tool that pulls a full picture of a UniFi Network
site — device health, client counts, radio quality, firewall policy, and
VLAN inventory — using a single permanent API key, and renders it as a local
web dashboard plus a few CLI audit scripts.

**Every call in this project is a GET.** Nothing here can modify your
configuration.

## Why API-key-only matters

UniFi exposes two different APIs:

| | Classic / v2 API | Integrations API |
|---|---|---|
| Auth | Session login + cookie | Permanent `X-API-KEY` header |
| MFA | Breaks automation (cookie expires ~2h) | Unaffected |
| Firewall data | Yes (historically the only source) | Yes, on current versions |

Earlier versions of tools like this had to scrape the Classic API with a
browser cookie, because the Integrations API didn't expose firewall policies.
Current UniFi Network versions added `/sites/{id}/firewall/policies`,
`/sites/{id}/firewall/zones`, and `/sites/{id}/networks` to the Integrations
API — so the cookie dance is no longer necessary, and this project doesn't do
it. One credential, no MFA handling, no session refresh.

## Setup

```bash
git clone https://github.com/<you>/unifi-readonly-dashboard.git
cd unifi-readonly-dashboard
npm install
cp .env.example .env     # fill in UDM_HOST and UNIFI_API_KEY
npm run test-connection
```

Generate the API key in the Network app under
**Settings → Admins & Users → (your admin) → Create API Key**. The key
inherits that account's permissions, so a read-only admin is the safer choice
even though this code never writes.

## Usage

```bash
npm run dashboard         # web UI at http://localhost:4173
npm run security-audit    # device/client/radio/firmware hygiene, to stdout
npm run firewall-audit    # firewall policy + VLAN findings, to stdout
```

## What it reports

**Device and client health** — online/offline state, firmware update
availability, CPU and memory utilization against thresholds, switch port
capacity, and per-radio transmit retry percentages (a useful early signal for
RF congestion).

**Firewall policy analysis** — enumerates zone-to-zone policies and flags:

- Policies that allow traffic in a direction you probably didn't intend
- Zone pairs that are blanket-allow by **vendor default** rather than by your
  configuration — informational, since a narrower custom rule can still
  restrict specific traffic inside a pair
- Rules that are disabled but still present

**Network / VLAN inventory** — name, VLAN ID, subnet, firewall zone, client
isolation state, and enabled/disabled, with findings for common issues like a
guest network that isn't actually isolated or a leftover test VLAN that's
still enabled.

## Design notes

- **Pagination is handled explicitly.** The Integrations API defaults to
  25-item pages; a naive single GET silently truncates device and client
  lists. `integrationsGetAll()` walks `totalCount`.
- **Self-signed certs are accepted for the local console only.** The undici
  dispatcher with `rejectUnauthorized: false` is scoped to one agent that is
  only ever pointed at `UDM_HOST`, never at a third-party host.
- **Two cache tiers.** Device and client state changes constantly (15s cache);
  firewall and VLAN configuration almost never does (60s cache).
- **Partial failure is tolerated.** Per-device detail and statistics calls are
  individually caught, so one unreachable device degrades its own row rather
  than failing the whole snapshot.

## Limitations

- **Port forwards aren't exposed** by the Integrations API (404 as of Network
  app 10.5.67). That data lives only behind the Classic API. Check
  Settings → Port Forwarding manually.
- **Single site.** It reads the first site returned by `/sites`.
- **Network app only.** UniFi Protect and Access run on separate consoles with
  their own APIs and aren't covered.

## License

MIT
