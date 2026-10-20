import type { AccessMode } from '../../config/permissions';

export interface BuildPiArgsInput {
  /**
   * Effective access mode for this run. pi has no OS-level sandbox, so
   * `read-only` is enforced by restricting the built-in tool allowlist;
   * `workspace` and `full` behave the same (pi always runs with the tools it
   * was configured with, exactly like Claude Code's bypassPermissions default).
   */
  access: AccessMode;
  /** Append the bridge system prompt from this file (pi reads the file contents). */
  systemPromptFile: string;
  sessionId?: string;
  model?: string;
  /** Attachment paths forwarded as `@file` message arguments. */
  images?: readonly string[];
  /**
   * Trust project-local resources (AGENTS.md, extensions). Default true: the
   * bridge always runs inside the user's own workspace.
   */
  approveProjectFiles?: boolean;
}

/**
 * Built-in pi tools that cannot modify the workspace. Used for `read-only`
 * runs; the names match the built-ins pi ships (read/write/edit/bash/grep/find/ls).
 */
const READ_ONLY_TOOLS = 'read,grep,find,ls';

export function buildPiArgs(input: BuildPiArgsInput): string[] {
  const args = [
    '--mode',
    'json',
    '--print',
    '--append-system-prompt',
    input.systemPromptFile,
  ];

  if (input.sessionId) args.push('--session-id', input.sessionId);
  if (input.model) args.push('--model', input.model);
  if (input.access === 'read-only') args.push('--tools', READ_ONLY_TOOLS);
  if (input.approveProjectFiles !== false) args.push('--approve');

  // `@path` arguments are merged with the piped stdin prompt into pi's initial
  // user message, so attachments ride along without touching the prompt text.
  for (const path of input.images ?? []) {
    args.push(`@${path}`);
  }

  return args;
}
