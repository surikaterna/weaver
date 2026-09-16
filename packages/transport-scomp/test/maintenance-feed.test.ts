import type { ConfigDelta } from "@weaver-conf/config-types";
import { createScompTransport } from "../src/index";
import { startSubscriptionFeed } from "../src/subscription-feed";

const delta: ConfigDelta = {
  action: "set",
  key: "service.enabled",
  value: true,
  layer: "runtime",
  environment: "default",
  timestamp: "2026-09-16T00:00:00.000Z",
};

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class ControlledFeed implements AsyncIterable<ConfigDelta> {
  readonly iterator: ControlledIterator;

  constructor(options: ControlledIteratorOptions = {}) {
    this.iterator = new ControlledIterator(options);
  }

  [Symbol.asyncIterator](): AsyncIterator<ConfigDelta> {
    return this.iterator;
  }
}

interface ControlledIteratorOptions {
  readonly settlePendingOnReturn?: boolean;
  readonly returnGate?: Promise<void>;
  readonly returnError?: Error;
}

class ControlledIterator implements AsyncIterator<ConfigDelta> {
  returnCalls = 0;
  private pending?: {
    resolve: (result: IteratorResult<ConfigDelta>) => void;
    reject: (error: Error) => void;
  };

  constructor(private readonly options: ControlledIteratorOptions) {}

  next(): Promise<IteratorResult<ConfigDelta>> {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  async return(): Promise<IteratorResult<ConfigDelta>> {
    this.returnCalls += 1;
    if (this.options.settlePendingOnReturn !== false) this.end();
    await this.options.returnGate;
    if (this.options.returnError) throw this.options.returnError;
    return { done: true, value: undefined };
  }

  emit(value: ConfigDelta): void {
    this.takePending()?.resolve({ done: false, value });
  }

  end(): void {
    this.takePending()?.resolve({ done: true, value: undefined });
  }

  fail(error: Error): void {
    this.takePending()?.reject(error);
  }

  private takePending(): ControlledIterator["pending"] {
    const pending = this.pending;
    this.pending = undefined;
    return pending;
  }
}

function createTransport(
  feeds: AsyncIterable<ConfigDelta>[],
  closeChannel: () => Promise<void> = async () => undefined,
) {
  let feedIndex = 0;
  let channelCloseCalls = 0;
  const peer = {
    consumes: () => ({ subscribe: () => feeds[feedIndex++] }),
    close: async () => {
      channelCloseCalls += 1;
      await closeChannel();
    },
  };
  return {
    transport: createScompTransport({ peer: peer as never }),
    channelCloseCalls: () => channelCloseCalls,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function remainsPending(promise: Promise<void>): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => false,
      () => false,
    ),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), 10)),
  ]);
}

describe("SCOMP maintenance feed ownership", () => {
  it("removes a naturally ended feed without returning it", async () => {
    const feed = new ControlledFeed();
    const { transport } = createTransport([feed]);
    transport.subscribe(() => undefined);
    feed.iterator.end();
    await settle();
    await transport.close();
    expect(feed.iterator.returnCalls).toBe(0);
  });

  it("treats a remote maintenance end as normal terminal cleanup", async () => {
    const feed = new ControlledFeed();
    const handled: ConfigDelta[] = [];
    const { transport } = createTransport([feed]);
    transport.subscribe((value) => handled.push(value));
    feed.iterator.emit(delta);
    await settle();
    feed.iterator.end();
    await settle();
    await transport.close();
    expect(handled).toEqual([delta]);
    expect(feed.iterator.returnCalls).toBe(0);
  });

  it("removes an errored iterator without an unhandled rejection", async () => {
    const feed = new ControlledFeed();
    const { transport } = createTransport([feed]);
    transport.subscribe(() => undefined);
    feed.iterator.fail(new Error("remote feed failed"));
    await settle();
    await expect(transport.close()).resolves.toBeUndefined();
    expect(feed.iterator.returnCalls).toBe(0);
  });

  it("terminates a failing handler and returns exactly once", async () => {
    const feed = new ControlledFeed();
    const { transport } = createTransport([feed]);
    transport.subscribe(async () => {
      throw new Error("handler failed");
    });
    feed.iterator.emit(delta);
    await settle();
    await transport.close();
    expect(feed.iterator.returnCalls).toBe(1);
  });

  it("makes unsubscribe and close races idempotent across feeds", async () => {
    const feeds = [
      new ControlledFeed({ settlePendingOnReturn: false }),
      new ControlledFeed(),
      new ControlledFeed(),
    ];
    const handled: ConfigDelta[] = [];
    const { transport, channelCloseCalls } = createTransport(feeds);
    const unsubscribe = transport.subscribe((value) => handled.push(value));
    transport.subscribe((value) => handled.push(value));
    const naturalRace = transport.subscribe((value) => handled.push(value));
    unsubscribe();
    unsubscribe();
    feeds[0].iterator.emit(delta);
    feeds[2].iterator.end();
    naturalRace();
    await transport.close();
    await transport.close();
    await settle();
    expect(handled).toEqual([]);
    expect(feeds.map((feed) => feed.iterator.returnCalls)).toEqual([1, 1, 1]);
    expect(channelCloseCalls()).toBe(1);
    expect(() => transport.subscribe(() => undefined)).toThrow(
      "SCOMP transport is closed",
    );
  });

  it("shares concurrent close while iterator return is delayed", async () => {
    const gate = deferred();
    const feed = new ControlledFeed({ returnGate: gate.promise });
    const { transport, channelCloseCalls } = createTransport([feed]);
    transport.subscribe(() => undefined);
    const first = transport.close();
    const second = transport.close();
    expect(first).toBe(second);
    expect(await remainsPending(first)).toBe(true);
    expect(feed.iterator.returnCalls).toBe(1);
    expect(channelCloseCalls()).toBe(1);
    gate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it("finalizes its consumer when pending next never settles", async () => {
    const gate = deferred();
    const feed = new ControlledFeed({
      settlePendingOnReturn: false,
      returnGate: gate.promise,
    });
    let owned = 0;
    let handled = 0;
    const handle = startSubscriptionFeed(
      feed,
      () => {
        handled += 1;
      },
      () => {
        owned += 1;
      },
      () => {
        owned -= 1;
      },
    );
    const cleanup = handle.stop();
    await expect(handle.consumerDone).resolves.toBeUndefined();
    expect(owned).toBe(0);
    expect(handled).toBe(0);
    expect(await remainsPending(cleanup)).toBe(true);
    gate.resolve();
    await cleanup;
  });

  it("observes late next resolution and rejection after terminal", async () => {
    for (const outcome of ["resolve", "reject"] as const) {
      const feed = new ControlledFeed({ settlePendingOnReturn: false });
      const handled: ConfigDelta[] = [];
      const { transport } = createTransport([feed]);
      const unsubscribe = transport.subscribe((value) => handled.push(value));
      unsubscribe();
      if (outcome === "resolve") feed.iterator.emit(delta);
      else feed.iterator.fail(new Error("late rejection"));
      await settle();
      await transport.close();
      expect(handled).toEqual([]);
      expect(feed.iterator.returnCalls).toBe(1);
    }
  });

  it("observes return rejection and shares successful close", async () => {
    const feed = new ControlledFeed({
      returnError: new Error("return failed"),
    });
    const fixture = createTransport([feed]);
    fixture.transport.subscribe(() => undefined);
    const first = fixture.transport.close();
    const second = fixture.transport.close();
    expect(first).toBe(second);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(feed.iterator.returnCalls).toBe(1);
    expect(fixture.channelCloseCalls()).toBe(1);
  });

  it("shares channel close failure after removing active feeds", async () => {
    const feed = new ControlledFeed();
    const channelError = new Error("channel failed");
    const fixture = createTransport([feed], async () => {
      throw channelError;
    });
    fixture.transport.subscribe(() => undefined);
    const first = fixture.transport.close();
    const second = fixture.transport.close();
    expect(first).toBe(second);
    await expect(first).rejects.toBe(channelError);
    await expect(second).rejects.toBe(channelError);
    expect(feed.iterator.returnCalls).toBe(1);
    expect(fixture.channelCloseCalls()).toBe(1);
  });

  it("retains nothing when iterator acquisition throws", async () => {
    const broken: AsyncIterable<ConfigDelta> = {
      [Symbol.asyncIterator]() {
        throw new Error("iterator unavailable");
      },
    };
    const { transport, channelCloseCalls } = createTransport([broken]);
    expect(() => transport.subscribe(() => undefined)).toThrow(
      "iterator unavailable",
    );
    await expect(transport.close()).resolves.toBeUndefined();
    expect(channelCloseCalls()).toBe(1);
  });
});
