import type { ModelPort, ModelRequest, ModelResponse } from "@raven-gonna-test/forecast-core";

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

export class AsyncSemaphore {
  private inUse = 0;
  private readonly waiters: Waiter[] = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Semaphore limit must be a positive integer.");
  }

  private release = (): void => {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) continue;
      waiter.resolve(this.release);
      return;
    }
    this.inUse -= 1;
  };

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw signal.reason ?? new Error("Semaphore wait aborted.");
    if (this.inUse < this.limit) {
      this.inUse += 1;
      return this.release;
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal.reason ?? new Error("Semaphore wait aborted."));
        }
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class ConcurrencyLimitedModel implements ModelPort {
  readonly model: string;
  private readonly semaphore: AsyncSemaphore;

  constructor(private readonly inner: ModelPort, limit: number) {
    this.model = inner.model;
    this.semaphore = new AsyncSemaphore(limit);
  }

  generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    return this.semaphore.run(signal, () => this.inner.generate(request, signal));
  }
}
