# useRetryQueue Implementation Summary

## Overview
Implemented a robust transaction retry queue system for Soroban RPC transactions with automatic retry using exponential backoff and localStorage persistence.

## Key Features Implemented

### 1. Transaction State Management
- **States**: `pending` → `submitted` → `confirmed` | `failed`
- **Queue Structure**: Each transaction includes:
  - `id`: Unique transaction identifier
  - `txHash`: Transaction hash (null until submitted)
  - `status`: Current state of the transaction
  - `retryCount`: Number of retry attempts made
  - `maxRetries`: Maximum allowed retries (default: 5)
  - `error`: Error message from last failure
  - `createdAt`: Timestamp of transaction creation

### 2. Core Functions

#### `enqueue(id, maxRetries = 5)`
- Adds a new transaction to the queue
- Sets initial status to "pending"
- Prevents duplicate entries
- Transactions are added at the beginning of the queue

#### `updateTxHash(id, txHash)`
- Updates transaction hash
- Transitions status from "pending" to "submitted"

#### `markConfirmed(id)`
- Marks transaction as successfully confirmed
- Cleans up any pending retry timers

#### `markFailed(id, error)`
- Marks transaction as failed with error message
- **Auto-retry logic**:
  - If `retryCount < maxRetries`: schedules automatic retry
  - Uses exponential backoff delays: [1s, 5s, 15s, 30s, 60s]
  - Cleans up old timers before scheduling new ones
  - Else: permanently marks as failed

#### `retry(id)`
- Manually triggers immediate retry
- Cancels any scheduled auto-retry
- Increments retry count
- Resets status to "pending"

#### `purge()`
- Clears all transactions from queue
- Cancels all pending retry timers
- Resets localStorage

#### `pendingCount`
- Returns count of transactions in "pending" or "submitted" state
- Useful for UI loading indicators

### 3. Exponential Backoff
Retry delays follow this pattern:
- 1st retry: 1 second
- 2nd retry: 5 seconds
- 3rd retry: 15 seconds
- 4th retry: 30 seconds
- 5th+ retry: 60 seconds (capped)

### 4. localStorage Persistence
- Queue automatically persists to localStorage on every change
- Restores queue state on component mount
- Storage key: `retry-queue-state`
- Handles corrupt data gracefully
- Survives browser reloads

### 5. Timer Management
- Uses `useRef<Map<string, setTimeout>>` for active retry timers
- Proper cleanup on:
  - Component unmount
  - Transaction confirmation
  - Manual retry
  - Queue purge
- Prevents memory leaks

## Test Coverage

Created comprehensive test suite with 32 passing tests covering:

### Enqueue Tests (4 tests)
- Default and custom maxRetries
- Duplicate prevention
- Queue ordering

### UpdateTxHash Tests (2 tests)
- Status transition
- Transaction isolation

### MarkConfirmed Tests (2 tests)
- Status update
- Timer cleanup

### MarkFailed Tests (7 tests)
- Error message storage
- Auto-retry with exponential backoff (1s, 5s, 15s, 30s, 60s)
- Delay capping at 60s
- MaxRetries enforcement
- Timer management

### Retry Tests (3 tests)
- Manual retry trigger
- Timer cleanup
- Status reset

### Purge Tests (2 tests)
- Queue clearing
- Timer cleanup

### PendingCount Tests (4 tests)
- Pending status counting
- Submitted status counting
- Status exclusion (confirmed/failed)
- Dynamic updates

### localStorage Persistence Tests (5 tests)
- Queue persistence
- State restoration
- Corrupt data handling
- Missing data handling
- Purge synchronization

### Cleanup Tests (1 test)
- Unmount timer cleanup

### State Transition Tests (2 tests)
- Success flow: pending → submitted → confirmed
- Retry flow: pending → failed → pending → failed

## Technical Details

### Dependencies Added
- `vitest`: Test runner
- `@testing-library/react`: React testing utilities
- `@testing-library/jest-dom`: DOM matchers
- `jsdom`: Browser environment for tests
- `@vitejs/plugin-react`: Vite React plugin

### Configuration Files
- `vitest.config.ts`: Vitest configuration with jsdom environment
- `tests/setup.ts`: Test setup with localStorage mock

### Test Commands
- `npm test`: Run tests once
- `npm run test:watch`: Run tests in watch mode
- `npm run test:ui`: Run tests with UI

## Implementation Highlights

### Bug Fixes
1. **Fixed stale closure in markFailed**: Changed from reading `queue` state directly to using the callback form of `setQueue((prev) => ...)` to avoid stale state issues
2. **Added timer cleanup in markFailed**: Ensures old timers are cleaned up before scheduling new ones
3. **Proper localStorage serialization**: Handles SSR (server-side rendering) with `typeof window` check

### Best Practices
- Uses `useCallback` for stable function references
- Properly manages side effects with `useEffect`
- Cleans up timers on unmount
- Handles edge cases (duplicate transactions, corrupt localStorage)
- Type-safe with TypeScript
- Comprehensive test coverage

## Verification

✅ All 32 tests passing
✅ TypeScript compilation successful
✅ Next.js build successful
✅ No linting errors

## Usage Example

```typescript
import { useRetryQueue } from '@/hooks/useRetryQueue';

function MyComponent() {
  const { enqueue, updateTxHash, markConfirmed, markFailed, retry, queue, pendingCount } = useRetryQueue();

  const submitTransaction = async () => {
    const txId = 'tx-123';
    
    // Add to queue
    enqueue(txId, 5);
    
    try {
      const txHash = await submitToBlockchain();
      updateTxHash(txId, txHash);
      
      const result = await pollForConfirmation(txHash);
      markConfirmed(txId);
    } catch (error) {
      markFailed(txId, error.message);
      // Auto-retry will be scheduled
    }
  };

  const manualRetry = (txId: string) => {
    retry(txId);
    // Re-submit transaction logic here
  };

  return (
    <div>
      <div>Pending: {pendingCount}</div>
      {queue.map(tx => (
        <div key={tx.id}>
          {tx.id} - {tx.status} - Retries: {tx.retryCount}/{tx.maxRetries}
          {tx.status === 'failed' && <button onClick={() => manualRetry(tx.id)}>Retry</button>}
        </div>
      ))}
    </div>
  );
}
```

## Conclusion

The `useRetryQueue` hook is fully implemented according to the requirements with:
- Complete state management
- Automatic retry with exponential backoff
- localStorage persistence across browser reloads
- Comprehensive test coverage (32 tests)
- Production-ready code with proper error handling and cleanup
