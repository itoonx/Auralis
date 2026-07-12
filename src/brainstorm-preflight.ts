// Preflight for /brainstorm — a paid provider with no key or no balance must NOT start work, and must NOT
// fail silently. Pure decision layer: `probe(spec)` throws if a provider is unusable (missing key / 429 out
// of credits / auth). We check every configured provider ONCE up front, drop the unusable ones LOUDLY,
// resolve the synthesizer to a live provider, and tell the caller to abort if nothing survives.
// Testable with a fake probe — no network, no runners.
import type { RunnerSpec } from "./runners";

export const label = (s: RunnerSpec) => (s.model ? `${s.vendor}:${s.model}` : s.vendor);

export interface Preflight {
  panel: RunnerSpec[]; // configured panelists that passed
  synth: RunnerSpec | null; // configured synth if live, else the first live panelist, else null
  excluded: { name: string; reason: string }[]; // who was dropped and why (surfaced, never silent)
}

export async function preflightPanel(
  panel: RunnerSpec[],
  synth: RunnerSpec,
  probe: (spec: RunnerSpec) => Promise<void>,
  log: (line: string) => void = () => {},
): Promise<Preflight> {
  // Probe each DISTINCT provider once (panel ∪ synth), keyed by label — no wasted double-checks.
  const seen = new Map<string, RunnerSpec>();
  for (const s of [...panel, synth]) if (!seen.has(label(s))) seen.set(label(s), s);

  const okNames = new Set<string>();
  const excluded: { name: string; reason: string }[] = [];
  for (const [name, spec] of seen) {
    try {
      await probe(spec);
      okNames.add(name);
      log(`  ✓ ${name}`);
    } catch (e) {
      const reason = String((e as Error).message).slice(0, 100);
      excluded.push({ name, reason });
      log(`  ✗ ${name} excluded — ${reason}`);
    }
  }

  const readyPanel = panel.filter((s) => okNames.has(label(s)));
  const synthReady = okNames.has(label(synth)) ? synth : (readyPanel[0] ?? null);
  return { panel: readyPanel, synth: synthReady, excluded };
}
