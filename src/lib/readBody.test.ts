import { describe, it, expect } from 'vitest';
import { readBody } from './safeFetch';

function streamOf(chunks: Uint8Array[], { endless = false, stall = false } = {}) {
  let i = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stall) return new Promise(() => {});
      if (endless) return controller.enqueue(new Uint8Array(1024).fill(97));
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { res: new Response(body), wasCancelled: () => cancelled };
}

describe('readBody', () => {
  it('reads a normal body, decoding characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('héllo wörld');
    const { res } = streamOf([bytes.slice(0, 2), bytes.slice(2, 9), bytes.slice(9)]);
    expect(await readBody(res, { timeoutMs: 1000 })).toBe('héllo wörld');
  });

  it('stops at the size cap and cancels the rest of the body', async () => {
    const { res, wasCancelled } = streamOf([], { endless: true });
    const text = await readBody(res, { timeoutMs: 1000, maxBytes: 10_000 });
    expect(text.length).toBeLessThanOrEqual(10_000);
    expect(text.length).toBeGreaterThan(0);
    expect(wasCancelled()).toBe(true);
  });

  it('gives up on a body that stops sending', async () => {
    const { res, wasCancelled } = streamOf([], { stall: true });
    await expect(readBody(res, { timeoutMs: 50 })).rejects.toThrow(/timed out/i);
    expect(wasCancelled()).toBe(true);
  });

  it('returns an empty string for a response with no body', async () => {
    expect(await readBody(new Response(null), { timeoutMs: 50 })).toBe('');
  });
});
