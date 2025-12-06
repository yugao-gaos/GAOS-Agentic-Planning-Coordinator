# Architecture Overview

This document describes the high-level architecture of the Agentic Planning Coordinator (APC) system.

## Design Philosophy

APC follows a **client-daemon architecture** where:

- **Daemon**: Hosts all business logic, state management, and AI agent coordination
- **Clients**: Thin UI layers (VS Code extension, CLI, TUI) that connect to the daemon

This design enables:
- Multiple clients to share the same state
- State persistence across client restarts
- Headless operation for automation
- Clean separation of concerns

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER INTERFACE                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐                    │
│  │  VS Code     │   │  CLI (apc)   │   │  TUI         │                    │
│  │  Extension   │   │  Commands    │   │  (Future)    │                    │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘                    │
└─────────┼──────────────────┼──────────────────┼────────────────────────────┘
          │                  │                  │
          │         WebSocket (ws://127.0.0.1:19840)
          │                  │                  │
┌─────────▼──────────────────▼──────────────────▼────────────────────────────┐
│                           APC DAEMON                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        WebSocket Server                              │   │
│  │  • Client connection management                                      │   │
│  │  • Request routing to ApiHandler                                     │   │
│  │  • Event broadcasting to clients                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         Core Services                                │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │   │
│  │  │ StateManager│  │ AgentPool   │  │ TaskManager │                  │   │
│  │  │             │  │ Service     │  │             │                  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘                  │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │   │
│  │  │ Unified     │  │ Workflow    │  │ Planning    │                  │   │
│  │  │ Coordinator │  │ Registry    │  │ Service     │                  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                          Workflows                                   │   │
│  │  • PlanningNewWorkflow      • ErrorResolutionWorkflow               │   │
│  │  • PlanningRevisionWorkflow • ContextGatheringWorkflow              │   │
│  │  • TaskImplementationWorkflow                                        │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           STATE PERSISTENCE                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│  _AiDevLog/                                                                 │
│  ├── .config/daemon.json        # Daemon configuration                      │
│  ├── .extension_state.json      # Global state                              │
│  ├── .agent_pool.json           # Agent pool state                          │
│  ├── Plans/                     # Generated plans                           │
│  ├── Logs/                      # Agent execution logs                      │
│  ├── Context/                   # Project context files                     │
│  └── coordinators/              # Coordinator state                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Key Components

### 1. Daemon (`src/daemon/`)

The daemon is the heart of APC, running as a standalone process:

| Component | File | Responsibility |
|-----------|------|----------------|
| ApcDaemon | `ApcDaemon.ts` | WebSocket server, client management, lifecycle |
| ApiHandler | `ApiHandler.ts` | Routes requests to appropriate services |
| EventBroadcaster | `EventBroadcaster.ts` | Broadcasts events to subscribed clients |
| DaemonConfig | `DaemonConfig.ts` | Configuration loading, port/PID file management |

### 2. Client (`src/client/`)

Abstract client interfaces for daemon communication:

| Component | File | Responsibility |
|-----------|------|----------------|
| IApcClient | `ApcClient.ts` | Client interface definition |
| BaseApcClient | `ApcClient.ts` | Common client implementation |
| Protocol | `Protocol.ts` | Request/response/event type definitions |

### 3. VS Code Integration (`src/vscode/`)

VS Code-specific client implementation:

| Component | File | Responsibility |
|-----------|------|----------------|
| VsCodeClient | `VsCodeClient.ts` | WebSocket client for VS Code |
| DaemonManager | `DaemonManager.ts` | Daemon lifecycle management |

### 4. Core Services (`src/services/`)

Business logic services running in the daemon:

| Service | File | Responsibility |
|---------|------|----------------|
| StateManager | `StateManager.ts` | Central state management, file persistence |
| AgentPoolService | `AgentPoolService.ts` | Agent lifecycle, allocation, release |
| TaskManager | `TaskManager.ts` | Task tracking, dependencies, status |
| UnifiedCoordinatorService | `UnifiedCoordinatorService.ts` | Workflow orchestration |
| PlanningService | `PlanningService.ts` | Plan creation, revision |
| AgentRoleRegistry | `AgentRoleRegistry.ts` | Agent role definitions |

### 5. Workflows (`src/services/workflows/`)

Self-contained state machines for different operations:

| Workflow | File | Purpose |
|----------|------|---------|
| PlanningNewWorkflow | `PlanningNewWorkflow.ts` | Create new plans via multi-agent debate |
| PlanningRevisionWorkflow | `PlanningRevisionWorkflow.ts` | Revise plans with feedback |
| TaskImplementationWorkflow | `TaskImplementationWorkflow.ts` | Execute individual tasks |
| ErrorResolutionWorkflow | `ErrorResolutionWorkflow.ts` | Handle and resolve errors |
| ContextGatheringWorkflow | `ContextGatheringWorkflow.ts` | Gather project context |

## Communication Patterns

### Request-Response

Clients send requests and receive responses:

```typescript
// Client sends
{
  type: 'request',
  payload: {
    id: 'req_123',
    cmd: 'pool.status',
    params: {}
  }
}

// Daemon responds
{
  type: 'response',
  payload: {
    id: 'req_123',
    success: true,
    data: { total: 10, available: 8, busy: 2 }
  }
}
```

### Event Broadcasting

Daemon broadcasts events to subscribed clients:

```typescript
{
  type: 'event',
  payload: {
    event: 'workflow.completed',
    data: { workflowId: 'wf_123', status: 'completed' },
    timestamp: '2025-01-01T00:00:00Z'
  }
}
```

## Service Locator Pattern

APC uses a Service Locator pattern for dependency injection:

```typescript
// Registration (in daemon startup)
ServiceLocator.register(StateManager, () => new StateManager(workspaceRoot));
ServiceLocator.register(AgentPoolService, () => new AgentPoolService(
    ServiceLocator.resolve(StateManager),
    ServiceLocator.resolve(AgentRoleRegistry)
));

// Resolution (anywhere in daemon)
const stateManager = ServiceLocator.resolve(StateManager);
```

### Architecture Guard

The extension enforces strict separation - daemon-only services cannot be registered in the extension:

```typescript
const daemonOnlyServices = [
    'StateManager',
    'TaskManager',
    'AgentPoolService',
    'UnifiedCoordinatorService',
    // ... etc
];
```

## Data Flow

### Planning Flow

```
User Request
    │
    ▼
VS Code Extension ──► Daemon (WebSocket)
    │                     │
    │                     ▼
    │              StateManager (create session)
    │                     │
    │                     ▼
    │              PlanningNewWorkflow
    │                     │
    │     ┌───────────────┼───────────────┐
    │     ▼               ▼               ▼
    │  Planner         Analyst 1       Analyst 2
    │  Agent           Agent           Agent
    │     │               │               │
    │     └───────────────┼───────────────┘
    │                     │
    │                     ▼
    │              Plan Finalized
    │                     │
    ◄─────────────────────┘
Event: plan.ready
```

### Execution Flow

```
User Approves Plan
    │
    ▼
UnifiedCoordinatorService
    │
    ▼
TaskManager.getReadyTasks()
    │
    ├──► Task 1 ──► TaskImplementationWorkflow
    │                        │
    │                        ▼
    │               AgentPoolService.allocate()
    │                        │
    │                        ▼
    │               Agent Executes Task
    │                        │
    │                        ▼
    │               Task Complete
    │
    ├──► Task 2 ──► (waits for dependencies)
    │
    └──► Task 3 ──► (parallel if independent)
```

## Idle Shutdown

The daemon automatically shuts down after 60 seconds with no connected clients:

```
Client disconnects
        │
        ▼
clients.size === 0
        │
        ▼
Start 60s timer
        │
        ├── Client connects ──► Cancel timer
        │
        └── Timer expires ──► Graceful shutdown
                                    │
                                    ▼
                              Save workflow state
                                    │
                                    ▼
                              Release agents
                                    │
                                    ▼
                              Stop daemon
```

## Error Handling

### Workflow Errors

Workflows handle errors through:
1. **Retry Policy** - Configurable retry attempts with backoff
2. **Error Classification** - Categorize errors (transient, permanent, needs_clarity)
3. **Error Resolution Workflow** - Dedicated workflow for complex error handling

### Connection Errors

Clients handle disconnection through:
1. **Auto-reconnect** - Configurable retry with exponential backoff
2. **Connection health monitoring** - Periodic ping checks
3. **Graceful degradation** - UI shows connection status

## Security Considerations

- Daemon listens only on `127.0.0.1` (localhost)
- No authentication required (local only)
- State files stored in workspace directory
- No sensitive data transmitted over network

