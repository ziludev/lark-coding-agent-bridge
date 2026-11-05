import { describe, expect, it } from 'vitest';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';
import { renderText, renderTextFrame } from '../../../src/card/text-renderer.js';

const tool = (
  id: string,
  name: string,
  opts: { input?: unknown; status?: 'running' | 'done' | 'error' } = {},
): RunState['blocks'][number] => ({
  kind: 'tool',
  tool: {
    id,
    name,
    input: opts.input ?? {},
    status: opts.status ?? 'done',
    ...(opts.status === 'running' ? {} : { output: 'ok' }),
  },
});

const state = (blocks: RunState['blocks']): RunState => ({ ...initialState, blocks });

describe('markdown text renderer tool grouping', () => {
  it('keeps one line per tool for short runs', () => {
    const text = renderText(
      state([tool('t1', 'Bash', { input: { command: 'ls' } }), tool('t2', 'Read')]),
    );
    expect(text).toContain('> ✅ **Bash** — ls');
    expect(text).toContain('> ✅ **Read**');
    expect(text).not.toContain('个工具调用');
  });

  it('collapses a long run of identical calls into one counted line', () => {
    const blocks = Array.from({ length: 16 }, (_, i) => tool(`t${i}`, 'ctx_execute'));
    blocks.push(tool('t16', 'edit', { input: { file_path: '/tmp/wt-gw-core/build.gradle.kts' } }));
    const text = renderText(state(blocks));

    expect(text).toContain('> ☕ **17 个工具调用**：ctx_execute ×16、edit');
    // The wall of individual rows is gone.
    expect(text.match(/ctx_execute/g)).toHaveLength(1);
    expect(text).toContain('> ✅ **edit** — /tmp/wt-gw-core/build.gradle.kts');
  });

  it('reports failed calls in the summary', () => {
    const text = renderText(
      state([
        tool('t1', 'ctx_execute'),
        tool('t2', 'ctx_execute', { status: 'error' }),
        tool('t3', 'ctx_execute'),
      ]),
    );
    expect(text).toContain('ctx_execute ×3，1 个失败');
  });

  it('keeps the in-flight call visible while the rest collapse', () => {
    const text = renderText(
      state([
        tool('t1', 'Bash'),
        tool('t2', 'Bash'),
        tool('t3', 'Bash', { input: { command: 'sleep 60' }, status: 'running' }),
      ]),
    );
    expect(text).toContain('> ☕ **3 个工具调用**：Bash ×3');
    expect(text).toContain('> ⏳ **Bash** — sleep 60');
  });

  it('does not merge runs separated by prose', () => {
    const text = renderText(
      state([
        tool('t1', 'Bash'),
        tool('t2', 'Bash'),
        tool('t3', 'Bash'),
        { kind: 'text', content: '现在跑测试', streaming: false },
        tool('t4', 'Bash'),
        tool('t5', 'Bash'),
        tool('t6', 'Bash'),
      ]),
    );
    expect(text.match(/个工具调用/g)).toHaveLength(2);
    expect(text).toContain('现在跑测试');
  });

  it('survives an empty tool output without emitting blank lines', () => {
    const text = renderText(
      state(Array.from({ length: 4 }, (_, i) => tool(`t${i}`, 'ctx_execute'))),
    );
    expect(text.startsWith('> ☕')).toBe(true);
    expect(text).not.toContain('\n\n\n');
  });

  it('honours a terminal footer over the tool summary', () => {
    const running: RunState = reduce(
      initialState,
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 60' } },
      { now: 1_000 },
    );
    expect(renderText(running)).toContain('正在调用工具');
    const done = reduce(
      { ...running, toolCalls: 1 },
      { type: 'done', terminationReason: 'normal' },
    );
    expect(renderText(done)).not.toContain('正在调用工具');
  });
});

describe('markdown text renderer tables', () => {
  const narrow = ['| 名称 | 价格 |', '| --- | ---: |', '| 苹果 | 3 |'].join('\n');
  const wide = [
    '| a | b | c | d | e |',
    '| --- | --- | --- | --- | --- |',
    '| 1 | 2 | 3 | 4 | 5 |',
  ].join('\n');
  const prose = (content: string): RunState => ({
    ...state([{ kind: 'text', content, streaming: false }]),
    terminal: 'done',
    footer: null,
  });

  it('separates a table from the surrounding prose with blank lines', () => {
    const text = renderText(prose(`结论：\n${narrow}\n以上`));

    expect(text).toContain(`结论：\n\n| 名称 | 价格 |`);
    expect(text).toContain('| 苹果 | 3 |\n\n以上');
  });

  it('keeps narrow tables as markdown by default', () => {
    expect(renderText(prose(narrow))).toBe(
      ['| 名称 | 价格 |', '| --- | ---: |', '| 苹果 | 3 |'].join('\n'),
    );
  });

  it('flattens every table for surfaces that cannot render them', () => {
    const text = renderText(prose(narrow), { tables: 'list' });

    expect(text).not.toContain('|');
    expect(text).toContain('**苹果**\n- **价格**：3');
  });

  it('flattens a wide table even when markdown tables are allowed', () => {
    const text = renderText(prose(wide));

    expect(text).not.toContain('|');
    expect(text).toContain('**1**\n- **b**：2');
  });

  it('leaves a fenced code block containing pipes untouched', () => {
    const code = ['```bash', 'ps aux | grep node', '```'].join('\n');
    expect(renderText(prose(code))).toBe(code);
  });

  it('renders the final frame with native table elements', () => {
    const frame = renderTextFrame(prose(`结论：\n${narrow}\n以上`));
    const tags = frame.elements.map((element) => (element as { tag?: string }).tag);

    expect(tags).toEqual(['markdown', 'table', 'markdown']);
    expect(frame.text).toBe(renderText(prose(`结论：\n${narrow}\n以上`)));
  });

  it('caps native tables per card and keeps the rest as markdown tables', () => {
    const frame = renderTextFrame(
      prose(Array.from({ length: 7 }, () => narrow).join('\n\n')),
    );
    const tags = frame.elements.map((element) => (element as { tag?: string }).tag);

    expect(tags.filter((tag) => tag === 'table')).toHaveLength(5);
    expect(tags.filter((tag) => tag === 'markdown')).toHaveLength(2);
    const markdown = frame.elements[frame.elements.length - 1] as { content?: string };
    expect(markdown.content).toContain('| 名称 | 价格 |');
  });
});
