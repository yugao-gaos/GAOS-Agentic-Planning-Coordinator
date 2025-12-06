# UI Components

APC provides a rich UI through VS Code's extension APIs, including a sidebar, webview panels, and terminal integration.

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      UI Architecture                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    Activity Bar                             │ │
│  │  [Agentic Planning Icon]                                    │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│                              ▼                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    Sidebar Webview                          │ │
│  │  • Connection status                                        │ │
│  │  • Planning sessions                                        │ │
│  │  • Agent pool status                                        │ │
│  │  • Active workflows                                         │ │
│  │  • Unity status                                             │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    Panels (Webviews)                        │ │
│  │  • System Settings      • Dependency Map                   │ │
│  │  • Role Settings        • History View                     │ │
│  │  • Workflow Settings                                        │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    Terminals                                │ │
│  │  • Agent terminals (one per busy agent)                    │ │
│  │  • APC CLI terminal                                         │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Source Files

| File | Description |
|------|-------------|
| `src/ui/SidebarViewProvider.ts` | Main sidebar webview |
| `src/ui/SystemSettingsPanel.ts` | System settings panel |
| `src/ui/RoleSettingsPanel.ts` | Agent role configuration |
| `src/ui/WorkflowSettingsPanel.ts` | Workflow settings |
| `src/ui/DependencyMapPanel.ts` | Task dependency visualization |
| `src/ui/HistoryViewPanel.ts` | Workflow history view |
| `src/ui/AgentPoolProvider.ts` | Agent pool tree view |
| `src/ui/PlanningSessionsProvider.ts` | Sessions tree view |
| `src/services/TerminalManager.ts` | Terminal management |
| `src/ui/webview/` | Webview HTML/CSS/JS components |

## Sidebar

### SidebarViewProvider

The main sidebar displaying system status:

```typescript
class SidebarViewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'agenticPlanning.sidebarView';
    
    resolveWebviewView(webviewView: vscode.WebviewView): void;
    refresh(): void;
    setStateProxy(proxy: DaemonStateProxy): void;
}
```

### Sidebar Sections

1. **Connection Status**
   - Daemon connection indicator
   - Reconnection status

2. **Planning Sessions**
   - Active sessions list
   - Status badges
   - Action buttons (approve, revise, cancel)

3. **Agent Pool**
   - Available/busy/resting counts
   - Agent cards with status

4. **Active Workflows**
   - Running workflow progress
   - Phase indicators

5. **Unity Status** (if enabled)
   - Compilation status
   - Test results

### Webview Components

```
src/ui/webview/
├── SidebarTemplate.ts      # Main HTML template
├── components/
│   ├── AgentCard.ts        # Individual agent display
│   ├── SessionItem.ts      # Planning session item
│   ├── StatusBar.ts        # Status indicators
│   └── UnityControl.ts     # Unity controls
├── styles/
│   ├── base.ts             # Base styles
│   ├── agents.ts           # Agent-specific styles
│   ├── sessions.ts         # Session styles
│   └── unity.ts            # Unity styles
└── scripts/
    └── sidebar.ts          # Client-side JavaScript
```

## Settings Panels

### System Settings

Configure daemon and extension settings:

```typescript
class SystemSettingsPanel {
    static show(extensionUri: vscode.Uri, client: VsCodeClient): void;
}
```

**Settings:**
- Working directory
- Agent pool size
- Auto-open terminals
- Log level
- Default backend

### Role Settings

Configure agent roles:

```typescript
class RoleSettingsPanel {
    static showWithClient(client: VsCodeClient, extensionUri: vscode.Uri): void;
}
```

**Features:**
- View existing roles
- Edit role prompts
- Add custom roles
- Set role capabilities

### Workflow Settings

Configure workflow behavior:

```typescript
class WorkflowSettingsPanel {
    static show(extensionUri: vscode.Uri, workspaceRoot: string): void;
}
```

**Settings:**
- Planning iterations
- Retry policies
- Timeout configurations
- Context gathering presets

## Visualization Panels

### Dependency Map

Visual task dependency graph:

```typescript
class DependencyMapPanel {
    static show(
        sessionId: string,
        extensionUri: vscode.Uri,
        client: VsCodeClient
    ): void;
}
```

**Features:**
- Interactive DAG visualization
- Task status colors
- Dependency arrows
- Click to view details

### History View

Workflow execution history:

```typescript
class HistoryViewPanel {
    static show(
        sessionId: string,
        extensionUri: vscode.Uri,
        client: VsCodeClient
    ): void;
}
```

**Displays:**
- Timeline of events
- Workflow outcomes
- Coordinator decisions
- Error history

## Terminal Management

### TerminalManager

Manages VS Code terminals for agents:

```typescript
class TerminalManager {
    // Create terminal for agent
    createAgentTerminal(
        agentName: string,
        sessionId: string,
        logFile: string,
        workspaceRoot: string
    ): vscode.Terminal;
    
    // Show existing terminal
    showAgentTerminal(agentName: string): boolean;
    
    // Close terminal
    closeAgentTerminal(agentName: string): void;
    
    // Dispose all
    dispose(): void;
}
```

### Agent Terminals

Each busy agent gets a dedicated terminal:

```
┌─────────────────────────────────────────────────────────────┐
│ Terminal: Alex (ps_abc123)                           [X]    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ [2025-01-01 12:00:00] Agent Alex started                    │
│ [2025-01-01 12:00:01] Working on: Implement ComboManager    │
│ [2025-01-01 12:00:05] Reading files...                      │
│ [2025-01-01 12:00:10] Creating ComboManager.cs              │
│ [2025-01-01 12:00:30] Running tests...                      │
│ [2025-01-01 12:00:45] Task completed successfully           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Commands

### Registered Commands

| Command | Description |
|---------|-------------|
| `agenticPlanning.showDashboard` | Show dashboard |
| `agenticPlanning.startPlanning` | Start new planning |
| `agenticPlanning.startExecution` | Start execution |
| `agenticPlanning.pauseExecution` | Pause execution |
| `agenticPlanning.resumeExecution` | Resume execution |
| `agenticPlanning.stopExecution` | Stop execution |
| `agenticPlanning.showAgentTerminal` | Show agent terminal |
| `agenticPlanning.poolStatus` | Show pool status |
| `apc.openRoleSettings` | Open role settings |
| `apc.openDaemonSettings` | Open daemon settings |
| `agenticPlanning.revisePlan` | Revise plan |
| `agenticPlanning.approvePlan` | Approve plan |
| `agenticPlanning.openDependencyMap` | Show dependency map |
| `agenticPlanning.openHistoryView` | Show history |

### Command Registration

```typescript
context.subscriptions.push(
    vscode.commands.registerCommand('agenticPlanning.startPlanning', async () => {
        // Copy planning prompt to clipboard
        await vscode.env.clipboard.writeText(planningPrompt);
        // Open agent chat
        openAgentChat();
    })
);
```

## Event-Driven Updates

### UI Refresh on Events

```typescript
// Subscribe to events for UI updates
vsCodeClient.subscribe('session.created', () => {
    sidebarProvider.refresh();
});

vsCodeClient.subscribe('session.updated', () => {
    sidebarProvider.refresh();
});

vsCodeClient.subscribe('workflow.completed', (data) => {
    sidebarProvider.clearWorkflowTracking(data.workflowId);
    sidebarProvider.refresh();
});

vsCodeClient.subscribe('pool.changed', () => {
    sidebarProvider.refresh();
});
```

## Webview Communication

### Extension → Webview

```typescript
// Send data to webview
webviewView.webview.postMessage({
    type: 'update',
    data: {
        sessions: await proxy.getPlanningSessions(),
        pool: await proxy.getPoolStatus(),
        workflows: await proxy.getActiveWorkflows()
    }
});
```

### Webview → Extension

```typescript
// Handle messages from webview
webviewView.webview.onDidReceiveMessage(async (message) => {
    switch (message.command) {
        case 'startPlanning':
            vscode.commands.executeCommand('agenticPlanning.startPlanning');
            break;
        case 'approveSession':
            await client.approvePlan(message.sessionId, true);
            break;
        case 'showTerminal':
            terminalManager.showAgentTerminal(message.agentName);
            break;
    }
});
```

## Styling

### CSS Variables

```css
:root {
    --apc-primary: var(--vscode-button-background);
    --apc-success: #4caf50;
    --apc-warning: #ff9800;
    --apc-error: #f44336;
    --apc-info: #2196f3;
    
    --apc-status-available: #4caf50;
    --apc-status-busy: #2196f3;
    --apc-status-resting: #ff9800;
    --apc-status-allocated: #9c27b0;
}
```

### Status Badges

```css
.status-badge {
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
}

.status-badge.planning { background: var(--apc-info); }
.status-badge.approved { background: var(--apc-success); }
.status-badge.executing { background: var(--apc-primary); }
.status-badge.failed { background: var(--apc-error); }
```

## Tree View Providers

### PlanningSessionsProvider

```typescript
class PlanningSessionsProvider implements vscode.TreeDataProvider<PlanningSessionItem> {
    getChildren(element?: PlanningSessionItem): Promise<PlanningSessionItem[]>;
    getTreeItem(element: PlanningSessionItem): vscode.TreeItem;
    refresh(): void;
}
```

### AgentPoolProvider

```typescript
class AgentPoolProvider implements vscode.TreeDataProvider<AgentItem> {
    getChildren(element?: AgentItem): Promise<AgentItem[]>;
    getTreeItem(element: AgentItem): vscode.TreeItem;
    refresh(): void;
}
```

## Notifications

### User Notifications

```typescript
// Info notification
vscode.window.showInformationMessage('Planning complete!');

// Warning notification
vscode.window.showWarningMessage('Task failed, retry available.');

// Error notification
vscode.window.showErrorMessage('Daemon connection lost.');

// With actions
vscode.window.showWarningMessage(
    'Missing dependencies detected.',
    'Show System Status'
).then(selection => {
    if (selection === 'Show System Status') {
        vscode.commands.executeCommand('agenticPlanning.systemStatusView.focus');
    }
});
```

### Task Failed Notification

```typescript
vsCodeClient.subscribe('task.failedFinal', async (data) => {
    // Copy helpful prompt to clipboard
    await vscode.env.clipboard.writeText(prompt);
    
    // Open agent chat
    openAgentChat();
    
    // Show notification
    vscode.window.showWarningMessage(
        `Task "${data.taskId}" failed - ${data.lastError}`,
        'View in Chat'
    );
});
```

## Best Practices

### Performance

1. Use `refresh()` sparingly - debounce rapid updates
2. Cache state in DaemonStateProxy
3. Lazy-load panel content

### UX

1. Show loading states during async operations
2. Provide clear error messages
3. Enable keyboard navigation
4. Use consistent color coding

### Accessibility

1. Use semantic HTML in webviews
2. Support high contrast themes
3. Provide tooltips for icons

