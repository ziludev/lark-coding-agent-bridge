import { describe, expect, it } from 'vitest';
import { formatElapsed, toolProgressSuffix } from '../../../src/card/progress-label.js';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';
import { renderText } from '../../../src/card/text-renderer.js';

const toolUse = (id: string, name = 'Bash', input: unknown = { command: 'ls' }) =>
  ({ type: 'tool_use', id, name, input }) as const;
const toolResult = (id: string) => ({ type: 'tool_result', id, output: 'ok', isError: false }) as const;

describe('formatElapsed', () => {
  it('formats seconds, minutes and hours compactly', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(999)).toBe('0s');
    expect(formatElapsed(9_400)).toBe('9s');
    expect(formatElapsed(65_000)).toBe('1m05s');
    expect(formatElapsed(12 * 60_000)).toBe('12m00s');
    expect(formatElapsed(3_725_000)).toBe('1h02m');
  });
});

describe('tool progress label', () => {
  it('stays empty for a single fresh call so the footer does not flicker', () => {
    const state = reduce(initialState, toolUse('t1'), { now: 1_000 });
    expect(toolProgressSuffix(state, 1_000)).toBe('');
    expect(toolProgressSuffix(state, 2_000)).toBe('');
  });

  it('shows elapsed time once a single call runs long enough to look stuck', () => {
    const state = reduce(initialState, toolUse('t1'), { now: 1_000 });
    expect(toolProgressSuffix(state, 3_500)).toBe('');
    expect(toolProgressSuffix(state, 4_000)).toBe('（已 3s）');
    expect(toolProgressSuffix(state, 1_000 + 72_000)).toBe('（已 1m12s）');
  });

  it('adds the call ordinal from the second call on', () => {
    let state = reduce(initialState, toolUse('t1'), { now: 0 });
    state = reduce(state, toolResult('t1'), { now: 1_000 });
    state = reduce(state, toolUse('t2'), { now: 1_000 });
    expect(toolProgressSuffix(state, 1_000)).toBe('（第 2 次）');
    expect(toolProgressSuffix(state, 1_000 + 40_000)).toBe('（第 2 次 · 已 40s）');
  });

  it('drops the elapsed label when the tool finished', () => {
    const state = reduce(reduce(initialState, toolUse('t1'), { now: 0 }), toolResult('t1'));
    expect(state.activeToolStartedAt).toBeUndefined();
    expect(toolProgressSuffix(state, 90_000)).toBe('');
  });

  it('ignores the clock entirely when the caller does not pass one', () => {
    const state = reduce(initialState, toolUse('t1'));
    expect(state.toolCalls).toBe(1);
    expect(state.activeToolStartedAt).toBeUndefined();
    expect(toolProgressSuffix(state, 90_000)).toBe('');
  });

  it('clears the in-flight marker on every terminal transition', () => {
    const running = reduce(initialState, toolUse('t1'), { now: 0 });
    expect(running.activeToolStartedAt).toBe(0);
    expect(
      reduce(running, { type: 'done', terminationReason: 'normal' }).activeToolStartedAt,
    ).toBeUndefined();
    expect(
      reduce(running, {
        type: 'error',
        message: 'boom',
        terminationReason: 'failed',
      }).activeToolStartedAt,
    ).toBeUndefined();
  });
});

describe('running footer text', () => {
  const runningWithTool = (): RunState => {
    let state = reduce(initialState, toolUse('t1'), { now: 0 });
    state = reduce(state, toolResult('t1'), { now: 1_000 });
    return reduce(state, toolUse('t2'), { now: 1_000 });
  };

  it('renders the call counter and elapsed time in markdown mode', () => {
    const text = renderText(runningWithTool());
    expect(text).toContain('正在调用工具');
    expect(text).toMatch(/第 2 次/);
  });

  it('does not show progress details after the run settles', () => {
    const text = renderText(reduce(runningWithTool(), { type: 'done', terminationReason: 'normal' }));
    expect(text).not.toContain('正在调用工具');
  });
});
