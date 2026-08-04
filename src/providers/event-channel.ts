/**
 * A pushable async iterable. Provider adapters need to emit events from two
 * places at once — the provider's own stream and permission callbacks that
 * fire while it is being consumed — so they funnel both through here.
 */
export class EventChannel<T> {
  private readonly queue: T[] = [];
  private readonly waiting: Array<(result: IteratorResult<T>) => void> = [];
  private failure?: Error;
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value, done: false });
    else this.queue.push(value);
  }

  /** Ends iteration once buffered values are drained. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.drainWaiters();
  }

  /** Ends iteration with an error once buffered values are drained. */
  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.closed = true;
    this.drainWaiters();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.queue.length) {
        yield this.queue.shift() as T;
        continue;
      }
      if (this.closed) {
        if (this.failure) throw this.failure;
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
      if (next.done) {
        if (this.failure) throw this.failure;
        return;
      }
      yield next.value;
    }
  }

  private drainWaiters(): void {
    while (this.waiting.length) {
      const waiter = this.waiting.shift();
      waiter?.({ value: undefined as never, done: true });
    }
  }
}
