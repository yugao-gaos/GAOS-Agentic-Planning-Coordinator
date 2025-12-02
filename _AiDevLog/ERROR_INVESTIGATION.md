# Error Investigation - December 2, 2025

## Summary

This document investigates daemon errors observed in terminal output related to workflow status and task status API calls.

## Observed Errors

### 1. Workflow Not Found Error
```
[Daemon Error] API error for workflow.status: Workflow 410392e6 not found
```

**Analysis:**
- A client (likely VS Code UI) is querying status for a workflow that no longer exists
- This happens when workflows complete and are removed from active memory
- The UI has stale references and tries to refresh them

**Root Cause:** UI-daemon synchronization gap - the UI doesn't know the workflow was removed

**Impact:** Low - API correctly returns error, but logs are cluttered

**Recommended Fixes:**
1. Add workflow completion events to notify all connected clients
2. Update UI to handle "not found" gracefully (remove from display)
3. Consider keeping completed workflows in memory with TTL for smooth transitions
4. Add workflow lifecycle logging to track when/why workflows are removed

---

### 2. Task Status Error - Invalid Session Parameter
```
[Daemon Error] API error for task.status: Task ps_000001 not found in session --session
```

**Analysis:**
- The error shows `session --session`, meaning the literal string `"--session"` was passed as the session ID
- This indicates a CLI argument parsing failure in the bash script

**Root Cause:** The `apc task status` command expects positional arguments but someone used named parameters:
```bash
# Expected usage (positional):
apc task status ps_000001 T1

# Actual usage (caused error):
apc task status --session ps_000001 --task T1
```

The bash script at line 637-644 didn't support named parameters, only positional.

**Impact:** Critical - command fails with confusing error message

**Fix Applied:** Updated `/scripts/apc` line 637-663 to support both:
- Positional: `apc task status <session_id> <task_id>`
- Named: `apc task status --session <id> --task <task_id>`

The script now detects which style is being used and parses accordingly.

---

### 3. Rapid Client Connections/Disconnections
```
[Daemon] Client connected: client_1764683435070_3qjv5wv (unknown)
[Daemon] Client disconnected: client_1764683435070_3qjv5wv (code: 1005, reason: )
```

**Analysis:**
- WebSocket close code 1005 = "No status code present" (normal closure)
- Pattern shows many rapid connect/disconnect cycles
- Clients connect but immediately disconnect

**Possible Causes:**
1. Multiple VS Code instances trying to connect to the same daemon
2. Client retry logic with aggressive backoff
3. Extension activation/deactivation cycles
4. Daemon not responding fast enough, causing client timeouts

**Impact:** Performance overhead, log clutter

**Recommended Investigation:**
1. Check if multiple VS Code windows are open for the same workspace
2. Review `src/client/ApcClient.ts` reconnection backoff logic
3. Add connection pooling or singleton pattern in `src/vscode/DaemonManager.ts`
4. Add unique client identifiers (workspace hash + process PID) to detect duplicates
5. Log client connection source (VS Code PID, CLI, external) for debugging

---

## Additional Observations

### Modified Files
The user has unstaged changes in:
- `src/services/workflows/BaseWorkflow.ts`
- `src/types/workflow.ts`

These files contain workflow type definitions and base workflow logic. The errors may be related to recent refactoring in these files.

**Recommendation:** Review git diff for these files to identify any changes to:
- Workflow ID generation or storage
- Task ID normalization (session prefix stripping)
- Workflow lifecycle (when workflows are created/removed)

### Task ID Normalization
From `ApiHandler.ts` line 874-881, there's logic to strip session prefixes from task IDs:
```typescript
// Normalize task ID: strip session prefix if coordinator mistakenly included it
// e.g., "ps_000001_T1" with session "ps_000001" → "T1"
if (taskId && sessionId && taskId.startsWith(`${sessionId}_`)) {
    const normalizedId = taskId.slice(sessionId.length + 1);
    console.log(`[ApiHandler] Normalized task ID: "${taskId}" → "${normalizedId}"`);
    taskId = normalizedId;
}
```

This suggests there may be inconsistency in how task IDs are passed around (with vs without session prefix).

---

## Action Items

### Immediate
- [x] Fix `apc task status` to support named parameters
- [ ] Add workflow lifecycle events to EventBroadcaster
- [ ] Update UI to handle "workflow not found" gracefully

### Short Term
- [ ] Review client reconnection logic and add backoff
- [ ] Add client identification (source, PID) to connection logs
- [ ] Implement connection pooling/singleton for VS Code clients
- [ ] Review task ID normalization across all API calls

### Long Term
- [ ] Add workflow TTL system (keep completed workflows for X minutes)
- [ ] Implement proper workflow lifecycle state machine
- [ ] Add comprehensive workflow/task ID validation layer
- [ ] Create integration tests for CLI → API → Service flow

---

## Testing

### To reproduce task status error:
```bash
# This should now work (after fix):
apc task status --session ps_000001 --task T1

# This should still work:
apc task status ps_000001 T1
```

### To check workflow lifecycle:
1. Start a session: `apc plan new "test requirement"`
2. Monitor daemon logs for workflow creation
3. Complete the workflow
4. Check if UI still tries to query the completed workflow

---

## Related Code

- `/scripts/apc` - CLI bash script (fixed)
- `src/daemon/ApiHandler.ts` - API request handler
- `src/client/ApcClient.ts` - WebSocket client
- `src/services/workflows/BaseWorkflow.ts` - Workflow base class
- `src/types/workflow.ts` - Workflow type definitions



