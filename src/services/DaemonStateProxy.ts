/**
 * DaemonStateProxy.ts - Proxy service for daemon state access
 * 
 * This service provides a unified interface for UI providers to access state.
 * All state is fetched from the daemon via WebSocket API.
 * When daemon is not connected, returns empty state and UI shows "daemon missing".
 */

import { VsCodeClient } from '../vscode/VsCodeClient';
import { AgentAssignment } from './TaskManager';
import {
    PlanningSession,
    AgentStatus,
    AgentRole
} from '../types';
import { WorkflowProgress, FailedTask } from '../types/workflow';

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
    task?: string;
}

export interface SessionState {
    isRevising: boolean;
    activeWorkflows: Map<string, WorkflowProgress>;
}

export interface UnityStatus {
    connected: boolean;
    isPlaying: boolean;
    isCompiling: boolean;
    hasErrors: boolean;
    errorCount: number;
    queueLength: number;
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

export class DaemonStateProxy {
    private vsCodeClient: VsCodeClient;
    private unityEnabled: boolean;

    constructor(options: DaemonStateProxyOptions) {
        this.vsCodeClient = options.vsCodeClient;
        this.unityEnabled = options.unityEnabled ?? true;
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
            const response = await this.vsCodeClient.send<{ session: PlanningSession }>('session.get', { id: sessionId });
            return response.session;
        } catch (err) {
            console.warn('[DaemonStateProxy] Failed to get session from daemon:', err);
            return undefined;
        }
    }

    /**
     * Get progress log path for a session
     */
    async getProgressLogPath(sessionId: string): Promise<string | undefined> {
        if (!this.vsCodeClient.isConnected()) {
            return undefined;
        }

        try {
            const response = await this.vsCodeClient.send<{ session?: { progressLogPath?: string } }>('session.get', { id: sessionId });
            return response.session?.progressLogPath;
        } catch (err) {
            console.warn('[DaemonStateProxy] Failed to get progress log path:', err);
            return undefined;
        }
    }

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
     * Get agent status
     */
    async getAgentStatus(agentName: string): Promise<AgentStatus | undefined> {
        if (!this.vsCodeClient.isConnected()) {
            return undefined;
        }

        try {
            const response = await this.vsCodeClient.send<{ agent?: AgentStatus }>('pool.agent.status', { name: agentName });
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
            const response = await this.vsCodeClient.send<{ role?: AgentRole }>('pool.role', { id: roleId });
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
            const response = await this.vsCodeClient.send<{ assignments?: AgentAssignment[] }>('task.assignments');
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
     * Get session state (workflows, revision status)
     */
    async getSessionState(sessionId: string): Promise<SessionState | undefined> {
        if (!this.vsCodeClient.isConnected()) {
            return undefined;
        }

        try {
            const response = await this.vsCodeClient.send<{ state?: { isRevising: boolean; activeWorkflows?: Array<WorkflowProgress & { id: string }> } }>('session.state', { id: sessionId });
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
                    activeWorkflows: workflowsMap
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
            const response = await this.vsCodeClient.send<{ failedTasks?: FailedTask[] }>('session.failed_tasks', { id: sessionId });
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

        if (!this.vsCodeClient.isConnected()) {
            return undefined;
        }

        try {
            const response = await this.vsCodeClient.getUnityStatus();
            return {
                connected: response.connected,
                isPlaying: response.isPlaying,
                isCompiling: response.isCompiling,
                hasErrors: response.hasErrors,
                errorCount: response.errorCount,
                queueLength: response.queueLength
            };
        } catch (err) {
            console.warn('[DaemonStateProxy] Failed to get Unity status from daemon:', err);
            return undefined;
        }
    }
}
