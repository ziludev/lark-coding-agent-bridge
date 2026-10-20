import type { RunState } from './run-state';

/**
 * Below this the footer would flicker `已 0s → 已 1s` on every quick tool, so
 * elapsed time only appears once a call has actually been running a while.
 */
const ELAPSED_DISPLAY_MIN_MS = 3000;

/** Compact elapsed label: `9s`, `1m05s`, `1h02m`. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m${String(totalSeconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * Suffix for the running footer, e.g. `（第 7 次 · 已 1m12s）`.
 *
 * A tool loop can run for minutes without emitting anything else, which used to
 * leave the card frozen on a bare "正在调用工具" — indistinguishable from a hung
 * run. The call counter appears from the second call on (a single call needs no
 * ordinal) and the elapsed time from `ELAPSED_DISPLAY_MIN_MS`.
 */
export function toolProgressSuffix(state: RunState, now = Date.now()): string {
  const parts: string[] = [];
  const calls = state.toolCalls ?? 0;
  if (calls >= 2) parts.push(`第 ${calls} 次`);
  if (state.activeToolStartedAt !== undefined) {
    const elapsed = now - state.activeToolStartedAt;
    if (elapsed >= ELAPSED_DISPLAY_MIN_MS) parts.push(`已 ${formatElapsed(elapsed)}`);
  }
  return parts.length > 0 ? `（${parts.join(' · ')}）` : '';
}
