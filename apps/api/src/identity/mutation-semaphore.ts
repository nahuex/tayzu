/**
 * Process-wide bound on the identity mutations that take an advisory lock (`043` Resolved
 * decision Q148). Waiters queue in memory, so the pool keeps the connections that a lock holder
 * needs for its own nested transaction. Each replica bounds its own pool.
 */
const MAX_CONCURRENT_MUTATIONS = 2;

let running = 0;
const waiters: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT_MUTATIONS) {
    running += 1;
    return;
  }
  // The releasing mutation hands its slot over, so `running` stays unchanged.
  await new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next === undefined) running -= 1;
  else next();
}

/** Runs `run` once one of the slots is free, before it asks for a pooled connection. */
export async function withMutationSlot<T>(run: () => Promise<T> | T): Promise<T> {
  await acquire();
  try {
    return await run();
  } finally {
    release();
  }
}
