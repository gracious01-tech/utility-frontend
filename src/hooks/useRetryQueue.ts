"use client";

import { useState, useCallback, useRef, useEffect } from "react";

interface QueuedTransaction {
  id: string;
  txHash: string | null;
  status: "pending" | "submitted" | "confirmed" | "failed";
  retryCount: number;
  maxRetries: number;
  error: string | null;
  createdAt: number;
}

interface UseRetryQueueReturn {
  queue: QueuedTransaction[];
  enqueue: (id: string, maxRetries?: number) => void;
  updateTxHash: (id: string, txHash: string) => void;
  markConfirmed: (id: string) => void;
  markFailed: (id: string, error: string) => void;
  retry: (id: string) => Promise<void>;
  purge: () => void;
  pendingCount: number;
}

const RETRY_DELAYS = [1000, 5000, 15000, 30000, 60000];
const STORAGE_KEY = "retry-queue-state";

// Serialize queue for localStorage
function serializeQueue(queue: QueuedTransaction[]): string {
  return JSON.stringify(queue);
}

// Deserialize queue from localStorage
function deserializeQueue(stored: string | null): QueuedTransaction[] {
  if (!stored) return [];
  try {
    return JSON.parse(stored);
  } catch {
    return [];
  }
}

export function useRetryQueue(): UseRetryQueueReturn {
  // Initialize queue from localStorage
  const [queue, setQueue] = useState<QueuedTransaction[]>(() => {
    if (typeof window === "undefined") return [];
    const stored = localStorage.getItem(STORAGE_KEY);
    return deserializeQueue(stored);
  });
  
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Persist queue to localStorage whenever it changes
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, serializeQueue(queue));
    }
  }, [queue]);

  const cleanupTimer = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const enqueue = useCallback((id: string, maxRetries = 5) => {
    setQueue((prev) => {
      if (prev.find((t) => t.id === id)) return prev;
      const newQueue = [
        {
          id,
          txHash: null,
          status: "pending" as const,
          retryCount: 0,
          maxRetries,
          error: null,
          createdAt: Date.now(),
        },
        ...prev,
      ];
      return newQueue;
    });
  }, []);

  const updateTxHash = useCallback((id: string, txHash: string) => {
    setQueue((prev) =>
      prev.map((t) =>
        t.id === id ? { ...t, txHash, status: "submitted" as const } : t
      )
    );
  }, []);

  const markConfirmed = useCallback(
    (id: string) => {
      cleanupTimer(id);
      setQueue((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, status: "confirmed" as const } : t
        )
      );
    },
    [cleanupTimer]
  );

  const markFailed = useCallback(
    (id: string, error: string) => {
      setQueue((prev) => {
        const tx = prev.find((t) => t.id === id);
        if (!tx) return prev;

        // First, mark as failed
        const updatedQueue = prev.map((t) =>
          t.id === id ? { ...t, status: "failed" as const, error } : t
        );

        // If retries are available, schedule auto-retry
        if (tx.retryCount < tx.maxRetries) {
          const delay = RETRY_DELAYS[Math.min(tx.retryCount, RETRY_DELAYS.length - 1)];
          
          // Clean up any existing timer for this transaction
          cleanupTimer(id);
          
          const timer = setTimeout(() => {
            setQueue((current) =>
              current.map((t) =>
                t.id === id
                  ? {
                      ...t,
                      retryCount: t.retryCount + 1,
                      status: "pending" as const,
                      error: null,
                    }
                  : t
              )
            );
          }, delay);
          
          timersRef.current.set(id, timer);
        }

        return updatedQueue;
      });
    },
    [cleanupTimer]
  );

  const retry = useCallback(async (id: string) => {
    cleanupTimer(id);
    setQueue((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, status: "pending" as const, retryCount: t.retryCount + 1, error: null }
          : t
      )
    );
  }, [cleanupTimer]);

  const purge = useCallback(() => {
    timersRef.current.forEach((timer) => clearTimeout(timer));
    timersRef.current.clear();
    setQueue([]);
  }, []);

  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => clearTimeout(timer));
    };
  }, []);

  return {
    queue,
    enqueue,
    updateTxHash,
    markConfirmed,
    markFailed,
    retry,
    purge,
    pendingCount: queue.filter((t) => t.status === "pending" || t.status === "submitted").length,
  };
}
