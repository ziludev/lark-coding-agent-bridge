import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as unknown,
  createLarkChannel: vi.fn(() => sdkMock.channel),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return { ...actual, createLarkChannel: sdkMock.createLarkChannel };
});

import { startChannel } from '../../../src/bot/channel.js';

/**
 * Emits a tool_use, stays silent for `holdMs` (a long one-shot tool), then
 * finishes. The silence is what used to freeze the card: no events means no
 * flush, so the run looked hung until the tool returned.
 */
class SlowToolAdapter implements AgentAdapter {
  readonly id = 'fake';
  readonly displayName = 'Fake';
  constructor(private readonly holdMs: number) {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  run(opts: AgentRunOptions): AgentRun {
    const holdMs = this.holdMs;
    async function* events(): AsyncGenerator<AgentEvent> {
      yield { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 8' } };
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      yield { type: 'tool_result', id: 't1', output: 'done', isError: false };
      yield { type: 'text', delta: 'all done' };
      yield { type: 'done', terminationReason: 'normal' };
    }
    return {
      runId: opts.runId,
      events: events(),
      async stop() {},
      async waitForExit(): Promise<boolean> {
        return true;
      },
    };
  }
}

interface RecordedCard {
  at: number;
  json: string;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('long tool progress', () => {
  it('keeps re-rendering the card while a tool is silent', async () => {
    const updates: RecordedCard[] = [];
    const channel = {
      handlers: {} as Record<string, unknown>,
      botIdentity: { openId: 'ou_bot', name: 'Bridge' },
      rawClient: {
        request: vi.fn(async () => ({ data: { items: [] } })),
        application: {
          v6: {
            application: {
              get: vi.fn(async () => ({ data: { app: { owner: { owner_id: 'ou_owner' } } } })),
            },
          },
        },
        im: {
          v1: {
            message: { get: vi.fn(async () => ({ data: { items: [] } })) },
            messageReaction: {
              create: vi.fn(async () => ({ data: { reaction_id: 'r1' } })),
              delete: vi.fn(async () => ({})),
            },
          },
        },
      },
      on(next: Record<string, unknown>) {
        Object.assign(this.handlers, next);
      },
      async connect() {},
      async disconnect() {},
      async getChatMode() {
        return 'group';
      },
      getConnectionStatus() {
        return { state: 'connected', reconnectAttempts: 0 };
      },
      async send() {
        return { messageId: 'm1' };
      },
      async stream(_chatId: string, input: unknown) {
        const producer = (input as { card?: { producer?: (ctrl: { update(v: unknown): Promise<void> }) => Promise<void> } })
          .card?.producer;
        await producer?.({
          update: async (v: unknown) => {
            updates.push({ at: Date.now(), json: JSON.stringify(v) });
          },
        });
      },
      async addReaction() {
        return 'r1';
      },
      async removeReaction() {},
    };
    sdkMock.channel = channel;

    const tmp = await createTmpProfile('ticker-');
    const workspace = await realpath(tmp.workspace);
    const base = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
      access: { allowedUsers: ['ou_user'] },
      preferences: { messageReply: 'card' },
    });
    const profileConfig = { ...base, workspaces: { ...base.workspaces, default: workspace } };
    const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
    const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
    cleanups.push(async () => {
      await Promise.all([sessions.flush(), workspaces.flush()]);
      await tmp.cleanup();
    });

    const bridge = await startChannel({
      cfg: profileConfig,
      agent: new SlowToolAdapter(6_000),
      sessions,
      workspaces,
      controls: {
        profile: 'test',
        profileConfig,
        ownerRefreshState: 'unknown',
        async refreshOwner() {},
        async restart() {},
        async exit() {},
        configPath: '/tmp/config.json',
        cfg: profileConfig,
        processId: 'proc_test',
      } as never,
    });
    cleanups.push(() => bridge.disconnect());

    const started = Date.now();
    await (channel.handlers as { message?: (m: NormalizedMessage) => Promise<void> }).message?.(
      {
        messageId: 'om_1',
        chatId: 'oc_dm',
        chatType: 'p2p',
        senderId: 'ou_user',
        senderName: 'User',
        content: 'run a long tool',
        rawContentType: 'text',
        resources: [],
        mentionedBot: false,
        createTime: 1760000001000,
      } as unknown as NormalizedMessage,
    );

    // Wait for the run to finish (tool held 8s, ticker fires at 5s).
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (updates.some((u) => u.json.includes('all done'))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // One event-driven render for tool_use, then at least one ticker render
    // while the tool stayed silent — that is the whole point of the change.
    const toolFooters = updates
      .map((u) => /正在调用工具[^"]*/.exec(u.json)?.[0])
      .filter((f): f is string => Boolean(f));
    expect(toolFooters.length).toBeGreaterThanOrEqual(2);
    expect(updates.some((u) => /已 \d+s/.test(u.json))).toBe(true);
    expect(updates.some((u) => u.json.includes('all done'))).toBe(true);
    // The ticker must not outlive the run: the last frame is terminal.
    expect(updates.at(-1)?.json).toContain('已完成');
  }, 60_000);
});
