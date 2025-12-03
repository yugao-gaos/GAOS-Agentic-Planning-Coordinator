import * as vscode from 'vscode';
import { DependencyService } from '../services/DependencyService';
import { DaemonStateProxy } from '../services/DaemonStateProxy';
import { ROLE_WORKFLOW_MAP } from '../types/constants';
import { ServiceLocator } from '../services/ServiceLocator';

// Import modular webview components
import { 
    getSidebarHtml,
    buildClientState,
    renderSessionsSection,
    renderAgentGrid,
    SidebarState,
    SessionInfo,
    AgentInfo,
    UnityInfo,
    WorkflowInfo,
    FailedTaskInfo,
    CoordinatorStatusInfo,
    ConnectionHealthInfo,
} from './webview';

export class SidebarViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'agenticPlanning.sidebarView';

    private _view?: vscode.WebviewView;
    private dependencyService: DependencyService;
    private stateProxy?: DaemonStateProxy;
    private disposables: vscode.Disposable[] = [];
    
    /** Whether Unity features are enabled */
    private unityEnabled: boolean = true;
    
    /** Track expanded session IDs for UI state */
    private expandedSessions: Set<string> = new Set();
    
    /** Track active workflow IDs to prevent stale queries */
    private trackedWorkflows: Set<string> = new Set();

    constructor(private readonly _extensionUri: vscode.Uri) {
        this.dependencyService = ServiceLocator.resolve(DependencyService);
        this.dependencyService.onStatusChanged(() => this.refresh());
    }
    
    /**
     * Set whether Unity features are enabled
     * When disabled, the Unity section is hidden
     */
    public setUnityEnabled(enabled: boolean): void {
        this.unityEnabled = enabled;
        this.refresh();
    }

    /**
     * Set the daemon state proxy for local/remote state routing
     */
    public setStateProxy(proxy: DaemonStateProxy): void {
        this.stateProxy = proxy;
        this.unityEnabled = proxy.isUnityEnabled();
        
        // Subscribe to connection health changes
        proxy.onConnectionHealthChanged((health) => {
            console.log('[SidebarViewProvider] Connection health changed:', health.state);
            this.debouncedRefresh();
        });
        
        this.refresh();
    }
    
    private refreshDebounceTimer?: NodeJS.Timeout;
    private periodicRefreshTimer?: NodeJS.Timeout;
    private lastSystemStatus: 'checking' | 'ready' | 'missing' | 'daemon_missing' = 'checking';
    
    private debouncedRefresh(): void {
        if (this.refreshDebounceTimer) {
            clearTimeout(this.refreshDebounceTimer);
        }
        this.refreshDebounceTimer = setTimeout(() => {
            this.refresh();
        }, 100); // 100ms debounce
    }
    
    /**
     * Start periodic refresh with adaptive interval.
     * - 1 second when system is not ready (checking/missing/daemon_missing)
     * - 30 seconds when system is ready
     */
    private startPeriodicRefresh(): void {
        this.stopPeriodicRefresh();
        
        const interval = this.lastSystemStatus === 'ready' ? 30000 : 1000;
        this.periodicRefreshTimer = setInterval(() => {
            this.refresh();
        }, interval);
    }
    
    private stopPeriodicRefresh(): void {
        if (this.periodicRefreshTimer) {
            clearInterval(this.periodicRefreshTimer);
            this.periodicRefreshTimer = undefined;
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview();

        // Handle messages from webview
        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'refresh':
                    vscode.commands.executeCommand('agenticPlanning.refreshDependencies');
                    this.refresh();
                    break;
                case 'settings':
                    vscode.commands.executeCommand('agenticPlanning.openSettings');
                    break;
                case 'showMissing':
                    vscode.commands.executeCommand('agenticPlanning.showMissingDependencies');
                    break;
                case 'newSession':
                    vscode.commands.executeCommand('agenticPlanning.startPlanning');
                    break;
                case 'startExecution':
                    vscode.commands.executeCommand('agenticPlanning.startExecution', { session: { id: data.sessionId } });
                    break;
                case 'pauseExecution':
                    vscode.commands.executeCommand('agenticPlanning.pauseExecution', { session: { id: data.sessionId } });
                    break;
                case 'stopExecution':
                    vscode.commands.executeCommand('agenticPlanning.stopExecution', { session: { id: data.sessionId } });
                    break;
                case 'resumeExecution':
                    vscode.commands.executeCommand('agenticPlanning.resumeExecution', { session: { id: data.sessionId } });
                    break;
                case 'approvePlan':
                    vscode.commands.executeCommand('agenticPlanning.approvePlan', { session: { id: data.sessionId } });
                    break;
                case 'revisePlan':
                    vscode.commands.executeCommand('agenticPlanning.revisePlan', { session: { id: data.sessionId } });
                    break;
                case 'stopRevision':
                    vscode.commands.executeCommand('agenticPlanning.cancelPlan', { session: { id: data.sessionId } });
                    break;
                case 'restartPlanning':
                    vscode.commands.executeCommand('agenticPlanning.restartPlanning', { session: { id: data.sessionId } });
                    break;
                case 'removeSession':
                    vscode.commands.executeCommand('agenticPlanning.removePlanningSession', { session: { id: data.sessionId } });
                    break;
                case 'releaseAgent':
                    vscode.commands.executeCommand('agenticPlanning.releaseAgent', { label: data.agentName });
                    break;
                case 'pauseWorkflow':
                    if (data.sessionId && data.workflowId && this.stateProxy) {
                        const result = await this.stateProxy.pauseWorkflow(data.sessionId, data.workflowId);
                        if (!result.success) {
                            vscode.window.showErrorMessage(result.error || 'Failed to pause workflow');
                        }
                        this.refresh();
                    }
                    break;
                case 'resumeWorkflow':
                    if (data.sessionId && data.workflowId && this.stateProxy) {
                        const result = await this.stateProxy.resumeWorkflow(data.sessionId, data.workflowId);
                        if (!result.success) {
                            vscode.window.showErrorMessage(result.error || 'Failed to resume workflow');
                        }
                        this.refresh();
                    }
                    break;
                case 'cancelWorkflow':
                    if (data.sessionId && data.workflowId && this.stateProxy) {
                        const result = await this.stateProxy.cancelWorkflow(data.sessionId, data.workflowId);
                        if (!result.success) {
                            vscode.window.showErrorMessage(result.error || 'Failed to cancel workflow');
                        }
                        this.refresh();
                    }
                    break;
                case 'showAgentTerminal':
                    vscode.commands.executeCommand('agenticPlanning.showAgentTerminal', data.agentName);
                    break;
                case 'openPlan':
                    {
                        let planPath = data.planPath;
                        // If planPath not provided directly, try to look it up from session
                        if (!planPath && data.sessionId && this.stateProxy) {
                            const sessions = await this.stateProxy.getPlanningSessions();
                            const session = sessions.find(s => s.id === data.sessionId);
                            planPath = session?.currentPlanPath;
                        }
                        if (planPath) {
                            const uri = vscode.Uri.file(planPath);
                            vscode.window.showTextDocument(uri);
                        } else {
                            vscode.window.showWarningMessage('No plan file available for this session yet.');
                        }
                    }
                    break;
                // NOTE: 'openProgressLog' removed - progress.log no longer generated
                // Use workflow logs (openWorkflowLog) instead
                case 'openWorkflowLog':
                    if (data.logPath) {
                        const uri = vscode.Uri.file(data.logPath);
                        vscode.window.showTextDocument(uri);
                    }
                    break;
                case 'retryTask':
                    vscode.commands.executeCommand('agenticPlanning.retryFailedTask', { 
                        sessionId: data.sessionId, 
                        taskId: data.taskId 
                    });
                    break;
                case 'openDependencyMap':
                    vscode.commands.executeCommand('agenticPlanning.openDependencyMap', { 
                        sessionId: data.sessionId 
                    });
                    break;
                case 'openRoleSettings':
                    vscode.commands.executeCommand('apc.openRoleSettings');
                    break;
                case 'openWorkflowSettings':
                    vscode.commands.executeCommand('apc.openWorkflowSettings');
                    break;
                case 'openFullHistory':
                    vscode.commands.executeCommand('agenticPlanning.openHistoryView', { 
                        sessionId: data.sessionId 
                    });
                    break;
                case 'openCoordinatorLog':
                    this.openLatestCoordinatorLog();
                    break;
            }
        });

        // Start periodic refresh with adaptive interval
        // Fast (1s) when system not ready, slow (30s) when ready
        this.startPeriodicRefresh();
        
        // Handle visibility changes - refresh when sidebar becomes visible again
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                // Sidebar became visible - refresh immediately to show latest state
                this.refresh();
            }
        });
        
        webviewView.onDidDispose(() => {
            this.stopPeriodicRefresh();
            if (this.refreshDebounceTimer) {
                clearTimeout(this.refreshDebounceTimer);
            }
            // Dispose event subscriptions
            this.disposables.forEach(d => d.dispose());
            this.disposables = [];
        });

        this.refresh();
    }

    public refresh(): void {
        if (!this._view) return;

        // Use async state building
        this._buildStateAsync().then(async state => {
            // Check if system status changed - restart periodic refresh with new interval
            if (state.systemStatus !== this.lastSystemStatus) {
                this.lastSystemStatus = state.systemStatus;
                this.startPeriodicRefresh();
            }
            
            // Build client state with pre-computed values and pre-rendered HTML
            const clientState = buildClientState(state);
            
            // Track active workflow IDs
            this.trackedWorkflows.clear();
            for (const session of state.sessions) {
                for (const workflow of [...(session.activeWorkflows || []), ...(session.workflowHistory || [])]) {
                    const status = workflow.status;
                    if (status === 'running' || status === 'paused' || status === 'pending') {
                        this.trackedWorkflows.add(workflow.id);
                    }
                }
            }
            
            // Pre-render session and agent HTML for efficient updates
            const extendedState = {
                ...clientState,
                sessionsHtml: renderSessionsSection(state.sessions, this.expandedSessions),
                agentsHtml: renderAgentGrid(state.agents),
            };
            
            this._view?.webview.postMessage({ type: 'updateState', state: extendedState });
        }).catch(err => {
            console.warn('[SidebarViewProvider] Failed to build state:', err);
        });
    }
    
    private async _buildStateAsync(): Promise<SidebarState> {
        // Check daemon connection first - this is critical for all operations
        if (this.stateProxy && !this.stateProxy.isDaemonConnected()) {
            return {
                systemStatus: 'daemon_missing',
                missingCount: 0,
                sessions: [],
                agents: [],
                unity: {
                    connected: false,
                    isPlaying: false,
                    isCompiling: false,
                    hasErrors: false,
                    errorCount: 0,
                    queueLength: 0
                },
                unityEnabled: this.unityEnabled,
                coordinatorStatus: {
                    state: 'idle',
                    pendingEvents: 0,
                    evaluationCount: 0
                },
                connectionHealth: {
                    state: 'unknown',
                    lastPingSuccess: false,
                    consecutiveFailures: 0
                }
            };
        }

        // System Status - check dependencies
        const statuses = this.dependencyService.getCachedStatus();
        const platform = process.platform;
        const relevantStatuses = statuses.filter(s => s.platform === platform || s.platform === 'all');
        const requiredStatuses = relevantStatuses.filter(s => s.required);
        const missingDeps = requiredStatuses.filter(s => !s.installed);

        let systemStatus: 'checking' | 'ready' | 'missing' | 'daemon_missing' = 'checking';
        if (relevantStatuses.length > 0) {
            systemStatus = missingDeps.length === 0 ? 'ready' : 'missing';
        }

        // Sessions with workflow information
        const sessions: SessionInfo[] = [];
        
        // Get sessions from proxy
        const allSessions = this.stateProxy 
            ? await this.stateProxy.getPlanningSessions()
            : [];
            
        for (const s of allSessions) {
            // Get active workflows for this session from proxy or coordinator
            let activeWorkflows: WorkflowInfo[] = [];
            let workflowHistory: WorkflowInfo[] = [];
            let isRevising = false;
            let taskCount = 0;
            let completedTasks = 0;
            let agentCount = 0;
            
            // Use proxy for session state when available
            const sessionState = this.stateProxy 
                ? await this.stateProxy.getSessionState(s.id)
                : undefined;
                
            if (sessionState) {
                try {
                    isRevising = sessionState.isRevising;
                    
                    // Build workflow history from completed workflows (newest first)
                    for (const hist of sessionState.workflowHistory || []) {
                        workflowHistory.push({
                            id: hist.id,
                            type: hist.type,
                            status: hist.status,
                            phase: hist.status === 'completed' ? 'Done' : 'Failed',
                            phaseIndex: 0,
                            totalPhases: 1,
                            percentage: hist.status === 'completed' ? 100 : 0,
                            startedAt: hist.startedAt,
                            taskId: hist.taskId,
                            logPath: hist.logPath,
                            summary: hist.summary,
                            // New fields
                            success: hist.success,
                            error: hist.error,
                            output: hist.output
                        });
                    }
                    
                    // Collect active workflows from activeWorkflows Map<string, WorkflowProgress>
                    for (const [workflowId, progress] of sessionState.activeWorkflows) {
                        // Skip entries with invalid workflow IDs
                        if (!workflowId || typeof workflowId !== 'string') {
                            console.warn(`[SidebarViewProvider] Skipping workflow with invalid ID:`, workflowId);
                            continue;
                        }
                        
                        // Use taskId directly from progress (now included in WorkflowProgress)
                        const taskId = progress.taskId;
                        
                        activeWorkflows.push({
                            id: workflowId,
                            type: progress.type,
                            status: progress.status,
                            phase: progress.phase,
                            phaseIndex: progress.phaseIndex,
                            totalPhases: progress.totalPhases,
                            percentage: progress.percentage,
                            startedAt: progress.startedAt,
                            taskId,
                            logPath: progress.logPath,
                            waitingForAgent: progress.waitingForAgent,
                            waitingForAgentRole: progress.waitingForAgentRole
                        });
                        
                        // Count task workflows
                        if (progress.type === 'task_implementation') {
                            taskCount++;
                            if (progress.status === 'completed') {
                                completedTasks++;
                            }
                        }
                    }
                    
                    // Agent count from pending + completed workflows count (approx)
                    agentCount = sessionState.activeWorkflows.size;
                } catch (e) {
                    console.warn(`[SidebarViewProvider] Error processing session state for ${s.id}:`, e);
                }
            }
            
            // Use session's execution data (global coordinator model)
            if (activeWorkflows.length === 0 && s.execution) {
                taskCount = s.execution.progress?.total || 0;
                completedTasks = s.execution.progress?.completed || 0;
                // Get agent count from proxy
                const sessionAssignments = this.stateProxy
                    ? await this.stateProxy.getSessionAgentAssignments(s.id)
                    : [];
                agentCount = sessionAssignments.length;
            }
            
            // Determine execution status from workflows or session status
            let executionStatus = 'Not started';
            const activeRunningWorkflows = activeWorkflows.filter(w => w.status === 'running' || w.status === 'pending');
            const pausedWorkflows = activeWorkflows.filter(w => w.status === 'paused');
            
            if (activeRunningWorkflows.length > 0) {
                executionStatus = `Running (${activeRunningWorkflows.length} workflows)`;
            } else if (pausedWorkflows.length > 0) {
                executionStatus = 'Paused';
            } else if (s.status === 'completed') {
                executionStatus = 'Completed';
            } else if (s.status === 'approved') {
                executionStatus = 'Ready';
            } else if (isRevising) {
                executionStatus = 'Revising';
            }
            
            // Determine plan status
            let planStatus = 'Draft';
            if (s.status === 'approved' || s.status === 'completed') {
                planStatus = 'Approved';
            } else if (s.status === 'reviewing') {
                planStatus = 'Pending Review';
            } else if (s.status === 'planning') {
                planStatus = 'Planning...';
            } else if (s.status === 'revising') {
                planStatus = 'Revising';
            } else if (s.status === 'no_plan') {
                planStatus = 'No Plan';
            }
            
            // NOTE: progressLogPath removed - progress.log no longer generated
            // Workflow logs are available via activeWorkflows[].logPath
            
            // Get failed tasks from proxy
            let failedTasks: FailedTaskInfo[] = [];
            try {
                const failed = this.stateProxy
                    ? await this.stateProxy.getFailedTasks(s.id)
                    : [];
                failedTasks = failed.map(f => ({
                    taskId: f.taskId,
                    description: f.description,
                    attempts: f.attempts,
                    lastError: f.lastError,
                    canRetry: f.canRetry
                }));
            } catch (e) {
                console.warn(`[SidebarViewProvider] Error getting failed tasks for ${s.id}:`, e);
            }
                
            // Get agents assigned to this session with workflow context
            const sessionAgents: AgentInfo[] = [];
            const busyAgentsRaw = this.stateProxy 
                ? await this.stateProxy.getBusyAgents()
                : [];
            const busyAgents = busyAgentsRaw.map(b => ({
                name: b.name,
                roleId: b.roleId,
                sessionId: b.sessionId,
                workflowId: b.coordinatorId, // Map coordinatorId back to workflowId
                task: b.task
            }));
            for (const agent of busyAgents) {
                // Match agents by session ID
                if (agent.sessionId === s.id) {
                    let roleColor: string | undefined;
                    if (agent.roleId) {
                        const role = this.stateProxy 
                            ? await this.stateProxy.getRole(agent.roleId) 
                            : undefined;
                        roleColor = role?.color;
                    }
                    
                    // Find the workflow this agent is working on
                    let workflowType: string | undefined;
                    let currentPhase: string | undefined;
                    let taskId: string | undefined;
                    let matchedWorkflowId: string | undefined;
                    
                    // Match agent to workflow by workflowId
                    if (agent.workflowId) {
                        for (const wf of activeWorkflows) {
                            if (wf.id === agent.workflowId) {
                                workflowType = wf.type;
                                currentPhase = wf.phase;
                                taskId = wf.taskId;
                                matchedWorkflowId = wf.id;
                                break;
                            }
                        }
                        
                        // Log warning if workflowId doesn't match any active workflow
                        if (!matchedWorkflowId) {
                            console.warn(`[SidebarViewProvider] Agent ${agent.name} has workflowId=${agent.workflowId} but no matching workflow found in session ${s.id}`);
                        }
                    }
                    
                    sessionAgents.push({
                        name: agent.name,
                        status: 'busy',
                        roleId: agent.roleId,
                        workflowId: agent.workflowId || matchedWorkflowId,
                        roleColor: roleColor || '#f97316',
                        workflowType,
                        currentPhase,
                        taskId,
                        sessionId: s.id
                    });
                }
            }
            
            // Collect agents on bench for this session
            const sessionBench: AgentInfo[] = [];
            const benchAgentsRaw = this.stateProxy 
                ? await this.stateProxy.getAgentsOnBench(s.id)
                : [];
            for (const agent of benchAgentsRaw) {
                let roleColor: string | undefined;
                if (agent.roleId) {
                    const role = this.stateProxy 
                        ? await this.stateProxy.getRole(agent.roleId) 
                        : undefined;
                    roleColor = role?.color;
                }
                
                sessionBench.push({
                    name: agent.name,
                    status: 'allocated',
                    roleId: agent.roleId,
                    roleColor: roleColor || '#6366f1',
                    sessionId: s.id
                });
            }
            
            sessions.push({
                id: s.id,
                requirement: s.requirement,
                status: s.status,
                taskCount,
                completedTasks,
                agentCount,
                createdAt: s.createdAt,
                planPath: s.currentPlanPath,
                planStatus,
                planVersion: s.planHistory?.length || 1,
                executionStatus,
                activeWorkflows,
                workflowHistory,
                isRevising,
                failedTasks,
                sessionAgents,
                benchAgents: sessionBench,
                benchCount: sessionBench.length
            });
        }

        // Agents with workflow context - use proxy when available
        const agents: AgentInfo[] = [];
        const allAvailableAgents = this.stateProxy 
            ? await this.stateProxy.getAvailableAgents()
            : [];
        const allBusyAgentsRaw = this.stateProxy 
            ? await this.stateProxy.getBusyAgents()
            : [];
        const allBusyAgents = allBusyAgentsRaw.map(b => ({
            name: b.name,
            roleId: b.roleId,
            sessionId: b.sessionId,
            workflowId: b.coordinatorId, // Map coordinatorId back to workflowId
            task: b.task
        }));
        
        for (const name of allAvailableAgents) {
            agents.push({ name, status: 'available' });
        }
        
        // Collect allocated (bench) agents (not yet available in daemon)
        
        for (const agent of allBusyAgents) {
            // Get role color if available
            let roleColor: string | undefined;
            if (agent.roleId) {
                const role = this.stateProxy 
                    ? await this.stateProxy.getRole(agent.roleId) 
                    : undefined;
                roleColor = role?.color;
            }
            
            // Find workflow context for this agent from AgentPoolService workflowId
            let workflowType: string | undefined;
            let currentPhase: string | undefined;
            let taskId: string | undefined;
            let sessionId: string | undefined;
            
            // Search through sessions to find matching workflow using workflowId
            for (const session of sessions) {
                if (agent.workflowId && agent.sessionId === session.id) {
                    sessionId = session.id;
                    
                    // Find matching workflow by workflowId ONLY (no role-based fallback)
                    if (agent.workflowId) {
                        for (const wf of session.activeWorkflows) {
                            if (wf.id === agent.workflowId) {
                                workflowType = wf.type;
                                currentPhase = wf.phase;
                                taskId = wf.taskId;
                                break;
                            }
                        }
                    }
                    break;
                }
            }
            
            agents.push({
                name: agent.name,
                status: 'busy',
                roleId: agent.roleId,
                workflowId: agent.workflowId,  // Use workflowId from AgentPoolService
                roleColor: roleColor || '#f97316',  // Default orange
                workflowType,
                currentPhase,
                taskId,
                sessionId
            });
        }
        // Sort by name
        agents.sort((a, b) => a.name.localeCompare(b.name));

        // Unity (only gather when Unity features are enabled) - use proxy when available
        let unity: UnityInfo = {
            connected: false,
            isPlaying: false,
            isCompiling: false,
            hasErrors: false,
            errorCount: 0,
            queueLength: 0
        };
        
        if (this.unityEnabled) {
            const unityStatus = this.stateProxy
                ? await this.stateProxy.getUnityStatus()
                : null;
            
            if (unityStatus) {
                unity = unityStatus;
            }
            // No fallback - if daemon doesn't provide unity status, we simply don't show it
        }

        // Get coordinator status
        let coordinatorStatus: CoordinatorStatusInfo = {
            state: 'idle',
            pendingEvents: 0,
            evaluationCount: 0
        };
        
        if (this.stateProxy) {
            try {
                const status = await this.stateProxy.getCoordinatorStatus();
                if (status) {
                    coordinatorStatus = status;
                }
            } catch (e) {
                console.warn('[SidebarViewProvider] Failed to get coordinator status:', e);
            }
        }

        // Get connection health
        let connectionHealth: ConnectionHealthInfo = {
            state: 'unknown',
            lastPingSuccess: true,
            consecutiveFailures: 0
        };
        
        if (this.stateProxy) {
            const health = this.stateProxy.getConnectionHealth();
            connectionHealth = {
                state: health.state,
                lastPingSuccess: health.lastPingSuccess,
                consecutiveFailures: health.consecutiveFailures
            };
        }

        return {
            systemStatus,
            missingCount: missingDeps.length,
            sessions,
            agents,
            unity,
            unityEnabled: this.unityEnabled,
            coordinatorStatus,
            connectionHealth
        };
    }
    
    /**
     * Clear a workflow from tracking (called when workflow completes)
     */
    public clearWorkflowTracking(workflowId: string): void {
        this.trackedWorkflows.delete(workflowId);
    }
    
    /**
     * Open the latest coordinator log file from the global coordinator logs folder.
     * Files are named with timestamp prefix, so sorting alphabetically gives us the latest.
     */
    private async openLatestCoordinatorLog(): Promise<void> {
        try {
            if (!this.stateProxy) {
                vscode.window.showWarningMessage('State proxy not available.');
                return;
            }
            
            // Get the workspace root to construct the log path
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                vscode.window.showWarningMessage('No workspace folder found.');
                return;
            }
            
            const logDir = require('path').join(workspaceRoot, '_AiDevLog', 'Logs', 'Coordinator');
            const fs = require('fs');
            
            // Check if the log directory exists
            if (!fs.existsSync(logDir)) {
                vscode.window.showInformationMessage('No coordinator logs found yet. Logs will appear after the coordinator runs.');
                return;
            }
            
            // Get all .txt and .log files, sorted by name (newest first due to timestamp prefix)
            const files = fs.readdirSync(logDir)
                .filter((f: string) => f.endsWith('.txt') || f.endsWith('.log'))
                .sort()
                .reverse();
            
            if (files.length === 0) {
                vscode.window.showInformationMessage('No coordinator logs found yet. Logs will appear after the coordinator runs.');
                return;
            }
            
            // Get the latest output file (prefer output over prompt)
            let latestFile = files.find((f: string) => f.includes('_output.txt'));
            if (!latestFile) {
                // If no output file, try to find stream log
                latestFile = files.find((f: string) => f.endsWith('.log'));
            }
            if (!latestFile) {
                // Fallback to any file
                latestFile = files[0];
            }
            
            const latestPath = require('path').join(logDir, latestFile);
            const uri = vscode.Uri.file(latestPath);
            await vscode.window.showTextDocument(uri, { preview: false });
            
        } catch (err) {
            console.error('[SidebarViewProvider] Failed to open coordinator log:', err);
            vscode.window.showErrorMessage(`Failed to open coordinator log: ${err}`);
        }
    }

    /**
     * Generate the HTML for the webview using modular components.
     * @see ./webview/ for component implementations
     */
    private _getHtmlForWebview(): string {
        return getSidebarHtml();
    }
}
