/** Stop awaiting on cancellation, even when a dependency ignores its signal. */
export function awaitWithSignal<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Operation aborted"));
  if (!signal) return operation();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = () => finish(() => reject(signal.reason ?? new Error("Operation aborted")));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => {
        if (signal.aborted) throw signal.reason ?? new Error("Operation aborted");
        return operation();
      })
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
  });
}
