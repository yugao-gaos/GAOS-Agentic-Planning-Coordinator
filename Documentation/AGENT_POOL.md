# Agent Pool System

The Agent Pool manages AI agent lifecycle, allocation, and release. Agents are named workers (Alex, Betty, Cleo, etc.) that execute workflows.

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Agent Pool Service                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    Available Agents                         │ │
│  │  [Alex] [Betty] [Cleo] [Dany] [Echo]                       │ │
│  │  Ready to be allocated to workflows                         │ │
│  └────────────────────────────────────────────────────────────┘ │
│                          │                                       │
│                          ▼ allocate()                            │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                  Allocated (Bench)                          │ │
│  │  [Finn → workflow_123] [Gwen → workflow_456]               │ │
│  │  Reserved by workflow, waiting to start work                │ │
│  └────────────────────────────────────────────────────────────┘ │
│                          │                                       │
│                          ▼ promoteAgentToBusy()                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                      Busy Agents                            │ │
│  │  [Hugo → Task 1] [Iris → Task 2]                           │ │
│  │  Actively executing workflow tasks                          │ │
│  └────────────────────────────────────────────────────────────┘ │
│                          │                                       │
│                          ▼ releaseAgents()                       │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                   Resting (Cooldown)                        │ │
│  │  [Jake → 3s remaining]                                      │ │
│  │  5 second cooldown before returning to available            │ │
│  └────────────────────────────────────────────────────────────┘ │
│                          │                                       │
│                          ▼ (automatic after 5s)                  │
│                    Back to Available                             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Source Files

| File | Description |
|------|-------------|
| `src/services/AgentPoolService.ts` | Main pool management service |
| `src/services/AgentRoleRegistry.ts` | Agent role definitions |
| `src/types/index.ts` | Agent state type definitions |

## Agent States

### State Machine

```
                    allocate()
    ┌──────────────────────────────────────┐
    │                                      │
    ▼                                      │
┌─────────┐                         ┌──────┴──────┐
│AVAILABLE│                         │  ALLOCATED  │
│         │                         │   (bench)   │
└────┬────┘                         └──────┬──────┘
     │                                     │
     │                                     │ promoteAgentToBusy()
     │                                     │
     │                                     ▼
     │                              ┌─────────────┐
     │                              │    BUSY     │
     │                              │             │
     │                              └──────┬──────┘
     │                                     │
     │      (auto after 5s)                │ releaseAgents()
     │    ┌─────────────────┐              │
     │    │                 │              │
     └────┤    RESTING      │◄─────────────┘
          │   (cooldown)    │
          └─────────────────┘
```

### State Definitions

| State | Description | Can Allocate? |
|-------|-------------|---------------|
| `available` | Ready for allocation | Yes |
| `allocated` | On workflow's bench, waiting for work | No |
| `busy` | Actively working on a task | No |
| `resting` | 5-second cooldown after release | No |

## Agent Names

Default pool of 20 agents:

```
Alex, Betty, Cleo, Dany, Echo, Finn, Gwen, Hugo, Iris, Jake,
Kate, Liam, Mona, Noah, Olga, Pete, Quinn, Rose, Sam, Tina
```

## Allocation

### Workflow-Scoped Bench

Agents are allocated to a specific workflow's bench:

```typescript
// Allocate 2 agents to workflow's bench
const agents = poolService.allocateAgents(
    sessionId,      // Session for capacity tracking
    workflowId,     // Workflow that owns these agents
    2,              // Number of agents
    'engineer'      // Role assignment
);
// Returns: ['Alex', 'Betty']
```

### Promotion to Busy

Workflows must explicitly promote agents when work starts:

```typescript
// When workflow is ready to use the agent
const success = poolService.promoteAgentToBusy(
    'Alex',         // Agent name
    workflowId,     // Workflow ID
    'Implementing combo system'  // Task description
);
```

### Release Flow

```typescript
// Release returns agents to resting state
poolService.releaseAgents(['Alex', 'Betty']);

// After 5 seconds, agents automatically return to available
```

## State Structure

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

### Busy Agent Info

```typescript
interface BusyAgentInfo {
    sessionId: string;
    roleId: string;
    workflowId: string;
    task?: string;
    startTime: string;
    logFile?: string;
    processId?: number;
}
```

### Allocated Agent Info

```typescript
interface AllocatedAgentInfo {
    sessionId: string;
    workflowId: string;
    roleId: string;
    allocatedAt: string;
}
```

### Resting Agent Info

```typescript
interface RestingAgentInfo {
    releasedAt: string;
    restUntil: string;  // ISO timestamp when cooldown ends
}
```

## Agent Roles

Agents are assigned roles that define their behavior:

### Default Roles

```typescript
const DEFAULT_ROLES = [
    {
        id: 'engineer',
        name: 'Engineer',
        description: 'General-purpose implementation agent',
        systemPrompt: '...',
        capabilities: ['code', 'test', 'debug']
    },
    {
        id: 'planner',
        name: 'Planner',
        description: 'Creates and refines execution plans',
        systemPrompt: '...',
        capabilities: ['planning', 'analysis']
    },
    {
        id: 'analyst',
        name: 'Analyst',
        description: 'Reviews and critiques plans',
        systemPrompt: '...',
        capabilities: ['review', 'analysis']
    }
];
```

### Role Registry

```typescript
// Get a role
const role = roleRegistry.getRole('engineer');

// Get all roles
const roles = roleRegistry.getAllRoles();

// Add custom role
roleRegistry.registerRole({
    id: 'custom',
    name: 'Custom Role',
    // ...
});
```

## Pool Operations

### Get Pool Status

```typescript
const status = poolService.getPoolStatus();
// {
//     total: 10,
//     available: ['Alex', 'Betty', 'Cleo'],
//     allocated: ['Dany'],
//     busy: ['Echo', 'Finn']
// }
```

### Get Pool Summary

```typescript
const summary = poolService.getPoolSummary();
// {
//     total: 10,
//     available: 3,
//     resting: 1,
//     allocated: 2,
//     busy: 4,
//     byRole: { engineer: 3, planner: 1 }
// }
```

### Resize Pool

```typescript
const result = poolService.resizePool(15);
// { added: ['Kate', 'Liam', 'Mona', 'Noah', 'Olga'], removed: [] }

const result2 = poolService.resizePool(8);
// { added: [], removed: ['Olga', 'Noah'] }
// Note: Only available agents can be removed
```

### Release Session Agents

```typescript
// Release all agents for a session
const released = poolService.releaseSessionAgents(sessionId);
// Returns: ['Echo', 'Finn', 'Gwen']
```

## Cooldown System

### Purpose

The 5-second resting cooldown:
- Prevents rapid reallocation of the same agent
- Allows cleanup of agent resources
- Provides a buffer between tasks

### Implementation

```typescript
private readonly REST_COOLDOWN_MS = 5000;  // 5 seconds

releaseAgents(agentNames: string[]): void {
    for (const name of agentNames) {
        // Move to resting state
        state.resting[name] = {
            releasedAt: new Date().toISOString(),
            restUntil: new Date(Date.now() + this.REST_COOLDOWN_MS).toISOString()
        };
        
        // Set timer for auto-transition
        setTimeout(() => {
            this.transitionRestingToAvailable(name);
        }, this.REST_COOLDOWN_MS);
    }
}
```

### Manual Transition

```typescript
// Process expired resting agents immediately
poolService.processRestingAgents();
```

## Query Methods

### Get Agent Status

```typescript
const status = poolService.getAgentStatus('Alex');
// { name: 'Alex', status: 'busy', sessionId: '...', task: '...' }
```

### Get Busy Agents

```typescript
const busy = poolService.getBusyAgents();
// [{ name: 'Alex', roleId: 'engineer', sessionId: '...', task: '...' }]
```

### Get Agents by Role

```typescript
const engineers = poolService.getAgentsByRole('engineer');
// [{ name: 'Alex', sessionId: '...', task: '...' }]
```

### Get Agents on Bench

```typescript
// Get all bench agents
const bench = poolService.getAgentsOnBench();

// Get bench agents for specific workflow
const workflowBench = poolService.getAgentsOnBench(workflowId);
```

## Force Release

For error recovery and cleanup:

```typescript
// Force immediate release (skips cooldown)
const success = poolService.forceReleaseAgent('Alex');
```

## Disposal

Cleanup on service shutdown:

```typescript
poolService.dispose();
// Cancels all resting timers to prevent memory leaks
```

## Events

The pool service triggers events via EventBroadcaster:

| Event | Trigger | Data |
|-------|---------|------|
| `pool.changed` | Any pool state change | Pool summary |
| `agent.allocated` | Agent allocated to workflow | Agent name, session, role |
| `agent.released` | Agent released back to pool | Agent name |

## Best Practices

### Allocation

1. Always allocate before starting work
2. Use workflow-specific allocations
3. Check availability before allocation

### Release

1. Always release agents when workflow completes
2. Use `releaseSessionAgents()` for session cleanup
3. Let cooldown complete before reallocating

### Error Handling

1. Use `forceReleaseAgent()` for stuck agents
2. Monitor pool summary for imbalances
3. Handle allocation failures gracefully

## Example: Workflow Using Pool

```typescript
class MyWorkflow {
    private poolService: AgentPoolService;
    private allocatedAgents: string[] = [];
    
    async start() {
        // Allocate agents to bench
        this.allocatedAgents = this.poolService.allocateAgents(
            this.sessionId,
            this.id,
            2,
            'engineer'
        );
        
        if (this.allocatedAgents.length === 0) {
            throw new Error('No agents available');
        }
        
        // Promote first agent when ready to work
        const agent = this.allocatedAgents[0];
        this.poolService.promoteAgentToBusy(agent, this.id, 'Task 1');
        
        // Do work...
        await this.executeTask(agent);
        
        // Release when done
        this.poolService.releaseAgents([agent]);
    }
}
```

