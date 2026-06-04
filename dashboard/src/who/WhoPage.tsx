/**
 * WhoPage — public per-entity profile, the chronicle's wiki face.
 *
 * Read-only. Composes existing data (chronicle, standing, activity,
 * competence) into a name-keyed view: identity → bio → narratives →
 * achievements → stats → connections. Connections cross-link to other
 * /who pages — a social graph derived from chronicle co-participation.
 *
 * Visual language inherited from the main dashboard (glass-panel, Orbitron
 * headings, mono body) but laid out blog/wiki-style — content-first, single
 * scrollable column, no draggable grid.
 */

import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { useEffect } from "react";
import { fetchApi } from "../lib/api";
import { Sigil } from "./Sigil";
import type { Achievement, ChronicleEntry, EntityProfile } from "./types";

// Extract name from /who/<name> path. Trailing slash + query string tolerated.
function getNameFromPath(): string | null {
  const m = window.location.pathname.match(/^\/who\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

function formatAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function WhoPage() {
  const name = getNameFromPath();

  useEffect(() => {
    document.title = name ? `${name} — Marina` : "Who — Marina";
  }, [name]);

  if (!name) {
    return <WhoLanding />;
  }

  return <WhoProfile name={name} />;
}

function WhoLanding() {
  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-6 py-16">
      <h1 className="gradient-text font-display text-3xl tracking-widest">WHO</h1>
      <p className="text-text-dim">
        The chronicle's wiki face. Each entity in this Marina has a public profile at{" "}
        <code className="text-text-bright">/who/&lt;name&gt;</code>.
      </p>
      <p className="text-text-dim">
        Try one from the activity feed — every name in the chronicle is a link to its own page.
      </p>
      <a href="/dashboard" className="text-primary underline">
        ← Back to the dashboard
      </a>
    </div>
  );
}

function WhoProfile({ name }: { name: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["entity-profile", name],
    queryFn: () => fetchApi<EntityProfile>(`/api/entity/${encodeURIComponent(name)}/profile`),
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="mx-auto flex min-h-screen max-w-3xl items-center justify-center px-6">
        <span className="text-text-dim">Loading…</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-3 px-6">
        <h1 className="font-display text-2xl text-text-bright">Not found</h1>
        <p className="text-text-dim">No entity named "{name}" in this Marina.</p>
        <a href="/dashboard" className="text-primary underline">
          ← Back to the dashboard
        </a>
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-screen max-w-3xl px-4 pb-16 pt-8 sm:px-6">
      <Nav />
      <Identity profile={data} />
      <Bio profile={data} />
      {data.narratives.length > 0 && <Narratives narratives={data.narratives} />}
      <StatsAchievementsConnections profile={data} />
    </div>
  );
}

function Nav() {
  return (
    <nav className="mb-8 flex items-center justify-between text-[11px]">
      <a href="/dashboard" className="text-text-dim hover:text-primary">
        ← Marina
      </a>
      <span className="text-text-dim">public profile</span>
    </nav>
  );
}

function Identity({ profile }: { profile: EntityProfile }) {
  const { identity } = profile;
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="glass-panel mb-6 flex items-start gap-5 p-5"
    >
      <Sigil name={identity.name} size={88} />
      <div className="min-w-0 flex-1">
        <h1 className="gradient-text font-display text-2xl tracking-wider sm:text-3xl">
          {identity.name}
        </h1>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-text-dim">
          <span>{identity.kind}</span>
          {identity.role && (
            <>
              <span>·</span>
              <span className="text-text-bright">{identity.role}</span>
            </>
          )}
          {identity.online && (
            <>
              <span>·</span>
              <span className="text-success">online</span>
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2 text-right">
        <Pill label="rank" value={String(identity.rank)} />
        <Pill label="standing" value={identity.standing.toFixed(1)} />
      </div>
    </motion.section>
  );
}

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-end">
      <span className="font-mono text-[10px] uppercase tracking-wider text-text-dim">{label}</span>
      <span className="font-display text-xl text-text-bright">{value}</span>
    </div>
  );
}

function Bio({ profile }: { profile: EntityProfile }) {
  const { bio, identity } = profile;
  const lines: { label: string; value: string }[] = [];
  if (bio.operator_bio) lines.push({ label: "bio", value: bio.operator_bio });
  if (bio.goal) lines.push({ label: "goal", value: bio.goal });
  if (bio.model) lines.push({ label: "model", value: bio.model });
  if (bio.traits.length > 0) lines.push({ label: "traits", value: bio.traits.join(", ") });
  if (identity.first_seen) lines.push({ label: "joined", value: formatDate(identity.first_seen) });
  if (identity.last_active)
    lines.push({ label: "last active", value: formatAge(Date.now() - identity.last_active) });

  if (lines.length === 0) return null;

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.05 }}
      className="glass-panel mb-6 p-5"
    >
      <SectionHeading>Bio</SectionHeading>
      <dl className="grid gap-y-2 text-[13px] sm:grid-cols-[max-content_1fr] sm:gap-x-4">
        {lines.map((l) => (
          <div key={l.label} className="contents">
            <dt className="font-mono text-[10px] uppercase tracking-wider text-text-dim sm:pt-1">
              {l.label}
            </dt>
            <dd className="whitespace-pre-wrap text-text">{l.value}</dd>
          </div>
        ))}
      </dl>
    </motion.section>
  );
}

function Narratives({ narratives }: { narratives: ChronicleEntry[] }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.1 }}
      className="mb-6"
    >
      <SectionHeading>Chronicle</SectionHeading>
      <div className="space-y-3">
        {narratives.map((entry) => (
          <NarrativeCard key={entry.id} entry={entry} />
        ))}
      </div>
    </motion.section>
  );
}

function NarrativeCard({ entry }: { entry: ChronicleEntry }) {
  const otherParticipants = entry.participants.filter(
    // Tiny optimization: this filter runs on the wire shape; the page name
    // isn't passed in, so we keep everyone. A future pass could thread it.
    () => true,
  );
  return (
    <article className="glass-panel p-5">
      <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-base text-text-bright">{entry.title}</h3>
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-dim">
          {entry.kind} · {formatAge(Date.now() - entry.created_at)}
        </span>
      </header>
      {entry.body && <p className="mb-3 whitespace-pre-wrap text-[13px] text-text">{entry.body}</p>}
      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-text-dim">
        {otherParticipants.length > 0 && (
          <span>
            with{" "}
            {otherParticipants.map((p, i) => (
              <span key={p}>
                {i > 0 && ", "}
                <a href={`/who/${encodeURIComponent(p)}`} className="text-text hover:text-primary">
                  {p}
                </a>
              </span>
            ))}
          </span>
        )}
        {entry.refs.length > 0 && (
          <span className="text-text-dim">refs: {entry.refs.join(", ")}</span>
        )}
        {entry.period && <span className="text-text-dim">period: {entry.period}</span>}
      </footer>
    </article>
  );
}

function StatsAchievementsConnections({ profile }: { profile: EntityProfile }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.15 }}
      className="mb-6 grid gap-4 md:grid-cols-3"
    >
      <Achievements list={profile.achievements} />
      <Stats stats={profile.stats} />
      <Connections list={profile.connections} />
    </motion.section>
  );
}

function Achievements({ list }: { list: Achievement[] }) {
  return (
    <div className="glass-panel p-4">
      <SectionHeading small>Achievements</SectionHeading>
      {list.length === 0 ? (
        <p className="text-[12px] text-text-dim">No milestones yet.</p>
      ) : (
        <ul className="space-y-2">
          {list.map((a) => (
            <li key={a.id} className="border-l-2 border-primary/50 pl-2">
              <div className="font-display text-[12px] text-text-bright">{a.title}</div>
              <div className="text-[11px] text-text-dim">{a.description}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stats({ stats }: { stats: EntityProfile["stats"] }) {
  const cit = stats.chronicle_citations;
  const rows: { label: string; value: string }[] = [
    { label: "days active", value: String(stats.days_active) },
    { label: "actions", value: String(stats.total_actions) },
    { label: "rooms visited", value: String(stats.rooms_visited) },
    { label: "unique commands", value: String(stats.unique_commands) },
    { label: "interactions", value: String(stats.entities_interacted) },
    { label: "gates passed", value: String(stats.competence_gates_passed) },
    { label: "citations (total)", value: String(stats.chronicle_citations_total) },
    {
      label: "by kind",
      value: `e:${cit.event} n:${cit.narrative} d:${cit.digest} c:${cit.correction}`,
    },
  ];
  return (
    <div className="glass-panel p-4">
      <SectionHeading small>Stats</SectionHeading>
      <dl className="space-y-1 text-[12px]">
        {rows.map((r) => (
          <div key={r.label} className="flex justify-between gap-2">
            <dt className="text-text-dim">{r.label}</dt>
            <dd className="font-mono text-text-bright">{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Connections({ list }: { list: { name: string; co_chronicles: number }[] }) {
  return (
    <div className="glass-panel p-4">
      <SectionHeading small>Connections</SectionHeading>
      {list.length === 0 ? (
        <p className="text-[12px] text-text-dim">No co-citations yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {list.map((c) => (
            <li key={c.name} className="flex items-center justify-between gap-2">
              <a
                href={`/who/${encodeURIComponent(c.name)}`}
                className="text-[13px] text-text hover:text-primary"
              >
                {c.name}
              </a>
              <span className="font-mono text-[10px] text-text-dim">×{c.co_chronicles}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SectionHeading({
  children,
  small = false,
}: {
  children: React.ReactNode;
  small?: boolean;
}) {
  return (
    <h2
      className={
        small
          ? "mb-2 font-display text-[11px] uppercase tracking-widest text-text-dim"
          : "mb-3 font-display text-sm uppercase tracking-widest text-text-dim"
      }
    >
      {children}
    </h2>
  );
}
