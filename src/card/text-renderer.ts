import {
  MAX_NATIVE_TABLES_PER_CARD,
  canRenderAsCardTable,
  splitTables,
  tableToCardElement,
  tableToKeyValueList,
  tableToMarkdown,
} from './markdown-table';
import { deepMaskEmails, maskEmails } from './mask-email';
import { toolProgressSuffix } from './progress-label';
import type { Block, RunState, ToolEntry } from './run-state';
import { toolHeaderText } from './tool-render';

/**
 * Consecutive tool calls at or above this count collapse into one summary line
 * (same rule as the card's collapsible panel). A long agent loop otherwise
 * produces a wall of identical `> ✅ ctx_execute` blockquotes.
 */
const TOOL_COLLAPSE_THRESHOLD = 3;

/** How pipe tables are represented in a markdown string. */
export type TableTextMode = 'markdown' | 'list';

export interface RenderTextOptions {
  /**
   * `markdown` keeps pipe tables (card markdown elements can render them);
   * `list` flattens every table into a label/value list, for surfaces that
   * cannot render tables at all — a post message's `md` element and drive
   * comments. Default: `markdown`.
   */
  tables?: TableTextMode;
}

/**
 * Render `RunState` as plain markdown text — used in `messageReply: 'markdown'`
 * and `'text'` modes where we stream a markdown message instead of a card.
 *
 * Differences vs `renderCard`:
 *   - No collapsible panels, no buttons (markdown messages have neither)
 *   - Tool calls collapse to a single short line each, and runs of them into one
 *     summary line (see {@link renderToolGroup})
 *   - No reasoning / thinking output (no place to fold it; would be noise)
 *   - Footer is appended inline at the bottom while running
 */
export function renderText(state: RunState, options: RenderTextOptions = {}): string {
  return maskEmails(renderMarkdown(renderParts(state), options.tables ?? 'markdown'));
}

/**
 * Element-level render of the same content, for the final frame of a
 * `markdown`-mode reply: the streaming card only ever holds one markdown
 * element, so a table can only become a native `table` component once the run
 * is over and the frame is PATCHed. `text` is the equivalent markdown string
 * (summary + emptiness checks), so both stay in sync.
 */
export function renderTextFrame(state: RunState): { text: string; elements: object[] } {
  const parts = renderParts(state);
  const budget: ElementBudget = {
    nativeTablesLeft: MAX_NATIVE_TABLES_PER_CARD,
    fallback: 'markdown',
  };
  return {
    text: renderText(state),
    elements: deepMaskEmails(parts.flatMap((part) => markdownToElements(part, budget))),
  };
}

/** Shared budget so a single card never exceeds the table-component limit. */
export interface ElementBudget {
  /** How many native table components this card may still carry (0 = none). */
  nativeTablesLeft: number;
  /**
   * What a table that *could* be native but has no budget left becomes: the
   * streaming card keeps markdown tables (Feishu renders them, and a
   * `streaming_mode` card stays plain markdown only), everything else — past
   * the per-card limit — flattens to the key-value list. Tables too wide for
   * the component always flatten.
   */
  fallback: 'markdown' | 'list';
}

/**
 * One markdown string → card elements: text stays markdown, tables become
 * native `table` components while the card budget allows, and degrade to a
 * markdown table or the key-value list otherwise.
 */
export function markdownToElements(md: string, budget: ElementBudget): object[] {
  const elements: object[] = [];
  for (const segment of splitTables(md)) {
    if (segment.kind === 'text') {
      const content = trimBlankEdges(segment.content);
      if (content.trim()) elements.push({ tag: 'markdown', content });
      continue;
    }
    const eligible = canRenderAsCardTable(segment.table);
    if (eligible && budget.nativeTablesLeft > 0) {
      budget.nativeTablesLeft -= 1;
      elements.push(tableToCardElement(segment.table));
      continue;
    }
    elements.push({
      tag: 'markdown',
      content:
        eligible && budget.fallback === 'markdown'
          ? tableToMarkdown(segment.table)
          : tableToKeyValueList(segment.table),
    });
  }
  return elements;
}

/**
 * Flatten rendered parts into one markdown string. Every segment is joined with
 * a blank line, which is what keeps a table from being absorbed into the
 * paragraph above it (Feishu then renders the surrounding text as part of the
 * table header row).
 */
function renderMarkdown(parts: string[], tables: TableTextMode): string {
  const chunks: string[] = [];
  for (const part of parts) {
    for (const segment of splitTables(part)) {
      if (segment.kind === 'text') {
        const content = trimBlankEdges(segment.content);
        if (content.trim()) chunks.push(content);
        continue;
      }
      chunks.push(
        tables === 'markdown' && canRenderAsCardTable(segment.table)
          ? tableToMarkdown(segment.table)
          : tableToKeyValueList(segment.table),
      );
    }
  }
  return chunks.join('\n\n');
}

function renderParts(state: RunState): string[] {
  const parts = renderBlocks(state.blocks);

  if (state.terminal === 'interrupted') {
    parts.push('_⏹ 已被中断_');
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    parts.push(`_⏱ ${mins} 分钟无响应,已自动终止_`);
  } else if (state.terminal === 'error' && state.errorMsg) {
    parts.push(`⚠️ agent 失败:${state.errorMsg}`);
  } else if (state.terminal === 'running' && state.footer) {
    parts.push(footerLine(state));
  }
  return parts;
}

function renderBlocks(blocks: Block[]): string[] {
  const parts: string[] = [];
  let tools: ToolEntry[] = [];
  const flushTools = (): void => {
    if (tools.length === 0) return;
    parts.push(renderToolGroup(tools));
    tools = [];
  };

  for (const block of blocks) {
    if (block.kind === 'tool') {
      tools.push(block.tool);
      continue;
    }
    flushTools();
    const text = block.content.trim();
    if (text) parts.push(text);
  }
  flushTools();
  return parts;
}

/**
 * One line per tool call (`> ✅ **Bash** — git status`), or — for a run of them
 * — a single summary line plus the newest call, so the most recent action (and
 * anything still running) stays visible without the full wall of rows.
 */
function renderToolGroup(tools: ToolEntry[]): string {
  if (tools.length < TOOL_COLLAPSE_THRESHOLD) return tools.map(toolLine).join('\n');

  const counts = new Map<string, number>();
  let errors = 0;
  for (const tool of tools) {
    counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
    if (tool.status === 'error') errors += 1;
  }
  const detail = [...counts]
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join('、');
  const suffix = errors > 0 ? `，${errors} 个失败` : '';
  const lines = [`> ☕ **${tools.length} 个工具调用**：${detail}${suffix}`];
  // Keep the newest call visible: it carries the live status when running, and
  // the most recent target (file path, command) when the run already finished.
  const latest = tools[tools.length - 1];
  if (latest) lines.push(toolLine(latest));
  return lines.join('\n');
}

/**
 * One-line summary for a tool call:
 *   `> ⏳ **Bash** — git status`
 *   `> ✅ **Read** — ~/code/foo.ts`
 * Reuses `toolHeaderText` so the format matches the card mode header.
 */
function toolLine(tool: ToolEntry): string {
  return `> ${toolHeaderText(tool)}`;
}

function footerLine(state: RunState): string {
  if (state.footer === 'thinking') return '_🧠 正在思考…_';
  if (state.footer === 'tool_running') {
    return `_🧰 正在调用工具…${toolProgressSuffix(state)}_`;
  }
  return '_✍️ 正在输出…_';
}

function trimBlankEdges(text: string): string {
  return text.replace(/^\n+/, '').replace(/\n+$/, '');
}
