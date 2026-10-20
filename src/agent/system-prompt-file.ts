import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SystemPromptFile {
  path: string;
  cleanup: () => void;
}

/**
 * Persist the bridge system prompt to a throwaway temp file so agent CLIs can
 * append it from a path instead of argv — argv mangles `<bridge_context>` XML
 * on Windows (`cmd.exe` redirects `<`/`>`) and on any shell that word-splits.
 * Returns the path plus an idempotent, best-effort cleanup.
 */
export function writeSystemPromptFile(content: string, prefix = 'lark-agent-'): SystemPromptFile {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, 'append-system-prompt.md');
  writeFileSync(path, content, 'utf8');
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort: the OS will reclaim the temp dir eventually
      }
    },
  };
}
