import * as vscode from 'vscode';
import { DependencyService, DependencyStatus } from '../services/DependencyService';
import { DaemonStateProxy } from '../services/DaemonStateProxy';
import { ROLE_WORKFLOW_MAP } from '../types/constants';
import { ServiceLocator } from '../services/ServiceLocator';
import { Logger } from '../utils/Logger';
import { PlanViewerPanel } from './PlanViewerPanel';

const log = Logger.create('Client', 'SidebarView');

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
    
    /** Track initialization progress */
    private initializationStep: string = 'Starting...';
    private initializationPhase: string = 'starting';
    private isDaemonReady: boolean = false;
    private healthMonitoringStarted: boolean = false;

    constructor(private readonly _extensionUri: vscode.Uri) {
        this.dependencyService = ServiceLocator.resolve(DependencyService);
        // DON'T refresh on dependency status changes during initialization!
        // This fires when checking dependencies (during daemon startup)
        // which triggers UI rebuild and wipes out progress messages
        this.dependencyService.onStatusChanged(() => {
            // Only refresh if daemon is ready
            if (this.isDaemonReady) {
                this.refresh();
            }
        });
    }
    
    /**
     * Smart refresh: Enable cache for fast verification, then refresh
     * Used after installations - only rechecks failed dependencies, uses cache for passed ones
     */
    private async smartRefresh(): Promise<void> {
        log.info('[smartRefresh] Starting dependency refresh...');
        
        // Enable cache for fast post-install verification
        if (this.stateProxy) {
            try {
                const vsCodeClient = (this.stateProxy as any).vsCodeClient;
                if (vsCodeClient && vsCodeClient.isConnected()) {
                    log.info('[smartRefresh] Enabling cache for next check...');
                    await vsCodeClient.send('system.enableCacheForNextCheck', {});
                    log.info('[smartRefresh] Cache enabled');
                } else {
                    log.warn('[smartRefresh] VsCodeClient not available or not connected');
                }
            } catch (err) {
                log.warn('[smartRefresh] Failed to enable cache:', err);
            }
        } else {
            log.warn('[smartRefresh] StateProxy not initialized');
        }
        
        // Refresh dependencies (using cached results for speed)
        log.info('[smartRefresh] Executing refreshDependencies command...');
        await vscode.commands.executeCommand('agenticPlanning.refreshDependencies');
        log.info('[smartRefresh] RefreshDependencies command completed');
        
        log.info('[smartRefresh] Refreshing UI...');
        this.refresh();
        log.info('[smartRefresh] Refresh completed');
    }
    
    /**
     * Show standard post-installation notification with smart refresh option
     * Consistent UX across all installation types
     */
    private showInstallationNotification(depName: string): void {
        vscode.window.showInformationMessage(
            `Installing ${depName}... Click Refresh when complete.`,
            'Refresh Now'
        ).then(async (choice) => {
            if (choice === 'Refresh Now') {
                log.info(`[Refresh Button] User clicked refresh after installing ${depName}`);
                try {
                    await this.smartRefresh();
                    log.info(`[Refresh Button] Refresh completed successfully`);
                    vscode.window.showInformationMessage('Dependencies refreshed successfully');
                } catch (err) {
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    log.error(`[Refresh Button] Failed to refresh:`, errorMsg);
                    vscode.window.showErrorMessage(`Failed to refresh dependencies: ${errorMsg}`);
                }
            }
        });
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
        // Clean up old subscriptions to prevent duplicates
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        
        this.stateProxy = proxy;
        this.unityEnabled = proxy.isUnityEnabled();
        this.isConnecting = true;  // Mark as connecting
        
        // Reset daemon ready state when setting new proxy (reconnection)
        this.isDaemonReady = false;
        this.healthMonitoringStarted = false;
        this.initializationStep = 'Starting...';
        this.initializationPhase = 'starting';
        
        // Subscribe to connection health changes
        // BUT: Don't refresh during initialization - it wipes out progress updates!
        const healthSubscription = proxy.onConnectionHealthChanged((health) => {
            log.info('Connection health changed:', health.state);
            // Only refresh if daemon is already ready (not during initialization)
            if (this.isDaemonReady && this.healthMonitoringStarted) {
                this.debouncedRefresh();
            }
        });
        this.disposables.push(healthSubscription);
        
        // Subscribe to dependency check progress for real-time updates
        // Note: subscribe() returns unsubscribe function, we need to wrap it
        const depsListUnsubscribe = proxy.subscribe('deps.list', (data: any) => {
            log.debug(`Dependency list received: ${data.dependencies?.length || 0} items`);
            if (this._view && data.dependencies) {
                this._view.webview.postMessage({
                    type: 'dependencyList',
                    dependencies: data.dependencies
                });
            }
        });
        this.disposables.push({ dispose: depsListUnsubscribe });
        
        const depsProgressUnsubscribe = proxy.subscribe('deps.progress', (data: any) => {
            log.debug(`Dependency progress: ${data.name} - ${data.status.installed ? 'installed' : 'missing'}`);
            this.updateDependencyProgress(data.name, data.status);
        });
        this.disposables.push({ dispose: depsProgressUnsubscribe });
        
        // Subscribe to daemon.ready event - refresh when services are fully initialized
        const readyUnsubscribe = proxy.subscribe('daemon.ready', (data: any) => {
            log.info('Daemon services ready - refreshing UI and enabling health monitoring');
            this.isDaemonReady = true;  // Mark daemon as ready
            this.isConnecting = false;  // Clear connecting flag - we're past that phase
            
            // NOW start health monitoring - daemon is fully initialized
            // This prevents health check refreshes from wiping out initialization progress
            if (!this.healthMonitoringStarted) {
                log.debug('Starting health monitoring now that daemon is ready');
                this.healthMonitoringStarted = true;
            }
            
            this.refresh();
        });
        this.disposables.push({ dispose: readyUnsubscribe });
        
        // Subscribe to daemon.progress event - update UI with initialization steps
        const daemonProgressUnsubscribe = proxy.subscribe('daemon.progress', (data: any) => {
            log.debug(`Daemon progress: ${data.step} (phase: ${data.phase})`);
            this.updateInitializationProgress(data.step, data.phase);
            // Don't refresh - postMessage updates DOM directly
            // Refresh only on state transitions (daemon.ready)
        });
        this.disposables.push({ dispose: daemonProgressUnsubscribe });
        
        // Subscribe to daemon.starting event - update progress, no refresh needed
        const startingUnsubscribe = proxy.subscribe('daemon.starting', (data: any) => {
            log.info('Daemon starting');
            this.updateInitializationProgress('Daemon services starting...', 'starting');
            // No refresh - postMessage updates DOM directly
        });
        this.disposables.push({ dispose: startingUnsubscribe });
        
        // Subscribe to client.connected event - handle reconnection to already-ready daemon
        const clientConnectedUnsubscribe = proxy.subscribe('client.connected', async (data: any) => {
            log.info('Client connected to daemon');
            // Check if daemon is already ready (no initialization events will be sent)
            // Wait for cached events to arrive and be processed
            setTimeout(async () => {
                if (this.stateProxy) {
                    const isReady = await this.stateProxy.isDaemonReady();
                    if (isReady && !this.isDaemonReady) {
                        log.info('Connected to already-ready daemon - no daemon.ready event received, setting state manually');
                        this.isDaemonReady = true;
                        this.isConnecting = false;  // Clear connecting flag
                        this.healthMonitoringStarted = true;
                        this.refresh();
                    }
                }
            }, 500); // Wait 500ms for cached events to be processed (increased from 200ms)
        });
        this.disposables.push({ dispose: clientConnectedUnsubscribe });
        
        // Check if client is already connected when proxy is set (happens during extension activation)
        // If so, cached events may be in-flight or already delivered
        // We need to explicitly check daemon status after a delay to ensure we don't get stuck
        if (proxy.isDaemonConnected()) {
            log.info('Proxy set with already-connected client - will check daemon ready state after events settle');
            setTimeout(async () => {
                if (this.stateProxy) {
                    const isReady = await this.stateProxy.isDaemonReady();
                    if (isReady && !this.isDaemonReady) {
                        log.warn('Daemon was already ready but daemon.ready event was not processed - manually triggering ready state');
                        this.isDaemonReady = true;
                        this.isConnecting = false;  // Clear connecting flag
                        this.healthMonitoringStarted = true;
                        this.refresh();
                    } else if (isReady && this.isDaemonReady) {
                        // Daemon ready event was processed, but isConnecting might still be true
                        // if refresh() returned early (due to _view not being set)
                        // Clear it now to prevent stuck "Checking..." state when GUI opens late
                        if (this.isConnecting) {
                            log.debug('Clearing isConnecting flag (daemon ready, event processed, but flag was stuck)');
                            this.isConnecting = false;
                        }
                        log.debug('Daemon ready state already set from event - all good');
                    } else {
                        log.debug('Daemon not ready yet, waiting for daemon.ready event');
                    }
                }
            }, 300); // Wait 300ms to allow daemon cached events (sent at T+50ms) to be processed
        }
        
        // Initial refresh: Delay slightly to allow client.connected and cached events to be processed first
        // This prevents race condition where refresh() happens before daemon.ready event arrives
        // Daemon sends cached events at T+50ms after connection opens
        log.debug('Proxy set - scheduling initial refresh after connection events settle');
        setTimeout(() => {
            log.debug('Performing initial refresh');
            this.refresh();
        }, 150); // Wait 150ms to allow daemon cached events (sent at T+50ms, processed at ~T+60-100ms) to arrive
    }
    
    private refreshDebounceTimer?: NodeJS.Timeout;
    private periodicRefreshTimer?: NodeJS.Timeout;
    private lastSystemStatus: 'initializing' | 'connecting' | 'checking' | 'ready' | 'missing' | 'daemon_missing' = 'initializing';
    private isConnecting: boolean = false;  // Track connection attempt
    
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
     * - 30 seconds when system is ready (light maintenance polling)
     * - NO polling when initializing (rely on broadcasts instead)
     */
    private startPeriodicRefresh(): void {
        this.stopPeriodicRefresh();
        
        // Don't poll during initialization/connection/checking - rely on daemon broadcasts
        if (this.lastSystemStatus === 'initializing' || 
            this.lastSystemStatus === 'connecting' || 
            this.lastSystemStatus === 'checking') {
            return;  // Wait for daemon.ready broadcast
        }
        
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
        log.info('[resolveWebviewView] Webview is being opened/shown');
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
                    // Immediately set UI to checking state before triggering daemon refresh
                    this.setCheckingState();
                    // Trigger daemon dependency refresh and wait for completion
                    if (this.stateProxy) {
                        await this.stateProxy.refreshDependencies();
                    }
                    // Also trigger the command for any other listeners
                    vscode.commands.executeCommand('agenticPlanning.refreshDependencies');
                    // Now refresh UI with the actual results
                    this.refresh();
                    break;
                case 'stopDaemon':
                    vscode.commands.executeCommand('agenticPlanning.stopDaemon');
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
                        let sessionId = data.sessionId;
                        // If planPath not provided directly, try to look it up from session
                        if (!planPath && sessionId && this.stateProxy) {
                            const sessions = await this.stateProxy.getPlanningSessions();
                            const session = sessions.find(s => s.id === sessionId);
                            planPath = session?.currentPlanPath;
                        }
                        if (planPath && sessionId) {
                            // Open in Plan Viewer Panel
                            PlanViewerPanel.show(planPath, sessionId, this._extensionUri);
                        } else if (planPath) {
                            // Fallback: open raw file if no sessionId
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
                case 'openGlobalDependencyMap':
                    vscode.commands.executeCommand('agenticPlanning.openGlobalDependencyMap');
                    break;
                case 'installDep':
                    await this.handleInstallDependency(data.depName, data.installType, data.installUrl, data.installCommand);
                    break;
                case 'showDepDetails':
                    this.showDependencyDetails(data.depName, data.depDesc);
                    break;
                case 'retryDaemonConnection':
                    // Trigger manual reconnect attempt via the new command
                    vscode.commands.executeCommand('agenticPlanning.retryDaemonConnection');
                    break;
                case 'startDaemon':
                    vscode.commands.executeCommand('agenticPlanning.startDaemon');
                    break;
                case 'refreshDeps':
                    // Refresh dependencies on daemon and update UI
                    if (this.stateProxy) {
                        await this.stateProxy.refreshDependencies();
                    }
                    this.refresh();
                    break;
            }
        });

        // Don't start periodic polling immediately - wait for first refresh
        // to determine actual status (connecting/initializing/ready/missing)
        // The initial refresh will happen immediately below
        // After refresh completes, appropriate polling will start based on status
        
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

        // Trigger initial refresh
        // If daemon is already ready (opening GUI late), refresh immediately
        // Otherwise, refresh will be triggered by daemon.ready event
        if (this.stateProxy && this.isDaemonReady) {
            log.info('[resolveWebviewView] Daemon already ready at view open, refreshing immediately');
            this.refresh();
        } else {
            log.info('[resolveWebviewView] Daemon not ready yet, showing initial state');
            // Still call refresh to show the "initializing" or "connecting" state
            this.refresh();
        }
    }

    public refresh(): void {
        if (!this._view) return;
        
        // Always refresh - _buildStateAsync() handles not querying daemon when not ready
        // Progress messages are updated via postMessage AND refresh (for state transitions)
        
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
            log.warn('Failed to build state:', err);
        });
    }
    
    /**
     * Set UI to checking state immediately (used when refresh button is clicked)
     */
    private setCheckingState(): void {
        if (!this._view) return;
        
        // Create a minimal "checking" state to show immediately
        const checkingState: SidebarState = {
            systemStatus: 'checking',
            missingCount: 0,
            missingDependencies: [],
            connectionRetries: 0,
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
        
        // Build client state and send to webview
        const clientState = buildClientState(checkingState);
        const extendedState = {
            ...clientState,
            sessionsHtml: renderSessionsSection([], this.expandedSessions),
            agentsHtml: renderAgentGrid([]),
        };
        
        this._view.webview.postMessage({ type: 'updateState', state: extendedState });
    }
    
    /**
     * Update dependency progress in real-time
     * Called when individual dependency checks complete during daemon startup
     */
    private updateDependencyProgress(name: string, status: DependencyStatus): void {
        if (!this._view) return;
        
        // Send progress update to webview for real-time display
        this._view.webview.postMessage({
            type: 'dependencyProgress',
            name,
            status: {
                installed: status.installed,
                description: status.description,
                version: status.version
            }
        });
    }
    
    /**
     * Update initialization progress in real-time
     */
    private updateInitializationProgress(step: string, phase: string): void {
        if (!this._view) return;
        
        // Update local state
        this.initializationStep = step;
        this.initializationPhase = phase;
        
        // Send progress update to webview for real-time display
        this._view.webview.postMessage({
            type: 'initializationProgress',
            step,
            phase
        });
    }
    
    private async _buildStateAsync(): Promise<SidebarState> {
        // Get connection health info
        const connectionHealth = this.stateProxy?.getConnectionHealth() || {
            state: 'unknown' as const,
            lastPingSuccess: false,
            consecutiveFailures: 0
        };
        
        // If no stateProxy yet, daemon process is starting
        if (!this.stateProxy) {
            return {
                systemStatus: 'initializing',
                initializationStep: 'Starting daemon process...',
                missingCount: 0,
                missingDependencies: [],
                connectionRetries: 0,
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
                connectionHealth
            };
        }
        
        // If we're in connecting phase (proxy set but connection not confirmed)
        // Skip this check if daemon is already known to be ready (prevents stuck state when GUI opens late)
        if (this.isConnecting && !this.isDaemonReady) {
            this.isConnecting = false;  // Clear flag after first check
            return {
                systemStatus: 'connecting',
                initializationStep: 'Establishing connection...',
                missingCount: 0,
                missingDependencies: [],
                connectionRetries: connectionHealth.consecutiveFailures,
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
                connectionHealth
            };
        }
        
        // If we skipped the connecting check because daemon is ready, still clear the flag
        if (this.isConnecting) {
            this.isConnecting = false;
        }
        
        // Check daemon connection - if not connected, show error
        if (!this.stateProxy.isDaemonConnected()) {
            return {
                systemStatus: 'daemon_missing',
                missingCount: 0,
                missingDependencies: [],
                connectionRetries: connectionHealth.consecutiveFailures,
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
                connectionHealth
            };
        }
        
        // Check if daemon is fully ready (services initialized)
        const daemonReady = this.stateProxy ? await this.stateProxy.isDaemonReady() : true;
        if (!daemonReady) {
            // Daemon connected but services not ready yet
            return {
                systemStatus: 'initializing',
                missingCount: 0,
                missingDependencies: [],
                connectionRetries: 0,
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
                connectionHealth
            };
        }

        // System Status - fetch dependencies from daemon
        // Wait for daemon to be fully ready (dependency checks complete) before showing final status
        let systemStatus: 'initializing' | 'connecting' | 'checking' | 'ready' | 'missing' | 'daemon_missing' = 'checking';
        let missingCount = 0;
        let missingDependencies: Array<{
            name: string;
            description: string;
            installUrl?: string;
            installCommand?: string;
            installType?: 'url' | 'command' | 'apc-cli' | 'vscode-command' | 'cursor-agent-cli';
        }> = [];
        
        // Check if daemon is fully ready (including dependency checks)
        const isDaemonReady = this.stateProxy ? await this.stateProxy.isDaemonReady() : false;
        
        if (!isDaemonReady && this.stateProxy?.isDaemonConnected()) {
            // Daemon is connected but not fully ready yet (checking dependencies)
            systemStatus = 'checking';
            log.debug('Daemon connected but not ready - dependency checks running');
        } else if (isDaemonReady) {
            // Daemon is fully ready - fetch final dependency status
            const depStatus = await this.stateProxy!.getDependencyStatus();
            if (depStatus) {
                missingCount = depStatus.missingCount;
                missingDependencies = depStatus.missingDependencies;
                systemStatus = missingCount === 0 ? 'ready' : 'missing';
            }
        } else {
            // Not connected - this should not happen here as we checked earlier
            throw new Error('Unexpected state: daemon not connected in dependency check');
        }

        // Sessions with workflow information
        const sessions: SessionInfo[] = [];
        
        // Only query daemon state if it's ready - avoid failed API calls during initialization
        if (!isDaemonReady) {
            // Daemon not ready yet - return minimal state with 'initializing' status
            return {
                systemStatus,
                missingCount,
                missingDependencies,
                connectionRetries: connectionHealth.consecutiveFailures,
                initializationStep: this.initializationStep, // Include progress message
                sessions: [], // No sessions until ready
                agents: [], // No agents until ready
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
                connectionHealth
            };
        }
        
        // Daemon is ready - safe to query all state
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
                            log.warn(`Skipping workflow with invalid ID:`, workflowId);
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
                    log.warn(`Error processing session state for ${s.id}:`, e);
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
            const hasPartialPlan = !!(s as any).metadata?.partialPlan;
            if (s.status === 'approved' || s.status === 'completed') {
                planStatus = 'Approved';
            } else if (s.status === 'reviewing') {
                // If plan is partial/incomplete, show warning indicator
                planStatus = hasPartialPlan ? '⚠️ Incomplete' : 'Pending Review';
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
                log.warn(`Error getting failed tasks for ${s.id}:`, e);
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
                            log.warn(`Agent ${agent.name} has workflowId=${agent.workflowId} but no matching workflow found in session ${s.id}`);
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
            
            // Also add benched agents to sessionAgents so they show on workflows
            // Benched agents are allocated to a workflow but waiting for work (e.g., reviewer waiting for review phase)
            const benchAgentsRaw = this.stateProxy 
                ? await this.stateProxy.getBenchAgents()
                : [];
            for (const benchAgent of benchAgentsRaw) {
                // Only include agents from this session
                if (benchAgent.sessionId === s.id) {
                    let roleColor: string | undefined;
                    if (benchAgent.roleId) {
                        const role = this.stateProxy 
                            ? await this.stateProxy.getRole(benchAgent.roleId) 
                            : undefined;
                        roleColor = role?.color;
                    }
                    
                    // Find workflow context for this benched agent
                    let workflowType: string | undefined;
                    let currentPhase: string | undefined;
                    let taskId: string | undefined;
                    
                    if (benchAgent.workflowId) {
                        for (const wf of activeWorkflows) {
                            if (wf.id === benchAgent.workflowId) {
                                workflowType = wf.type;
                                currentPhase = wf.phase;
                                taskId = wf.taskId;
                                break;
                            }
                        }
                    }
                    
                    sessionAgents.push({
                        name: benchAgent.name,
                        status: 'allocated',  // Mark as benched (allocated but idle)
                        roleId: benchAgent.roleId,
                        workflowId: benchAgent.workflowId,
                        roleColor: roleColor || '#6366f1',  // Indigo for benched agents
                        workflowType,
                        currentPhase,
                        taskId,
                        sessionId: s.id
                    });
                }
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
                hasPartialPlan: !!(s as any).metadata?.partialPlan,
                interruptReason: (s as any).metadata?.interruptReason
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
        
        // Collect allocated (bench) agents - get from state proxy
        const allBenchAgentsRaw = this.stateProxy
            ? await this.stateProxy.getBenchAgents()
            : [];
        const allBenchAgents = allBenchAgentsRaw.map(b => ({
            name: b.name,
            roleId: b.roleId,
            sessionId: b.sessionId,
            workflowId: b.workflowId
        }));
        
        for (const agent of allBenchAgents) {
            // Get role color if available
            let roleColor: string | undefined;
            if (agent.roleId) {
                const role = this.stateProxy 
                    ? await this.stateProxy.getRole(agent.roleId) 
                    : undefined;
                roleColor = role?.color;
            }
            
            // Find workflow context for this agent
            let workflowType: string | undefined;
            let currentPhase: string | undefined;
            let taskId: string | undefined;
            let sessionId: string | undefined;
            
            // Search through sessions to find matching workflow using workflowId
            for (const session of sessions) {
                if (agent.workflowId && agent.sessionId === session.id) {
                    sessionId = session.id;
                    
                    // Find matching workflow by workflowId
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
                status: 'allocated',  // On bench, not busy
                roleId: agent.roleId,
                workflowId: agent.workflowId,
                roleColor: roleColor || '#6366f1',  // Default indigo for benched
                workflowType,
                currentPhase,
                taskId,
                sessionId
            });
        }
        
        // Collect busy agents
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
        
        // Collect resting agents (cooldown after release)
        const allRestingAgents = this.stateProxy 
            ? await this.stateProxy.getRestingAgents()
            : [];
        
        for (const name of allRestingAgents) {
            agents.push({ 
                name, 
                status: 'resting',
                roleColor: '#a3a3a3'  // Gray for resting
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
                log.warn('Failed to get coordinator status:', e);
            }
        }

        return {
            systemStatus,
            missingCount,
            missingDependencies,
            connectionRetries: 0,
            sessions,
            agents,
            unity,
            unityEnabled: this.unityEnabled,
            coordinatorStatus,
            connectionHealth
        };
    }
    
    /**
     * Determine install type for a dependency
     */
    private getInstallType(dep: { name: string; installUrl?: string; installCommand?: string }): 'url' | 'command' | 'apc-cli' | 'vscode-command' | 'cursor-agent-cli' {
        if (dep.name.includes('APC CLI')) {
            return 'apc-cli';
        }
        // Check for Cursor Agent CLI first (before basic Cursor CLI)
        if (dep.name.includes('Cursor Agent CLI')) {
            return 'cursor-agent-cli';
        }
        // Then check for basic Cursor CLI
        if (dep.name === 'Cursor CLI') {
            return 'vscode-command';
        }
        if (dep.installUrl) {
            return 'url';
        }
        if (dep.installCommand) {
            return 'command';
        }
        return 'url';
    }
    
    /**
     * Show dependency details in a popup
     */
    private showDependencyDetails(depName: string, depDesc: string): void {
        // Extract URLs from description
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const urls = depDesc.match(urlRegex) || [];
        
        // Create buttons for URLs
        const buttons: string[] = [];
        if (urls.length > 0) {
            buttons.push('Open Documentation');
        }
        buttons.push('OK');
        
        // Show modal with description (respects VS Code's theme automatically)
        vscode.window.showInformationMessage(
            `${depName}\n\n${depDesc}`,
            { modal: true },
            ...buttons
        ).then(async (choice) => {
            if (choice === 'Open Documentation' && urls.length > 0 && urls[0]) {
                // Open the first URL found
                await vscode.env.openExternal(vscode.Uri.parse(urls[0]));
            }
        });
    }
    
    /**
     * Handle dependency installation based on type
     */
    private async handleInstallDependency(
        depName: string, 
        installType: string, 
        installUrl?: string, 
        installCommand?: string
    ): Promise<void> {
        log.info(`Installing dependency: ${depName} (type: ${installType})`);
        
        try {
            switch (installType) {
                case 'apc-cli': {
                    // Use VS Code command for APC CLI installation
                    // The command handles its own user feedback and refreshes
                    await vscode.commands.executeCommand('agenticPlanning.installCli');
                    
                    // The command already handles both client and daemon refresh
                    // Just refresh the sidebar UI
                    this.refresh();
                    break;
                }
                case 'cursor-agent-cli': {
                    // Check if this is a login command (auth issue) or install
                    const isLogin = installCommand === 'cursor-agent login';
                    const platform = process.platform;
                    
                    if (isLogin) {
                        // Open login terminal
                        const terminal = vscode.window.createTerminal('cursor-agent login');
                        terminal.show();
                        
                        if (platform === 'win32') {
                            terminal.sendText('wsl -d Ubuntu bash -c "~/.local/bin/cursor-agent login"');
                        } else {
                            terminal.sendText('cursor-agent login');
                        }
                        
                        this.showInstallationNotification('cursor-agent login');
                    } else {
                        // Run setup script directly - no dialog, just do it
                        const scriptPath = vscode.Uri.joinPath(
                            this._extensionUri,
                            'out',
                            'scripts',
                            'install-cursor-agent.ps1'
                        );
                        const fullPath = scriptPath.fsPath;
                        
                        // Verify script exists
                        const fs = require('fs');
                        if (!fs.existsSync(fullPath)) {
                            vscode.window.showErrorMessage(
                                `Setup script not found at: ${fullPath}\n\nPlease run "npm run compile" to build the extension.`
                            );
                            return;
                        }
                        
                        // Create terminal and run script immediately
                        const terminal = vscode.window.createTerminal({
                            name: 'Cursor Agent Setup',
                            hideFromUser: false
                        });
                        terminal.show();
                        
                        if (platform === 'win32') {
                            const command = `Start-Process powershell.exe -Verb RunAs -ArgumentList '-ExecutionPolicy','Bypass','-NoProfile','-File','"${fullPath}"'`;
                            terminal.sendText(command);
                            log.info(`Running setup script: ${fullPath}`);
                        } else {
                            const command = `sudo bash "${fullPath.replace('.ps1', '.sh')}"`;
                            terminal.sendText(command);
                            log.info(`Running setup script: ${command}`);
                        }
                        
                        this.showInstallationNotification(depName);
                    }
                    break;
                }
                case 'vscode-command': {
                    // Execute VS Code command (e.g., install cursor CLI)
                    if (installUrl?.startsWith('cursor://')) {
                        await vscode.env.openExternal(vscode.Uri.parse(installUrl));
                    } else {
                        vscode.window.showInformationMessage(
                            `To install ${depName}: Open Command Palette (Ctrl+Shift+P) → "Install cursor command"`
                        );
                    }
                    break;
                }
                case 'url': {
                    // Special case: MCP for Unity - auto-configure directly
                    if (depName.includes('MCP for Unity')) {
                        log.info(`Auto-configuring MCP for Unity`);
                        await vscode.commands.executeCommand('agenticPlanning.autoConfigureMcp');
                        this.showInstallationNotification(depName);
                        break;
                    }
                    
                    // Open URL in browser
                    if (installUrl) {
                        log.info(`Opening install URL for ${depName}: ${installUrl}`);
                        await vscode.env.openExternal(vscode.Uri.parse(installUrl));
                        this.showInstallationNotification(depName);
                    } else {
                        vscode.window.showWarningMessage(`No installation URL available for ${depName}`);
                    }
                    break;
                }
                case 'command': {
                    // Run command directly in terminal
                    if (installCommand) {
                        const terminal = vscode.window.createTerminal({
                            name: `Install ${depName}`,
                            hideFromUser: false
                        });
                        terminal.show();
                        terminal.sendText(installCommand);
                        this.showInstallationNotification(depName);
                    } else {
                        vscode.window.showWarningMessage(`No install command available for ${depName}`);
                    }
                    break;
                }
                case 'unity-mcp': {
                    // Install Unity MCP via VS Code command
                    log.info('Installing Unity MCP via command...');
                    
                    try {
                        await vscode.commands.executeCommand('agenticPlanning.autoConfigureMcp');
                        this.showInstallationNotification(depName);
                    } catch (error) {
                        const errorMsg = error instanceof Error ? error.message : String(error);
                        log.error('Unity MCP installation failed:', errorMsg);
                        vscode.window.showErrorMessage(`Failed to install Unity MCP: ${errorMsg}`);
                    }
                    break;
                }
                case 'retry': {
                    // Retry dependency check (refresh dependencies)
                    log.info(`Retrying dependency check for ${depName}...`);
                    vscode.window.showInformationMessage(`Retrying ${depName} connectivity check...`);
                    await vscode.commands.executeCommand('agenticPlanning.refreshDependencies');
                    break;
                }
                default:
                    log.warn(`Unknown install type: ${installType} for ${depName}`);
                    vscode.window.showWarningMessage(`Unknown install type: ${installType}`);
            }
        } catch (err) {
            log.error(`Failed to install ${depName}:`, err);
            vscode.window.showErrorMessage(`Failed to install ${depName}: ${err}`);
        }
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
                // No appropriate log file found
                throw new Error(
                    'No coordinator log files found in logs directory. ' +
                    'Expected files with .output or .log extension. ' +
                    `Directory: ${logDir}`
                );
            }
            
            const latestPath = require('path').join(logDir, latestFile);
            const uri = vscode.Uri.file(latestPath);
            await vscode.window.showTextDocument(uri, { preview: false });
            
        } catch (err) {
            log.error('Failed to open coordinator log:', err);
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
