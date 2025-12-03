/**
 * DaemonStateProxy.ts - Proxy service for daemon state access
 * 
 * This service provides a unified interface for UI providers to access state.
 * All state is fetched from the daemon via WebSocket API.
 * When daemon is not connected, returns empty state and UI shows "daemon missing".
 */

import { VsCodeClient } from '../vscode/VsCodeClient';
import { TypedEventEmitter } from './TypedEventEmitter';
import {
    PlanningSession,
    AgentStatus,
    AgentRole
} from '../types';
import { WorkflowProgress, FailedTask, CompletedWorkflowSummary } from '../types/workflow';

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
    coordinatorId: string;
    sessionId: string;
    workflowId?: string;  // The specific workflow this agent is working on
    task?: string;
}

export interface SessionState {
    isRevising: boolean;
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
}

// ============================================================================
// DaemonStateProxy
// ============================================================================

export type ConnectionHealthState = 'healthy' | 'unhealthy' | 'unknown';

export interface ConnectionHealthInfo {
    state: ConnectionHealthState;
    lastPingSuccess: boolean;
    lastPingTime?: number;
    consecutiveFailures: number;
}

export class DaemonStateProxy {
    private vsCodeClient: VsCodeClient;
    private unityEnabled: boolean;
    
    // Connection health monitoring
    private healthCheckTimer: NodeJS.Timeout | null = null;
    private consecutiveFailures: number = 0;
    private lastPingSuccess: boolean = true;
    private lastPingTime?: number;
    private currentHealthState: ConnectionHealthState = 'unknown';
    
    // Cached status from events
    private lastCoordinatorStatus?: CoordinatorStatusInfo;
    private lastUnityStatus?: UnityStatus;
    
    private readonly _onConnectionHealthChanged = new TypedEventEmitter<ConnectionHealthInfo>();
    readonly onConnectionHealthChanged = this._onConnectionHealthChanged.event;

    constructor(options: DaemonStateProxyOptions) {
        this.vsCodeClient = options.vsCodeClient;
        this.unityEnabled = options.unityEnabled ?? true;
        
        // Listen to coordinator and Unity status events
        this.setupEventListeners();
    }
    
    /**
     * Set up event listeners for status updates
     */
    private setupEventListeners(): void {
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
                connected: true,  // If we're receiving events, Unity is connected
                isPlaying: data.isPlaying,
                isCompiling: data.isCompiling,
                hasErrors: data.hasErrors,
                errorCount: data.errorCount,
                queueLength: 0  // Will be updated by state queries
            };
        });
        
        // Listen for Unity pipeline events to update queue
        this.vsCodeClient.on('unity.pipelineStarted', (data: any) => {
            if (this.lastUnityStatus) {
                this.lastUnityStatus.queueLength = (this.lastUnityStatus.queueLength || 0) + 1;
            }
        });
        
        this.vsCodeClient.on('unity.pipelineCompleted', (data: any) => {
            if (this.lastUnityStatus && this.lastUnityStatus.queueLength > 0) {
                this.lastUnityStatus.queueLength--;
            }
        });
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
     * Check if Unity features are enabled
     */
    isUnityEnabled(): boolean {
        return this.unityEnabled;
    }
    
    /**
     * Get current connection health info
     */
    getConnectionHealth(): ConnectionHealthInfo {
        return {
            state: this.currentHealthState,
            lastPingSuccess: this.lastPingSuccess,
            lastPingTime: this.lastPingTime,
            consecutiveFailures: this.consecutiveFailures
        };
    }
    
    /**
     * Start periodic connection health monitoring
     * @param intervalMs Interval between health checks (default: 15000)
     */
    startConnectionMonitor(intervalMs: number = 15000): void {
        this.stopConnectionMonitor();
        
        console.log(`[DaemonStateProxy] Starting connection monitor (interval: ${intervalMs / 1000}s)`);
        
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
            console.log('[DaemonStateProxy] Connection monitor stopped');
        }
    }
    
    /**
     * Perform a health check ping
     */
    private async performHealthCheck(): Promise<void> {
        const previousState = this.currentHealthState;
        
        try {
            const pingSuccess = await this.vsCodeClient.ping(5000);
            this.lastPingTime = Date.now();
            this.lastPingSuccess = pingSuccess;
            
            if (pingSuccess) {
                this.consecutiveFailures = 0;
                this.currentHealthState = 'healthy';
            } else {
                this.consecutiveFailures++;
                // Consider unhealthy after 2 consecutive failures
                if (this.consecutiveFailures >= 2) {
                    this.currentHealthState = 'unhealthy';
                }
            }
        } catch (e) {
            this.consecutiveFailures++;
            this.lastPingSuccess = false;
            this.lastPingTime = Date.now();
            
            if (this.consecutiveFailures >= 2) {
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
            console.warn('[DaemonStateProxy] Failed to get sessions from daemon:', err);
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
            console.warn('[DaemonStateProxy] Failed to get session from daemon:', err);
            return undefined;
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
            console.warn('[DaemonStateProxy] Failed to get pool status from daemon:', err);
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
            console.warn('[DaemonStateProxy] Failed to get available agents from daemon:', err);
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
                coordinatorId: b.coordinatorId,
                sessionId: b.sessionId,
                task: b.task
            }));
        } catch (err) {
            console.warn('[DaemonStateProxy] Failed to get busy agents from daemon:', err);
            return [];
        }
    }

    /**
     * Get agents on bench (allocated but not busy)
     */
    async getAgentsOnBench(sessionId?: string): Promise<Array<{ name: string; roleId: string; sessionId: string }>> {
        if (!this.vsCodeClient.isConnected()) {
            return [];
        }

        try {
            const response: { agents?: Array<{ name: string; roleId: string; sessionId: string }> } = 
                await this.vsCodeClient.send('pool.bench', { sessionId });
            return response.agents || [];
        } catch (err) {
            console.warn('[DaemonStateProxy] Failed to get bench agents from daemon:', err);
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
            console.warn('[DaemonStateProxy] Failed to get agent status from daemon:', err);
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
            console.warn('[DaemonStateProxy] Failed to get role from daemon:', err);
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
            console.warn('[DaemonStateProxy] Failed to get assignments from daemon:', err);
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
                    isRevising: boolean; 
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
                    isRevising: response.state.isRevising,
                    activeWorkflows: workflowsMap,
                    workflowHistory: response.state.workflowHistory || []
                };
            }
            return undefined;
        } catch (err) {
            console.warn('[DaemonStateProxy] Failed to get session state from daemon:', err);
            return undefined;
        }
    }

    /**
     * Get failed tasks for a session
     */
    async getFailedTasks(sessionId: string): Promise<FailedTask[]> {
        if (!this.vsCodeClient.isConnected()) {
            return [];
        }

        try {
            const response: { failedTasks?: FailedTask[] } = await this.vsCodeClient.send('session.failed_tasks', { id: sessionId });
            return response.failedTasks || [];
        } catch (err) {
            console.warn('[DaemonStateProxy] Failed to get failed tasks from daemon:', err);
            return [];
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
            const status = {
                connected: response.connected,
                isPlaying: response.isPlaying,
                isCompiling: response.isCompiling,
                hasErrors: response.hasErrors,
                errorCount: response.errorCount,
                queueLength: response.queueLength
            };
            this.lastUnityStatus = status;
            return status;
        } catch (err) {
            console.warn('[DaemonStateProxy] Failed to get Unity status from daemon:', err);
            return undefined;
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
            console.warn('[DaemonStateProxy] Failed to get coordinator status from daemon:', err);
            return undefined;
        }
    }
    
    // ========================================================================
    // Workflow Control
    // ========================================================================
    
    /**
     * Pause a workflow
     */
    async pauseWorkflow(sessionId: string, workflowId: string): Promise<{ success: boolean; error?: string }> {
        if (!this.vsCodeClient.isConnected()) {
            return { success: false, error: 'Daemon not connected' };
        }
        return this.vsCodeClient.pauseWorkflow(sessionId, workflowId);
    }
    
    /**
     * Resume a paused workflow
     */
    async resumeWorkflow(sessionId: string, workflowId: string): Promise<{ success: boolean; error?: string }> {
        if (!this.vsCodeClient.isConnected()) {
            return { success: false, error: 'Daemon not connected' };
        }
        return this.vsCodeClient.resumeWorkflow(sessionId, workflowId);
    }
    
    /**
     * Cancel a workflow
     */
    async cancelWorkflow(sessionId: string, workflowId: string): Promise<{ success: boolean; error?: string }> {
        if (!this.vsCodeClient.isConnected()) {
            return { success: false, error: 'Daemon not connected' };
        }
        return this.vsCodeClient.cancelWorkflow(sessionId, workflowId);
    }
    }
