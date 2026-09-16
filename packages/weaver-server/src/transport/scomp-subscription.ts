import type { WeaverConfigContract } from "@weaver-conf/transport-scomp";
import {
  assertConfigServiceTransportOpen,
  subscribeConfigServiceMaintenance,
} from "../core/config-service-lifecycle";
import type { WeaverConfigService } from "../core/config-service-types";
import type { ConfigDelta } from "../types/index";

interface SubscriptionDeps {
  readonly configService: WeaverConfigService;
  readonly onMaintenance?: ((listener: () => void) => () => void) | undefined;
}

export function scompSubscriptionMethods({
  configService,
  onMaintenance,
}: SubscriptionDeps): Pick<WeaverConfigContract, "subscribe"> {
  return {
    async *subscribe(_input) {
      assertConfigServiceTransportOpen(configService);
      const state = new SubscriptionState();
      let stopMaintenance: (() => void) | undefined;
      let stopDeltas: (() => void) | undefined;
      try {
        stopMaintenance =
          subscribeConfigServiceMaintenance(configService, state.stop) ??
          onMaintenance?.(state.stop);
        if (state.stopped) return;
        stopDeltas = configService.onDelta(state.push);
        if (state.stopped) return;
        for await (const delta of state) yield delta;
      } finally {
        state.stop();
        stopDeltas?.();
        stopMaintenance?.();
      }
    },
  };
}

class SubscriptionState implements AsyncIterable<ConfigDelta> {
  private readonly queue: ConfigDelta[] = [];
  private wake: (() => void) | undefined;
  stopped = false;

  push = (delta: ConfigDelta): void => {
    if (this.stopped) return;
    this.queue.push(delta);
    this.release();
  };

  stop = (): void => {
    if (this.stopped) return;
    this.stopped = true;
    this.queue.length = 0;
    this.release();
  };

  async *[Symbol.asyncIterator](): AsyncGenerator<ConfigDelta> {
    while (!this.stopped) {
      const delta = this.queue.shift();
      if (delta !== undefined) {
        yield delta;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private release(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}
