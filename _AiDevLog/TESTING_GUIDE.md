# Testing Guide for Daemon Error Fixes

## Overview

This document provides testing procedures for all phases of the daemon error fixes implementation.

## Phase 1: CLI Task Status (Already Fixed)

### Test Positional Arguments
```bash
cd /Users/imyu/Desktop/Agentic-Planning-Coordinator
apc task status ps_000001 T1
```
**Expected:** Task status displayed successfully

### Test Named Arguments
```bash
apc task status --session ps_000001 --task T1
```
**Expected:** Task status displayed successfully (same result as positional)

## Phase 2 & 3: Graceful Error Handling (P0)

### Test 1: Query Non-Existent Workflow
**Setup:**
1. Start a session and complete a workflow
2. Wait for workflow to be cleaned up (1 hour) OR manually query old workflow ID

**Test:**
```typescript
// Via VS Code client or API
const result = await vsCodeClient.send('workflow.status', { 
    sessionId: 'ps_000001', 
    workflowId: 'old-workflow-id' 
});
```

**Expected:**
- No error thrown
- Returns: `{ status: 'not_found', message: 'Workflow completed and cleaned up from memory' }`
- Daemon logs show NO "Workflow not found" errors

### Test 2: Cleanup Events Broadcasting
**Setup:**
1. Start a session with workflows
2. Keep session open for >1 hour (or adjust MAX_AGE_MS for testing)

**Test:**
- Monitor daemon logs for "Cleaned up X old completed workflows"
- Check UI refreshes when cleanup occurs
- Verify `workflows.cleaned` event is broadcast

**Expected:**
- Event broadcasted successfully
- UI refreshes after cleanup
- No stale workflow queries after cleanup

## Phase 4: UI Workflow Tracking (P1)

### Test Workflow Tracking
**Setup:**
1. Start execution with multiple workflows
2. Monitor SidebarProvider tracked workflows

**Test:**
```typescript
// In browser console when viewing VS Code webview:
// trackedWorkflows Set should only contain running/paused workflows
```

**Expected:**
- Only active workflows in trackedWorkflows Set
- Completed workflows removed from Set immediately
- No stale queries for completed workflows

## Phase 5: Status Query Cache (P1)

### Test Cache Hit
**Setup:**
1. Query a workflow status twice within 5 seconds

**Test:**
```typescript
const start = Date.now();
const result1 = await vsCodeClient.getWorkflowStatusCached(sessionId, workflowId);
const result2 = await vsCodeClient.getWorkflowStatusCached(sessionId, workflowId);
const duration = Date.now() - start;
```

**Expected:**
- Second query returns immediately (<10ms)
- Same result for both queries
- Cache used (check logs)

### Test Cache Miss
**Setup:**
1. Query a workflow status
2. Wait 6 seconds
3. Query again

**Expected:**
- Second query makes network request
- Cache expired and refreshed

## Phase 6: Connection Pooling (P1)

### Test Singleton Connection
**Setup:**
1. Close and reopen VS Code sidebar multiple times
2. Monitor daemon logs for client connections

**Test:**
- Check daemon logs for `[APC] Creating new daemon connection` vs `[APC] Reusing existing daemon connection`

**Expected:**
- Only ONE "Creating new daemon connection" log
- Subsequent sidebar opens show "Reusing existing daemon connection"
- Client ID includes process PID: `vscode-12345`

### Test Connection Count
**Setup:**
1. Open multiple VS Code windows for same workspace (if possible)
2. Monitor daemon connection count

**Expected:**
- Minimal connection churn
- <5 reconnects per hour
- Process PID helps identify duplicate clients

## Phase 7: Workflow State Machine (P2)

### Test Workflow Archival
**Setup:**
1. Complete a workflow
2. Wait for cleanup (1 hour or adjust MAX_AGE_MS)
3. Query the workflow status

**Test:**
```typescript
const status = await coordinator.getWorkflowStatus(sessionId, archivedWorkflowId);
```

**Expected:**
- Returns archived workflow with status: 'not_found'
- Message indicates "archived on [timestamp]"
- Workflow not in active workflows Map
- Workflow IS in archivedWorkflows Map

### Test Archive Contents
**Setup:**
1. Check session state after workflow cleanup

**Test:**
```typescript
const state = coordinator.getSessionState(sessionId);
console.log(state.archivedWorkflows.size); // Should have archived workflows
```

**Expected:**
- Archived workflows contain: id, type, status, taskId, timestamps
- Lightweight (no full workflow instance)

## Phase 8: Persistent History Service (P2)

### Test History File Creation
**Setup:**
1. Complete a workflow
2. Check filesystem

**Test:**
```bash
ls -la _AiDevLog/History/
cat _AiDevLog/History/ps_000001.json
```

**Expected:**
- Directory exists: `_AiDevLog/History/`
- File created: `ps_000001.json`
- Contains workflow history entries (newest first)

### Test History Query
**Setup:**
1. Complete multiple workflows
2. Query history service

**Test:**
```typescript
const history = await historyService.getSessionHistory('ps_000001');
console.log(history.length); // Should match completed workflows
```

**Expected:**
- All completed workflows in history
- Ordered by completion time (newest first)
- Maximum 1000 entries per session

### Test History Persistence
**Setup:**
1. Complete workflow
2. Restart daemon
3. Query history

**Expected:**
- History persists across daemon restarts
- Can query old workflows from disk

## Phase 9: Metrics Monitoring (P2)

### Test Metrics Collection
**Setup:**
1. Run system for a while with various operations
2. Query metrics

**Test:**
```typescript
const metrics = metricsCollector.getMetrics();
console.log(metrics);
```

**Expected:**
- Metrics tracked: workflowNotFoundErrors, clientConnections, etc.
- Rates calculated per hour
- Summary provides useful debugging info

## Integration Testing

### End-to-End Workflow Test
**Complete Test Scenario:**

1. **Start session:**
   ```bash
   apc plan new "test requirement"
   apc plan approve <session_id>
   ```

2. **Execute workflows:**
   ```bash
   apc exec start <session_id>
   ```

3. **Monitor for 2 hours:**
   - Check for workflow not-found errors → NONE expected
   - Check client connection churn → <5/hour expected
   - Check UI responsiveness → No stale queries

4. **After cleanup (1 hour):**
   - Query old workflow → Returns archived status
   - Check history file → Contains workflow
   - Verify UI handles gracefully

5. **Restart daemon:**
   - History persists
   - Archives recreated in memory
   - Metrics reset but history intact

### Success Criteria

✅ **P0 Tests:**
- Zero "workflow not found" errors in daemon logs
- Cleanup events broadcasted successfully
- Both CLI formats work correctly

✅ **P1 Tests:**
- Status cache reduces redundant queries
- Connection singleton prevents duplicates
- <5 client reconnects per hour

✅ **P2 Tests:**
- Archived workflows queryable
- History files persist to disk
- Metrics provide useful insights

## Automated Testing (Future)

Consider adding:
- Unit tests for graceful 404 handling
- Integration tests for cache behavior
- Load tests for connection pooling
- Performance tests for metrics collection

## Troubleshooting

### If errors still occur:

1. **Check daemon logs:**
   ```bash
   # Monitor real-time
   tail -f /tmp/apc_daemon_*.log
   ```

2. **Check metrics:**
   ```typescript
   console.log(metricsCollector.getSummary());
   ```

3. **Verify cache TTL:**
   - Adjust CACHE_TTL_MS if needed
   - Check cache hit/miss ratio

4. **Monitor connections:**
   - Check for duplicate client IDs
   - Look for process PID patterns
   - Identify connection source

## Notes

- All tests should be run in a development environment first
- Monitor memory usage during long-running tests
- Check that cleanup doesn't impact active workflows
- Verify backward compatibility with existing sessions





