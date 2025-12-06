# API Reference

This document details the WebSocket API for communicating with the APC daemon.

## Protocol Overview

### Message Format

All messages are JSON with a `type` field:

```typescript
type ApcMessage = 
    | { type: 'request'; payload: ApcRequest }
    | { type: 'response'; payload: ApcResponse }
    | { type: 'event'; payload: ApcEvent };
```

### Request Structure

```typescript
interface ApcRequest {
    id: string;                    // Unique request ID
    cmd: string;                   // Command name
    params?: Record<string, any>;  // Command parameters
    clientId?: string;             // Client identifier
}
```

### Response Structure

```typescript
interface ApcResponse {
    id: string;        // Matches request ID
    success: boolean;  // Operation success
    data?: any;        // Response data
    error?: string;    // Error message
    message?: string;  // Status message
}
```

### Event Structure

```typescript
interface ApcEvent {
    event: string;     // Event name
    data: any;         // Event payload
    timestamp: string; // ISO timestamp
}
```

## API Commands

### System Commands

#### `status`

Get daemon status.

**Request:**
```json
{ "id": "req_1", "cmd": "status" }
```

**Response:**
```json
{
    "id": "req_1",
    "success": true,
    "data": {
        "state": "running",
        "readyState": "ready",
        "uptime": 123456,
        "clients": 2,
        "servicesReady": true
    }
}
```

#### `daemon.status`

Get detailed daemon status with dependency info.

**Response Data:**
```typescript
{
    state: DaemonState;
    readyState: DaemonReadyState;
    servicesReady: boolean;
    uptime: number;
    clients: number;
    dependencies: DependencyStatus[];
    missingCount: number;
    hasCriticalMissing: boolean;
}
```

#### `config.get`

Get current configuration.

**Request:**
```json
{ "id": "req_1", "cmd": "config.get" }
```

**Response:**
```json
{
    "id": "req_1",
    "success": true,
    "data": {
        "port": 19840,
        "logLevel": "info",
        "agentPoolSize": 10,
        "autoOpenTerminals": true
    }
}
```

#### `config.update`

Update configuration.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "config.update",
    "params": {
        "logLevel": "debug",
        "agentPoolSize": 15
    }
}
```

---

### Session Commands

#### `session.list`

List all planning sessions.

**Response:**
```typescript
{
    sessions: PlanningSession[];
}
```

#### `session.create`

Create new planning session.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "session.create",
    "params": {
        "requirement": "Implement combo system",
        "docs": ["docs/combat.md"]
    }
}
```

**Response:**
```json
{
    "id": "req_1",
    "success": true,
    "data": {
        "sessionId": "ps_abc123",
        "status": "planning"
    }
}
```

#### `session.status`

Get session status.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "session.status",
    "params": { "sessionId": "ps_abc123" }
}
```

**Response:**
```typescript
{
    sessionId: string;
    status: PlanningSessionStatus;
    requirement: string;
    planPath?: string;
    tasksTotal?: number;
    tasksCompleted?: number;
    activeWorkflows: string[];
}
```

#### `session.stop`

Stop a session.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "session.stop",
    "params": { "sessionId": "ps_abc123" }
}
```

#### `session.remove`

Remove a session and its data.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "session.remove",
    "params": { "sessionId": "ps_abc123" }
}
```

---

### Plan Commands

#### `plan.status`

Get plan status and details.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "plan.status",
    "params": { "sessionId": "ps_abc123" }
}
```

**Response:**
```typescript
{
    sessionId: string;
    status: PlanningSessionStatus;
    requirement: string;
    currentPlanPath?: string;
    revisionCount: number;
    recommendedAgents?: number;
    activeWorkflowId?: string;
}
```

#### `plan.approve`

Approve a plan for execution.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "plan.approve",
    "params": {
        "sessionId": "ps_abc123",
        "autoStart": true
    }
}
```

#### `plan.revise`

Request plan revision.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "plan.revise",
    "params": {
        "sessionId": "ps_abc123",
        "feedback": "Add more unit tests"
    }
}
```

#### `plan.cancel`

Cancel ongoing planning.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "plan.cancel",
    "params": { "sessionId": "ps_abc123" }
}
```

#### `plan.restart`

Restart planning from beginning.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "plan.restart",
    "params": { "sessionId": "ps_abc123" }
}
```

---

### Execution Commands

#### `exec.start`

Start execution for approved plan.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "exec.start",
    "params": { "sessionId": "ps_abc123" }
}
```

**Response:**
```typescript
{
    success: boolean;
    engineerCount: number;
    coordinatorId?: string;
    error?: string;
}
```

#### `exec.pause`

Pause execution.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "exec.pause",
    "params": { "sessionId": "ps_abc123" }
}
```

#### `exec.resume`

Resume paused execution.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "exec.resume",
    "params": { "sessionId": "ps_abc123" }
}
```

#### `exec.stop`

Stop execution and release agents.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "exec.stop",
    "params": { "sessionId": "ps_abc123" }
}
```

#### `exec.status`

Get execution status.

**Response:**
```typescript
{
    sessionId: string;
    status: string;
    tasksTotal: number;
    tasksCompleted: number;
    tasksFailed: number;
    tasksInProgress: number;
    activeWorkflows: ActiveWorkflowSummary[];
    allocatedAgents: string[];
}
```

---

### Pool Commands

#### `pool.status`

Get agent pool status.

**Response:**
```typescript
{
    total: number;
    available: string[];
    allocated: string[];
    busy: string[];
    resting?: string[];
}
```

#### `pool.resize`

Resize the agent pool.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "pool.resize",
    "params": { "size": 15 }
}
```

**Response:**
```typescript
{
    success: boolean;
    added: string[];
    removed: string[];
}
```

#### `pool.agents`

Get detailed agent information.

**Response:**
```typescript
{
    agents: AgentStatus[];
}
```

#### `pool.release`

Release a specific agent.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "pool.release",
    "params": { "agentName": "Alex" }
}
```

---

### Workflow Commands

#### `workflow.list`

List active workflows.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "workflow.list",
    "params": { "sessionId": "ps_abc123" }
}
```

**Response:**
```typescript
{
    workflows: ActiveWorkflowSummary[];
}
```

#### `workflow.status`

Get workflow details.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "workflow.status",
    "params": { "workflowId": "wf_xyz789" }
}
```

**Response:**
```typescript
{
    id: string;
    type: WorkflowType;
    status: WorkflowStatus;
    sessionId: string;
    phase: string;
    phaseIndex: number;
    totalPhases: number;
    progress: number;
    startTime: number;
    elapsedMs: number;
}
```

#### `workflow.cancel`

Cancel a workflow.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "workflow.cancel",
    "params": { "workflowId": "wf_xyz789" }
}
```

---

### Task Commands

#### `task.list`

List tasks for session.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "task.list",
    "params": { "sessionId": "ps_abc123" }
}
```

**Response:**
```typescript
{
    tasks: TaskSummary[];
}
```

#### `task.retry`

Retry a failed task.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "task.retry",
    "params": {
        "sessionId": "ps_abc123",
        "taskId": "task_002"
    }
}
```

**Response:**
```typescript
{
    success: boolean;
    workflowId?: string;
    error?: string;
}
```

---

### Role Commands

#### `roles.list`

List all agent roles.

**Response:**
```typescript
{
    roles: AgentRole[];
}
```

#### `roles.get`

Get specific role.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "roles.get",
    "params": { "roleId": "engineer" }
}
```

#### `roles.update`

Update a role.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "roles.update",
    "params": {
        "roleId": "engineer",
        "systemPrompt": "Updated prompt..."
    }
}
```

---

### Unity Commands

#### `unity.status`

Get Unity status.

**Response:**
```typescript
{
    detected: boolean;
    projectPath?: string;
    compileStatus: string;
    testStatus: string;
    errors: UnityError[];
    warnings: number;
}
```

#### `unity.compile`

Trigger compilation.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "unity.compile",
    "params": { "forceRefresh": false }
}
```

#### `unity.test`

Run tests.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "unity.test",
    "params": {
        "filter": "ComboTests",
        "timeout": 300
    }
}
```

#### `unity.pipeline`

Run full pipeline.

**Request:**
```json
{
    "id": "req_1",
    "cmd": "unity.pipeline",
    "params": {
        "compile": true,
        "test": true
    }
}
```

---

### Process Commands

#### `process.killOrphans`

Kill orphaned cursor-agent processes.

**Response:**
```typescript
{
    killed: number;
}
```

---

## Events

### Daemon Events

| Event | Data |
|-------|------|
| `daemon.starting` | `{ version, port, workspaceRoot }` |
| `daemon.ready` | `{ version, servicesReady }` |
| `daemon.shutdown` | `{ reason, graceful }` |

### Client Events

| Event | Data |
|-------|------|
| `client.connected` | `{ clientId, clientType, totalClients }` |
| `client.disconnected` | `{ clientId, reason, totalClients }` |

### Session Events

| Event | Data |
|-------|------|
| `session.created` | `{ sessionId, requirement }` |
| `session.updated` | `{ sessionId, status, changes }` |
| `session.completed` | `{ sessionId, success }` |

### Workflow Events

| Event | Data |
|-------|------|
| `workflow.started` | `{ workflowId, type, sessionId }` |
| `workflow.progress` | `{ workflowId, phase, progress }` |
| `workflow.completed` | `{ workflowId, success, result }` |
| `workflows.cleaned` | `{ count }` |

### Agent Events

| Event | Data |
|-------|------|
| `agent.allocated` | `{ agentName, sessionId, roleId, logFile }` |
| `agent.released` | `{ agentName }` |
| `pool.changed` | `{ total, available, busy }` |

### Coordinator Events

| Event | Data |
|-------|------|
| `coordinator.started` | `{ sessionId }` |
| `coordinator.statusChanged` | `{ sessionId, status }` |

### Task Events

| Event | Data |
|-------|------|
| `task.failedFinal` | `{ taskId, sessionId, error, canRetry }` |

### Unity Events

| Event | Data |
|-------|------|
| `unity.statusChanged` | `{ compileStatus, testStatus }` |
| `unity.pipelineStarted` | `{ steps }` |
| `unity.pipelineCompleted` | `{ success, results }` |

---

## Subscriptions

### Subscribe to Session

Subscribe to events for a specific session:

```json
{
    "id": "req_1",
    "cmd": "subscribe",
    "params": { "sessionId": "ps_abc123" }
}
```

### Unsubscribe

```json
{
    "id": "req_1",
    "cmd": "unsubscribe",
    "params": { "sessionId": "ps_abc123" }
}
```

---

## Error Codes

| Code | Message |
|------|---------|
| `NOT_CONNECTED` | Not connected to daemon |
| `SESSION_NOT_FOUND` | Session does not exist |
| `WORKFLOW_NOT_FOUND` | Workflow does not exist |
| `AGENT_NOT_FOUND` | Agent does not exist |
| `INVALID_STATE` | Operation not valid in current state |
| `TIMEOUT` | Operation timed out |
| `INTERNAL_ERROR` | Internal daemon error |

---

## Rate Limiting

No explicit rate limiting, but clients should:
- Avoid polling more than once per second
- Use events instead of polling when possible
- Batch related operations

---

## WebSocket Connection

### Connect

```javascript
const ws = new WebSocket('ws://127.0.0.1:19840');

ws.onopen = () => {
    console.log('Connected to APC daemon');
};

ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    // Handle message
};
```

### Send Request

```javascript
function sendRequest(cmd, params) {
    const request = {
        type: 'request',
        payload: {
            id: `req_${Date.now()}`,
            cmd,
            params
        }
    };
    ws.send(JSON.stringify(request));
}
```

### Handle Response

```javascript
ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    
    if (message.type === 'response') {
        const response = message.payload;
        if (response.success) {
            console.log('Data:', response.data);
        } else {
            console.error('Error:', response.error);
        }
    } else if (message.type === 'event') {
        const event = message.payload;
        console.log(`Event: ${event.event}`, event.data);
    }
};
```

