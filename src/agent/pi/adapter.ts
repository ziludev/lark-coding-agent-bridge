import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import { codexSandboxToAccess } from '../../config/permissions';
import type { SandboxMode } from '../../config/profile-schema';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import { writeSystemPromptFile } from '../system-prompt-file';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { buildPiArgs } from './argv';
import { PiJsonlTranslator, type PiTerminationReason } from './jsonl';

export interface PiAdapterOptions {
  binary: string;
  profileStateDir: string;
  /** `PI_CODING_AGENT_DIR` override; when absent the child inherits the user's `~/.pi/agent`. */
  agentDir?: string;
  inheritAgentDir?: boolean;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

type PiChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class PiAdapter implements AgentAdapter {
  readonly id = 'pi';
  readonly displayName = 'Pi';

  private readonly binary: string;
  private readonly profileStateDir: string;
  private readonly agentDir: string | undefined;
  private readonly inheritAgentDir: boolean;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: PiAdapterOptions) {
    this.binary = opts.binary;
    this.profileStateDir = opts.profileStateDir;
    this.agentDir = opts.agentDir;
    this.inheritAgentDir = opts.inheritAgentDir !== false;
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.larkChannel = opts.larkChannel;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'pi',
      agentName: this.displayName,
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'pi binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for PiAdapter.run');
    }

    const access = codexSandboxToAccess(opts.sandbox ?? defaultSandbox());
    const systemPromptFile = writeSystemPromptFile(buildBridgeSystemPrompt(this.botIdentity), 'lark-pi-');

    const args = buildPiArgs({
      access,
      systemPromptFile: systemPromptFile.path,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.images && opts.images.length > 0 ? { images: opts.images } : {}),
    });

    const envOverrides: NodeJS.ProcessEnv = buildLarkChannelEnv(this.larkChannel);
    // Isolating the agent dir also isolates sessions, extensions, skills and
    // credentials; it is opt-in because the default inherits the user's
    // ~/.pi/agent (where their provider auth lives).
    if (this.agentDir) {
      envOverrides.PI_CODING_AGENT_DIR = this.agentDir;
    } else if (!this.inheritAgentDir) {
      envOverrides.PI_CODING_AGENT_DIR = join(this.profileStateDir, 'pi-agent');
    }

    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, envOverrides),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as PiChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      images: opts.images?.length ?? 0,
      model: opts.model,
      access,
    });

    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn pi: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let stopReason: PiTerminationReason | undefined;
    child.on('error', (err) => {
      runtimeError = err;
      systemPromptFile.cleanup();
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
      systemPromptFile.cleanup();
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });
    // No bridge_context prefix here: the bridge system prompt already travelled
    // in argv (from a file), so stdin carries the user message verbatim.
    child.stdin.end(opts.prompt, 'utf8');

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError, () => stopReason),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        stopReason = 'interrupted';
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

async function* createEventStream(
  child: PiChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  getStopReason: () => PiTerminationReason | undefined,
): AsyncGenerator<AgentEvent> {
  const translator = new PiJsonlTranslator();
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn pi: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  let sawStdout = false;
  let silentExitTimer: ReturnType<typeof setTimeout> | undefined;
  const closeSilentStdout = (): void => {
    silentExitTimer = setTimeout(() => {
      if (!sawStdout && !child.stdout.readableEnded) child.stdout.destroy();
    }, 50);
  };
  child.once('exit', closeSilentStdout);
  try {
    for await (const record of readJsonlRecords(child.stdout)) {
      sawStdout = true;
      yield* translator.translate(record);
    }
  } finally {
    if (silentExitTimer) clearTimeout(silentExitTimer);
    child.removeListener('exit', closeSilentStdout);
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield* translator.fail(`pi runtime error: ${earlyRuntimeError.message}`);
    return;
  }

  const exitCode = await waitForExitCode(child);
  const stopReason = getStopReason();
  if (stopReason) {
    yield* translator.finish(stopReason);
    return;
  }

  if (translator.terminalEmitted()) return;

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield* translator.fail(`pi exited with code ${exitCode}${detail}`);
    return;
  }
  if (runtimeError) {
    yield* translator.fail(`pi runtime error: ${runtimeError.message}`);
    return;
  }

  // pi exits 0 even when a turn was aborted or the provider errored, and it
  // does not always emit `agent_settled` for those (e.g. SIGTERM mid-turn).
  yield* translator.finish(translator.sawAbortedTurn() ? 'interrupted' : 'normal');
}

/**
 * Split pi's JSONL stream on LF only. `node:readline` also splits on U+2028 and
 * U+2029, which are legal inside JSON strings, so a Chinese/CJK answer would be
 * cut mid-record; pi's docs call this out explicitly.
 */
async function* readJsonlRecords(stream: Readable): AsyncGenerator<unknown> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = stripCr(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      if (line.trim()) yield parseRecord(line);
      nl = buffer.indexOf('\n');
    }
  }
  const tail = stripCr(buffer + decoder.decode());
  if (tail.trim()) yield parseRecord(tail);
}

function parseRecord(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    log.warn('jsonl', 'unparsable_record', { chars: line.length });
    return undefined;
  }
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

async function waitForExitCode(child: PiChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

/** Runs always carry a sandbox from the policy; default to full when absent. */
function defaultSandbox(): SandboxMode {
  return 'danger-full-access';
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}
