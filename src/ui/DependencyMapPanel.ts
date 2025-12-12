import * as vscode from 'vscode';
import { VsCodeClient } from '../vscode/VsCodeClient';
import { Logger } from '../utils/Logger';

const log = Logger.create('Client', 'DependencyMap');

/**
 * View mode for the dependency map
 */
type ViewMode = 'session' | 'global';

/**
 * Session color palette for global view
 */
const SESSION_COLORS = [
    { bg: '#3b82f6', border: '#60a5fa', name: 'blue' },
    { bg: '#10b981', border: '#34d399', name: 'green' },
    { bg: '#f59e0b', border: '#fbbf24', name: 'amber' },
    { bg: '#ec4899', border: '#f472b6', name: 'pink' },
    { bg: '#8b5cf6', border: '#a78bfa', name: 'purple' },
    { bg: '#06b6d4', border: '#22d3ee', name: 'cyan' },
];

/**
 * Task node for dependency visualization
 */
interface TaskNode {
    id: string;
    shortId: string;      // Global task ID (e.g., "PS_000001_T1") - kept for compatibility
    sessionId: string;    // Which session this task belongs to
    description: string;
    status: string;
    dependencies: string[];       // Full global IDs for cross-plan deps
    dependents: string[];
    workflowType?: string;  // Current workflow type (e.g., 'task_implementation', 'context_gathering')
    isForeign?: boolean;    // Is this a ghost node from another session (session view only)
    sessionColor?: number;  // Index into SESSION_COLORS (global view)
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
    private eventUnsubscribers: Array<() => void> = [];
    private viewMode: ViewMode = 'session';  // Toggle between session and global view
    private sessionColorMap: Map<string, number> = new Map();  // Session ID to color index
    private openedFromGlobal: boolean = false;  // If true, don't show session/global toggle

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        sessionId: string,
        vsCodeClient: VsCodeClient
    ) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.sessionId = sessionId;
        this.vsCodeClient = vsCodeClient;

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

        // Subscribe to events that affect task status (instead of polling)
        this.subscribeToEvents();

        // Set initial content
        this.updateWebviewContent();
    }

    /**
     * Subscribe to daemon events that affect task status
     */
    private subscribeToEvents(): void {
        if (!this.vsCodeClient) return;

        // Debounce refresh to avoid multiple rapid updates
        let refreshTimeout: NodeJS.Timeout | undefined;
        const debouncedRefresh = () => {
            if (refreshTimeout) clearTimeout(refreshTimeout);
            refreshTimeout = setTimeout(() => {
                if (this.panel.visible) {
                    this.updateWebviewContent();
                }
            }, 300);  // 300ms debounce
        };

        // Subscribe to workflow events (task status changes)
        this.eventUnsubscribers.push(
            this.vsCodeClient.subscribe('workflow.started', debouncedRefresh)
        );
        this.eventUnsubscribers.push(
            this.vsCodeClient.subscribe('workflow.completed', debouncedRefresh)
        );
        this.eventUnsubscribers.push(
            this.vsCodeClient.subscribe('workflow.failed', debouncedRefresh)
        );

        // Subscribe to session updates (plan changes, etc.)
        this.eventUnsubscribers.push(
            this.vsCodeClient.subscribe('session.updated', debouncedRefresh)
        );
    }

    /**
     * Show the dependency map panel for a session
     * @param sessionId - Session to show (required even for global view as fallback)
     * @param extensionUri - Extension URI for resources
     * @param vsCodeClient - Client for daemon communication
     * @param initialViewMode - Optional: 'session' (default) or 'global'
     */
    public static show(
        sessionId: string, 
        extensionUri: vscode.Uri, 
        vsCodeClient: VsCodeClient,
        initialViewMode: ViewMode = 'session'
    ): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        const isGlobalOpen = initialViewMode === 'global';

        // If panel already exists, reveal it and update
        if (DependencyMapPanel.currentPanel) {
            DependencyMapPanel.currentPanel.sessionId = sessionId;
            DependencyMapPanel.currentPanel.viewMode = initialViewMode;
            DependencyMapPanel.currentPanel.openedFromGlobal = isGlobalOpen;
            DependencyMapPanel.currentPanel.panel.reveal(column);
            DependencyMapPanel.currentPanel.updateWebviewContent();
            return;
        }

        // Create new panel
        const title = isGlobalOpen 
            ? 'Global Task Dependencies' 
            : `Task Dependencies - ${sessionId}`;
            
        const panel = vscode.window.createWebviewPanel(
            'apcDependencyMap',
            title,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        const instance = new DependencyMapPanel(panel, extensionUri, sessionId, vsCodeClient);
        instance.viewMode = initialViewMode;
        instance.openedFromGlobal = isGlobalOpen;
        DependencyMapPanel.currentPanel = instance;
        // Constructor already calls updateWebviewContent(), no need to call again
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
            case 'switchSession':
                // Switch to viewing a different session's tasks
                if (message.sessionId) {
                    this.sessionId = message.sessionId;
                    this.updateWebviewContent();
                }
                break;
            case 'toggleViewMode':
                // Toggle between session and global view
                this.viewMode = this.viewMode === 'session' ? 'global' : 'session';
                this.panel.title = this.viewMode === 'global' 
                    ? 'Global Task Dependencies' 
                    : `Task Dependencies - ${this.sessionId}`;
                this.updateWebviewContent();
                break;
            case 'reviewAllTasks':
                // Start implementation review for all completed tasks in session
                await this.startImplementationReview(message.completedTaskIds || [], true);
                break;
            case 'reviewTask':
                // Start implementation review for a single task
                if (message.taskId) {
                    await this.startImplementationReview([message.taskId], false);
                }
                break;
        }
    }
    
    /**
     * Start an implementation review workflow
     */
    private async startImplementationReview(taskIds: string[], isSessionReview: boolean): Promise<void> {
        if (taskIds.length === 0) {
            vscode.window.showWarningMessage('No completed tasks to review');
            return;
        }
        
        if (!this.vsCodeClient) {
            vscode.window.showErrorMessage('Cannot start review: not connected to daemon');
            return;
        }
        
        const label = isSessionReview ? `all ${taskIds.length} completed tasks` : `task ${taskIds[0]}`;
        log.info(`Starting implementation review for ${label}`);
        
        try {
            // Request daemon to dispatch implementation_review workflow
            const result = await this.vsCodeClient.send<{ workflowId?: string; error?: string }>(
                'workflow.dispatch',
                {
                    type: 'implementation_review',
                    sessionId: this.sessionId,
                    input: {
                        taskIds,
                        sessionId: this.sessionId,
                        planPath: '', // Will be resolved by workflow
                        isSessionReview
                    }
                }
            );
            
            if (result?.workflowId) {
                vscode.window.showInformationMessage(`Implementation review started for ${label}`);
            } else {
                vscode.window.showErrorMessage(`Failed to start review: ${result?.error || 'Unknown error'}`);
            }
        } catch (error) {
            log.error('Failed to start implementation review:', error);
            vscode.window.showErrorMessage(`Failed to start review: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Get tasks based on current view mode
     * - Session view: Current session's tasks + ghost nodes for foreign dependencies
     * - Global view: All tasks from all sessions
     */
    private async getTasks(): Promise<{ tasks: TaskNode[]; sessionList?: string[] }> {
        // Task format from tasks.json file
        interface TaskFromFile {
            id: string;              // Full ID (e.g., "ps_000001_T1")
            sessionId: string;
            description: string;
            status: string;
            taskType?: string;
            dependencies: string[];  // Full IDs (e.g., ["ps_000001_T2", "ps_000002_T5"])
            dependents: string[];    // Full IDs
            priority: number;
            activeWorkflow?: { id: string; type: string; status: string };
            targetFiles?: string[];
        }


        if (!this.vsCodeClient) {
            log.error('vsCodeClient is not initialized');
            return { tasks: [] };
        }

        try {
            if (this.viewMode === 'global') {
                return await this.getGlobalTasks();
            } else {
                return await this.getSessionTasksWithForeignDeps();
            }
        } catch (err) {
            log.error('Failed to load tasks:', err);
            vscode.window.showErrorMessage(`Cannot load tasks: ${err instanceof Error ? err.message : String(err)}`);
            return { tasks: [] };
        }
    }

    /**
     * Get tasks for session view with ghost nodes for foreign dependencies
     */
    private async getSessionTasksWithForeignDeps(): Promise<{ tasks: TaskNode[] }> {
        interface TaskFromFile {
            id: string;
            sessionId: string;
            description: string;
            status: string;
            taskType?: string;
            dependencies: string[];
            dependents: string[];
            priority: number;
            activeWorkflow?: { id: string; type: string; status: string };
            targetFiles?: string[];
        }

        const fs = require('fs');
        
        // Get current session's tasks
        const pathResponse = await this.vsCodeClient!.send<{ sessionId: string; filePath: string; exists: boolean }>('task.getFilePath', { sessionId: this.sessionId });
        
        if (!pathResponse?.exists) {
            return { tasks: [] };
        }
        
        const fileContent = fs.readFileSync(pathResponse.filePath, 'utf-8');
        const fileData = JSON.parse(fileContent);
        const tasksFromFile: TaskFromFile[] = fileData.tasks || [];
        
        // Get active workflows (returns array of WorkflowSummary)
        // Create two maps: by workflow ID and by task ID for flexible matching
        const workflowsByIdMap = new Map<string, { type: string; status: string; taskId?: string }>();
        const workflowsByTaskIdMap = new Map<string, { type: string; status: string }>();
        try {
            const workflows = await this.vsCodeClient!.send<Array<{ id: string; type: string; status: string; taskId?: string }>>('workflow.list', { sessionId: this.sessionId });
            if (Array.isArray(workflows)) {
                for (const wf of workflows) {
                    workflowsByIdMap.set(wf.id, wf);
                    // Also index by taskId for matching tasks that don't have activeWorkflow set
                    if (wf.taskId) {
                        // Store with global task ID (UPPERCASE)
                        const globalTaskId = wf.taskId.toUpperCase();
                        workflowsByTaskIdMap.set(globalTaskId, wf);
                    }
                }
            }
        } catch (e) {
            log.warn('Could not fetch workflows:', e);
        }
        
        // Collect all foreign dependency IDs (deps from other sessions)
        const foreignDepIds = new Set<string>();
        const normalizedSessionPrefix = this.sessionId.toUpperCase() + '_';
        for (const task of tasksFromFile) {
            for (const depId of task.dependencies) {
                // Check if this dependency is from another session (case-insensitive)
                if (!depId.toUpperCase().startsWith(normalizedSessionPrefix)) {
                    foreignDepIds.add(depId.toUpperCase());
                }
            }
        }
        
        // Fetch foreign tasks if any
        const foreignTaskMap = new Map<string, TaskFromFile>();
        if (foreignDepIds.size > 0) {
            // Get all tasks from daemon (includes all sessions)
            // Note: API returns the tasks array directly (not wrapped in { data: ... })
            try {
                const allTasks = await this.vsCodeClient!.send<Array<{ id: string; globalId?: string; sessionId: string; description: string; status: string }>>('task.list', {});
                if (Array.isArray(allTasks)) {
                    for (const task of allTasks) {
                        // All IDs should now be in global format PS_XXXXXX_TN - normalize to uppercase
                        const taskId = (task.globalId || task.id).toUpperCase();
                        if (foreignDepIds.has(taskId)) {
                            foreignTaskMap.set(taskId, { 
                                id: taskId,
                                sessionId: task.sessionId.toUpperCase(),
                                description: task.description,
                                status: task.status,
                                dependencies: [],
                                dependents: [],
                                priority: 0
                            });
                        }
                    }
                }
            } catch (e) {
                log.warn('Could not fetch foreign tasks:', e);
            }
        }
        
        // Convert to TaskNode format
        const taskNodes: TaskNode[] = tasksFromFile.map(t => {
            // Normalize to global ID format (UPPERCASE)
            const normalizedId = t.id.toUpperCase();
            const normalizedPrefix = `${t.sessionId.toUpperCase()}_`;
            
            // Build normalized global ID
            const globalId = normalizedId.startsWith(normalizedPrefix) 
                ? normalizedId 
                : `${normalizedPrefix}${normalizedId}`;
            
            // Try to find active workflow for this task
            let workflowType: string | undefined;
            
            // First try: use activeWorkflow type directly from task
            if (t.activeWorkflow) {
                workflowType = t.activeWorkflow.type;
            }
            
            // Second try: match by workflow ID in session workflows
            if (!workflowType && t.activeWorkflow?.id) {
                const wf = workflowsByIdMap.get(t.activeWorkflow.id);
                if (wf) {
                    workflowType = wf.type;
                }
            }
            
            // Third try: match by taskId (workflow may not have activeWorkflow set)
            if (!workflowType) {
                // Use global task ID only - no fallback to short ID
                const wf = workflowsByTaskIdMap.get(globalId);
                if (wf) {
                    workflowType = wf.type;
                }
            }
            
            return {
                id: globalId,  // Always use normalized global ID
                shortId: globalId,  // Use global ID everywhere - no simple ID
                sessionId: t.sessionId.toUpperCase(),
                description: t.description,
                status: t.status,
                workflowType,
                isForeign: false,
                // Normalize dependencies to global format
                dependencies: (t.dependencies || []).map((dep: string) => {
                    const depUpper = dep.toUpperCase();
                    return depUpper.match(/^PS_\d{6}_/) ? depUpper : `${normalizedPrefix}${depUpper}`;
                }),
                dependents: (t.dependents || []).map((dep: string) => {
                    const depUpper = dep.toUpperCase();
                    return depUpper.match(/^PS_\d{6}_/) ? depUpper : `${normalizedPrefix}${depUpper}`;
                })
            };
        });
        
        // Add ghost nodes for foreign dependencies
        for (const [depId, foreignTask] of foreignTaskMap) {
            taskNodes.push({
                id: depId,
                shortId: foreignTask.id,  // Use global ID
                sessionId: foreignTask.sessionId,
                description: foreignTask.description,
                status: foreignTask.status,
                isForeign: true,
                dependencies: [],  // Don't show deps of foreign tasks
                dependents: []
            });
        }
        
        return { tasks: taskNodes };
    }

    /**
     * Get all tasks from all sessions for global view
     * Reads directly from tasks.json files (daemon memory may not have completed tasks)
     */
    private async getGlobalTasks(): Promise<{ tasks: TaskNode[]; sessionList: string[] }> {
        interface TaskFromFile {
            id: string;
            sessionId: string;
            description: string;
            status: string;
            taskType?: string;
            dependencies: string[];
            dependents: string[];
            priority: number;
            activeWorkflow?: { id: string; type: string; status: string };
            targetFiles?: string[];
        }

        const fs = require('fs');
        
        // Get all task file paths from daemon (scans all session folders including completed)
        // Note: API returns the data array directly (not wrapped in { data: ... })
        const filePaths = await this.vsCodeClient!.send<Array<{ sessionId: string; filePath: string; exists: boolean }>>('task.listAllFilePaths', {});
        
        
        if (!filePaths || !Array.isArray(filePaths) || filePaths.length === 0) {
            return { tasks: [], sessionList: [] };
        }
        
        // Read tasks from all files
        const allTasks: TaskFromFile[] = [];
        const sessionSet = new Set<string>();
        
        for (const { sessionId, filePath, exists } of filePaths) {
            if (!exists) continue;
            
            try {
                const fileContent = fs.readFileSync(filePath, 'utf-8');
                const fileData = JSON.parse(fileContent);
                const tasksFromFile: TaskFromFile[] = fileData.tasks || [];
                
                for (const task of tasksFromFile) {
                    allTasks.push(task);
                    sessionSet.add(task.sessionId);
                }
            } catch (e) {
                log.warn(`Failed to read tasks from ${filePath}:`, e);
            }
        }
        
        if (allTasks.length === 0) {
            return { tasks: [], sessionList: [] };
        }
        
        const sessionList = Array.from(sessionSet).sort();
        
        // Assign colors to sessions
        this.sessionColorMap.clear();
        sessionList.forEach((sessionId, index) => {
            this.sessionColorMap.set(sessionId, index % SESSION_COLORS.length);
        });
        
        // Get active workflows from daemon for status enrichment
        // For each session: Map by workflow ID and by task ID
        interface WorkflowMaps {
            byId: Map<string, { type: string; status: string; taskId?: string }>;
            byTaskId: Map<string, { type: string; status: string }>;
        }
        const activeWorkflowsBySession = new Map<string, WorkflowMaps>();
        try {
            for (const sessionId of sessionList) {
                const workflows = await this.vsCodeClient!.send<Array<{ id: string; type: string; status: string; taskId?: string }>>('workflow.list', { sessionId });
                if (Array.isArray(workflows)) {
                    const byId = new Map<string, { type: string; status: string; taskId?: string }>();
                    const byTaskId = new Map<string, { type: string; status: string }>();
                    for (const wf of workflows) {
                        byId.set(wf.id, wf);
                        if (wf.taskId) {
                            // Store with global task ID (UPPERCASE) - no prefix adding
                            const globalTaskId = wf.taskId.toUpperCase();
                            byTaskId.set(globalTaskId, wf);
                        }
                    }
                    activeWorkflowsBySession.set(sessionId, { byId, byTaskId });
                }
            }
        } catch (e) {
            log.warn('Could not fetch workflows for status enrichment:', e);
        }
        
        // Convert to TaskNode format
        const taskNodes: TaskNode[] = allTasks.map(t => {
            // Normalize to global ID format (UPPERCASE)
            const normalizedId = t.id.toUpperCase();
            const normalizedPrefix = `${t.sessionId.toUpperCase()}_`;
            
            // Build normalized global ID
            const globalId = normalizedId.startsWith(normalizedPrefix)
                ? normalizedId
                : `${normalizedPrefix}${normalizedId}`;
            
            const normalizedSessionId = t.sessionId.toUpperCase();
            
            // Check if task has an active workflow
            let workflowType: string | undefined;
            
            // First try: use activeWorkflow type directly from task
            if (t.activeWorkflow) {
                workflowType = t.activeWorkflow.type;
            }
            
            // Second try: match from session workflows
            if (!workflowType) {
                const sessionWorkflows = activeWorkflowsBySession.get(t.sessionId) || 
                                        activeWorkflowsBySession.get(normalizedSessionId);
                if (sessionWorkflows) {
                    // Try by workflow ID first
                    if (t.activeWorkflow?.id) {
                        const wf = sessionWorkflows.byId.get(t.activeWorkflow.id);
                        if (wf) {
                            workflowType = wf.type;
                        }
                    }
                    // Try by global task ID only - no fallback to short ID
                    if (!workflowType) {
                        const wf = sessionWorkflows.byTaskId.get(globalId);
                        if (wf) {
                            workflowType = wf.type;
                        }
                    }
                }
            }
            
            return {
                id: globalId,  // Always use normalized global ID
                shortId: globalId,  // Use global ID everywhere - no simple ID
                sessionId: normalizedSessionId,
                description: t.description,
                status: t.status,
                workflowType,
                isForeign: false,
                sessionColor: this.sessionColorMap.get(t.sessionId) || this.sessionColorMap.get(normalizedSessionId),
                // Normalize dependency IDs to global format
                dependencies: (t.dependencies || []).map((dep: string) => {
                    const depUpper = dep.toUpperCase();
                    return depUpper.match(/^PS_\d{6}_/) ? depUpper : `${normalizedPrefix}${depUpper}`;
                }),
                dependents: (t.dependents || []).map((dep: string) => {
                    const depUpper = dep.toUpperCase();
                    return depUpper.match(/^PS_\d{6}_/) ? depUpper : `${normalizedPrefix}${depUpper}`;
                })
            };
        });
        
        return { tasks: taskNodes, sessionList };
    }

    /**
     * Calculate layout for tasks based on dependency levels
     * Handles both same-session and cross-plan dependencies
     */
    private calculateLayout(tasks: TaskNode[]): TaskNode[] {
        // Create map for task lookups by global ID
        const taskMapById = new Map(tasks.map(t => [t.id, t]));
        
        // Helper to find a task by dependency ID (global ID only)
        const findTask = (depId: string): TaskNode | undefined => {
            return taskMapById.get(depId);
        };
        
        // Calculate levels (topological sort)
        const levels = new Map<string, number>();
        
        const getLevel = (taskId: string, visited: Set<string> = new Set()): number => {
            if (levels.has(taskId)) return levels.get(taskId)!;
            if (visited.has(taskId)) return 0; // Circular dependency
            
            visited.add(taskId);
            const task = taskMapById.get(taskId);
            if (!task || task.dependencies.length === 0) {
                levels.set(taskId, 0);
                return 0;
            }
            
            const depLevels = task.dependencies
                .map(d => findTask(d))
                .filter((t): t is TaskNode => t !== undefined)
                .map(t => getLevel(t.id, visited));
            const level = Math.max(...depLevels, -1) + 1;
            levels.set(taskId, level);
            return level;
        };
        
        // Calculate levels for all tasks
        for (const task of tasks) {
            getLevel(task.id);
        }
        
        // Group tasks by level, but separate foreign tasks
        const levelGroups = new Map<number, TaskNode[]>();
        const foreignTasks: TaskNode[] = [];
        
        for (const task of tasks) {
            if (task.isForeign) {
                // Foreign tasks go in a separate area
                foreignTasks.push(task);
            } else {
                const level = levels.get(task.id) || 0;
                task.level = level;
                if (!levelGroups.has(level)) {
                    levelGroups.set(level, []);
                }
                levelGroups.get(level)!.push(task);
            }
        }
        
        // Calculate positions
        const boxWidth = 110;  // Wide enough for task IDs like PS_000001_CTX6
        const boxHeight = 50;
        const horizontalGap = 50;
        const verticalGap = 60;
        const startX = 60;
        const startY = 60;
        
        for (const [level, levelTasks] of levelGroups) {
            const y = startY + level * (boxHeight + verticalGap);
            let x = startX;
            
            for (const task of levelTasks) {
                task.x = x;
                task.y = y;
                x += boxWidth + horizontalGap;
            }
        }
        
        // Position foreign tasks on the right side
        if (foreignTasks.length > 0) {
            const maxX = Math.max(...tasks.filter(t => !t.isForeign).map(t => t.x || 0), startX);
            const foreignStartX = maxX + boxWidth + horizontalGap * 2;
            let foreignY = startY;
            
            for (const task of foreignTasks) {
                task.x = foreignStartX;
                task.y = foreignY;
                foreignY += boxHeight + verticalGap / 2;
            }
        }
        
        return tasks;
    }

    /**
     * Update the webview content
     */
    private async updateWebviewContent(): Promise<void> {
        const { tasks, sessionList } = await this.getTasks();
        const layoutedTasks = this.calculateLayout(tasks);
        
        
        // Update panel title based on view mode
        if (this.viewMode === 'global') {
            this.panel.title = `Global Task Dependencies (${tasks.length} tasks)`;
        } else {
            const foreignCount = tasks.filter(t => t.isForeign).length;
            const suffix = foreignCount > 0 ? ` + ${foreignCount} foreign` : '';
            this.panel.title = `Task Dependencies - ${this.sessionId} (${tasks.length - foreignCount} tasks${suffix})`;
        }
        
        this.panel.webview.html = this.getWebviewContent(layoutedTasks, sessionList);
    }

    /**
     * Generate the webview HTML content
     */
    private getWebviewContent(tasks: TaskNode[], sessionList?: string[]): string {
        const tasksJson = JSON.stringify(tasks);
        const sessionColorsJson = JSON.stringify(SESSION_COLORS);
        const viewMode = this.viewMode;
        const currentSessionId = this.sessionId;
        const showToggle = !this.openedFromGlobal;  // Hide toggle when opened from global
        
        // Calculate completed tasks for review button (non-foreign only)
        const completedTasks = tasks.filter(t => t.status === 'succeeded' && !t.isForeign);
        const completedTaskIds = completedTasks.map(t => t.id);
        const hasCompletedTasks = completedTasks.length > 0;
        
        // Calculate canvas size
        const maxX = Math.max(...tasks.map(t => (t.x || 0) + 150), 400);
        const maxY = Math.max(...tasks.map(t => (t.y || 0) + 80), 300);
        
        // Build session legend for global view (shows session badges)
        const sessionLegendHtml = sessionList && sessionList.length > 0
            ? sessionList.map((sid, i) => {
                const color = SESSION_COLORS[i % SESSION_COLORS.length];
                return `<div class="legend-item">
                    <span class="legend-session-badge" style="background: ${color.bg};">${sid.slice(-3)}</span>
                    ${sid}
                </div>`;
            }).join('')
            : '';

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
            --hover-bg: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
        }
        
        * { box-sizing: border-box; }
        
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--fg-color);
            background: var(--bg-color);
            margin: 0;
            padding: 0;
            overflow: auto;
            display: flex;
            flex-direction: column;
            height: 100vh;
        }
        
        /* Top Toolbar */
        .toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            background: rgba(0,0,0,0.15);
            border-bottom: 1px solid var(--border-color);
            gap: 12px;
            flex-shrink: 0;
        }
        
        .toolbar-left {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        
        .toolbar-title {
            font-size: 0.95em;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 6px;
            opacity: 0.9;
        }
        
        .toolbar-right {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        /* Segmented Control Toggle */
        .segmented-control {
            display: flex;
            background: rgba(0,0,0,0.25);
            border-radius: 6px;
            padding: 2px;
            gap: 2px;
        }
        
        .segmented-control button {
            padding: 5px 12px;
            font-size: 0.75em;
            font-weight: 500;
            background: transparent;
            color: var(--fg-color);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            opacity: 0.5;
            transition: all 0.15s ease;
            text-transform: uppercase;
            letter-spacing: 0.3px;
        }
        
        .segmented-control button:hover {
            opacity: 0.7;
            background: rgba(255,255,255,0.05);
        }
        
        .segmented-control button.active {
            background: var(--button-bg);
            opacity: 1;
            box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        }
        
        /* Icon Button */
        .icon-btn {
            width: 28px;
            height: 28px;
            padding: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            background: transparent;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            color: var(--fg-color);
            opacity: 0.7;
            transition: all 0.15s ease;
        }
        
        .icon-btn:hover {
            background: var(--hover-bg);
            opacity: 1;
        }
        
        .icon-btn svg {
            width: 16px;
            height: 16px;
        }
        
        /* Review All Button */
        .review-btn {
            display: flex;
            align-items: center;
            gap: 5px;
            padding: 4px 10px;
            font-size: 0.75em;
            font-weight: 500;
            background: rgba(16, 185, 129, 0.15);
            border: 1px solid rgba(16, 185, 129, 0.3);
            border-radius: 4px;
            cursor: pointer;
            color: #34d399;
            transition: all 0.15s ease;
        }
        
        .review-btn:hover {
            background: rgba(16, 185, 129, 0.25);
            border-color: rgba(16, 185, 129, 0.5);
        }
        
        .review-btn.disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }
        
        /* Legend Toggle Button */
        .legend-toggle {
            padding: 4px 8px;
            font-size: 0.7em;
            font-weight: 500;
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 4px;
            cursor: pointer;
            color: var(--fg-color);
            opacity: 0.6;
            transition: all 0.15s ease;
            text-transform: uppercase;
            letter-spacing: 0.3px;
        }
        
        .legend-toggle:hover {
            opacity: 0.9;
            background: rgba(255,255,255,0.1);
        }
        
        .legend-toggle.active {
            opacity: 1;
            background: rgba(255,255,255,0.1);
            border-color: rgba(255,255,255,0.2);
        }
        
        /* Context Menu */
        .context-menu {
            position: fixed;
            background: var(--vscode-editorWidget-background, #252526);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 4px 0;
            z-index: 1000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.4);
            min-width: 150px;
            display: none;
        }
        
        .context-menu.visible {
            display: block;
        }
        
        .context-menu-item {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 12px;
            font-size: 0.85em;
            cursor: pointer;
            color: var(--fg-color);
            transition: background 0.1s ease;
        }
        
        .context-menu-item:hover {
            background: var(--hover-bg);
        }
        
        .context-menu-item svg {
            width: 14px;
            height: 14px;
            opacity: 0.8;
        }
        
        /* Floating Legend Panel */
        .legend-panel {
            position: absolute;
            top: 48px;
            right: 12px;
            background: var(--vscode-editorWidget-background, #252526);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 12px 16px;
            z-index: 100;
            box-shadow: 0 4px 16px rgba(0,0,0,0.3);
            display: none;
            min-width: 200px;
        }
        
        .legend-panel.visible {
            display: block;
        }
        
        .legend-section {
            margin-bottom: 12px;
        }
        
        .legend-section:last-child {
            margin-bottom: 0;
        }
        
        .legend-section-title {
            font-size: 0.7em;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            opacity: 0.5;
            margin-bottom: 8px;
            font-weight: 600;
        }
        
        .legend {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        
        .legend-row {
            display: flex;
            gap: 12px;
            flex-wrap: wrap;
        }
        
        .legend-item {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 0.8em;
            opacity: 0.85;
        }
        
        .legend-box {
            width: 14px;
            height: 14px;
            border-radius: 3px;
            border: 1px solid rgba(255,255,255,0.15);
        }
        
        .legend-box.completed { background: #10b981; }
        .legend-box.in_progress { background: #3b82f6; }
        .legend-box.created { background: #6b7280; }
        .legend-box.blocked { background: #f59e0b; }
        .legend-box.failed { background: #ef4444; }
        
        /* Workflow type legend badges */
        .legend-wf-badge {
            font-size: 8px;
            padding: 2px 6px;
            border-radius: 6px;
            color: white;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.3px;
        }
        
        .legend-wf-badge.implementation { background: #3b82f6; }
        .legend-wf-badge.context { background: #a855f7; }
        .legend-wf-badge.error { background: #ef4444; }
        .legend-wf-badge.planning { background: #10b981; }
        .legend-wf-badge.revision { background: #f59e0b; }
        
        /* Session legend (for global view) */
        .session-legend {
            display: flex;
            gap: 12px;
            flex-wrap: wrap;
            flex-direction: column;
        }
        
        .legend-session-badge {
            display: inline-block;
            font-size: 9px;
            padding: 2px 5px;
            border-radius: 4px;
            color: white;
            font-weight: 600;
            margin-right: 6px;
        }
        
        /* Canvas */
        .canvas-container {
            flex: 1;
            position: relative;
            width: 100%;
            min-height: ${maxY + 40}px;
            background: rgba(0,0,0,0.05);
            overflow: auto;
        }
        
        .canvas {
            position: relative;
            min-width: ${maxX + 40}px;
            min-height: ${maxY + 40}px;
            padding: 20px;
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
            width: 110px;
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
        }
        
        .task-node.created {
            background: linear-gradient(135deg, #6b7280 0%, #4b5563 100%);
            border-color: #9ca3af;
        }
        
        .task-node.blocked {
            background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
            border-color: #fbbf24;
        }
        
        .task-node.failed {
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
            border-color: #f87171;
        }
        
        /* Foreign dependency nodes (ghost nodes from other sessions) */
        .task-node.foreign {
            opacity: 0.6;
            border-style: dashed;
            border-width: 2px;
            background: linear-gradient(135deg, rgba(139, 92, 246, 0.3) 0%, rgba(109, 40, 217, 0.3) 100%);
            border-color: #a78bfa;
        }
        
        .task-node.foreign::before {
            content: '📌';
            position: absolute;
            top: -8px;
            right: -8px;
            font-size: 12px;
        }
        
        .task-node.foreign:hover {
            opacity: 0.9;
        }
        
        /* Session badge inside task node (for global view) */
        .session-badge {
            position: absolute;
            top: -8px;
            left: -8px;
            font-size: 9px;
            padding: 2px 5px;
            border-radius: 4px;
            color: white;
            font-weight: 600;
            box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        }
        
        /* Session badge colors - matches SESSION_COLORS */
        .session-badge-0 { background: #3b82f6; }  /* Blue */
        .session-badge-1 { background: #10b981; }  /* Green */
        .session-badge-2 { background: #f59e0b; }  /* Amber */
        .session-badge-3 { background: #ec4899; }  /* Pink */
        .session-badge-4 { background: #8b5cf6; }  /* Purple */
        .session-badge-5 { background: #06b6d4; }  /* Cyan */
        
        /* Workflow badge at bottom of task node */
        .workflow-badge {
            position: absolute;
            bottom: -10px;
            left: 50%;
            transform: translateX(-50%);
            font-size: 8px;
            padding: 2px 6px;
            border-radius: 6px;
            color: white;
            font-weight: 600;
            white-space: nowrap;
            box-shadow: 0 1px 3px rgba(0,0,0,0.4);
            text-transform: uppercase;
            letter-spacing: 0.3px;
        }
        
        /* Workflow badge colors */
        .workflow-badge.implementation { background: #3b82f6; }  /* Blue */
        .workflow-badge.context { background: #a855f7; }  /* Purple */
        .workflow-badge.error { background: #ef4444; }  /* Red */
        .workflow-badge.planning { background: #10b981; }  /* Green */
        .workflow-badge.revision { background: #f59e0b; }  /* Orange */
        
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
    <!-- Compact Toolbar -->
    <div class="toolbar">
        <div class="toolbar-left">
            <span class="toolbar-title">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h2A1.5 1.5 0 0 1 7 3.5v2A1.5 1.5 0 0 1 5.5 7h-2A1.5 1.5 0 0 1 2 5.5v-2zM3.5 3a.5.5 0 0 0-.5.5v2a.5.5 0 0 0 .5.5h2a.5.5 0 0 0 .5-.5v-2a.5.5 0 0 0-.5-.5h-2zM2 10.5A1.5 1.5 0 0 1 3.5 9h2A1.5 1.5 0 0 1 7 10.5v2A1.5 1.5 0 0 1 5.5 14h-2A1.5 1.5 0 0 1 2 12.5v-2zm1.5-.5a.5.5 0 0 0-.5.5v2a.5.5 0 0 0 .5.5h2a.5.5 0 0 0 .5-.5v-2a.5.5 0 0 0-.5-.5h-2zM9 3.5A1.5 1.5 0 0 1 10.5 2h2A1.5 1.5 0 0 1 14 3.5v2A1.5 1.5 0 0 1 12.5 7h-2A1.5 1.5 0 0 1 9 5.5v-2zm1.5-.5a.5.5 0 0 0-.5.5v2a.5.5 0 0 0 .5.5h2a.5.5 0 0 0 .5-.5v-2a.5.5 0 0 0-.5-.5h-2zM9 10.5A1.5 1.5 0 0 1 10.5 9h2a1.5 1.5 0 0 1 1.5 1.5v2a1.5 1.5 0 0 1-1.5 1.5h-2A1.5 1.5 0 0 1 9 12.5v-2zm1.5-.5a.5.5 0 0 0-.5.5v2a.5.5 0 0 0 .5.5h2a.5.5 0 0 0 .5-.5v-2a.5.5 0 0 0-.5-.5h-2z"/>
                </svg>
                ${viewMode === 'global' ? 'Global Dependencies' : 'Task Dependency Map'}
            </span>
            
            ${showToggle ? `
            <!-- Segmented View Toggle (only when opened from session) -->
            <div class="segmented-control">
                <button id="btn-session" class="${viewMode === 'session' ? 'active' : ''}" onclick="toggleView('session')">Session</button>
                <button id="btn-global" class="${viewMode === 'global' ? 'active' : ''}" onclick="toggleView('global')">Global</button>
            </div>
            ` : ''}
        </div>
        
        <div class="toolbar-right">
            ${viewMode === 'session' && hasCompletedTasks ? `
            <button class="review-btn${hasCompletedTasks ? '' : ' disabled'}" 
                    id="reviewAllBtn" 
                    onclick="reviewAllTasks()"
                    title="Review all ${completedTasks.length} completed task(s)"
                    ${hasCompletedTasks ? '' : 'disabled'}>
                <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
                    <path d="M10.5 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z"/>
                    <path d="M0 8s3-5.5 8-5.5S16 8 16 8s-3 5.5-8 5.5S0 8 0 8zm8 3.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"/>
                </svg>
                Review (${completedTasks.length})
            </button>
            ` : ''}
            <button class="legend-toggle" id="legendToggle" onclick="toggleLegend()">Legend</button>
            <button class="icon-btn" onclick="refresh()" title="Refresh">
                <svg viewBox="0 0 16 16" fill="currentColor">
                    <path fill-rule="evenodd" d="M4.083 4.583a6 6 0 0 1 8.94 1.584H11.5a.5.5 0 0 0 0 1h2.5a.5.5 0 0 0 .5-.5v-2.5a.5.5 0 0 0-1 0v1.12a7 7 0 1 0 1.407 5.63.5.5 0 1 0-.977-.208A6 6 0 1 1 4.083 4.583z"/>
                </svg>
            </button>
        </div>
    </div>
    
    <!-- Floating Legend Panel -->
    <div class="legend-panel" id="legendPanel">
        <div class="legend-section">
            <div class="legend-section-title">Task Status</div>
            <div class="legend">
                <div class="legend-row">
                    <div class="legend-item"><div class="legend-box completed"></div> Completed</div>
                    <div class="legend-item"><div class="legend-box in_progress"></div> In Progress</div>
                    <div class="legend-item"><div class="legend-box created"></div> Ready</div>
                </div>
                <div class="legend-row">
                    <div class="legend-item"><div class="legend-box blocked"></div> Blocked</div>
                    <div class="legend-item"><div class="legend-box failed"></div> Failed</div>
                </div>
            </div>
        </div>
        
        <div class="legend-section">
            <div class="legend-section-title">Active Workflow</div>
            <div class="legend">
                <div class="legend-row">
                    <div class="legend-item"><span class="legend-wf-badge implementation">IMPL</span> Implement</div>
                    <div class="legend-item"><span class="legend-wf-badge context">CTX</span> Context</div>
                    <div class="legend-item"><span class="legend-wf-badge error">ERR</span> Error Fix</div>
                </div>
                <div class="legend-row">
                    <div class="legend-item"><span class="legend-wf-badge planning">PLAN</span> Planning</div>
                    <div class="legend-item"><span class="legend-wf-badge revision">REV</span> Revision</div>
                </div>
            </div>
        </div>
        
        ${viewMode === 'session' ? `
        <div class="legend-section">
            <div class="legend-section-title">Dependencies</div>
            <div class="legend">
                <div class="legend-row">
                    <div class="legend-item">
                        <div class="legend-box" style="border: 2px dashed #a78bfa; background: rgba(139,92,246,0.3);"></div> 
                        Foreign Dep
                    </div>
                </div>
            </div>
        </div>
        ` : ''}
        
        ${viewMode === 'global' && sessionLegendHtml ? `
        <div class="legend-section">
            <div class="legend-section-title">Sessions</div>
            <div class="session-legend">
                ${sessionLegendHtml}
            </div>
        </div>
        ` : ''}
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
    
    <!-- Context Menu for completed tasks -->
    <div class="context-menu" id="contextMenu">
        <div class="context-menu-item" onclick="reviewSelectedTask()">
            <svg viewBox="0 0 16 16" fill="currentColor">
                <path d="M10.5 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z"/>
                <path d="M0 8s3-5.5 8-5.5S16 8 16 8s-3 5.5-8 5.5S0 8 0 8zm8 3.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"/>
            </svg>
            Review Implementation
        </div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        const tasks = ${tasksJson};
        const sessionColors = ${sessionColorsJson};
        const viewMode = '${viewMode}';
        const currentSession = '${currentSessionId}';
        
        const statusIcons = {
            'succeeded': '✓',
            'in_progress': '⟳',
            'created': '○',
            'blocked': '⏸',
            'awaiting_decision': '⚡'  // Needs coordinator attention
        };
        
        // Toggle between session and global view
        function toggleView(mode) {
            vscode.postMessage({ command: 'toggleViewMode' });
        }
        
        // Toggle legend panel visibility
        function toggleLegend() {
            const panel = document.getElementById('legendPanel');
            const btn = document.getElementById('legendToggle');
            panel.classList.toggle('visible');
            btn.classList.toggle('active');
        }
        
        // Close legend when clicking outside
        document.addEventListener('click', function(e) {
            const panel = document.getElementById('legendPanel');
            const btn = document.getElementById('legendToggle');
            if (!panel.contains(e.target) && e.target !== btn) {
                panel.classList.remove('visible');
                btn.classList.remove('active');
            }
            // Also close context menu when clicking outside
            const contextMenu = document.getElementById('contextMenu');
            if (contextMenu && !contextMenu.contains(e.target)) {
                contextMenu.classList.remove('visible');
            }
        });
        
        // Completed task IDs for review
        const completedTaskIds = ${JSON.stringify(completedTaskIds)};
        let selectedTaskForReview = null;
        
        // Review all completed tasks
        function reviewAllTasks() {
            if (completedTaskIds.length === 0) return;
            vscode.postMessage({ 
                command: 'reviewAllTasks',
                completedTaskIds: completedTaskIds
            });
        }
        
        // Review a single selected task
        function reviewSelectedTask() {
            if (!selectedTaskForReview) return;
            vscode.postMessage({ 
                command: 'reviewTask',
                taskId: selectedTaskForReview
            });
            // Hide context menu
            document.getElementById('contextMenu').classList.remove('visible');
            selectedTaskForReview = null;
        }
        
        // Show context menu for completed task
        function showContextMenu(e, taskId, status) {
            e.preventDefault();
            
            // Only show for completed tasks
            if (status !== 'succeeded') return;
            
            selectedTaskForReview = taskId;
            const menu = document.getElementById('contextMenu');
            
            // Position menu at click location
            menu.style.left = e.clientX + 'px';
            menu.style.top = e.clientY + 'px';
            menu.classList.add('visible');
        }
        
        function renderTasks() {
            const canvas = document.getElementById('canvas');
            const connections = document.getElementById('connections');
            
            if (tasks.length === 0) {
                const emptyHtml = '<div class="empty-state">' +
                    '<div class="empty-state-icon">📋</div>' +
                    '<div>No tasks yet</div>' +
                    '<div style="margin-top: 8px; font-size: 0.85em; opacity: 0.7;">Tasks will be created after a plan is approved</div>' +
                    '</div>';
                canvas.innerHTML = emptyHtml;
                return;
            }
            
            // Create task map for lookups by global ID
            const taskMapById = new Map(tasks.map(t => [t.id, t]));
            
            // Helper to find task by dependency ID (global ID only)
            const findTask = (depId) => taskMapById.get(depId);
            
            // Helper to extract short display ID (e.g., "T1" from "PS_000001_T1")
            const getDisplayId = (fullId) => {
                const parts = fullId.split('_');
                // Format: PS_XXXXXX_TASKPART - extract everything after second underscore
                return parts.length >= 3 ? parts.slice(2).join('_') : fullId;
            };
            
            // Render task nodes
            let nodesHtml = '';
            for (const task of tasks) {
                const x = task.x || 0;
                const y = task.y || 0;
                const icon = statusIcons[task.status] || '○';
                const workflowType = task.workflowType || '';
                
                // Determine CSS classes - always use status colors
                let classes = 'task-node';
                if (task.isForeign) {
                    classes += ' foreign';
                } else {
                    // Always color by status (completed, in_progress, created, etc.)
                    classes += ' ' + task.status;
                }
                
                // Session badge for global view (shows session ID, colored by session)
                const sessionBadge = viewMode === 'global' 
                    ? '<span class="session-badge session-badge-' + (task.sessionColor || 0) + '">' + (task.sessionId || '').slice(-3) + '</span>' 
                    : '';
                
                // Foreign indicator
                const foreignLabel = task.isForeign 
                    ? '<div style="font-size: 8px; opacity: 0.7;">From ' + (task.sessionId || '').slice(-6) + '</div>'
                    : '';
                
                // Workflow badge at bottom of task box
                let workflowBadge = '';
                if (workflowType && !task.isForeign) {
                    const wfClass = workflowType
                        .replace('task_implementation', 'implementation')
                        .replace('context_gathering', 'context')
                        .replace('error_resolution', 'error')
                        .replace('planning_new', 'planning')
                        .replace('planning_revision', 'revision');
                    const wfLabel = workflowType
                        .replace('task_implementation', 'IMPL')
                        .replace('context_gathering', 'CTX')
                        .replace('error_resolution', 'ERR')
                        .replace('planning_new', 'PLAN')
                        .replace('planning_revision', 'REV');
                    workflowBadge = '<span class="workflow-badge ' + wfClass + '">' + wfLabel + '</span>';
                }
                
                nodesHtml += \`
                    <div class="\${classes}" 
                         style="left: \${x}px; top: \${y}px; width: 110px;"
                         data-task-id="\${task.shortId}"
                         data-full-id="\${task.id}"
                         data-session="\${task.sessionId || ''}"
                         data-description="\${escapeHtml(task.description)}"
                         data-status="\${task.status}"
                         data-deps="\${task.dependencies.join(', ') || 'None'}"
                         data-workflow="\${workflowType}"
                         data-foreign="\${task.isForeign || false}"
                         onmouseenter="showTooltip(event, this)"
                         onmousemove="moveTooltip(event)"
                         onmouseleave="hideTooltip()"
                         oncontextmenu="showContextMenu(event, '\${task.id}', '\${task.status}')"
                        \${sessionBadge}
                        <span class="task-id">\${getDisplayId(task.shortId)}</span>
                        <span class="task-status-icon">\${icon}</span>
                        \${foreignLabel}
                        \${workflowBadge}
                    </div>
                \`;
            }
            canvas.innerHTML = nodesHtml;
            
            // Render connections (dependency arrows)
            let svgHtml = '<defs>' +
                '<marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="rgba(255,255,255,0.3)" /></marker>' +
                '<marker id="arrowhead-foreign" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="rgba(167,139,250,0.5)" /></marker>' +
                '</defs>';
            
            for (const task of tasks) {
                if (task.isForeign) continue; // Don't draw deps from foreign tasks
                
                for (const depId of task.dependencies) {
                    const depTask = findTask(depId);
                    if (!depTask) continue;
                    
                    // Check if this is a cross-plan dependency
                    const isCrossPlan = depTask.isForeign || (task.sessionId !== depTask.sessionId);
                    
                    // Draw arrow from dependency to task
                    const startX = (depTask.x || 0) + 55; // Center of box (110px / 2)
                    const startY = (depTask.y || 0) + 50; // Bottom of box
                    const endX = (task.x || 0) + 55;      // Center of box (110px / 2)
                    const endY = (task.y || 0);           // Top of box
                    
                    // Bezier curve for smoother lines
                    const midY = (startY + endY) / 2;
                    
                    // Different styling for cross-plan deps
                    const strokeColor = isCrossPlan ? 'rgba(167,139,250,0.5)' : 'rgba(255,255,255,0.25)';
                    const strokeDash = isCrossPlan ? 'stroke-dasharray="5,3"' : '';
                    const strokeWidth = isCrossPlan ? 2.5 : 2;
                    const marker = isCrossPlan ? 'url(#arrowhead-foreign)' : 'url(#arrowhead)';
                    
                    svgHtml += \`
                        <path d="M \${startX} \${startY} C \${startX} \${midY}, \${endX} \${midY}, \${endX} \${endY}"
                              stroke="\${strokeColor}"
                              stroke-width="\${strokeWidth}"
                              \${strokeDash}
                              fill="none"
                              marker-end="\${marker}" />
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
            const fullId = element.dataset.fullId || taskId;
            const sessionId = element.dataset.session || '';
            const description = element.dataset.description;
            const status = element.dataset.status;
            const deps = element.dataset.deps;
            const workflowType = element.dataset.workflow || '';
            const isForeign = element.dataset.foreign === 'true';
            
            // Show full ID and session info
            let idDisplay = taskId;
            if (viewMode === 'global' || isForeign) {
                idDisplay = fullId + (sessionId ? ' (' + sessionId + ')' : '');
            }
            tooltipId.textContent = idDisplay;
            
            // Status with foreign indicator
            let statusDisplay = status.replace('_', ' ');
            if (isForeign) {
                statusDisplay = '📌 FOREIGN - ' + statusDisplay;
            }
            tooltipStatus.textContent = statusDisplay;
            tooltipStatus.className = 'tooltip-status ' + status;
            
            tooltipDesc.textContent = description;
            
            let depsText = deps && deps !== 'None' ? 'Dependencies: ' + deps : '';
            if (workflowType) {
                const workflowLabel = workflowType
                    .replace('task_implementation', 'Implementation')
                    .replace('context_gathering', 'Context Gathering')
                    .replace('error_resolution', 'Error Fix')
                    .replace('planning_new', 'Planning')
                    .replace('planning_revision', 'Revision');
                depsText += (depsText ? '\\n' : '') + '🔄 Active Workflow: ' + workflowLabel;
            }
            if (isForeign) {
                depsText += (depsText ? '\\n' : '') + '⚠️ This task belongs to another session';
            }
            tooltipDeps.textContent = depsText;
            
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

        // Unsubscribe from all events
        for (const unsubscribe of this.eventUnsubscribers) {
            unsubscribe();
        }
        this.eventUnsubscribers = [];

        this.panel.dispose();

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}


