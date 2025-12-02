import * as vscode from 'vscode';
import { TaskManager, ManagedTask } from '../services/TaskManager';
import { ServiceLocator } from '../services/ServiceLocator';
import { VsCodeClient } from '../vscode/VsCodeClient';

/**
 * Task node for dependency visualization
 */
interface TaskNode {
    id: string;
    shortId: string;      // Just the task part (e.g., "T1")
    description: string;
    status: string;
    dependencies: string[];
    dependents: string[];
    x?: number;
    y?: number;
    level?: number;
}

/**
 * Webview panel for visualizing task dependencies within a plan.
 * Shows tasks as boxes with connections representing dependencies.
 * 
 * Features:
 * - Task boxes colored by status (completed, in_progress, blocked, etc.)
 * - Hover to see task details
 * - Visual dependency arrows
 * - Auto-layout based on dependency levels
 */
export class DependencyMapPanel {
    public static currentPanel: DependencyMapPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private sessionId: string;
    private vsCodeClient: VsCodeClient | null;
    private disposables: vscode.Disposable[] = [];
    private refreshInterval?: NodeJS.Timeout;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        sessionId: string,
        vsCodeClient?: VsCodeClient
    ) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.sessionId = sessionId;
        this.vsCodeClient = vsCodeClient || null;

        // Handle messages from webview
        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                await this.handleMessage(message);
            },
            null,
            this.disposables
        );

        // Handle panel disposal
        this.panel.onDidDispose(
            () => this.dispose(),
            null,
            this.disposables
        );

        // Auto-refresh every 3 seconds when visible
        this.refreshInterval = setInterval(() => {
            if (this.panel.visible) {
                this.updateWebviewContent();
            }
        }, 3000);

        // Set initial content
        this.updateWebviewContent();
    }

    /**
     * Show the dependency map panel for a session
     */
    public static show(sessionId: string, extensionUri: vscode.Uri, vsCodeClient?: VsCodeClient): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If panel already exists, reveal it and update session
        if (DependencyMapPanel.currentPanel) {
            DependencyMapPanel.currentPanel.sessionId = sessionId;
            DependencyMapPanel.currentPanel.panel.reveal(column);
            DependencyMapPanel.currentPanel.updateWebviewContent();
            return;
        }

        // Create new panel
        const panel = vscode.window.createWebviewPanel(
            'apcDependencyMap',
            `Task Dependencies - ${sessionId.substring(0, 8)}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        DependencyMapPanel.currentPanel = new DependencyMapPanel(panel, extensionUri, sessionId, vsCodeClient);
    }

    /**
     * Handle messages from the webview
     */
    private async handleMessage(message: any): Promise<void> {
        switch (message.command) {
            case 'refresh':
                this.updateWebviewContent();
                break;
            case 'openTask':
                // Could open task details or progress log
                vscode.window.showInformationMessage(`Task ${message.taskId}: ${message.description}`);
                break;
        }
    }

    /**
     * Get tasks for the session
     */
    private async getTasks(): Promise<TaskNode[]> {
        let tasks: ManagedTask[] = [];

        if (this.vsCodeClient) {
            try {
                const response = await this.vsCodeClient.send<{ tasks: ManagedTask[] }>('tasks.getForSession', { sessionId: this.sessionId });
                tasks = response.tasks || [];
            } catch (err) {
                console.error('[DependencyMapPanel] Failed to fetch tasks from daemon:', err);
            }
        }

        // Fallback to local TaskManager
        if (tasks.length === 0) {
            try {
                const taskManager = ServiceLocator.resolve(TaskManager);
                tasks = taskManager.getTasksForSession(this.sessionId);
            } catch (err) {
                console.error('[DependencyMapPanel] TaskManager not available:', err);
            }
        }

        // Convert to TaskNode format
        return tasks.map(t => ({
            id: t.id,
            shortId: t.id.replace(`${this.sessionId}_`, ''),
            description: t.description,
            status: t.status,
            dependencies: t.dependencies.map(d => d.replace(`${this.sessionId}_`, '')),
            dependents: t.dependents.map(d => d.replace(`${this.sessionId}_`, ''))
        }));
    }

    /**
     * Calculate layout for tasks based on dependency levels
     */
    private calculateLayout(tasks: TaskNode[]): TaskNode[] {
        const taskMap = new Map(tasks.map(t => [t.shortId, t]));
        
        // Calculate levels (topological sort)
        const levels = new Map<string, number>();
        
        const getLevel = (taskId: string, visited: Set<string> = new Set()): number => {
            if (levels.has(taskId)) return levels.get(taskId)!;
            if (visited.has(taskId)) return 0; // Circular dependency
            
            visited.add(taskId);
            const task = taskMap.get(taskId);
            if (!task || task.dependencies.length === 0) {
                levels.set(taskId, 0);
                return 0;
            }
            
            const depLevels = task.dependencies
                .filter(d => taskMap.has(d))
                .map(d => getLevel(d, visited));
            const level = Math.max(...depLevels, -1) + 1;
            levels.set(taskId, level);
            return level;
        };
        
        // Calculate levels for all tasks
        for (const task of tasks) {
            getLevel(task.shortId);
        }
        
        // Group tasks by level
        const levelGroups = new Map<number, TaskNode[]>();
        for (const task of tasks) {
            const level = levels.get(task.shortId) || 0;
            task.level = level;
            if (!levelGroups.has(level)) {
                levelGroups.set(level, []);
            }
            levelGroups.get(level)!.push(task);
        }
        
        // Calculate positions
        const boxWidth = 80;
        const boxHeight = 50;
        const horizontalGap = 40;
        const verticalGap = 60;
        const startX = 60;
        const startY = 60;
        
        for (const [level, levelTasks] of levelGroups) {
            const y = startY + level * (boxHeight + verticalGap);
            const totalWidth = levelTasks.length * boxWidth + (levelTasks.length - 1) * horizontalGap;
            let x = startX;
            
            for (const task of levelTasks) {
                task.x = x;
                task.y = y;
                x += boxWidth + horizontalGap;
            }
        }
        
        return tasks;
    }

    /**
     * Update the webview content
     */
    private async updateWebviewContent(): Promise<void> {
        const tasks = await this.getTasks();
        const layoutedTasks = this.calculateLayout(tasks);
        
        // Update panel title
        this.panel.title = `Task Dependencies - ${this.sessionId.substring(0, 8)} (${tasks.length} tasks)`;
        
        this.panel.webview.html = this.getWebviewContent(layoutedTasks);
    }

    /**
     * Generate the webview HTML content
     */
    private getWebviewContent(tasks: TaskNode[]): string {
        const tasksJson = JSON.stringify(tasks);
        
        // Calculate canvas size
        const maxX = Math.max(...tasks.map(t => (t.x || 0) + 100), 400);
        const maxY = Math.max(...tasks.map(t => (t.y || 0) + 80), 300);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <title>Task Dependencies</title>
    <style>
        :root {
            --bg-color: var(--vscode-editor-background);
            --fg-color: var(--vscode-editor-foreground);
            --border-color: var(--vscode-panel-border);
            --button-bg: var(--vscode-button-background);
            --button-fg: var(--vscode-button-foreground);
        }
        
        * { box-sizing: border-box; }
        
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--fg-color);
            background: var(--bg-color);
            margin: 0;
            padding: 16px;
            overflow: auto;
        }
        
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--border-color);
        }
        
        h1 {
            margin: 0;
            font-size: 1.3em;
            font-weight: 500;
        }
        
        .legend {
            display: flex;
            gap: 16px;
            flex-wrap: wrap;
        }
        
        .legend-item {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 0.85em;
            opacity: 0.8;
        }
        
        .legend-box {
            width: 16px;
            height: 16px;
            border-radius: 3px;
            border: 1px solid rgba(255,255,255,0.2);
        }
        
        .legend-box.completed { background: #10b981; }
        .legend-box.in_progress { background: #3b82f6; }
        .legend-box.created { background: #6b7280; }
        .legend-box.blocked { background: #f59e0b; }
        .legend-box.paused { background: #8b5cf6; }
        .legend-box.failed { background: #ef4444; }
        
        button {
            padding: 6px 12px;
            background: var(--button-bg);
            color: var(--button-fg);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.9em;
        }
        
        button:hover { opacity: 0.9; }
        
        .canvas-container {
            position: relative;
            width: 100%;
            min-height: ${maxY + 40}px;
            background: rgba(0,0,0,0.1);
            border-radius: 8px;
            overflow: auto;
        }
        
        .canvas {
            position: relative;
            min-width: ${maxX + 40}px;
            min-height: ${maxY + 40}px;
        }
        
        svg.connections {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
        }
        
        .task-node {
            position: absolute;
            width: 80px;
            height: 50px;
            border-radius: 6px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: transform 0.15s, box-shadow 0.15s;
            border: 2px solid transparent;
            font-weight: 500;
        }
        
        .task-node:hover {
            transform: scale(1.05);
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 10;
        }
        
        .task-node.completed {
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            border-color: #34d399;
        }
        
        .task-node.in_progress {
            background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
            border-color: #60a5fa;
            animation: pulse 2s infinite;
        }
        
        .task-node.created {
            background: linear-gradient(135deg, #6b7280 0%, #4b5563 100%);
            border-color: #9ca3af;
        }
        
        .task-node.blocked {
            background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
            border-color: #fbbf24;
        }
        
        .task-node.paused {
            background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
            border-color: #a78bfa;
        }
        
        .task-node.failed {
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
            border-color: #f87171;
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.85; }
        }
        
        .task-id {
            font-size: 1.1em;
            color: white;
            text-shadow: 0 1px 2px rgba(0,0,0,0.3);
        }
        
        .task-status-icon {
            font-size: 0.8em;
            margin-top: 2px;
        }
        
        .tooltip {
            position: fixed;
            background: var(--vscode-editorWidget-background, #1e1e1e);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 12px;
            max-width: 300px;
            z-index: 1000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.4);
            pointer-events: none;
            display: none;
        }
        
        .tooltip.visible {
            display: block;
        }
        
        .tooltip-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--border-color);
        }
        
        .tooltip-id {
            font-weight: 600;
            font-size: 1.1em;
        }
        
        .tooltip-status {
            font-size: 0.85em;
            padding: 2px 8px;
            border-radius: 4px;
            text-transform: uppercase;
        }
        
        .tooltip-status.completed { background: rgba(16, 185, 129, 0.2); color: #34d399; }
        .tooltip-status.in_progress { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }
        .tooltip-status.created { background: rgba(107, 114, 128, 0.2); color: #9ca3af; }
        .tooltip-status.blocked { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
        .tooltip-status.paused { background: rgba(139, 92, 246, 0.2); color: #a78bfa; }
        .tooltip-status.failed { background: rgba(239, 68, 68, 0.2); color: #f87171; }
        
        .tooltip-desc {
            font-size: 0.9em;
            opacity: 0.9;
            line-height: 1.4;
        }
        
        .tooltip-deps {
            margin-top: 8px;
            font-size: 0.85em;
            opacity: 0.7;
        }
        
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            opacity: 0.6;
        }
        
        .empty-state-icon {
            font-size: 3em;
            margin-bottom: 12px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>📊 Task Dependency Map</h1>
        <div style="display: flex; gap: 16px; align-items: center;">
            <div class="legend">
                <div class="legend-item"><div class="legend-box completed"></div> Completed</div>
                <div class="legend-item"><div class="legend-box in_progress"></div> In Progress</div>
                <div class="legend-item"><div class="legend-box created"></div> Ready</div>
                <div class="legend-item"><div class="legend-box blocked"></div> Blocked</div>
                <div class="legend-item"><div class="legend-box paused"></div> Paused</div>
                <div class="legend-item"><div class="legend-box failed"></div> Failed</div>
            </div>
            <button onclick="refresh()">🔄 Refresh</button>
        </div>
    </div>
    
    <div class="canvas-container">
        <div class="canvas" id="canvas"></div>
        <svg class="connections" id="connections"></svg>
    </div>
    
    <div class="tooltip" id="tooltip">
        <div class="tooltip-header">
            <span class="tooltip-id" id="tooltip-id"></span>
            <span class="tooltip-status" id="tooltip-status"></span>
        </div>
        <div class="tooltip-desc" id="tooltip-desc"></div>
        <div class="tooltip-deps" id="tooltip-deps"></div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        const tasks = ${tasksJson};
        
        const statusIcons = {
            'completed': '✓',
            'in_progress': '⟳',
            'created': '○',
            'blocked': '⏸',
            'paused': '⏯',
            'failed': '✗'
        };
        
        function renderTasks() {
            const canvas = document.getElementById('canvas');
            const connections = document.getElementById('connections');
            
            if (tasks.length === 0) {
                canvas.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><div>No tasks yet</div><div style="margin-top: 8px; font-size: 0.9em;">Tasks will appear here once created</div></div>';
                return;
            }
            
            // Create task map for lookups
            const taskMap = new Map(tasks.map(t => [t.shortId, t]));
            
            // Render task nodes
            let nodesHtml = '';
            for (const task of tasks) {
                const x = task.x || 0;
                const y = task.y || 0;
                const icon = statusIcons[task.status] || '○';
                
                nodesHtml += \`
                    <div class="task-node \${task.status}" 
                         style="left: \${x}px; top: \${y}px;"
                         data-task-id="\${task.shortId}"
                         data-description="\${escapeHtml(task.description)}"
                         data-status="\${task.status}"
                         data-deps="\${task.dependencies.join(', ') || 'None'}"
                         onmouseenter="showTooltip(event, this)"
                         onmousemove="moveTooltip(event)"
                         onmouseleave="hideTooltip()">
                        <span class="task-id">\${task.shortId}</span>
                        <span class="task-status-icon">\${icon}</span>
                    </div>
                \`;
            }
            canvas.innerHTML = nodesHtml;
            
            // Render connections (dependency arrows)
            let svgHtml = '<defs><marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="rgba(255,255,255,0.3)" /></marker></defs>';
            
            for (const task of tasks) {
                for (const depId of task.dependencies) {
                    const depTask = taskMap.get(depId);
                    if (!depTask) continue;
                    
                    // Draw arrow from dependency to task
                    const startX = (depTask.x || 0) + 40; // Center of box
                    const startY = (depTask.y || 0) + 50; // Bottom of box
                    const endX = (task.x || 0) + 40;      // Center of box
                    const endY = (task.y || 0);          // Top of box
                    
                    // Bezier curve for smoother lines
                    const midY = (startY + endY) / 2;
                    
                    svgHtml += \`
                        <path d="M \${startX} \${startY} C \${startX} \${midY}, \${endX} \${midY}, \${endX} \${endY}"
                              stroke="rgba(255,255,255,0.25)"
                              stroke-width="2"
                              fill="none"
                              marker-end="url(#arrowhead)" />
                    \`;
                }
            }
            
            connections.innerHTML = svgHtml;
        }
        
        function escapeHtml(str) {
            if (!str) return '';
            return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }
        
        const tooltip = document.getElementById('tooltip');
        const tooltipId = document.getElementById('tooltip-id');
        const tooltipStatus = document.getElementById('tooltip-status');
        const tooltipDesc = document.getElementById('tooltip-desc');
        const tooltipDeps = document.getElementById('tooltip-deps');
        
        function showTooltip(event, element) {
            const taskId = element.dataset.taskId;
            const description = element.dataset.description;
            const status = element.dataset.status;
            const deps = element.dataset.deps;
            
            tooltipId.textContent = taskId;
            tooltipStatus.textContent = status.replace('_', ' ');
            tooltipStatus.className = 'tooltip-status ' + status;
            tooltipDesc.textContent = description;
            tooltipDeps.textContent = deps ? 'Dependencies: ' + deps : '';
            
            tooltip.classList.add('visible');
            moveTooltip(event);
        }
        
        function moveTooltip(event) {
            const x = event.clientX + 15;
            const y = event.clientY + 15;
            
            // Keep tooltip in viewport
            const rect = tooltip.getBoundingClientRect();
            const maxX = window.innerWidth - rect.width - 10;
            const maxY = window.innerHeight - rect.height - 10;
            
            tooltip.style.left = Math.min(x, maxX) + 'px';
            tooltip.style.top = Math.min(y, maxY) + 'px';
        }
        
        function hideTooltip() {
            tooltip.classList.remove('visible');
        }
        
        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }
        
        // Initial render
        renderTasks();
    </script>
</body>
</html>`;
    }

    /**
     * Dispose the panel
     */
    public dispose(): void {
        DependencyMapPanel.currentPanel = undefined;

        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
        }

        this.panel.dispose();

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}


