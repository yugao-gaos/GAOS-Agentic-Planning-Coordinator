/**
 * ApiHandler.ts - WebSocket API request handler for APC daemon
 * 
 * This module handles incoming API requests from clients and routes them
 * to the appropriate services. It replaces the file-based CliIpcService.
 */

import {
    ApcRequest,
    ApcResponse,
    StatusResponse,
    SessionListResponse,
    SessionStatusResponse,
    PlanListResponse,
    ExecStatusResponse,
    PoolStatusResponse,
    AgentPoolResponse,
    AgentRolesResponse,
    UnityStatusResponse,
    WorkflowSummaryData
} from '../client/Protocol';
import { EventBroadcaster } from './EventBroadcaster';
import { ServiceLocator } from '../services/ServiceLocator';

// ============================================================================
// Service Interface
// ============================================================================

/**
 * Interface for services that the ApiHandler depends on.
 * This allows the daemon to inject actual service instances.
 */
export interface ApiServices {
    stateManager: IStateManagerApi;
    agentPoolService: IAgentPoolApi;
    coordinator: ICoordinatorApi;
    planningService: IPlanningApi;
    unityManager?: IUnityApi;
    taskManager?: ITaskManagerApi;
    roleRegistry?: IRoleRegistryApi;
}

/**
 * Planning session data from state manager
 */
export interface PlanningSessionData {
    id: string;
    status: string;
    requirement: string;
    currentPlanPath?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    planHistory?: any[];
    createdAt: string;
    updatedAt: string;
}

/**
 * Minimal state manager interface for API handler
 */
export interface IStateManagerApi {
    getAllPlanningSessions(): PlanningSessionData[];
    getPlanningSession(id: string): PlanningSessionData | undefined;
    deletePlanningSession(id: string): void;
}

/**
 * Role data for API responses
 */
export interface RoleData {
    id: string;
    name: string;
    description: string;
    isBuiltIn: boolean;
    defaultModel: string;
    timeoutMs: number;
}

/**
 * Minimal agent pool interface for API handler
 */
export interface IAgentPoolApi {
    getPoolStatus(): { total: number; available: string[]; busy: string[] };
    getAvailableAgents(): string[];
    getBusyAgents(): Array<{ name: string; roleId?: string; coordinatorId: string; sessionId: string; task?: string }>;
    getAgentsOnBench(sessionId?: string): Array<{ name: string; roleId: string; sessionId: string }>;
    getAllRoles(): RoleData[];
    getRole(roleId: string): RoleData | undefined;
    resizePool(newSize: number): { added: string[]; removed: string[] };
    releaseAgents(names: string[]): void;
}

/**
 * Role registry interface for API handler
 */
export interface IRoleRegistryApi {
    getRole(roleId: string): RoleData | undefined;
    updateRole(roleId: string, updates: Record<string, unknown>): void;
    resetRoleToDefault(roleId: string): boolean;
}

/**
 * Session state from coordinator
 */
export interface SessionState {
    isRevising: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    activeWorkflows: Map<string, any>;
    pendingWorkflows?: string[];
    completedWorkflows?: string[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    workflowHistory?: any[];
}

/**
 * Workflow status data
 */
export interface WorkflowStatusData {
    id?: string;
    type: string;
    status: string;
    phase: string;
    percentage: number;
}

/**
 * Coordinator status for UI display
 */
export interface CoordinatorStatusData {
    state: 'idle' | 'queuing' | 'evaluating' | 'cooldown';
    pendingEvents: number;
    lastEvaluation?: string;
    evaluationCount: number;
}

/**
 * Minimal coordinator interface for API handler
 */
export interface ICoordinatorApi {
    getSessionState(sessionId: string): SessionState | null | undefined;
    getWorkflowSummaries(sessionId: string): WorkflowSummaryData[];
    getWorkflowStatus(sessionId: string, workflowId: string): WorkflowStatusData | null | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dispatchWorkflow(sessionId: string, type: string, input: any): Promise<string>;
    cancelWorkflow(sessionId: string, workflowId: string): Promise<void>;
    pauseSession(sessionId: string): Promise<void>;
    resumeSession(sessionId: string): Promise<void>;
    cancelSession(sessionId: string): Promise<void>;
    startExecution(sessionId: string): Promise<string[]>;
    getFailedTasks(sessionId: string): Array<{ taskId: string; description: string; attempts: number; lastError: string; canRetry: boolean }>;
    
    // Agent CLI callback support
    signalAgentCompletion(signal: AgentCompletionSignal): boolean;
    
    // Coordinator evaluation trigger
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    triggerCoordinatorEvaluation(sessionId: string, eventType: string, payload: any): Promise<any>;
    
    // Update workflow history summary
    updateWorkflowHistorySummary(sessionId: string, workflowId: string, summary: string): void;
    
    // Start a workflow for a specific task
    startTaskWorkflow(sessionId: string, taskId: string, workflowType: string): Promise<string>;
    
    // Get coordinator status for UI
    getCoordinatorStatus?(): CoordinatorStatusData;
    
    // Graceful shutdown - pause all workflows and release agents
    gracefulShutdown?(): Promise<{ workflowsPaused: number; agentsReleased: number }>;
    
    // Recover paused workflows after restart
    recoverAllSessions?(): Promise<number>;
}

/**
 * Minimal task manager interface for API handler
 */
export interface ITaskManagerApi {
    getProgressForSession(sessionId: string): { completed: number; pending: number; inProgress: number; failed: number; ready: number; total: number };
    getTasksForSession(sessionId: string): Array<{ id: string; sessionId: string; description: string; status: string; taskType: string; stage?: string; dependencies: string[]; dependents: string[]; priority: number; actualAgent?: string; filesModified?: string[]; startedAt?: string; completedAt?: string; errorText?: string; previousAttempts?: number; previousFixSummary?: string; currentWorkflow?: string }>;
    getTask(globalTaskId: string): { id: string; sessionId: string; description: string; status: string; taskType: string; stage?: string; dependencies: string[]; dependents: string[]; priority: number; actualAgent?: string; filesModified?: string[]; startedAt?: string; completedAt?: string; errorText?: string; previousAttempts?: number; previousFixSummary?: string; currentWorkflow?: string } | undefined;
    getAllTasks(): Array<{ id: string; sessionId: string; description: string; status: string; taskType: string; stage?: string; dependencies: string[]; dependents: string[]; priority: number; actualAgent?: string; filesModified?: string[]; startedAt?: string; completedAt?: string; errorText?: string; previousAttempts?: number; previousFixSummary?: string; currentWorkflow?: string }>;
    createTaskFromCli(params: { sessionId: string; taskId: string; description: string; dependencies?: string[]; taskType?: 'implementation' | 'error_fix'; priority?: number; errorText?: string }): { success: boolean; error?: string };
    completeTask(globalTaskId: string, summary?: string): void;
    updateTaskStage(globalTaskId: string, stage: string): void;
    markTaskFailed(globalTaskId: string, reason?: string): void;
    /** Reload tasks from disk (for when daemon started before tasks were created) */
    reloadPersistedTasks?(): void;
    /** Delete a task (used when task has invalid format) */
    deleteTask?(globalTaskId: string, reason?: string): boolean;
    /** Validate task format, returns { valid: true } or { valid: false, reason: string } */
    validateTaskFormat?(task: any): { valid: true } | { valid: false; reason: string };
    /** Get agent assignments for UI display */
    getAgentAssignmentsForUI?(): Array<{ name: string; sessionId: string; roleId?: string; workflowId?: string; currentTaskId?: string; status: string; assignedAt: string; lastActivityAt?: string; logFile: string }>;
}

// Import types for agent completion signal
import { AgentCompletionSignal, AgentStage, AgentStageResult, AgentCompletionPayload } from '../types/workflow';

/**
 * Planning status result
 */
export interface PlanningResult {
    sessionId: string;
    status: string;
    planPath?: string;
    recommendedAgents?: { count: number; justification: string };
    debateSummary?: string;
}

/**
 * Minimal planning service interface for API handler
 */
export interface IPlanningApi {
    listPlanningSessions(): PlanningSessionData[];
    getPlanningStatus(id: string): PlanningSessionData | null | undefined;
    startPlanning(prompt: string, docs?: string[]): Promise<PlanningResult>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    revisePlan(id: string, feedback: string): Promise<any>;
    approvePlan(id: string, autoStart?: boolean): Promise<void>;
    cancelPlan(id: string): Promise<void>;
    restartPlanning(id: string): Promise<{ success: boolean; error?: string }>;
    removeSession(id: string): Promise<{ success: boolean; error?: string }>;
}

/**
 * Unity task requester info
 */
export interface UnityTaskRequester {
    coordinatorId: string;
    agentName: string;
}

/**
 * Unity task info
 */
export interface UnityTaskInfo {
    id: string;
    type: string;
    phase?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    requestedBy: any;
}

/**
 * Unity state from manager
 */
export interface UnityState {
    status: string;
    currentTask?: UnityTaskInfo;
    queueLength: number;
    lastActivity?: string;
    isPlaying?: boolean;
    isCompiling?: boolean;
    hasErrors?: boolean;
    errorCount?: number;
}

/**
 * Unity task options
 */
export interface UnityTaskOptions {
    testFilter?: string[];
    testScene?: string;
}

/**
 * Minimal Unity manager interface for API handler
 */
export interface IUnityApi {
    getState(): UnityState;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queueTask(type: string, requester: any, options?: any): string;
}

// ============================================================================
// API Handler
// ============================================================================

/**
 * Handles API requests from WebSocket clients.
 * Routes commands to appropriate services and returns responses.
 */
export class ApiHandler {
    private services: ApiServices;
    private broadcaster: EventBroadcaster;
    private startTime: number;
    private requestCount: number = 0;
    
    constructor(services: ApiServices) {
        this.services = services;
        this.broadcaster = ServiceLocator.resolve(EventBroadcaster);
        this.startTime = Date.now();
    }
    
    /**
     * Handle an incoming request and return a response
     */
    async handleRequest(request: ApcRequest): Promise<ApcResponse> {
        this.requestCount++;
        
        try {
            const result = await this.routeCommand(request.cmd, request.params || {});
            
            return {
                id: request.id,
                success: true,
                data: result.data,
                message: result.message
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`API error for ${request.cmd}:`, errorMessage);
            
            return {
                id: request.id,
                success: false,
                error: errorMessage
            };
        }
    }
    
    /**
     * Route a command to the appropriate handler
     */
    private async routeCommand(cmd: string, params: Record<string, unknown>): Promise<{ data?: unknown; message?: string }> {
        const [category, action] = cmd.split('.');
        
        switch (category) {
            case 'status':
                return { data: await this.handleStatus() };
            
            case 'session':
                return this.handleSession(action, params);
            
            case 'plan':
                return this.handlePlan(action, params);
            
            case 'exec':
                return this.handleExec(action, params);
            
            case 'workflow':
                return this.handleWorkflow(action, params);
            
            case 'pool':
                return this.handlePool(action, params);
            
            case 'agent':
                return this.handleAgent(action, params);
            
            case 'task':
                return this.handleTask(action, params);
            
            case 'unity':
                return this.handleUnity(action, params);
            
            case 'roles':
                return this.handleRoles(action, params);
            
            case 'coordinator':
                return this.handleCoordinator(action, params);
            
            case 'config':
                return this.handleConfig(action, params);
            
            case 'folders':
                return this.handleFolders(action, params);
            
            default:
                throw new Error(`Unknown command category: ${category}`);
        }
    }
    
    // ========================================================================
    // Status Handler
    // ========================================================================
    
    private async handleStatus(): Promise<StatusResponse> {
        const sessions = this.services.stateManager.getAllPlanningSessions();
        const poolStatus = this.services.agentPoolService.getPoolStatus();
        
        const activeSessions = sessions.filter(s => 
            ['debating', 'reviewing', 'revising', 'executing'].includes(s.status)
        ).length;
        
        return {
            activePlanningSessions: activeSessions,
            agentPool: {
                total: poolStatus.total,
                available: poolStatus.available.length,
                busy: poolStatus.busy.length
            },
            daemonUptime: Date.now() - this.startTime,
            connectedClients: 0 // Will be set by daemon
        };
    }
    
    // ========================================================================
    // Session Handlers
    // ========================================================================
    
    private async handleSession(action: string, params: Record<string, unknown>): Promise<{ data?: unknown; message?: string }> {
        switch (action) {
            case 'list': {
                return { data: this.sessionList() };
            }
            
            case 'status': {
                return { data: this.sessionStatus(params.id as string) };
            }
            
            case 'pause': {
                await this.services.coordinator.pauseSession(params.id as string);
                return { message: `Session ${params.id} paused` };
            }
            
            case 'resume': {
                await this.services.coordinator.resumeSession(params.id as string);
                return { message: `Session ${params.id} resumed` };
            }
            
            case 'get': {
                const session = this.services.stateManager.getPlanningSession(params.id as string);
                return { data: { session } };
            }
            
            case 'state': {
                return { data: { state: this.sessionState(params.id as string) } };
            }
            
            case 'failed_tasks': {
                const failedTasks = this.services.coordinator.getFailedTasks(params.id as string);
                return { data: { failedTasks } };
            }
            
            case 'stop': {
                await this.services.coordinator.cancelSession(params.id as string);
                return { message: `Session ${params.id} stopped` };
            }
            
            case 'remove': {
                // Use planningService.removeSession which also deletes plan files on disk
                const result = await this.services.planningService.removeSession(params.id as string);
                if (!result.success) {
                    throw new Error(result.error || 'Failed to remove session');
                }
                return { message: `Session ${params.id} removed` };
            }
            
            default:
                throw new Error(`Unknown session action: ${action}`);
        }
    }
    
    private sessionState(id: string): { isRevising: boolean; activeWorkflows: unknown[]; workflowHistory: unknown[] } | null {
        const state = this.services.coordinator.getSessionState(id);
        if (!state) {
            return null;
        }
        return {
            isRevising: state.isRevising,
            // Include workflow ID in each entry (Map keys are lost during serialization)
            activeWorkflows: Array.from(state.activeWorkflows.entries()).map(([id, wf]) => ({ ...wf, id })),
            workflowHistory: state.workflowHistory || []
        };
    }
    
    private sessionList(): SessionListResponse {
        const sessions = this.services.stateManager.getAllPlanningSessions();
        
        return {
            sessions: sessions.map(s => {
                const workflows = this.services.coordinator.getWorkflowSummaries(s.id);
                return {
                    id: s.id,
                    status: s.status,
                    requirement: s.requirement.substring(0, 100) + (s.requirement.length > 100 ? '...' : ''),
                    activeWorkflows: workflows.filter(w => w.status === 'running').length,
                    totalWorkflows: workflows.length,
                    createdAt: s.createdAt,
                    updatedAt: s.updatedAt,
                    currentPlanPath: s.currentPlanPath,
                    planHistory: s.planHistory
                };
            })
        };
    }
    
    private sessionStatus(id: string): SessionStatusResponse {
        const state = this.services.coordinator.getSessionState(id);
        if (!state) {
            throw new Error(`Session ${id} not found`);
        }
        
        const session = this.services.stateManager.getPlanningSession(id);
        const workflows = this.services.coordinator.getWorkflowSummaries(id);
        
        return {
            sessionId: id,
            status: session?.status || 'unknown',
            requirement: session?.requirement || '',
            currentPlanPath: session?.currentPlanPath,
            isRevising: state.isRevising,
            workflows: workflows,
            pendingWorkflows: state.pendingWorkflows?.length || 0,
            completedWorkflows: state.completedWorkflows?.length || 0
        };
    }
    
    // ========================================================================
    // Plan Handlers
    // ========================================================================
    
    private async handlePlan(action: string, params: Record<string, unknown>): Promise<{ data?: unknown; message?: string }> {
        switch (action) {
            case 'list': {
                return { data: this.planList() };
            }
            
            case 'create':
            case 'new':
            case 'start': {
                const result = await this.services.planningService.startPlanning(
                    params.prompt as string,
                    params.docs as string[] | undefined
                );
                // Broadcast session created so UI refreshes
                this.broadcaster.broadcast('session.created', { 
                    sessionId: result.sessionId, 
                    requirement: params.prompt as string,
                    createdAt: new Date().toISOString()
                });
                return {
                    data: result,
                    message: `Planning session ${result.sessionId} created`
                };
            }
            
            case 'status': {
                const status = this.services.planningService.getPlanningStatus(params.id as string);
                if (!status) {
                    throw new Error(`Planning session ${params.id} not found`);
                }
                return { data: status };
            }
            
            case 'revise': {
                const planId = params.id as string;
                const reviseResult = await this.services.planningService.revisePlan(planId, params.feedback as string);
                // Broadcast session update so UI refreshes
                this.broadcaster.broadcast('session.updated', { 
                    sessionId: planId, 
                    status: 'revising',
                    previousStatus: 'pending_review',
                    changes: ['feedback_added'],
                    updatedAt: new Date().toISOString()
                });
                return { data: reviseResult, message: 'Plan revision started' };
            }
            
            case 'approve': {
                const approveId = params.id as string;
                await this.services.planningService.approvePlan(approveId, params.autoStart as boolean | undefined);
                // Broadcast session update so UI refreshes
                this.broadcaster.broadcast('session.updated', { 
                    sessionId: approveId, 
                    status: 'approved',
                    previousStatus: 'pending_review',
                    changes: ['status_changed'],
                    updatedAt: new Date().toISOString()
                });
                return { message: `Plan ${approveId} approved` };
            }
            
            case 'cancel': {
                const cancelId = params.id as string;
                await this.services.planningService.cancelPlan(cancelId);
                // Broadcast session update so UI refreshes
                this.broadcaster.broadcast('session.updated', { 
                    sessionId: cancelId, 
                    status: 'cancelled',
                    previousStatus: 'unknown',
                    changes: ['status_changed'],
                    updatedAt: new Date().toISOString()
                });
                return { message: `Plan ${cancelId} cancelled` };
            }
            
            case 'restart': {
                const restartId = params.id as string;
                const result = await this.services.planningService.restartPlanning(restartId);
                if (!result.success) {
                    throw new Error(result.error || 'Failed to restart planning');
                }
                // Broadcast session update so UI refreshes
                this.broadcaster.broadcast('session.updated', { 
                    sessionId: restartId, 
                    status: 'debating',
                    previousStatus: 'cancelled',
                    changes: ['planning_restarted'],
                    updatedAt: new Date().toISOString()
                });
                return { message: `Planning restarted for ${restartId}` };
            }
            
            default:
                throw new Error(`Unknown plan action: ${action}`);
        }
    }
    
    private planList(): PlanListResponse {
        const sessions = this.services.planningService.listPlanningSessions();
        
        return {
            plans: sessions.map(s => ({
                id: s.id,
                status: s.status,
                requirement: s.requirement.substring(0, 100) + (s.requirement.length > 100 ? '...' : ''),
                currentPlanPath: s.currentPlanPath,
                version: s.planHistory?.length || 0
            }))
        };
    }
    
    // ========================================================================
    // Execution Handlers
    // ========================================================================
    
    private async handleExec(action: string, params: Record<string, unknown>): Promise<{ data?: unknown; message?: string }> {
        const sessionId = (params.sessionId || params.session || params.id) as string;
        
        switch (action) {
            case 'start': {
                const workflowIds = await this.services.coordinator.startExecution(sessionId);
                return {
                    data: { sessionId, workflowIds },
                    message: `Execution started with ${workflowIds.length} task workflows`
                };
            }
            
            case 'pause': {
                await this.services.coordinator.pauseSession(sessionId);
                return { message: `Execution paused for ${sessionId}` };
            }
            
            case 'resume': {
                await this.services.coordinator.resumeSession(sessionId);
                return { message: `Execution resumed for ${sessionId}` };
            }
            
            case 'stop': {
                await this.services.coordinator.cancelSession(sessionId);
                return { message: `Execution stopped for ${sessionId}` };
            }
            
            case 'status': {
                return { data: this.execStatus(sessionId) };
            }
            
            default:
                throw new Error(`Unknown exec action: ${action}`);
        }
    }
    
    private execStatus(sessionId: string): ExecStatusResponse {
        const state = this.services.coordinator.getSessionState(sessionId);
        if (!state) {
            throw new Error(`Session ${sessionId} not found`);
        }
        
        const workflows = this.services.coordinator.getWorkflowSummaries(sessionId);
        
        return {
            sessionId,
            isRevising: state.isRevising,
            workflows,
            activeWorkflows: workflows.filter(w => w.status === 'running').length,
            completedWorkflows: state.completedWorkflows?.length || 0
        };
    }
    
    // ========================================================================
    // Workflow Handlers
    // ========================================================================
    
    private async handleWorkflow(action: string, params: Record<string, unknown>): Promise<{ data?: unknown; message?: string }> {
        switch (action) {
            case 'dispatch': {
                const input = (params.input || {}) as Record<string, unknown>;
                const workflowId = await this.services.coordinator.dispatchWorkflow(
                    params.sessionId as string,
                    params.type as string,
                    input
                );
                return {
                    data: { workflowId, sessionId: params.sessionId, type: params.type },
                    message: `Workflow ${params.type} dispatched`
                };
            }
            
            case 'status': {
                const progress = this.services.coordinator.getWorkflowStatus(params.sessionId as string, params.workflowId as string);
                if (!progress) {
                    // Return graceful "not found" instead of throwing error
                    return { 
                        data: { 
                            workflowId: params.workflowId,
                            sessionId: params.sessionId,
                            status: 'not_found',
                            message: 'Workflow completed and cleaned up from memory'
                        } 
                    };
                }
                return { data: progress };
            }
            
            case 'cancel': {
                await this.services.coordinator.cancelWorkflow(params.sessionId as string, params.workflowId as string);
                return { message: `Workflow ${params.workflowId} cancelled` };
            }
            
            case 'list': {
                const workflows = this.services.coordinator.getWorkflowSummaries(params.sessionId as string);
                return { data: workflows };
            }
            
            case 'summarize': {
                this.services.coordinator.updateWorkflowHistorySummary(
                    params.sessionId as string,
                    params.workflowId as string,
                    params.summary as string
                );
                return { message: `Workflow summary updated for ${params.workflowId}` };
            }
            
            default:
                throw new Error(`Unknown workflow action: ${action}`);
        }
    }
    
    // ========================================================================
    // Pool Handlers
    // ========================================================================
    
    private async handlePool(action: string, params: Record<string, unknown>): Promise<{ data?: unknown; message?: string }> {
        switch (action) {
            case 'status':
            case undefined: {
                return { data: this.poolStatus() };
            }
            
            case 'resize': {
                const result = this.services.agentPoolService.resizePool(params.size as number);
                return {
                    data: { newSize: params.size, ...result },
                    message: `Pool resized to ${params.size}`
                };
            }
            
            case 'role': {
                const role = this.services.agentPoolService.getRole(params.id as string);
                return { data: { role } };
            }
            
            case 'bench': {
                const sessionId = params.sessionId as string | undefined;
                const agentPoolService = this.services.agentPoolService as IAgentPoolApi & { getAgentsOnBench?: (sessionId?: string) => Array<{ name: string; roleId: string; sessionId: string }> };
                if (agentPoolService.getAgentsOnBench) {
                    const agents = agentPoolService.getAgentsOnBench(sessionId);
                    return { data: { agents } };
                } else {
                    // Fallback: return empty array if method doesn't exist
                    return { data: { agents: [] } };
                }
            }
            
            default:
                throw new Error(`Unknown pool action: ${action}`);
        }
    }
    
    private poolStatus(): PoolStatusResponse {
        const status = this.services.agentPoolService.getPoolStatus();
        const busy = this.services.agentPoolService.getBusyAgents();
        
        return {
            total: status.total,
            available: status.available,
            busy: busy
        };
    }
    
    // ========================================================================
    // Agent Handlers
    // ========================================================================
    
    private async handleAgent(action: string, params: Record<string, unknown>): Promise<{ data?: unknown; message?: string }> {
        switch (action) {
            case 'pool': {
                return { data: this.agentPool() };
            }
            
            case 'roles': {
                return { data: this.agentRoles() };
            }
            
            case 'release': {
                this.services.agentPoolService.releaseAgents([params.agentName as string]);
                return { message: `Released ${params.agentName} back to pool` };
            }
            
            case 'complete': {
                return this.agentComplete(params);
            }
            
            default:
                throw new Error(`Unknown agent action: ${action}`);
        }
    }
    
    /**
     * Handle agent completion signal from CLI callback
     */
    private agentComplete(params: Record<string, unknown>): { data?: unknown; message?: string } {
        const { session, workflow, stage, result, data, task } = params;
        
        // Validate required params
        if (!session) {
            throw new Error('Missing session parameter');
        }
        if (!workflow) {
            throw new Error('Missing workflow parameter');
        }
        if (!stage) {
            throw new Error('Missing stage parameter');
        }
        if (!result) {
            throw new Error('Missing result parameter');
        }
        
        // Parse data payload if provided
        let payload: AgentCompletionPayload | undefined;
        if (data) {
            try {
                payload = typeof data === 'string' ? JSON.parse(data) : data as AgentCompletionPayload;
            } catch (e) {
                throw new Error(`Invalid data JSON: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        
        // Build signal (include taskId if provided for parallel task support)
        const signal: AgentCompletionSignal = {
            sessionId: session as string,
            workflowId: workflow as string,
            stage: stage as AgentStage,
            result: result as AgentStageResult,
            taskId: task as string | undefined,
            payload
        };
        
        // Send to coordinator
        const delivered = this.services.coordinator.signalAgentCompletion(signal);
        
        return {
            data: { sessionId: session, workflowId: workflow, stage, result, task, delivered },
            message: delivered 
                ? `Completion signaled: ${stage}${task ? '/' + task : ''} → ${result}` 
                : `Signal sent but no workflow waiting`
        };
    }
    
    private agentPool(): AgentPoolResponse {
        const available = this.services.agentPoolService.getAvailableAgents();
        const busy = this.services.agentPoolService.getBusyAgents();
        
        return {
            availableCount: available.length,
            available,
            busyCount: busy.length,
            busy: busy.map(b => ({
                name: b.name,
                roleId: b.roleId,
                coordinatorId: b.coordinatorId,
                sessionId: b.sessionId,
                task: b.task
            }))
        };
    }
    
    private agentRoles(): AgentRolesResponse {
        const roles = this.services.agentPoolService.getAllRoles();
        
        return {
            roles: roles.map(r => ({
                id: r.id,
                name: r.name,
                description: r.description,
                isBuiltIn: r.isBuiltIn,
                defaultModel: r.defaultModel,
                timeoutMs: r.timeoutMs
            }))
        };
    }
    
    // ========================================================================
    // Task Handlers
    // ========================================================================
    
    private async handleTask(action: string, params: Record<string, unknown>): Promise<{ data?: unknown; message?: string }> {
        if (!this.services.taskManager) {
            throw new Error('Task manager not available');
        }
        
        const sessionId = (params.session || params.sessionId) as string;
        let taskId = (params.task || params.taskId || params.id) as string;
        
        // Normalize task ID: strip session prefix if coordinator mistakenly included it
        // e.g., "ps_000001_T1" with session "ps_000001" → "T1"
        if (taskId && sessionId && taskId.startsWith(`${sessionId}_`)) {
            const normalizedId = taskId.slice(sessionId.length + 1);
            console.log(`[ApiHandler] Normalized task ID: "${taskId}" → "${normalizedId}" (stripped session prefix)`);
            taskId = normalizedId;
        }
        
        // Helper to validate and normalize task type
        const normalizeTaskType = (type: unknown): 'implementation' | 'error_fix' => {
            const typeStr = String(type || 'implementation').toLowerCase();
            // Map common mistakes to valid types
            if (typeStr === 'bugfix' || typeStr === 'bug_fix' || typeStr === 'fix') {
                console.log(`[ApiHandler] Normalized task type: "${type}" → "error_fix"`);
                return 'error_fix';
            }
            if (typeStr === 'implementation' || typeStr === 'impl' || typeStr === 'feature') {
                return 'implementation';
            }
            if (typeStr === 'error_fix') {
                return 'error_fix';
            }
            // Default to implementation if unknown
            console.log(`[ApiHandler] Unknown task type "${type}", defaulting to "implementation"`);
            return 'implementation';
        };
        
        switch (action) {
            case 'list': {
                // List all tasks, optionally filtered by session
                let allTasks = this.services.taskManager.getAllTasks();
                
                // If no tasks in memory, try reloading from disk (daemon may have started before tasks were created)
                if (allTasks.length === 0) {
                    console.log('[ApiHandler] No tasks in memory, attempting reload from disk...');
                    try {
                        // TaskManager exposes reloadPersistedTasks for this purpose
                        if (this.services.taskManager.reloadPersistedTasks) {
                            this.services.taskManager.reloadPersistedTasks();
                            allTasks = this.services.taskManager.getAllTasks();
                            console.log(`[ApiHandler] Reloaded ${allTasks.length} tasks from disk`);
                        }
                    } catch (e) {
                        console.warn('[ApiHandler] Failed to reload tasks:', e);
                    }
                }
                
                const tasks = sessionId 
                    ? allTasks.filter(t => t.sessionId === sessionId)
                    : allTasks;
                
                return {
                    data: tasks.map(t => ({
                        // Extract short ID by removing the sessionId_ prefix
                        // e.g., "ps_000001_T1" with sessionId "ps_000001" → "T1"
                        id: t.sessionId && t.id.startsWith(`${t.sessionId}_`) 
                            ? t.id.slice(t.sessionId.length + 1) 
                            : t.id,
                        globalId: t.id,
                        sessionId: t.sessionId,
                        description: t.description,
                        status: t.status,
                        type: t.taskType,
                        dependencies: t.dependencies,
                        dependents: t.dependents,
                        priority: t.priority
                    })),
                    message: `Found ${tasks.length} task(s)`
                };
            }
            
            case 'create': {
                if (!sessionId) {
                    throw new Error('Missing session parameter');
                }
                if (!taskId) {
                    throw new Error('Missing id parameter');
                }
                if (!params.desc && !params.description) {
                    throw new Error('Missing desc parameter');
                }
                
                const result = this.services.taskManager.createTaskFromCli({
                    sessionId,
                    taskId,
                    description: (params.desc || params.description) as string,
                    dependencies: params.deps ? String(params.deps).split(',').filter(d => d.trim()) : [],
                    taskType: normalizeTaskType(params.type),
                    priority: params.priority ? Number(params.priority) : 0,
                    errorText: params.errorText as string | undefined
                });
                
                if (!result.success) {
                    throw new Error(result.error || 'Failed to create task');
                }
                
                return { message: `Task ${taskId} created in session ${sessionId}` };
            }
            
            case 'start': {
                if (!sessionId) {
                    throw new Error('Missing session parameter');
                }
                if (!taskId) {
                    throw new Error('Missing id parameter');
                }
                
                const workflowType = (params.workflow || 'task_implementation') as string;
                
                // Get the task to verify it exists
                const globalTaskId = `${sessionId}_${taskId}`;
                const task = this.services.taskManager.getTask(globalTaskId);
                if (!task) {
                    throw new Error(`Task ${taskId} not found in session ${sessionId}`);
                }
                
                // Validate task format - if invalid, delete and fail
                // This triggers coordinator to recreate with correct format
                if (this.services.taskManager.validateTaskFormat) {
                    const validation = this.services.taskManager.validateTaskFormat(task);
                    if (!validation.valid) {
                        const reason = `Invalid task format: ${validation.reason}`;
                        this.services.taskManager.deleteTask?.(globalTaskId, reason);
                        throw new Error(`Task ${taskId} deleted due to invalid format (${validation.reason}). Coordinator will recreate.`);
                    }
                }
                
                // Validate task can be started
                if (task.status === 'blocked') {
                    throw new Error(`Task ${taskId} is blocked by unmet dependencies`);
                } else if (task.status === 'completed') {
                    throw new Error(`Task ${taskId} is already completed`);
                } else if (task.status === 'failed') {
                    throw new Error(`Task ${taskId} has failed. Cannot restart failed tasks.`);
                } else if (task.status === 'paused') {
                    throw new Error(`Task ${taskId} is paused. Resume the task first.`);
                } else if (task.status === 'in_progress') {
                    // Task is in_progress, check if it's actually running or orphaned
                    // For now, allow restart of in_progress tasks
                    console.log(`[ApiHandler] Task ${taskId} is in_progress, allowing restart`);
                }
                // If status is 'created' or was recovered from orphaned 'in_progress', proceed
                
                // Check dependencies
                const unmetDeps = task.dependencies.filter(depId => {
                    const depTask = this.services.taskManager!.getTask(depId) || 
                                   this.services.taskManager!.getTask(`${sessionId}_${depId}`);
                    return !depTask || depTask.status !== 'completed';
                });
                
                if (unmetDeps.length > 0) {
                    throw new Error(`Task ${taskId} has unmet dependencies: ${unmetDeps.join(', ')}`);
                }
                
                // Start workflow for this task via coordinator
                if (this.services.coordinator) {
                    await this.services.coordinator.startTaskWorkflow(sessionId, taskId, workflowType);
                    return { message: `Started ${workflowType} workflow for task ${taskId}` };
                } else {
                    throw new Error('Coordinator not available to start workflow');
                }
            }
            
            case 'complete': {
                if (!sessionId) {
                    throw new Error('Missing session parameter');
                }
                if (!taskId) {
                    throw new Error('Missing id parameter');
                }
                
                const globalTaskId = `${sessionId}_${taskId}`;
                this.services.taskManager.completeTask(globalTaskId, params.summary as string);
                
                return { message: `Task ${taskId} marked complete` };
            }
            
            case 'progress': {
                if (!sessionId) {
                    throw new Error('Missing session parameter');
                }
                return { data: this.taskProgress(sessionId) };
            }
            
            case 'status': {
                if (!sessionId) {
                    throw new Error('Missing session parameter');
                }
                if (!taskId) {
                    throw new Error('Missing task parameter');
                }
                return { data: this.taskStatus(sessionId, taskId) };
            }
            
            case 'fail': {
                if (!sessionId) {
                    throw new Error('Missing session parameter');
                }
                if (!taskId) {
                    throw new Error('Missing task parameter');
                }
                if (!params.reason) {
                    throw new Error('Missing reason parameter');
                }
                return this.taskFail(sessionId, taskId, params.reason as string);
            }
            
            case 'assignments': {
                // Get agent assignments for UI - optionally filtered by session
                if (!this.services.taskManager.getAgentAssignmentsForUI) {
                    return { data: [] };
                }
                
                const allAssignments = this.services.taskManager.getAgentAssignmentsForUI();
                const assignments = sessionId
                    ? allAssignments.filter(a => a.sessionId === sessionId)
                    : allAssignments;
                
                return { data: assignments };
            }
            
            default:
                throw new Error(`Unknown task action: ${action}`);
        }
    }
    
    private taskProgress(sessionId: string): {
        sessionId: string;
        progress: { completed: number; pending: number; inProgress: number; failed: number; ready: number; total: number };
        tasks: Array<{ id: string; description: string; status: string; stage?: string; dependencies: string[]; actualAgent?: string }>;
    } {
        const progress = this.services.taskManager!.getProgressForSession(sessionId);
        const tasks = this.services.taskManager!.getTasksForSession(sessionId);
        
        return {
            sessionId,
            progress,
            tasks: tasks.map(t => ({
                id: t.id.replace(`${sessionId}_`, ''),
                description: t.description,
                status: t.status,
                stage: t.stage,
                dependencies: t.dependencies,
                actualAgent: t.actualAgent
            }))
        };
    }
    
    private taskStatus(sessionId: string, taskId: string): {
        id: string;
        globalId: string;
        description: string;
        status: string;
        dependencies: string[];
        actualAgent?: string;
        filesModified?: string[];
        startedAt?: string;
        completedAt?: string;
        currentWorkflow?: string;
        workflowStatus?: string;
    } {
        const globalTaskId = `${sessionId}_${taskId}`;
        const task = this.services.taskManager!.getTask(globalTaskId);
        
        if (!task) {
            // Get all tasks for this session to help with debugging
            const sessionTasks = this.services.taskManager!.getTasksForSession(sessionId);
            const taskList = sessionTasks.length > 0 
                ? sessionTasks.map(t => t.id.replace(`${sessionId}_`, '')).join(', ')
                : '(no tasks)';
            
            throw new Error(
                `Task ${taskId} not found in session ${sessionId}. ` +
                `Available tasks for this session: ${taskList}`
            );
        }
        
        // Get current workflow status if task has one
        let workflowStatus: string | undefined;
        if (task.currentWorkflow) {
            const progress = this.services.coordinator.getWorkflowStatus(sessionId, task.currentWorkflow);
            workflowStatus = progress?.status;
        }
        
        return {
            id: taskId,
            globalId: globalTaskId,
            description: task.description,
            status: task.status,
            dependencies: task.dependencies,
            actualAgent: task.actualAgent,
            filesModified: task.filesModified,
            startedAt: task.startedAt,
            completedAt: task.completedAt,
            currentWorkflow: task.currentWorkflow,
            workflowStatus
        };
    }
    
    private taskFail(sessionId: string, taskId: string, reason: string): { data?: unknown; message?: string } {
        const globalTaskId = `${sessionId}_${taskId}`;
        this.services.taskManager!.markTaskFailed(globalTaskId, reason);
        
        return {
            data: { sessionId, taskId, reason },
            message: `Task ${taskId} marked as failed`
        };
    }
    
    // ========================================================================
    // Unity Handlers
    // ========================================================================
    
    private async handleUnity(action: string, params: Record<string, unknown>): Promise<{ data?: unknown; message?: string }> {
        // For status requests, return null gracefully when Unity manager isn't available
        if (!this.services.unityManager) {
            if (action === 'status') {
                return { data: null };
            }
            throw new Error('Unity manager not available - Unity features require Unity MCP connection');
        }
        
        switch (action) {
            case 'status': {
                return { data: this.unityStatus() };
            }
            
            case 'compile': {
                const compileTaskId = this.services.unityManager.queueTask('prep_editor', {
                    coordinatorId: params.coordinatorId as string,
                    agentName: params.agentName as string
                });
                return {
                    data: { taskId: compileTaskId, type: 'prep_editor' },
                    message: 'Unity compilation queued'
                };
            }
            
            case 'test': {
                const testType = params.mode === 'playmode' ? 'test_framework_playmode' : 'test_framework_editmode';
                const testTaskId = this.services.unityManager.queueTask(testType, {
                    coordinatorId: params.coordinatorId as string,
                    agentName: params.agentName as string
                }, {
                    testFilter: params.filter as string[] | undefined,
                    testScene: params.scene as string | undefined
                });
                return {
                    data: { taskId: testTaskId, type: testType },
                    message: `Unity ${params.mode} tests queued`
                };
            }
            
            default:
                throw new Error(`Unknown unity action: ${action}`);
        }
    }
    
    private unityStatus(): UnityStatusResponse {
        const state = this.services.unityManager!.getState();
        
        return {
            status: state.status,
            connected: state.status !== 'disconnected',
            isPlaying: state.isPlaying || false,
            isCompiling: state.isCompiling || false,
            hasErrors: state.hasErrors || false,
            errorCount: state.errorCount || 0,
            currentTask: state.currentTask ? {
                id: state.currentTask.id,
                type: state.currentTask.type,
                phase: state.currentTask.phase || 'unknown',
                requestedBy: state.currentTask.requestedBy
            } : undefined,
            queueLength: state.queueLength,
            lastActivity: state.lastActivity
        };
    }
    
    // ========================================================================
    // Role Handlers
    // ========================================================================
    
    private async handleRoles(action: string, params: Record<string, unknown>): Promise<{ data?: unknown; message?: string }> {
        if (!this.services.roleRegistry) {
            throw new Error('Role registry not available');
        }
        
        switch (action) {
            case 'list': {
                return { data: this.agentRoles() };
            }
            
            case 'get': {
                if (!params.roleId) {
                    throw new Error('Missing roleId parameter');
                }
                const role = this.services.roleRegistry.getRole(params.roleId as string);
                if (!role) {
                    throw new Error(`Role ${params.roleId} not found`);
                }
                return { data: role };
            }
            
            case 'update': {
                if (!params.roleId) {
                    throw new Error('Missing roleId parameter');
                }
                if (!params.updates) {
                    throw new Error('Missing updates parameter');
                }
                this.services.roleRegistry.updateRole(params.roleId as string, params.updates as Record<string, unknown>);
                const updatedRole = this.services.roleRegistry.getRole(params.roleId as string);
                return { 
                    data: updatedRole,
                    message: `Role ${params.roleId} updated`
                };
            }
            
            case 'reset': {
                if (!params.roleId) {
                    throw new Error('Missing roleId parameter');
                }
                const wasReset = this.services.roleRegistry.resetRoleToDefault(params.roleId as string);
                if (!wasReset) {
                    throw new Error(`Role ${params.roleId} is not a built-in role or not found`);
                }
                const resetRole = this.services.roleRegistry.getRole(params.roleId as string);
                return { 
                    data: resetRole,
                    message: `Role ${params.roleId} reset to default`
                };
            }
            
            default:
                throw new Error(`Unknown roles action: ${action}`);
        }
    }
    
    // ========================================================================
    // Coordinator Handler
    // ========================================================================
    
    private async handleCoordinator(action: string, params: Record<string, unknown>): Promise<{ data?: unknown; message?: string }> {
        switch (action) {
            case 'status': {
                // Get coordinator status for UI display
                const status = this.services.coordinator.getCoordinatorStatus?.();
                return { 
                    data: { 
                        status: status || { state: 'idle', pendingEvents: 0, evaluationCount: 0 }
                    }
                };
            }
            
            case 'evaluate': {
                const sessionId = params.sessionId as string;
                const reason = params.reason as string || 'manual_evaluation';
                
                if (!sessionId) {
                    throw new Error('Missing sessionId parameter');
                }
                
                // Verify session exists and is approved
                const session = this.services.stateManager.getPlanningSession(sessionId);
                if (!session) {
                    throw new Error(`Session ${sessionId} not found`);
                }
                if (session.status !== 'approved') {
                    return { message: `Session ${sessionId} is not in approved state (current: ${session.status})` };
                }
                
                // Trigger coordinator evaluation
                await this.services.coordinator.triggerCoordinatorEvaluation(
                    sessionId,
                    'manual_evaluation',
                    { type: 'manual_evaluation', reason }
                );
                
                return { message: `Coordinator evaluation triggered for ${sessionId}: ${reason}` };
            }
            
            case 'shutdown': {
                // Graceful shutdown - pause all workflows and release agents
                if (!this.services.coordinator.gracefulShutdown) {
                    throw new Error('Graceful shutdown not supported by coordinator');
                }
                
                const result = await this.services.coordinator.gracefulShutdown();
                return { 
                    data: { 
                        workflowsPaused: result.workflowsPaused,
                        agentsReleased: result.agentsReleased
                    },
                    message: `Graceful shutdown: ${result.workflowsPaused} workflows paused, ${result.agentsReleased} agents released`
                };
            }
            
            default:
                throw new Error(`Unknown coordinator action: ${action}`);
        }
    }
    
    // ========================================================================
    // Config Handler
    // ========================================================================
    
    private async handleConfig(action: string, params: Record<string, unknown>): Promise<{ data?: unknown; message?: string }> {
        const { ConfigLoader } = await import('./DaemonConfig');
        
        // Get config loader instance from state manager
        const stateManager = this.services.stateManager as any;
        const workspaceRoot = stateManager.getWorkspaceRoot?.() || stateManager.workspaceRoot;
        
        const configLoader = new ConfigLoader(workspaceRoot);
        
        switch (action) {
            case 'get': {
                const key = params.key as string | undefined;
                
                if (key) {
                    // Get specific key
                    const value = configLoader.get(key as any);
                    return { data: { config: value } };
                } else {
                    // Get all config
                    const config = configLoader.getConfig();
                    // Don't return workspaceRoot to clients
                    const { workspaceRoot: _, ...clientConfig } = config;
                    return { data: { config: clientConfig } };
                }
            }
            
            case 'set': {
                const key = params.key as string;
                const value = params.value;
                
                if (!key) {
                    throw new Error('Missing key parameter');
                }
                if (value === undefined) {
                    throw new Error('Missing value parameter');
                }
                
                configLoader.set(key as any, value as any);
                return { message: `Config ${key} updated to ${value}` };
            }
            
            case 'reset': {
                const key = params.key as string | undefined;
                
                if (key) {
                    configLoader.resetKey(key as any);
                    return { message: `Config ${key} reset to default` };
                } else {
                    configLoader.reset();
                    return { message: 'All config reset to defaults' };
                }
            }
            
            default:
                throw new Error(`Unknown config action: ${action}`);
        }
    }
    
    // ========================================================================
    // Folders Handler
    // ========================================================================
    
    private async handleFolders(action: string, params: Record<string, unknown>): Promise<{ data?: unknown; message?: string }> {
        const { getFolderStructureManager } = await import('../services/FolderStructureManager');
        
        // Get folder structure manager from state manager
        const stateManager = this.services.stateManager as any;
        const workingDir = stateManager.getWorkingDir?.();
        
        if (!workingDir) {
            throw new Error('Working directory not available from state manager');
        }
        
        const folderMgr = getFolderStructureManager(workingDir);
        
        switch (action) {
            case 'get': {
                const folder = params.folder as string | undefined;
                
                if (folder) {
                    // Get specific folder
                    const name = folderMgr.getFolder(folder as any);
                    return { data: { folders: name } };
                } else {
                    // Get all folders
                    const folders = folderMgr.getFolders();
                    return { data: { folders } };
                }
            }
            
            case 'set': {
                const folder = params.folder as string;
                const name = params.name as string;
                
                if (!folder || !name) {
                    throw new Error('Missing folder or name parameter');
                }
                
                const success = folderMgr.setFolder(folder as any, name);
                if (!success) {
                    throw new Error(`Failed to set folder ${folder} to ${name}`);
                }
                
                return { message: `Folder ${folder} set to ${name}` };
            }
            
            case 'reset': {
                const folder = params.folder as string | undefined;
                
                if (folder) {
                    folderMgr.resetFolder(folder as any);
                    return { message: `Folder ${folder} reset to default` };
                } else {
                    folderMgr.resetFolders();
                    return { message: 'All folders reset to defaults' };
                }
            }
            
            default:
                throw new Error(`Unknown folders action: ${action}`);
        }
    }
    
    // ========================================================================
    // Statistics
    // ========================================================================
    
    /**
     * Get API handler statistics
     */
    getStats(): { requestCount: number; uptime: number } {
        return {
            requestCount: this.requestCount,
            uptime: Date.now() - this.startTime
        };
    }
}

