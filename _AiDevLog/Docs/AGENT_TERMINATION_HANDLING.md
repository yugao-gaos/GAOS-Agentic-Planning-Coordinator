# Agent Termination Handling

## Overview

This document describes how the system handles unexpected agent terminations (external kills, crashes, stuck processes) through proper separation of concerns between `ProcessManager` and workflow classes.

## Architecture

### Separation of Concerns

1. **ProcessManager** - Responsible for:
   - Process lifecycle management
   - Health monitoring (stuck detection, timeout detection)
   - Process group killing (reliable cleanup)
   - Orphan process detection
   - Cross-platform process management

2. **BaseWorkflow** - Responsible for:
   - Agent task orchestration
   - Workflow state management
   - Agent allocation/release
   - Responding to process health events
   - Continuation context management

3. **CursorAgentRunner** - Responsible for:
   - Running cursor CLI agents
   - Output parsing and streaming
   - Process registration with ProcessManager
   - Exit event handling

## How It Works

### 1. Agent Process Registration

When a workflow starts an agent:

```typescript
// In BaseWorkflow.runAgentTaskWithCallback()
const agentPromise = agentRunner.run({
    id: runId,
    prompt: enhancedPrompt,
    metadata: {
        roleId,
        coordinatorId: this.id,
        sessionId: this.sessionId,
        taskId,
        agentName,
        workflowType: this.type
    }
});
```

The `CursorAgentRunner.run()` automatically registers the process with ProcessManager:

```typescript
// In CursorAgentRunner.run()
this.processManager.registerExternalProcess(id, proc, {
    command: 'cursor',
    args: ['agent', '--model', model],
    cwd,
    metadata: { ...metadata, model, promptFile, managedByCursorAgentRunner: true }
});
```

### 2. ProcessManager Monitoring

ProcessManager monitors all registered processes:
- **Health checks every 30 seconds** - detects stuck processes (no output for 5+ minutes)
- **Timeout tracking** - enforces max runtime (default 1 hour)
- **Exit event monitoring** - tracks process lifecycle

### 3. Workflow Callbacks

Workflows subscribe to ProcessManager events in their constructor:

```typescript
// In BaseWorkflow.setupProcessManagerMonitoring()
const stuckCallbackId = this.processManager.onProcessStuck((processId, state) => {
    if (processId.startsWith(this.id) && this.currentAgentRunId === processId) {
        this.handleAgentUnexpectedTermination(processId, 'health_check_failed', state);
    }
});

const timeoutCallbackId = this.processManager.onProcessTimeout((processId, state) => {
    if (processId.startsWith(this.id) && this.currentAgentRunId === processId) {
        this.handleAgentUnexpectedTermination(processId, 'timeout', state);
    }
});
```

### 4. Termination Handling

When ProcessManager detects an issue, the workflow receives notification:

```typescript
// In BaseWorkflow.handleAgentUnexpectedTermination()
private handleAgentUnexpectedTermination(
    runId: string,
    reason: 'external_kill' | 'timeout' | 'error' | 'health_check_failed',
    processState?: ProcessState
): void {
    // Log the issue
    this.log(`❌ Agent terminated unexpectedly: ${reason}`);
    
    // Fire event for UI/monitoring
    this.onAgentTerminated.fire({
        agentName: agentName || 'unknown',
        runId,
        reason,
        phase: phaseName
    });
    
    // Clear tracking so we don't wait for it
    if (this.currentAgentRunId === runId) {
        this.currentAgentRunId = undefined;
    }
    
    // Note: The agentRunner.run() Promise will reject,
    // which will be caught by the workflow's try-catch
}
```

## Termination Scenarios

### Scenario 1: External Kill (e.g., `kill -9`)

**Timeline:**
1. User/system kills agent process externally
2. Process exit event fires in CursorAgentRunner
3. ProcessManager health check (next 30s interval) detects process is gone
4. ProcessManager fires `onProcessStuck` callback (since process stopped producing output)
5. Workflow receives callback, logs termination, fires `onAgentTerminated` event
6. AgentRunner's Promise rejects with error
7. Workflow's phase execution catches error and can retry or fail gracefully

**Result:** Workflow detects termination within 30 seconds, fails cleanly

### Scenario 2: Agent Hangs/Stuck

**Timeline:**
1. Agent process alive but not producing output
2. ProcessManager health check detects no output for 5+ minutes
3. ProcessManager fires `onProcessStuck` callback
4. Workflow receives callback, logs warning, fires `onAgentTerminated` event
5. ProcessManager can kill the stuck process (if configured)
6. Workflow can retry or fail gracefully

**Result:** Workflow detects stuck agent within 5 minutes, can take action

### Scenario 3: Timeout Exceeded

**Timeline:**
1. Agent runs longer than timeout (default 1 hour)
2. ProcessManager timeout timer fires
3. ProcessManager kills the process
4. ProcessManager fires `onProcessTimeout` callback
5. Workflow receives callback, logs timeout, fires `onAgentTerminated` event
6. AgentRunner's Promise rejects with timeout error
7. Workflow's phase execution catches error

**Result:** Workflow enforces timeout, fails cleanly

### Scenario 4: Normal Exit with Error Code

**Timeline:**
1. Agent exits with non-zero exit code
2. Process exit event fires in CursorAgentRunner
3. AgentRunner's Promise rejects with error
4. Workflow's phase execution catches error and handles it
5. No ProcessManager callback needed (normal exit, not hung/stuck)

**Result:** Workflow handles error through normal exception flow

## Events Fired

### `onAgentTerminated`

Fired when an agent terminates unexpectedly:

```typescript
{
    agentName: string;      // Name of the agent (e.g., "agent-1")
    runId: string;          // Process ID (e.g., "workflow_task_1234567890")
    reason: 'external_kill' | 'timeout' | 'error' | 'health_check_failed';
    phase?: string;         // Workflow phase when termination occurred
}
```

This event allows:
- UI to show termination status
- Monitoring systems to track agent reliability
- Coordinator to decide whether to retry

## Benefits of This Design

### ✅ Separation of Concerns
- ProcessManager handles ALL process health monitoring
- Workflows only respond to health events
- No duplicate monitoring logic

### ✅ Reliable Detection
- Detects external kills within 30 seconds
- Detects stuck processes within 5 minutes
- Cross-platform process group killing

### ✅ Clean Failure Handling
- No hanging workflows waiting for dead agents
- Proper error propagation through Promise rejection
- Workflow can retry or fail gracefully

### ✅ Memory Efficient
- Callbacks use IDs for cleanup (no memory leaks)
- Proper disposal in workflow.dispose()
- Unregister callbacks when workflow completes

### ✅ Observable
- `onAgentTerminated` event for monitoring
- Detailed logging of termination reason
- UI can show agent health status

## Configuration

### ProcessManager Settings

```typescript
// In ProcessManager.ts
private readonly GRACEFUL_TIMEOUT_MS = 5000;       // 5 seconds to gracefully stop
private readonly FORCE_KILL_TIMEOUT_MS = 2000;     // 2 more seconds before SIGKILL
private readonly DEFAULT_MAX_RUNTIME_MS = 60 * 60 * 1000;  // 1 hour default max runtime
private readonly HEALTH_CHECK_INTERVAL_MS = 30 * 1000;     // Check health every 30 seconds
private readonly STUCK_THRESHOLD_MS = 5 * 60 * 1000;       // Consider stuck if no output for 5 minutes
```

These can be adjusted based on your needs:
- Shorter `HEALTH_CHECK_INTERVAL_MS` for faster detection (but more CPU usage)
- Longer `STUCK_THRESHOLD_MS` for agents with long processing phases
- Longer `DEFAULT_MAX_RUNTIME_MS` for complex tasks

## Testing External Kill Handling

### Manual Test

1. Start a workflow that runs an agent
2. Find the agent process PID: `ps aux | grep cursor.*agent`
3. Kill it externally: `kill -9 <PID>`
4. Observe workflow logs - should see:
   ```
   ⚠️ Agent process appears stuck: workflow_task_1234567890
   ❌ Agent terminated unexpectedly: health_check_failed
     Run ID: workflow_task_1234567890
     Phase: implement
     Agent: agent-1
   ```
5. Workflow should fail cleanly with error message

### Programmatic Test

```typescript
// In tests/agent-termination-test.ts
describe('Agent Termination Handling', () => {
    it('should detect external agent kill', async () => {
        const workflow = createTestWorkflow();
        let terminationDetected = false;
        
        workflow.onAgentTerminated.on((event) => {
            terminationDetected = true;
            expect(event.reason).toBe('health_check_failed');
        });
        
        // Start workflow
        const workflowPromise = workflow.start();
        
        // Wait for agent to start
        await waitForAgentAllocation();
        
        // Kill agent externally
        const agentPid = getAgentProcessPid();
        process.kill(agentPid, 'SIGKILL');
        
        // Wait for detection (should be < 30 seconds)
        await waitForCondition(() => terminationDetected, 35000);
        
        expect(terminationDetected).toBe(true);
        
        // Workflow should fail gracefully
        const result = await workflowPromise;
        expect(result.success).toBe(false);
    });
});
```

## Troubleshooting

### Workflow hangs after agent kill

**Symptom:** Workflow stays in "running" state after agent is killed

**Possible causes:**
1. ProcessManager callbacks not registered
   - Check `setupProcessManagerMonitoring()` is called in constructor
2. Process not registered with ProcessManager
   - Check `CursorAgentRunner.run()` calls `registerExternalProcess()`
3. Callback IDs don't match
   - Check workflow ID prefix matching in callback handlers

**Solution:** Enable debug logging:
```typescript
// In BaseWorkflow
private setupProcessManagerMonitoring(): void {
    const stuckCallbackId = this.processManager.onProcessStuck((processId, state) => {
        console.log(`[DEBUG] Stuck callback: ${processId}, workflow: ${this.id}`);
        // ...
    });
}
```

### False positives (agents marked as stuck)

**Symptom:** Agents marked as stuck when they're still working

**Possible causes:**
1. Agent doing long computation without output
2. `STUCK_THRESHOLD_MS` too short

**Solution:** 
- Have agents output progress messages during long operations
- Increase `STUCK_THRESHOLD_MS` in ProcessManager
- Disable health checks for specific agent runs:
```typescript
this.processManager.registerExternalProcess(id, proc, {
    // ...
    enableHealthCheck: false  // Disable for this specific agent
});
```

## Future Enhancements

### 1. Agent Heartbeat
Add periodic heartbeat from agents:
```bash
apc agent heartbeat --session $SESSION --workflow $WORKFLOW
```

### 2. Checkpoint/Resume
Save agent state periodically for recovery:
```typescript
// Every 30 seconds during agent run
const checkpoint = await this.saveAgentCheckpoint({
    taskId,
    phaseIndex: this.phaseIndex,
    partialOutput: runner.getPartialOutput(runId)
});
```

### 3. Adaptive Timeouts
Adjust timeouts based on historical task duration:
```typescript
const averageDuration = await getAverageTaskDuration(taskType);
const timeout = averageDuration * 1.5; // 50% buffer
```

### 4. Automatic Retry with Backoff
Retry failed agents with exponential backoff:
```typescript
if (terminationReason === 'timeout' || terminationReason === 'health_check_failed') {
    if (retryCount < MAX_RETRIES) {
        await sleep(Math.pow(2, retryCount) * 1000);
        return await this.retryAgentTask(taskId);
    }
}
```

