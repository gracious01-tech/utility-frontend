"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface AggregationChunk {
  period: string;
  total: number;
  average: number;
  min: number;
  max: number;
  count: number;
}

export interface TransformedValue {
  original: number;
  scaled: number;
  normalized: number;
}

export interface WorkerPayload {
  type: "aggregate" | "filter" | "transform";
  data: number[];
  config?: {
    chunkSize?: number;
    period?: string;
    threshold?: number;
  };
}

type WorkerResult =
  | { type: "aggregate_result"; data: AggregationChunk[] }
  | { type: "filter_result"; data: number[] }
  | { type: "transform_result"; data: TransformedValue[] }
  | { type: "error"; data: string };

interface UseWorkerReturn {
  result: AggregationChunk[] | number[] | TransformedValue[] | null;
  loading: boolean;
  error: string | null;
  run: (payload: WorkerPayload) => void;
  terminate: () => void;
}

// Main-thread fallback implementations
function aggregateOnMain(data: number[], chunkSize: number): AggregationChunk[] {
  const chunks: AggregationChunk[] = [];
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.slice(i, i + chunkSize);
    const sum = chunk.reduce((a, b) => a + b, 0);
    chunks.push({
      period: `chunk-${Math.floor(i / chunkSize)}`,
      total: sum,
      average: chunk.length > 0 ? sum / chunk.length : 0,
      min: Math.min(...chunk),
      max: Math.max(...chunk),
      count: chunk.length,
    });
  }
  return chunks;
}

function filterOnMain(data: number[], threshold: number): number[] {
  const mean = data.reduce((a, b) => a + b, 0) / data.length;
  const stdDev = Math.sqrt(
    data.reduce((sq, n) => sq + Math.pow(n - mean, 2), 0) / data.length
  );
  return data.filter(
    (value) => Math.abs(value - mean) <= threshold * stdDev
  );
}

function transformOnMain(data: number[]): TransformedValue[] {
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  return data.map((value) => ({
    original: value,
    scaled: value / 100,
    normalized: (value - min) / range,
  }));
}

function computeOnMain(payload: WorkerPayload): WorkerResult {
  const { type, data, config } = payload;
  switch (type) {
    case "aggregate": {
      const chunkSize = config?.chunkSize || 100;
      return { type: "aggregate_result", data: aggregateOnMain(data, chunkSize) };
    }
    case "filter": {
      const threshold = config?.threshold || 3;
      return { type: "filter_result", data: filterOnMain(data, threshold) };
    }
    case "transform":
      return { type: "transform_result", data: transformOnMain(data) };
    default:
      return { type: "error", data: `Unknown type: ${type}` };
  }
}

export function useWorker(): UseWorkerReturn {
  const [result, setResult] = useState<AggregationChunk[] | number[] | TransformedValue[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    // Initialize the Web Worker
    try {
      const worker = new Worker(
        new URL("../workers/data.worker.ts", import.meta.url),
        { type: "module" }
      );
      workerRef.current = worker;

      worker.onmessage = (event: MessageEvent<WorkerResult>) => {
        if (!mountedRef.current) return;
        const msg = event.data;
        if (msg.type === "error") {
          setError(msg.data);
          setLoading(false);
        } else {
          setResult(msg.data);
          setLoading(false);
        }
      };

      worker.onerror = (evt: ErrorEvent) => {
        if (!mountedRef.current) return;
        setError(evt.message || "Worker error occurred");
        setLoading(false);
      };
    } catch {
      // Worker creation failed — will fall back to main thread
    }

    return () => {
      mountedRef.current = false;
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, []);

  const run = useCallback((payload: WorkerPayload) => {
    setLoading(true);
    setError(null);

    if (workerRef.current) {
      // Use Web Worker
      workerRef.current.postMessage(payload);
    } else {
      // Fallback: compute on main thread
      try {
        const res = computeOnMain(payload);
        if (!mountedRef.current) return;
        if (res.type === "error") {
          setError(res.data);
          setLoading(false);
        } else {
          setResult(res.data);
          setLoading(false);
        }
      } catch (err) {
        if (!mountedRef.current) return;
        setError((err as Error).message || "Computation failed");
        setLoading(false);
      }
    }
  }, []);

  const terminate = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    setResult(null);
    setError(null);
    setLoading(false);
  }, []);

  return { result, loading, error, run, terminate };
}
