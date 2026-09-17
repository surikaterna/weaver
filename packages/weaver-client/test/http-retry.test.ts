import { fetchWithRetry } from "../src/http-retry.js";

function createMockFetch(
  responses: Array<{ status: number; body?: unknown } | "network-error">,
) {
  let callCount = 0;
  const fn = async (_url: string, _init?: RequestInit): Promise<Response> => {
    const entry = responses[callCount++];
    if (entry === "network-error") throw new Error("network error");
    return new Response(JSON.stringify(entry.body ?? {}), {
      status: entry.status,
    });
  };
  return {
    fn: fn as typeof globalThis.fetch,
    get callCount() {
      return callCount;
    },
  };
}

const baseOpts = {
  retry: { maxAttempts: 3, baseDelay: 10, maxDelay: 50 },
  timeout: 5000,
};

describe("fetchWithRetry", () => {
  it("returns immediately on 200", async () => {
    const mock = createMockFetch([{ status: 200, body: { ok: true } }]);
    const res = await fetchWithRetry(
      "http://x",
      {},
      { ...baseOpts, fetchFn: mock.fn },
    );
    expect(res.status).toBe(200);
    expect(mock.callCount).toBe(1);
  });

  it("does not retry on 400", async () => {
    const mock = createMockFetch([{ status: 400 }]);
    const res = await fetchWithRetry(
      "http://x",
      {},
      { ...baseOpts, fetchFn: mock.fn },
    );
    expect(res.status).toBe(400);
    expect(mock.callCount).toBe(1);
  });

  it("retries on 503 then succeeds", async () => {
    const mock = createMockFetch([{ status: 503 }, { status: 200 }]);
    const res = await fetchWithRetry(
      "http://x",
      {},
      { ...baseOpts, fetchFn: mock.fn },
    );
    expect(res.status).toBe(200);
    expect(mock.callCount).toBe(2);
  });

  it("retries on network error then succeeds", async () => {
    const mock = createMockFetch(["network-error", { status: 200 }]);
    const res = await fetchWithRetry(
      "http://x",
      {},
      { ...baseOpts, fetchFn: mock.fn },
    );
    expect(res.status).toBe(200);
    expect(mock.callCount).toBe(2);
  });

  it("throws after exhausting retries on network error", async () => {
    const mock = createMockFetch([
      "network-error",
      "network-error",
      "network-error",
    ]);
    await expect(
      fetchWithRetry("http://x", {}, { ...baseOpts, fetchFn: mock.fn }),
    ).rejects.toThrow();
    expect(mock.callCount).toBe(3);
  });

  it("calls onError on each failed attempt", async () => {
    const errors: unknown[] = [];
    const mock = createMockFetch([{ status: 503 }, { status: 200 }]);
    await fetchWithRetry(
      "http://x",
      {},
      { ...baseOpts, fetchFn: mock.fn, onError: (e) => errors.push(e) },
    );
    expect(errors.length).toBe(1);
  });

  it("reports a terminal timeout once without reclassifying it", async () => {
    const errors: Array<{ type: string }> = [];
    const fetchFn: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("timed out", "AbortError")),
          { once: true },
        );
      });
    await expect(
      fetchWithRetry(
        "http://x",
        {},
        {
          retry: { maxAttempts: 1, baseDelay: 0, maxDelay: 0 },
          timeout: 1,
          fetchFn,
          onError: (error) => errors.push(error),
        },
      ),
    ).rejects.toThrow("timed out");
    expect(errors).toEqual([
      { type: "timeout", message: "timed out", retryable: false },
    ]);
  });

  it("does not fetch when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    const reason = new DOMException("caller stopped", "AbortError");
    const errors: Array<{ type: string; retryable: boolean }> = [];
    const mock = createMockFetch([{ status: 200 }]);
    controller.abort(reason);

    await expect(
      fetchWithRetry(
        "http://x",
        { signal: controller.signal },
        {
          ...baseOpts,
          fetchFn: mock.fn,
          onError: (error) => errors.push(error),
        },
      ),
    ).rejects.toBe(reason);
    expect(mock.callCount).toBe(0);
    expect(errors).toEqual([
      expect.objectContaining({ type: "abort", retryable: false }),
    ]);
  });

  it("cancels an in-flight request when the caller aborts", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const errors: Array<{ type: string }> = [];
    const fetchFn: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    const request = fetchWithRetry(
      "http://x",
      { signal: controller.signal },
      { ...baseOpts, fetchFn, onError: (error) => errors.push(error) },
    );

    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(request).rejects.toThrow("cancelled");
    expect(errors).toEqual([
      expect.objectContaining({ type: "abort", retryable: false }),
    ]);
    expect(remove).toHaveBeenCalledTimes(add.mock.calls.length);
  });

  it("stops retries when the caller aborts during the retry delay", async () => {
    const controller = new AbortController();
    const errors: Array<{ type: string }> = [];
    const mock = createMockFetch([{ status: 503 }, { status: 200 }]);

    await expect(
      fetchWithRetry(
        "http://x",
        { signal: controller.signal },
        {
          ...baseOpts,
          fetchFn: mock.fn,
          onError: (error) => {
            errors.push(error);
            if (error.type === "server") {
              queueMicrotask(() => controller.abort());
            }
          },
        },
      ),
    ).rejects.toThrow();
    expect(mock.callCount).toBe(1);
    expect(errors.map((error) => error.type)).toEqual(["server", "abort"]);
  });

  it("keeps timeout classification when caller abort races afterward", async () => {
    const controller = new AbortController();
    const errors: Array<{ type: string }> = [];
    const fetchFn: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            controller.abort(new DOMException("caller stopped", "AbortError"));
            reject(new DOMException("timed out", "AbortError"));
          },
          { once: true },
        );
      });

    await expect(
      fetchWithRetry(
        "http://x",
        { signal: controller.signal },
        {
          retry: { maxAttempts: 1, baseDelay: 0, maxDelay: 0 },
          timeout: 1,
          fetchFn,
          onError: (error) => errors.push(error),
        },
      ),
    ).rejects.toThrow("timed out");
    expect(errors.map((error) => error.type)).toEqual(["timeout"]);
  });

  it("removes caller listeners after success and retry", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const mock = createMockFetch([{ status: 503 }, { status: 200 }]);

    await fetchWithRetry(
      "http://x",
      { signal: controller.signal },
      { ...baseOpts, fetchFn: mock.fn },
    );
    expect(remove).toHaveBeenCalledTimes(add.mock.calls.length);
    expect(add.mock.calls.length).toBeGreaterThan(0);
  });

  it("clears the timeout after a completed request", async () => {
    let signal: AbortSignal | null = null;
    const fetchFn: typeof globalThis.fetch = async (_input, init) => {
      signal = init?.signal ?? null;
      return new Response(null, { status: 200 });
    };
    await fetchWithRetry(
      "http://x",
      {},
      {
        retry: { maxAttempts: 1, baseDelay: 0, maxDelay: 0 },
        timeout: 1,
        fetchFn,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(signal?.aborted).toBe(false);
  });
});
