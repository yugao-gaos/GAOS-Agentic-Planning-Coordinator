# Workflow System

Workflows are self-contained state machines that manage multi-phase AI operations. Each workflow type handles a specific operation like planning, task implementation, or error resolution.

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                       Workflow System                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    IWorkflow Interface                      │ │
│  │  • Identity (id, type, sessionId)                          │ │
│  │  • State (status, progress)                                 │ │
│  │  • Lifecycle (start, pause, resume, cancel)                │ │
│  │  • Events (onProgress, onComplete, onError)                │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│                              ▼                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                     BaseWorkflow                            │ │
│  │  • Phase-based execution loop                               │ │
│  │  • Agent request/release helpers                            │ │
│  │  • Progress emission                                        │ │
│  │  • Pause/resume control                                     │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│      ┌───────────┬──────────┼──────────┬───────────┐           │
│      ▼           ▼          ▼          ▼           ▼           │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐       │
│  │Planning│ │Planning│ │  Task  │ │ Error  │ │Context │       │
│  │  New   │ │Revision│ │ Impl   │ │ Resol  │ │Gather  │       │
│  └────────┘ └────────┘ └────────┘ └────────┘ └────────┘       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Source Files

| File | Description |
|------|-------------|
| `src/services/workflows/IWorkflow.ts` | Interface and type definitions |
| `src/services/workflows/BaseWorkflow.ts` | Abstract base class |
| `src/services/workflows/WorkflowRegistry.ts` | Workflow type registry |
| `src/services/workflows/PlanningNewWorkflow.ts` | New plan creation |
| `src/services/workflows/PlanningRevisionWorkflow.ts` | Plan revision |
| `src/services/workflows/TaskImplementationWorkflow.ts` | Task execution |
| `src/services/workflows/ErrorResolutionWorkflow.ts` | Error handling |
| `src/services/workflows/ContextGatheringWorkflow.ts` | Context collection |

## Workflow Types

### 1. Planning New Workflow

Creates execution plans through multi-agent debate.

**Phases:**
```
┌──────────┐    ┌──────────┐    ┌──────────┐
│ Planner  │───►│ Analysts │───►│ Finalize │
└──────────┘    └──────────┘    └──────────┘
     │               │               │
     │               │               ▼
     │               │          Plan Ready
     │               │
     │    ┌──────────┴──────────┐
     │    │ Critical Issues?    │
     │    └──────────┬──────────┘
     │               │ Yes (max 3 iterations)
     └───────────────┘
```

**Process:**
1. **Planner Phase**: AI creates initial plan based on requirements
2. **Analysts Phase**: Multiple AI analysts review and critique (parallel)
3. **Iteration**: If critical issues found, return to planner (max 3 times)
4. **Finalize**: Final plan written to file

**Input:**
```typescript
interface PlanningWorkflowInput {
    requirement: string;
    docs?: string[];           // Reference documentation
    contextPath?: string;      // Pre-gathered context
    maxIterations?: number;    // Default: 3
}
```

### 2. Planning Revision Workflow

Revises existing plans based on feedback.

**Phases:**
```
┌──────────┐    ┌──────────┐    ┌──────────┐
│  Load    │───►│ Reviser  │───►│ Analysts │───►┌──────────┐
│  Plan    │    │          │    │          │    │ Finalize │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
```

**Process:**
1. **Load**: Read existing plan from disk
2. **Reviser**: AI revises plan based on feedback
3. **Analysts**: Review revised plan
4. **Finalize**: Write updated plan

**Input:**
```typescript
interface PlanningRevisionInput {
    sessionId: string;
    feedback: string;
    planPath: string;
}
```

### 3. Task Implementation Workflow

Executes individual tasks from plans.

**Phases:**
```
┌──────────┐    ┌──────────┐    ┌──────────┐
│  Setup   │───►│ Execute  │───►│ Verify   │
└──────────┘    └──────────┘    └──────────┘
```

**Process:**
1. **Setup**: Prepare task context, allocate agent
2. **Execute**: Agent implements the task
3. **Verify**: Check completion criteria (Unity compile, tests)

**Input:**
```typescript
interface TaskImplementationInput {
    taskId: string;
    description: string;
    dependencies: string[];
    context?: string;
    verifyWithUnity?: boolean;
}
```

### 4. Error Resolution Workflow

Handles and resolves errors during execution.

**Phases:**
```
┌──────────┐    ┌──────────┐    ┌──────────┐
│ Classify │───►│ Resolve  │───►│ Verify   │
└──────────┘    └──────────┘    └──────────┘
```

**Error Classification:**
- `transient`: Retry automatically
- `permanent`: Cannot recover without changes
- `needs_clarity`: Requires user input

**Input:**
```typescript
interface ErrorResolutionInput {
    errorId: string;
    errorMessage: string;
    taskId?: string;
    stackTrace?: string;
    attemptCount: number;
}
```

### 5. Context Gathering Workflow

Collects project context for planning.

**Phases:**
```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ Prescan  │───►│ Gather   │───►│Aggregate │───►│Summarize │───►│ Persist  │
└──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
```

**Process:**
1. **Prescan**: Scan directories, categorize files by extension
2. **Gather**: Run AI agents for detected asset types (parallel)
3. **Aggregate**: Combine results, check completeness
4. **Summarize**: Compress if output too large
5. **Persist**: Write to `_AiDevLog/Context/`

**Presets:**
- `unity_scripts`: C# files
- `unity_prefabs`: Prefab files
- `unity_scenes`: Scene files
- `docs`: Markdown/text documentation

## Workflow States

```typescript
type WorkflowStatus =
    | 'pending'     // Not yet started
    | 'running'     // Actively executing
    | 'paused'      // Temporarily stopped
    | 'completed'   // Finished successfully
    | 'failed'      // Finished with error
    | 'cancelled';  // User cancelled
```

## Workflow Interface

```typescript
interface IWorkflow {
    // Identity
    readonly id: string;
    readonly type: WorkflowType;
    readonly sessionId: string;
    
    // State
    getStatus(): WorkflowStatus;
    getProgress(): WorkflowProgress;
    getState(): object;  // For persistence
    
    // Lifecycle
    start(): Promise<WorkflowResult>;
    pause(options?: { force?: boolean }): Promise<void>;
    resume(): Promise<void>;
    cancel(): Promise<void>;
    
    // Events
    readonly onProgress: TypedEventEmitter<WorkflowProgress>;
    readonly onComplete: TypedEventEmitter<WorkflowResult>;
    readonly onError: TypedEventEmitter<Error>;
    
    // Task Occupancy
    getOccupiedTasks(): string[];
}
```

## Progress Tracking

```typescript
interface WorkflowProgress {
    workflowId: string;
    type: WorkflowType;
    status: WorkflowStatus;
    phase: string;
    phaseIndex: number;
    totalPhases: number;
    message: string;
    startTime: number;
    elapsedMs: number;
}
```

## Workflow Result

```typescript
interface WorkflowResult {
    success: boolean;
    output?: any;
    error?: string;
    duration: number;
    phases: {
        name: string;
        duration: number;
        status: 'completed' | 'skipped' | 'failed';
    }[];
}
```

## Workflow Configuration

```typescript
interface WorkflowConfig {
    id: string;
    type: WorkflowType;
    sessionId: string;
    priority: number;
    input: Record<string, any>;
    resumeState?: object;  // For resuming paused workflows
}
```

## Base Workflow Implementation

### Phase Execution Loop

```typescript
abstract class BaseWorkflow {
    protected abstract getPhases(): string[];
    protected abstract executePhase(index: number): Promise<void>;
    
    async start(): Promise<WorkflowResult> {
        this.status = 'running';
        this.startTime = Date.now();
        
        try {
            const phases = this.getPhases();
            
            for (this.phaseIndex = 0; this.phaseIndex < phases.length; this.phaseIndex++) {
                // Check for pause request
                if (this.pauseRequested) {
                    await this.handlePause();
                }
                
                this.emitProgress();
                await this.executePhase(this.phaseIndex);
            }
            
            this.status = 'completed';
            return this.buildResult(true);
            
        } catch (error) {
            this.status = 'failed';
            return this.buildResult(false, error);
        }
    }
}
```

### Agent Request Helper

```typescript
protected async requestAgent(roleId: string): Promise<string> {
    this.waitingForAgent = true;
    this.waitingForAgentRole = roleId;
    
    // Try to get from workflow's bench first
    const benchAgents = this.services.pool.getAgentsOnBench(this.id);
    const matchingAgent = benchAgents.find(a => a.roleId === roleId);
    
    if (matchingAgent) {
        this.services.pool.promoteAgentToBusy(
            matchingAgent.name,
            this.id,
            this.getProgressMessage()
        );
        return matchingAgent.name;
    }
    
    // Otherwise allocate new agent
    const agents = this.services.pool.allocateAgents(
        this.sessionId,
        this.id,
        1,
        roleId
    );
    
    if (agents.length === 0) {
        throw new Error(`No agents available for role: ${roleId}`);
    }
    
    this.services.pool.promoteAgentToBusy(agents[0], this.id, this.getProgressMessage());
    return agents[0];
}
```

## Workflow Registry

```typescript
class WorkflowRegistry {
    register(
        type: WorkflowType,
        factory: (config: WorkflowConfig, services: WorkflowServices) => IWorkflow,
        metadata: WorkflowMetadata
    ): void;
    
    create(type: WorkflowType, config: WorkflowConfig, services: WorkflowServices): IWorkflow;
    
    getMetadata(type: WorkflowType): WorkflowMetadata | undefined;
    
    list(): WorkflowType[];
}
```

### Registration

```typescript
// Built-in workflows registered at startup
function registerBuiltinWorkflows(registry: WorkflowRegistry): void {
    registry.register(
        'planning_new',
        (config, services) => new PlanningNewWorkflow(config, services),
        { name: 'New Planning', description: '...' }
    );
    
    registry.register(
        'task_implementation',
        (config, services) => new TaskImplementationWorkflow(config, services),
        { name: 'Task Implementation', description: '...' }
    );
    
    // ... etc
}
```

## Workflow Services

Services injected into workflows:

```typescript
interface WorkflowServices {
    pool: AgentPoolService;
    state: StateManager;
    tasks: TaskManager;
    agentRunner: AgentRunner;
    outputChannel: OutputChannelManager;
    eventBroadcaster: EventBroadcaster;
    unityControl?: UnityControlManager;
}
```

## Task Occupancy

Workflows declare which tasks they occupy:

```typescript
// TaskImplementationWorkflow
getOccupiedTasks(): string[] {
    return [this.taskId];  // Exclusive lock on this task
}

// PlanningRevisionWorkflow
getOccupiedTasks(): string[] {
    return this.affectedTaskIds;  // May affect multiple tasks
}
```

The coordinator uses this to prevent conflicts.

## Pause/Resume

### Pausing

```typescript
async pause(options?: { force?: boolean }): Promise<void> {
    if (options?.force) {
        // Kill running agent immediately
        await this.killCurrentAgent();
        this.saveState();
    } else {
        // Pause at next phase boundary
        this.pauseRequested = true;
    }
    
    this.status = 'paused';
}
```

### Resuming

```typescript
async resume(): Promise<void> {
    this.pauseRequested = false;
    this.status = 'running';
    
    if (this.pauseResolve) {
        this.pauseResolve();
    }
}
```

## Error Handling

### Retry Policy

```typescript
interface RetryPolicy {
    maxAttempts: number;
    backoffMs: number;
    backoffMultiplier: number;
    maxBackoffMs: number;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
    maxAttempts: 3,
    backoffMs: 1000,
    backoffMultiplier: 2,
    maxBackoffMs: 30000
};
```

### Error Classification

```typescript
type ErrorCategory = 
    | 'transient'      // Retry automatically
    | 'permanent'      // Cannot recover
    | 'needs_clarity'  // User input needed
    | 'resource'       // Resource unavailable
    | 'timeout';       // Operation timed out
```

## Example: Creating a Custom Workflow

```typescript
class CustomWorkflow extends BaseWorkflow {
    private static readonly PHASES = ['init', 'process', 'finalize'];
    
    getPhases(): string[] {
        return CustomWorkflow.PHASES;
    }
    
    getProgressMessage(): string {
        return `Processing ${this.input.itemCount} items`;
    }
    
    async executePhase(index: number): Promise<void> {
        switch (index) {
            case 0: // init
                await this.initializeResources();
                break;
            case 1: // process
                const agent = await this.requestAgent('engineer');
                await this.processWithAgent(agent);
                break;
            case 2: // finalize
                await this.saveResults();
                break;
        }
    }
    
    getOutput(): any {
        return { results: this.results };
    }
    
    getState(): object {
        return {
            phaseIndex: this.phaseIndex,
            results: this.results
        };
    }
}
```

## Workflow Events

| Event | Description |
|-------|-------------|
| `workflow.started` | Workflow began execution |
| `workflow.progress` | Phase completed or progress update |
| `workflow.completed` | Workflow finished successfully |
| `workflow.failed` | Workflow failed with error |
| `workflow.paused` | Workflow was paused |
| `workflow.resumed` | Workflow resumed from pause |
| `workflow.cancelled` | Workflow was cancelled |

