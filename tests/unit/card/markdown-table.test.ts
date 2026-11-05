import { describe, expect, it } from 'vitest';
import {
  MAX_NATIVE_TABLE_COLUMNS,
  canRenderAsCardTable,
  splitTables,
  tableToCardElement,
  tableToKeyValueList,
  tableToMarkdown,
  type MarkdownSegment,
} from '../../../src/card/markdown-table.js';

const TABLE = ['| 名称 | 价格 |', '| --- | ---: |', '| 苹果 | 3 |', '| 梨 | 5 |'].join('\n');

function tables(segments: MarkdownSegment[]): MarkdownSegment[] {
  return segments.filter((segment) => segment.kind === 'table');
}

describe('markdown pipe-table parsing', () => {
  it('lifts a table out of surrounding prose', () => {
    const segments = splitTables(`结论如下：\n\n${TABLE}\n\n以上。`);

    expect(segments.map((segment) => segment.kind)).toEqual(['text', 'table', 'text']);
    const [table] = tables(segments);
    if (table?.kind !== 'table') throw new Error('expected a table');
    expect(table.table.header).toEqual(['名称', '价格']);
    expect(table.table.rows).toEqual([
      ['苹果', '3'],
      ['梨', '5'],
    ]);
    expect(table.table.align).toEqual([undefined, 'right']);
  });

  it('parses a table without outer pipes', () => {
    const segments = splitTables('a | b\n--- | ---\n1 | 2');
    const [table] = tables(segments);
    if (table?.kind !== 'table') throw new Error('expected a table');
    expect(table.table.header).toEqual(['a', 'b']);
    expect(table.table.rows).toEqual([['1', '2']]);
  });

  it('keeps escaped pipes and inline code pipes inside their cell', () => {
    const segments = splitTables('| cmd | 说明 |\n| --- | --- |\n| a \\| b | `x|y` |');
    const [table] = tables(segments);
    if (table?.kind !== 'table') throw new Error('expected a table');
    expect(table.table.rows).toEqual([['a | b', '`x|y`']]);
  });

  it('pads short rows and drops extra cells to match the header', () => {
    const segments = splitTables('| a | b | c |\n| --- | --- | --- |\n| 1 |\n| 1 | 2 | 3 | 4 |');
    const [table] = tables(segments);
    if (table?.kind !== 'table') throw new Error('expected a table');
    expect(table.table.rows).toEqual([
      ['1', '', ''],
      ['1', '2', '3'],
    ]);
  });

  it('never parses inside fenced code blocks or blockquotes', () => {
    const fenced = ['```', '| a | b |', '| --- | --- |', '| 1 | 2 |', '```'].join('\n');
    expect(tables(splitTables(fenced))).toHaveLength(0);

    const quoted = ['> | a | b |', '> | --- | --- |'].join('\n');
    expect(tables(splitTables(quoted))).toHaveLength(0);
  });

  it('requires the delimiter row column count to match the header', () => {
    expect(tables(splitTables('| a | b |\n| --- |'))).toHaveLength(0);
    expect(tables(splitTables('| a | b |\nplain text'))).toHaveLength(0);
  });

  it('collapses multi-line cells and caps oversized ones', () => {
    const long = 'x'.repeat(400);
    const segments = splitTables(`| a |\n| --- |\n|  ${long}  |`);
    const [table] = tables(segments);
    if (table?.kind !== 'table') throw new Error('expected a table');
    const cell = table.table.rows[0]?.[0] ?? '';
    expect(cell.endsWith('…')).toBe(true);
    expect(cell.length).toBeLessThan(400);
  });
});

describe('table rendering', () => {
  const table = {
    header: ['名称', '价格'],
    align: [undefined, 'right' as const],
    rows: [
      ['苹果', '3'],
      ['梨', '5'],
    ],
  };

  it('re-emits normalized markdown with alignment', () => {
    expect(tableToMarkdown(table)).toBe(
      ['| 名称 | 价格 |', '| --- | ---: |', '| 苹果 | 3 |', '| 梨 | 5 |'].join('\n'),
    );
  });

  it('flattens a table into a label/value list', () => {
    expect(tableToKeyValueList(table)).toBe(
      '**苹果**\n- **价格**：3\n\n**梨**\n- **价格**：5',
    );
  });

  it('flattens a wide table without dropping columns', () => {
    const wide = {
      header: ['a', 'b', 'c', 'd', 'e'],
      align: [undefined, undefined, undefined, undefined, undefined],
      rows: [['1', '2', '3', '4', '5']],
    };
    expect(tableToKeyValueList(wide)).toBe(
      '**1**\n- **b**：2\n- **c**：3\n- **d**：4\n- **e**：5',
    );
  });

  it('renders a header-only table as a single line', () => {
    expect(tableToKeyValueList({ header: ['a', 'b'], align: [undefined, undefined], rows: [] })).toBe(
      '**a** · **b**',
    );
  });

  it('builds a native card table with one column per header cell', () => {
    const element = tableToCardElement(table) as {
      tag: string;
      page_size: number;
      columns: Array<{ name: string; display_name: string; data_type: string }>;
      rows: Array<Record<string, string>>;
    };

    expect(element.tag).toBe('table');
    expect(element.page_size).toBe(2);
    expect(element.columns).toEqual([
      { name: 'c0', display_name: '名称', data_type: 'lark_md', width: 'auto' },
      { name: 'c1', display_name: '价格', data_type: 'lark_md', width: 'auto' },
    ]);
    expect(element.rows).toEqual([
      { c0: '苹果', c1: '3' },
      { c0: '梨', c1: '5' },
    ]);
  });

  it('only takes narrow tables with at least one row', () => {
    const columns = (count: number) => Array.from({ length: count }, (_, i) => `c${i}`);
    expect(canRenderAsCardTable({ header: columns(MAX_NATIVE_TABLE_COLUMNS), align: [], rows: [['1']] })).toBe(true);
    expect(canRenderAsCardTable({ header: columns(MAX_NATIVE_TABLE_COLUMNS + 1), align: [], rows: [['1']] })).toBe(false);
    expect(canRenderAsCardTable({ header: ['a'], align: [undefined], rows: [] })).toBe(false);
  });
});
