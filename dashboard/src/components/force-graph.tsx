// A small force-directed graph: d3-force does the physics, we render plain SVG so it inherits the theme.
// Nodes sized by degree, drag to pin, hover to spotlight a node's neighborhood. No canvas, no wrapper lib.
import { useEffect, useMemo, useRef, useState } from "react"
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type Simulation } from "d3-force"
import type { GraphAllEdge } from "@/lib/api"

interface N { id: string; label: string; deg: number; x?: number; y?: number; fx?: number | null; fy?: number | null }
interface L { source: string | N; target: string | N; predicate: string }

const W = 760, H = 520
const idOf = (v: string | N) => (typeof v === "string" ? v : v.id)
const short = (s: string) => (s.length > 22 ? s.slice(0, 21) + "…" : s)

export function ForceGraph({ edges, onSelect }: { edges: GraphAllEdge[]; onSelect?: (key: string) => void }) {
  const { nodes, links } = useMemo(() => {
    const map = new Map<string, N>()
    const deg = new Map<string, number>()
    const bump = (key: string, label: string) => {
      if (!map.has(key)) map.set(key, { id: key, label, deg: 0 })
      deg.set(key, (deg.get(key) ?? 0) + 1)
    }
    const ls: L[] = []
    for (const e of edges) {
      bump(e.subj_key, e.subject)
      bump(e.obj_key, e.object)
      ls.push({ source: e.subj_key, target: e.obj_key, predicate: e.predicate })
    }
    for (const [k, d] of deg) map.get(k)!.deg = d
    return { nodes: [...map.values()], links: ls }
  }, [edges])

  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>()
    const link = (a: string, b: string) => { if (!m.has(a)) m.set(a, new Set()); m.get(a)!.add(b) }
    for (const l of links) { link(idOf(l.source), idOf(l.target)); link(idOf(l.target), idOf(l.source)) }
    return m
  }, [links])

  const simRef = useRef<Simulation<N, L> | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragId = useRef<string | null>(null)
  const [, tick] = useState(0)
  const [hover, setHover] = useState<string | null>(null)

  useEffect(() => {
    const sim = forceSimulation<N>(nodes)
      .force("link", forceLink<N, L>(links).id((d) => d.id).distance(72).strength(0.5))
      .force("charge", forceManyBody().strength(-260))
      .force("center", forceCenter(W / 2, H / 2))
      .force("collide", forceCollide<N>().radius((d) => 10 + d.deg * 2))
    sim.on("tick", () => tick((n) => n + 1))
    simRef.current = sim
    return () => { sim.stop() }
  }, [nodes, links])

  const local = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }
  }
  const onDown = (n: N) => (e: React.PointerEvent) => {
    dragId.current = n.id
    ;(e.target as Element).setPointerCapture(e.pointerId)
    simRef.current?.alphaTarget(0.3).restart()
  }
  const onMove = (e: React.PointerEvent) => {
    if (!dragId.current) return
    const p = local(e)
    const n = nodes.find((x) => x.id === dragId.current)
    if (n) { n.fx = p.x; n.fy = p.y }
  }
  const onUp = () => {
    const n = dragId.current ? nodes.find((x) => x.id === dragId.current) : null
    if (n) { n.fx = null; n.fy = null }
    dragId.current = null
    simRef.current?.alphaTarget(0)
  }
  const dim = (id: string) => hover != null && hover !== id && !neighbors.get(hover)?.has(id)

  if (nodes.length === 0) return null
  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      className="w-full h-[520px] select-none touch-none rounded-md border bg-muted/20"
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={onUp}
    >
      {links.map((l, i) => {
        const s = l.source as N, t = l.target as N
        if (s?.x == null || t?.x == null) return null
        const active = hover != null && (s.id === hover || t.id === hover)
        return (
          <line
            key={i}
            x1={s.x} y1={s.y} x2={t.x} y2={t.y}
            stroke="currentColor"
            className={active ? "text-primary" : "text-border"}
            strokeOpacity={hover != null && !active ? 0.12 : 0.55}
            strokeWidth={active ? 1.6 : 1}
          />
        )
      })}
      {nodes.map((n) =>
        n.x == null ? null : (
          <g
            key={n.id}
            transform={`translate(${n.x},${n.y})`}
            opacity={dim(n.id) ? 0.2 : 1}
            onPointerDown={onDown(n)}
            onPointerEnter={() => setHover(n.id)}
            onPointerLeave={() => setHover(null)}
            onClick={() => onSelect?.(n.id)}
            className="cursor-grab"
          >
            <circle r={5 + n.deg * 2} className="fill-primary/80 stroke-background" strokeWidth={1.5} />
            <text x={8 + n.deg * 2} y={4} className="fill-foreground text-[10px]" style={{ pointerEvents: "none" }}>{short(n.label)}</text>
          </g>
        ),
      )}
    </svg>
  )
}
