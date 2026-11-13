import { worstLevel, type Incident, type Level, type ProviderSnapshot, type ServiceIssue, type StatusBoard, type StatusCounts } from "./types";

const MAX_ISSUES = 80;
const MAX_RECENT = 3;
const MAX_SCHEDULED = 4;

type Fail = { error: string };

function isFail(value: unknown): value is Fail {
  return Boolean(value && typeof value === "object" && "error" in value && typeof (value as Fail).error === "string");
}

export function plain(text: string, max = 420): string {
  const decoded = decodeEntities(text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
  const cleaned = decoded
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#>*_`~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

function decodeEntities(value: string): string {
  const amp = String.fromCharCode(38);
  let current = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = current
      .replaceAll(`${amp}nbsp;`, " ")
      .replaceAll(`${amp}#160;`, " ")
      .replaceAll(`${amp}amp;`, amp)
      .replaceAll(`${amp}lt;`, "<")
      .replaceAll(`${amp}gt;`, ">")
      .replaceAll(`${amp}quot;`, '"')
      .replaceAll(`${amp}#39;`, "'")
      .replaceAll(`${amp}apos;`, "'");
    if (next === current) break;
    current = next;
  }
  return current;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function isoOrNull(value: unknown): string | null {
  const raw = str(value).trim();
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

function unixIso(value: unknown): string | null {
  const n = typeof value === "number" ? value : Number(str(value));
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function isOpen(end: unknown, now: number): boolean {
  if (end == null || end === "") return true;
  const t = Date.parse(str(end));
  if (Number.isNaN(t)) return true;
  return t > now;
}

function emptyCounts(): StatusCounts {
  return { operational: 0, info: 0, degraded: 0, outage: 0, maintenance: 0 };
}

function bump(counts: StatusCounts, level: Level) {
  if (level === "unknown") return;
  counts[level] += 1;
}

function googleLevel(impact: unknown, severity: unknown): Level {
  const kind = str(impact);
  const severityName = str(severity);
  if (kind === "SERVICE_OUTAGE") return "outage";
  if (kind === "SERVICE_DISRUPTION") return severityName === "high" ? "outage" : "degraded";
  if (kind === "SERVICE_INFORMATION") return "info";
  if (severityName === "high") return "outage";
  return "degraded";
}

function titles(value: unknown): string[] {
  const names: string[] = [];
  for (const item of asArray(value)) {
    const row = asRecord(item);
    const title = plain(str(row?.title || row?.name || item), 80);
    if (title) names.push(title);
  }
  return names;
}

function googleIncidents(data: unknown, now: number, urlFor: (row: Record<string, unknown>) => string): {
  active: Incident[];
  recent: Incident[];
} {
  const active: Incident[] = [];
  const recent: Incident[] = [];
  for (const item of asArray(data)) {
    const row = asRecord(item);
    if (!row) continue;
    const products = titles(row.affected_products);
    const regions = titles(row.currently_affected_locations);
    const previous = titles(row.previously_affected_locations);
    const update = asRecord(row.most_recent_update);
    const summary = plain(str(row.external_desc || update?.text || ""), 460);
    const incident: Incident = {
      id: str(row.id) || summary.slice(0, 24),
      title: plain(str(row.service_name) || products[0] || "Incidente", 120),
      level: googleLevel(row.status_impact, row.severity),
      summary: summary || "Sin descripción publicada.",
      startedAt: isoOrNull(row.begin),
      updatedAt: isoOrNull(update?.when || row.modified || row.end),
      url: urlFor(row),
      regions: regions.length ? regions.slice(0, 6) : previous.slice(0, 4),
      services: products.slice(0, 8),
      state: isOpen(row.end, now) ? "active" : "resolved",
    };
    if (incident.state === "active") active.push(incident);
    else recent.push(incident);
  }
  recent.sort((a, b) => str(b.updatedAt).localeCompare(str(a.updatedAt)));
  return { active, recent: recent.slice(0, MAX_RECENT) };
}

function levelSort(a: Level, b: Level): number {
  const order: Level[] = ["outage", "degraded", "maintenance", "info", "operational", "unknown"];
  return order.indexOf(a) - order.indexOf(b);
}

function headlineFor(level: Level, active: number, noun: string): string {
  if (active === 0 && level === "operational") return "Sin incidentes activos en el tablero público";
  if (level === "outage") return active === 1 ? `1 ${noun} con interrupción` : `${active} ${noun}s con interrupción`;
  if (level === "degraded") return active === 1 ? `1 ${noun} degradado` : `${active} ${noun}s degradados`;
  if (level === "maintenance") return "Mantenimiento en curso";
  if (level === "info") return "Aviso informativo publicado";
  if (level === "unknown") return "No se pudo leer la fuente oficial";
  return "Operativo";
}

function packIssues(issues: ServiceIssue[]): { issues: ServiceIssue[]; issueTotal: number } {
  const ranked = [...issues].sort(
    (a, b) => levelSort(a.level, b.level) || a.name.localeCompare(b.name, "es"),
  );
  return { issues: ranked.slice(0, MAX_ISSUES), issueTotal: issues.length };
}

function baseProvider(
  input: Omit<ProviderSnapshot, "level" | "headline" | "issues" | "issueTotal"> & { issues: ServiceIssue[] },
  noun: string,
): ProviderSnapshot {
  const active = input.incidents.filter((item) => item.state === "active");
  const level = input.error ? "unknown" : worstLevel(active.map((item) => item.level));
  const packed = packIssues(input.issues);
  const incidents = [...input.incidents].sort((a, b) => {
    const stateOrder = { active: 0, scheduled: 1, resolved: 2 };
    return (
      stateOrder[a.state] - stateOrder[b.state] ||
      levelSort(a.level, b.level) ||
      str(b.updatedAt).localeCompare(str(a.updatedAt))
    );
  });
  return {
    ...input,
    ...packed,
    incidents,
    level: input.error ? "unknown" : active.length ? level : "operational",
    headline: input.error ? "No se pudo leer la fuente oficial" : headlineFor(active.length ? level : "operational", active.length, noun),
  };
}

function failed(template: ProviderSnapshot, error: string): ProviderSnapshot {
  return {
    ...template,
    level: "unknown",
    headline: "No se pudo leer la fuente oficial",
    error,
    incidents: [],
    recent: [],
    issues: [],
    issueTotal: 0,
    counts: null,
    updatedAt: null,
  };
}

const shell = {
  gcp: (): ProviderSnapshot => ({
    id: "gcp",
    company: "Google",
    name: "Google Cloud",
    short: "Cloud",
    level: "unknown",
    headline: "",
    sourceUrl: "https://status.cloud.google.com/",
    sourceLabel: "status.cloud.google.com",
    updatedAt: null,
    error: null,
    note: "Incidentes del tablero público. No hay semáforo por producto fuera de un incidente.",
    incidents: [],
    recent: [],
    issues: [],
    issueTotal: 0,
    counts: null,
    countsLabel: null,
  }),
  workspace: (): ProviderSnapshot => ({
    id: "workspace",
    company: "Google",
    name: "Google Workspace",
    short: "Workspace",
    level: "unknown",
    headline: "",
    sourceUrl: "https://www.google.com/appsstatus/dashboard/",
    sourceLabel: "appsstatus",
    updatedAt: null,
    error: null,
    note: "Incidentes públicos de Workspace: Gmail, Drive, Meet y el resto del paquete.",
    incidents: [],
    recent: [],
    issues: [],
    issueTotal: 0,
    counts: null,
    countsLabel: null,
  }),
  aws: (): ProviderSnapshot => ({
    id: "aws",
    company: "Amazon",
    name: "Amazon Web Services",
    short: "AWS",
    level: "unknown",
    headline: "",
    sourceUrl: "https://health.aws.amazon.com/health/status",
    sourceLabel: "AWS Health",
    updatedAt: null,
    error: null,
    note: "Eventos públicos de AWS. El estado privado de tu cuenta no sale en este feed.",
    incidents: [],
    recent: [],
    issues: [],
    issueTotal: 0,
    counts: null,
    countsLabel: null,
  }),
  azure: (): ProviderSnapshot => ({
    id: "azure",
    company: "Microsoft",
    name: "Microsoft Azure",
    short: "Azure",
    level: "unknown",
    headline: "",
    sourceUrl: "https://azure.status.microsoft/en-us/status",
    sourceLabel: "Azure Status",
    updatedAt: null,
    error: null,
    note: "El feed público solo publica incidentes amplios. Los avisos de tu suscripción están en Azure Service Health.",
    incidents: [],
    recent: [],
    issues: [],
    issueTotal: 0,
    counts: null,
    countsLabel: null,
  }),
  m365: (): ProviderSnapshot => ({
    id: "m365",
    company: "Microsoft",
    name: "Microsoft 365",
    short: "M365",
    level: "unknown",
    headline: "",
    sourceUrl: "https://status.cloud.microsoft/",
    sourceLabel: "status.cloud.microsoft",
    updatedAt: null,
    error: null,
    note: "Estado del centro de administración de Microsoft 365, Teams, Exchange y servicios asociados.",
    incidents: [],
    recent: [],
    issues: [],
    issueTotal: 0,
    counts: null,
    countsLabel: null,
  }),
  cloudflare: (): ProviderSnapshot => ({
    id: "cloudflare",
    company: "Cloudflare",
    name: "Cloudflare",
    short: "Cloudflare",
    level: "unknown",
    headline: "",
    sourceUrl: "https://www.cloudflarestatus.com/",
    sourceLabel: "cloudflarestatus.com",
    updatedAt: null,
    error: null,
    note: "Resumen oficial de productos y de cada centro de datos.",
    incidents: [],
    recent: [],
    issues: [],
    issueTotal: 0,
    counts: null,
    countsLabel: null,
  }),
};

function awsLevel(code: unknown): Level {
  switch (str(code)) {
    case "0":
      return "operational";
    case "1":
      return "info";
    case "2":
      return "degraded";
    case "3":
      return "outage";
    default:
      return "unknown";
  }
}

function rssItems(xml: string): Array<Record<string, string>> {
  const items: Array<Record<string, string>> = [];
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = match[1] ?? "";
    const fields: Record<string, string> = {};
    for (const tag of ["title", "link", "pubDate", "guid", "description", "status"]) {
      const found = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
      if (found?.[1]) fields[tag] = found[1];
    }
    items.push(fields);
  }
  return items;
}

function namedServices(summary: string): string[] {
  const names: string[] = [];
  for (const match of summary.matchAll(/(?:^|\s)-\s+([^:]{2,60}):/g)) {
    const name = match[1]?.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names.slice(0, 12);
}

function m365Level(status: string): Level {
  const value = status.toLowerCase();
  if (value.includes("interruption") || value.includes("outage")) return "outage";
  if (value.includes("degradation") || value.includes("extendedrecovery") || value.includes("investigating")) {
    return "degraded";
  }
  if (value.includes("restored") || value.includes("operational") || value.includes("falsepositive") || value.includes("postincident")) {
    return "operational";
  }
  return status ? "info" : "degraded";
}

function cfLevel(status: unknown): Level {
  switch (str(status)) {
    case "operational":
      return "operational";
    case "degraded_performance":
      return "degraded";
    case "partial_outage":
    case "major_outage":
      return "outage";
    case "under_maintenance":
      return "maintenance";
    default:
      return "unknown";
  }
}

function cfIndicator(indicator: unknown): Level {
  switch (str(indicator)) {
    case "none":
      return "operational";
    case "minor":
      return "degraded";
    case "major":
    case "critical":
      return "outage";
    case "maintenance":
      return "maintenance";
    default:
      return "unknown";
  }
}

const CF_HEADLINE: Record<string, string> = {
  none: "Todos los sistemas operativos",
  minor: "Degradación parcial",
  major: "Interrupción importante",
  critical: "Interrupción crítica",
  maintenance: "Mantenimiento en curso",
};

function isLocation(name: string): boolean {
  return /\s-\s\([A-Z0-9]{2,6}\)$/.test(name);
}

export type RawFeeds = {
  now: string;
  cloudflare: unknown;
  gcp: unknown;
  workspace: unknown;
  aws: unknown;
  azureXml: unknown;
  m365Xml: unknown;
};

export function buildBoard(raw: RawFeeds): StatusBoard {
  const now = Date.parse(raw.now);
  return {
    fetchedAt: raw.now,
    providers: [
      buildGoogle("gcp", raw.gcp, now, (row) => {
        const uri = str(row.uri);
        return uri ? `https://status.cloud.google.com/${uri}` : "https://status.cloud.google.com/";
      }),
      buildGoogle("workspace", raw.workspace, now, (row) => {
        const id = str(row.id);
        return id
          ? `https://www.google.com/appsstatus/dashboard/incidents/${id}`
          : "https://www.google.com/appsstatus/dashboard/";
      }),
      buildAws(raw.aws),
      buildRss("azure", raw.azureXml),
      buildRss("m365", raw.m365Xml),
      buildCloudflare(raw.cloudflare, now),
    ],
  };
}

function buildGoogle(
  id: "gcp" | "workspace",
  data: unknown,
  now: number,
  urlFor: (row: Record<string, unknown>) => string,
): ProviderSnapshot {
  const template = shell[id]();
  if (isFail(data)) return failed(template, data.error);
  if (!Array.isArray(data)) return failed(template, "La fuente no devolvió la lista de incidentes.");
  const parsed = googleIncidents(data, now, urlFor);
  const updatedAt = [...parsed.active, ...parsed.recent].map((item) => item.updatedAt).find(Boolean) ?? null;
  return baseProvider(
    {
      ...template,
      updatedAt,
      incidents: [...parsed.active],
      recent: parsed.recent,
      issues: [],
    },
    "incidente",
  );
}

function buildAws(data: unknown): ProviderSnapshot {
  const template = shell.aws();
  if (isFail(data)) return failed(template, data.error);
  if (!Array.isArray(data)) return failed(template, "AWS Health no devolvió la lista de eventos.");
  const incidents: Incident[] = [];
  const issues: ServiceIssue[] = [];
  const seen = new Map<string, Level>();
  const counts = emptyCounts();
  let updatedAt: string | null = null;

  for (const item of data) {
    const row = asRecord(item);
    if (!row) continue;
    const logs = asArray(row.event_log).map(asRecord).filter((entry): entry is Record<string, unknown> => Boolean(entry));
    const last = logs.at(-1);
    const startedAt = unixIso(row.date);
    const touched = unixIso(last?.timestamp) || startedAt;
    if (touched && (!updatedAt || touched > updatedAt)) updatedAt = touched;
    const region = plain(str(row.region_name), 40) || null;
    const level = awsLevel(row.status);
    incidents.push({
      id: str(row.arn) || str(row.service),
      title: plain(str(last?.summary || row.summary || row.service_name), 140) || "Evento de AWS",
      level: level === "unknown" ? "degraded" : level,
      summary: plain(str(last?.message || row.summary), 520) || "AWS publicó un evento sin detalle.",
      startedAt,
      updatedAt: touched,
      url: "https://health.aws.amazon.com/health/status",
      regions: region ? [region] : [],
      services: [],
      state: "active",
    });

    const impacted = asRecord(row.impacted_services) ?? {};
    for (const info of Object.values(impacted)) {
      const service = asRecord(info);
      if (!service) continue;
      const name = plain(str(service.service_name), 80);
      if (!name) continue;
      const serviceLevel = awsLevel(service.current);
      if (serviceLevel === "unknown") continue;
      const key = `${name}|${region ?? ""}`;
      const previous = seen.get(key);
      if (!previous || levelSort(serviceLevel, previous) < 0) seen.set(key, serviceLevel);
    }
  }

  for (const [key, level] of seen) {
    const [name, region] = key.split("|");
    bump(counts, level);
    if (level === "operational" || !name) continue;
    issues.push({
      name,
      level,
      group: null,
      region: region || null,
      kind: "product",
    });
  }

  const provider = baseProvider(
    {
      ...template,
      updatedAt,
      incidents,
      recent: [],
      issues,
      counts,
      countsLabel: incidents.length ? "Servicios citados en los eventos abiertos" : null,
    },
    "evento",
  );
  if (!incidents.length && !provider.error) {
    provider.headline = "Sin eventos públicos abiertos";
    provider.level = "operational";
  }
  return provider;
}

function buildRss(id: "azure" | "m365", data: unknown): ProviderSnapshot {
  const template = shell[id]();
  if (isFail(data)) return failed(template, data.error);
  if (typeof data !== "string" || !data.includes("<rss")) {
    return failed(template, "La fuente no devolvió un feed RSS.");
  }
  const incidents: Incident[] = [];
  const recent: Incident[] = [];
  let updatedAt: string | null = null;
  for (const item of rssItems(data)) {
    const summary = plain(item.description || "", 700);
    const services = namedServices(summary);
    const rawTitle = plain(item.title || (id === "azure" ? "Azure" : "Microsoft 365"), 140);
    const sentence = (summary.split(/(?<=\.)\s/)[0] ?? "").replace(/^(user impact|more info)\s*:\s*/i, "");
    const title =
      id === "m365" && /admin center/i.test(rawTitle) && sentence.length > 20
        ? plain(sentence, 140)
        : rawTitle;
    const when = isoOrNull(item.pubDate);
    if (when && (!updatedAt || when > updatedAt)) updatedAt = when;
    const level = id === "m365" ? m365Level(item.status || "") : "degraded";
    const resolved = id === "m365" && level === "operational";
    const incident: Incident = {
      id: plain(item.guid || title, 80),
      title: title || (id === "azure" ? "Incidente de Azure" : "Incidente de Microsoft 365"),
      level: resolved ? "info" : level === "operational" ? "degraded" : level,
      summary: summary || "Sin descripción publicada.",
      startedAt: when,
      updatedAt: when,
      url: item.link?.startsWith("http") ? item.link : template.sourceUrl,
      regions: [],
      services,
      state: resolved ? "resolved" : "active",
    };
    if (resolved) recent.push(incident);
    else incidents.push(incident);
  }
  const provider = baseProvider(
    { ...template, updatedAt, incidents, recent, issues: [] },
    "incidente",
  );
  if (!incidents.length && !provider.error) {
    provider.level = "operational";
    provider.headline = id === "azure" ? "Sin incidentes públicos amplios" : "Sin incidentes activos";
  }
  return provider;
}

function buildCloudflare(data: unknown, now: number): ProviderSnapshot {
  const template = shell.cloudflare();
  if (isFail(data)) return failed(template, data.error);
  const row = asRecord(data);
  if (!row) return failed(template, "Cloudflare no devolvió el resumen de estado.");
  const page = asRecord(row.page);
  const status = asRecord(row.status);
  const indicator = str(status?.indicator || "none");
  const groups = new Map<string, string>();
  for (const item of asArray(row.components)) {
    const component = asRecord(item);
    if (component?.group === true) groups.set(str(component.id), str(component.name));
  }

  const issues: ServiceIssue[] = [];
  const counts = emptyCounts();
  for (const item of asArray(row.components)) {
    const component = asRecord(item);
    if (!component || component.group === true) continue;
    const level = cfLevel(component.status);
    if (level === "unknown") continue;
    bump(counts, level);
    if (level === "operational") continue;
    const name = plain(str(component.name), 90);
    if (!name) continue;
    issues.push({
      name,
      level,
      group: groups.get(str(component.group_id)) || null,
      region: null,
      kind: isLocation(name) ? "location" : "product",
    });
  }

  const incidents: Incident[] = [];
  for (const item of asArray(row.incidents)) {
    const incident = asRecord(item);
    if (!incident) continue;
    const updates = asArray(incident.incident_updates).map(asRecord).filter((entry): entry is Record<string, unknown> => Boolean(entry));
    const latest = updates[0];
    const impact = str(incident.impact);
    const level: Level =
      impact === "critical" || impact === "major" ? "outage" : impact === "maintenance" ? "maintenance" : "degraded";
    incidents.push({
      id: str(incident.id),
      title: plain(str(incident.name), 160) || "Incidente de Cloudflare",
      level,
      summary: plain(str(latest?.body || incident.name), 500),
      startedAt: isoOrNull(incident.started_at),
      updatedAt: isoOrNull(incident.updated_at || latest?.created_at),
      url: str(incident.shortlink) || "https://www.cloudflarestatus.com/",
      regions: [],
      services: titles(incident.components).slice(0, 8),
      state: "active",
    });
  }

  const scheduled: Incident[] = [];
  for (const item of asArray(row.scheduled_maintenances)) {
    const job = asRecord(item);
    if (!job) continue;
    const statusName = str(job.status);
    if (statusName === "completed" || statusName === "resolved") continue;
    const start = isoOrNull(job.scheduled_for);
    const inProgress = statusName === "in_progress" || statusName === "verifying";
    if (!inProgress && start && Date.parse(start) < now - 60 * 60 * 1000) continue;
    scheduled.push({
      id: str(job.id),
      title: plain(str(job.name), 160) || "Mantenimiento",
      level: "maintenance",
      summary: plain(str(asArray(job.incident_updates).map(asRecord)[0]?.body || job.name), 300),
      startedAt: start,
      updatedAt: isoOrNull(job.scheduled_until),
      url: str(job.shortlink) || "https://www.cloudflarestatus.com/",
      regions: [],
      services: [],
      state: inProgress ? "active" : "scheduled",
    });
  }
  scheduled.sort((a, b) => str(a.startedAt).localeCompare(str(b.startedAt)));

  const rollup = cfIndicator(indicator);
  const activeLevels = incidents.filter((item) => item.state === "active").map((item) => item.level);
  const level = worstLevel([rollup, ...activeLevels]);
  const packed = packIssues(issues);
  const headline = CF_HEADLINE[indicator] || headlineFor(level, incidents.length, "incidente");
  return {
    ...template,
    level,
    headline,
    updatedAt: isoOrNull(page?.updated_at),
    incidents: [...incidents, ...scheduled.slice(0, MAX_SCHEDULED)],
    recent: [],
    ...packed,
    counts,
    countsLabel: "Componentes del tablero",
  };
}
