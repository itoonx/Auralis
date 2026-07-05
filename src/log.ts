// Centralized run timing + structured log. ONE sink for the whole process so you can see, in one place,
// where wall-clock actually goes — which worker, which brain call, which phase is the bottleneck. No deps
// (perf_hooks only). Spans are kept in memory and, when a file is set, appended as JSONL for later tooling.
// AURALIS_LOG_TIMING=1 also streams each span live to stderr; the end-of-run summary() prints always.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

export interface SpanRecord {
  name: string; // dotted phase — e.g. "worker.run", "oracle.search", "oracle.boot"
  label?: string; // instance detail — e.g. task id / project
  ms: number; // duration
  atMs: number; // start offset from reset()
  meta?: Record<string, unknown>;
}

const C = {
  on: !!process.stdout.isTTY, // colour on a terminal; plain text when redirected to a file
  b: (s: string) => (C.on ? `\x1b[1m${s}\x1b[0m` : s),
  d: (s: string) => (C.on ? `\x1b[2m${s}\x1b[0m` : s),
  c: (s: string) => (C.on ? `\x1b[36m${s}\x1b[0m` : s),
};

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n.toFixed(n < 10 ? 1 : 0)}ms`);

class RunLog {
  private t0 = performance.now();
  readonly spans: SpanRecord[] = [];
  private file?: string;
  private live = process.env.AURALIS_LOG_TIMING === "1";

  // Call once at the start of a run: zero the clock, clear spans, choose the JSONL sink.
  reset(file?: string): void {
    this.t0 = performance.now();
    this.spans.length = 0;
    this.file = file;
    if (file) {
      try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, ""); } catch { /* noop */ }
    }
  }

  private record(rec: SpanRecord): void {
    this.spans.push(rec);
    if (this.file) {
      try { appendFileSync(this.file, JSON.stringify(rec) + "\n"); } catch { /* best-effort */ }
    }
    if (this.live) {
      process.stderr.write(C.d(`  ⟐ ${fmt(rec.ms).padStart(7)}  ${rec.name}${rec.label ? " " + rec.label : ""}\n`));
    }
  }

  // Manual span: call start(), do the work, call the returned fn when done. Returns elapsed ms.
  start(name: string, label?: string, meta?: Record<string, unknown>): (endMeta?: Record<string, unknown>) => number {
    const atMs = performance.now() - this.t0;
    const t = performance.now();
    return (endMeta) => {
      const ms = performance.now() - t;
      this.record({ name, label, ms, atMs, meta: meta || endMeta ? { ...meta, ...endMeta } : undefined });
      return ms;
    };
  }

  // Wrap an async unit of work in a span. The common case.
  async time<T>(name: string, label: string | undefined, fn: () => Promise<T>): Promise<T> {
    const end = this.start(name, label);
    try {
      return await fn();
    } finally {
      end();
    }
  }

  // Instantaneous marker (no duration).
  event(name: string, meta?: Record<string, unknown>): void {
    this.record({ name, ms: 0, atMs: performance.now() - this.t0, meta });
  }

  // Pretty, centralized bottleneck view: grouped by phase, sorted by total time, with share-of-wall + bar.
  summary(): string {
    const wall = performance.now() - this.t0;
    const g = new Map<string, { n: number; total: number; max: number }>();
    for (const s of this.spans) {
      const e = g.get(s.name) ?? { n: 0, total: 0, max: 0 };
      e.n++;
      e.total += s.ms;
      e.max = Math.max(e.max, s.ms);
      g.set(s.name, e);
    }
    const rows = [...g.entries()].sort((a, b) => b[1].total - a[1].total);
    const top = rows[0]?.[1].total || 1;
    const head =
      `${C.b("━━━ TIMING ━━━")}  wall ${C.c(fmt(wall))} · ${this.spans.length} spans` +
      (this.file ? C.d(`  ·  ${this.file}`) : "");
    const cols = C.d(`${"PHASE".padEnd(18)}${"n".padStart(4)}${"total".padStart(10)}${"mean".padStart(10)}${"max".padStart(10)}   share`);
    const lines = rows.map(([name, e]) => {
      const share = e.total / wall;
      const bar = "▇".repeat(Math.max(0, Math.round((e.total / top) * 10)));
      return (
        `${name.padEnd(18)}${String(e.n).padStart(4)}${fmt(e.total).padStart(10)}${fmt(e.total / e.n).padStart(10)}` +
        `${fmt(e.max).padStart(10)}   ${C.c(bar)} ${(share * 100).toFixed(1)}%`
      );
    });
    return [head, cols, ...lines, C.d("(spans nest — oracle.search runs inside worker.run — so shares are per-phase, not additive)")].join("\n");
  }
}

// The one shared sink. Import `log` anywhere and record into the same run.
export const log = new RunLog();
