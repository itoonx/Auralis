// The analytical panels behind the dashboard tabs. Each fetches its own slice of the brain and refetches
// on the shared `tick` the parent bumps while live. Kept in one file — they're small and always shipped together.
import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  getGraph, getGraphEntities, getRuns, getTiming, search,
  type GraphEdge, type GraphEntity, type RunSummary, type SearchResult, type Timing,
} from "@/lib/api"

const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(ms < 10 ? 1 : 0)}ms`)

// ── Timing: where wall-clock actually went. Bars relative to the biggest phase; the point is that the LLM dominates.
export function TimingPanel({ tick }: { tick: number }) {
  const [t, setT] = useState<Timing | null>(null)
  useEffect(() => { getTiming().then(setT).catch(() => setT(null)) }, [tick])
  const top = t?.phases.reduce((m, p) => Math.max(m, p.total), 0) || 1
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">Where time goes
          {t && <span className="text-xs font-normal text-muted-foreground">wall {fmt(t.wall)} · {t.spans} spans</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {(!t || t.phases.length === 0) && (
          <p className="text-sm text-muted-foreground">no timing yet — run <code className="font-mono">pnpm dev</code>, which writes the timing sink.</p>
        )}
        {t?.phases.map((p) => (
          <div key={p.name} className="text-sm">
            <div className="flex justify-between mb-1">
              <span className="font-mono">{p.name} <span className="text-muted-foreground text-xs">×{p.n}</span></span>
              <span className="tabular-nums text-muted-foreground">{fmt(p.total)} · {(p.share * 100).toFixed(1)}%</span>
            </div>
            <div className="h-2 rounded bg-muted overflow-hidden">
              <div className="h-full bg-primary" style={{ width: `${Math.max(2, (p.total / top) * 100)}%` }} />
            </div>
          </div>
        ))}
        {t && t.phases.length > 0 && (
          <p className="text-xs text-muted-foreground pt-1">bars are relative to the biggest phase; share is of wall (can exceed 100% when tasks run in parallel — spans nest).</p>
        )}
      </CardContent>
    </Card>
  )
}

// ── Runs: history + per-run scorecard. Click a row to drive the timeline (compare by eyeballing the columns).
export function RunsPanel({ project, tick, selected, onSelect }: { project: string; tick: number; selected: string; onSelect: (runId: string) => void }) {
  const [runs, setRuns] = useState<RunSummary[]>([])
  useEffect(() => { getRuns(project).then((d) => setRuns(d.runs)).catch(() => setRuns([])) }, [project, tick])
  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle>Runs <span className="text-xs font-normal text-muted-foreground">click one to drive the timeline</span></CardTitle></CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>run</TableHead>
              <TableHead className="text-right">tasks</TableHead>
              <TableHead className="text-right">deduped</TableHead>
              <TableHead className="text-right">overlaps</TableHead>
              <TableHead className="text-right">repairs</TableHead>
              <TableHead className="text-right">events</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.length === 0 && <TableRow><TableCell colSpan={6} className="text-muted-foreground">no runs yet.</TableCell></TableRow>}
            {runs.map((r) => (
              <TableRow key={r.runId} onClick={() => onSelect(r.runId)} className={`cursor-pointer ${selected === r.runId ? "bg-muted/60" : ""}`}>
                <TableCell className="font-mono text-xs">
                  <div className="truncate max-w-[240px]">{r.runId}</div>
                  <div className="text-muted-foreground">{r.lastTs?.slice(0, 19).replace("T", " ")}</div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.tasks}</TableCell>
                <TableCell className="text-right tabular-nums text-amber-400">{r.deduped}</TableCell>
                <TableCell className="text-right tabular-nums text-red-400">{r.overlaps}</TableCell>
                <TableCell className="text-right tabular-nums text-orange-400">{r.repairs}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{r.events}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

// ── Graph: entities by degree; click one to see its 1-hop neighborhood (subject —predicate→ object).
export function GraphPanel({ project, tick }: { project: string; tick: number }) {
  const [entities, setEntities] = useState<GraphEntity[]>([])
  const [sel, setSel] = useState("")
  const [edges, setEdges] = useState<GraphEdge[]>([])
  useEffect(() => { getGraphEntities(project).then((d) => setEntities(d.entities)).catch(() => setEntities([])) }, [project, tick])
  useEffect(() => {
    if (!sel) { setEdges([]); return }
    getGraph(sel, project).then((d) => setEdges(d.edges)).catch(() => setEdges([]))
  }, [sel, project])
  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle>Knowledge graph <span className="text-xs font-normal text-muted-foreground">{entities.length} entities</span></CardTitle></CardHeader>
      <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div>
          <div className="text-xs text-muted-foreground mb-2">entities by degree — click to explore</div>
          <div className="flex flex-wrap gap-1.5">
            {entities.length === 0 && <span className="text-sm text-muted-foreground">no graph yet — run <code className="font-mono">pnpm build-graph</code>.</span>}
            {entities.map((e) => (
              <button
                key={e.key}
                onClick={() => setSel(e.key)}
                className={`text-xs rounded-full border px-2 py-1 hover:bg-muted transition-colors ${sel === e.key ? "bg-muted border-primary" : ""}`}
              >
                {e.label} <span className="text-muted-foreground">·{e.degree}</span>
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground mb-2">{sel ? `neighborhood of ${sel}` : "select an entity"}</div>
          <ul className="space-y-1">
            {edges.map((e, i) => (
              <li key={i} className="font-mono text-xs">
                <span>{e.subject}</span>
                <span className="text-violet-400"> —{e.predicate}→ </span>
                <span>{e.object}</span>
              </li>
            ))}
            {sel && edges.length === 0 && <li className="text-sm text-muted-foreground">no edges.</li>}
          </ul>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Search: live semantic recall — exactly what a worker gets back. Superseded notes flagged, not hidden.
export function SearchPanel({ project }: { project: string }) {
  const [q, setQ] = useState("")
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async () => {
    if (!q.trim()) return
    setBusy(true)
    try { setResults((await search(q, project)).results) } catch { setResults([]) } finally { setBusy(false) }
  }
  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle>Search <span className="text-xs font-normal text-muted-foreground">semantic recall — what a worker sees</span></CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <form onSubmit={(e) => { e.preventDefault(); run() }} className="flex gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="how do we authenticate users?" />
          <Button type="submit" disabled={busy}>{busy ? "…" : "search"}</Button>
        </form>
        <ul className="space-y-2">
          {results?.length === 0 && <li className="text-sm text-muted-foreground">nothing in the brain for that query.</li>}
          {results?.map((r) => (
            <li key={r.id} className="text-sm border rounded-md p-2.5">
              <div className="flex items-center gap-2 mb-1 text-[11px] text-muted-foreground">
                {r.superseded_by && <Badge variant="outline" className="h-4 px-1.5 text-[10px] text-amber-400">superseded</Badge>}
                {r.score != null && <span className="tabular-nums">score {r.score.toFixed(3)}</span>}
                <span className="font-mono truncate">{r.id}</span>
              </div>
              <p className="text-muted-foreground">{r.content}</p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
