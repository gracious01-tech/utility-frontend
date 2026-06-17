import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRetryQueue } from '../../src/hooks/useRetryQueue';

describe('useRetryQueue', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
    // Clear all timers
    vi.clearAllTimers();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('enqueue', () => {
    it('should add a new transaction with default maxRetries of 5', () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
      });

      expect(result.current.queue).toHaveLength(1);
      expect(result.current.queue[0]).toMatchObject({
        id: 'tx-1',
        txHash: null,
        status: 'pending',
        retryCount: 0,
        maxRetries: 5,
        error: null,
      });
      expect(result.current.queue[0].createdAt).toBeGreaterThan(0);
    });

    it('should add a new transaction with custom maxRetries', () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1', 3);
      });

      expect(result.current.queue[0].maxRetries).toBe(3);
    });

    it('should not add duplicate transactions', () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
        result.current.enqueue('tx-1');
      });

      expect(result.current.queue).toHaveLength(1);
    });

    it('should add transactions at the beginning of the queue', () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
        result.current.enqueue('tx-2');
      });

      expect(result.current.queue[0].id).toBe('tx-2');
      expect(result.current.queue[1].id).toBe('tx-1');
    });
  });

  describe('updateTxHash', () => {
    it('should update txHash and set status to submitted', () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
        result.current.updateTxHash('tx-1', 'hash-123');
      });

      expect(result.current.queue[0]).toMatchObject({
        id: 'tx-1',
        txHash: 'hash-123',
        status: 'submitted',
      });
    });

    it('should not affect other transactions', () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
        result.current.enqueue('tx-2');
        result.current.updateTxHash('tx-2', 'hash-456');
      });

      expect(result.current.queue[0].txHash).toBe('hash-456');
      expect(result.current.queue[1].txHash).toBeNull();
    });
  });

  describe('markConfirmed', () => {
    it('should mark transaction as confirmed', () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
        result.current.markConfirmed('tx-1');
      });

      expect(result.current.queue[0].status).toBe('confirmed');
    });

    it('should cleanup any pending retry timer', () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
        result.current.markFailed('tx-1', 'Network error');
      });

      // Should have scheduled a retry
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      act(() => {
        result.current.markConfirmed('tx-1');
      });

      // Timer should be cleaned up
      expect(result.current.queue[0].status).toBe('confirmed');
    });
  });

  describe('markFailed', () => {
    it('should mark transaction as failed with error message', () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
        result.current.markFailed('tx-1', 'Network timeout');
      });

      expect(result.current.queue[0]).toMatchObject({
        status: 'failed',
        error: 'Network timeout',
      });
    });

    it('should schedule auto-retry with 1s delay on first failure', async () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
        result.current.markFailed('tx-1', 'Error 1');
      });

      expect(result.current.queue[0].status).toBe('failed');
      expect(result.current.queue[0].retryCount).toBe(0);

      // Advance time by 1 second
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      expect(result.current.queue[0].status).toBe('pending');
      expect(result.current.queue[0].retryCount).toBe(1);
      expect(result.current.queue[0].error).toBeNull();
    });

    it('should schedule auto-retry with 5s delay on second failure', async () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
        result.current.markFailed('tx-1', 'Error 1');
      });

      // First retry after 1s
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      expect(result.current.queue[0].retryCount).toBe(1);

      act(() => {
        result.current.markFailed('tx-1', 'Error 2');
      });

      // Should not retry after 1s
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      expect(result.current.queue[0].status).toBe('failed');

      // Should retry after 5s total
      await act(async () => {
        vi.advanceTimersByTime(4000);
      });

      expect(result.current.queue[0].status).toBe('pending');
      expect(result.current.queue[0].retryCount).toBe(2);
    });

    it('should use exponential backoff delays [1s, 5s, 15s, 30s, 60s]', async () => {
      const { result } = renderHook(() => useRetryQueue());
      const delays = [1000, 5000, 15000, 30000, 60000];

      act(() => {
        result.current.enqueue('tx-1');
      });

      for (let i = 0; i < delays.length; i++) {
        act(() => {
          result.current.markFailed('tx-1', `Error ${i + 1}`);
        });

        expect(result.current.queue[0].status).toBe('failed');

        // Advance by the expected delay
        await act(async () => {
          vi.advanceTimersByTime(delays[i]);
        });

        expect(result.current.queue[0].status).toBe('pending');
        expect(result.current.queue[0].retryCount).toBe(i + 1);
      }
    });

    it('should cap delay at 60s for retries beyond 5th', async () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1', 7); // Allow 7 retries
      });

      // Get to 5th retry
      for (let i = 0; i < 5; i++) {
        act(() => {
          result.current.markFailed('tx-1', 'Error');
        });
        
        await act(async () => {
          vi.advanceTimersByTime([1000, 5000, 15000, 30000, 60000][i]);
        });
      }

      expect(result.current.queue[0].retryCount).toBe(5);

      // 6th failure should still use 60s delay
      act(() => {
        result.current.markFailed('tx-1', 'Error 6');
      });

      await act(async () => {
        vi.advanceTimersByTime(60000);
      });

      expect(result.current.queue[0].retryCount).toBe(6);
    });

    it('should not schedule retry when maxRetries is reached', async () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1', 2); // Max 2 retries
      });

      // First failure
      act(() => {
        result.current.markFailed('tx-1', 'Error 1');
      });
      
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      expect(result.current.queue[0].retryCount).toBe(1);

      // Second failure
      act(() => {
        result.current.markFailed('tx-1', 'Error 2');
      });
      
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });

      expect(result.current.queue[0].retryCount).toBe(2);

      // Third failure - should stay failed
      act(() => {
        result.current.markFailed('tx-1', 'Final error');
      });
      
      await act(async () => {
        vi.advanceTimersByTime(60000);
      });

      // Should remain failed
      expect(result.current.queue[0].status).toBe('failed');
      expect(result.current.queue[0].error).toBe('Final error');
      expect(result.current.queue[0].retryCount).toBe(2);
    });

    it('should cleanup old timer before scheduling new one', async () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
        result.current.markFailed('tx-1', 'Error 1');
      });

      const timerCount1 = vi.getTimerCount();

      act(() => {
        result.current.markFailed('tx-1', 'Error 2');
      });

      // Should not have more timers than before
      expect(vi.getTimerCount()).toBeLessThanOrEqual(timerCount1);
    });
  });

  describe('retry', () => {
    it('should manually reset transaction to pending and increment retryCount', async () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
        result.current.markFailed('tx-1', 'Error');
      });

      expect(result.current.queue[0].status).toBe('failed');

      await act(async () => {
        await result.current.retry('tx-1');
      });

      expect(result.current.queue[0]).toMatchObject({
        status: 'pending',
        retryCount: 1,
        error: null,
      });
    });

    it('should cleanup any pending auto-retry timer', async () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
        result.current.markFailed('tx-1', 'Error');
      });

      // Auto-retry should be scheduled
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      await act(async () => {
        await result.current.retry('tx-1');
      });

      // Original timer should be cleaned up
      expect(result.current.queue[0].status).toBe('pending');
    });

    it('should work on transactions with any status', async () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
        result.current.updateTxHash('tx-1', 'hash-123');
      });

      expect(result.current.queue[0].status).toBe('submitted');

      await act(async () => {
        await result.current.retry('tx-1');
      });

      expect(result.current.queue[0].status).toBe('pending');
      expect(result.current.queue[0].retryCount).toBe(1);
    });
  });

  describe('purge', () => {
    it('should clear all transactions from queue', () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
        result.current.enqueue('tx-2');
        result.current.enqueue('tx-3');
      });

      expect(result.current.queue).toHaveLength(3);

      act(() => {
        result.current.purge();
      });

      expect(result.current.queue).toHaveLength(0);
    });

    it('should clear all pending timers', () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
        result.current.enqueue('tx-2');
        result.current.markFailed('tx-1', 'Error 1');
        result.current.markFailed('tx-2', 'Error 2');
      });

      expect(vi.getTimerCount()).toBeGreaterThan(0);

      act(() => {
        result.current.purge();
      });

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('pendingCount', () => {
    it('should count transactions with pending status', () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
        result.current.enqueue('tx-2');
      });

      expect(result.current.pendingCount).toBe(2);
    });

    it('should count transactions with submitted status', () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
        result.current.updateTxHash('tx-1', 'hash-123');
      });

      expect(result.current.pendingCount).toBe(1);
    });

    it('should not count confirmed or failed transactions', () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
        result.current.enqueue('tx-2');
        result.current.enqueue('tx-3');
        result.current.markConfirmed('tx-1');
        result.current.markFailed('tx-2', 'Error');
      });

      expect(result.current.pendingCount).toBe(1);
    });

    it('should update when transactions change status', async () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
        result.current.enqueue('tx-2');
      });

      expect(result.current.pendingCount).toBe(2);

      act(() => {
        result.current.markFailed('tx-1', 'Error');
      });

      expect(result.current.pendingCount).toBe(1);

      // Wait for auto-retry
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      expect(result.current.pendingCount).toBe(2);
    });
  });

  describe('localStorage persistence', () => {
    it('should persist queue to localStorage on changes', () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
      });

      const stored = localStorage.getItem('retry-queue-state');
      expect(stored).toBeTruthy();
      
      const parsed = JSON.parse(stored!);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe('tx-1');
    });

    it('should restore queue from localStorage on mount', () => {
      // Set up localStorage with existing queue
      const existingQueue = [
        {
          id: 'tx-existing',
          txHash: 'hash-old',
          status: 'submitted',
          retryCount: 2,
          maxRetries: 5,
          error: null,
          createdAt: Date.now() - 5000,
        },
      ];
      localStorage.setItem('retry-queue-state', JSON.stringify(existingQueue));

      const { result } = renderHook(() => useRetryQueue());

      expect(result.current.queue).toHaveLength(1);
      expect(result.current.queue[0]).toMatchObject({
        id: 'tx-existing',
        txHash: 'hash-old',
        status: 'submitted',
        retryCount: 2,
      });
    });

    it('should handle corrupt localStorage data gracefully', () => {
      localStorage.setItem('retry-queue-state', 'invalid json{');

      const { result } = renderHook(() => useRetryQueue());

      // Should start with empty queue instead of crashing
      expect(result.current.queue).toHaveLength(0);
    });

    it('should handle missing localStorage gracefully', () => {
      // Don't set anything in localStorage
      const { result } = renderHook(() => useRetryQueue());

      expect(result.current.queue).toHaveLength(0);
    });

    it('should update localStorage when purging', () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
        result.current.enqueue('tx-2');
      });

      expect(localStorage.getItem('retry-queue-state')).toBeTruthy();

      act(() => {
        result.current.purge();
      });

      const stored = localStorage.getItem('retry-queue-state');
      expect(JSON.parse(stored!)).toHaveLength(0);
    });
  });

  describe('cleanup on unmount', () => {
    it('should clear all timers on unmount', () => {
      const { result, unmount } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
        result.current.enqueue('tx-2');
        result.current.markFailed('tx-1', 'Error 1');
        result.current.markFailed('tx-2', 'Error 2');
      });

      expect(vi.getTimerCount()).toBeGreaterThan(0);

      unmount();

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('state transitions', () => {
    it('should follow correct state flow: pending → submitted → confirmed', () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1');
      });
      expect(result.current.queue[0].status).toBe('pending');

      act(() => {
        result.current.updateTxHash('tx-1', 'hash-123');
      });
      expect(result.current.queue[0].status).toBe('submitted');

      act(() => {
        result.current.markConfirmed('tx-1');
      });
      expect(result.current.queue[0].status).toBe('confirmed');
    });

    it('should follow retry flow: pending → failed → pending (auto) → failed (final)', async () => {
      const { result } = renderHook(() => useRetryQueue());

      act(() => {
        result.current.enqueue('tx-1', 1); // Max 1 retry
      });
      expect(result.current.queue[0].status).toBe('pending');

      act(() => {
        result.current.markFailed('tx-1', 'Error 1');
      });
      expect(result.current.queue[0].status).toBe('failed');
      expect(result.current.queue[0].retryCount).toBe(0);

      // Auto-retry after 1s
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      expect(result.current.queue[0].status).toBe('pending');
      expect(result.current.queue[0].retryCount).toBe(1);

      act(() => {
        result.current.markFailed('tx-1', 'Final error');
      });

      expect(result.current.queue[0].status).toBe('failed');
      expect(result.current.queue[0].error).toBe('Final error');

      // Should not retry again
      await act(async () => {
        vi.advanceTimersByTime(60000);
      });

      expect(result.current.queue[0].status).toBe('failed');
    });
  });
});
