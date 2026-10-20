import type { Readable } from 'node:stream';
import { log } from '../../core/logger';

export interface JsonlRecordReader {
  records(): AsyncGenerator<unknown>;
}

/**
 * Read pi's `--mode json` stdout as JSONL records.
 *
 * Two constraints shape this:
 *  - Split on LF only. `node:readline` also splits on U+2028/U+2029, which are
 *    legal inside JSON strings, so a CJK answer would be cut mid-record.
 *  - Never stop draining. The bridge stops consuming events as soon as it sees
 *    a terminal state, and releasing an async iterator destroys the underlying
 *    stream — pi then dies mid-write with an unhandled EPIPE stack trace on
 *    every successful run. A `data` listener keeps reading (and discarding)
 *    whatever arrives after the consumer walks away, so pi can shut down on its
 *    own; the executor still reaps it with `waitForExit` + `stop()`.
 */
export function createJsonlRecordReader(stream: Readable): JsonlRecordReader {
  const decoder = new TextDecoder('utf-8');
  const queue: unknown[] = [];
  let buffer = '';
  let ended = false;
  let wake: (() => void) | undefined;

  const notify = (): void => {
    const pending = wake;
    wake = undefined;
    pending?.();
  };

  const push = (line: string): void => {
    const trimmed = stripCr(line);
    if (!trimmed.trim()) return;
    const record = parseRecord(trimmed);
    if (record !== undefined) queue.push(record);
  };

  stream.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      push(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
    }
    notify();
  });
  stream.on('end', () => {
    push(buffer + decoder.decode());
    buffer = '';
    ended = true;
    notify();
  });
  stream.on('error', () => {
    ended = true;
    notify();
  });

  return {
    async *records(): AsyncGenerator<unknown> {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift();
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
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
