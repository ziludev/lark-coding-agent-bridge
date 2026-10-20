import type { AccessMode } from '../config/permissions';
import type { ProfileConfig } from '../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from './bridge-system-prompt';

export type AgentCapabilityId = 'claude' | 'codex' | 'pi';
export type AgentSessionKind = 'claude-session' | 'codex-thread' | 'pi-session';
export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix';

export interface AgentCapability {
  agentId: AgentCapabilityId;
  sessionKind: AgentSessionKind;
  promptInjection: PromptInjectionMode;
  systemPrompt: string;
  supportsNativeHistory: boolean;
  callback: {
    marker: '__bridge_cb';
    legacyMarkers: string[];
  };
  permissions: {
    maxAccess: AccessMode;
  };
}

export function claudeCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'claude',
    sessionKind: 'claude-session',
    promptInjection: 'append-system-prompt',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: ['__claude_cb'],
    },
    permissions: {
      maxAccess,
    },
  };
}

export function codexCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile.permissions.maxAccess;
  return {
    agentId: 'codex',
    sessionKind: 'codex-thread',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}

/**
 * Pi resumes through its own native session id (`--session-id`), like Claude
 * Code — so it is a first-class `sessionId` agent, not a `threadId` one.
 */
export function piCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  return {
    agentId: 'pi',
    sessionKind: 'pi-session',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess: profile.permissions.maxAccess,
    },
  };
}

/** Capability for whichever agent a profile is configured to run. */
export function agentCapability(profile: ProfileConfig): AgentCapability {
  switch (profile.agentKind) {
    case 'codex':
      return codexCapability(profile);
    case 'pi':
      return piCapability(profile);
    case 'claude':
      return claudeCapability(profile);
  }
}

/**
 * True when resuming means "hand the agent its own session id" (claude, pi)
 * rather than a Codex thread id. Shared bot/card code branches on this instead
 * of naming a specific agent.
 */
export function usesNativeSessionId(capability: AgentCapability): boolean {
  return capability.sessionKind !== 'codex-thread';
}
