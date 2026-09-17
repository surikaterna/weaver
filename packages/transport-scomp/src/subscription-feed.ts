import type { ConfigDelta } from "@weaver-conf/config-types";
import type { WeaverConfigContract } from "./contract";

type NextOutcome =
  | { readonly kind: "result"; readonly result: IteratorResult<ConfigDelta> }
  | { readonly kind: "error" }
  | { readonly kind: "terminal" };

interface TerminalSignal {
  readonly outcome: Promise<NextOutcome>;
  resolve(): void;
}

interface DeferredClose {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

export interface SubscriptionFeedHandle {
  readonly consumerDone: Promise<void>;
  stop(): Promise<void>;
}

export interface SubscriptionFeedOwner {
  subscribe(handler: (delta: ConfigDelta) => void): () => void;
  close(): Promise<void>;
}

function createTerminalSignal(): TerminalSignal {
  let resolve: () => void = () => undefined;
  const outcome = new Promise<NextOutcome>((done) => {
    resolve = () => done({ kind: "terminal" });
  });
  return { outcome, resolve };
}

function createDeferredClose(): DeferredClose {
  let resolve: () => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function observeNext(
  iterator: AsyncIterator<ConfigDelta>,
): Promise<NextOutcome> {
  try {
    return Promise.resolve(iterator.next()).then(
      (result) => ({ kind: "result", result }),
      () => ({ kind: "error" }),
    );
  } catch {
    return Promise.resolve({ kind: "error" });
  }
}

async function observeReturn(
  iterator: AsyncIterator<ConfigDelta>,
): Promise<void> {
  try {
    // Provider-owned return work may remain pending; terminal signaling releases the consumer.
    await iterator.return?.();
  } catch {
    // Closing a subscription preserves the transport's non-throwing return contract.
  }
}

export function startSubscriptionFeed(
  source: AsyncIterable<ConfigDelta>,
  handler: (delta: ConfigDelta) => void,
  own: (feed: SubscriptionFeedHandle) => void,
  remove: (feed: SubscriptionFeedHandle) => void,
  trackCleanup: (cleanup: Promise<void>) => void = () => undefined,
): SubscriptionFeedHandle {
  const iterator = source[Symbol.asyncIterator]();
  const terminalSignal = createTerminalSignal();
  let terminal = false;
  let returnWork = Promise.resolve();

  const finish = (requestReturn: boolean): Promise<void> => {
    if (terminal) return returnWork;
    terminal = true;
    remove(feed);
    terminalSignal.resolve();
    returnWork = requestReturn ? observeReturn(iterator) : Promise.resolve();
    if (requestReturn) trackCleanup(returnWork);
    return returnWork;
  };

  let consumerDone = Promise.resolve();
  const feed: SubscriptionFeedHandle = {
    get consumerDone() {
      return consumerDone;
    },
    stop: () => finish(true),
  };
  own(feed);
  consumerDone = consumeFeed(iterator, handler, terminalSignal, finish);
  return feed;
}

async function consumeFeed(
  iterator: AsyncIterator<ConfigDelta>,
  handler: (delta: ConfigDelta) => void,
  terminalSignal: TerminalSignal,
  finish: (requestReturn: boolean) => Promise<void>,
): Promise<void> {
  while (true) {
    const outcome = await Promise.race([
      observeNext(iterator),
      terminalSignal.outcome,
    ]);
    if (outcome.kind === "terminal") return;
    if (outcome.kind === "error") {
      void finish(false);
      return;
    }
    if (outcome.result.done) {
      void finish(false);
      return;
    }
    try {
      await handler(outcome.result.value);
    } catch {
      void finish(true);
      return;
    }
  }
}

async function finishClose(
  feeds: readonly SubscriptionFeedHandle[],
  pendingCleanup: ReadonlySet<Promise<void>>,
  closeChannel: () => Promise<void>,
): Promise<void> {
  const cleanup = new Set(pendingCleanup);
  for (const feed of feeds) cleanup.add(feed.stop());
  let channelError: unknown;
  let channelFailed = false;
  try {
    await closeChannel();
  } catch (error) {
    channelFailed = true;
    channelError = error;
  }
  await Promise.all(cleanup);
  if (channelFailed) throw channelError;
}

export function createSubscriptionFeedOwner(
  client: WeaverConfigContract,
  closeChannel: () => Promise<void>,
): SubscriptionFeedOwner {
  const activeFeeds = new Set<SubscriptionFeedHandle>();
  const pendingCleanup = new Set<Promise<void>>();
  let closePromise: Promise<void> | undefined;

  const trackCleanup = (cleanup: Promise<void>): void => {
    pendingCleanup.add(cleanup);
    void cleanup.then(
      () => pendingCleanup.delete(cleanup),
      () => pendingCleanup.delete(cleanup),
    );
  };

  return {
    subscribe(handler) {
      if (closePromise) throw new Error("SCOMP transport is closed");
      let feed: SubscriptionFeedHandle | undefined;
      feed = startSubscriptionFeed(
        client.subscribe({}),
        handler,
        (owned) => activeFeeds.add(owned),
        (owned) => activeFeeds.delete(owned),
        trackCleanup,
      );
      return () => {
        void feed?.stop();
      };
    },
    close() {
      if (closePromise) return closePromise;
      const deferred = createDeferredClose();
      closePromise = deferred.promise;
      const feeds = [...activeFeeds];
      void finishClose(feeds, pendingCleanup, closeChannel).then(
        () => deferred.resolve(),
        (error: unknown) => deferred.reject(error),
      );
      return closePromise;
    },
  };
}
