import { log } from '../../core/logger';
import type { AgentEvent } from '../types';

export type PiTerminationReason = 'normal' | 'interrupted' | 'failed';

/**
 * Session-scoped records pi emits that the bridge card has no slot for. They
 * are expected traffic, so they must not be counted as protocol drift (which
 * would spam the log for every compaction / queue change).
 */
const IGNORED_EVENT_TYPES = new Set([
  'agent_start',
  'agent_end',
  'turn_start',
  'turn_end',
  'tool_execution_update',
  'compaction_start',
  'compaction_end',
  'queue_update',
  'entry_appended',
  'session_info_changed',
  'thinking_level_changed',
]);

export interface PiProtocolDriftState {
  unknownEvents: number;
  anomalies: number;
}

/**
 * Translates pi's `--mode json` event stream (see docs/json.md in the pi
 * package) into the bridge's agent event contract.
 *
 * Two behaviours matter here:
 *  - `role: "system"` messages are dropped, not forwarded. Pi emits the whole
 *    rendered system prompt (sections, project context, docs) in
 *    `message_start`/`message_end`, which would both flood the Feishu card and
 *    leak the operator's local AGENTS.md into the chat.
 *  - A failed assistant turn is reported by the provider stream, but pi may
 *    retry it, so the error is only surfaced when the process settles.
 */
export class PiJsonlTranslator {
  private sessionId: string | undefined;
  private terminal = false;
  private lastStreamError: string | undefined;
  private lastAbortedTurn = false;
  private drift: PiProtocolDriftState = { unknownEvents: 0, anomalies: 0 };

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal) return [];
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      this.drift.anomalies++;
      return [];
    }

    switch (raw.type) {
      case 'session':
        return this.translateSession(raw);
      case 'message_start':
        // Only the authoritative `message_end` payload is used; the start
        // payload repeats the (huge) system message.
        return [];
      case 'message_end':
        return this.translateMessageEnd(raw);
      case 'message_update':
        return this.translateMessageUpdate(raw);
      case 'tool_execution_start':
        return this.translateToolStart(raw);
      case 'tool_execution_end':
        return this.translateToolEnd(raw);
      case 'agent_settled':
        return this.finish(raw.aborted === true ? 'interrupted' : 'normal');
      default:
        if (IGNORED_EVENT_TYPES.has(raw.type)) return [];
        this.drift.unknownEvents++;
        log.warn('jsonl', 'unknown_event', { eventType: raw.type });
        return [];
    }
  }

  /** Emit the terminal event for a stream that ended without `agent_settled`. */
  finish(reason: PiTerminationReason = 'normal'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (reason === 'failed') {
      const detail = this.lastStreamError ? `: ${this.lastStreamError}` : '';
      return [
        {
          type: 'error',
          message: truncate(`pi stream ended before a terminal event${detail}`, 4096),
          terminationReason: 'failed',
        },
      ];
    }
    return [{ type: 'done', sessionId: this.sessionId, terminationReason: reason }];
  }

  fail(message: string): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    return [{ type: 'error', message: truncate(message, 4096), terminationReason: 'failed' }];
  }

  /** `true` when an assistant turn ended aborted/errored; used by the adapter's exit path. */
  sawAbortedTurn(): boolean {
    return this.lastAbortedTurn;
  }

  protocolDrift(): PiProtocolDriftState {
    return { ...this.drift };
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  private translateSession(raw: Record<string, unknown>): AgentEvent[] {
    const sessionId = stringValue(raw.id);
    if (!sessionId) {
      this.drift.anomalies++;
      return [];
    }
    this.sessionId = sessionId;
    return [{ type: 'system', sessionId }];
  }

  private translateMessageEnd(raw: Record<string, unknown>): AgentEvent[] {
    const message = recordValue(raw.message);
    if (!message) {
      this.drift.anomalies++;
      return [];
    }
    // Never forward system/user messages: the system one embeds the full local
    // prompt context, the user one is the bridge's own prompt echoed back.
    if (message.role !== 'assistant') return [];

    const events: AgentEvent[] = [];
    const stopReason = stringValue(message.stopReason);
    if (stopReason === 'aborted' || stopReason === 'error') {
      this.lastAbortedTurn = true;
    } else {
      this.lastAbortedTurn = false;
    }

    const text = textOf(message.content);
    if (text) events.push({ type: 'final_text', content: text });

    const usage = recordValue(message.usage);
    if (usage) {
      const cost = recordValue(usage.cost);
      events.push({
        type: 'usage',
        inputTokens: numberValue(usage.input),
        outputTokens: numberValue(usage.output),
        cachedInputTokens: numberValue(usage.cacheRead),
        reasoningOutputTokens: numberValue(usage.reasoning),
        costUsd: numberValue(cost?.total),
      });
    }
    return events;
  }

  private translateMessageUpdate(raw: Record<string, unknown>): AgentEvent[] {
    const inner = recordValue(raw.assistantMessageEvent);
    if (!inner || typeof inner.type !== 'string') {
      this.drift.anomalies++;
      return [];
    }
    switch (inner.type) {
      case 'text_delta': {
        const delta = stringValue(inner.delta);
        return delta ? [{ type: 'text', delta }] : [];
      }
      case 'thinking_delta': {
        const delta = stringValue(inner.delta);
        return delta ? [{ type: 'thinking', delta }] : [];
      }
      case 'error': {
        const detail =
          stringValue(inner.error) ?? stringValue(inner.reason) ?? 'provider stream error';
        // Non-terminal: pi retries on its own, so keep it for the exit path.
        this.lastStreamError = detail;
        log.warn('jsonl', 'stream_error', { detail: truncate(detail, 500) });
        return [];
      }
      default:
        // start / text_start / text_end / thinking_start / thinking_end /
        // toolcall_* carry no data the bridge renders incrementally.
        return [];
    }
  }

  private translateToolStart(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.toolCallId);
    const name = stringValue(raw.toolName);
    if (!id || !name) {
      this.drift.anomalies++;
      return [];
    }
    return [{ type: 'tool_use', id, name, input: raw.args ?? {} }];
  }

  private translateToolEnd(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.toolCallId);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    return [
      {
        type: 'tool_result',
        id,
        output: textOf(recordValue(raw.result)?.content),
        isError: raw.isError === true,
      },
    ];
  }
}

/** Concatenate the text blocks of a pi content payload (string or block array). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text') {
      const text = stringValue(block.text);
      if (text) parts.push(text);
    } else if (block.type === 'image') {
      parts.push('[image]');
    }
  }
  return parts.join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
