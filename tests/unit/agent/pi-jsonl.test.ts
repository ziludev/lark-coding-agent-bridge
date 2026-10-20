import { describe, expect, it } from 'vitest';
import { PiJsonlTranslator } from '../../../src/agent/pi/jsonl.js';

describe('Pi JSONL translator', () => {
  it('translates the session header, streamed text, tools, usage and settlement', () => {
    const t = new PiJsonlTranslator();

    expect(
      t.translate({ type: 'session', version: 3, id: 'sess-1', cwd: '/repo' }),
    ).toEqual([{ type: 'system', sessionId: 'sess-1' }]);

    expect(t.translate({ type: 'agent_start' })).toEqual([]);
    expect(t.translate({ type: 'turn_start' })).toEqual([]);

    expect(
      t.translate({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hel' },
      }),
    ).toEqual([{ type: 'text', delta: 'Hel' }]);

    expect(
      t.translate({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_delta',
          contentIndex: 0,
          delta: 'thinking',
        },
      }),
    ).toEqual([{ type: 'thinking', delta: 'thinking' }]);

    expect(
      t.translate({
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'bash',
        args: { command: 'ls' },
      }),
    ).toEqual([{ type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'ls' } }]);

    expect(
      t.translate({
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'a\nb' }], details: {} },
        isError: false,
      }),
    ).toEqual([{ type: 'tool_result', id: 'call-1', output: 'a\nb', isError: false }]);

    expect(
      t.translate({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
          stopReason: 'stop',
          usage: {
            input: 10,
            output: 2,
            cacheRead: 3,
            reasoning: 1,
            totalTokens: 16,
            cost: { total: 0.5 },
          },
        },
      }),
    ).toEqual([
      { type: 'final_text', content: 'Hello' },
      {
        type: 'usage',
        inputTokens: 10,
        outputTokens: 2,
        cachedInputTokens: 3,
        reasoningOutputTokens: 1,
        costUsd: 0.5,
      },
    ]);

    expect(t.translate({ type: 'agent_settled', aborted: false })).toEqual([
      { type: 'done', sessionId: 'sess-1', terminationReason: 'normal' },
    ]);

    expect(t.protocolDrift()).toEqual({ unknownEvents: 0, anomalies: 0 });
  });

  it('never forwards the system message that carries the local prompt context', () => {
    const t = new PiJsonlTranslator();
    const huge = {
      role: 'system',
      content: '',
      sections: { project_context: '<project_context>secret AGENTS.md</project_context>' },
    };

    expect(t.translate({ type: 'message_start', message: huge })).toEqual([]);
    expect(t.translate({ type: 'message_end', message: huge })).toEqual([]);
  });

  it('never forwards the echoed user prompt', () => {
    const t = new PiJsonlTranslator();
    expect(
      t.translate({
        type: 'message_end',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      }),
    ).toEqual([]);
  });

  it('marks an aborted settlement as interrupted', () => {
    const t = new PiJsonlTranslator();
    expect(t.translate({ type: 'session', id: 's' })).toEqual([{ type: 'system', sessionId: 's' }]);
    expect(t.translate({ type: 'agent_settled', aborted: true })).toEqual([
      { type: 'done', sessionId: 's', terminationReason: 'interrupted' },
    ]);
    expect(t.terminalEmitted()).toBe(true);
    expect(t.translate({ type: 'agent_settled', aborted: true })).toEqual([]);
  });

  it('ignores expected session-scoped records without counting drift', () => {
    const t = new PiJsonlTranslator();
    for (const type of [
      'agent_end',
      'turn_end',
      'tool_execution_update',
      'compaction_start',
      'compaction_end',
      'queue_update',
      'entry_appended',
      'session_info_changed',
      'thinking_level_changed',
    ]) {
      expect(t.translate({ type })).toEqual([]);
    }
    expect(t.protocolDrift()).toEqual({ unknownEvents: 0, anomalies: 0 });
  });

  it('holds provider stream errors until the process settles', () => {
    const t = new PiJsonlTranslator();
    expect(
      t.translate({
        type: 'message_update',
        assistantMessageEvent: { type: 'error', reason: 'overloaded', error: 'overloaded' },
      }),
    ).toEqual([]);
    expect(t.terminalEmitted()).toBe(false);
    expect(t.finish('failed')).toEqual([
      {
        type: 'error',
        message: 'pi stream ended before a terminal event: overloaded',
        terminationReason: 'failed',
      },
    ]);
  });

  it('treats an aborted assistant turn as an interrupted run', () => {
    const t = new PiJsonlTranslator();
    t.translate({
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'aborted' },
    });
    expect(t.sawAbortedTurn()).toBe(true);
  });

  it('fails on a stream that ends without a settlement', () => {
    const t = new PiJsonlTranslator();
    expect(t.finish()).toEqual([
      { type: 'done', sessionId: undefined, terminationReason: 'normal' },
    ]);
  });

  it('counts unknown records as drift and keeps going', () => {
    const t = new PiJsonlTranslator();
    expect(t.translate({ type: 'brand.new.event' })).toEqual([]);
    expect(t.translate('not an object')).toEqual([]);
    expect(t.protocolDrift()).toEqual({ unknownEvents: 1, anomalies: 1 });
  });
});
