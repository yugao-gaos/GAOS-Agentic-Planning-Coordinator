# Daemon System

The APC Daemon is a WebSocket server that hosts all business logic and services. It runs as a standalone Node.js process and manages client connections, state persistence, and workflow execution.

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         APC Daemon                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    HTTP Server                              │ │
│  │  • Health endpoint: GET /health                             │ │
│  │  • WebSocket upgrade handling                               │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│                              ▼                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                  WebSocket Server                           │ │
│  │  • Client connection management                             │ │
│  │  • Message routing                                          │ │
│  │  • Event broadcasting                                       │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│              ┌───────────────┼───────────────┐                   │
│              ▼               ▼               ▼                   │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐    │
│  │  ApiHandler    │  │EventBroadcaster│  │  ConfigLoader  │    │
│  │                │  │                │  │                │    │
│  └────────────────┘  └────────────────┘  └────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Source Files

| File | Description |
|------|-------------|
| `src/daemon/ApcDaemon.ts` | Main daemon class, WebSocket server |
| `src/daemon/ApiHandler.ts` | Request routing and handling |
| `src/daemon/EventBroadcaster.ts` | Event broadcasting to clients |
| `src/daemon/DaemonConfig.ts` | Configuration and file management |
| `src/daemon/standalone.ts` | Standalone entry point |
| `src/daemon/start.ts` | Daemon startup with service initialization |

## Daemon Lifecycle

### States

```typescript
type DaemonState = 'stopped' | 'starting' | 'running' | 'stopping';
type DaemonReadyState = 'starting' | 'checking_dependencies' | 'initializing_services' | 'ready';
```

### Startup Sequence

```
1. stopped
      │
      ▼
2. starting
      │
      ├── Check if daemon already running (PID file)
      ├── Create HTTP server
      ├── Create WebSocket server
      ├── Start listening on port
      └── Write PID and port files
      │
      ▼
3. running (readyState: initializing_services)
      │
      ├── Initialize all services (StateManager, AgentPool, etc.)
      ├── Register with ServiceLocator
      └── Mark services ready
      │
      ▼
4. running (readyState: ready)
      │
      └── Accept and handle client requests
```

### Shutdown Sequence

```
1. running
      │
      ▼
2. stopping
      │
      ├── Graceful coordinator shutdown
      │   └── Pause workflows, release agents
      ├── Broadcast shutdown event
      ├── Close all client connections
      ├── Close WebSocket server
      ├── Close HTTP server
      └── Cleanup PID files
      │
      ▼
3. stopped
```

## Configuration

### Default Configuration

```typescript
interface CoreConfig {
    workspaceRoot: string;      // Project root directory
    workingDirectory: string;   // Default: '_AiDevLog'
    port: number;               // Default: 19840
    autoOpenTerminals: boolean; // Default: true
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    defaultBackend: string;     // Default: 'cursor'
    agentPoolSize: number;      // Default: 10
}
```

### Configuration File

Located at `_AiDevLog/.config/daemon.json`:

```json
{
  "port": 19840,
  "autoOpenTerminals": true,
  "logLevel": "info",
  "agentPoolSize": 10
}
```

### Port and PID Files

The daemon writes status files for discovery:

```
_AiDevLog/.daemon_pid      # Process ID
_AiDevLog/.daemon_port     # WebSocket port
```

## Client Management

### Connection Handling

```typescript
interface ConnectedClient {
    id: string;
    ws: WebSocket;
    type: 'vscode' | 'tui' | 'headless' | 'unknown';
    connectedAt: string;
    lastActivity: string;
    subscribedSessions: Set<string>;
}
```

### Client Types

Client type is determined from headers:

```typescript
// X-APC-Client-Type header or User-Agent detection
parseClientType(req: http.IncomingMessage): ConnectedClient['type']
```

### Connection Events

When a client connects:
1. Generate unique client ID
2. Create ConnectedClient record
3. Send `client.connected` event to new client
4. Broadcast `client.connected` to other clients

When a client disconnects:
1. Unsubscribe from all sessions
2. Remove from clients map
3. Broadcast `client.disconnected` event
4. Start idle shutdown timer if no clients remain

## API Handler

The `ApiHandler` routes requests to appropriate services:

### Command Structure

Commands use dot notation: `category.action`

```
pool.status      → AgentPoolService.getPoolStatus()
session.create   → StateManager.createSession()
workflow.start   → UnifiedCoordinatorService.startWorkflow()
```

### Request Handling

```typescript
async handleRequest(request: ApcRequest): Promise<ApcResponse> {
    const [category, action] = request.cmd.split('.');
    
    switch (category) {
        case 'pool':
            return this.handlePoolCommand(action, request.params);
        case 'session':
            return this.handleSessionCommand(action, request.params);
        // ... etc
    }
}
```

## Event Broadcasting

The `EventBroadcaster` manages event distribution:

### Event Types

```typescript
type ApcEventType =
    | 'daemon.starting' | 'daemon.ready' | 'daemon.shutdown'
    | 'client.connected' | 'client.disconnected'
    | 'session.created' | 'session.updated'
    | 'workflow.started' | 'workflow.completed'
    | 'agent.allocated' | 'agent.released'
    | 'pool.changed'
    | 'unity.statusChanged'
    | 'task.failedFinal';
```

### Subscription System

Clients can subscribe to specific sessions:

```typescript
// Client subscribes to session events
broadcaster.subscribeToSession(clientId, sessionId);

// Events for that session are sent only to subscribers
broadcaster.broadcastToSession(sessionId, event);

// Or broadcast to all clients
broadcaster.broadcast('pool.changed', data);
```

## Idle Shutdown

The daemon automatically shuts down when idle:

```typescript
private static readonly IDLE_SHUTDOWN_MS = 60000;  // 60 seconds

private startIdleShutdownTimer(): void {
    this.idleShutdownTimer = setTimeout(async () => {
        await this.stop('idle_timeout');
    }, ApcDaemon.IDLE_SHUTDOWN_MS);
}
```

### Behavior

- Timer starts when last client disconnects
- Timer cancels when any client connects
- Graceful shutdown preserves workflow state

## Health Check

HTTP endpoint for health monitoring:

```
GET /health

Response:
{
    "status": "ok",           // or "initializing"
    "state": "running",
    "readyState": "ready",
    "uptime": 123456,
    "clients": 2,
    "servicesReady": true
}
```

## Graceful Shutdown

On shutdown, the daemon:

1. **Pauses all workflows** - Saves current state
2. **Releases all agents** - Returns to available pool
3. **Notifies clients** - Broadcasts shutdown event
4. **Saves state** - Persists to disk

This allows resumption when daemon restarts.

## Starting the Daemon

### From Extension

The VS Code extension auto-starts the daemon via `DaemonManager`:

```typescript
const daemonManager = new DaemonManager(workspaceRoot, extensionPath);
const { port, wasStarted } = await daemonManager.ensureDaemonRunning();
```

### From CLI

```bash
# Start in background (headless mode)
apc daemon run --headless

# Start in foreground (for debugging)
node out/daemon/standalone.js
```

### Programmatically

```typescript
import { ApcDaemon } from './daemon/ApcDaemon';

const daemon = new ApcDaemon({
    workspaceRoot: '/path/to/project',
    port: 19840,
    verbose: true
});

await daemon.start();
```

## Error Handling

### Startup Errors

- **Port in use**: Throws error with existing port
- **Already running**: Checks PID file, throws if daemon exists

### Runtime Errors

- **Service initialization failure**: Logs error, continues with degraded functionality
- **Client disconnection**: Cleanup and continue
- **Request timeout**: Return error response to client

## Logging

The daemon uses the unified Logger:

```typescript
const log = Logger.create('Daemon', 'ApcDaemon');

log.debug('Connection details');
log.info('Daemon started on port 19840');
log.warn('Client disconnected unexpectedly');
log.error('Failed to handle request:', error);
```

Log levels can be configured in `daemon.json`.

