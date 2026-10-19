/**
 * Calls `tick` repeatedly, one call at a time: the next call is scheduled only after the previous one has finished, so a
 * slow server never piles up requests. `stop()` ends it for good (nothing runs after it, even a tick already in flight is
 * not followed by another). A failing tick is reported and polling continues.
 */
export interface Poller {
  start(): void;
  stop(): void;
  readonly running: boolean;
}

export interface PollerOptions {
  intervalMs: number;
  tick: () => Promise<void> | void;
  onError?: (error: unknown) => void;
}

export function createPoller({ intervalMs, tick, onError }: PollerOptions): Poller {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const schedule = () => {
    if (!running) return;
    timer = setTimeout(async () => {
      timer = null;
      if (!running) return;
      try {
        await tick();
      } catch (error) {
        onError?.(error);
      }
      schedule();
    }, intervalMs);
  };

  return {
    start() {
      if (running) return;
      running = true;
      schedule();
    },
    stop() {
      running = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    get running() {
      return running;
    },
  };
}
