# Client System

The client system provides interfaces for communicating with the APC daemon. The primary client is the VS Code extension, but the architecture supports multiple client types.

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Client Architecture                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    IApcClient Interface                     │ │
│  │  • connect/disconnect                                       │ │
│  │  • send commands                                            │ │
│  │  • subscribe to events                                      │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│                              ▼                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    BaseApcClient                            │ │
│  │  • Connection state management                              │ │
│  │  • Request/response handling                                │ │
│  │  • Auto-reconnect logic                                     │ │
│  │  • Event emission                                           │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│              ┌───────────────┴───────────────┐                   │
│              ▼                               ▼                   │
│  ┌────────────────────┐          ┌────────────────────┐        │
│  │    VsCodeClient    │          │   Future Clients   │        │
│  │  (WebSocket impl)  │          │  (TUI, Headless)   │        │
│  └────────────────────┘          └────────────────────┘        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Source Files

| File | Description |
|------|-------------|
| `src/client/ApcClient.ts` | Client interface and base implementation |
| `src/client/Protocol.ts` | Request/response/event type definitions |
| `src/client/ClientEvents.ts` | Event type helpers |
| `src/vscode/VsCodeClient.ts` | VS Code WebSocket client |
| `src/vscode/DaemonManager.ts` | Daemon lifecycle management |

## Client Interface

### IApcClient

```typescript
interface IApcClient {
    // Connection
    connect(url?: string): Promise<void>;
    disconnect(): void;
    isConnected(): boolean;
    getConnectionState(): ConnectionState;
    ping(timeoutMs?: number): Promise<boolean>;
    
    // Commands
    send<T>(cmd: string, params?: Record<string, unknown>): Promise<T>;
    sendAsync(cmd: string, params?: Record<string, unknown>): void;
    
    // Events
    on(event: string, handler: (data: unknown) => void): () => void;
    onAny(handler: (event: ApcEvent) => void): () => void;
    off(event: string, handler: (...args: unknown[]) => void): void;
}
```

### Connection States

```typescript
type ConnectionState = 
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'error';
```

## Client Options

```typescript
interface ApcClientOptions {
    url?: string;                  // Default: ws://127.0.0.1:19840
    autoReconnect?: boolean;       // Default: true
    reconnectDelay?: number;       // Default: 1000ms
    maxReconnectAttempts?: number; // Default: 10
    requestTimeout?: number;       // Default: 30000ms
    clientId?: string;             // For logging
}
```

## VsCodeClient

The primary client implementation for VS Code:

### Features

- WebSocket connection to daemon
- Request timeout handling
- Auto-reconnect with exponential backoff
- Event subscription management
- Notification callbacks for VS Code UI

### Initialization

```typescript
// In extension.ts
const vsCodeClient = new VsCodeClient({ 
    clientId: `vscode-${process.pid}`,
    url: `ws://127.0.0.1:${port}`
});

// Set up notification callbacks
vsCodeClient.setNotificationCallbacks({
    showInfo: (msg) => vscode.window.showInformationMessage(msg),
    showWarning: (msg) => vscode.window.showWarningMessage(msg),
    showError: (msg) => vscode.window.showErrorMessage(msg)
});

await vsCodeClient.connect();
```

### Convenience Methods

VsCodeClient provides typed methods for common operations:

```typescript
// Sessions
await client.createSession(requirement, docs);
await client.getPlanningSessions();
await client.getPlanStatus(sessionId);

// Execution
await client.startExecution(sessionId);
await client.pauseExecution(sessionId);
await client.resumeExecution(sessionId);
await client.stopExecution(sessionId);

// Pool
await client.getPoolStatus();
await client.resizePool(newSize);
await client.releaseAgent(agentName);

// Plans
await client.approvePlan(sessionId, autoStart);
await client.revisePlan(sessionId, feedback);

// Unity
await client.getUnityStatus();
await client.triggerUnityPipeline(options);
```

## DaemonManager

Manages the daemon lifecycle from VS Code:

### Responsibilities

- Check if daemon is already running
- Start daemon process if needed
- Monitor daemon health
- Handle daemon restart

### Usage

```typescript
const daemonManager = new DaemonManager(workspaceRoot, extensionPath);

// Ensure daemon is running (starts if needed)
const { port, wasStarted, isExternal } = await daemonManager.ensureDaemonRunning();

// Health monitoring
daemonManager.startHealthMonitoring(15000); // Check every 15s

// Cleanup
await daemonManager.dispose();
```

### Daemon Detection

```typescript
// Check PID and port files
isDaemonRunning(workspaceRoot): boolean
getDaemonPort(workspaceRoot): number | null

// Files checked:
// _AiDevLog/.daemon_pid
// _AiDevLog/.daemon_port
```

## DaemonStateProxy

Bridges the VS Code UI with daemon state:

### Purpose

- Provides a unified interface for state queries
- Caches state to reduce daemon calls
- Handles connection status

### Usage in UI

```typescript
const proxy = new DaemonStateProxy({
    vsCodeClient,
    unityEnabled: true,
    workspaceRoot
});

// UI components use proxy
const sessions = await proxy.getPlanningSessions();
const pool = await proxy.getPoolStatus();
const workflows = await proxy.getActiveWorkflows();
```

## Protocol

### Request Format

```typescript
interface ApcRequest {
    id: string;           // Unique request ID
    cmd: string;          // Command (e.g., 'pool.status')
    params?: Record<string, unknown>;
    clientId?: string;    // Sender identification
}
```

### Response Format

```typescript
interface ApcResponse {
    id: string;           // Matches request ID
    success: boolean;
    data?: unknown;       // Response payload
    error?: string;       // Error message if !success
    message?: string;     // Optional status message
}
```

### Event Format

```typescript
interface ApcEvent {
    event: ApcEventType;  // Event name
    data: unknown;        // Event payload
    timestamp: string;    // ISO timestamp
}
```

## Event Subscription

### Subscribing to Events

```typescript
// Subscribe to specific event
const unsubscribe = client.subscribe('workflow.completed', (data) => {
    console.log('Workflow completed:', data);
});

// Subscribe to all events
client.subscribeAll((event) => {
    console.log(`${event.event}:`, event.data);
});

// Unsubscribe
unsubscribe();
```

### Common Events

| Event | Data | Description |
|-------|------|-------------|
| `session.created` | `{ sessionId }` | New planning session |
| `session.updated` | `{ sessionId, status }` | Session status change |
| `workflow.completed` | `{ workflowId, result }` | Workflow finished |
| `agent.allocated` | `{ agentName, sessionId }` | Agent assigned |
| `pool.changed` | `{ available, busy }` | Pool state change |
| `task.failedFinal` | `{ taskId, error }` | Task failed permanently |

## Request/Response Examples

### Pool Status

```typescript
// Request
await client.send('pool.status');

// Response
{
    total: 10,
    available: ['Alex', 'Betty', 'Cleo'],
    allocated: ['Dany'],
    busy: ['Echo', 'Finn']
}
```

### Create Session

```typescript
// Request
await client.send('session.create', {
    requirement: 'Implement combo system',
    docs: ['docs/combat.md']
});

// Response
{
    sessionId: 'ps_abc123',
    status: 'planning'
}
```

### Start Execution

```typescript
// Request
await client.send('exec.start', { sessionId: 'ps_abc123' });

// Response
{
    success: true,
    engineerCount: 3,
    coordinatorId: 'coord_xyz'
}
```

## Connection Handling

### Auto-Reconnect

```typescript
// Exponential backoff
attempt 1: wait 1000ms
attempt 2: wait 2000ms
attempt 3: wait 4000ms
...
attempt 10: give up, emit 'error'
```

### Health Monitoring

```typescript
// DaemonStateProxy monitors connection
proxy.startConnectionMonitor(15000);

// On disconnect
// - UI shows "disconnected" state
// - Auto-reconnect attempts begin
// - Events are buffered/dropped
```

## Extension Activation

The VS Code extension activation flow:

```typescript
export async function activate(context: vscode.ExtensionContext) {
    // 1. Create UI providers (shows "connecting" state)
    const sidebarProvider = new SidebarViewProvider(context.extensionUri);
    
    // 2. Register UI immediately
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            SidebarViewProvider.viewType, 
            sidebarProvider
        )
    );
    
    // 3. Connect to daemon in background
    const daemonManager = new DaemonManager(workspaceRoot, extensionPath);
    const { port } = await daemonManager.ensureDaemonRunning();
    
    // 4. Create and connect client
    const vsCodeClient = new VsCodeClient({ url: `ws://127.0.0.1:${port}` });
    await vsCodeClient.connect();
    
    // 5. Create state proxy and pass to UI
    const proxy = new DaemonStateProxy({ vsCodeClient, ... });
    sidebarProvider.setStateProxy(proxy);
    
    // 6. Subscribe to events for UI updates
    vsCodeClient.subscribe('session.updated', () => sidebarProvider.refresh());
}
```

## Cleanup

On extension deactivation:

```typescript
export async function deactivate() {
    // 1. Stop monitoring
    daemonStateProxy.dispose();
    
    // 2. Unsubscribe all events
    for (const unsubscribe of eventSubscriptions) {
        unsubscribe();
    }
    
    // 3. Disconnect client (daemon stays running)
    vsCodeClient.dispose();
    
    // 4. Cleanup daemon manager
    await daemonManager.dispose();
}
```

Note: The daemon continues running after VS Code closes. It will auto-shutdown after 60s if no clients connect.

