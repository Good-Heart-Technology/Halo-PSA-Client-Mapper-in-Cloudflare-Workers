# Halo PSA Client & Agent Map

A Cloudflare Worker that maps **Halo PSA agents** and **client organizations** on a dark-mode Leaflet map. Addresses come from Halo; geocoding runs in the browser via a Worker proxy to stay within Cloudflare limits.

## Features

- **Interactive map** — Pan and zoom; the map fits all pins when loading completes.
- **Agent pins** — Blue circular markers; distinct from organizations.
- **Organization pins** — Green square markers.
- **Hover tooltips** — Name, type, site (orgs), and full address on hover.
- **Agent photos** — Profile images from Halo (`agentphotopath`), proxied through the Worker.
- **Organization logos** — Client logos from Halo (`logo` / attachment images), proxied through the Worker.
- **Layer toggles** — Show or hide **Agents** and **Organizations** independently.
- **Loading progress** — Top-right progress bar during Halo fetch and geocoding.
- **Debug tab** — Runtime log and a checklist of required secrets/variables (no secret values shown).

## Configuration

### Required secrets

Set these in the Cloudflare dashboard (**Workers & Pages** → your Worker → **Settings** → **Variables and Secrets**) or with Wrangler:

```bash
wrangler secret put HALO_CLIENT_ID
wrangler secret put HALO_CLIENT_SECRET
wrangler secret put HALO_BASE_URL
```

| Variable | Definition |
|----------|------------|
| `HALO_CLIENT_ID` | OAuth **client ID** for your Halo API application (from Halo **Settings → Integrations → Halo API**). |
| `HALO_CLIENT_SECRET` | OAuth **client secret** paired with the client ID. Used only on the Worker to obtain a Bearer token; never sent to the browser. |
| `HALO_BASE_URL` | Your Halo instance base URL, e.g. `https://yourtenant.halopsa.com` (no trailing slash). All Halo API and image requests use this host. |

### Optional secrets

| Variable | Definition |
|----------|------------|
| `HALO_TENANT` | OAuth **tenant** slug for hosted Halo (e.g. `goodheart`). If omitted, the Worker infers it from the hostname in `HALO_BASE_URL` (subdomain before `.halopsa.com`). |
| `HALO_AGENT_ADDRESS_FIELD_ID` | Halo **custom field ID** for each agent’s mailing address. Defaults to **297** if unset. Must match the field you use for agent locations in Halo. |

### Optional variable (not a secret)

Defined in `wrangler.toml` under `[vars]` or overridden in the dashboard:

| Variable | Definition |
|----------|------------|
| `APP_NAME` | Title shown in the page header (default in repo: `Halo Client & Agent Map`). |

## Custom domain (Cloudflare dashboard)

This Worker is configured with `workers_dev = false`, so it is **not** served on `*.workers.dev`. Attach your own hostname:

1. Open the [Cloudflare dashboard](https://dash.cloudflare.com) and select the account that owns the Worker.
2. Go to **Workers & Pages** → **halo-psa-client-mapper** (or your deployed Worker name).
3. Open **Settings** → **Domains & Routes** (or **Triggers** → **Custom Domains**, depending on the UI).
4. Click **Add** / **Add Custom Domain**.
5. Enter the hostname (e.g. `map.yourdomain.com`). The zone must be on the same Cloudflare account.
6. Confirm DNS — Cloudflare usually creates the required record automatically.
7. Wait for SSL to become active, then open the custom URL. Routes on that hostname will hit this Worker.

For a path on an existing site (e.g. `yourdomain.com/halo-map/*`), use **Routes** instead and add a pattern that matches this Worker.

## Deploy

```bash
npm install
wrangler deploy
```

Ensure all required secrets are set in the target environment before use. The **Debug** tab confirms whether each value is loaded (not the actual secret values).

## Repository

[Good-Heart-Technology/Halo-PSA-Client-Mapper-in-Cloudflare-Workers](https://github.com/Good-Heart-Technology/Halo-PSA-Client-Mapper-in-Cloudflare-Workers)
