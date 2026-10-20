import { maskEmails } from './mask-email';
import { toolProgressSuffix } from './progress-label';
import type { Block, RunState, ToolEntry } from './run-state';
import { toolHeaderText } from './tool-render';

/**
 * Consecutive tool calls at or above this count collapse into one summary line
 * (same rule as the card's collapsible panel). A long agent loop otherwise
 * produces a wall of identical `> ✅ ctx_execute` blockquotes.
 */
const TOOL_COLLAPSE_THRESHOLD = 3;

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
export function renderText(state: RunState): string {
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

  // Strip raw emails so the Feishu tenant audit doesn't reject the message
  // (see mask-email.ts). Never removes content, so emptiness checks upstream
  // still behave.
  return maskEmails(parts.join('\n\n'));
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
