import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer.js';
import { initialState, type RunState } from '../../../src/card/run-state.js';

const NARROW = ['| 名称 | 价格 |', '| --- | ---: |', '| 苹果 | 3 |'].join('\n');
const WIDE = [
  '| a | b | c | d | e |',
  '| --- | --- | --- | --- | --- |',
  '| 1 | 2 | 3 | 4 | 5 |',
].join('\n');

function cardElements(content: string): Array<{ tag?: string; content?: string; columns?: unknown }> {
  const state: RunState = {
    ...initialState,
    blocks: [{ kind: 'text', content, streaming: false }],
    terminal: 'done',
    footer: null,
  };
  const card = renderCard(state) as { body?: { elements?: Array<{ tag?: string; content?: string }> } };
  return card.body?.elements ?? [];
}

describe('run card tables', () => {
  it('renders a narrow table as a native table component', () => {
    const elements = cardElements(`结论：\n${NARROW}\n以上`);

    expect(elements.map((element) => element.tag)).toEqual(['markdown', 'table', 'markdown']);
    expect(elements[0]?.content).toBe('结论：');
    expect(elements[2]?.content).toBe('以上');
  });

  it('degrades a wide table to a key-value list inside a markdown element', () => {
    const elements = cardElements(WIDE);

    expect(elements).toHaveLength(1);
    expect(elements[0]?.tag).toBe('markdown');
    expect(elements[0]?.content).toContain('**1**\n- **b**：2');
  });

  it('caps native tables per card and keeps the rest as markdown tables', () => {
    const elements = cardElements(
      Array.from({ length: 7 }, () => NARROW).join('\n\n'),
    );

    expect(elements.filter((element) => element.tag === 'table')).toHaveLength(5);
    expect(elements.filter((element) => element.tag === 'markdown')).toHaveLength(2);
  });

  it('keeps markdown tables while the card is still streaming', () => {
    const state: RunState = {
      ...initialState,
      blocks: [{ kind: 'text', content: NARROW, streaming: true }],
    };
    const card = renderCard(state) as { body?: { elements?: Array<{ tag?: string; content?: string }> } };
    const elements = card.body?.elements ?? [];

    expect(elements.some((element) => element.tag === 'table')).toBe(false);
    expect(elements[0]?.content).toContain('| 名称 | 价格 |');
  });
});
