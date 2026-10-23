import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { UpstreamError } from '../../src/shared/errors.js';
import { HttpClient, type FetchFn } from '../../src/shared/http-client.js';

const schema = z.object({ ok: z.boolean() });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function client(
  fetch: FetchFn,
  overrides: Partial<ConstructorParameters<typeof HttpClient>[0]> = {},
) {
  return new HttpClient({
    name: 'test',
    fetch,
    logger: pino({ level: 'silent' }),
    timeoutMs: 1_000,
    retries: 2,
    retryBaseDelayMs: 0,
    sleep: () => Promise.resolve(),
    ...overrides,
  });
}

describe('HttpClient', () => {
  it('returns validated JSON', async () => {
    const fetch = vi.fn<FetchFn>().mockResolvedValue(json({ ok: true, extra: 1 }));
    expect(await client(fetch).getJson('https://x.test', schema)).toEqual({ ok: true });
  });

  it('retries transient failures (503, network) and then succeeds', async () => {
    const fetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(json({}, 503))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue(json({ ok: true }));
    expect(await client(fetch).getJson('https://x.test', schema)).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry client errors and exposes the status', async () => {
    const fetch = vi.fn<FetchFn>().mockResolvedValue(json({ message: 'nope' }, 404));
    const err = await client(fetch)
      .getJson('https://x.test', schema)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).status).toBe(404);
    expect((err as UpstreamError).extensions.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('treats an unexpected response shape as a non-retryable upstream error', async () => {
    const fetch = vi.fn<FetchFn>().mockResolvedValue(json({ ok: 'yes' }));
    await expect(client(fetch).getJson('https://x.test', schema)).rejects.toMatchObject({
      message: 'test: unexpected response shape',
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('times out slow upstreams', async () => {
    const fetch: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal!.reason as Error);
        });
      });
    await expect(
      client(fetch, { timeoutMs: 20, retries: 1 }).getJson('https://x.test', schema),
    ).rejects.toMatchObject({ message: 'test: request timed out' });
  });
});
