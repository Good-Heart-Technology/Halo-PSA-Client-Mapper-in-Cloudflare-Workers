interface Env {
  HALO_CLIENT_ID: string;
  HALO_CLIENT_SECRET: string;
  HALO_BASE_URL: string;
  HALO_TENANT?: string;
  /** Optional Halo custom field id for agent mailing address (include_custom_fields). */
  HALO_AGENT_ADDRESS_FIELD_ID?: string;
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

interface DebugLog {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
}

interface ConfigCheck {
  key: string;
  label: string;
  required: boolean;
  loaded: boolean;
  ok: boolean;
  detail: string;
}

interface MapDataResponse {
  agents: MapPoint[];
  organizations: MapPoint[];
  stats: {
    agentsTotal: number;
    agentsMapped: number;
    agentsWithAddress: number;
    organizationsTotal: number;
    organizationsMapped: number;
    sitesTotal: number;
    sitesWithAddress: number;
  };
  configChecks: ConfigCheck[];
  debug: DebugLog[];
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
        return jsonResponse(emptyMapDataResponse(message, env), 500);
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

function emptyMapDataResponse(errorMessage: string, env?: Env): MapDataResponse {
  const { checks, logs } = env ? validateEnvConfig(env) : { checks: [] as ConfigCheck[], logs: [] as DebugLog[] };
  return {
    agents: [],
    organizations: [],
    stats: {
      agentsTotal: 0,
      agentsMapped: 0,
      agentsWithAddress: 0,
      organizationsTotal: 0,
      organizationsMapped: 0,
      sitesTotal: 0,
      sitesWithAddress: 0
    },
    configChecks: checks,
    debug: [
      ...logs,
      { at: new Date().toISOString(), level: "error", message: errorMessage }
    ]
  };
}

function validateEnvConfig(env: Env): { checks: ConfigCheck[]; logs: DebugLog[] } {
  const at = new Date().toISOString();
  const checks: ConfigCheck[] = [
    checkSecret("HALO_CLIENT_ID", "Halo Client ID", true, env.HALO_CLIENT_ID, (v) =>
      v.length >= 8 ? null : "value too short"
    ),
    checkSecret("HALO_CLIENT_SECRET", "Halo Client Secret", true, env.HALO_CLIENT_SECRET, (v) =>
      v.length >= 8 ? null : "value too short"
    ),
    checkSecret("HALO_BASE_URL", "Halo Base URL", true, env.HALO_BASE_URL, (v) => {
      try {
        const u = new URL(v);
        if (u.protocol !== "https:") return "must use https://";
        if (!u.hostname) return "missing hostname";
        return null;
      } catch {
        return "not a valid URL";
      }
    }),
    checkSecret("HALO_TENANT", "Halo Tenant", false, env.HALO_TENANT, (v) =>
      /^[a-z0-9-]+$/i.test(v) ? null : "unexpected format"
    ),
    checkSecret(
      "HALO_AGENT_ADDRESS_FIELD_ID",
      "Agent address field ID",
      false,
      env.HALO_AGENT_ADDRESS_FIELD_ID,
      (v) => (/^\d+$/.test(v) ? null : "should be numeric id")
    ),
    checkSecret("APP_NAME", "App name (var)", false, env.APP_NAME, () => null)
  ];

  const logs: DebugLog[] = checks.map((c) => ({
    at,
    level: c.ok ? "info" : c.required ? "error" : "warn",
    message: `Config ${c.key}: ${c.ok ? "OK" : "FAIL"} — ${c.detail}`
  }));

  const missingRequired = checks.filter((c) => c.required && !c.ok).length;
  logs.unshift({
    at,
    level: missingRequired ? "error" : "info",
    message: missingRequired
      ? `Config: ${missingRequired} required secret(s) missing or invalid`
      : "Config: all required secrets loaded"
  });

  return { checks, logs };
}

function checkSecret(
  key: string,
  label: string,
  required: boolean,
  raw: string | undefined,
  validate: (value: string) => string | null
): ConfigCheck {
  const value = (raw ?? "").trim();
  const loaded = value.length > 0;
  let detail = loaded ? "loaded" : "not set";
  let valid = true;

  if (loaded) {
    const err = validate(value);
    if (err) {
      valid = false;
      detail = `loaded — ${err}`;
    } else if (key.includes("SECRET") || key.includes("CLIENT_ID")) {
      detail = `loaded (${value.length} chars)`;
    } else if (key === "HALO_BASE_URL") {
      try {
        detail = `loaded — ${new URL(value).host}`;
      } catch {
        detail = "loaded";
      }
    }
  } else if (required) {
    valid = false;
    detail = "missing (required)";
  } else {
    detail = "not set (optional)";
  }

  const ok = required ? loaded && valid : !loaded || valid;
  return { key, label, required, loaded, ok, detail };
}

function createDebugLog(): { logs: DebugLog[]; log: (level: DebugLog["level"], message: string) => void } {
  const logs: DebugLog[] = [];
  return {
    logs,
    log(level, message) {
      logs.push({ at: new Date().toISOString(), level, message });
    }
  };
}

async function buildMapData(env: Env): Promise<MapDataResponse> {
  const { logs, log } = createDebugLog();
  const { checks: configChecks, logs: configLogs } = validateEnvConfig(env);
  for (const line of configLogs) logs.push(line);

  const missingRequired = configChecks.some((c) => c.required && !c.ok);
  if (missingRequired) {
    return {
      agents: [],
      organizations: [],
      stats: {
        agentsTotal: 0,
        agentsMapped: 0,
        agentsWithAddress: 0,
        organizationsTotal: 0,
        organizationsMapped: 0,
        sitesTotal: 0,
        sitesWithAddress: 0
      },
      configChecks,
      debug: logs
    };
  }

  const base = trimSlash(env.HALO_BASE_URL);
  log("info", `Halo base URL host: ${safeHost(base)}`);

  const token = await getHaloToken(env, log);

  const [agentsRaw, clientsRaw, sitesRaw] = await Promise.all([
    fetchAllAgents(base, token, log, env),
    fetchAllClients(base, token, log),
    fetchAllSites(base, token, log)
  ]);

  const agents: MapPoint[] = [];
  let agentsWithAddress = 0;
  let agentsNoAddress = 0;
  for (const agent of agentsRaw) {
    const addressText = agentAddressText(agent);
    if (!addressText) {
      agentsNoAddress++;
      continue;
    }
    agentsWithAddress++;
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
  if (agentsNoAddress > 0) {
    log("warn", `${agentsNoAddress} agent(s) skipped — no mailing/address custom field on list response`);
  }
  log("info", `Agents with address text: ${agentsWithAddress} → ${agents.length} map entries`);

  const sitesWithAddress = sitesRaw.filter(
    (s) => addressStoreToText(s.delivery_address) || addressStoreToText(s.invoice_address)
  ).length;
  const organizations = buildOrganizations(clientsRaw, sitesRaw, log);

  return {
    agents,
    organizations,
    stats: {
      agentsTotal: agentsRaw.length,
      agentsMapped: agents.length,
      agentsWithAddress,
      organizationsTotal: clientsRaw.length,
      organizationsMapped: organizations.length,
      sitesTotal: sitesRaw.length,
      sitesWithAddress
    },
    configChecks,
    debug: logs
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid URL)";
  }
}

// --- Halo auth & HTTP ---

async function getHaloToken(
  env: Env,
  log?: (level: DebugLog["level"], message: string) => void
): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expires) {
    log?.("info", "Using cached Halo OAuth token");
    return tokenCache.token;
  }

  const base = trimSlash(env.HALO_BASE_URL);
  const tenant = env.HALO_TENANT?.trim() || inferTenant(base);
  const tokenUrls = [`${base}/auth/token`];
  if (tenant) {
    tokenUrls.push(`${base}/token?tenant=${encodeURIComponent(tenant)}`);
    log?.("info", `OAuth tenant: ${tenant}`);
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
      lastError = `Token ${response.status} ${response.statusText}`;
      log?.("warn", `Token failed: ${tokenUrl} → ${lastError}`);
      continue;
    }
    const data = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      lastError = "Token response missing access_token";
      log?.("warn", `Token missing access_token from ${tokenUrl}`);
      continue;
    }
    const expiresIn = data.expires_in ?? 3600;
    tokenCache = {
      token: data.access_token,
      expires: Date.now() + (expiresIn - 120) * 1000
    };
    log?.("info", `Halo OAuth token obtained (expires in ~${expiresIn}s)`);
    return data.access_token;
  }
  log?.("error", lastError);
  throw new Error(lastError);
}

async function haloGet(
  base: string,
  token: string,
  path: string
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; statusText: string; body: string }> {
  const response = await fetch(joinUrl(base, path), {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` }
  });
  const body = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      statusText: response.statusText,
      body: body.slice(0, 300)
    };
  }
  let data: unknown;
  try {
    data = body ? JSON.parse(body) : null;
  } catch {
    return { ok: false, status: response.status, statusText: "Invalid JSON", body: body.slice(0, 300) };
  }
  return { ok: true, data };
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

const LIST_KEYS: Record<"Agent" | "Client" | "Site", string[]> = {
  Agent: ["agents", "agent", "uname"],
  Client: ["clients", "client", "areas", "area"],
  Site: ["sites", "site"]
};

function extractHaloList<T>(data: unknown, resource: "Agent" | "Client" | "Site"): T[] {
  if (Array.isArray(data)) return data as T[];
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;
  for (const key of LIST_KEYS[resource]) {
    const value = record[key];
    if (Array.isArray(value)) return value as T[];
  }
  return [];
}

function describeHaloShape(data: unknown): string {
  if (Array.isArray(data)) return `array[${data.length}]`;
  if (!data || typeof data !== "object") return String(data);
  const keys = Object.keys(data as object);
  const parts = keys.slice(0, 8).map((k) => {
    const v = (data as Record<string, unknown>)[k];
    return Array.isArray(v) ? `${k}[${v.length}]` : k;
  });
  return `{ ${parts.join(", ")} }`;
}

/** One Halo list request. */
async function fetchHaloList<T>(
  base: string,
  token: string,
  resource: "Agent" | "Client" | "Site",
  params: Record<string, string>,
  log: (level: DebugLog["level"], message: string) => void
): Promise<T[]> {
  const query = new URLSearchParams(params);
  const path = `/api/${resource}?${query}`;
  const result = await haloGet(base, token, path);
  if (!result.ok) {
    log("error", `GET ${path} → ${result.status} ${result.statusText}`);
    if (result.body) log("error", `Body: ${result.body}`);
    return [];
  }
  const list = extractHaloList<T>(result.data, resource);
  log(
    "info",
    `GET ${resource}?${query} → ${list.length} rows (shape: ${describeHaloShape(result.data)})`
  );
  return list;
}

async function fetchAllAgents(
  base: string,
  token: string,
  log: (level: DebugLog["level"], message: string) => void,
  env: Env
): Promise<HaloAgent[]> {
  const params: Record<string, string> = {
    activeinactive: "true,false",
    includedetails: "true",
    pageinate: "true",
    page_size: "500",
    page_no: "1"
  };
  if (env.HALO_AGENT_ADDRESS_FIELD_ID?.trim()) {
    params.include_custom_fields = env.HALO_AGENT_ADDRESS_FIELD_ID.trim();
    log("info", `Agent include_custom_fields=${params.include_custom_fields}`);
  }
  let list = await fetchHaloList<HaloAgent>(base, token, "Agent", params, log);

  if (list.length === 0) {
    log("warn", "Agent list empty — retrying with includeactive/includeinactive");
    list = await fetchHaloList<HaloAgent>(
      base,
      token,
      "Agent",
      {
        includeactive: "true",
        includeinactive: "false",
        includedetails: "true",
        page_size: "500",
        page_no: "1"
      },
      log
    );
  }

  const before = list.length;
  const filtered = list.filter(isActiveAgent);
  log(
    "info",
    `Agents after filter: ${filtered.length} of ${before} (drop Unassigned/disabled/non-agent)`
  );
  if (filtered.length === 0 && before > 0) {
    const sample = list.slice(0, 3).map((a) => `${a.name}(is_agent=${a.is_agent})`).join(", ");
    log("warn", `Sample unfiltered agents: ${sample}`);
  }
  return filtered;
}

function isActiveAgent(agent: HaloAgent): boolean {
  if (agent.name === "Unassigned") return false;
  if (agent.isdisabled) return false;
  if (agent.is_agent === false) return false;
  return true;
}

async function fetchAllClients(
  base: string,
  token: string,
  log: (level: DebugLog["level"], message: string) => void
): Promise<HaloClient[]> {
  let list = await fetchHaloList<HaloClient>(
    base,
    token,
    "Client",
    { includeactive: "true", includeinactive: "false", count: "5000" },
    log
  );
  if (list.length === 0) {
    log("warn", "Client list empty with count=5000 — retrying paginated");
    list = await fetchHaloList<HaloClient>(
      base,
      token,
      "Client",
      {
        includeactive: "true",
        includeinactive: "false",
        pageinate: "true",
        page_size: "100",
        page_no: "1"
      },
      log
    );
  }
  return list.filter((c) => !c.inactive);
}

async function fetchAllSites(
  base: string,
  token: string,
  log: (level: DebugLog["level"], message: string) => void
): Promise<HaloSite[]> {
  let list = await fetchHaloList<HaloSite>(
    base,
    token,
    "Site",
    {
      includeactive: "true",
      includeinactive: "false",
      includeaddress: "true",
      count: "5000"
    },
    log
  );
  if (list.length === 0) {
    log("warn", "Site list empty with count=5000 — retrying paginated");
    list = await fetchHaloList<HaloSite>(
      base,
      token,
      "Site",
      {
        includeactive: "true",
        includeinactive: "false",
        includeaddress: "true",
        pageinate: "true",
        page_size: "100",
        page_no: "1"
      },
      log
    );
  }
  return list;
}

function buildOrganizations(
  clients: HaloClient[],
  sites: HaloSite[],
  log: (level: DebugLog["level"], message: string) => void
): MapPoint[] {
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

  log("info", `Site address index: ${sitePick.size} client(s) with a site address`);

  const points: MapPoint[] = [];
  let noAddress = 0;
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
    if (!addressText) {
      noAddress++;
      continue;
    }

    const coords = coordsFromStore(store);
    points.push({
      id: client.id,
      name,
      address: addressText,
      siteName,
      ...(coords ? { lat: coords.lat, lng: coords.lng } : {})
    });
  }
  if (noAddress > 0) {
    log(
      "warn",
      `${noAddress} org(s) have no address (need site delivery_address or client custom field on list API)`
    );
  }
  log("info", `Organizations with address text: ${points.length}`);
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
    .tabs { display: flex; gap: 4px; }
    .tab {
      padding: 6px 12px;
      border: 1px solid #30363d;
      border-radius: 6px;
      background: #21262d;
      color: #8b949e;
      cursor: pointer;
      font-size: 0.85rem;
    }
    .tab.active { background: #30363d; color: #e7ecf3; border-color: #58a6ff; }
    .panel { display: none; flex: 1; min-height: 0; flex-direction: column; }
    .panel.active { display: flex; }
    #map { flex: 1; min-height: 0; background: #0d1117; }
    #debugPanel {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 12px 16px;
      background: #0d1117;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.8rem;
      line-height: 1.5;
    }
    .log-line { margin-bottom: 6px; word-break: break-word; }
    .log-line.info { color: #8b949e; }
    .log-line.warn { color: #d29922; }
    .log-line.error { color: #f85149; }
    .log-time { color: #484f58; margin-right: 8px; }
    #configChecks {
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid #30363d;
    }
    #configChecks h2 {
      font-size: 0.85rem;
      font-weight: 600;
      color: #8b949e;
      margin-bottom: 8px;
      font-family: system-ui, sans-serif;
    }
    .cfg-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 4px;
      font-family: system-ui, sans-serif;
      font-size: 0.82rem;
    }
    .cfg-dot {
      flex-shrink: 0;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-top: 4px;
    }
    .cfg-dot.ok { background: #3fb950; box-shadow: 0 0 6px #3fb95066; }
    .cfg-dot.bad { background: #f85149; box-shadow: 0 0 6px #f8514966; }
    .cfg-key { color: #e7ecf3; min-width: 220px; }
    .cfg-key code { font-size: 0.78rem; color: #58a6ff; }
    .cfg-meta { color: #8b949e; }
    .cfg-badge {
      font-size: 0.7rem;
      padding: 1px 5px;
      border-radius: 4px;
      margin-left: 6px;
      background: #30363d;
      color: #8b949e;
    }
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
    <div class="tabs">
      <button type="button" class="tab active" data-panel="mapPanel">Map</button>
      <button type="button" class="tab" data-panel="debugPanel">Debug</button>
    </div>
    <div class="toggles map-only">
      <label class="toggle"><input type="checkbox" id="showAgents" checked /> Agents</label>
      <label class="toggle"><input type="checkbox" id="showOrgs" checked /> Organizations</label>
    </div>
    <div class="stats" id="stats">Loading…</div>
  </header>
  <div id="mapPanel" class="panel active">
    <div id="map"></div>
  </div>
  <div id="debugPanelWrap" class="panel">
    <div id="debugPanel">No debug output yet. Load map data first.</div>
  </div>
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

    function showPanel(panelId) {
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      const panel = panelId === "debugPanel"
        ? document.getElementById("debugPanelWrap")
        : document.getElementById("mapPanel");
      panel.classList.add("active");
      document.querySelector('.tab[data-panel="' + panelId + '"]').classList.add("active");
      document.querySelectorAll(".map-only").forEach((el) => {
        el.style.display = panelId === "mapPanel" ? "" : "none";
      });
      if (panelId === "mapPanel") setTimeout(() => map.invalidateSize(), 50);
    }

    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => showPanel(tab.getAttribute("data-panel")));
    });

    function renderConfigChecks(checks) {
      if (!checks || !checks.length) return "";
      const rows = checks.map((c) => {
        const dot = c.ok ? "ok" : "bad";
        const req = c.required
          ? '<span class="cfg-badge">required</span>'
          : '<span class="cfg-badge">optional</span>';
        return '<div class="cfg-row">' +
          '<span class="cfg-dot ' + dot + '" title="' + (c.ok ? "OK" : "FAIL") + '"></span>' +
          '<span class="cfg-key"><code>' + escapeHtml(c.key) + "</code> " + escapeHtml(c.label) + req + "</span>" +
          '<span class="cfg-meta">' + escapeHtml(c.detail) + "</span>" +
          "</div>";
      }).join("");
      return '<div id="configChecks"><h2>Worker secrets &amp; variables</h2>' + rows + "</div>";
    }

    function renderDebug(logs, configChecks) {
      const el = document.getElementById("debugPanel");
      const cfgHtml = renderConfigChecks(configChecks);
      const logHtml = (!logs || !logs.length)
        ? '<div class="log-line warn">No log lines returned.</div>'
        : logs.map((line) => {
            const t = line.at ? line.at.replace("T", " ").replace("Z", " UTC") : "";
            return '<div class="log-line ' + escapeHtml(line.level) + '">' +
              '<span class="log-time">' + escapeHtml(t) + "</span>" +
              escapeHtml(line.message) + "</div>";
          }).join("");
      el.innerHTML = cfgHtml + (cfgHtml ? '<h2 style="font-size:0.85rem;color:#8b949e;margin:12px 0 8px;font-family:system-ui,sans-serif">Runtime log</h2>' : "") + logHtml;
    }

    async function load() {
      const status = document.getElementById("status");
      const statsEl = document.getElementById("stats");
      try {
        const res = await fetch("/api/map-data");
        const data = await res.json();
        renderDebug(data.debug, data.configChecks);
        if (!res.ok) throw new Error(data.error || res.statusText);

        const s = data.stats;
        statsEl.textContent =
          s.agentsTotal + " agents (" + s.agentsMapped + " w/ address) · " +
          s.organizationsTotal + " orgs (" + s.organizationsMapped + " w/ address) · " +
          s.sitesWithAddress + "/" + s.sitesTotal + " sites w/ address";

        if (!data.agents.length && !data.organizations.length) {
          status.textContent = "Halo returned no mappable addresses — open Debug tab for API details.";
          status.classList.add("error");
          showPanel("debugPanel");
          return;
        }

        status.textContent = "Geocoding addresses in browser (keeps Worker fast)…";
        const agentResult = await addMarkers(agentLayer, data.agents, "Agent", agentIcon, status);
        const orgResult = await addMarkers(orgLayer, data.organizations, "Organization", orgIcon, status);
        const all = agentResult.bounds.concat(orgResult.bounds);
        if (all.length) map.fitBounds(all, { padding: [40, 40], maxZoom: 12 });

        const pinsOnMap = agentResult.geocoded + orgResult.geocoded;
        const skipped = agentResult.skipped + orgResult.skipped;
        statsEl.textContent =
          pinsOnMap + " pins · " +
          agentResult.geocoded + "/" + data.agents.length + " agents · " +
          orgResult.geocoded + "/" + data.organizations.length + " orgs";
        status.textContent = pinsOnMap
          ? "Ready — " + pinsOnMap + " pins" + (skipped ? " (" + skipped + " could not be geocoded)" : "") + ". Hover for details."
          : "Addresses found but geocoding failed — check Debug tab; Nominatim may be rate-limiting.";
        status.classList.remove("error");
      } catch (e) {
        status.textContent = "Error: " + (e.message || e);
        status.classList.add("error");
        statsEl.textContent = "";
        showPanel("debugPanel");
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
