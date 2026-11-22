import type { KeyValueStore } from "./VirtualFS";

/**
 * Measuring localStorage. Browsers expose no API for its usage or quota
 * (navigator.storage.estimate() covers other storage types), so:
 *   - used  = total characters of every key and value (exact; this is what quotas count)
 *   - quota = used + the largest value a probe key can still store, found by
 *             binary search on QuotaExceededError. Measured once per store, then cached.
 * Sizes are in characters; for ASCII text that's one byte each.
 */

export interface EnumerableStore extends KeyValueStore {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

export interface StorageUsage {
  /** Characters used by all keys and values in the store. */
  used: number;
  /** Total capacity in characters (Infinity if the store has no limit). */
  quota: number;
  /** quota - used. */
  available: number;
}

export function isEnumerable(store: KeyValueStore): store is EnumerableStore {
  const s = store as Partial<EnumerableStore>;
  return typeof s.key === "function" && typeof s.removeItem === "function" && typeof s.length === "number";
}

export function usedChars(store: EnumerableStore): number {
  let total = 0;
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key !== null) total += key.length + (store.getItem(key)?.length ?? 0);
  }
  return total;
}

const PROBE_KEY = "onno:quota-probe";
/** Probe accuracy: stop the binary search once within this many characters. */
const RESOLUTION = 1024;
/** Above this, treat the store as unlimited rather than allocating huge strings. */
const UNLIMITED = 64 * 1024 * 1024;

/** How many more characters fit in the store, measured by probing. */
export function probeAvailable(store: EnumerableStore): number {
  const fits = (n: number) => {
    try {
      store.setItem(PROBE_KEY, "x".repeat(n));
      return true;
    } catch {
      return false;
    } finally {
      store.removeItem(PROBE_KEY);
    }
  };

  if (!fits(0)) return 0;
  let lo = 0; // known to fit
  let hi = 1024 * 1024; // candidate
  while (fits(hi)) {
    lo = hi;
    hi *= 2;
    if (hi > UNLIMITED) return Infinity;
  }
  while (hi - lo > RESOLUTION) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo + PROBE_KEY.length;
}

const quotaCache = new WeakMap<object, number>();

export function measureStorage(store: EnumerableStore): StorageUsage {
  const used = usedChars(store);
  let quota = quotaCache.get(store);
  if (quota === undefined) {
    quota = used + probeAvailable(store);
    quotaCache.set(store, quota);
  }
  return { used, quota, available: Math.max(0, quota - used) };
}
