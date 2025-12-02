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
}

/**
 * Minimal task manager interface for API handler
 */
export interface ITaskManagerApi {
    getProgressForSession(sessionId: string): { completed: number; pending: number; inProgress: number; failed: number; ready: number; total: number };
    getTasksForSession(sessionId: string): Array<{ id: string; description: string; status: string; stage?: string; dependencies: string[]; actualAgent?: string; filesModified?: string[]; startedAt?: string; completedAt?: string }>;
    getTask(globalTaskId: string): { id: string; description: string; status: string; stage?: string; dependencies: string[]; actualAgent?: string; filesModified?: string[]; startedAt?: string; completedAt?: string } | undefined;
    markTaskFailed(globalTaskId: string, reason?: string): void;
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
            activeWorkflows: Array.from(state.activeWorkflows.values()),
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
                    updatedAt: s.updatedAt
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
                    throw new Error(`Workflow ${params.workflowId} not found`);
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
        
        switch (action) {
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
                if (!params.task && !params.taskId) {
                    throw new Error('Missing task parameter');
                }
                return { data: this.taskStatus(sessionId, (params.task || params.taskId) as string) };
            }
            
            case 'fail': {
                if (!sessionId) {
                    throw new Error('Missing session parameter');
                }
                if (!params.task && !params.taskId) {
                    throw new Error('Missing task parameter');
                }
                if (!params.reason) {
                    throw new Error('Missing reason parameter');
                }
                return this.taskFail(sessionId, (params.task || params.taskId) as string, params.reason as string);
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
        stage?: string;
        dependencies: string[];
        actualAgent?: string;
        filesModified?: string[];
        startedAt?: string;
        completedAt?: string;
    } {
        const globalTaskId = `${sessionId}_${taskId}`;
        const task = this.services.taskManager!.getTask(globalTaskId);
        
        if (!task) {
            throw new Error(`Task ${taskId} not found in session ${sessionId}`);
        }
        
        return {
            id: taskId,
            globalId: globalTaskId,
            description: task.description,
            status: task.status,
            stage: task.stage,
            dependencies: task.dependencies,
            actualAgent: task.actualAgent,
            filesModified: task.filesModified,
            startedAt: task.startedAt,
            completedAt: task.completedAt
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

