import { formatElapsed } from './progress-label';
import type { RunState } from './run-state';

/**
 * One-line "how this answer was produced" footnote: model (thinking level) ·
 * elapsed · spend, mirroring the agent CLI's own status line. Pieces the agent
 * did not report are dropped — codex, for instance, sends token counts but no
 * cost and no thinking level.
 *
 * Returns an empty string when there is nothing to show, so callers can skip
 * the element entirely.
 */
export function runMetaText(state: RunState): string {
  const parts: string[] = [];
  if (state.model) {
    parts.push(state.thinkingLevel ? `${state.model} (${state.thinkingLevel})` : state.model);
  } else if (state.thinkingLevel) {
    parts.push(`thinking ${state.thinkingLevel}`);
  }
  if (state.elapsedMs !== undefined) parts.push(formatElapsed(state.elapsedMs));
  const cost = state.usage?.costUsd;
  if (cost !== undefined) parts.push(formatCost(cost));
  return parts.join(' · ');
}

/** Keep enough digits to tell runs apart: sub-cent runs are the normal case. */
function formatCost(usd: number): string {
  if (usd >= 0.1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}
