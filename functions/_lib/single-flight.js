// Only concurrent work is shared. Results are not cached after completion,
// preserving per-request authorization and revocation checks.
export function singleFlight() {
  const pending = new Map();
  return (key, work) => {
    if (!pending.has(key)) {
      const promise = Promise.resolve().then(work).finally(() => pending.delete(key));
      pending.set(key, promise);
    }
    return pending.get(key);
  };
}
