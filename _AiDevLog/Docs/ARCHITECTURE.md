# APC Architecture

## System Architecture

The Agentic Planning Coordinator follows a **layered service architecture** with clear separation of concerns. The system uses an **event-driven workflow model** with an **AI Coordinator Agent** for autonomous decision-making.

## Layer Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          UI LAYER                                    │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐        │
│  │ SidebarView    │  │ PlanningSession│  │ RoleSettings   │        │
│  │ Provider       │  │ Provider       │  │ Panel          │        │
│  └───────┬────────┘  └───────┬────────┘  └───────┬────────┘        │
└──────────┼───────────────────┼───────────────────┼──────────────────┘
           │                   │                   │
           ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        SERVICE LAYER                                 │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐        │
│  │ PlanningService│  │ Unified        │  │ AgentPool      │        │
│  │                │  │ Coordinator    │  │ Service        │        │
│  │                │  │ Service        │  │                │        │
│  └───────┬────────┘  └───────┬────────┘  └───────┬────────┘        │
│          │                   │                   │                  │
│  ┌───────┴────────┐  ┌───────┴────────┐  ┌───────┴────────┐        │
│  │ PlanningAgent  │  │ Coordinator    │  │ AgentRole      │        │
│  │ Runner         │  │ Agent (AI)     │  │ Registry       │        │
│  └────────────────┘  └───────┬────────┘  └────────────────┘        │
│                              │                                      │
│                      ┌───────┴────────┐                             │
│                      │ TaskManager    │                             │
│                      │ (Global)       │                             │
│                      └────────────────┘                             │
└─────────────────────────────────────────────────────────────────────┘
           │                   │                   │
           ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      INFRASTRUCTURE LAYER                            │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐        │
│  │ StateManager   │  │ CursorAgent    │  │ EventBroadcast │        │
│  │                │  │ Runner         │  │ er             │        │
│  └────────────────┘  └────────────────┘  └────────────────┘        │
│          │                   │                   │                  │
│  ┌───────┴────────┐  ┌───────┴────────┐  ┌───────┴────────┐        │
│  │ ProcessManager │  │ TerminalManager│  │ OutputChannel  │        │
│  │                │  │                │  │ Manager        │        │
│  └────────────────┘  └────────────────┘  └────────────────┘        │
└─────────────────────────────────────────────────────────────────────┘
           │                   │                   │
           ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       EXTERNAL SYSTEMS                               │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐        │
│  │ File System    │  │ Cursor CLI     │  │ Unity MCP      │        │
│  │ (JSON State)   │  │ (AI Agents)    │  │ (Editor)       │        │
│  └────────────────┘  └────────────────┘  └────────────────┘        │
└─────────────────────────────────────────────────────────────────────┘
```

## Workflow System

The system uses **self-contained workflows** as the primary execution unit. Each workflow is a state machine that handles a specific concern.

### Workflow Types

| Type | Purpose | Occupancy |
|------|---------|-----------|
| `planning_new` | Create new plan from requirement | N/A |
| `planning_revision` | Revise existing plan with feedback | Exclusive on plan.md |
| `task_implementation` | Implement a single task | Exclusive on task files |
| `error_resolution` | Fix Unity pipeline errors | Shared with affected tasks |

### Workflow Lifecycle

```
              ┌──────────┐
              │ pending  │
              └────┬─────┘
                   │ start()
                   ▼
              ┌──────────┐     pause()     ┌──────────┐
              │ running  │ ──────────────► │  paused  │
              └────┬─────┘                 └────┬─────┘
                   │                            │ resume()
                   │◄───────────────────────────┘
                   │
         ┌─────────┼─────────┐
         │         │         │
         ▼         ▼         ▼
    ┌─────────┐ ┌──────┐ ┌────────┐
    │completed│ │failed│ │cancelled│
    └─────────┘ └──────┘ └────────┘
```

### Task Occupancy Model

Workflows declare which tasks/files they are working on:
- **exclusive**: Only this workflow can modify the task/files
- **shared**: Multiple workflows can read but coordinate writes

When conflicts occur:
- `pause_others`: Request other workflows to pause (default for revisions)
- `wait_for_others`: Wait for conflicting workflows to finish
- `abort_if_occupied`: Cancel if task is already occupied

---

## Core Services

### UnifiedCoordinatorService
**Purpose**: Central workflow orchestration with AI coordinator

**Responsibilities**:
- Manage all workflow instances across sessions
- Handle session initialization and cleanup
- Dispatch workflows based on AI Coordinator decisions
- Route events between workflows and TaskManager
- Rate-limited AI Coordinator evaluations (10s cooldown)

**Key Methods**:
```typescript
initSession(sessionId: string): void
dispatchWorkflow(sessionId, type, input, options): Promise<string>
startExecution(sessionId: string): Promise<void>
startRevision(sessionId: string, feedback: string): Promise<string>
triggerCoordinatorEvaluation(sessionId, eventType, payload): Promise<void>
```

**Coordinator Events**:
| Event | Triggers When |
|-------|---------------|
| `execution_started` | Plan execution begins |
| `task_completed` | Workflow finishes successfully |
| `task_failed` | Workflow fails (retries exhausted) |
| `workflow_blocked` | Workflow waiting on dependency/conflict |
| `agent_available` | Agent released back to pool |
| `unity_pipeline_complete` | Unity compilation/tests finish |

---

### CoordinatorAgent
**Purpose**: AI-driven decision making for task dispatch

**Responsibilities**:
- Evaluate system state and decide next actions
- Select which tasks to start and which agents to use
- Handle error escalation and user clarification requests
- Provide structured decisions as JSON

**Decision Types**:
```typescript
interface CoordinatorDecision {
    reasoning: string;           // Explanation of decision
    actions: CoordinatorAction[];
    waitForEvents?: boolean;     // Pause and wait for next event
    requestUserClarification?: string; // Ask user for input
}

type CoordinatorAction =
    | { type: 'start_task'; taskId: string; agentName?: string }
    | { type: 'pause_workflow'; workflowId: string; reason: string }
    | { type: 'cancel_workflow'; workflowId: string; reason: string }
    | { type: 'escalate_error'; error: string; context: any };
```

---

### TaskManager
**Purpose**: Global cross-session task coordination

**Responsibilities**:
- Track all tasks across all planning sessions
- Manage task dependencies and stages
- Detect cross-plan file overlaps
- Create and track error-fixing tasks
- Provide ready tasks for dispatch

**Task Stages**:
```
created → ready → dispatched → in_progress → verifying → completed
                                    │
                                    └───► failed → retrying
```

**Key Methods**:
```typescript
initializeFromPlan(sessionId: string, planData: ParsedPlan): void
getReadyTasksForSession(sessionId: string): ManagedTask[]
updateTaskStage(taskId: string, stage: TaskStage): void
pauseTasksAndDependents(taskIds: string[], reason: string): void
createErrorFixingTasks(errors: ErrorInfo[]): string[]
```

**Special Session**: `ERROR_RESOLUTION`
- Virtual session for error-fixing tasks
- Tasks created when Unity pipeline fails
- Lives forever (not unregistered)

---

### StateManager
**Purpose**: Central state persistence and synchronization

**Responsibilities**:
- Manages all persistent state (sessions, agent pool, roles)
- File-based storage in `_AiDevLog/` directory
- Cross-process synchronization with file locks
- Atomic writes to prevent corruption

**Key Methods**:
```typescript
savePlanningSession(session: PlanningSession): void
getPlanningSession(sessionId: string): PlanningSession | undefined
updateAgentPool(state: AgentPoolState): void
reloadFromFiles(): Promise<void>
```

---

### AgentPoolService
**Purpose**: Agent allocation and lifecycle management

**Responsibilities**:
- Manage pool of named agents (Alex, Betty, Cleo, etc.)
- Allocate agents to workflows via AgentRequest
- Track agent status (available, busy, reserved)
- Role-based agent assignment

**Key Methods**:
```typescript
requestAgent(request: AgentRequest): Promise<string | null>
releaseAgent(agentName: string): void
getPoolStatus(): { total: number; available: string[]; busy: string[] }
```

---

### CursorAgentRunner
**Purpose**: Execute AI agents via Cursor CLI

**Responsibilities**:
- Spawn `cursor agent` processes
- Pipe prompts and parse streaming JSON output
- Manage process lifecycle (timeouts, cleanup)
- Track partial output for pause/resume

**Key Methods**:
```typescript
run(options: AgentRunOptions): Promise<AgentRunResult>
stop(id: string): Promise<boolean>
getPartialOutput(runId: string): string | undefined
```

---

### UnityControlManager
**Purpose**: Unity Editor integration and pipeline management

**Responsibilities**:
- Queue Unity operations (compile, test)
- Manage exclusive access to Unity
- Route pipeline errors to TaskManager
- Handle error-fixing workflow dispatch

**Pipeline Operations**:
```typescript
type PipelineOperation = 
  | 'prep'                    // Asset reimport + compile
  | 'test_editmode'           // Run EditMode tests
  | 'test_playmode'           // Run PlayMode tests
  | 'test_player_playmode';   // PlayMode in build
```

**Error Handling Flow**:
```
Unity Pipeline Fails
        │
        ▼
UnityControlManager.handlePipelineErrors()
        │
        ├──► Find affected tasks (by file path)
        ├──► Pause affected tasks and dependents
        ├──► Create error-fixing tasks in ERROR_RESOLUTION
        └──► Trigger ERROR_RESOLUTION execution
```

---

### EventBroadcaster
**Purpose**: Centralized event broadcasting for daemon/client architecture

**Responsibilities**:
- Decouple services from communication layer
- Support session-scoped subscriptions
- Enable external clients (TUI, headless) to receive events

**Key Methods**:
```typescript
broadcast(event: string, data: any): void
broadcastToSession(sessionId: string, event: string, data: any): void
subscribeToSession(clientId: string, sessionId: string): void
onBroadcast(handler: (clientId, event, data) => void): void
```

---

### CliHandler
**Purpose**: CLI command processing for AI agents

**Responsibilities**:
- Parse CLI commands from `apc` tool
- Route to appropriate service methods
- Format JSON responses for agents

**Command Categories**:
| Category | Commands |
|----------|----------|
| `plan` | list, start, status, revise, approve |
| `exec` | start, pause, resume, stop, status |
| `task` | create, start, complete, fail, reset, list |
| `agent` | list, status, log, request, release, complete |
| `unity` | compile, test, status, wait, console |

---

## Data Flow

### Planning Flow
```
User Requirement
       │
       ▼
PlanningService.startPlanning()
       │
       ▼
Dispatches 'planning_new' workflow
       │
       ├──► Context Gatherer (gemini) ──┐
       │                                │
       ├──► Opus Analyst ───────────────┤
       ├──► Codex Analyst ──────────────┼──► Consensus Building
       └──► Gemini Analyst ─────────────┘
                                        │
                                        ▼
                              Plan File (plan.md)
                                        │
                                        ▼
                              User Review/Approve
```

### Execution Flow (Event-Driven)
```
Approved Plan
       │
       ▼
UnifiedCoordinatorService.startExecution()
       │
       ▼
TaskManager.initializeFromPlan()
       │
       ▼
┌───────────────────────────────────────────────────────────────┐
│              AI Coordinator Loop (Rate-Limited)                │
│                                                               │
│  Event Received (task_completed, agent_available, etc.)       │
│         │                                                     │
│         ▼                                                     │
│  CoordinatorAgent.evaluate(input)                             │
│         │                                                     │
│         ├──► Build prompt with full system state              │
│         ├──► Query AI model (sonnet-4.5)                      │
│         └──► Parse structured decision (JSON)                 │
│                    │                                          │
│                    ▼                                          │
│  executeCoordinatorDecision()                                 │
│         │                                                     │
│         ├──► start_task: dispatch task_implementation         │
│         ├──► pause_workflow: pause specified workflow         │
│         ├──► cancel_workflow: cancel specified workflow       │
│         └──► escalate_error: notify user                      │
│                                                               │
│  (10s cooldown before next evaluation)                        │
└───────────────────────────────────────────────────────────────┘
       │
       ▼
All tasks completed → Summary Generation → Done
```

### Workflow Interaction
```
┌─────────────────────────────────────────────────────────────┐
│                    UnifiedCoordinatorService                 │
│                                                             │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐       │
│  │ planning_   │   │ task_impl   │   │ task_impl   │       │
│  │ revision    │   │ (Task A)    │   │ (Task B)    │       │
│  └──────┬──────┘   └──────┬──────┘   └──────┬──────┘       │
│         │                 │                 │               │
│         │  declareTaskConflicts(pause_others)               │
│         │─────────────────┼─────────────────►               │
│         │                 │                 │               │
│         │          ◄──────┴─── pause() ─────┘               │
│         │                                                   │
│         │  (revision modifies plan.md)                      │
│         │                                                   │
│         │  releaseTaskOccupancy()                           │
│         │───────────────────────────────────►               │
│         │                                   │               │
│         ▼                            resume() triggered     │
│    [completed]                              │               │
│                                             ▼               │
│                                      [continue...]          │
└─────────────────────────────────────────────────────────────┘
```

---

## Persistence Model

### What Gets Persisted

| File | Content | Location |
|------|---------|----------|
| `session.json` | Session state, status, requirement | `_AiDevLog/Plans/{sessionId}/` |
| `plan.md` | The execution plan with tasks | `_AiDevLog/Plans/{sessionId}/` |
| `.agent_pool.json` | Pool allocation state | `_AiDevLog/` |
| `progress.log` | Live progress updates | `_AiDevLog/Plans/{sessionId}/` |
| `{roleId}.json` | Custom role configurations | `_AiDevLog/Roles/` |

### What is Ephemeral (In-Memory Only)

- **Workflows**: Created fresh on each session start/resume
- **CoordinatorAgent state**: Decisions are not persisted
- **TaskManager runtime state**: Rebuilt from plan on recovery

### Recovery Behavior

On extension restart:
1. Load `session.json` to get session status
2. If status is `executing` or `paused`:
   - Re-parse `plan.md` to rebuild task list
   - Create fresh workflows for incomplete tasks
   - Resume execution from current task states

---

## Concurrency Model

### In-Process Synchronization
- `AsyncMutex` for async operation queuing
- Rate limiter on CoordinatorAgent (10s cooldown)
- Prevents race conditions within extension

### Cross-Process Synchronization
- `FileLock` for CLI/external tool access
- Lock files in temp directory
- 5-second timeout with stale lock detection

### Atomic Operations
- Atomic file writes (write to temp, rename)
- State versioning to detect concurrent modifications

### Workflow Coordination
- Task occupancy declarations prevent conflicts
- Revision workflows can force-pause implementation workflows
- ERROR_RESOLUTION tasks coordinate with affected tasks

---

## Error Handling

### Process Errors
- `ProcessManager` tracks all spawned processes
- Automatic stuck process detection (>30 min idle)
- Orphan process cleanup on deactivation

### Task Failures
- Workflows retry failed phases (configurable count)
- After max retries, task marked as `failed`
- AI Coordinator decides: retry with different agent, escalate, or skip

### Unity Pipeline Errors
- Errors routed to `UnityControlManager.handlePipelineErrors()`
- Affected tasks paused automatically
- Error-fixing tasks created in `ERROR_RESOLUTION` session

### State Recovery
- Sessions can be paused/resumed
- Stopped sessions retain state for restart
- File watcher triggers state reload on external changes

---

## Extension Points

### Custom Roles
Users can create custom roles with:
- Custom prompt templates
- Model selection
- Tool/command restrictions
- Context rules and documents

### System Prompts
System agents (Coordinator, Context Gatherer, etc.) have customizable prompts stored in `_AiDevLog/SystemPrompts/`.

### Daemon/Client Architecture
The `ApcDaemon` provides a WebSocket server for external clients:
- TUI clients can connect and receive events
- Headless execution without VS Code UI
- Session-scoped event subscriptions
