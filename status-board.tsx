import { useEffect, useMemo, useState } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { ExternalLink, Radio, RefreshCw, Search } from "lucide-react";
import type { Incident, Level, ProviderSnapshot, ServiceIssue, StatusBoard } from "@/lib/status/types";

const LEVEL_LABEL: Record<Level, string> = {
  operational: "Operativo",
  info: "Aviso",
  degraded: "Degradado",
  outage: "Interrupción",
  maintenance: "Mantenimiento",
  unknown: "Sin datos",
};

const DOT: Record<Level, string> = {
  operational: "bg-ok",
  info: "bg-accent",
  degraded: "bg-warn",
  outage: "bg-bad",
  maintenance: "bg-maint",
  unknown: "bg-muted",
};

const TEXT: Record<Level, string> = {
  operational: "text-ok",
  info: "text-accent",
  degraded: "text-warn",
  outage: "text-bad",
  maintenance: "text-maint",
  unknown: "text-muted",
};

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

type FeedFilter = "all" | "active" | "outage";

function formatUtc(iso: string | null): string {
  if (!iso) return "sin hora";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "sin hora";
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${day} ${MONTHS[date.getUTCMonth()]} ${hour}:${minute} UTC`;
}

function matches(query: string, parts: Array<string | null | undefined>): boolean {
  if (!query) return true;
  return parts
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase()
    .includes(query);
}

export function StatusBoardView({ board }: { board: StatusBoard }) {
  const router = useRouter();
  const isLoading = useRouterState({ select: (state) => state.isLoading });
  const [selected, setSelected] = useState<string>("all");
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();

  useEffect(() => {
    const id = window.setInterval(() => {
      void router.invalidate();
    }, 60_000);
    return () => window.clearInterval(id);
  }, [router]);

  const providers = board.providers;
  const visibleProviders = selected === "all" ? providers : providers.filter((provider) => provider.id === selected);

  const incidents = useMemo(() => {
    return visibleProviders.flatMap((provider) =>
      provider.incidents
        .filter((incident) => incident.state === "active")
        .filter((incident) => {
          if (filter === "outage") return incident.level === "outage";
          if (filter === "active") return incident.level !== "operational";
          return true;
        })
        .filter((incident) =>
          matches(needle, [
            provider.name,
            provider.company,
            incident.title,
            incident.summary,
            ...incident.regions,
            ...incident.services,
          ]),
        )
        .map((incident) => ({ incident, provider })),
    );
  }, [visibleProviders, filter, needle]);

  const scheduled = useMemo(() => {
    if (filter === "outage") return [];
    return visibleProviders.flatMap((provider) =>
      provider.incidents
        .filter((incident) => incident.state === "scheduled")
        .filter((incident) =>
          matches(needle, [provider.name, provider.company, incident.title, incident.summary]),
        )
        .map((incident) => ({ incident, provider })),
    );
  }, [visibleProviders, filter, needle]);

  const productIssues = useMemo(() => collectIssues(visibleProviders, needle, "product"), [visibleProviders, needle]);
  const locationIssues = useMemo(
    () => collectIssues(visibleProviders, needle, "location"),
    [visibleProviders, needle],
  );

  const recent = visibleProviders.flatMap((provider) =>
    provider.recent.map((incident) => ({ incident, provider })),
  );

  const tally = countLevels(providers);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex flex-col gap-5 border-b border-line pb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            <p className="flex items-center gap-2 font-mono text-xs tracking-widest text-accent uppercase">
              <Radio className="live-dot size-3.5" aria-hidden="true" />
              En vivo
            </p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Faro</h1>
            <p className="max-w-xl text-sm text-muted sm:text-base">
              Estado real de Google, Amazon, Microsoft, Cloudflare y AWS, leído de sus tableros públicos.
            </p>
          </div>
          <div className="flex flex-col items-stretch gap-2 sm:items-end">
            <button
              type="button"
              onClick={() => void router.invalidate()}
              disabled={isLoading}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-line bg-surface px-4 text-sm font-medium text-fg hover:border-accent disabled:opacity-60"
            >
              <RefreshCw className={`size-4 ${isLoading ? "animate-spin" : ""}`} aria-hidden="true" />
              {isLoading ? "Actualizando" : "Actualizar"}
            </button>
            <p className="font-mono text-xs text-muted">Lectura {formatUtc(board.fetchedAt)}</p>
          </div>
        </div>
        <p className="font-mono text-xs text-muted sm:text-sm" aria-live="polite">
          {tally.outage} con interrupción · {tally.degraded} degradados · {tally.maintenance} en mantenimiento ·{" "}
          {tally.operational} operativos
          {tally.unknown ? ` · ${tally.unknown} sin datos` : ""}
        </p>
      </header>

      <div className="grid gap-8 lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-start">
        <aside className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
            <ProviderButton provider={null} selected={selected === "all"} onSelect={() => setSelected("all")} tally={tally} />
            {providers.map((provider) => (
              <ProviderButton
                key={provider.id}
                provider={provider}
                selected={selected === provider.id}
                onSelect={() => setSelected(provider.id)}
              />
            ))}
          </div>
        </aside>

        <div className="flex min-w-0 flex-col gap-6">
          <div className="flex flex-col gap-3">
            <label className="relative block">
              <span className="sr-only">Buscar servicio o incidente</span>
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar servicio, región o incidente"
                className="min-h-11 w-full rounded-xl border border-line bg-surface pr-3 pl-10 text-sm text-fg outline-none placeholder:text-muted focus-visible:border-accent"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <FilterChip current={filter} value="all" onSelect={setFilter} label="Todo" />
              <FilterChip current={filter} value="active" onSelect={setFilter} label="Con aviso" />
              <FilterChip current={filter} value="outage" onSelect={setFilter} label="Interrupciones" />
            </div>
          </div>

          <section className="flex flex-col gap-3" aria-labelledby="en-curso">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id="en-curso" className="text-lg font-semibold">
                En curso
              </h2>
              <p className="font-mono text-xs text-muted">{incidents.length}</p>
            </div>
            {incidents.length === 0 ? (
              <p className="rounded-xl border border-line bg-surface px-4 py-6 text-sm text-muted">
                {needle || filter !== "all" || selected !== "all"
                  ? "Nada coincide con ese filtro en las fuentes públicas."
                  : "Ningún incidente activo en los tableros oficiales."}
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {incidents.map(({ incident, provider }) => (
                  <li key={`${provider.id}-${incident.id}`}>
                    <IncidentCard incident={incident} provider={provider} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {scheduled.length > 0 ? (
            <section className="flex flex-col gap-3" aria-labelledby="programado">
              <div className="flex items-baseline justify-between gap-3">
                <h2 id="programado" className="text-lg font-semibold">
                  Programado
                </h2>
                <p className="font-mono text-xs text-muted">{scheduled.length}</p>
              </div>
              <ul className="flex flex-col gap-3">
                {scheduled.map(({ incident, provider }) => (
                  <li key={`${provider.id}-sched-${incident.id}`}>
                    <IncidentCard incident={incident} provider={provider} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="flex flex-col gap-3" aria-labelledby="servicios">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id="servicios" className="text-lg font-semibold">
                Servicios afectados
              </h2>
              <p className="font-mono text-xs text-muted">{productIssues.length}</p>
            </div>
            {productIssues.length === 0 ? (
              <p className="text-sm text-muted">Sin productos marcados fuera de servicio en esta vista.</p>
            ) : (
              <IssueList items={productIssues} />
            )}
            {locationIssues.length > 0 ? (
              <details className="rounded-xl border border-line bg-surface px-4 py-3">
                <summary className="min-h-11 cursor-pointer text-sm font-medium">
                  Ubicaciones de red afectadas ({locationIssues.length})
                </summary>
                <div className="mt-3">
                  <IssueList items={locationIssues} />
                </div>
              </details>
            ) : null}
          </section>

          {recent.length > 0 ? (
            <details className="rounded-xl border border-line px-4 py-3">
              <summary className="min-h-11 cursor-pointer text-sm font-medium">
                Historial reciente ya cerrado ({recent.length})
              </summary>
              <ul className="mt-3 flex flex-col gap-3">
                {recent.map(({ incident, provider }) => (
                  <li key={`${provider.id}-recent-${incident.id}`} className="text-sm text-muted">
                    <span className="text-fg">{provider.short}.</span> {incident.title}. {incident.summary.slice(0, 180)}{" "}
                    <span className="font-mono text-xs">{formatUtc(incident.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <section className="flex flex-col gap-3 border-t border-line pt-4">
            {visibleProviders.map((provider) => (
              <p key={provider.id} className="text-xs leading-relaxed text-muted">
                <span className="text-fg">{provider.name}.</span> {provider.note}{" "}
                {provider.counts && provider.countsLabel ? (
                  <span className="font-mono">
                    {provider.countsLabel}: {provider.counts.outage} en interrupción, {provider.counts.degraded} degradados,{" "}
                    {provider.counts.maintenance} en mantenimiento, {provider.counts.operational} operativos.
                  </span>
                ) : null}{" "}
                {provider.error ? <span className="text-bad">Error: {provider.error}</span> : null}
              </p>
            ))}
          </section>
        </div>
      </div>
    </main>
  );
}

function summaryLevel(tally: ReturnType<typeof countLevels>): Level {
  if (tally.outage) return "outage";
  if (tally.degraded) return "degraded";
  if (tally.maintenance) return "maintenance";
  if (tally.info) return "info";
  if (tally.unknown && tally.operational === 0) return "unknown";
  return "operational";
}

function countLevels(providers: ProviderSnapshot[]) {
  const tally = { operational: 0, degraded: 0, outage: 0, maintenance: 0, info: 0, unknown: 0 };
  for (const provider of providers) tally[provider.level] += 1;
  return tally;
}

function collectIssues(providers: ProviderSnapshot[], needle: string, kind: ServiceIssue["kind"]) {
  return providers.flatMap((provider) =>
    provider.issues
      .filter((issue) => issue.kind === kind)
      .filter((issue) => matches(needle, [provider.name, issue.name, issue.group, issue.region]))
      .map((issue) => ({ provider, issue })),
  );
}

function ProviderButton({
  provider,
  selected,
  onSelect,
  tally,
}: {
  provider: ProviderSnapshot | null;
  selected: boolean;
  onSelect: () => void;
  tally?: ReturnType<typeof countLevels>;
}) {
  const level: Level = provider?.level ?? (tally ? summaryLevel(tally) : "operational");
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex min-h-11 flex-col gap-2 rounded-xl border px-3 py-3 text-left ${
        selected ? "border-accent bg-surface-2" : "border-line bg-surface hover:border-muted"
      }`}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs tracking-wide text-muted uppercase">
          {provider ? provider.company : "Todos"}
        </span>
        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${TEXT[level]}`}>
          <span className={`size-2 rounded-full ${DOT[level]}`} aria-hidden="true" />
          {provider ? LEVEL_LABEL[provider.level] : "Resumen"}
        </span>
      </span>
      <span className="text-sm font-semibold text-fg">{provider ? provider.name : "Las seis fuentes"}</span>
      <span className="text-xs leading-snug text-muted">
        {provider ? provider.headline : "Google Cloud, Workspace, AWS, Azure, Microsoft 365 y Cloudflare"}
      </span>
    </button>
  );
}

function FilterChip({
  current,
  value,
  label,
  onSelect,
}: {
  current: FeedFilter;
  value: FeedFilter;
  label: string;
  onSelect: (value: FeedFilter) => void;
}) {
  const selected = current === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      aria-pressed={selected}
      className={`min-h-11 rounded-full border px-4 text-sm ${
        selected ? "border-accent bg-accent text-bg" : "border-line bg-surface text-fg"
      }`}
    >
      {label}
    </button>
  );
}

function IncidentCard({ incident, provider }: { incident: Incident; provider: ProviderSnapshot }) {
  const when = incident.state === "scheduled" ? incident.startedAt : incident.updatedAt;
  return (
    <article className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${TEXT[incident.level]}`}>
          <span className={`size-2 rounded-full ${DOT[incident.level]}`} aria-hidden="true" />
          {incident.state === "scheduled" ? "Programado" : LEVEL_LABEL[incident.level]}
        </span>
        <span className="font-mono text-xs text-muted">
          {provider.short} · {formatUtc(when)}
        </span>
      </div>
      <h3 className="mt-2 text-base font-semibold">{incident.title}</h3>
      <p className="mt-2 line-clamp-4 text-sm leading-relaxed text-muted">{incident.summary}</p>
      {incident.summary.length > 220 ? (
        <details className="mt-1">
          <summary className="min-h-11 text-sm text-accent">Leer completo</summary>
          <p className="text-sm leading-relaxed text-muted">{incident.summary}</p>
        </details>
      ) : null}
      {incident.regions.length > 0 || incident.services.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2">
          {incident.regions.map((region) => (
            <li key={region} className="rounded-full border border-line px-2.5 py-1 text-xs text-fg">
              {region}
            </li>
          ))}
          {incident.services.slice(0, 6).map((service) => (
            <li key={service} className="rounded-full bg-surface-2 px-2.5 py-1 text-xs text-muted">
              {service}
            </li>
          ))}
        </ul>
      ) : null}
      <a
        href={incident.url || provider.sourceUrl}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-flex min-h-11 items-center gap-1.5 text-sm text-accent"
      >
        Fuente oficial
        <ExternalLink className="size-3.5" aria-hidden="true" />
      </a>
    </article>
  );
}

function IssueList({ items }: { items: Array<{ provider: ProviderSnapshot; issue: ServiceIssue }> }) {
  const preview = items.slice(0, 8);
  const rest = items.slice(8);
  return (
    <div className="flex flex-col gap-2">
      <ul className="grid gap-2 sm:grid-cols-2">
        {preview.map((item) => (
          <IssueRow key={`${item.provider.id}-${item.issue.kind}-${item.issue.name}-${item.issue.region}`} item={item} />
        ))}
      </ul>
      {rest.length > 0 ? (
        <details className="rounded-xl border border-line px-4 py-3">
          <summary className="min-h-11 text-sm font-medium">Ver los otros {rest.length}</summary>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {rest.map((item) => (
              <IssueRow
                key={`${item.provider.id}-rest-${item.issue.kind}-${item.issue.name}-${item.issue.region}`}
                item={item}
              />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function IssueRow({ item }: { item: { provider: ProviderSnapshot; issue: ServiceIssue } }) {
  const { provider, issue } = item;
  return (
    <li className="flex items-start justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-fg">{issue.name}</p>
        <p className="text-xs text-muted">
          {provider.short}
          {issue.region ? ` · ${issue.region}` : ""}
          {issue.group ? ` · ${issue.group}` : ""}
        </p>
      </div>
      <span className={`shrink-0 text-xs font-medium ${TEXT[issue.level]}`}>{LEVEL_LABEL[issue.level]}</span>
    </li>
  );
}
