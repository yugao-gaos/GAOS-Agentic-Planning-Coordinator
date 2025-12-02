# Final Architecture: Extension as Pure GUI Client

**Date**: December 2, 2025  
**Status**: ✅ Complete

---

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│          VSCode Extension (GUI)             │
│  ┌───────────────────────────────────────┐  │
│  │  Extension-Local Services Only:       │  │
│  │  • DependencyService (local checks)   │  │
│  │  • ProcessManager (local cleanup)     │  │
│  │  • TerminalManager (VSCode UI)        │  │
│  └───────────────────────────────────────┘  │
│                    │                         │
│              WebSocket API                   │
│                    ↓                         │
└─────────────────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────┐
│         APC Daemon (Business Logic)         │
│  ┌───────────────────────────────────────┐  │
│  │  All Core Services:                   │  │
│  │  • TaskManager                        │  │
│  │  • UnifiedCoordinatorService          │  │
│  │  • StateManager                       │  │
│  │  • AgentPoolService                   │  │
│  │  • AgentRunner (spawns agents)        │  │
│  │  • UnityControlManager                │  │
│  │  • All Workflow Services              │  │
│  └───────────────────────────────────────┘  │
│              Persists to Disk                │
│                    ↓                         │
│  ~/.apc/workspaces/{workspace}/              │
└─────────────────────────────────────────────┘
```

---

## Service Responsibilities

### Extension Services (3 total)

| Service | Purpose | Why Extension? |
|---------|---------|----------------|
| **DependencyService** | Check if Git, Python, Unity CLI, etc. are installed | Checks LOCAL machine where VSCode runs |
| **ProcessManager** | Kill orphaned cursor-agent processes | Cleans LOCAL processes |
| **TerminalManager** | Create/manage VSCode integrated terminals | VSCode-specific UI feature |

### Daemon Services (All Business Logic)

| Service | Purpose | Ownership |
|---------|---------|-----------|
| **TaskManager** | Track all tasks across sessions | Daemon-only |
| **UnifiedCoordinatorService** | Orchestrate workflows, dispatch tasks | Daemon-only |
| **StateManager** | Persist session/plan state to disk | Daemon-only |
| **AgentPoolService** | Manage agent allocation/availability | Daemon-only |
| **AgentRunner** | Spawn cursor-agent processes for workflows | Daemon-only |
| **UnityControlManager** | Interact with Unity Editor | Daemon-only |
| **PlanCache** | Cache parsed plans | Daemon-only |
| **ErrorClassifier** | Classify errors for retry logic | Daemon-only |
| **WorkflowPauseManager** | Manage workflow pause/resume | Daemon-only |
| **OutputChannelManager** | Log to files | Daemon-only |
| **EventBroadcaster** | Broadcast events via WebSocket | Daemon-only |

---

## Communication Pattern

### Extension → Daemon (WebSocket API)

```typescript
// Extension queries daemon for state
const tasks = await vsCodeClient.send('task.list', { sessionId });
const sessions = await vsCodeClient.send('session.list');
const agents = await vsCodeClient.send('task.assignments');
```

### Daemon → Extension (WebSocket Events)

```typescript
// Extension subscribes to daemon events
vsCodeClient.subscribe('task.failedFinal', (data) => { ... });
vsCodeClient.subscribe('workflow.completed', (data) => { ... });
vsCodeClient.subscribe('session.updated', (data) => { ... });
```

---

## Key Principles

### 1. Single Source of Truth
- **Daemon** owns all state
- **Extension** queries daemon for state
- No local caching of business data in extension

### 2. Clear Separation
- **Extension** = GUI + Local Utilities
- **Daemon** = All Business Logic
- No overlap, no duplication

### 3. Event-Driven UI
- Extension subscribes to daemon events
- UI updates automatically when state changes
- No polling (except connection health)

### 4. Stateless Extension
- Extension can restart without losing state
- Daemon persists all state to disk
- CLI and extension share same daemon

---

## Benefits

### ✅ Eliminated Problems

1. **No duplicate services** - Single TaskManager in daemon
2. **No state sync issues** - Daemon is single source of truth
3. **Empty task map fixed** - Extension sees all daemon tasks immediately
4. **Simpler extension** - 3 services vs 10+ before
5. **Faster startup** - Extension loads minimal services

### ✅ New Capabilities

1. **CLI independence** - Daemon runs standalone
2. **Multi-client support** - Multiple extensions can connect
3. **Remote daemon** - Extension could connect to remote daemon
4. **Better testing** - Core logic testable without VSCode
5. **Future-proof** - Easy to add web UI or other clients

---

## File Count Comparison

### Before Refactor
```
Extension registered: 10+ services
Extension used: TaskManager, UnifiedCoordinatorService, 
                StateManager, AgentPoolService, 
                UnityControlManager, AgentRunner, etc.
```

### After Refactor
```
Extension registered: 3 services
Extension used: DependencyService, ProcessManager, TerminalManager
                (All GUI-specific or local utilities)
```

---

## Testing Verification

### Manual Test Steps

1. **Start daemon independently:**
   ```bash
   apc daemon start
   ```

2. **Verify extension connects:**
   - Open VSCode
   - Check status bar: "APC: Connected"
   - Open developer console: No duplicate service warnings

3. **Test task creation via CLI:**
   ```bash
   apc session create "Test feature"
   apc task create --session ps_XXX --id T1 --desc "Test task"
   ```

4. **Verify UI shows tasks:**
   - Open task dependency map
   - Tasks appear immediately
   - No "empty map" issue

5. **Test workflow execution:**
   - Start workflow via CLI or UI
   - Verify agents spawn in daemon (not extension)
   - Check agent terminals appear in VSCode

6. **Test state persistence:**
   - Reload VSCode window
   - Verify state remains intact
   - Verify daemon keeps running

---

## Rollback Plan

If critical issues arise:

1. **Revert extension.ts** - Restore AgentRunner, bootstrapServices()
2. **Revert UI components** - Restore StateManager, AgentPoolService usage
3. **Daemon changes safe** - API endpoint additions are backward compatible

---

## Next Evolution

This architecture enables future enhancements:

1. **Web UI** - Build web interface connecting to same daemon
2. **Remote Daemon** - Run daemon on server, connect from multiple clients
3. **Daemon Plugins** - Third-party services can extend daemon
4. **Multi-Workspace** - Single daemon manages multiple workspaces
5. **Cloud Integration** - Daemon could sync state to cloud

---

## Summary

The extension is now a **pure GUI client** with only 3 local utility services. All business logic lives in the daemon, eliminating duplicate services and state synchronization issues. The architecture is clean, testable, and future-proof.

**Problem Solved**: Tasks created in daemon are now immediately visible in extension via WebSocket API. ✅

