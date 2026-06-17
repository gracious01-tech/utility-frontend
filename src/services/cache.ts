"use client";

import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "utility-cache";
const DB_VERSION = 2;
const CACHE_PREFIX = "utility";

const RETRY_DELAYS = [1_000, 5_000, 15_000, 30_000, 60_000];
const MAX_RETRIES = 5;

interface CacheEntry<T = unknown> {
  key: string;
  value: T;
  timestamp: number;
  ttl: number;
}

interface QueueEntry {
  key: string;
  value: unknown;
  timestamp: number;
  retryCount: number;
}

let dbInstance: IDBPDatabase | null = null;

async function getDb(): Promise<IDBPDatabase> {
  if (dbInstance) return dbInstance;
  dbInstance = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db, _oldVersion) {
      if (!db.objectStoreNames.contains("kv")) {
        const store = db.createObjectStore("kv", { keyPath: "key" });
        store.createIndex("timestamp", "timestamp");
        store.createIndex("ttl", "ttl");
      }
      if (!db.objectStoreNames.contains("offline-queue")) {
        db.createObjectStore("offline-queue", { keyPath: "key" });
      }
    },
  });
  return dbInstance;
}

export function buildCacheKey(parts: string[]): string {
  return `${CACHE_PREFIX}:${parts.join(":")}`;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const db = await getDb();
    const entry = await db.get("kv", key);
    if (!entry) return null;
    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      await db.delete("kv", key);
      return null;
    }
    return entry.value as T;
  } catch {
    return null;
  }
}

export async function cacheSet<T>(
  key: string,
  value: T,
  ttlMs = 5 * 60 * 1000
): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      await enqueueOfflineWrite(key, value);
      return;
    }
    const db = await getDb();
    const entry: CacheEntry<T> = {
      key,
      value,
      timestamp: Date.now(),
      ttl: ttlMs,
    };
    await db.put("kv", entry);
  } catch {
    // silently fail — cache is best-effort
  }
}

export async function cacheDelete(key: string): Promise<void> {
  try {
    const db = await getDb();
    await db.delete("kv", key);
  } catch {
    // silently fail
  }
}

export async function cacheClear(): Promise<void> {
  try {
    const db = await getDb();
    await db.clear("kv");
  } catch {
    // silently fail
  }
}

export async function cacheClearByPrefix(prefix: string): Promise<void> {
  try {
    const db = await getDb();
    const keys = await db.getAllKeys("kv");
    const tx = db.transaction("kv", "readwrite");
    for (const key of keys) {
      if (String(key).startsWith(prefix)) {
        tx.store.delete(key);
      }
    }
    await tx.done;
  } catch {
    // silently fail
  }
}

export async function cacheKeys(prefix?: string): Promise<string[]> {
  try {
    const db = await getDb();
    const all = await db.getAllKeys("kv");
    if (prefix) return all.filter((k) => String(k).startsWith(prefix)).map(String);
    return all.map(String);
  } catch {
    return [];
  }
}

export async function cacheGetBulk<T>(keys: string[]): Promise<Map<string, T>> {
  const results = new Map<string, T>();
  try {
    const db = await getDb();
    for (const key of keys) {
      const entry = await db.get("kv", key);
      if (entry && Date.now() - entry.timestamp <= entry.ttl) {
        results.set(key, entry.value as T);
      }
    }
  } catch {
    // silently fail
  }
  return results;
}

let writeBatch: Array<{ key: string; value: unknown; ttlMs: number }> = [];
let writeBatchScheduled = false;

async function flushWriteBatch(): Promise<void> {
  const batch = writeBatch;
  writeBatch = [];
  writeBatchScheduled = false;
  try {
    const db = await getDb();
    const tx = db.transaction("kv", "readwrite");
    const now = Date.now();
    for (const { key, value, ttlMs } of batch) {
      tx.store.put({ key, value, timestamp: now, ttl: ttlMs } satisfies CacheEntry);
    }
    await tx.done;
  } catch {
    // silently fail
  }
}

export function cacheSetBulk<T>(
  entries: Array<{ key: string; value: T; ttlMs?: number }>
): void {
  for (const { key, value, ttlMs } of entries) {
    writeBatch.push({
      key,
      value,
      ttlMs: ttlMs ?? 5 * 60 * 1000,
    });
  }
  if (!writeBatchScheduled) {
    writeBatchScheduled = true;
    requestAnimationFrame(() => {
      void flushWriteBatch();
    });
  }
}

export async function enqueueOfflineWrite(
  key: string,
  value: unknown
): Promise<void> {
  try {
    const db = await getDb();
    const entries = await db.getAll("offline-queue");
    const existing = entries.find((e) => e.key === key);
    const now = Date.now();
    if (existing) {
      await db.put("offline-queue", {
        ...existing,
        value,
        timestamp: now,
      } satisfies QueueEntry);
    } else {
      await db.add("offline-queue", {
        key,
        value,
        timestamp: now,
        retryCount: 0,
      } satisfies QueueEntry);
    }
  } catch {
    // silently fail
  }
}

export async function getOfflineQueueLength(): Promise<number> {
  try {
    const db = await getDb();
    return await db.count("offline-queue");
  } catch {
    return 0;
  }
}

export async function replayOfflineQueue(): Promise<void> {
  try {
    const db = await getDb();
    const entries = await db.getAll("offline-queue");
    entries.sort((a, b) => a.timestamp - b.timestamp);

    for (const entry of entries) {
      try {
        const cacheEntry: CacheEntry = {
          key: entry.key,
          value: entry.value,
          timestamp: Date.now(),
          ttl: 5 * 60 * 1000,
        };
        await db.put("kv", cacheEntry);
        await db.delete("offline-queue", entry.key);
      } catch {
        if (entry.retryCount < MAX_RETRIES) {
          await db.put("offline-queue", {
            ...entry,
            retryCount: entry.retryCount + 1,
          } satisfies QueueEntry);
          const delay =
            RETRY_DELAYS[Math.min(entry.retryCount, RETRY_DELAYS.length - 1)];
          setTimeout(() => {
            void replayOfflineQueue();
          }, delay);
        }
        break;
      }
    }
  } catch {
    // silently fail
  }
}
