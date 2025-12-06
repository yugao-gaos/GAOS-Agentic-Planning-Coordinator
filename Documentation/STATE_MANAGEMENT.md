# State Management

APC uses file-based state persistence to maintain system state across restarts and enable AI agents to read status via the filesystem.

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    State Management                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    StateManager                             │ │
│  │  • Central state repository                                 │ │
│  │  • File persistence                                         │ │
│  │  • Event broadcasting on changes                            │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│              ┌───────────────┼───────────────┐                   │
│              ▼               ▼               ▼                   │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐    │
│  │ Extension State│  │ Agent Pool     │  │ Planning       │    │
│  │                │  │ State          │  │ Sessions       │    │
│  └────────────────┘  └────────────────┘  └────────────────┘    │
│         │                    │                    │              │
│         ▼                    ▼                    ▼              │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    File System                              │ │
│  │  _AiDevLog/.extension_state.json                           │ │
│  │  _AiDevLog/.agent_pool.json                                │ │
│  │  _AiDevLog/Plans/                                          │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Source Files

| File | Description |
|------|-------------|
| `src/services/StateManager.ts` | Central state management |
| `src/services/PlanCache.ts` | Plan caching |
| `src/types/index.ts` | State type definitions |

## Working Directory Structure

Default: `_AiDevLog/` (configurable)

```
_AiDevLog/
├── .config/
│   └── daemon.json           # Daemon configuration
├── .extension_state.json     # Global extension state
├── .agent_pool.json          # Agent pool state
├── .daemon_pid               # Running daemon PID
├── .daemon_port              # Daemon WebSocket port
├── Plans/
│   └── <session-id>/
│       ├── plan.md           # Generated plan
│       ├── progress.log      # Planning progress
│       └── context.md        # Gathered context
├── Logs/
│   └── engineers/
│       └── <agent>_<session>.log
├── Context/
│   └── <name>.md             # Gathered context files
├── Errors/
│   └── <error-id>.json       # Error records
└── coordinators/
    └── <coordinator-id>.json # Coordinator state
```

## State Types

### Extension State

```typescript
interface ExtensionState {
    initialized: boolean;
    activeSessions: string[];
    lastUpdate: string;
    version: string;
    workspaceRoot: string;
}
```

### Agent Pool State

```typescript
interface AgentPoolState {
    totalAgents: number;
    agentNames: string[];
    available: string[];
    resting: Record<string, RestingAgentInfo>;
    allocated: Record<string, AllocatedAgentInfo>;
    busy: Record<string, BusyAgentInfo>;
}
```

### Planning Session

```typescript
interface PlanningSession {
    id: string;
    requirement: string;
    status: PlanningSessionStatus;
    createdAt: string;
    updatedAt: string;
    planPath?: string;
    currentPlanPath?: string;
    contextPath?: string;
    docs?: string[];
    revisionCount: number;
    recommendedAgents?: number;
    activeWorkflowId?: string;
    error?: string;
}

type PlanningSessionStatus =
    | 'created'
    | 'planning'
    | 'ready_for_review'
    | 'revising'
    | 'approved'
    | 'executing'
    | 'paused'
    | 'completed'
    | 'failed'
    | 'cancelled';
```

### Coordinator State

```typescript
interface CoordinatorState {
    id: string;
    sessionId: string;
    status: CoordinatorStatus;
    startedAt: string;
    lastActivity: string;
    tasksTotal: number;
    tasksCompleted: number;
    tasksFailed: number;
    activeWorkflows: string[];
    allocatedAgents: string[];
    history: CoordinatorHistoryEntry[];
}
```

## StateManager

### Initialization

```typescript
const stateManager = new StateManager(workspaceRoot, workingDirectory);
await stateManager.initialize();
```

### Extension State Operations

```typescript
// Get current state
const state = stateManager.getExtensionState();

// Update state
stateManager.updateExtensionState({
    activeSessions: [...state.activeSessions, newSessionId]
});

// Add active session
stateManager.addActiveSession(sessionId);

// Remove active session
stateManager.removeActiveSession(sessionId);
```

### Agent Pool Operations

```typescript
// Get pool state
const poolState = stateManager.getAgentPoolState();

// Update pool state
stateManager.updateAgentPool(newPoolState);

// Initialize pool with default agents
stateManager.initializeAgentPool(10);
```

### Session Operations

```typescript
// Create session
const session = stateManager.createSession(requirement, docs);

// Get session
const session = stateManager.getSession(sessionId);

// Get all sessions
const sessions = stateManager.getAllSessions();

// Update session
stateManager.updateSession(sessionId, { status: 'approved' });

// Delete session
stateManager.deleteSession(sessionId);
```

## File Persistence

### Write Strategy

State is persisted immediately on change:

```typescript
private saveState(): void {
    const statePath = path.join(this.workingDir, '.extension_state.json');
    fs.writeFileSync(statePath, JSON.stringify(this.state, null, 2));
}
```

### Read Strategy

State is loaded at initialization:

```typescript
private loadState(): ExtensionState {
    const statePath = path.join(this.workingDir, '.extension_state.json');
    
    if (fs.existsSync(statePath)) {
        return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
    
    return this.createDefaultState();
}
```

### Atomic Writes

For critical state files, atomic writes prevent corruption:

```typescript
private atomicWrite(filePath: string, data: string): void {
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, data);
    fs.renameSync(tempPath, filePath);
}
```

## Plan Storage

### Plan Directory Structure

```
Plans/<session-id>/
├── plan.md           # Current plan
├── plan_v1.md        # Previous versions (on revision)
├── plan_v2.md
├── progress.log      # Planning workflow log
└── context.md        # Gathered context
```

### Plan Cache

```typescript
class PlanCache {
    // Get cached plan
    getPlan(sessionId: string): string | undefined;
    
    // Cache plan
    setPlan(sessionId: string, content: string): void;
    
    // Invalidate cache
    invalidate(sessionId: string): void;
    
    // Clear all
    clear(): void;
}
```

## State Events

StateManager broadcasts events on changes:

| Event | Description |
|-------|-------------|
| `state.initialized` | State manager initialized |
| `session.created` | New planning session created |
| `session.updated` | Session status changed |
| `session.deleted` | Session removed |
| `pool.changed` | Agent pool state changed |

## State Queries

### Get Ready Tasks

```typescript
function getReadyTasks(sessionId: string): Task[] {
    const session = stateManager.getSession(sessionId);
    const tasks = stateManager.getTasks(sessionId);
    
    return tasks.filter(task => 
        task.status === 'pending' &&
        task.dependencies.every(depId => {
            const dep = tasks.find(t => t.id === depId);
            return dep?.status === 'completed';
        })
    );
}
```

### Get Session Summary

```typescript
function getSessionSummary(sessionId: string): SessionSummary {
    const session = stateManager.getSession(sessionId);
    const tasks = stateManager.getTasks(sessionId);
    
    return {
        sessionId,
        status: session.status,
        tasksTotal: tasks.length,
        tasksCompleted: tasks.filter(t => t.status === 'completed').length,
        tasksFailed: tasks.filter(t => t.status === 'failed').length,
        tasksInProgress: tasks.filter(t => t.status === 'in_progress').length
    };
}
```

## Daemon-Specific State

### PID and Port Files

```typescript
// Write daemon info
function writeDaemonInfo(workspaceRoot: string, pid: number, port: number): void {
    const workingDir = path.join(workspaceRoot, '_AiDevLog');
    fs.writeFileSync(path.join(workingDir, '.daemon_pid'), String(pid));
    fs.writeFileSync(path.join(workingDir, '.daemon_port'), String(port));
}

// Read daemon port
function getDaemonPort(workspaceRoot: string): number | null {
    const portFile = path.join(workspaceRoot, '_AiDevLog', '.daemon_port');
    if (fs.existsSync(portFile)) {
        return parseInt(fs.readFileSync(portFile, 'utf-8').trim());
    }
    return null;
}

// Cleanup on shutdown
function cleanupDaemonInfo(workspaceRoot: string): void {
    const workingDir = path.join(workspaceRoot, '_AiDevLog');
    try {
        fs.unlinkSync(path.join(workingDir, '.daemon_pid'));
        fs.unlinkSync(path.join(workingDir, '.daemon_port'));
    } catch {
        // Ignore cleanup errors
    }
}
```

## State Recovery

### Workflow Resume

Paused workflows can be resumed from saved state:

```typescript
interface WorkflowResumeState {
    workflowId: string;
    type: WorkflowType;
    phaseIndex: number;
    input: Record<string, any>;
    partialResults: Record<string, any>;
    pausedAt: string;
}
```

### Session Recovery

On daemon restart:

```typescript
async function recoverSessions(): Promise<void> {
    const sessions = stateManager.getAllSessions();
    
    for (const session of sessions) {
        if (session.status === 'executing' || session.status === 'planning') {
            // Mark as paused for manual resume
            stateManager.updateSession(session.id, {
                status: 'paused',
                error: 'Daemon restarted'
            });
        }
    }
}
```

## Best Practices

### State Consistency

1. Always update state through StateManager
2. Broadcast events after state changes
3. Use atomic writes for critical files

### Performance

1. Cache frequently accessed state
2. Debounce rapid state updates
3. Use incremental updates when possible

### Error Handling

1. Handle missing state files gracefully
2. Validate state on load
3. Provide default values for missing fields

## State File Examples

### .extension_state.json

```json
{
  "initialized": true,
  "activeSessions": ["ps_abc123", "ps_def456"],
  "lastUpdate": "2025-01-01T12:00:00Z",
  "version": "0.5.0",
  "workspaceRoot": "/path/to/project"
}
```

### .agent_pool.json

```json
{
  "totalAgents": 10,
  "agentNames": ["Alex", "Betty", "Cleo", "Dany", "Echo", "Finn", "Gwen", "Hugo", "Iris", "Jake"],
  "available": ["Alex", "Betty", "Cleo"],
  "resting": {
    "Dany": {
      "releasedAt": "2025-01-01T12:00:00Z",
      "restUntil": "2025-01-01T12:00:05Z"
    }
  },
  "allocated": {
    "Echo": {
      "sessionId": "ps_abc123",
      "workflowId": "wf_123",
      "roleId": "engineer",
      "allocatedAt": "2025-01-01T11:59:00Z"
    }
  },
  "busy": {
    "Finn": {
      "sessionId": "ps_abc123",
      "roleId": "engineer",
      "workflowId": "wf_456",
      "task": "Implement combo system",
      "startTime": "2025-01-01T11:58:00Z"
    }
  }
}
```

### Plans/ps_abc123/plan.md

```markdown
# Execution Plan: Implement Combo System

## Requirements
Implement a combo system for the fighting game...

## Tasks

### Task 1: Create ComboManager
- **ID**: task_001
- **Dependencies**: none
- **Priority**: 1
- **Description**: Create the core ComboManager class...

### Task 2: Implement Input Buffer
- **ID**: task_002
- **Dependencies**: task_001
- **Priority**: 2
- **Description**: Implement input buffering for combo detection...

## Recommended Team Size
3 engineers
```

