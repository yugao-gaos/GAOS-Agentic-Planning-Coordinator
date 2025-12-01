# APC Type Reference

## Core Types

This document describes the main data types used throughout the Agentic Planning Coordinator.

---

## State Types

### ExtensionState

Global extension state.

```typescript
interface ExtensionState {
    globalSettings: GlobalSettings;
    activePlanningSessions: string[];  // Session IDs
    activeCoordinators: string[];       // Coordinator IDs
}
```

### GlobalSettings

User-configurable settings.

```typescript
interface GlobalSettings {
    agentPoolSize: number;                          // 1-20
    defaultBackend: 'cursor' | 'claude-code' | 'codex';
    workingDirectory: string;                       // Default: "_AiDevLog"
}
```

---

## Agent Types

### AgentPoolState

Pool allocation state.

```typescript
interface AgentPoolState {
    totalAgents: number;
    agentNames: string[];                          // All agent names
    available: string[];                           // Available for allocation
    busy: Record<string, BusyAgentInfo>;          // Name → info
}
```

### BusyAgentInfo

Information about a busy agent.

```typescript
interface BusyAgentInfo {
    coordinatorId: string;
    sessionId: string;
    roleId: string;           // 'engineer', 'reviewer', 'context', or custom
    task?: string;            // Current task ID
    startTime: string;        // ISO timestamp
    processId?: number;       // OS process ID
    logFile?: string;         // Path to agent log
}
```

### AgentStatus

Agent status summary.

```typescript
interface AgentStatus {
    name: string;
    roleId?: string;
    status: 'available' | 'busy' | 'paused' | 'error';
    coordinatorId?: string;
    sessionId?: string;
    task?: string;
    logFile?: string;
    processId?: number;
}
```

---

## Role Types

### AgentRole

Role configuration for agents.

```typescript
class AgentRole {
    id: string;                         // Unique identifier
    name: string;                       // Display name
    description: string;
    isBuiltIn: boolean;                 // true for engineer/reviewer/context
    
    // Model & Prompt
    defaultModel: string;               // e.g., 'sonnet-4.5'
    promptTemplate: string;             // System prompt
    
    // Permissions
    allowedMcpTools: string[] | null;   // null = all allowed
    allowedCliCommands: string[] | null;
    
    // Context
    rules: string[];                    // Behavioral rules
    documents: string[];                // Reference documents
    
    // Execution
    timeoutMs: number;                  // Default: 3600000 (1 hour)
}
```

### Built-in Role Defaults

| Role | Model | Timeout | Description |
|------|-------|---------|-------------|
| engineer | sonnet-4.5 | 1 hour | Implements tasks |
| reviewer | opus-4.5 | 10 min | Reviews code changes |
| context | gemini-3-pro | 5 min | Updates project context |

### SystemPromptConfig

Configuration for system agents (non-role-based).

```typescript
class SystemPromptConfig {
    id: string;
    name: string;
    description: string;
    category: 'execution' | 'planning' | 'utility';
    defaultModel: string;
    promptTemplate: string;
}
```

**System Prompt IDs**:
- `coordinator` - Manages plan execution
- `context_gatherer` - Scans codebase during planning
- `planning_analyst` - Creates execution plans
- `error_router` - Routes errors to coordinators
- `unity_notification` - Formats Unity results
- `context_agent` - Updates context after tasks
- `summary_agent` - Generates execution summaries
- `plan_reviser` - Revises plans based on feedback
- `plan_finalizer` - Cleans up and validates plans

---

## Planning Types

### PlanningSession

A planning session from requirement to completion.

```typescript
interface PlanningSession {
    id: string;                         // e.g., 'ps_000001'
    status: PlanningStatus;
    requirement: string;                // Original requirement text
    currentPlanPath?: string;           // Path to current plan.md
    planHistory: PlanVersion[];         // Version history
    revisionHistory: RevisionEntry[];   // Revision requests
    recommendedAgents?: AgentRecommendation;
    createdAt: string;                  // ISO timestamp
    updatedAt: string;
    metadata?: Record<string, any>;     // Pause/resume state
    execution?: ExecutionState;         // When executing
}
```

### PlanningStatus

Session status values.

```typescript
// Planning phase statuses
type PlanningOnlyStatus = 
    | 'debating'      // AI analysts creating plan
    | 'reviewing'     // Plan complete, user reviewing
    | 'revising'      // Agents revising based on feedback
    | 'approved'      // Ready to execute
    | 'stopped'       // Stopped by user (can resume)
    | 'cancelled';    // Cancelled, cannot resume

// Execution phase statuses
type ExecutionOnlyStatus =
    | 'executing'     // Agents actively working
    | 'paused'        // Execution paused
    | 'completed'     // All tasks done
    | 'failed';       // Execution failed

type PlanningStatus = PlanningOnlyStatus | ExecutionOnlyStatus;
```

### PlanVersion

Plan version history entry.

```typescript
interface PlanVersion {
    version: number;
    path: string;
    timestamp: string;
}
```

### RevisionEntry

Plan revision request.

```typescript
interface RevisionEntry {
    version: number;
    feedback: string;
    timestamp: string;
}
```

### AgentRecommendation

Recommended agent count from planning.

```typescript
interface AgentRecommendation {
    count: number;
    justification: string;
}
```

---

## Execution Types

### ExecutionState

Execution state embedded in PlanningSession.

```typescript
interface ExecutionState {
    coordinatorId: string;
    mode: 'auto' | 'interactive';
    startedAt: string;
    agents: Record<string, AgentExecutionState>;  // Name → state
    progress: TaskProgress;
    lastActivityAt: string;
}
```

### AgentExecutionState

Per-agent execution state.

```typescript
interface AgentExecutionState {
    name: string;
    roleId?: string;
    status: 'idle' | 'starting' | 'working' | 'paused' | 'completed' | 'error';
    sessionId: string;
    currentTask?: string;
    logFile: string;
    processId?: number;
    startTime: string;
    lastActivity?: string;
}
```

---

## Coordinator Types

### CoordinatorState

Coordinator instance state.

```typescript
interface CoordinatorState {
    id: string;                         // e.g., 'coord_abc12345'
    planPath: string;
    planSessionId?: string;             // Links to PlanningSession
    status: CoordinatorStatus;
    mode: 'auto' | 'interactive';
    agentSessions: Record<string, AgentSessionInfo>;
    planVersion: number;
    progress: TaskProgress;
    logFile: string;
    executionSummaryPath?: string;
    createdAt: string;
    updatedAt: string;
}
```

### CoordinatorStatus

```typescript
type CoordinatorStatus = 
    | 'initializing'
    | 'running'
    | 'paused'
    | 'stopped'
    | 'reviewing'     // Generating summary
    | 'completed'
    | 'error';
```

### AgentSessionInfo

Agent session within a coordinator.

```typescript
interface AgentSessionInfo {
    sessionId: string;
    roleId?: string;
    status: 'starting' | 'working' | 'paused' | 'completed' | 'error' | 'stopped' | 'idle';
    task?: string;
    logFile: string;
    processId?: number;
    startTime: string;
    lastActivity?: string;
}
```

### TaskProgress

Execution progress tracking.

```typescript
interface TaskProgress {
    completed: number;
    total: number;
    percentage: number;
}
```

---

## Plan Types

### PlanInfo

Plan metadata for display.

```typescript
interface PlanInfo {
    title: string;
    path: string;
    sessionId?: string;
    status: PlanningStatus;
}
```

### PlanTask

Individual task in a plan.

```typescript
interface PlanTask {
    id: string;                         // e.g., 'T1', 'T2'
    title: string;
    description: string;
    assignedTo?: string;                // Agent name
    status: 'pending' | 'in_progress' | 'completed' | 'blocked';
    dependencies?: string[];            // Task IDs
}
```

---

## CLI Response Types

### CliResponse

Base CLI response.

```typescript
interface CliResponse {
    success: boolean;
    message?: string;
    error?: string;
    data?: unknown;
}
```

### StatusResponse

Response for `apc status`.

```typescript
interface StatusResponse extends CliResponse {
    data: {
        activePlanningSessions: number;
        activeCoordinators: number;
        agentPool: {
            total: number;
            available: number;
            busy: number;
        };
    };
}
```

### PoolStatusResponse

Response for `apc pool status`.

```typescript
interface PoolStatusResponse extends CliResponse {
    data: {
        total: number;
        available: string[];
        busy: Array<{
            name: string;
            roleId?: string;
            coordinatorId: string;
            sessionId: string;
            task?: string;
        }>;
    };
}
```

---

## Unity Types

### UnityTaskType

Unity operation types.

```typescript
type UnityTaskType =
    | 'prep_editor'              // Asset reimport + compile
    | 'test_framework_editmode'  // EditMode tests
    | 'test_framework_playmode'  // PlayMode tests
    | 'console_check';           // Read console errors
```

### PipelineOperation

Unity pipeline operations.

```typescript
type PipelineOperation =
    | 'prep'                     // Asset reimport + compile
    | 'test_editmode'            // EditMode tests
    | 'test_playmode'            // PlayMode tests
    | 'test_player_playmode';    // PlayMode in build
```

### TaskRequester

Who requested a Unity task.

```typescript
interface TaskRequester {
    coordinatorId: string;
    engineerName: string;
}
```

### PipelineTaskContext

Context for pipeline tasks.

```typescript
interface PipelineTaskContext {
    taskId: string;
    stage: string;
    engineerName: string;
    filesModified: string[];
}
```

---

## Terminal Types

### AgentTerminal

VS Code terminal for an agent.

```typescript
interface AgentTerminal {
    name: string;
    sessionId: string;
    terminal: vscode.Terminal;
    logFile: string;
}
```

---

## ID Formats

| Type | Format | Example |
|------|--------|---------|
| Planning Session | `ps_NNNNNN` | `ps_000001` |
| Coordinator | `coord_XXXXXXXX` | `coord_abc12345` |
| Agent Session | `{name}_{NNNNNN}` | `alex_000001` |
| Task | `T{N}` or `T{NNN}` | `T1`, `T001` |

