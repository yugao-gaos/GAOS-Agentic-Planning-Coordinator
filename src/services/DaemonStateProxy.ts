/**
 * DaemonStateProxy.ts - Proxy service for daemon/local state routing
 * 
 * This service provides a unified interface for UI providers to access state.
 * When the daemon is external (started by CLI), it routes to daemon API.
 * When the daemon is managed by VS Code, it uses local service singletons.
 */

import { VsCodeClient } from '../vscode/VsCodeClient';
import { StateManager } from './StateManager';
import { AgentPoolService } from './AgentPoolService';
import { AgentAssignment } from './TaskManager';
import {
    PlanningSession,
    AgentStatus,
    AgentRole
} from '../types';
import { WorkflowProgress, FailedTask } from '../types/workflow';
import { ServiceLocator } from './ServiceLocator';

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
    /** Whether daemon was started externally (CLI) vs by VS Code */
    isExternal: boolean;
    /** VS Code client for daemon communication (required if isExternal) */
    vsCodeClient?: VsCodeClient;
    /** Local services (required if NOT isExternal) */
    stateManager?: StateManager;
    agentPoolService?: AgentPoolService;
    /** Whether Unity features are enabled */
    unityEnabled?: boolean;
}

// ============================================================================
// DaemonStateProxy
// ============================================================================

export class DaemonStateProxy {
    private isExternal: boolean;
    private vsCodeClient?: VsCodeClient;
    private stateManager?: StateManager;
    private agentPoolService?: AgentPoolService;
    private unityEnabled: boolean;

    constructor(options: DaemonStateProxyOptions) {
        this.isExternal = options.isExternal;
        this.vsCodeClient = options.vsCodeClient;
        this.stateManager = options.stateManager;
        this.agentPoolService = options.agentPoolService;
        this.unityEnabled = options.unityEnabled ?? true;

        // Validate options
        if (this.isExternal && !this.vsCodeClient) {
            throw new Error('DaemonStateProxy: vsCodeClient required when isExternal=true');
        }
        if (!this.isExternal && !this.stateManager) {
            throw new Error('DaemonStateProxy: stateManager required when isExternal=false');
        }
    }

    // ========================================================================
    // Mode Queries
    // ========================================================================

    /**
     * Check if using external daemon
     */
    isExternalDaemon(): boolean {
        return this.isExternal;
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
     * Get all planning sessions
     * NOTE: Always use daemon API when client is connected, because
     * even when VS Code starts the daemon, it runs in a separate process
     * with its own StateManager instance.
     */
    async getPlanningSessions(): Promise<PlanningSession[]> {
        // Always prefer daemon API when client is connected
        if (this.vsCodeClient?.isConnected()) {
            try {
                const response = await this.vsCodeClient.listSessions();
                // Daemon API returns summary data - cast to PlanningSession[] 
                // The UI only uses common fields that are present in both types
                return (response.sessions || []) as unknown as PlanningSession[];
            } catch (err) {
                console.warn('[DaemonStateProxy] Failed to get sessions from daemon:', err);
                // Fall through to local StateManager as fallback
            }
        }

        // Fallback to local StateManager if daemon not connected
        return this.stateManager?.getAllPlanningSessions() || [];
    }

    /**
     * Get a specific planning session by ID
     */
    async getPlanningSession(sessionId: string): Promise<PlanningSession | undefined> {
        // Always prefer daemon API when client is connected
        if (this.vsCodeClient?.isConnected()) {
            try {
                const response = await this.vsCodeClient.send('session.get', { id: sessionId });
                return response.session;
            } catch (err) {
                console.warn('[DaemonStateProxy] Failed to get session from daemon:', err);
                // Fall through to local StateManager as fallback
            }
        }

        return this.stateManager?.getPlanningSession(sessionId);
    }

    /**
     * Get progress log path for a session
     */
    getProgressLogPath(sessionId: string): string | undefined {
        // This is always a local file path operation
        return this.stateManager?.getProgressLogPath(sessionId);
    }

    // ========================================================================
    // Agent Pool
    // ========================================================================

    /**
     * Get pool status summary
     */
    async getPoolStatus(): Promise<PoolStatus> {
        // Always prefer daemon API when client is connected
        if (this.vsCodeClient?.isConnected()) {
            try {
                const response = await this.vsCodeClient.getPoolStatus();
                return {
                    total: response.total,
                    available: response.available,
                    busy: response.busy.map(b => b.name)
                };
            } catch (err) {
                console.warn('[DaemonStateProxy] Failed to get pool status from daemon:', err);
                // Fall through to local service as fallback
            }
        }

        const status = this.agentPoolService?.getPoolStatus();
        return status || { total: 0, available: [], busy: [] };
    }

    /**
     * Get available agents
     */
    async getAvailableAgents(): Promise<string[]> {
        // Always prefer daemon API when client is connected
        if (this.vsCodeClient?.isConnected()) {
            try {
                const response = await this.vsCodeClient.getPoolStatus();
                return response.available;
            } catch (err) {
                console.warn('[DaemonStateProxy] Failed to get available agents from daemon:', err);
                // Fall through to local service as fallback
            }
        }

        return this.agentPoolService?.getAvailableAgents() || [];
    }

    /**
     * Get busy agents with details
     */
    async getBusyAgents(): Promise<BusyAgentInfo[]> {
        // Always prefer daemon API when client is connected
        if (this.vsCodeClient?.isConnected()) {
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
                // Fall through to local service as fallback
            }
        }

        return this.agentPoolService?.getBusyAgents() || [];
    }

    /**
     * Get agent status
     */
    async getAgentStatus(agentName: string): Promise<AgentStatus | undefined> {
        // Always prefer daemon API when client is connected
        if (this.vsCodeClient?.isConnected()) {
            try {
                const response = await this.vsCodeClient.send('pool.agent.status', { name: agentName });
                return response.agent;
            } catch (err) {
                console.warn('[DaemonStateProxy] Failed to get agent status from daemon:', err);
                // Fall through to local service as fallback
            }
        }

        return this.agentPoolService?.getAgentStatus(agentName);
    }

    /**
     * Get a role by ID
     */
    getRole(roleId: string): AgentRole | undefined {
        // Roles are stored in local registry - always use local
        return this.agentPoolService?.getRole(roleId);
    }

    // ========================================================================
    // Task Manager (Agent Assignments)
    // ========================================================================

    /**
     * Get agent assignments for UI display
     */
    async getAgentAssignmentsForUI(): Promise<AgentAssignment[]> {
        // Always prefer daemon API when client is connected
        if (this.vsCodeClient?.isConnected()) {
            try {
                const response = await this.vsCodeClient.send('task.assignments');
                return response.assignments || [];
            } catch (err) {
                console.warn('[DaemonStateProxy] Failed to get assignments from daemon:', err);
                // Fall through to return empty
            }
        }

        // TaskManager needs to be accessed via imports
        // Return empty since coordinator state isn't accessible without injected reference
        return [];
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
        // Always prefer daemon API when client is connected
        if (this.vsCodeClient?.isConnected()) {
            try {
                const response = await this.vsCodeClient.send('session.state', { id: sessionId });
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
                // Fall through to return undefined
            }
        }

        // Coordinator state isn't accessible without injected reference
        return undefined;
    }

    /**
     * Get failed tasks for a session
     */
    async getFailedTasks(sessionId: string): Promise<FailedTask[]> {
        // Always prefer daemon API when client is connected
        if (this.vsCodeClient?.isConnected()) {
            try {
                const response = await this.vsCodeClient.send('session.failed_tasks', { id: sessionId });
                return response.failedTasks || [];
            } catch (err) {
                console.warn('[DaemonStateProxy] Failed to get failed tasks from daemon:', err);
                // Fall through to return empty
            }
        }

        // Coordinator state isn't accessible without injected reference
        return [];
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

        // Always prefer daemon API when client is connected
        if (this.vsCodeClient?.isConnected()) {
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
                // Fall through to return undefined
            }
        }

        // Unity manager isn't accessible without injected reference
        return undefined;
    }

    // ========================================================================
    // State Reload (for event-based updates)
    // ========================================================================

    /**
     * Reload state from files (for file-based state sync)
     */
    reloadFromFiles(): void {
        if (!this.isExternal && this.stateManager) {
            this.stateManager.reloadFromFiles();
        }
    }
}

