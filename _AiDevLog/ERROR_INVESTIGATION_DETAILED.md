# Detailed Error Investigation - December 2, 2025

## Executive Summary

After deep investigation of the daemon errors, I've identified the root causes and mapped out the workflow lifecycle issues. The errors are **NOT critical** but indicate synchronization gaps between the UI and the daemon's workflow lifecycle management.

## Key Findings

### 1. Workflow Lifecycle and Memory Management

**Discovery:** Workflows are kept in memory with a 1-hour TTL after completion (`cleanupCompletedWorkflows`):

```typescript:1380:1405:src/services/UnifiedCoordinatorService.ts
private cleanupCompletedWorkflows(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    
    let cleaned = 0;
    const now = Date.now();
    const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
    
    for (const [workflowId, workflow] of state.workflows) {
        const status = workflow.getStatus();
        if (status === 'completed' || status === 'cancelled' || status === 'failed') {
            // Check age - only cleanup if completed more than an hour ago
            // This keeps recent completions available for inspection
            const progress = workflow.getProgress();
            const completedAt = new Date(progress.updatedAt).getTime();
            
            if (now - completedAt > MAX_AGE_MS) {
                // Dispose workflow before removing to clean up event listeners
                workflow.dispose();
                state.workflows.delete(workflowId);
                cleaned++;
            }
        }
    }
```

**Root Cause of "Workflow Not Found" Error:**
- UI components store workflow IDs and periodically query for status
- When a workflow is completed, it stays in the `workflows` Map for 1 hour
- After 1 hour, `cleanupCompletedWorkflows()` removes it
- **BUT**: The UI still has the workflow ID cached and tries to query it
- The API handler tries to look it up → **"Workflow not found"** error

**Why This Happens:**
1. User leaves VS Code open for >1 hour after a workflow completes
2. UI refreshes (on window focus, periodic refresh, etc.)
3. UI sends `workflow.status` request for the old workflow ID
4. Workflow has been cleaned up from memory
5. Error logged

### 2. Workflow Progress Polling

Looking at the UI code:

```typescript:87:111:src/ui/SidebarViewProvider.ts
private subscribeToWorkflowEvents(): void {
    try {
        this.unifiedCoordinator = ServiceLocator.resolve(UnifiedCoordinatorService);
        
        // Subscribe to workflow progress updates
        this.disposables.push(
            this.unifiedCoordinator.onWorkflowProgress((_progress: WorkflowProgress) => {
                // Debounced refresh to avoid UI flicker
                this.debouncedRefresh();
            })
        );
        
        // Subscribe to session state changes
        this.disposables.push(
            this.unifiedCoordinator.onSessionStateChanged((_sessionId: string) => {
                this.debouncedRefresh();
            })
        );
        
        console.log('[SidebarViewProvider] Subscribed to workflow events');
    } catch (e) {
        // UnifiedCoordinatorService may not be initialized yet
        console.log('[SidebarViewProvider] UnifiedCoordinatorService not yet available');
    }
}
```

The UI subscribes to events but **also does periodic refreshes** (debounced). During a refresh, it queries status for all workflows it knows about, including ones that might have been cleaned up.

### 3. Unstaged Changes Analysis

The git diff shows that `taskId` was added to `WorkflowProgress`:

```diff
+    taskId?: string;         // Task ID for task_implementation/error_resolution workflows
```

And `BaseWorkflow.getProgress()` was updated to extract the taskId from workflow input:

```typescript:283:316:src/services/workflows/BaseWorkflow.ts
getProgress(): WorkflowProgress {
    const phases = this.getPhases();
    
    // Extract taskId from input for task workflows
    let taskId: string | undefined;
    if (this.type === 'task_implementation' && 'taskId' in this.input) {
        taskId = this.input.taskId as string;
    } else if (this.type === 'error_resolution' && 'errors' in this.input) {
        // For error resolution, try to get taskId from the first error's relatedTaskId
        const errors = this.input.errors as Array<{ relatedTaskId?: string }>;
        taskId = errors[0]?.relatedTaskId;
    }
    
    return {
        workflowId: this.id,
        type: this.type,
        status: this.status,
        phase: phases[this.phaseIndex] || 'unknown',
        phaseIndex: this.phaseIndex,
        totalPhases: phases.length,
        percentage: phases.length > 0 
            ? (this.phaseIndex / phases.length) * 100 
            : 0,
        message: this.getProgressMessage(),
        startedAt: this.startTime > 0 
            ? new Date(this.startTime).toISOString() 
            : '',
        updatedAt: new Date().toISOString(),
        taskId,
        logPath: this.workflowLogPath
    };
}
```

**Impact:** These changes are good - they allow the UI to display which task a workflow is working on. The changes themselves are NOT causing the errors we're seeing.

### 4. Client Connection Churn

Looking at the connection handling in `ApcClient.ts`:

```typescript:366:389:src/client/ApcClient.ts
protected async attemptReconnect(): Promise<void> {
    if (!this.options.autoReconnect) {
        return;
    }
    
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
        this.setState('error');
        this.emit('error', new Error('Max reconnect attempts reached'));
        return;
    }
    
    this.reconnectAttempts++;
    this.setState('reconnecting');
    
    await this.delay(this.options.reconnectDelay * this.reconnectAttempts);
    
    try {
        await this.connect();
        this.reconnectAttempts = 0;
    } catch (err) {
        console.warn(`Reconnect attempt ${this.reconnectAttempts} failed:`, err);
        this.attemptReconnect();
    }
}
```

The reconnect logic has exponential backoff (`reconnectDelay * reconnectAttempts`), so the first retry is immediate (1s), second is 2s, etc.

**Root Cause of Rapid Connections:**
- Multiple VS Code windows/instances for the same workspace
- Each instance tries to connect to the same daemon
- WebSocket close code 1005 indicates normal closure (not an error)
- This suggests clients are connecting, checking something, then immediately disconnecting

Looking at the DaemonManager:

```typescript:159:181:src/vscode/DaemonManager.ts
async ensureDaemonRunning(): Promise<EnsureDaemonResult> {
    if (this.isDaemonRunning()) {
        const port = this.getDaemonPort();
        if (port) {
            // Daemon already running - check if we started it
            const isOurs = this.daemonProcess !== null;
            console.log(`[DaemonManager] Daemon already running on port ${port} (${isOurs ? 'ours' : 'external'})`);
            return { 
                port, 
                wasStarted: false,
                isExternal: !isOurs
            };
        }
    }
    
    // Need to start daemon
    const port = await this.startDaemon();
    return { 
        port, 
        wasStarted: true,
        isExternal: false
    };
}
```

**Hypothesis:** VS Code extension might be calling `ensureDaemonRunning()` multiple times during activation/window focus, and each call creates a temporary client connection to check health.

## Recommendations

### Immediate Fixes

1. **UI: Clear stale workflow references when workflow completes**

Add a handler in `SidebarViewProvider.ts`:

```typescript
eventSubscriptions.push(
    vsCodeClient.subscribe('workflow.completed', (data: any) => {
        // Remove workflow from tracked workflows to prevent stale queries
        this.trackedWorkflows.delete(data.workflowId);
        this.refresh();
    })
);
```

2. **API Handler: Return graceful response for missing workflows**

In `ApiHandler.ts` around line 689, change error handling:

```typescript
case 'status': {
    const progress = this.services.coordinator.getWorkflowStatus(params.sessionId as string, params.workflowId as string);
    if (!progress) {
        // Instead of throwing error, return a special "not_found" response
        return { 
            data: { 
                workflowId: params.workflowId, 
                status: 'not_found',
                message: 'Workflow completed and cleaned up' 
            } 
        };
    }
    return { data: progress };
}
```

3. **Coordinator: Emit workflow removal events**

When cleaning up workflows, broadcast an event so UI can update:

```typescript
private cleanupCompletedWorkflows(sessionId: string): void {
    // ... existing code ...
    
    if (cleaned > 0) {
        this.log(`Cleaned up ${cleaned} old completed workflows`);
        
        // Broadcast cleanup event so UI can update its tracked workflows
        try {
            const broadcaster = ServiceLocator.resolve(EventBroadcaster);
            broadcaster.broadcast('workflows.cleaned', {
                sessionId,
                cleanedCount: cleaned
            }, sessionId);
        } catch (e) {
            // Ignore if broadcaster not available
        }
    }
}
```

### Medium-Term Improvements

4. **Add Workflow Query Cache**

Implement a simple cache in the UI to avoid repeated queries:

```typescript
// Cache workflow status for 5 seconds
private workflowStatusCache = new Map<string, { status: any; timestamp: number }>();

async getWorkflowStatus(workflowId: string): Promise<any> {
    const cached = this.workflowStatusCache.get(workflowId);
    if (cached && Date.now() - cached.timestamp < 5000) {
        return cached.status;
    }
    
    try {
        const status = await this.client.send('workflow.status', { workflowId });
        this.workflowStatusCache.set(workflowId, { status, timestamp: Date.now() });
        return status;
    } catch (e) {
        // If not found, cache the "not found" state to avoid repeated queries
        if (e.message.includes('not found')) {
            this.workflowStatusCache.set(workflowId, { 
                status: { status: 'not_found' }, 
                timestamp: Date.now() 
            });
        }
        throw e;
    }
}
```

5. **Connection Pooling**

Implement singleton pattern for daemon connections in VS Code:

```typescript
// In extension.ts
let globalDaemonConnection: VsCodeClient | null = null;

export function getOrCreateDaemonConnection(): VsCodeClient {
    if (!globalDaemonConnection) {
        globalDaemonConnection = new VsCodeClient({ clientId: 'vscode-main' });
    }
    return globalDaemonConnection;
}
```

6. **Add Client Identification**

Enhance client logging to identify duplicate connections:

```typescript
// In VsCodeClient.ts constructor:
constructor(options: VsCodeClientOptions = {}) {
    super({
        ...options,
        clientId: `vscode-${process.pid}-${Date.now()}`  // Include process PID
    });
    this.showNotifications = options.showNotifications ?? true;
}
```

### Long-Term Architectural Improvements

7. **Workflow Lifecycle State Machine**

Implement explicit states:
- `active` → can be queried normally
- `completed_recent` → completed <1 hour ago, queryable
- `archived` → completed >1 hour ago, moved to history DB
- `removed` → explicitly removed by user

8. **Separate History Service**

Move completed workflows to a persistent history store:
- SQLite database or JSON file per session
- Query from history when workflow not in active map
- UI can display full history without memory overhead

9. **Metrics and Monitoring**

Add metrics to track:
- Number of "workflow not found" errors per hour
- Client connection churn rate
- Workflow cleanup frequency
- UI refresh rate

## Testing Plan

### To Verify Fixes

1. **Test workflow cleanup:**
   ```bash
   # Start a session, complete a workflow
   apc plan new "test" && apc plan approve <id>
   apc exec start <id>
   # Wait for workflow to complete
   # Change system time to +2 hours
   # Refresh UI → should not error
   ```

2. **Test rapid reconnection:**
   ```bash
   # Open multiple VS Code windows for same workspace
   # Monitor daemon logs for connection patterns
   # Should see stable connections, not rapid connect/disconnect
   ```

3. **Test stale workflow queries:**
   ```bash
   # Leave VS Code open overnight with completed workflows
   # Focus window next morning
   # Check daemon logs for "workflow not found" errors
   ```

## Metrics for Success

- [ ] Zero "workflow not found" errors in normal operation
- [ ] <5 client reconnects per hour (vs current ~20+)
- [ ] Workflow cleanup events successfully broadcasted
- [ ] UI correctly handles archived workflows
- [ ] No memory leaks from uncleaned workflow references

## Related Files

- `src/services/UnifiedCoordinatorService.ts` - Workflow lifecycle
- `src/ui/SidebarViewProvider.ts` - UI refresh logic
- `src/daemon/ApiHandler.ts` - API error handling
- `src/client/ApcClient.ts` - Reconnection logic
- `src/vscode/DaemonManager.ts` - Connection pooling
- `src/daemon/EventBroadcaster.ts` - Event system

## Timeline

- **Day 1:** Implement immediate fixes (graceful not-found handling, CLI fix ✅)
- **Day 2:** Add workflow cleanup events and UI handlers
- **Day 3:** Implement status cache and connection pooling
- **Week 2:** Design and implement history service
- **Week 3:** Add metrics and monitoring

## Conclusion

The errors are **symptoms of normal operation** in a long-running system:
1. Workflows complete and age out
2. UI retains stale references
3. Queries for cleaned-up workflows fail

The system is **working as designed**, but needs better **lifecycle synchronization** between coordinator (backend) and UI (frontend). The recommended fixes will eliminate these errors and improve the user experience.


