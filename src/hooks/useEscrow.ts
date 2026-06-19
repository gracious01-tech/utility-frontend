"use client";

import { useState, useCallback, useRef } from "react";

type MutationStatus = "idle" | "pending" | "confirmed" | "failed";

interface OptimisticMutation<TData = unknown> {
  id: string;
  data: TData;
  status: MutationStatus;
  error: string | null;
  submittedAt: number;
  confirmedAt: number | null;
}

interface UseEscrowReturn<TData> {
  mutations: OptimisticMutation<TData>[];
  submit: (data: TData) => Promise<void>;
  rollback: (mutationId: string) => void;
  retry: (mutationId: string) => Promise<void>;
  pendingCount: number;
}

let mutationCounter = 0;

export function useEscrow<TData = unknown>(
  onChainSubmit: (data: TData) => Promise<void>,
  onRollback: (data: TData) => Promise<void>
): UseEscrowReturn<TData> {
  const [mutations, setMutations] = useState<OptimisticMutation<TData>[]>([]);
  const activeMutationsRef = useRef<Set<string>>(new Set());

  const submit = useCallback(
    async (data: TData) => {
      const id = `mutation-${++mutationCounter}`;
      const mutation: OptimisticMutation<TData> = {
        id,
        data,
        status: "pending",
        error: null,
        submittedAt: Date.now(),
        confirmedAt: null,
      };

      setMutations((prev) => [mutation, ...prev].slice(0, 50));
      activeMutationsRef.current.add(id);

      try {
        await onChainSubmit(data);
        if (!activeMutationsRef.current.has(id)) return;
        activeMutationsRef.current.delete(id);
        setMutations((prev) =>
          prev.map((m) =>
            m.id === id
              ? { ...m, status: "confirmed", confirmedAt: Date.now() }
              : m
          )
        );
      } catch (error) {
        if (!activeMutationsRef.current.has(id)) return;
        activeMutationsRef.current.delete(id);
        await onRollback(data);
        setMutations((prev) =>
          prev.map((m) =>
            m.id === id
              ? { ...m, status: "failed", error: (error as Error).message }
              : m
          )
        );
      }
    },
    [onChainSubmit, onRollback]
  );

  const rollback = useCallback(
    (mutationId: string) => {
      if (!activeMutationsRef.current.has(mutationId)) return;

      const target = mutations.find((m) => m.id === mutationId);
      if (!target) return;

      activeMutationsRef.current.delete(mutationId);

      onRollback(target.data).catch((err) => {
        console.error("Failed to execute onRollback side effect:", err);
      });

      setMutations((prev) =>
        prev.map((m) =>
          m.id === mutationId ? { ...m, status: "idle", error: "Rolled back" } : m
        )
      );
    },
    [mutations, onRollback]
  );

  const retry = useCallback(
    async (mutationId: string) => {
      const target = mutations.find((m) => m.id === mutationId);
      if (!target || target.status !== "failed") return;

      setMutations((prev) =>
        prev.map((m) =>
          m.id === mutationId
            ? { ...m, status: "pending", error: null, submittedAt: Date.now() }
            : m
        )
      );

      activeMutationsRef.current.add(mutationId);

      try {
        await onChainSubmit(target.data);
        if (!activeMutationsRef.current.has(mutationId)) return;
        activeMutationsRef.current.delete(mutationId);
        setMutations((prev) =>
          prev.map((m) =>
            m.id === mutationId
              ? { ...m, status: "confirmed", confirmedAt: Date.now() }
              : m
          )
        );
      } catch (error) {
        if (!activeMutationsRef.current.has(mutationId)) return;
        activeMutationsRef.current.delete(mutationId);
        await onRollback(target.data);
        setMutations((prev) =>
          prev.map((m) =>
            m.id === mutationId
              ? { ...m, status: "failed", error: (error as Error).message }
              : m
          )
        );
      }
    },
    [mutations, onChainSubmit, onRollback]
  );

  return {
    mutations,
    submit,
    rollback,
    retry,
    pendingCount: mutations.filter((m) => m.status === "pending").length,
  };
}
