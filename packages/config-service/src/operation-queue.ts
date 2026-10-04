/** A rejected operation retains its error without poisoning subsequent work. */
export function createOperationQueue() {
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
      const result = tail.then(operation);
      tail = result.then(
        () => {},
        () => {},
      );
      return result;
    },
    settled(): Promise<void> {
      return tail;
    },
  };
}
