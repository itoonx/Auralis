// The debate view — position-flow chart for /brainstorm runs (panel + dialectic share the event shape).
// X = rounds, Y = stance lanes (categorical, first-appearance order), one 2px line per model; a node with
// a ring marks a FLIP. Data = `position` events ("name @rK: stance") + the `note` trust badge — both are
// our own emitter templates. Colors: validated categorical set for the dark surface (see dataviz method:
// identity → fixed order per entity, never cycled; legend + direct labels; text wears text tokens).
import { useMemo, useState } from "react"
import type { TimelineEvent } from "@/lib/api"

const SERIES = ["#0284c7", "#d97706", "#8b5cf6", "#f43f5e"] // validated: dark surface, CVD ΔE 82, contrast ≥3:1

interface Pos { name: string; round: number; stance: string }

function parsePositions(events: TimelineEvent[]): Pos[] {
  const out: Pos[] = []
  for (const e of events) {
    if (e.kind !== "position") continue
    // human = "◈ name @rK: stance" (glyph prefixed by the emitter's format())
    const m = e.human.match(/@r(\d+):\s*(.*)$/s)
    if (m) out.push({ name: e.actor, round: Number(m[1]), stance: m[2].trim() || "—" })
  }
  return out
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()

export function DebateView({ events }: { events: TimelineEvent[] }) {
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null)
  const model = useMemo(() => {
    const pos = parsePositions(events)
    if (!pos.length) return null
    const names = [...new Set(pos.map((p) => p.name))] // first-appearance order — color follows the entity
    const rounds = [...new Set(pos.map((p) => p.round))].sort((a, b) => a - b)
    const lanes: string[] = [] // stance lanes, first-appearance order (top → bottom)
    for (const p of pos) if (!lanes.some((l) => norm(l) === norm(p.stance))) lanes.push(p.stance)
    const laneOf = (s: string) => lanes.findIndex((l) => norm(l) === norm(s))
    const trust = events.find((e) => e.kind === "note" && e.actor === "trust")?.human.replace(/^✎\s*/, "") ?? null
    return { pos, names, rounds, lanes, laneOf, trust }
  }, [events])
  if (!model) return null
  const { pos, names, rounds, lanes, laneOf, trust } = model

  // Geometry — lanes get honest room; wide stance labels are truncated with the full text on hover.
  const W = 640, PADX = 150, PADR = 70, ROWH = 44, PADY = 30
  const H = PADY * 2 + Math.max(1, lanes.length - 1) * ROWH
  const x = (r: number) => PADX + ((r - rounds[0]) / Math.max(1, rounds[rounds.length - 1] - rounds[0])) * (W - PADX - PADR)
  const y = (lane: number) => PADY + lane * ROWH

  return (
    <div className="relative">
      {/* legend — identity is never color-alone (names repeat as direct labels at line ends) */}
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {names.map((n, i) => (
          <span key={n} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="inline-block size-2.5 rounded-full" style={{ background: SERIES[i % SERIES.length] }} aria-hidden />
            <span className="font-mono">{n}</span>
          </span>
        ))}
        {trust && <span className="ml-auto rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground" title={trust}>{trust.slice(0, 60)}</span>}
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="position flow — who stood where, per round">
        {/* recessive lane grid + stance labels (text tokens, never series color) */}
        {lanes.map((l, i) => (
          <g key={l}>
            <line x1={PADX} x2={W - PADR} y1={y(i)} y2={y(i)} stroke="currentColor" strokeOpacity="0.08" strokeWidth="1" />
            <text x={PADX - 8} y={y(i)} textAnchor="end" dominantBaseline="middle" className="fill-muted-foreground" fontSize="10">
              {l.length > 24 ? `${l.slice(0, 23)}…` : l}
              <title>{l}</title>
            </text>
          </g>
        ))}
        {/* round ticks */}
        {rounds.map((r) => (
          <text key={r} x={x(r)} y={H - 6} textAnchor="middle" className="fill-muted-foreground" fontSize="10">r{r}</text>
        ))}
        {/* one 2px line + ≥8px markers per model; a flip node wears a wider surface ring */}
        {names.map((n, i) => {
          const pts = pos.filter((p) => p.name === n).sort((a, b) => a.round - b.round)
          const color = SERIES[i % SERIES.length]
          const d = pts.map((p, k) => `${k ? "L" : "M"}${x(p.round)},${y(laneOf(p.stance))}`).join(" ")
          return (
            <g key={n}>
              <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
              {pts.map((p, k) => {
                const flipped = k > 0 && laneOf(p.stance) !== laneOf(pts[k - 1].stance)
                return (
                  <circle
                    key={p.round} cx={x(p.round)} cy={y(laneOf(p.stance))} r={flipped ? 6 : 4.5}
                    fill={color} stroke="var(--card)" strokeWidth={flipped ? 3 : 2}
                    className="cursor-pointer"
                    onMouseEnter={(ev) => {
                      const host = (ev.currentTarget.ownerSVGElement?.parentElement as HTMLElement)?.getBoundingClientRect()
                      setHover({ x: ev.clientX - (host?.left ?? 0), y: ev.clientY - (host?.top ?? 0), text: `${n} · round ${p.round}${flipped ? " · FLIPPED" : ""}\n${p.stance}` })
                    }}
                    onMouseLeave={() => setHover(null)}
                  />
                )
              })}
              {/* direct label at line end */}
              {pts.length > 0 && (
                <text x={x(pts[pts.length - 1].round) + 10} y={y(laneOf(pts[pts.length - 1].stance)) + (i % 2 ? 12 : -8)} className="fill-muted-foreground" fontSize="10" fontFamily="ui-monospace, monospace">
                  {n.split(":").pop()}
                </text>
              )}
            </g>
          )
        })}
      </svg>

      {hover && (
        <div className="pointer-events-none absolute z-10 max-w-64 whitespace-pre-wrap rounded border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow" style={{ left: Math.min(hover.x + 12, 480), top: hover.y + 12 }}>
          {hover.text}
        </div>
      )}

      {/* the same data as text — never color/geometry alone */}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-muted-foreground">as table</summary>
        <table className="mt-1 w-full text-xs">
          <thead><tr className="text-left text-muted-foreground"><th className="pr-3 font-medium">model</th><th className="pr-3 font-medium">round</th><th className="font-medium">position</th></tr></thead>
          <tbody>
            {pos.map((p, i) => <tr key={i} className="border-t border-border/50"><td className="pr-3 font-mono">{p.name}</td><td className="pr-3 tabular-nums">r{p.round}</td><td>{p.stance}</td></tr>)}
          </tbody>
        </table>
      </details>
    </div>
  )
}
