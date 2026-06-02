interface Env {
  HALO_CLIENT_ID: string;
  HALO_CLIENT_SECRET: string;
  HALO_BASE_URL: string;
  HALO_TENANT?: string;
  APP_NAME?: string;
}

interface AddressStore {
  line1?: string | null;
  line2?: string | null;
  line3?: string | null;
  line4?: string | null;
  postcode?: string | null;
  lat?: number | null;
  long?: number | null;
}

interface MapPoint {
  id: number;
  name: string;
  address: string;
  lat?: number;
  lng?: number;
  photoUrl?: string;
  siteName?: string;
}

interface MapDataResponse {
  agents: MapPoint[];
  organizations: MapPoint[];
  stats: {
    agentsTotal: number;
    agentsMapped: number;
    organizationsTotal: number;
    organizationsMapped: number;
  };
}

let tokenCache: { token: string; expires: number } | null = null;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return htmlResponse(getPageHtml(env.APP_NAME || "Halo Map"));
    }

    if (request.method === "GET" && url.pathname === "/api/map-data") {
      try {
        const data = await buildMapData(env);
        return jsonResponse(data);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return jsonResponse({ error: message }, 500);
      }
    }

    if (request.method === "GET" && url.pathname === "/api/agent-photo") {
      const photoPath = url.searchParams.get("path");
      if (!photoPath || !photoPath.startsWith("/AgentImage/")) {
        return new Response("Invalid path", { status: 400 });
      }
      try {
        const token = await getHaloToken(env);
        const imageUrl = joinUrl(env.HALO_BASE_URL, `/api${photoPath}`);
        const image = await fetch(imageUrl, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!image.ok) {
          return new Response("Photo not found", { status: image.status });
        }
        return new Response(image.body, {
          headers: {
            "Content-Type": image.headers.get("Content-Type") || "image/jpeg",
            "Cache-Control": "private, max-age=3600"
          }
        });
      } catch {
        return new Response("Photo fetch failed", { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};

async function buildMapData(env: Env): Promise<MapDataResponse> {
  const token = await getHaloToken(env);
  const base = trimSlash(env.HALO_BASE_URL);

  // Halo: 3 list calls (agents, clients, sites). Geocoding runs in the browser.
  const [agentsRaw, clientsRaw, sitesRaw] = await Promise.all([
    fetchAllAgents(base, token),
    fetchAllClients(base, token),
    fetchAllSites(base, token)
  ]);

  const agents: MapPoint[] = [];
  for (const agent of agentsRaw) {
    const addressText = agentAddressText(agent);
    if (!addressText) continue;
    const coords = coordsFromStore(agent.main_delivery_address);
    const point: MapPoint = {
      id: agent.id,
      name: agent.name || `Agent ${agent.id}`,
      address: addressText,
      ...(coords ? { lat: coords.lat, lng: coords.lng } : {})
    };
    if (agent.agentphotopath) {
      point.photoUrl = `/api/agent-photo?path=${encodeURIComponent(agent.agentphotopath)}`;
    }
    agents.push(point);
  }

  const organizations = buildOrganizations(clientsRaw, sitesRaw);

  return {
    agents,
    organizations,
    stats: {
      agentsTotal: agentsRaw.length,
      agentsMapped: agents.length,
      organizationsTotal: clientsRaw.length,
      organizationsMapped: organizations.length
    }
  };
}

// --- Halo auth & HTTP ---

async function getHaloToken(env: Env): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expires) {
    return tokenCache.token;
  }

  const base = trimSlash(env.HALO_BASE_URL);
  const tenant = env.HALO_TENANT?.trim() || inferTenant(base);
  const tokenUrls = [`${base}/auth/token`];
  if (tenant) {
    tokenUrls.push(`${base}/token?tenant=${encodeURIComponent(tenant)}`);
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.HALO_CLIENT_ID,
    client_secret: env.HALO_CLIENT_SECRET,
    scope: "all"
  });

  let lastError = "Unable to obtain Halo OAuth token.";
  for (const tokenUrl of tokenUrls) {
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
    const text = await response.text();
    if (!response.ok) {
      lastError = `Token ${response.status}`;
      continue;
    }
    const data = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      lastError = "Token response missing access_token";
      continue;
    }
    const expiresIn = data.expires_in ?? 3600;
    tokenCache = {
      token: data.access_token,
      expires: Date.now() + (expiresIn - 120) * 1000
    };
    return data.access_token;
  }
  throw new Error(lastError);
}

async function haloGet<T>(base: string, token: string, path: string): Promise<T> {
  const response = await fetch(joinUrl(base, path), {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error(`Halo GET ${path} failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

// --- Halo data fetch ---

interface HaloAgent {
  id: number;
  name?: string;
  is_agent?: boolean;
  isdisabled?: boolean;
  agentphotopath?: string;
  customfields?: HaloCustomField[];
  main_delivery_address?: AddressStore;
}

interface HaloCustomField {
  name?: string;
  label?: string;
  type?: number;
  value?: string;
}

interface HaloClient {
  id: number;
  name?: string;
  inactive?: boolean;
  main_site_id?: number;
  main_delivery_address?: AddressStore;
  customfields?: HaloCustomField[];
}

interface HaloSite {
  id: number;
  name?: string;
  client_id?: number;
  client_name?: string;
  defaultdelivery?: boolean;
  delivery_address?: AddressStore;
  invoice_address?: AddressStore;
}

/** One Halo list request; uses count (no pagination) when the API allows it. */
async function fetchHaloList<T>(
  base: string,
  token: string,
  resource: "Agent" | "Client" | "Site",
  params: Record<string, string>
): Promise<T[]> {
  const query = new URLSearchParams(params);
  const batch = await haloGet<T[] | Record<string, T[]>>(
    base,
    token,
    `/api/${resource}?${query}`
  );
  if (Array.isArray(batch)) return batch;
  const key = resource === "Agent" ? "agents" : resource === "Client" ? "clients" : "sites";
  return (batch as Record<string, T[]>)[key] ?? [];
}

async function fetchAllAgents(base: string, token: string): Promise<HaloAgent[]> {
  const query: Record<string, string> = {
    includeactive: "true",
    includeinactive: "false",
    includedetails: "true",
    page_size: "500",
    page_no: "1"
  };
  const list = await fetchHaloList<HaloAgent>(base, token, "Agent", query);
  return list.filter(
    (agent) => agent.is_agent && !agent.isdisabled && agent.name !== "Unassigned"
  );
}

async function fetchAllClients(base: string, token: string): Promise<HaloClient[]> {
  return fetchHaloList<HaloClient>(base, token, "Client", {
    includeactive: "true",
    includeinactive: "false",
    count: "5000"
  });
}

async function fetchAllSites(base: string, token: string): Promise<HaloSite[]> {
  return fetchHaloList<HaloSite>(base, token, "Site", {
    includeactive: "true",
    includeinactive: "false",
    includeaddress: "true",
    count: "5000"
  });
}

function buildOrganizations(clients: HaloClient[], sites: HaloSite[]): MapPoint[] {
  const sitePick = new Map<number, { score: number; siteName?: string; text: string; store?: AddressStore }>();

  for (const site of sites) {
    const clientId = site.client_id != null ? Math.round(site.client_id) : 0;
    if (!clientId) continue;
    const store = site.delivery_address || site.invoice_address;
    const text = addressStoreToText(store);
    if (!text) continue;
    const score = siteScore(site);
    const existing = sitePick.get(clientId);
    if (!existing || score > existing.score) {
      sitePick.set(clientId, { score, siteName: site.name, text, store });
    }
  }

  const points: MapPoint[] = [];
  for (const client of clients) {
    if (client.inactive) continue;
    const name = client.name || `Client ${client.id}`;
    let addressText = addressStoreToText(client.main_delivery_address);
    let store = client.main_delivery_address;
    let siteName: string | undefined;

    const picked = sitePick.get(client.id);
    if (picked) {
      if (!addressText || picked.score >= 2) {
        addressText = picked.text;
        store = picked.store;
        siteName = picked.siteName;
      }
    }
    if (!addressText) addressText = customFieldAddress(client.customfields);
    if (!addressText) continue;

    const coords = coordsFromStore(store);
    points.push({
      id: client.id,
      name,
      address: addressText,
      siteName,
      ...(coords ? { lat: coords.lat, lng: coords.lng } : {})
    });
  }
  return points;
}

function siteScore(site: HaloSite): number {
  let score = 0;
  if (site.defaultdelivery) score += 4;
  if ((site.name || "").toLowerCase() === "main") score += 3;
  if (site.delivery_address?.line1) score += 2;
  else if (site.invoice_address?.line1) score += 1;
  return score;
}

// --- Address helpers ---

function agentAddressText(agent: HaloAgent): string | null {
  const fromCustom = customFieldAddress(agent.customfields);
  if (fromCustom) return fromCustom;
  return addressStoreToText(agent.main_delivery_address);
}

function customFieldAddress(fields?: HaloCustomField[]): string | null {
  if (!fields?.length) return null;
  for (const field of fields) {
    const name = `${field.name || ""} ${field.label || ""}`.toLowerCase();
    if (!/mail|address|location/.test(name)) continue;
    const value = (field.value || "").trim();
    if (!value || value.startsWith("<")) continue;
    if (field.type !== undefined && field.type !== 0) continue;
    return value;
  }
  return null;
}

function addressStoreToText(addr?: AddressStore | null): string | null {
  if (!addr) return null;
  const parts = [addr.line1, addr.line2, addr.line3, addr.line4, addr.postcode]
    .map((p) => (p || "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function coordsFromStore(addr?: AddressStore | null): { lat: number; lng: number } | null {
  if (!addr?.lat || !addr?.long) return null;
  if (Math.abs(addr.lat) < 0.0001 && Math.abs(addr.long) < 0.0001) return null;
  return { lat: addr.lat, lng: addr.long };
}

// --- Utilities ---

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function joinUrl(base: string, path: string): string {
  const b = trimSlash(base);
  return path.startsWith("/") ? `${b}${path}` : `${b}/${path}`;
}

function inferTenant(baseUrl: string): string | undefined {
  try {
    const host = new URL(baseUrl).hostname;
    const parts = host.split(".");
    if (
      parts.length >= 3 &&
      (host.endsWith(".halopsa.com") || host.endsWith(".haloservicedesk.com"))
    ) {
      return parts[0];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

// --- UI (single page, dark mode, Leaflet) ---

function getPageHtml(title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: #0f1419;
      color: #e7ecf3;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 16px;
      padding: 12px 16px;
      background: #161b22;
      border-bottom: 1px solid #30363d;
      z-index: 1000;
    }
    h1 { font-size: 1.1rem; font-weight: 600; }
    .toggles { display: flex; gap: 20px; align-items: center; }
    .toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      user-select: none;
      font-size: 0.95rem;
    }
    .toggle input { width: 18px; height: 18px; accent-color: #58a6ff; }
    .stats {
      margin-left: auto;
      font-size: 0.85rem;
      color: #8b949e;
    }
    #map { flex: 1; min-height: 0; background: #0d1117; }
    #status {
      padding: 8px 16px;
      font-size: 0.85rem;
      background: #161b22;
      border-top: 1px solid #30363d;
      color: #8b949e;
    }
    #status.error { color: #f85149; }
    .leaflet-tooltip {
      background: #21262d;
      border: 1px solid #30363d;
      color: #e7ecf3;
      border-radius: 6px;
      padding: 8px 10px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    }
    .leaflet-tooltip::before { border-top-color: #30363d; }
    .tip-title { font-weight: 600; margin-bottom: 4px; }
    .tip-addr { font-size: 0.8rem; color: #8b949e; max-width: 220px; }
    .tip-photo {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      object-fit: cover;
      margin-bottom: 6px;
      border: 2px solid #30363d;
    }
    .agent-marker {
      background: #58a6ff;
      border: 2px solid #fff;
      border-radius: 50%;
      width: 14px;
      height: 14px;
    }
    .org-marker {
      background: #3fb950;
      border: 2px solid #fff;
      border-radius: 3px;
      width: 12px;
      height: 12px;
    }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(title)}</h1>
    <div class="toggles">
      <label class="toggle"><input type="checkbox" id="showAgents" checked /> Agents</label>
      <label class="toggle"><input type="checkbox" id="showOrgs" checked /> Organizations</label>
    </div>
    <div class="stats" id="stats">Loading…</div>
  </header>
  <div id="map"></div>
  <div id="status">Fetching Halo data…</div>

  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const map = L.map("map", { zoomControl: true }).setView([39.5, -98.35], 4);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; CARTO',
      subdomains: "abcd",
      maxZoom: 19
    }).addTo(map);

    const agentLayer = L.layerGroup().addTo(map);
    const orgLayer = L.layerGroup().addTo(map);

    function agentIcon() {
      return L.divIcon({
        className: "",
        html: '<div class="agent-marker"></div>',
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      });
    }

    function orgIcon() {
      return L.divIcon({
        className: "",
        html: '<div class="org-marker"></div>',
        iconSize: [12, 12],
        iconAnchor: [6, 6]
      });
    }

    function tooltipHtml(point, kind) {
      const photo = point.photoUrl
        ? '<img class="tip-photo" src="' + point.photoUrl + '" alt="" />'
        : "";
      const site = point.siteName
        ? '<div class="tip-addr">' + escapeHtml(point.siteName) + "</div>"
        : "";
      return (
        photo +
        '<div class="tip-title">' + escapeHtml(point.name) + "</div>" +
        '<div class="tip-addr">' + escapeHtml(kind) + "</div>" +
        site +
        '<div class="tip-addr">' + escapeHtml(point.address) + "</div>"
      );
    }

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    const geocodeCache = new Map();

    async function geocodeAddress(address) {
      const key = address.trim().toLowerCase();
      if (geocodeCache.has(key)) return geocodeCache.get(key);
      const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
        encodeURIComponent(address);
      const res = await fetch(url, {
        headers: { "User-Agent": "HaloPSA-Client-Mapper/1.0 (browser)" }
      });
      if (!res.ok) {
        geocodeCache.set(key, null);
        return null;
      }
      const hits = await res.json();
      const hit = hits[0];
      const coords = hit && hit.lat && hit.lon
        ? { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon) }
        : null;
      geocodeCache.set(key, coords);
      await new Promise((r) => setTimeout(r, 200));
      return coords;
    }

    async function resolvePoint(point) {
      if (point.lat != null && point.lng != null) {
        return { lat: point.lat, lng: point.lng };
      }
      return geocodeAddress(point.address);
    }

    async function addMarkers(layer, points, kind, iconFn, statusEl) {
      layer.clearLayers();
      const bounds = [];
      let geocoded = 0;
      let skipped = 0;
      for (const p of points) {
        const coords = await resolvePoint(p);
        if (!coords) {
          skipped++;
          continue;
        }
        geocoded++;
        const m = L.marker([coords.lat, coords.lng], { icon: iconFn() });
        m.bindTooltip(tooltipHtml(p, kind), {
          direction: "top",
          offset: [0, -8],
          opacity: 1
        });
        m.addTo(layer);
        bounds.push([coords.lat, coords.lng]);
        if (geocoded % 5 === 0) {
          statusEl.textContent = "Placing " + kind.toLowerCase() + " pins… " + geocoded + " on map";
        }
      }
      return { bounds, geocoded, skipped };
    }

    function updateVisibility() {
      const showA = document.getElementById("showAgents").checked;
      const showO = document.getElementById("showOrgs").checked;
      if (showA) map.addLayer(agentLayer); else map.removeLayer(agentLayer);
      if (showO) map.addLayer(orgLayer); else map.removeLayer(orgLayer);
    }

    document.getElementById("showAgents").addEventListener("change", updateVisibility);
    document.getElementById("showOrgs").addEventListener("change", updateVisibility);

    async function load() {
      const status = document.getElementById("status");
      const statsEl = document.getElementById("stats");
      try {
        const res = await fetch("/api/map-data");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);

        status.textContent = "Geocoding addresses in browser (keeps Worker fast)…";
        const agentResult = await addMarkers(agentLayer, data.agents, "Agent", agentIcon, status);
        const orgResult = await addMarkers(orgLayer, data.organizations, "Organization", orgIcon, status);
        const all = agentResult.bounds.concat(orgResult.bounds);
        if (all.length) map.fitBounds(all, { padding: [40, 40], maxZoom: 12 });

        const pinsOnMap = agentResult.geocoded + orgResult.geocoded;
        const skipped = agentResult.skipped + orgResult.skipped;
        statsEl.textContent =
          agentResult.geocoded + "/" + data.stats.agentsMapped + " agents · " +
          orgResult.geocoded + "/" + data.stats.organizationsMapped + " orgs on map";
        status.textContent = pinsOnMap
          ? "Ready — " + pinsOnMap + " pins" + (skipped ? " (" + skipped + " addresses could not be geocoded)" : "") + ". Hover for details."
          : "No pins placed. Check that Halo has mailing addresses (agents) or site addresses (orgs).";
        status.classList.remove("error");
      } catch (e) {
        status.textContent = "Error: " + (e.message || e);
        status.classList.add("error");
        statsEl.textContent = "";
      }
    }

    load();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
