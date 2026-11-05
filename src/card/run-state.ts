import type { AgentEvent } from '../agent/types';

export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolEntry {
  id: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  output?: string;
}

export type Block =
  | { kind: 'text'; content: string; streaming: boolean }
  | { kind: 'tool'; tool: ToolEntry };

/** What the agent reported spending on this run (summed over its usage events). */
export interface RunUsage {
  costUsd?: number;
}

export type FooterStatus = 'thinking' | 'tool_running' | 'streaming' | null;
export type Terminal = 'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout';

export interface RunState {
  blocks: Block[];
  finalText?: string;
  reasoning: { content: string; active: boolean };
  footer: FooterStatus;
  terminal: Terminal;
  errorMsg?: string;
  /** Set when terminal === 'idle_timeout' — how long claude was idle before
   * the watchdog gave up (so the message can say "N 分钟无响应"). */
  idleTimeoutMinutes?: number;
  /**
   * Model the agent reported actually loading (Claude's init event, pi's
   * assistant message). Rendered as the reply's footnote; absent when the
   * adapter exposes none, in which case the channel layer fills in the pinned
   * picker label.
   */
  model?: string;
  /** Effective thinking/reasoning level the agent ran with (pi reports it). */
  thinkingLevel?: string;
  /** Wall clock from run start to the terminal event, stamped on that state. */
  elapsedMs?: number;
  /** Spend reported by the agent; absent when the agent reports none (codex). */
  usage?: RunUsage;
  /** Tool calls seen in this run, so a long tool loop shows visible progress.
   * Optional so externally-built RunState literals stay valid. */
  toolCalls?: number;
  /** Epoch ms the in-flight tool started. Absent when no tool runs, or when the
   * caller supplied no clock (keeps `reduce` deterministic for tests). */
  activeToolStartedAt?: number;
}

export const initialState: RunState = {
  blocks: [],
  reasoning: { content: '', active: false },
  footer: 'thinking',
  terminal: 'running',
  toolCalls: 0,
};

export interface ReduceOptions {
  /** Wall clock used for the elapsed-time label; omitted by pure callers/tests. */
  now?: number;
}

function closeStreamingText(blocks: Block[]): Block[] {
  return blocks.map((b) =>
    b.kind === 'text' && b.streaming ? { ...b, streaming: false } : b,
  );
}

export function reduce(state: RunState, evt: AgentEvent, opts: ReduceOptions = {}): RunState {
  switch (evt.type) {
    case 'system': {
      // The agent's own report of what it actually ran (model, thinking level)
      // is the ground truth for the reply footnote; later events repeat it, so
      // drop no-op updates.
      const model = evt.model ?? state.model;
      const thinkingLevel = evt.thinkingLevel ?? state.thinkingLevel;
      if (model === state.model && thinkingLevel === state.thinkingLevel) return state;
      return { ...state, model, thinkingLevel };
    }

    case 'text': {
      const last = state.blocks[state.blocks.length - 1];
      if (last && last.kind === 'text' && last.streaming) {
        const next: Block = { ...last, content: last.content + evt.delta };
        return {
          ...state,
          blocks: [...state.blocks.slice(0, -1), next],
          reasoning: { ...state.reasoning, active: false },
          footer: 'streaming',
        };
      }
      return {
        ...state,
        blocks: [...state.blocks, { kind: 'text', content: evt.delta, streaming: true }],
        reasoning: { ...state.reasoning, active: false },
        footer: 'streaming',
      };
    }

    case 'usage': {
      if (evt.costUsd === undefined) return state;
      // Agents report usage per turn (pi) or once with totals (claude); both
      // accumulate, so a resumed multi-turn run shows the whole spend.
      const costUsd = (state.usage?.costUsd ?? 0) + evt.costUsd;
      return { ...state, usage: { ...state.usage, costUsd } };
    }

    case 'final_text':
      return { ...state, finalText: evt.content };

    case 'thinking': {
      return {
        ...state,
        reasoning: { content: state.reasoning.content + evt.delta, active: true },
        footer: 'thinking',
      };
    }

    case 'tool_use': {
      const tool: ToolEntry = {
        id: evt.id,
        name: evt.name,
        input: evt.input,
        status: 'running',
      };
      return {
        ...state,
        blocks: [...closeStreamingText(state.blocks), { kind: 'tool', tool }],
        reasoning: { ...state.reasoning, active: false },
        footer: 'tool_running',
        toolCalls: (state.toolCalls ?? 0) + 1,
        ...(opts.now !== undefined ? { activeToolStartedAt: opts.now } : {}),
      };
    }

    case 'tool_result': {
      const blocks = state.blocks.map((b) => {
        if (b.kind !== 'tool' || b.tool.id !== evt.id) return b;
        return {
          ...b,
          tool: {
            ...b.tool,
            status: evt.isError ? ('error' as const) : ('done' as const),
            output: evt.output,
          },
        };
      });
      return { ...state, blocks, activeToolStartedAt: undefined };
    }

    case 'error': {
      const terminal =
        evt.terminationReason === 'interrupted'
          ? 'interrupted'
          : evt.terminationReason === 'timeout'
            ? 'idle_timeout'
            : 'error';
      return {
        ...state,
        terminal,
        errorMsg: terminal === 'error' ? evt.message : state.errorMsg,
        footer: null,
        activeToolStartedAt: undefined,
      };
    }

    case 'done': {
      const terminal =
        evt.terminationReason === 'interrupted'
          ? 'interrupted'
          : evt.terminationReason === 'timeout'
            ? 'idle_timeout'
            : 'done';
      return {
        ...state,
        blocks: closeStreamingText(state.blocks),
        reasoning: { ...state.reasoning, active: false },
        terminal,
        footer: null,
        activeToolStartedAt: undefined,
      };
    }

    default:
      return state;
  }
}

export function markInterrupted(state: RunState): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'interrupted',
    footer: null,
    activeToolStartedAt: undefined,
  };
}

export function markIdleTimeout(state: RunState, minutes: number): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'idle_timeout',
    footer: null,
    idleTimeoutMinutes: minutes,
    activeToolStartedAt: undefined,
  };
}

export function finalizeIfRunning(state: RunState): RunState {
  if (state.terminal !== 'running') return state;
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'done',
    footer: null,
    activeToolStartedAt: undefined,
  };
}
