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
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return { ...actual, createLarkChannel: sdkMock.createLarkChannel };
});

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: {
      v6: { application: { get: ReturnType<typeof vi.fn> } };
    };
    im: {
      v1: {
        message: { get: ReturnType<typeof vi.fn> };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<unknown>;
  cardUpdates: Array<{ messageId: string; card: Record<string, unknown> }>;
  reactions: Array<{ action: 'add' | 'remove'; messageId: string; emojiType?: string; reactionId?: string }>;
  updateCard(messageId: string, card: object): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/**
 * Emits the given events, waiting `holdMs` (fake clock) before the terminal
 * event so a run can be made to look long without slowing the test down.
 */
class DelayedAdapter implements AgentAdapter {
  readonly id = 'fake';
  readonly displayName = 'Fake';
  constructor(
    private readonly holdMs: number,
    private readonly events: readonly AgentEvent[],
  ) {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  run(opts: AgentRunOptions): AgentRun {
    const { holdMs, events } = this;
    async function* iterate(): AsyncGenerator<AgentEvent> {
      for (const event of events) {
        if (event.type === 'done' || event.type === 'error') {
          await new Promise((resolve) => setTimeout(resolve, holdMs));
        }
        yield event;
      }
    }
    return {
      runId: opts.runId,
      events: iterate(),
      async stop() {},
      async waitForExit(): Promise<boolean> {
        return true;
      },
    };
  }
}

describe('completion reaction after an in-place reply', () => {
  it('marks a long streamed markdown reply with DONE instead of posting a message', async () => {
    vi.useFakeTimers();
    const h = await createHarness({
      messageReply: 'markdown',
      holdMs: 31_000,
      events: [
        { type: 'text', delta: 'ANSWER_HEAD_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
    });
    await startTestBridge(h);

    void h.channel.handlers.message?.(message('om_long_md', 'run'));
    await flushTimers(40_000);

    // The streamed message was patched in place, so nothing is sent...
    expect(h.channel.cardUpdates).toHaveLength(1);
    expect(h.channel.sent).toHaveLength(0);
    // ...and the run is marked on the triggering message, where the typing cue was.
    expect(h.channel.reactions.filter((r) => r.action === 'add')).toEqual([
      { action: 'add', messageId: 'om_long_md', emojiType: 'Typing' },
      { action: 'add', messageId: 'om_long_md', emojiType: 'DONE' },
    ]);
    // The typing cue is still cleaned up, leaving only DONE on the message.
    expect(h.channel.reactions.filter((r) => r.action === 'remove')).toHaveLength(1);
  });

  it('marks card mode the same way', async () => {
    vi.useFakeTimers();
    const h = await createHarness({
      messageReply: 'card',
      holdMs: 31_000,
      events: [
        { type: 'text', delta: 'CARD_ANSWER_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
    });
    await startTestBridge(h);

    void h.channel.handlers.message?.(message('om_long_card', 'run'));
    await flushTimers(40_000);

    expect(h.channel.cardUpdates).toHaveLength(1);
    expect(h.channel.sent).toHaveLength(0);
    expect(h.channel.reactions).toEqual([
      { action: 'add', messageId: 'om_long_card', emojiType: 'DONE' },
    ]);
  });

  it('marks a short run too, since the cue is not time-based', async () => {
    vi.useFakeTimers();
    const h = await createHarness({
      messageReply: 'markdown',
      holdMs: 1_000,
      events: [
        { type: 'text', delta: 'QUICK_ANSWER' },
        { type: 'done', terminationReason: 'normal' },
      ],
    });
    await startTestBridge(h);

    void h.channel.handlers.message?.(message('om_short', 'run'));
    await flushTimers(10_000);

    expect(h.channel.sent).toHaveLength(0);
    expect(h.channel.reactions.map((r) => r.emojiType).filter(Boolean)).toEqual(['Typing', 'DONE']);
  });

  it('marks a run that ended without an answer as failed', async () => {
    vi.useFakeTimers();
    const h = await createHarness({
      messageReply: 'markdown',
      holdMs: 31_000,
      events: [
        { type: 'text', delta: 'PARTIAL' },
        { type: 'error', message: 'boom', terminationReason: 'failed' },
      ],
    });
    await startTestBridge(h);

    void h.channel.handlers.message?.(message('om_failed', 'run'));
    await flushTimers(40_000);

    expect(h.channel.sent).toHaveLength(0);
    const added = h.channel.reactions.filter((r) => r.action === 'add').map((r) => r.emojiType);
    expect(added).toContain('ERROR');
    expect(added).not.toContain('DONE');
  });
});

interface Harness {
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: DelayedAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
}

async function createHarness(options: {
  messageReply: 'card' | 'markdown' | 'text';
  holdMs: number;
  events: readonly AgentEvent[];
}): Promise<Harness> {
  const tmp = await createTmpProfile('completion-notice-');
  const workspace = await realpath(tmp.workspace);
  const base = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'] },
    preferences: { messageReply: options.messageReply },
  });
  const profileConfig = { ...base, workspaces: { ...base.workspaces, default: workspace } };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new DelayedAdapter(options.holdMs, options.events);
  const channel = createFakeLarkChannel();
  sdkMock.channel = channel;
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { tmp, channel, agent, sessions, workspaces, profileConfig };
}

async function startTestBridge(h: Harness): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: {
      profile: 'test',
      profileConfig: h.profileConfig,
      ownerRefreshState: 'unknown' as const,
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: '/tmp/config.json',
      cfg: h.profileConfig,
      processId: 'proc_test',
    } as never,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
  const cardUpdates: FakeLarkChannel['cardUpdates'] = [];
  const reactions: FakeLarkChannel['reactions'] = [];
  const channel: FakeLarkChannel = {
    handlers,
    sent,
    reactions,
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
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(next) {
      Object.assign(handlers, next);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId, content, options) {
      sent.push({ chatId, content, options });
      return { messageId: `sent_${sent.length}` };
    },
    async stream(_chatId, input) {
      const producer = (
        input as {
          card?: { producer?: (ctrl: { update(next: unknown): Promise<void> }) => Promise<void> };
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }
      );
      if (producer.markdown) {
        await producer.markdown({ setContent: vi.fn(async () => {}) });
      } else if (producer.card?.producer) {
        await producer.card.producer({ update: vi.fn(async () => {}) });
      }
      return { messageId: 'om_streamed' };
    },
    cardUpdates,
    async updateCard(messageId, card) {
      cardUpdates.push({ messageId, card: card as Record<string, unknown> });
    },
    async addReaction(messageId, emojiType) {
      reactions.push({ action: 'add', messageId, emojiType });
      return `reaction_${reactions.length}`;
    },
    async removeReaction(messageId, reactionId) {
      reactions.push({ action: 'remove', messageId, reactionId });
    },
  };
  return channel;
}

/**
 * Advance the fake clock in small steps: the bridge schedules its debounce/ticker
 * timers from inside promise chains, so a single big jump can return before the
 * first of them exists.
 */
async function flushTimers(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 50) {
    await vi.advanceTimersByTimeAsync(50);
  }
}

function message(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function lastMarkdown(channel: FakeLarkChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: string } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content?.markdown ?? '';
}
