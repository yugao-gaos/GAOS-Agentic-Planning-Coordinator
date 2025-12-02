# Architecture Refactor: Extension as Pure GUI Client

**Date**: December 2, 2025
**Status**: Implementation Complete - Ready for Testing

## Problem Summary

The VSCode extension and daemon were running duplicate instances of core services (TaskManager, UnifiedCoordinatorService, etc.) in separate processes, causing state synchronization issues. Most critically, tasks created in the daemon were not visible in the extension's task dependency map.

## Solution Implemented

Converted the VSCode extension to a **pure GUI client** that queries all state from the daemon via WebSocket API.

---

## Changes Made

### 1. Removed Core Services from Extension

**Services Removed from Extension:**
- ❌ TaskManager
- ❌ UnifiedCoordinatorService
- ❌ StateManager (usage)
- ❌ AgentPoolService (usage)
- ❌ UnityControlManager
- ❌ EventBroadcaster (local instance)
- ❌ PlanCache
- ❌ Error Classifier
- ❌ WorkflowPauseManager
- ❌ OutputChannelManager (local instance)

**Services Kept in Extension (VSCode-specific only):**
- ✅ DependencyService (checks local system dependencies)
- ✅ ProcessManager (kills orphan LOCAL processes)
- ✅ TerminalManager (manages VSCode terminals)

**Services Moved to Daemon-Only:**
- ✅ AgentRunner (now daemon-only - workflows spawn agents there)

### 2. UI Components Updated

**src/ui/DependencyMapPanel.ts**
- Removed TaskManager import and fallback
- Made `vsCodeClient` required parameter (non-optional)
- All task queries now go through daemon API
- Shows error if daemon not connected

**src/ui/SidebarViewProvider.ts**
- Removed StateManager, AgentPoolService, UnityControlManager, UnifiedCoordinatorService imports
- Removed `setServices()` method
- Removed `subscribeToWorkflowEvents()` method  
- Removed TaskManager fallback for agent assignments
- Removed UnityControlManager fallback for Unity status
- Now uses only DaemonStateProxy for all state queries

**src/ui/PlanningSessionsProvider.ts**
- Removed TaskManager usage for agent assignments
- Temporarily commented out agent display (will be restored when daemon API is used)

### 3. DaemonStateProxy Enhanced

**src/services/DaemonStateProxy.ts**
- Removed TaskManager import dependency
- Added `AgentAssignment` interface locally (no longer depends on TaskManager)
- Already has methods for querying daemon:
  - `getAgentAssignmentsForUI()`
  - `getSessionAgentAssignments(sessionId)`
  - `getPoolStatus()`
  - `getUnityStatus()`

### 4. Daemon API Extended

**src/daemon/ApiHandler.ts**
- Added `task.assignments` endpoint
- Returns agent assignment data for UI display
- Optionally filterable by sessionId
- Interface updated: `ITaskManagerApi.getAgentAssignmentsForUI()`

### 5. Extension Bootstrap Simplified

**src/extension.ts**
- **REMOVED** `bootstrapServices()` call
- **REMOVED** EventBroadcaster local listener
- Manually register ONLY extension-local services:
  ```typescript
  ServiceLocator.register(DependencyService, () => new DependencyService());
  ServiceLocator.register(ProcessManager, () => new ProcessManager());
  ServiceLocator.register(AgentRunner, () => new AgentRunner());
  ```
- Replaced local EventBroadcaster listener with WebSocket subscription to `task.failedFinal`

---

## Architecture Decision Matrix

| Service | Daemon | Extension | Reason |
|---------|--------|-----------|--------|
| TaskManager | ✓ | ✗ | Core business logic |
| UnifiedCoordinatorService | ✓ | ✗ | Core business logic |
| StateManager | ✓ | ✗ | File system state |
| AgentPoolService | ✓ | ✗ | Agent allocation |
| UnityControlManager | ✓ | ✗ | Unity integration |
| **AgentRunner** | ✓ | ✗ | **Workflows spawn agents in daemon** |
| DependencyService | ✗ | ✓ | Checks LOCAL system |
| ProcessManager | ✗ | ✓ | Cleans LOCAL processes |
| TerminalManager | ✗ | ✓ | VSCode-specific |

---

## Key Principles Enforced

1. **Extension is JUST a GUI**
   - No business logic
   - No state management
   - Only UI rendering and user interaction

2. **Daemon is Single Source of Truth**
   - All core services live only in daemon
   - All state mutations happen in daemon
   - Extension never creates/modifies state directly

3. **DaemonStateProxy is Unified Interface**
   - Single entry point for all daemon queries
   - Handles connection failures gracefully
   - All UI components query through this proxy

4. **WebSocket Events for Real-Time Updates**
   - Extension subscribes to daemon events
   - No local service events
   - UI updates when daemon broadcasts changes

---

## Files Modified

1. `src/ui/DependencyMapPanel.ts` - Removed TaskManager fallback
2. `src/ui/SidebarViewProvider.ts` - Removed all core service dependencies
3. `src/ui/PlanningSessionsProvider.ts` - Removed TaskManager usage
4. `src/services/DaemonStateProxy.ts` - Made AgentAssignment interface local
5. `src/daemon/ApiHandler.ts` - Added task.assignments endpoint
6. `src/extension.ts` - Removed bootstrapServices(), AgentRunner, manual service registration for local services only

---

## Testing Checklist

- [ ] Extension starts without errors
- [ ] Daemon starts successfully  
- [ ] Extension connects to daemon via WebSocket
- [ ] Task dependency map shows tasks from daemon
- [ ] Sidebar shows sessions/agents from daemon
- [ ] Agent terminals still created correctly
- [ ] Dependency checks still work
- [ ] All UI updates via WebSocket events work
- [ ] No duplicate service instances
- [ ] CLI and daemon work independently
- [ ] Task creation via CLI visible in extension immediately

---

## Next Steps

1. **Test the full workflow:**
   ```bash
   # Terminal 1: Start daemon
   apc daemon start
   
   # Terminal 2: Create session and tasks
   apc session create "Test feature"
   # ... create tasks via CLI
   
   # VSCode: Open task dependency map and verify tasks appear
   ```

2. **If issues found:**
   - Check daemon logs
   - Check extension developer console (Help > Toggle Developer Tools)
   - Verify WebSocket connection is established
   - Check API endpoint responses

3. **Performance verification:**
   - Extension should start faster (fewer services)
   - UI should be responsive (queries cached by proxy)
   - No memory leaks from duplicate services

---

## Benefits of This Architecture

1. **Single Source of Truth**: No state synchronization issues
2. **Simpler Extension**: Easier to maintain, faster startup
3. **Better Separation**: Clear boundary between GUI and business logic
4. **CLI Independence**: Daemon can run standalone with CLI
5. **Future-Proof**: Easy to add web UI or other clients

---

## Rollback Plan

If issues arise, revert these commits:
- Extension service registration changes
- UI component service dependency removal
- DaemonStateProxy interface changes

**Note**: The daemon changes (API endpoint) are backward compatible and safe to keep.

