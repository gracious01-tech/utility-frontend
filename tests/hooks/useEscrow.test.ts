import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useEscrow } from "../../src/hooks/useEscrow";

describe("useEscrow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should initialize with empty mutations and pendingCount of 0", () => {
    const onChainSubmit = vi.fn().mockResolvedValue(undefined);
    const onRollback = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useEscrow(onChainSubmit, onRollback));

    expect(result.current.mutations).toEqual([]);
    expect(result.current.pendingCount).toBe(0);
  });

  it("should apply optimistic update immediately, then confirm on success", async () => {
    let resolveSubmit!: () => void;
    const submitPromise = new Promise<void>((resolve) => {
      resolveSubmit = resolve;
    });
    const onChainSubmit = vi.fn().mockReturnValue(submitPromise);
    const onRollback = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useEscrow(onChainSubmit, onRollback));

    let promise: Promise<void>;
    act(() => {
      promise = result.current.submit("data-1");
    });

    // Check immediate optimistic state
    expect(result.current.mutations).toHaveLength(1);
    expect(result.current.mutations[0]).toMatchObject({
      data: "data-1",
      status: "pending",
      error: null,
      confirmedAt: null,
    });
    expect(result.current.mutations[0].submittedAt).toBeGreaterThan(0);
    expect(result.current.pendingCount).toBe(1);

    // Resolve the on-chain submission
    await act(async () => {
      resolveSubmit();
      await promise;
    });

    // Check confirmed state
    expect(result.current.mutations[0].status).toBe("confirmed");
    expect(result.current.mutations[0].confirmedAt).toBeGreaterThan(0);
    expect(result.current.pendingCount).toBe(0);
    expect(onRollback).not.toHaveBeenCalled();
  });

  it("should rollback automatically on failure", async () => {
    const error = new Error("On-chain error");
    const onChainSubmit = vi.fn().mockRejectedValue(error);
    const onRollback = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useEscrow(onChainSubmit, onRollback));

    await act(async () => {
      await result.current.submit("data-1");
    });

    // Check failed and rolled back state
    expect(result.current.mutations[0].status).toBe("failed");
    expect(result.current.mutations[0].error).toBe("On-chain error");
    expect(result.current.pendingCount).toBe(0);
    expect(onRollback).toHaveBeenCalledWith("data-1");
  });

  it("should allow manual rollback of pending mutation", async () => {
    let resolveSubmit!: () => void;
    const submitPromise = new Promise<void>((resolve) => {
      resolveSubmit = resolve;
    });
    const onChainSubmit = vi.fn().mockReturnValue(submitPromise);
    const onRollback = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useEscrow(onChainSubmit, onRollback));

    act(() => {
      result.current.submit("data-1");
    });

    const mutationId = result.current.mutations[0].id;
    expect(result.current.pendingCount).toBe(1);

    await act(async () => {
      result.current.rollback(mutationId);
    });

    // Check that manually rolled back status is idle
    expect(result.current.mutations[0].status).toBe("idle");
    expect(result.current.pendingCount).toBe(0);
    expect(onRollback).toHaveBeenCalledWith("data-1");

    // Even if onChainSubmit resolves afterwards, it should not confirm or execute again
    await act(async () => {
      resolveSubmit();
      await submitPromise;
    });

    expect(result.current.mutations[0].status).toBe("idle");
  });

  it("should allow retrying a failed mutation", async () => {
    const error = new Error("Temp error");
    let shouldFail = true;
    const onChainSubmit = vi.fn().mockImplementation(() => {
      if (shouldFail) {
        return Promise.reject(error);
      }
      return Promise.resolve();
    });
    const onRollback = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useEscrow(onChainSubmit, onRollback));

    // First attempt fails
    await act(async () => {
      await result.current.submit("data-retry");
    });

    expect(result.current.mutations[0].status).toBe("failed");
    expect(onRollback).toHaveBeenCalledTimes(1);

    // Second attempt succeeds
    shouldFail = false;
    await act(async () => {
      await result.current.retry(result.current.mutations[0].id);
    });

    expect(result.current.mutations[0].status).toBe("confirmed");
    expect(result.current.mutations[0].confirmedAt).toBeGreaterThan(0);
    expect(onRollback).toHaveBeenCalledTimes(1); // No new rollback
  });

  it("should store mutation history in state with max 50 entries", async () => {
    const onChainSubmit = vi.fn().mockResolvedValue(undefined);
    const onRollback = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useEscrow(onChainSubmit, onRollback));

    await act(async () => {
      for (let i = 0; i < 55; i++) {
        await result.current.submit(`data-${i}`);
      }
    });

    expect(result.current.mutations).toHaveLength(50);
    // The most recent should be at index 0 (data-54)
    expect(result.current.mutations[0].data).toBe("data-54");
    // The oldest kept should be data-5 (since 54 down to 5 is 50 items)
    expect(result.current.mutations[49].data).toBe("data-5");
  });
});
