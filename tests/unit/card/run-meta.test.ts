import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer.js';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';
import { renderText } from '../../../src/card/text-renderer.js';
import { pinnedModelText } from '../../../src/agent/models.js';

const state = (extra: Partial<RunState>): RunState => ({
  ...initialState,
  blocks: [{ kind: 'text', content: '回答', streaming: false }],
  terminal: 'done',
  footer: null,
  ...extra,
});

function cardElements(next: RunState): Array<{ tag?: string; content?: string; text_size?: string }> {
  const card = renderCard(next) as {
    body?: { elements?: Array<{ tag?: string; content?: string; text_size?: string }> };
  };
  return card.body?.elements ?? [];
}

describe('run footnote (model · elapsed · cost)', () => {
  it('records the model the agent reports', () => {
    const next = reduce(initialState, { type: 'system', sessionId: 's1', model: 'claude-sonnet-4-6' });

    expect(next.model).toBe('claude-sonnet-4-6');
  });

  it('ignores a system event without a model', () => {
    expect(reduce(initialState, { type: 'system', sessionId: 's1' }).model).toBeUndefined();
  });

  it('keeps the model when a later event only changes the thinking level', () => {
    const first = reduce(initialState, {
      type: 'system',
      model: 'deepseek-v4.1-flash',
      thinkingLevel: 'high',
    });
    const second = reduce(first, { type: 'system', thinkingLevel: 'max' });

    expect(second.model).toBe('deepseek-v4.1-flash');
    expect(second.thinkingLevel).toBe('max');
    // A no-op repeat keeps the same object (no needless re-render).
    expect(reduce(second, { type: 'system', thinkingLevel: 'max' })).toBe(second);
  });

  it('renders the model as a trailing note in card mode', () => {
    const elements = cardElements(state({ model: 'claude-sonnet-4-6' }));

    expect(elements.map((element) => element.tag)).toEqual(['markdown', 'markdown']);
    expect(elements[1]?.content).toBe('🤖 claude-sonnet-4-6');
    expect(elements[1]?.text_size).toBe('notation');
  });

  it('shows the thinking level next to the model', () => {
    expect(
      renderText(
        state({ model: 'deepseek-v4.1-flash', thinkingLevel: 'high', elapsedMs: 16_400 }),
      ),
    ).toBe('回答\n\n_🤖 deepseek-v4.1-flash (high) · 16s_');
    expect(renderText(state({ thinkingLevel: 'high', elapsedMs: 1_000 }))).toBe(
      '回答\n\n_🤖 thinking high · 1s_',
    );
  });

  it('adds elapsed time and spend to the same line', () => {
    expect(
      renderText(
        state({ model: 'claude-sonnet-4-6', elapsedMs: 16_400, usage: { costUsd: 0.0042 } }),
      ),
    ).toBe('回答\n\n_🤖 claude-sonnet-4-6 · 16s · $0.0042_');
  });

  it('drops the pieces the agent did not report', () => {
    expect(renderText(state({ model: 'gpt-5-codex', elapsedMs: 42_000 }))).toBe(
      '回答\n\n_🤖 gpt-5-codex · 42s_',
    );
    expect(renderText(state({ elapsedMs: 1_000 }))).toBe('回答\n\n_🤖 1s_');
  });

  it('scales the cost precision so small runs still read apart', () => {
    const cost = (costUsd: number): string =>
      renderText(state({ elapsedMs: 1_000, usage: { costUsd } }));
    expect(cost(0.00042)).toContain('$0.0004');
    expect(cost(0.042)).toContain('$0.042');
    expect(cost(0.42)).toContain('$0.42');
  });

  it('sums spend across the run\'s usage events', () => {
    const first = reduce(initialState, { type: 'usage', costUsd: 0.002 });
    const second = reduce(first, { type: 'usage', costUsd: 0.003 });

    expect(first.usage?.costUsd).toBeCloseTo(0.002);
    expect(second.usage?.costUsd).toBeCloseTo(0.005);
    // Token-only usage events (codex) leave the spend untouched.
    expect(reduce(first, { type: 'usage', inputTokens: 10 }).usage?.costUsd).toBeCloseTo(0.002);
  });

  it('leaves the footnote out of emptiness checks', () => {
    const only = state({ model: 'claude-sonnet-4-6', elapsedMs: 5_000, blocks: [] });

    expect(renderText(only)).toBe('_🤖 claude-sonnet-4-6 · 5s_');
    expect(renderText(only, { meta: false })).toBe('');
  });

  it('renders the model as a trailing line in markdown mode', () => {
    expect(renderText(state({ model: 'claude-sonnet-4-6' }))).toBe(
      '回答\n\n_🤖 claude-sonnet-4-6_',
    );
  });

  it('stays out of the reply when no model is known', () => {
    expect(renderText(state({}))).toBe('回答');
    expect(cardElements(state({}))).toHaveLength(1);
  });

  it('keeps the markdown footnote out of completion summaries', () => {
    const line = renderText(state({ model: 'claude-sonnet-4-6' }))
      .split('\n')
      .find((candidate) => {
        const trimmed = candidate.trim();
        return trimmed !== '' && !trimmed.startsWith('>') && !trimmed.startsWith('_');
      });

    expect(line).toBe('回答');
  });

  it('falls back to the pinned picker label', () => {
    expect(pinnedModelText('claude', undefined)).toBe('默认');
    expect(pinnedModelText('claude', 'default')).toBe('默认');
    expect(pinnedModelText('claude', 'claude-sonnet-4-6')).toBe('Sonnet 4.6');
  });
});
