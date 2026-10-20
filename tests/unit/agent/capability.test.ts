import { describe, expect, it } from 'vitest';
import { BRIDGE_SYSTEM_PROMPT } from '../../../src/agent/bridge-system-prompt';
import {
  agentCapability,
  claudeCapability,
  codexCapability,
  piCapability,
  usesNativeSessionId,
} from '../../../src/agent/capability';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

describe('agent capability contract', () => {
  it('defines Claude capability with legacy callback marker compatibility', () => {
    const capability = claudeCapability();

    expect(capability).toMatchObject({
      agentId: 'claude',
      sessionKind: 'claude-session',
      promptInjection: 'append-system-prompt',
      supportsNativeHistory: true,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      callback: {
        marker: '__bridge_cb',
        legacyMarkers: ['__claude_cb'],
      },
    });
  });

  it('defines Codex capability with thread sessions and stdin prompt injection', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      codex: {
        binaryPath: '/usr/local/bin/codex',
      },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
    });

    expect(codexCapability(profile)).toMatchObject({
      agentId: 'codex',
      sessionKind: 'codex-thread',
      promptInjection: 'stdin-prefix',
      supportsNativeHistory: false,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      permissions: {
        maxAccess: 'workspace',
      },
    });
  });

  it('uses Codex profile max access as the static capability ceiling', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      codex: {
        binaryPath: '/usr/local/bin/codex',
      },
      permissions: {
        defaultAccess: 'read-only',
        maxAccess: 'read-only',
      },
    });

    expect(codexCapability(profile).permissions.maxAccess).toBe('read-only');
  });

  it('defines a Pi capability that resumes through a native session id', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'pi',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      pi: {
        binaryPath: '/usr/local/bin/pi',
        inheritAgentDir: true,
      },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
    });

    const capability = agentCapability(profile);

    expect(capability).toMatchObject({
      agentId: 'pi',
      sessionKind: 'pi-session',
      promptInjection: 'stdin-prefix',
      supportsNativeHistory: true,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      permissions: {
        maxAccess: 'workspace',
      },
    });
    expect(usesNativeSessionId(capability)).toBe(true);
    expect(usesNativeSessionId(codexCapability(profile))).toBe(false);
  });

  it('dispatches the capability from the profile agent kind', () => {
    const base = {
      accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' as const } },
    };

    expect(agentCapability(createDefaultProfileConfig({ ...base, agentKind: 'claude' })).agentId)
      .toBe('claude');
    expect(
      agentCapability(
        createDefaultProfileConfig({
          ...base,
          agentKind: 'codex',
          codex: { binaryPath: '/usr/local/bin/codex' },
        }),
      ).agentId,
    ).toBe('codex');
    expect(
      agentCapability(
        createDefaultProfileConfig({
          ...base,
          agentKind: 'pi',
          pi: { binaryPath: '/usr/local/bin/pi', inheritAgentDir: true },
        }),
      ).agentId,
    ).toBe('pi');
    expect(piCapability(createDefaultProfileConfig({ ...base, agentKind: 'claude' })).agentId).toBe(
      'pi',
    );
  });
});
