# TaskManager Daemon Fix

## Issue

The coordinator was reporting: **"The APC daemon appears to be not functioning - `apc task list` failed with exit code 1"**

This error occurred when the coordinator tried to query tasks via the CLI, causing the daemon to respond with an error instead of returning task data.

## Root Cause

In `src/daemon/standalone.ts` (around line 303), the `taskManager` service proxy was registered using an **Immediately Invoked Function Expression (IIFE)**:

```typescript
taskManager: (() => {
    const tm = ServiceLocator.resolve(TaskManager);  // ← Resolved ONCE at daemon startup
    return {
        getProgressForSession: (sessionId: string) => { ... },
        // ... other methods using 'tm' variable
    };
})(),  // ← IIFE executes immediately
```

### Problems with this approach:

1. **Eager resolution**: The TaskManager was resolved once at object creation time, not when methods were called
2. **Initialization order dependency**: If anything went wrong during the initial resolve, the entire proxy would fail
3. **No error recovery**: Once the IIFE failed or returned undefined, subsequent API calls would see `taskManager` as undefined
4. **Race conditions**: The IIFE executed during the `ApiServices` object construction, which might happen before all services were fully initialized

When the API handler received a `task.list` request, it checked:

```typescript
private async handleTask(action: string, params: Record<string, unknown>): Promise<...> {
    if (!this.services.taskManager) {
        throw new Error('Task manager not available');  // ← This caused exit code 1
    }
    // ...
}
```

## Fix Applied

Changed from **eager resolution** (resolve once at startup) to **lazy resolution** (resolve on each method call):

```typescript
// Before (IIFE - eager resolution):
taskManager: (() => {
    const tm = ServiceLocator.resolve(TaskManager);
    return {
        getAllTasks: () => tm.getAllTasks(),
        // ...
    };
})(),

// After (lazy resolution):
taskManager: {
    getAllTasks: () => ServiceLocator.resolve(TaskManager).getAllTasks(),
    getProgressForSession: (sessionId: string) => {
        const tm = ServiceLocator.resolve(TaskManager);
        const progress = tm.getProgressForSession(sessionId);
        return {
            completed: progress.completed,
            // ... transformation
        };
    },
    // ... other methods
},
```

### Benefits of lazy resolution:

1. **No initialization order issues**: TaskManager is resolved when actually needed, not at daemon startup
2. **Better error recovery**: If TaskManager has a temporary issue, subsequent calls can still succeed
3. **Simpler code**: No IIFE wrapper, just plain object methods
4. **Consistent with other services**: Matches the pattern used for `roleRegistry` in the same file

## Files Changed

- `src/daemon/standalone.ts` (lines 301-330): Changed TaskManager proxy from IIFE to lazy resolution

## Testing

1. ✅ TypeScript compilation successful (no errors)
2. ✅ No linter errors
3. ✅ The fix ensures `taskManager` object always exists (not undefined)
4. ✅ Each method call resolves TaskManager dynamically, avoiding initialization issues

## Expected Behavior After Fix

When the coordinator runs `apc task list`, the daemon should:
1. Receive the `task.list` command
2. Route to `handleTask('list', params)`
3. Successfully resolve TaskManager via ServiceLocator on each call
4. Return task data (or empty array if no tasks exist)
5. **No longer throw "Task manager not available" error**

## Related Code Paths

- `src/daemon/ApiHandler.ts:919-996` - `handleTask()` method that checks for taskManager availability
- `src/services/DaemonBootstrap.ts:81` - TaskManager registration in ServiceLocator
- `src/daemon/standalone.ts:77-79` - TaskManager initialization and persisted task reload

## Prevention

To prevent similar issues in the future:
1. Use lazy resolution for all service proxies in ApiServices
2. Consider adding TypeScript types that enforce non-nullable service properties
3. Add daemon startup health checks that verify all services are resolvable
4. Add logging when ServiceLocator.resolve fails (currently silent)

## Date

2025-12-03


