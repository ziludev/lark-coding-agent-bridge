import { describe, expect, it } from 'vitest';
import { buildPiArgs } from '../../../src/agent/pi/argv.js';

const PROMPT_FILE = '/tmp/lark-pi-x/append-system-prompt.md';

describe('Pi argv contract', () => {
  it('streams JSON in print mode and keeps the prompt out of argv', () => {
    expect(buildPiArgs({ access: 'full', systemPromptFile: PROMPT_FILE })).toEqual([
      '--mode',
      'json',
      '--print',
      '--append-system-prompt',
      PROMPT_FILE,
      '--approve',
    ]);
  });

  it('resumes with a native session id and forwards the model pin', () => {
    const args = buildPiArgs({
      access: 'workspace',
      systemPromptFile: PROMPT_FILE,
      sessionId: 'sess-1',
      model: 'deepseek/deepseek-flash',
    });

    expect(args).toContain('--session-id');
    expect(args.slice(args.indexOf('--session-id'), args.indexOf('--session-id') + 2)).toEqual([
      '--session-id',
      'sess-1',
    ]);
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual([
      '--model',
      'deepseek/deepseek-flash',
    ]);
  });

  it('enforces read-only by restricting the built-in tool allowlist', () => {
    const args = buildPiArgs({ access: 'read-only', systemPromptFile: PROMPT_FILE });
    const tools = args.indexOf('--tools');

    expect(tools).toBeGreaterThan(-1);
    expect(args[tools + 1]).toBe('read,grep,find,ls');
  });

  it('does not restrict tools for workspace or full access', () => {
    for (const access of ['workspace', 'full'] as const) {
      expect(buildPiArgs({ access, systemPromptFile: PROMPT_FILE })).not.toContain('--tools');
    }
  });

  it('passes attachments as @file arguments merged into the piped prompt', () => {
    const args = buildPiArgs({
      access: 'full',
      systemPromptFile: PROMPT_FILE,
      images: ['/tmp/a.png', '/tmp/b.jpg'],
    });

    expect(args.slice(-2)).toEqual(['@/tmp/a.png', '@/tmp/b.jpg']);
  });
});
