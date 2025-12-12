/**
 * DaemonStateProxy.ts - Proxy service for daemon state access
 * 
 * This service provides a unified interface for UI providers to access state.
 * All state is fetched from the daemon via WebSocket API.
 * When daemon is not connected, returns empty state and UI shows "daemon missing".
 */

import { VsCodeClient } from '../vscode/VsCodeClient';
import { TypedEventEmitter } from './TypedEventEmitter';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
    PlanningSession,
    AgentStatus,
    AgentRole
} from '../types';
import { WorkflowProgress, CompletedWorkflowSummary } from '../types/workflow';
import { CompletedSessionInfo } from '../client/Protocol';
import { Logger } from '../utils/Logger';

const log = Logger.create('Client', 'DaemonStateProxy');

// Agent assignment interface (was from TaskManager, now defined here for extension use)
export interface AgentAssignment {
    name: string;
    sessionId: string;
    roleId?: string;
    workflowId?: string;
    currentTaskId?: string;
    status: string;
    assignedAt: string;
    lastActivityAt?: string;
    logFile: string;
}

// ============================================================================
// Types
// ============================================================================

export interface PoolStatus {
    total: number;
    available: string[];
    busy: string[];
}

export interface BusyAgentInfo {
    name: string;
    roleId?: string;
    workflowId: string;
    sessionId: string;
    task?: string;
}

export interface SessionState {
    // Note: Check session.status === 'revising' for revision state
    activeWorkflows: Map<string, WorkflowProgress>;
    workflowHistory: CompletedWorkflowSummary[];
}

export interface UnityStatus {
    connected: boolean;
    isPlaying: boolean;
    isCompiling: boolean;
    hasErrors: boolean;
    errorCount: number;
    queueLength: number;
    status?: 'idle' | 'compiling' | 'testing' | 'playing' | 'error';
    currentTask?: {
        id: string;
        type: string;
        phase?: string;
    };
}

export interface CoordinatorStatusInfo {
    state: 'idle' | 'queuing' | 'evaluating' | 'cooldown';
    pendingEvents: number;
    lastEvaluation?: string;
    evaluationCount: number;
}

export interface DaemonStateProxyOptions {
    /** VS Code client for daemon communication */
    vsCodeClient: VsCodeClient;
    /** Whether Unity features are enabled */
    unityEnabled?: boolean;
    /** Workspace root for locating daemon port file (for auto-reconnect) */
    workspaceRoot?: string;
    /** Extension URI for creating webview panels */
    extensionUri?: any;
}

// ============================================================================
// DaemonStateProxy
// ============================================================================

/**
 * Connection health states:
 * - 'healthy': Connected and responding
 * - 'unhealthy': Connection issues (should try to reconnect)
 * - 'daemon_stopped': Daemon was intentionally stopped (don't reconnect)
 * - 'unknown': Initial state before first health check
 */
export type ConnectionHealthState = 'healthy' | 'unhealthy' | 'daemon_stopped' | 'unknown';

export interface ConnectionHealthInfo {
    state: ConnectionHealthState;
    lastPingSuccess: boolean;
    lastPingTime?: number;
    consecutiveFailures: number;
    /** True if daemon was intentionally stopped (vs connection lost) */
    daemonStopped?: boolean;
}

export class DaemonStateProxy {
    private vsCodeClient: VsCodeClient;
    private unityEnabled: boolean;
    private workspaceRoot?: string;
    private extensionUri?: any;
    
    // Connection health monitoring
    private healthCheckTimer: NodeJS.Timeout | null = null;
    private consecutiveFailures: number = 0;
    private lastPingSuccess: boolean = true;
    private lastPingTime?: number;
    private currentHealthState: ConnectionHealthState = 'unknown';
    private isReconnecting: boolean = false;
    
    // Track if daemon was intentionally shut down - don't reconnect in this case
    private daemonShutdownReceived: boolean = false;
    
    // Cached status from events
    private lastCoordinatorStatus?: CoordinatorStatusInfo;
    private lastUnityStatus?: UnityStatus;
    
    private readonly _onConnectionHealthChanged = new TypedEventEmitter<ConnectionHealthInfo>();
    readonly onConnectionHealthChanged = this._onConnectionHealthChanged.event;

    constructor(options: DaemonStateProxyOptions) {
        this.vsCodeClient = options.vsCodeClient;
        this.unityEnabled = options.unityEnabled ?? true;
        this.workspaceRoot = options.workspaceRoot;
        this.extensionUri = options.extensionUri;
        
        // Listen to coordinator and Unity status events
        this.setupEventListeners();
    }
    
    /**
     * Set up event listeners for status updates
     */
    private setupEventListeners(): void {
        // Listen for daemon shutdown - stop trying to reconnect
        this.vsCodeClient.on('daemon.shutdown', (data: any) => {
            log.info(`Received daemon.shutdown event: ${data?.reason || 'unknown reason'}`);
            this.daemonShutdownReceived = true;
            this.currentHealthState = 'daemon_stopped';  // Distinct from 'unhealthy' - don't reconnect
            this.stopConnectionMonitor();  // Stop health checks - daemon is gone
            this._onConnectionHealthChanged.fire(this.getConnectionHealth());
        });
        
        // Listen for coordinator status changes
        this.vsCodeClient.on('coordinator.statusChanged', (data: any) => {
            this.lastCoordinatorStatus = {
                state: data.state,
                pendingEvents: data.pendingEvents,
                lastEvaluation: data.lastEvaluation,
                evaluationCount: data.evaluationCount
            };
        });
        
        // Listen for Unity status changes
        this.vsCodeClient.on('unity.statusChanged', (data: any) => {
            this.lastUnityStatus = {
                connected: data.connected ?? false,  // Unity Bridge connected to daemon
                isPlaying: data.isPlaying,
                isCompiling: data.isCompiling,
                hasErrors: data.hasErrors,
                errorCount: data.errorCount,
                queueLength: data.queueLength ?? 0,
                status: data.status,
                currentTask: data.currentTask
            };
        });
        
        // Listen for player test popup request
        this.vsCodeClient.on('unity.playerTestRequest', (data: any) => {
            this.handlePlayerTestRequest(data.pipelineId, data.stepIndex);
        });
    }
    
    // Player test popup handling
    private playerTestPopup: any = null;
    private currentPlayerTestPipelineId: string | null = null;
    
    /**
     * Handle player test popup request from daemon
     */
    private async handlePlayerTestRequest(pipelineId: string, stepIndex: number): Promise<void> {
        log.info(`[DaemonStateProxy] Player test requested for pipeline ${pipelineId}`);
        
        // Dynamically import to avoid circular dependency
        const { PlayerTestPopup } = await import('../ui/PlayerTestPopup');
        
        this.currentPlayerTestPipelineId = pipelineId;
        
        const popup = PlayerTestPopup.getInstance();
        popup.show(this.extensionUri, {
            onStartTest: () => {
                log.info('[DaemonStateProxy] User started player test');
                this.vsCodeClient.sendPlayerTestStart(pipelineId);
            },
            onFinishTest: () => {
                log.info('[DaemonStateProxy] User finished player test');
                this.vsCodeClient.sendPlayerTestFinish(pipelineId);
                this.currentPlayerTestPipelineId = null;
            },
            onCancel: () => {
                log.info('[DaemonStateProxy] User cancelled player test');
                this.vsCodeClient.sendPlayerTestCancel(pipelineId);
                this.currentPlayerTestPipelineId = null;
            }
        });
    }
    
    /**
     * Reset shutdown state - called when user explicitly starts daemon again
     */
    resetShutdownState(): void {
        this.daemonShutdownReceived = false;
    }
    
    /**
     * Check if daemon was intentionally shut down
     */
    wasDaemonShutdown(): boolean {
        return this.daemonShutdownReceived;
    }

    // ========================================================================
    // Connection Status
    // ========================================================================

    /**
     * Check if daemon is connected
     */
    isDaemonConnected(): boolean {
        return this.vsCodeClient.isConnected();
    }
    
    /**
     * Check if daemon is fully ready (services initialized)
     * Returns true if daemon is connected AND services are ready
     */
    async isDaemonReady(): Promise<boolean> {
        if (!this.vsCodeClient.isConnected()) {
            return false;
        }
        
        try {
            const response: { readyState?: string; servicesReady?: boolean } = 
                await this.vsCodeClient.send('daemon.status');
            return response.readyState === 'ready' && response.servicesReady === true;
        } catch (e) {
            // If daemon doesn't respond or doesn't have the status endpoint, assume not ready
            return false;
        }
    }

    /**
     * Check if Unity features are enabled
     */
    isUnityEnabled(): boolean {
        return this.unityEnabled;
    }
    
    /**
     * Subscribe to daemon events
     * @param event Event name to subscribe to
     * @param callback Callback function
     * @returns Unsubscribe function
     */
    subscribe(event: string, callback: (data: any) => void): () => void {
        return this.vsCodeClient.subscribe(event, callback);
    }
    
    /**
     * Get current connection health info
     */
    getConnectionHealth(): ConnectionHealthInfo {
        return {
            state: this.currentHealthState,
            lastPingSuccess: this.lastPingSuccess,
            lastPingTime: this.lastPingTime,
            consecutiveFailures: this.consecutiveFailures,
            daemonStopped: this.daemonShutdownReceived
        };
    }
    
    /**
     * Start periodic connection health monitoring
     * @param intervalMs Interval between health checks (default: 15000)
     */
    startConnectionMonitor(intervalMs: number = 15000): void {
        this.stopConnectionMonitor();
        
        log.info(`Starting connection monitor (interval: ${intervalMs / 1000}s)`);
        
        // Do initial health check
        this.performHealthCheck();
        
        this.healthCheckTimer = setInterval(() => {
            this.performHealthCheck();
        }, intervalMs);
    }
    
    /**
     * Stop connection health monitoring
     */
    stopConnectionMonitor(): void {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
            log.debug('Connection monitor stopped');
        }
    }
    
    /**
     * Get workspace hash for daemon port file identification
     */
    private getWorkspaceHash(): string {
        if (!this.workspaceRoot) return '';
        return crypto.createHash('md5').update(this.workspaceRoot).digest('hex').substring(0, 8);
    }
    
    /**
     * Get the daemon port file path
     */
    private getPortPath(): string {
        if (!this.workspaceRoot) return '';
        return path.join(os.tmpdir(), `apc_daemon_${this.getWorkspaceHash()}.port`);
    }
    
    /**
     * Read daemon port from port file (if exists)
     */
    private readDaemonPort(): number | null {
        const portPath = this.getPortPath();
        if (!portPath || !fs.existsSync(portPath)) {
            return null;
        }
        try {
            return parseInt(fs.readFileSync(portPath, 'utf-8').trim(), 10);
        } catch {
            return null;
        }
    }
    
    /**
     * Attempt to reconnect to daemon
     */
    private async attemptReconnect(): Promise<boolean> {
        if (this.isReconnecting) return false;
        
        // Don't reconnect if daemon was intentionally shut down
        if (this.daemonShutdownReceived) {
            log.debug('Skipping reconnect - daemon was intentionally shut down');
            return false;
        }
        
        const port = this.readDaemonPort();
        if (!port) {
            return false;
        }
        
        this.isReconnecting = true;
        log.info(`Attempting to reconnect to daemon on port ${port}...`);
        
        try {
            await this.vsCodeClient.connect(`ws://127.0.0.1:${port}`);
            log.info(`Successfully reconnected to daemon`);
            this.consecutiveFailures = 0;
            this.currentHealthState = 'healthy';
            this.lastPingSuccess = true;
            this._onConnectionHealthChanged.fire(this.getConnectionHealth());
            this.isReconnecting = false;
            return true;
        } catch (err) {
            log.warn(`Reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
            this.isReconnecting = false;
            return false;
        }
    }
    
    /**
     * Manually trigger a reconnection attempt.
     * Called by UI "Retry Now" button or when starting daemon.
     * @returns true if reconnection succeeded
     */
    async manualReconnect(): Promise<{ success: boolean; error?: string }> {
        // Reset shutdown state - user explicitly wants to reconnect
        this.daemonShutdownReceived = false;
        this.currentHealthState = 'unknown';  // Reset to unknown, not unhealthy
        
        // Also reset the VsCodeClient's shutdown state
        if (typeof (this.vsCodeClient as any).resetShutdownState === 'function') {
            (this.vsCodeClient as any).resetShutdownState();
        }
        
        // Notify UI that we're attempting to reconnect
        this._onConnectionHealthChanged.fire(this.getConnectionHealth());
        
        if (this.vsCodeClient.isConnected()) {
            // Already connected, just verify with ping
            try {
                const pingSuccess = await this.vsCodeClient.ping(5000);
                if (pingSuccess) {
                    this.consecutiveFailures = 0;
                    this.currentHealthState = 'healthy';
                    this._onConnectionHealthChanged.fire(this.getConnectionHealth());
                    return { success: true };
                }
            } catch (e) {
                // Fall through to reconnect
            }
        }
        
        const reconnected = await this.attemptReconnect();
        if (reconnected) {
            return { success: true };
        }
        
        const port = this.readDaemonPort();
        if (!port) {
            return { 
                success: false, 
                error: 'Daemon not running (no port file found). Click "Start Daemon" to start it.' 
            };
        }
        
        return { 
            success: false, 
            error: 'Failed to connect to daemon. It may still be starting up - try again in a few seconds.' 
        };
    }
    
    /**
     * Perform a health check ping (with auto-reconnect on failure)
     */
    private async performHealthCheck(): Promise<void> {
        // Don't perform health checks if daemon was intentionally shut down
        if (this.daemonShutdownReceived) {
            log.debug('Skipping health check - daemon was intentionally shut down');
            return;
        }
        
        const previousState = this.currentHealthState;
        
        // If not connected, try to reconnect first
        if (!this.vsCodeClient.isConnected()) {
            const reconnected = await this.attemptReconnect();
            if (!reconnected) {
                this.consecutiveFailures++;
                this.lastPingSuccess = false;
                this.lastPingTime = Date.now();
                
                if (this.consecutiveFailures >= 2) {
                    this.currentHealthState = 'unhealthy';
                }
                
                // Emit event if health state changed
                if (previousState !== this.currentHealthState) {
                    log.info(`Connection health changed: ${previousState} -> ${this.currentHealthState}`);
                    this._onConnectionHealthChanged.fire(this.getConnectionHealth());
                }
                return;
            }
        }
        
        try {
            // Increased timeout to 10s to handle daemon being busy with async operations
            // Even though dependency checks are async, localhost can have transient delays
            const pingSuccess = await this.vsCodeClient.ping(10000);
            this.lastPingTime = Date.now();
            this.lastPingSuccess = pingSuccess;
            
            if (pingSuccess) {
                this.consecutiveFailures = 0;
                this.currentHealthState = 'healthy';
            } else {
                this.consecutiveFailures++;
                // More lenient: 3 failures before marking unhealthy
                if (this.consecutiveFailures >= 3) {
                    this.currentHealthState = 'unhealthy';
                }
            }
        } catch (e) {
            this.consecutiveFailures++;
            this.lastPingSuccess = false;
            this.lastPingTime = Date.now();
            
            if (this.consecutiveFailures >= 3) {
                this.currentHealthState = 'unhealthy';
            }
        }
        
        // Emit event if health state changed
        if (previousState !== this.currentHealthState) {
            console.log(`[DaemonStateProxy] Connection health changed: ${previousState} -> ${this.currentHealthState}`);
            this._onConnectionHealthChanged.fire(this.getConnectionHealth());
        }
    }
    
    /**
     * Dispose resources
     */
    dispose(): void {
        this.stopConnectionMonitor();
        this._onConnectionHealthChanged.dispose();
    }

    // ========================================================================
    // Planning Sessions
    // ========================================================================

    /**
     * Get all planning sessions from daemon
     */
    async getPlanningSessions(): Promise<PlanningSession[]> {
        if (!this.vsCodeClient.isConnected()) {
            return [];
        }

        try {
            const response = await this.vsCodeClient.listSessions();
            return (response.sessions || []) as unknown as PlanningSession[];
        } catch (err) {
            log.warn('Failed to get sessions from daemon:', err);
            return [];
        }
    }

    /**
     * Get a specific planning session by ID
     */
    async getPlanningSession(sessionId: string): Promise<PlanningSession | undefined> {
        if (!this.vsCodeClient.isConnected()) {
            return undefined;
        }

        try {
            const response: { session: PlanningSession } = await this.vsCodeClient.send('session.get', { id: sessionId });
            return response.session;
        } catch (err) {
            log.warn('Failed to get session from daemon:', err);
            return undefined;
        }
    }
    
    /**
     * Get completed sessions from daemon (these are stored on disk, not in memory)
     */
    async getCompletedSessions(limit?: number): Promise<{ sessions: CompletedSessionInfo[]; total: number }> {
        if (!this.vsCodeClient.isConnected()) {
            return { sessions: [], total: 0 };
        }

        try {
            const response = await this.vsCodeClient.listCompletedSessions(limit);
            return response;
        } catch (err) {
            log.warn('Failed to get completed sessions from daemon:', err);
            return { sessions: [], total: 0 };
        }
    }
    
    /**
     * Reopen a completed session for review
     */
    async reopenSession(sessionId: string): Promise<boolean> {
        if (!this.vsCodeClient.isConnected()) {
            return false;
        }

        try {
            await this.vsCodeClient.reopenSession(sessionId);
            return true;
        } catch (err) {
            log.warn('Failed to reopen session:', err);
            return false;
        }
    }
    
    /**
     * Manually complete a session
     */
    async completeSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
        if (!this.vsCodeClient.isConnected()) {
            return { success: false, error: 'Not connected to daemon' };
        }

        try {
            await this.vsCodeClient.send('session.complete', { id: sessionId });
            return { success: true };
        } catch (err) {
            log.warn('Failed to complete session:', err);
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    
    /**
     * Check if a session is ready for manual completion
     */
    async isSessionReadyForCompletion(sessionId: string): Promise<boolean> {
        if (!this.vsCodeClient.isConnected()) {
            return false;
        }

        try {
            const response: { ready: boolean } = await this.vsCodeClient.send('session.checkReadyForCompletion', { id: sessionId });
            return response.ready;
        } catch (err) {
            log.warn('Failed to check session completion readiness:', err);
            return false;
        }
    }

    // NOTE: getProgressLogPath removed - progress.log is no longer generated
    // Use workflow logs in logs/ folder instead

    // ========================================================================
    // Agent Pool
    // ========================================================================

    /**
     * Get pool status summary
     */
    async getPoolStatus(): Promise<PoolStatus> {
        if (!this.vsCodeClient.isConnected()) {
            return { total: 0, available: [], busy: [] };
        }

        try {
            const response = await this.vsCodeClient.getPoolStatus();
            return {
                total: response.total,
                available: response.available,
                busy: response.busy.map(b => b.name)
            };
        } catch (err) {
            log.warn('Failed to get pool status from daemon:', err);
            return { total: 0, available: [], busy: [] };
        }
    }

    /**
     * Get available agents
     */
    async getAvailableAgents(): Promise<string[]> {
        if (!this.vsCodeClient.isConnected()) {
            return [];
        }

        try {
            const response = await this.vsCodeClient.getPoolStatus();
            return response.available;
        } catch (err) {
            log.warn('Failed to get available agents from daemon:', err);
            return [];
        }
    }

    /**
     * Get busy agents with details
     */
    async getBusyAgents(): Promise<BusyAgentInfo[]> {
        if (!this.vsCodeClient.isConnected()) {
            return [];
        }

        try {
            const response = await this.vsCodeClient.getPoolStatus();
            return response.busy.map(b => ({
                name: b.name,
                roleId: b.roleId,
                workflowId: b.workflowId,
                sessionId: b.sessionId,
                task: b.task
            }));
        } catch (err) {
            log.warn('Failed to get busy agents from daemon:', err);
            return [];
        }
    }

    /**
     * Get all benched agents (allocated but not busy) - includes workflowId
     */
    async getBenchAgents(): Promise<Array<{ name: string; roleId: string; sessionId: string; workflowId: string }>> {
        if (!this.vsCodeClient.isConnected()) {
            return [];
        }

        try {
            const response = await this.vsCodeClient.getPoolStatus();
            // Pool status should have allocated agents
            return response.allocated || [];
        } catch (err) {
            log.warn('Failed to get bench agents from daemon:', err);
            return [];
        }
    }

    /**
     * Get agents in resting state (cooldown after release)
     */
    async getRestingAgents(): Promise<string[]> {
        if (!this.vsCodeClient.isConnected()) {
            return [];
        }

        try {
            const response = await this.vsCodeClient.getPoolStatus();
            return response.resting || [];
        } catch (err) {
            log.warn('Failed to get resting agents from daemon:', err);
            return [];
        }
    }

    /**
     * Get agent status
     */
    async getAgentStatus(agentName: string): Promise<AgentStatus | undefined> {
        if (!this.vsCodeClient.isConnected()) {
            return undefined;
        }

        try {
            const response: { agent?: AgentStatus } = await this.vsCodeClient.send('pool.agent.status', { name: agentName });
            return response.agent;
        } catch (err) {
            log.warn('Failed to get agent status from daemon:', err);
            return undefined;
        }
    }

    /**
     * Get a role by ID
     */
    async getRole(roleId: string): Promise<AgentRole | undefined> {
        if (!this.vsCodeClient.isConnected()) {
            return undefined;
        }

        try {
            const response: { role?: AgentRole } = await this.vsCodeClient.send('pool.role', { id: roleId });
            return response.role;
        } catch (err) {
            log.warn('Failed to get role from daemon:', err);
            return undefined;
        }
    }

    // ========================================================================
    // Task Manager (Agent Assignments)
    // ========================================================================

    /**
     * Get agent assignments for UI display
     */
    async getAgentAssignmentsForUI(): Promise<AgentAssignment[]> {
        if (!this.vsCodeClient.isConnected()) {
            return [];
        }

        try {
            const response: { assignments?: AgentAssignment[] } = await this.vsCodeClient.send('task.assignments');
            return response.assignments || [];
        } catch (err) {
            log.warn('Failed to get assignments from daemon:', err);
            return [];
        }
    }

    /**
     * Get agent assignments for a specific session
     */
    async getSessionAgentAssignments(sessionId: string): Promise<AgentAssignment[]> {
        const assignments = await this.getAgentAssignmentsForUI();
        return assignments.filter(a => a.sessionId === sessionId);
    }

    // ========================================================================
    // Workflow Progress
    // ========================================================================

    /**
     * Get session state (workflows, revision status, history)
     */
    async getSessionState(sessionId: string): Promise<SessionState | undefined> {
        if (!this.vsCodeClient.isConnected()) {
            return undefined;
        }

        try {
            type SessionStateResponse = { 
                state?: { 
                    activeWorkflows?: Array<WorkflowProgress & { id: string }>;
                    workflowHistory?: CompletedWorkflowSummary[];
                } 
            };
            const response: SessionStateResponse = await this.vsCodeClient.send('session.state', { id: sessionId });
            if (response.state) {
                // Convert workflows array to Map
                const workflowsMap = new Map<string, WorkflowProgress>();
                if (response.state.activeWorkflows) {
                    for (const wf of response.state.activeWorkflows) {
                        workflowsMap.set(wf.id, wf);
                    }
                }
                return {
                    activeWorkflows: workflowsMap,
                    workflowHistory: response.state.workflowHistory || []
                };
            }
            return undefined;
        } catch (err) {
            log.warn('Failed to get session state from daemon:', err);
            return undefined;
        }
    }

    // ========================================================================
    // Unity Status
    // ========================================================================

    /**
     * Get Unity control status
     */
    async getUnityStatus(): Promise<UnityStatus | undefined> {
        if (!this.unityEnabled) {
            return undefined;
        }
        
        // Return cached status if available
        if (this.lastUnityStatus) {
            return this.lastUnityStatus;
        }

        if (!this.vsCodeClient.isConnected()) {
            return undefined;
        }

        try {
            const response = await this.vsCodeClient.getUnityStatus();
            const status: UnityStatus = {
                connected: response.connected,
                isPlaying: response.isPlaying,
                isCompiling: response.isCompiling,
                hasErrors: response.hasErrors,
                errorCount: response.errorCount,
                queueLength: response.queueLength ?? 0,
                status: response.status as UnityStatus['status'],
                currentTask: response.currentTask
            };
            this.lastUnityStatus = status;
            return status;
        } catch (err) {
            log.warn('Failed to get Unity status from daemon:', err);
            return undefined;
        }
    }
    
    /**
     * Trigger Unity prep (compile) run manually
     * Only call this when Unity pipeline queue is empty
     */
    async triggerUnityPrep(): Promise<{ success: boolean; taskId?: string; error?: string }> {
        if (!this.unityEnabled) {
            return { success: false, error: 'Unity features not enabled' };
        }
        
        if (!this.vsCodeClient.isConnected()) {
            return { success: false, error: 'Daemon not connected' };
        }
        
        try {
            return await this.vsCodeClient.triggerUnityPrep();
        } catch (err) {
            log.warn('Failed to trigger Unity prep:', err);
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    
    /**
     * Trigger Unity prep + EditMode test pipeline
     */
    async triggerUnityEditModeTest(): Promise<{ success: boolean; pipelineId?: string; error?: string }> {
        if (!this.unityEnabled) {
            return { success: false, error: 'Unity features not enabled' };
        }
        
        if (!this.vsCodeClient.isConnected()) {
            return { success: false, error: 'Daemon not connected' };
        }
        
        try {
            return await this.vsCodeClient.triggerUnityPipeline(['prep', 'test_editmode']);
        } catch (err) {
            log.warn('Failed to trigger Unity EditMode test:', err);
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    
    /**
     * Trigger Unity prep + PlayMode test pipeline
     */
    async triggerUnityPlayModeTest(): Promise<{ success: boolean; pipelineId?: string; error?: string }> {
        if (!this.unityEnabled) {
            return { success: false, error: 'Unity features not enabled' };
        }
        
        if (!this.vsCodeClient.isConnected()) {
            return { success: false, error: 'Daemon not connected' };
        }
        
        try {
            return await this.vsCodeClient.triggerUnityPipeline(['prep', 'test_playmode']);
        } catch (err) {
            log.warn('Failed to trigger Unity PlayMode test:', err);
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    
    /**
     * Trigger Unity prep + Player manual test pipeline
     */
    async triggerUnityPlayerTest(): Promise<{ success: boolean; pipelineId?: string; error?: string }> {
        if (!this.unityEnabled) {
            return { success: false, error: 'Unity features not enabled' };
        }
        
        if (!this.vsCodeClient.isConnected()) {
            return { success: false, error: 'Daemon not connected' };
        }
        
        try {
            return await this.vsCodeClient.triggerUnityPipeline(['prep', 'test_player_playmode']);
        } catch (err) {
            log.warn('Failed to trigger Unity Player test:', err);
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    
    // ========================================================================
    // Coordinator
    // ========================================================================
    
    /**
     * Request coordinator evaluation for a session
     * Used when UI detects idle approved plan with available agents
     */
    async requestCoordinatorEvaluation(sessionId: string, reason: string): Promise<{ success: boolean; error?: string }> {
        if (!this.vsCodeClient.isConnected()) {
            return { success: false, error: 'Daemon not connected' };
        }
        return this.vsCodeClient.requestCoordinatorEvaluation(sessionId, reason);
    }
    
    /**
     * Get coordinator status for UI display
     */
    async getCoordinatorStatus(): Promise<CoordinatorStatusInfo | undefined> {
        // Return cached status if available
        if (this.lastCoordinatorStatus) {
            return this.lastCoordinatorStatus;
        }
        
        if (!this.vsCodeClient.isConnected()) {
            return undefined;
        }

        try {
            const response: { status?: CoordinatorStatusInfo } = await this.vsCodeClient.send('coordinator.status');
            if (response.status) {
                this.lastCoordinatorStatus = response.status;
            }
            return response.status;
        } catch (err) {
            log.warn('Failed to get coordinator status from daemon:', err);
            return undefined;
        }
    }
    
    // ========================================================================
    // Workflow Control
    // ========================================================================
    
    /**
     * Cancel a workflow
     */
    async cancelWorkflow(sessionId: string, workflowId: string): Promise<{ success: boolean; error?: string }> {
        if (!this.vsCodeClient.isConnected()) {
            return { success: false, error: 'Daemon not connected' };
        }
        return this.vsCodeClient.cancelWorkflow(sessionId, workflowId);
    }
    
    // ========================================================================
    // Dependency Status
    // ========================================================================
    
    /**
     * Get dependency status from daemon
     */
    async getDependencyStatus(): Promise<{
        missingDependencies: Array<{
            name: string;
            description: string;
            installUrl?: string;
            installCommand?: string;
            installType: 'url' | 'command' | 'apc-cli' | 'vscode-command' | 'cursor-agent-cli';
        }>;
        missingCount: number;
        hasCriticalMissing: boolean;
    } | undefined> {
        if (!this.vsCodeClient.isConnected()) {
            return undefined;
        }
        
        try {
            const response: {
                missingDependencies?: Array<{
                    name: string;
                    description: string;
                    installUrl?: string;
                    installCommand?: string;
                    installType: 'url' | 'command' | 'apc-cli' | 'vscode-command' | 'cursor-agent-cli';
                }>;
                missingCount?: number;
                hasCriticalMissing?: boolean;
            } = await this.vsCodeClient.send('deps.status');
            
            return {
                missingDependencies: response.missingDependencies || [],
                missingCount: response.missingCount || 0,
                hasCriticalMissing: response.hasCriticalMissing || false
            };
        } catch (err) {
            log.warn('Failed to get dependency status from daemon:', err);
            return undefined;
        }
    }
    
    /**
     * Refresh dependency status on daemon
     */
    async refreshDependencies(): Promise<{
        missingDependencies: Array<{
            name: string;
            description: string;
            installUrl?: string;
            installCommand?: string;
            installType: 'url' | 'command' | 'apc-cli' | 'vscode-command' | 'cursor-agent-cli';
        }>;
        missingCount: number;
        hasCriticalMissing: boolean;
    } | undefined> {
        if (!this.vsCodeClient.isConnected()) {
            return undefined;
        }
        
        try {
            const response: {
                missingDependencies?: Array<{
                    name: string;
                    description: string;
                    installUrl?: string;
                    installCommand?: string;
                    installType: 'url' | 'command' | 'apc-cli' | 'vscode-command';
                }>;
                missingCount?: number;
                hasCriticalMissing?: boolean;
            // Use 4-minute timeout for deps.refresh since Unity MCP connectivity test can take ~3 minutes
            } = await this.vsCodeClient.sendWithTimeout('deps.refresh', undefined, 240000);
            
            return {
                missingDependencies: response.missingDependencies || [],
                missingCount: response.missingCount || 0,
                hasCriticalMissing: response.hasCriticalMissing || false
            };
        } catch (err) {
            log.warn('Failed to refresh dependencies on daemon:', err);
            return undefined;
        }
    }
    
    /**
     * Install APC Unity Bridge package to Unity project
     */
    async installUnityBridge(): Promise<{ success: boolean; message: string } | undefined> {
        if (!this.vsCodeClient.isConnected()) {
            return undefined;
        }
        
        try {
            const response: { success?: boolean; message?: string } = 
                await this.vsCodeClient.send('system.installUnityBridge');
            
            return {
                success: response.success || false,
                message: response.message || 'Unknown result'
            };
        } catch (err) {
            log.warn('Failed to install Unity Bridge:', err);
            return { success: false, message: err instanceof Error ? err.message : String(err) };
        }
    }
}
