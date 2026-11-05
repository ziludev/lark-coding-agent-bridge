/**
 * Markdown pipe-table handling for Feishu output.
 *
 * Agent answers regularly contain GFM pipe tables. Feishu's card markdown
 * element does render them, but it lays the table out by itself: column widths
 * are unconstrained and the table cannot scroll, so a wide table (or long
 * cells) gets cut off at the card edge. Card schema 2.0 has a native `table`
 * component instead — each column gets a width and an over-long cell is
 * ellipsized with the full value on hover — so tables are lifted out of the
 * markdown text and rendered with it.
 *
 * Tables the component cannot take (too many columns, or past the per-card
 * limit) — and any table bound for a post `md` element, which cannot render
 * tables at all — degrade into a key-value list that survives any width.
 */

/** GFM delimiter row cell, e.g. `---`, `:---`, `:---:`. */
const DELIMITER_CELL_RE = /^:?-{1,}:?$/;

/**
 * Native tables stop being readable past this many columns on a phone: each
 * column shrinks to a few characters and everything ellipsizes.
 */
export const MAX_NATIVE_TABLE_COLUMNS = 4;

/** Feishu rejects a card carrying more than five table components. */
export const MAX_NATIVE_TABLES_PER_CARD = 5;

/**
 * Per-cell character cap. Guards the card's serialized size: a pathological
 * table (many rows × multi-KB cells) would otherwise push the whole card past
 * Feishu's element size limit and lose the entire reply.
 */
const CELL_MAX_CHARS = 300;

/**
 * Rows a native table shows before it paginates (Feishu allows 1-10). Short
 * tables keep their own row count so they never grow a pager row for nothing.
 */
const NATIVE_TABLE_PAGE_SIZE = 10;

export type TableAlign = 'left' | 'center' | 'right' | undefined;

export interface MarkdownTable {
  /** Header cells, already normalized to a single line. */
  header: string[];
  /** Per-column alignment from the delimiter row. */
  align: TableAlign[];
  /** Body rows, each padded/truncated to `header.length`. */
  rows: string[][];
}

export type MarkdownSegment =
  | { kind: 'text'; content: string }
  | { kind: 'table'; table: MarkdownTable };

/**
 * Split markdown into text and pipe-table segments.
 *
 * Text segments keep their original inline formatting and line breaks; table
 * segments are returned parsed so callers can decide how to render them.
 * Fenced code blocks are never parsed (a shell script with `|` pipes must stay
 * code), and blockquote lines are ignored for the same reason.
 */
export function splitTables(md: string): MarkdownSegment[] {
  const lines = md.split('\n');
  const segments: MarkdownSegment[] = [];
  let text: string[] = [];
  // Open code fence: its marker character and run length, so a longer fence
  // (` ```` `) can only be closed by a run at least as long.
  let fence: { char: string; length: number } | undefined;

  const flushText = (): void => {
    if (text.length === 0) return;
    const content = text.join('\n');
    text = [];
    if (content.trim()) segments.push({ kind: 'text', content });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fenceMark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      const closes =
        fenceMark !== undefined &&
        fenceMark[0] === fence.char &&
        fenceMark.length >= fence.length;
      if (closes) fence = undefined;
      text.push(line);
      continue;
    }
    if (fenceMark) {
      fence = { char: fenceMark[0] ?? '`', length: fenceMark.length };
      text.push(line);
      continue;
    }

    const found = tableAt(lines, index);
    if (!found) {
      text.push(line);
      continue;
    }
    flushText();
    segments.push({ kind: 'table', table: found.table });
    index = found.end;
  }

  flushText();
  return segments;
}

/**
 * Parse the table starting at `headerIndex`, or `undefined` when there is none.
 * `end` is the index of the last consumed line (header + delimiter + rows).
 */
function tableAt(
  lines: string[],
  headerIndex: number,
): { table: MarkdownTable; end: number } | undefined {
  const header = rowCells(lines[headerIndex] ?? '');
  if (!header) return undefined;
  const align = delimiterAlign(lines[headerIndex + 1] ?? '');
  if (!align || align.length !== header.length) return undefined;

  const rows: string[][] = [];
  let end = headerIndex + 1;
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const cells = rowCells(lines[index] ?? '');
    if (!cells) break;
    rows.push(fitCells(cells, header.length).map(normalizeCell));
    end = index;
  }

  return {
    table: { header: header.map(normalizeCell), align, rows },
    end,
  };
}

/** Cells of a table row line, or `undefined` when the line cannot be one. */
function rowCells(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('>') || !trimmed.includes('|')) return undefined;
  return parseRow(trimmed);
}

function delimiterAlign(line: string): TableAlign[] | undefined {
  const cells = rowCells(line);
  if (!cells || cells.length === 0) return undefined;
  const align: TableAlign[] = [];
  for (const cell of cells) {
    const trimmed = cell.trim();
    if (!DELIMITER_CELL_RE.test(trimmed)) return undefined;
    align.push(
      trimmed.startsWith(':') && trimmed.endsWith(':')
        ? 'center'
        : trimmed.endsWith(':')
          ? 'right'
          : trimmed.startsWith(':')
            ? 'left'
            : undefined,
    );
  }
  return align;
}

/**
 * Split one row into cells. Handles escaped pipes (`a \| b`) and pipes inside
 * inline code spans (`` `a|b` ``), which are cell content, not separators.
 */
function parseRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  let inCode = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? '';
    if (char === '\\' && body[index + 1] === '|') {
      current += '|';
      index += 1;
      continue;
    }
    if (char === '`') {
      inCode = !inCode;
      current += char;
      continue;
    }
    if (char === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function fitCells(cells: string[], count: number): string[] {
  if (cells.length === count) return cells;
  if (cells.length > count) return cells.slice(0, count);
  return [...cells, ...Array.from({ length: count - cells.length }, () => '')];
}

/** Collapse to a single line and cap the length (see `CELL_MAX_CHARS`). */
function normalizeCell(cell: string): string {
  const oneLine = cell.replace(/\s+/g, ' ').trim();
  return oneLine.length > CELL_MAX_CHARS
    ? `${oneLine.slice(0, CELL_MAX_CHARS - 1)}…`
    : oneLine;
}

/**
 * Whether this table renders well as the native card component. Beyond
 * `MAX_NATIVE_TABLE_COLUMNS` columns it would ellipsize into unreadability,
 * and a header-only table has nothing to show.
 */
export function canRenderAsCardTable(table: MarkdownTable): boolean {
  return (
    table.header.length > 0 &&
    table.header.length <= MAX_NATIVE_TABLE_COLUMNS &&
    table.rows.length > 0
  );
}

/**
 * Native schema-2.0 `table` element. Cells use `lark_md` so inline code and
 * bold inside a cell keep rendering; column widths stay `auto` (Feishu sizes
 * them to the card) and each over-long cell ellipsizes with hover reveal.
 */
export function tableToCardElement(table: MarkdownTable): object {
  const columns = table.header.map((cell, index) => ({
    name: `c${index}`,
    display_name: plainText(cell) || `列${index + 1}`,
    data_type: 'lark_md',
    width: 'auto',
  }));
  const rows = table.rows.map((row) => {
    const values: Record<string, string> = {};
    columns.forEach((column, index) => {
      values[column.name] = row[index] ?? '';
    });
    return values;
  });

  return {
    tag: 'table',
    page_size: Math.min(Math.max(rows.length, 1), NATIVE_TABLE_PAGE_SIZE),
    columns,
    rows,
  };
}

/**
 * Re-emit the table as normalized markdown — consistent cell spacing and
 * alignment markers. Callers join segments with blank lines, which also fixes
 * the "table glued to the paragraph above it" rendering bug.
 */
export function tableToMarkdown(table: MarkdownTable): string {
  const row = (cells: string[]): string => `| ${cells.map(escapeCell).join(' | ')} |`;
  const delimiter = table.align.map((align) =>
    align === 'center' ? ':---:' : align === 'right' ? '---:' : align === 'left' ? ':---' : '---',
  );
  return [row(table.header), row(delimiter), ...table.rows.map(row)].join('\n');
}

/**
 * Fallback for every surface that cannot render a table (post `md` elements,
 * drive comments) and for tables the card component cannot take: one titled
 * block per row, with the remaining columns as label/value lines. Stays
 * readable at any width because nothing has to line up horizontally.
 */
export function tableToKeyValueList(table: MarkdownTable): string {
  const columnCount = Math.max(
    table.header.length,
    ...table.rows.map((row) => row.length),
    1,
  );
  const label = (index: number): string => {
    const header = table.header[index]?.trim() ?? '';
    return header || `列${index + 1}`;
  };

  if (table.rows.length === 0) {
    return table.header.filter(Boolean).map((cell) => `**${cell}**`).join(' · ');
  }

  return table.rows
    .map((row, rowIndex) => {
      const title = (row[0] ?? '').trim() || `${label(0)} ${rowIndex + 1}`;
      const fields: string[] = [];
      for (let column = 1; column < columnCount; column += 1) {
        const value = (row[column] ?? '').trim();
        if (value) fields.push(`- **${label(column)}**：${value}`);
      }
      return [`**${title}**`, ...fields].join('\n');
    })
    .join('\n\n');
}

function escapeCell(cell: string): string {
  return cell.replace(/\|/g, '\\|');
}

/** Strip inline markdown so a plain-text field (column name) stays literal. */
function plainText(cell: string): string {
  return cell.replace(/\*\*|__|`/g, '').trim();
}
