# Coordinator System

The Coordinator is an event-driven orchestration system that manages workflow execution, agent allocation, and task scheduling based on system events.

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Coordinator System                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                      Events                                 │ │
│  │  execution_started │ workflow_completed │ workflow_failed   │ │
│  │  unity_error │ agent_available │ task_paused │ task_resumed │ │
│  └───────────────────────────┬────────────────────────────────┘ │
│                              │                                   │
│                              ▼                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │              UnifiedCoordinatorService                      │ │
│  │                                                             │ │
│  │  • Event handling                                           │ │
│  │  • Decision making                                          │ │
│  │  • Workflow dispatch                                        │ │
│  │  • State tracking                                           │ │
│  └───────────────────────────┬────────────────────────────────┘ │
│                              │                                   │
│              ┌───────────────┼───────────────┐                   │
│              ▼               ▼               ▼                   │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐    │
│  │ TaskManager    │  │ AgentPool      │  │ Workflows      │    │
│  │                │  │ Service        │  │                │    │
│  └────────────────┘  └────────────────┘  └────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Source Files

| File | Description |
|------|-------------|
| `src/services/UnifiedCoordinatorService.ts` | Main coordinator implementation |
| `src/services/CoordinatorAgent.ts` | AI-based coordinator agent |
| `src/services/CoordinatorContext.ts` | Context building for coordinator |
| `src/types/coordinator.ts` | Coordinator type definitions |

## Event Types

```typescript
type CoordinatorEventType =
    | 'execution_started'     // startExecution() called
    | 'workflow_completed'    // A workflow finished successfully
    | 'workflow_failed'       // A workflow failed
    | 'workflow_blocked'      // A workflow needs dependency/clarification
    | 'unity_error'           // Unity compilation/test errors
    | 'user_responded'        // User provided clarification
    | 'agent_available'       // An agent became available
    | 'task_paused'           // Tasks were paused
    | 'task_resumed'          // Tasks were resumed
    | 'manual_evaluation';    // Manual trigger for re-evaluation
```

## Event Flow

```
┌─────────────┐
│   Event     │
│  (trigger)  │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────────────┐
│          Coordinator Evaluates              │
│                                             │
│  1. Build context (tasks, agents, history)  │
│  2. Determine available actions             │
│  3. Make decision                           │
│  4. Execute actions                         │
└──────┬──────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────┐
│            Possible Actions                 │
│                                             │
│  • Dispatch task workflow                   │
│  • Pause affected workflows                 │
│  • Resume paused tasks                      │
│  • Ask user for clarification               │
│  • Trigger error resolution                 │
│  • Wait (no action needed)                  │
└─────────────────────────────────────────────┘
```

## Coordinator Input

What the coordinator sees when making decisions:

```typescript
interface CoordinatorInput {
    // Trigger
    event: CoordinatorEvent;
    sessionId: string;
    
    // Plan Context
    approvedPlans: PlanSummary[];
    
    // Current State
    availableAgents: string[];
    agentStatuses: AgentStatus[];
    tasks: TaskSummary[];
    activeWorkflows: ActiveWorkflowSummary[];
    sessionStatus: string;
    pendingQuestions: PendingQuestion[];
    
    // Capacity Planning
    sessionCapacities: SessionCapacity[];
    
    // History
    history: CoordinatorHistoryEntry[];
}
```

### Task Summary

```typescript
interface TaskSummary {
    id: string;
    sessionId?: string;
    description: string;
    status: 'created' | 'pending' | 'in_progress' | 'completed' | 'failed' | 'paused' | 'blocked';
    type: 'implementation' | 'error_fix' | 'context_gathering';
    dependencies: string[];
    dependencyStatus: 'all_complete' | 'some_pending' | 'some_failed';
    assignedAgent?: string;
    errors?: string[];
    attempts: number;
    priority: number;
}
```

### Session Capacity

```typescript
interface SessionCapacity {
    sessionId: string;
    recommendedAgents: number;    // From plan
    currentlyAllocated: number;   // Busy + bench
    availableCapacity: number;    // Can still allocate
    activeWorkflows: number;      // Running workflows
}
```

## Coordinator Decision

```typescript
interface CoordinatorDecision {
    reasoning: string;      // Explanation for logging
    confidence: number;     // 0-1 confidence level
}
```

## History Tracking

```typescript
interface CoordinatorHistoryEntry {
    timestamp: string;
    
    event: {
        type: CoordinatorEventType;
        summary: string;
    };
    
    decision: {
        dispatchCount: number;
        dispatchedTasks: string[];
        askedUser: boolean;
        pausedCount: number;
        resumedCount: number;
        reasoning: string;
    };
    
    outcome?: {
        success: boolean;
        notes?: string;
        completedAt?: string;
    };
}
```

## Unified Coordinator Service

### Core Methods

```typescript
class UnifiedCoordinatorService {
    // Start execution for a session
    startExecution(sessionId: string): Promise<StartExecutionResult>;
    
    // Pause execution
    pauseExecution(sessionId: string): Promise<void>;
    
    // Resume execution
    resumeExecution(sessionId: string): Promise<void>;
    
    // Stop execution (release all agents)
    stopExecution(sessionId: string): Promise<void>;
    
    // Handle event
    handleEvent(event: CoordinatorEvent): Promise<void>;
    
    // Get status
    getStatus(sessionId: string): CoordinatorStatus;
    
    // Graceful shutdown
    gracefulShutdown(): Promise<GracefulShutdownResult>;
}
```

### Workflow Management

```typescript
// Start a workflow
startWorkflow(type: WorkflowType, config: WorkflowConfig): Promise<string>;

// Get active workflows
getActiveWorkflows(sessionId?: string): ActiveWorkflowSummary[];

// Get workflow by ID
getWorkflow(workflowId: string): IWorkflow | undefined;

// Cancel workflow
cancelWorkflow(workflowId: string): Promise<void>;
```

## Decision Making

### Task Selection

Tasks are selected for execution based on:

1. **Dependencies satisfied** - All dependent tasks completed
2. **Not already running** - No active workflow for this task
3. **Priority** - Higher priority tasks first
4. **Capacity** - Agents available

```typescript
function getReadyTasks(sessionId: string): TaskSummary[] {
    return tasks.filter(task => 
        task.status === 'pending' &&
        task.dependencyStatus === 'all_complete' &&
        !isTaskOccupied(task.id)
    ).sort((a, b) => b.priority - a.priority);
}
```

### Agent Allocation

```typescript
function shouldAllocateAgent(session: SessionCapacity): boolean {
    return session.availableCapacity > 0 &&
           session.activeWorkflows < session.recommendedAgents;
}
```

## Event Handlers

### execution_started

```typescript
async handleExecutionStarted(event: ExecutionStartedPayload): Promise<void> {
    // Parse plan to get tasks
    const tasks = await this.parsePlan(event.planPath);
    
    // Create tasks in TaskManager
    for (const task of tasks) {
        this.taskManager.createTask(task);
    }
    
    // Start dispatching ready tasks
    await this.dispatchReadyTasks(event.sessionId);
}
```

### workflow_completed

```typescript
async handleWorkflowCompleted(event: WorkflowCompletedPayload): Promise<void> {
    // Mark task as completed
    if (event.taskId) {
        this.taskManager.updateTask(event.taskId, { status: 'completed' });
    }
    
    // Check for newly unblocked tasks
    await this.dispatchReadyTasks(event.sessionId);
    
    // Check if all tasks complete
    if (this.allTasksComplete(event.sessionId)) {
        this.broadcastSessionComplete(event.sessionId);
    }
}
```

### workflow_failed

```typescript
async handleWorkflowFailed(event: WorkflowFailedPayload): Promise<void> {
    if (event.canRetry && event.attempts < 3) {
        // Retry the task
        await this.retryTask(event.taskId);
    } else {
        // Mark as failed, pause dependent tasks
        this.taskManager.updateTask(event.taskId, { status: 'failed' });
        await this.pauseDependentTasks(event.taskId);
        
        // Notify user
        this.notifyTaskFailed(event);
    }
}
```

### unity_error

```typescript
async handleUnityError(event: UnityErrorPayload): Promise<void> {
    // Pause affected tasks
    for (const taskId of event.affectedTaskIds) {
        await this.pauseTask(taskId);
    }
    
    // Start error resolution workflow
    await this.startWorkflow('error_resolution', {
        sessionId: this.sessionId,
        input: {
            errors: event.errors,
            affectedTasks: event.affectedTaskIds
        }
    });
}
```

## Graceful Shutdown

```typescript
async gracefulShutdown(): Promise<GracefulShutdownResult> {
    const result = {
        workflowsPaused: 0,
        agentsReleased: 0
    };
    
    // Pause all running workflows
    for (const workflow of this.activeWorkflows.values()) {
        if (workflow.getStatus() === 'running') {
            await workflow.pause();
            result.workflowsPaused++;
        }
    }
    
    // Release all agents
    const released = this.poolService.releaseSessionAgents(this.sessionId);
    result.agentsReleased = released.length;
    
    return result;
}
```

## Coordinator Configuration

```typescript
interface CoordinatorAgentConfig {
    maxHistoryEntries: number;     // Default: 20
    evaluationTimeout: number;     // Default: 300000 (5 min)
    model: string;                 // Default: 'sonnet-4.5'
    includePlanContent: boolean;   // Default: true
    maxPlanContentLength: number;  // Default: 50000
    debug: boolean;                // Default: false
}
```

## Multi-Session Support

The coordinator can manage multiple planning sessions simultaneously:

```typescript
// Get all active sessions
const sessions = coordinator.getActiveSessions();

// Get status for specific session
const status = coordinator.getStatus(sessionId);

// Each session has its own:
// - Task list
// - Active workflows
// - Agent capacity
// - History
```

## Events Broadcast

| Event | Description |
|-------|-------------|
| `coordinator.started` | Coordinator started for session |
| `coordinator.statusChanged` | Status changed (paused, running, etc.) |
| `coordinator.taskDispatched` | Task workflow started |
| `coordinator.sessionComplete` | All tasks completed |
| `task.failedFinal` | Task failed permanently |

## Example: Execution Flow

```
1. User approves plan (ps_001)
          │
          ▼
2. startExecution(ps_001)
          │
          ├── Parse plan → [Task A, Task B, Task C]
          ├── Task B depends on Task A
          └── Task C depends on Task A
          │
          ▼
3. Event: execution_started
          │
          ▼
4. Dispatch ready tasks (Task A)
          │
          ├── Allocate agent (Alex)
          └── Start TaskImplementationWorkflow
          │
          ▼
5. Event: workflow_completed (Task A)
          │
          ├── Mark Task A complete
          └── Check dependencies
          │
          ▼
6. Dispatch ready tasks (Task B, Task C)
          │
          ├── Allocate agents (Betty, Cleo)
          └── Start 2 TaskImplementationWorkflows
          │
          ▼
7. Events: workflow_completed (B), workflow_completed (C)
          │
          ▼
8. All tasks complete → session_complete event
```

