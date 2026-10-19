import { describe, it, expect, vi, afterEach } from 'vitest';
import { readBody, timeLeft } from './safeFetch';

/* Test bodies. Every producer is bounded (at most `maxChunks` chunks, then it closes) and
   stops on cancel: its pending timer is cleared and nothing is enqueued after cancel or close.
   So even a readBody that never stops reading cannot make a spec grow memory or leak timers. */
const MAX_TEST_CHUNKS = 64;

function streamOf(
  chunks: Uint8Array[],
  { repeat = false, stall = false, delayMs = 0, maxChunks = MAX_TEST_CHUNKS } = {},
) {
  let sent = 0;
  let closed = false;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const next = (): Uint8Array | null => {
    if (sent >= maxChunks) return null;
    const chunk = repeat ? chunks[0] : chunks[sent];
    if (!chunk) return null;
    sent++;
    return chunk;
  };
  const emit = (c: ReadableStreamDefaultController<Uint8Array>) => {
    if (closed) return;
    const chunk = next();
    if (chunk) return c.enqueue(chunk);
    closed = true;
    c.close();
  };
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (closed) return;
      if (stall) return new Promise<void>(() => {});
      if (delayMs === 0) return emit(c);
      return new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timer = undefined;
          emit(c);
          resolve();
        }, delayMs);
      });
    },
    cancel() {
      closed = true;
      cancelled = true;
      clearTimeout(timer);
      timer = undefined;
    },
  });
  return { res: new Response(body), wasCancelled: () => cancelled, chunksSent: () => sent };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('readBody', () => {
  it('reads a normal body, decoding characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('héllo wörld');
    const { res } = streamOf([bytes.slice(0, 2), bytes.slice(2, 9), bytes.slice(9)]);
    expect(await readBody(res, { timeoutMs: 1000 })).toBe('héllo wörld');
  });

  it('stops at the size cap and cancels the rest of the body', async () => {
    // 64 KiB available, cap at 10 000 bytes.
    const { res, wasCancelled, chunksSent } = streamOf([new Uint8Array(1024).fill(97)], { repeat: true });
    const text = await readBody(res, { timeoutMs: 1000, maxBytes: 10_000 });
    expect(text.length).toBe(10_000);
    expect(wasCancelled()).toBe(true);
    expect(chunksSent()).toBeLessThanOrEqual(10);
  });

  it('gives up on a body that stops sending', async () => {
    const { res, wasCancelled } = streamOf([], { stall: true });
    await expect(readBody(res, { timeoutMs: 50 })).rejects.toThrow(/timed out/i);
    expect(wasCancelled()).toBe(true);
  });

  it('limits the whole read, not each chunk: a slow drip still times out', async () => {
    // A byte every 10ms for up to 64 chunks (640ms); the read is allowed 80ms in total.
    const { res, wasCancelled, chunksSent } = streamOf([new Uint8Array([97])], {
      repeat: true,
      delayMs: 10,
    });
    await expect(readBody(res, { timeoutMs: 80 })).rejects.toThrow(/timed out/i);
    expect(wasCancelled()).toBe(true);
    expect(chunksSent()).toBeLessThan(MAX_TEST_CHUNKS);
  });

  it('returns an empty string for a response with no body', async () => {
    expect(await readBody(new Response(null), { timeoutMs: 50 })).toBe('');
  });
});

describe('timeLeft', () => {
  it('gives the body only what the headers left of the budget, never zero', () => {
    vi.useFakeTimers();
    const started = Date.now();
    vi.advanceTimersByTime(3000);
    expect(timeLeft(started, 10_000)).toBe(7000);
    vi.advanceTimersByTime(20_000);
    expect(timeLeft(started, 10_000)).toBe(1);
  });
});
