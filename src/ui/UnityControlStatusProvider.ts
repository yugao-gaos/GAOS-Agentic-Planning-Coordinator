import * as vscode from 'vscode';

/**
 * Unity task in the queue
 */
interface QueuedUnityTask {
    id: string;
    type: 'prep_editor' | 'test_framework_editmode' | 'test_framework_playmode' | 'test_player_playmode';
    requestedBy: string[];
    status: 'queued' | 'executing' | 'completed' | 'failed';
    queuedAt: string;
    startedAt?: string;
    phase?: 'preparing' | 'waiting_compile' | 'waiting_import' | 'running_tests' | 'monitoring';
}

/**
 * Unity Editor state from polling agent
 */
interface UnityEditorState {
    isCompiling: boolean;
    isPlaying: boolean;
    isPaused: boolean;
    hasErrors: boolean;
    errorCount: number;
}

/**
 * Unity Control Manager status
 */
interface UnityControlStatus {
    isRunning: boolean;
    currentTask: QueuedUnityTask | null;
    queueLength: number;
    queue: QueuedUnityTask[];
    estimatedWaitTime: number; // seconds
    lastActivity?: string;
    // Unity Editor state
    unityState?: UnityEditorState;
    pollingAgentRunning?: boolean;
}

export class UnityControlStatusProvider implements vscode.TreeDataProvider<UnityControlItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<UnityControlItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private status: UnityControlStatus = {
        isRunning: true,  // Default to ready state - agent is initialized on extension activate
        currentTask: null,
        queueLength: 0,
        queue: [],
        estimatedWaitTime: 0
    };

    constructor() {
        // Status updates come from extension.ts via updateStatus()
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    /**
     * Update status from UnityControlManager
     */
    updateStatus(status: UnityControlStatus): void {
        this.status = status;
        this.refresh();
    }

    getTreeItem(element: UnityControlItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: UnityControlItem): Promise<UnityControlItem[]> {
        if (element) {
            // Children of queue item - show individual tasks
            if (element.contextValue === 'queue-parent') {
                return this.status.queue.map((task, index) => new UnityControlItem(
                    `${index + 1}. ${this.getTaskTypeLabel(task.type)}`,
                    task.requestedBy.join(', '),
                    vscode.TreeItemCollapsibleState.None,
                    this.getTaskIcon(task.status),
                    `task-${task.status}`
                ));
            }
            return [];
        }

        // Root level
        const items: UnityControlItem[] = [];

        // Manager Status indicator (always first)
        if (this.status.currentTask) {
            // Currently executing a task - show detailed status
            const task = this.status.currentTask;
            const taskLabel = this.getTaskTypeLabel(task.type);
            const requesters = task.requestedBy.join(', ');
            const phaseLabel = this.getPhaseLabel(task.phase);
            
            // Main status item
            items.push(new UnityControlItem(
                `Working: ${taskLabel}`,
                phaseLabel,
                vscode.TreeItemCollapsibleState.None,
                'sync~spin',
                'executing'
            ));
            
            // Show who requested the task
            if (requesters) {
                items.push(new UnityControlItem(
                    `Requested by`,
                    requesters,
                    vscode.TreeItemCollapsibleState.None,
                    'account',
                    'info'
                ));
            }
        } else if (this.status.isRunning) {
            // Running but idle
            items.push(new UnityControlItem(
                'Manager: Ready',
                'Idle - Waiting for tasks',
                vscode.TreeItemCollapsibleState.None,
                'circle-filled',
                'idle'
            ));
        } else {
            // Not running
            items.push(new UnityControlItem(
                'Manager: Inactive',
                'Not initialized',
                vscode.TreeItemCollapsibleState.None,
                'circle-outline',
                'inactive'
            ));
        }

        // Unity Editor State (only show when polling agent is running)
        if (this.status.pollingAgentRunning) {
            if (this.status.unityState) {
                const state = this.status.unityState;
                
                if (state.isCompiling) {
                    items.push(new UnityControlItem(
                        'Unity: Compiling',
                        'Scripts are being compiled...',
                        vscode.TreeItemCollapsibleState.None,
                        'sync~spin',
                        'unity-compiling'
                    ));
                } else if (state.isPlaying) {
                    const playStatus = state.isPaused ? 'Paused' : 'Running';
                    items.push(new UnityControlItem(
                        `Unity: Play Mode ${playStatus}`,
                        state.isPaused ? 'Game is paused' : 'Game is running',
                        vscode.TreeItemCollapsibleState.None,
                        state.isPaused ? 'debug-pause' : 'play',
                        'unity-playing'
                    ));
                } else if (state.hasErrors) {
                    items.push(new UnityControlItem(
                        `Unity: ${state.errorCount} Errors`,
                        'Compilation errors detected',
                        vscode.TreeItemCollapsibleState.None,
                        'error',
                        'unity-errors'
                    ));
                } else {
                    items.push(new UnityControlItem(
                        'Unity: Ready',
                        'No errors, ready to work',
                        vscode.TreeItemCollapsibleState.None,
                        'check',
                        'unity-ready'
                    ));
                }
            } else {
                // Polling agent running but no state yet
                items.push(new UnityControlItem(
                    'Unity: Polling...',
                    'Waiting for status update',
                    vscode.TreeItemCollapsibleState.None,
                    'loading~spin',
                    'unity-polling'
                ));
            }
        }

        // Queue status
        if (this.status.queueLength > 0) {
            const waitTime = this.formatWaitTime(this.status.estimatedWaitTime);
            items.push(new UnityControlItem(
                `Queue: ${this.status.queueLength} tasks`,
                `Est. wait: ${waitTime}`,
                vscode.TreeItemCollapsibleState.Expanded,
                'list-ordered',
                'queue-parent'
            ));
        } else {
            items.push(new UnityControlItem(
                'Queue: Empty',
                'No pending tasks',
                vscode.TreeItemCollapsibleState.None,
                'list-ordered',
                'queue-empty'
            ));
        }

        // Last activity
        if (this.status.lastActivity) {
            items.push(new UnityControlItem(
                'Last Activity',
                this.status.lastActivity,
                vscode.TreeItemCollapsibleState.None,
                'history',
                'info'
            ));
        }

        return items;
    }

    private getTaskTypeLabel(type: string): string {
        switch (type) {
            case 'prep_editor': return 'Compile & Import';
            case 'test_framework_editmode': return 'EditMode Tests';
            case 'test_framework_playmode': return 'PlayMode Tests';
            case 'test_player_playmode': return 'Player Test';
            default: return type;
        }
    }

    private getPhaseLabel(phase?: string): string {
        switch (phase) {
            case 'preparing': return 'Preparing Unity...';
            case 'waiting_compile': return 'Waiting for compilation...';
            case 'waiting_import': return 'Waiting for import...';
            case 'running_tests': return 'Running tests...';
            case 'monitoring': return 'Monitoring playtest...';
            default: return 'Processing...';
        }
    }

    private getTaskIcon(status: string): string {
        switch (status) {
            case 'executing': return 'sync~spin';
            case 'completed': return 'check';
            case 'failed': return 'error';
            default: return 'circle-outline';
        }
    }

    private formatWaitTime(seconds: number): string {
        if (seconds < 60) return `${seconds}s`;
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
    }
}

class UnityControlItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly description: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        iconId?: string,
        contextValue?: string
    ) {
        super(label, collapsibleState);
        this.description = description;
        this.contextValue = contextValue;
        
        if (iconId) {
            // Color based on status
            if (contextValue === 'executing' || contextValue === 'unity-compiling' || contextValue === 'unity-polling') {
                this.iconPath = new vscode.ThemeIcon(iconId, new vscode.ThemeColor('charts.yellow'));
            } else if (contextValue === 'idle' || contextValue === 'unity-ready') {
                this.iconPath = new vscode.ThemeIcon(iconId, new vscode.ThemeColor('charts.green'));
            } else if (contextValue === 'inactive') {
                this.iconPath = new vscode.ThemeIcon(iconId, new vscode.ThemeColor('disabledForeground'));
            } else if (contextValue === 'task-completed') {
                this.iconPath = new vscode.ThemeIcon(iconId, new vscode.ThemeColor('charts.green'));
            } else if (contextValue === 'task-failed' || contextValue === 'unity-errors') {
                this.iconPath = new vscode.ThemeIcon(iconId, new vscode.ThemeColor('errorForeground'));
            } else if (contextValue === 'unity-playing') {
                this.iconPath = new vscode.ThemeIcon(iconId, new vscode.ThemeColor('charts.blue'));
            } else {
                this.iconPath = new vscode.ThemeIcon(iconId);
            }
        }
    }
}

