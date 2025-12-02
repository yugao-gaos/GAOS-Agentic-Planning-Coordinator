# Unity Pipeline Broadcasting Implementation

## Overview
Added comprehensive broadcasting of Unity pipeline status changes to all connected clients (VSCode extensions, CLI, daemon API clients).

## Changes Made

### 1. New Event Types (`src/client/ClientEvents.ts`)

Added three new event types for Unity pipeline lifecycle:

#### `UnityPipelineStartedEventData`
Broadcast when a Unity pipeline begins execution.
```typescript
{
    pipelineId: string;
    sessionId?: string;
    operations: string[];  // e.g., ['prep', 'test_editmode']
    tasksInvolved: Array<{ taskId: string; description: string }>;
    startedAt: string;
}
```

#### `UnityPipelineProgressEventData`
Broadcast as each step in the pipeline executes.
```typescript
{
    pipelineId: string;
    sessionId?: string;
    currentStep: number;
    totalSteps: number;
    currentOperation: string;  // e.g., 'prep', 'test_editmode'
    percentage: number;
    timestamp: string;
}
```

#### `UnityPipelineCompletedEventData`
Broadcast when pipeline completes (success or failure).
```typescript
{
    pipelineId: string;
    sessionId?: string;
    success: boolean;
    failedAtStep?: string;
    operations: string[];
    errors: Array<{ message: string; source?: string }>;
    testFailures: Array<{ test: string; message: string }>;
    tasksInvolved: Array<{ taskId: string; description: string }>;
    duration: number;
    completedAt: string;
}
```

### 2. EventBroadcaster Methods (`src/daemon/EventBroadcaster.ts`)

Added convenience methods for broadcasting pipeline events:

```typescript
unityPipelineStarted(pipelineId, operations, tasksInvolved, sessionId?)
unityPipelineProgress(pipelineId, currentStep, totalSteps, currentOperation, sessionId?)
unityPipelineCompleted(pipelineId, success, operations, errors, testFailures, tasksInvolved, duration, failedAtStep?, sessionId?)
```

### 3. UnityControlManager Updates (`src/services/UnityControlManager.ts`)

#### Added EventBroadcaster Import
```typescript
import { EventBroadcaster } from '../daemon/EventBroadcaster';
```

#### Modified `processPipelineQueue()`
- Broadcasts `unity.pipelineStarted` when pipeline begins
- Broadcasts `unity.pipelineProgress` for each step
- Tracks pipeline duration

#### Modified `notifyPipelineComplete()`
- Broadcasts `unity.pipelineCompleted` with full results
- Includes errors, test failures, and duration
- Logs successful broadcast confirmation

## What "Unity Pipeline Failed" Means

When you see **"Unity pipeline failed"**, it means:

1. **NOT a system error** - The pipeline execution completed successfully
2. **Unity console errors detected** - After recompilation, Unity reported errors in the console
3. **Fail-fast behavior** - Pipeline stops at first failing operation:
   - `prep` - Compilation errors detected
   - `test_editmode` - EditMode tests failed
   - `test_playmode` - PlayMode tests failed

The pipeline result includes:
- `success: false` - At least one operation failed
- `failedAtStep` - Which operation failed (e.g., "test_editmode")
- `allErrors` - Array of Unity console errors
- `allTestFailures` - Array of test failures with details

## Broadcasting Benefits

### Multi-Client Support
All connected clients now receive real-time Unity pipeline updates:
- **VSCode Extension** - Sidebar shows pipeline progress
- **CLI Clients** - Can monitor pipeline status
- **Multiple VSCode Windows** - All stay in sync

### Event Flow Example

```
Client A (VSCode)          Daemon                    Client B (TUI)
      |                      |                              |
      |  <-- unity.pipelineStarted --                      |
      |                      |                              |
      |  <-- unity.pipelineProgress (prep, 50%) --         |
      |                      |                              |
      |  <-- unity.pipelineProgress (test_editmode, 100%) -|
      |                      |                              |
      |  <-- unity.pipelineCompleted (success: false) --   |
      |      { errors: [...], failedAtStep: "test_editmode" }
```

## GUI Integration

The sidebar should now receive pipeline events via WebSocket. Update `SidebarViewProvider.ts` to listen for:

```typescript
// In daemon's WebSocket handler or DaemonStateProxy
client.on('unity.pipelineStarted', (data) => {
    // Show pipeline notification in sidebar
    // Update Unity status section
});

client.on('unity.pipelineProgress', (data) => {
    // Update progress bar: data.percentage
    // Show current step: data.currentOperation
});

client.on('unity.pipelineCompleted', (data) => {
    // Show success/failure notification
    // If failed: display errors and failedAtStep
    // Update Unity status back to idle
});
```

## Testing

To test broadcasting:

1. **Start daemon** with multiple clients connected
2. **Trigger a task workflow** that uses Unity pipeline
3. **Monitor both clients** - both should see:
   - Pipeline start notification
   - Step-by-step progress
   - Completion with results

### Test Scenario

```bash
# Terminal 1: Start daemon
apc daemon start

# Terminal 2: Connect CLI client
apc-ws-client.js

# Terminal 3 (or VSCode): Start a task
apc task start --session ps_001 --id T1 --workflow task_implementation
```

Both Terminal 2 and VSCode sidebar should show Unity pipeline events in real-time.

## Next Steps

### 1. Add Unity Editor Focus (Optional)
Would you like Unity editor window to automatically focus when pipeline starts? This helps developers see compilation/test errors immediately.

```typescript
// In processPipelineQueue(), after broadcasting start:
if (shouldFocusUnity) {
    await this.focusUnityEditor();
}
```

### 2. GUI Event Handling
Update `src/ui/SidebarViewProvider.ts` or `src/services/DaemonStateProxy.ts` to:
- Subscribe to new Unity pipeline events
- Display pipeline status in Unity section
- Show progress bar during pipeline execution
- Display errors when pipeline fails

### 3. Notification System
Consider adding VS Code notifications for:
- Pipeline completion (success)
- Pipeline failure (with error summary)
- Long-running pipelines (> 1 minute)

## Related Files

- Event types: `src/client/ClientEvents.ts`
- Broadcasting: `src/daemon/EventBroadcaster.ts`
- Pipeline execution: `src/services/UnityControlManager.ts`
- GUI updates needed: `src/ui/SidebarViewProvider.ts`
- Protocol types: `src/client/Protocol.ts`

## Troubleshooting

### Pipeline events not appearing in GUI?

1. Check WebSocket connection is active
2. Verify EventBroadcaster is registered in daemon
3. Check browser console for event reception
4. Ensure DaemonStateProxy forwards Unity events

### Events showing in one client but not another?

- Both clients must subscribe to Unity events
- Check session filtering (pipeline events are session-scoped)
- Verify broadcast handler is registered in daemon

### "Broadcaster may not be available" warning?

This is normal during tests or when running UnityControlManager standalone. In production, EventBroadcaster is always available via ServiceLocator.

