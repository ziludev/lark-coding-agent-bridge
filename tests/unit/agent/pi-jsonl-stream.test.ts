import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createJsonlRecordReader } from '../../../src/agent/pi/jsonl-stream.js';

const collect = async (stream: Readable, limit?: number): Promise<unknown[]> => {
  const reader = createJsonlRecordReader(stream);
  const out: unknown[] = [];
  for await (const record of reader.records()) {
    out.push(record);
    if (limit !== undefined && out.length >= limit) break;
  }
  return out;
};

describe('pi JSONL record reader', () => {
  it('splits on LF and keeps U+2028 inside a JSON string', async () => {
    const stream = Readable.from([
      '{"type":"a","text":"中文\u2028换段"}\n',
      '{"type":"b"}\r\n',
    ]);

    expect(await collect(stream)).toEqual([
      { type: 'a', text: '中文\u2028换段' },
      { type: 'b' },
    ]);
  });

  it('reassembles a record split across chunk boundaries', async () => {
    const stream = Readable.from(['{"type":"sp', 'lit"}\n{"ty', 'pe":"next"}\n']);

    expect(await collect(stream)).toEqual([{ type: 'split' }, { type: 'next' }]);
  });

  it('skips unparsable lines instead of ending the stream', async () => {
    const stream = Readable.from(['not json\n{"type":"ok"}\n']);

    expect(await collect(stream)).toEqual([{ type: 'ok' }]);
  });

  it('keeps draining after the consumer stops early', async () => {
    // Mirrors the bridge: it stops iterating on a terminal event, but pi keeps
    // writing its shutdown records. Destroying the pipe here would kill pi with
    // an unhandled EPIPE, so the reader must stay attached.
    const stream = new Readable({ read() {} });
    const reader = createJsonlRecordReader(stream);
    const iterator = reader.records();

    stream.push('{"type":"first"}\n');
    expect(await iterator.next()).toEqual({ value: { type: 'first' }, done: false });
    await iterator.return(undefined);

    stream.push('{"type":"late-1"}\n{"type":"late-2"}\n');

    expect(stream.destroyed).toBe(false);
    expect(stream.readableFlowing).toBe(true);

    // Later records are dropped rather than buffered forever.
    let drained = 0;
    stream.on('data', () => {
      drained++;
    });
    stream.push('{"type":"late-3"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toBe(1);
    stream.push(null);
  });
});
