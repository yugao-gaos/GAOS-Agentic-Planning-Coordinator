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
    WorkflowSummaryData,
    CompletedSessionListResponse,
    CompletedSessionInfo
} from '../client/Protocol';
import { EventBroadcaster } from './EventBroadcaster';
import { ServiceLocator } from '../services/ServiceLocator';
import { DependencyService, DependencyStatus } from '../services/DependencyService';
import { TaskIdValidator } from '../services/TaskIdValidator';
import { Logger } from '../utils/Logger';
import { ConfigLoader } from './DaemonConfig';

const log = Logger.create('Daemon', 'ApiHandler');

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
    processManager: IProcessManagerApi;
    unityManager?: IUnityApi;
    taskManager?: ITaskManagerApi;
    roleRegistry?: IRoleRegistryApi;
    /** Config loader for runtime config changes */
    configLoader?: ConfigLoader;
    /** Daemon instance for cache management and state control */
    daemon?: {
        clearInitializationCache(): void;
        setDependencyCheckComplete(): void;
    };
    /** Internal reference to ApcDaemon for Unity client management */
    _daemon?: {
        registerUnityClient(clientId: string, projectPath: string): { success: boolean; error?: string };
        isUnityClientConnected(): boolean;
        sendRequestToUnity(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<any>;
    };
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
    /** Execution state (for approved sessions with running/completed tasks) */
    execution?: {
        startedAt?: string;
        lastActivityAt?: string;
        progress?: {
            completed: number;
            total: number;
            percentage: number;
        };
    };
}

/**
 * Minimal state manager interface for API handler
 */
export interface IStateManagerApi {
    getAllPlanningSessions(): PlanningSessionData[];
    getPlanningSession(id: string): PlanningSessionData | undefined;
    deletePlanningSession(id: string): void;
    getSessionTasksFilePath(sessionId: string): string;
    getPlansDirectory(): string;
    getWorkspaceRoot(): string;
    getWorkingDir(): string;
    /** Get IDs of completed sessions from disk */
    getCompletedSessionIds(): string[];
    /** Load a session from disk without adding to memory (for completed sessions) */
    loadSessionFromDisk(sessionId: string): PlanningSessionData | undefined;
    /** Save a planning session to disk */
    savePlanningSession(session: PlanningSessionData): void;
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
 * Minimal process manager interface for API handler
 */
export interface IProcessManagerApi {
    killOrphanCursorAgents(): Promise<number>;
}

/**
 * Minimal agent pool interface for API handler
 */
export interface IAgentPoolApi {
    getPoolStatus(): { total: number; available: string[]; allocated: string[]; busy: string[] };
    getAvailableAgents(): string[];
    getAllocatedAgents(): Array<{ name: string; roleId: string; sessionId: string; workflowId: string }>;
    getBusyAgents(): Array<{ name: string; roleId?: string; workflowId: string; sessionId: string; task?: string }>;
    getRestingAgents(): string[];
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
    getAllRoles(): RoleData[];
    updateRole(roleId: string, updates: Record<string, unknown>): void;
    resetRoleToDefault(roleId: string): boolean;
    getAllSystemPrompts(): Array<{ toJSON(): Record<string, unknown> }>;
    getSystemPrompt(id: string): { toJSON(): Record<string, unknown> } | undefined;
    updateSystemPrompt(config: { id: string; toJSON(): Record<string, unknown> }): void;
    resetSystemPromptToDefault(promptId: string): { toJSON(): Record<string, unknown> } | undefined;
}

/**
 * Session state from coordinator
 */
export interface SessionState {
    // Note: Revision status is tracked via session.status === 'revising'
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
    cancelSession(sessionId: string): Promise<void>;
    startExecution(sessionId: string): Promise<string[]>;
    
    // Agent CLI callback support
    signalAgentCompletion(signal: AgentCompletionSignal): boolean;
    
    // Coordinator evaluation trigger
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    triggerCoordinatorEvaluation(sessionId: string, eventType: string, payload: any): Promise<any>;
    
    // Update workflow history summary
    updateWorkflowHistorySummary(sessionId: string, workflowId: string, summary: string): void;
    
    // Start a workflow for a specific task
    // Optional workflowInput allows passing additional params (e.g., targets for context_gathering)
    startTaskWorkflow(sessionId: string, rawTaskId: string, workflowType: string, workflowInput?: Record<string, any>): Promise<string>;
    
    // Get coordinator status for UI
    getCoordinatorStatus?(): CoordinatorStatusData;
    
    // Manual workflow cleanup
    forceCleanupStaleWorkflows(sessionId: string): number;
    forceCleanupAllStaleWorkflows(): number;
    
    // Workflow event response handling
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleWorkflowEventResponse(workflowId: string, eventType: string, payload: any): void;
    
    // Get the workflow registry (for accessing workflow metadata)
    getWorkflowRegistry?(): IWorkflowRegistryApi;
    
    // Graceful shutdown - cancel all workflows and release agents
    gracefulShutdown?(): Promise<{ workflowsCancelled: number; agentsReleased: number }>;
    
    // Manual session completion
    completeSession(sessionId: string): { success: boolean; error?: string };
    
    // Check if session is ready for manual completion
    isSessionReadyForCompletion(sessionId: string): boolean;
}

/**
 * Minimal task manager interface for API handler
 */
export interface ITaskManagerApi {
    getProgressForSession(sessionId: string): { completed: number; pending: number; inProgress: number; ready: number; total: number; percentage: number };
    getTasksForSession(sessionId: string): Array<{ id: string; sessionId: string; description: string; status: string; taskType: string; stage?: string; dependencies: string[]; dependents: string[]; priority: number; actualAgent?: string; filesModified?: string[]; startedAt?: string; completedAt?: string; errorText?: string; previousAttempts?: number; previousFixSummary?: string; activeWorkflow?: { id: string; type: string; status: string } }>;
    getTask(globalTaskId: string): { id: string; sessionId: string; description: string; status: string; taskType: string; stage?: string; dependencies: string[]; dependents: string[]; priority: number; actualAgent?: string; filesModified?: string[]; startedAt?: string; completedAt?: string; errorText?: string; previousAttempts?: number; previousFixSummary?: string; activeWorkflow?: { id: string; type: string; status: string } } | undefined;
    getAllTasks(): Array<{ id: string; sessionId: string; description: string; status: string; taskType: string; stage?: string; dependencies: string[]; dependents: string[]; priority: number; actualAgent?: string; filesModified?: string[]; startedAt?: string; completedAt?: string; errorText?: string; previousAttempts?: number; previousFixSummary?: string; activeWorkflow?: { id: string; type: string; status: string } }>;
    createTaskFromCli(params: { sessionId: string; taskId: string; description: string; dependencies?: string[]; taskType?: 'implementation' | 'error_fix'; priority?: number; errorText?: string; unityPipeline?: 'none' | 'prep' | 'prep_editmode' | 'prep_playmode' | 'prep_playtest' | 'full'; needsContext?: boolean }): { success: boolean; error?: string };
    completeTask(globalTaskId: string, summary?: string): void;
    updateTaskStage(globalTaskId: string, stage: string): void;
    // NOTE: markTaskFailed was removed - tasks should never be permanently abandoned
    /** Reload tasks from disk (for when daemon started before tasks were created) */
    reloadPersistedTasks?(): void;
    /** Delete a task (used when task has invalid format) */
    deleteTask?(globalTaskId: string, reason?: string): boolean;
    /** Validate task format, returns { valid: true } or { valid: false, reason: string } */
    validateTaskFormat?(task: any): { valid: true } | { valid: false; reason: string };
    /** Get agent assignments for UI display */
    getAgentAssignmentsForUI?(): Array<{ name: string; sessionId: string; roleId?: string; workflowId?: string; currentTaskId?: string; status: string; assignedAt: string; lastActivityAt?: string; logFile: string }>;
    /** Add a dependency to a task (supports cross-plan dependencies) */
    addDependency(rawTaskId: string, dependsOnId: string): { success: boolean; error?: string };
    /** Remove a dependency from a task */
    removeDependency(rawTaskId: string, depId: string): { success: boolean; error?: string };
    /** Update a task's description and/or dependencies */
    updateTaskFromCli(params: { sessionId: string; taskId: string; description?: string; dependencies?: string[] }): { success: boolean; error?: string };
    /** Remove a task entirely (cancels active workflows) */
    removeTaskFromCli(sessionId: string, taskId: string, reason?: string): { success: boolean; error?: string; cancelledWorkflows?: number };
    
    /** Add a question to a task (for user clarification) */
    addQuestionToTask(taskId: string, question: string): { success: boolean; questionId?: string; error?: string };
    /** Answer a pending question on a task */
    answerTaskQuestion(taskId: string, questionId: string, answer: string): { success: boolean; clarification?: { id: string; question: string; answer?: string; askedAt: string; answeredAt?: string }; error?: string };
    /** Get pending question for a task */
    getPendingQuestion(taskId: string): { id: string; question: string; answer?: string; askedAt: string; answeredAt?: string } | undefined;
}

/**
 * Minimal workflow registry interface for API handler
 */
export interface IWorkflowRegistryApi {
    getMetadata(type: string): { requiresCompleteDependencies?: boolean } | undefined;
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
    startPlanning(prompt: string, docs?: string[], complexity?: string): Promise<PlanningResult>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    revisePlan(id: string, feedback: string): Promise<any>;
    approvePlan(id: string, autoStart?: boolean): Promise<void>;
    cancelPlan(id: string): Promise<void>;
    restartPlanning(id: string): Promise<{ success: boolean; error?: string }>;
    removeSession(id: string): Promise<{ success: boolean; error?: string }>;
    addTaskToPlan(sessionId: string, taskSpec: {
        id: string;
        description: string;
        dependencies?: string[];
        engineer?: string;
        unityPipeline?: 'none' | 'prep' | 'prep_editmode' | 'prep_playmode' | 'prep_playtest' | 'full';
    }): Promise<{ success: boolean; taskId?: string; error?: string }>;
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
/**
 * Unity editor status from Unity Bridge events
 */
export interface UnityEditorStatus {
    isCompiling: boolean;
    isPlaying: boolean;
    isPaused: boolean;
    timestamp: number;
}

export interface IUnityApi {
    getState(): UnityState;
    getUnityStatus(): UnityEditorStatus | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queuePipeline(coordinatorId: string, operations: any[], tasksInvolved: any[], mergeEnabled: boolean): string;
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
     * Validate and normalize task ID to UPPERCASE global format.
     * STRICT: Only accepts global format PS_XXXXXX_TN - rejects simple IDs.
     * Uses TaskIdValidator as single source of truth for task ID validation.
     * 
     * @param rawTaskId - The raw task ID (must be global format)
     * @param session - The session ID for context (used in error messages)
     * @returns Normalized global task ID in UPPERCASE (e.g., "PS_000001_T1")
     * @throws Error if taskId is not in global format
     */
    private toGlobalTaskId(rawTaskId: string, session: string): string {
        if (!rawTaskId) return rawTaskId;
        
        const result = TaskIdValidator.validateGlobalTaskId(rawTaskId);
        if (!result.valid) {
            throw new Error(result.error!);
        }
        
        return result.normalizedId!;
    }
    
    /**
     * Check if critical dependencies are missing (blocks workflow/execution operations)
     * Returns error message if critical deps missing, undefined if OK
     * 
     * Critical dependencies:
     * - Python: Required for core APC functionality
     * - APC CLI: Required for command execution
     * - MCP for Unity: Required when Unity features are enabled (for Unity projects)
     */
    private checkCriticalDependencies(): string | undefined {
        try {
            const depService = ServiceLocator.resolve(DependencyService);
            const allDeps = depService.getCachedStatus();
            const platform = process.platform;
            const relevantDeps = allDeps.filter(d => d.platform === platform || d.platform === 'all');
            const missingDeps = relevantDeps.filter(d => d.required && !d.installed);
            
            // Check if Unity features are enabled - MCP for Unity becomes critical
            const unityEnabled = depService.isUnityEnabled();
            
            const criticalMissing = missingDeps.filter(d => {
                // Always critical: Python, APC CLI
                if (d.name.includes('Python') || d.name.includes('APC CLI')) {
                    return true;
                }
                // Critical when Unity enabled: MCP for Unity
                if (unityEnabled && (d.name === 'MCP for Unity' || d.name.includes('Unity MCP'))) {
                    return true;
                }
                return false;
            });
            
            if (criticalMissing.length > 0) {
                const names = criticalMissing.map(d => d.name).join(', ');
                return `Cannot start: Missing critical dependencies (${names}). Check System panel for installation instructions.`;
            }
            return undefined;
        } catch {
            // DependencyService not available, allow operation
            return undefined;
        }
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
        const parts = cmd.split('.');
        const category = parts[0];
        const action = parts.slice(1).join('.'); // Join remaining parts to support nested actions like "custom.create"
        
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
            
            case 'taskAgent':
                return this.handleTaskAgent(action, params);
            
            case 'unity':
                return this.handleUnity(action, params);
            
            case 'roles':
                return this.handleRoles(action, params);
            
            case 'coordinator':
                return this.handleCoordinator(action, params);
            
            case 'process':
                return this.handleProcess(action, params);
            
            case 'config':
                return this.handleConfig(action, params);
            
            case 'folders':
                return this.handleFolders(action, params);
            
            case 'deps':
                return this.handleDeps(action, params);
            
            case 'prompts':
                return this.handlePrompts(action, params);
            
            case 'system':
                return this.handleSystem(action, params);
            
            case 'user':
                return this.handleUser(action, params);
            
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
            
            case 'get': {
                const session = this.services.stateManager.getPlanningSession(params.id as string);
                return { data: { session } };
            }
            
            case 'state': {
                return { data: { state: this.sessionState(params.id as string) } };
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
            
            case 'listCompleted': {
                return { data: this.sessionListCompleted(params.limit as number | undefined) };
            }
            
            case 'reopen': {
                return this.sessionReopen(params.id as string);
            }
            
            case 'complete': {
                const result = this.services.coordinator.completeSession(params.id as string);
                if (!result.success) {
                    throw new Error(result.error || 'Failed to complete session');
                }
                return { message: `Session ${params.id} completed` };
            }
            
            case 'checkReadyForCompletion': {
                const isReady = this.services.coordinator.isSessionReadyForCompletion(params.id as string);
                return { data: { ready: isReady } };
            }
            
            default:
                throw new Error(`Unknown session action: ${action}`);
        }
    }
    
    private sessionState(id: string): { activeWorkflows: unknown[]; workflowHistory: unknown[] } | null {
        const state = this.services.coordinator.getSessionState(id);
        if (!state) {
            return null;
        }
        return {
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
            // Note: Check session.status === 'revising' instead of separate isRevising flag
            workflows: workflows,
            pendingWorkflows: state.pendingWorkflows?.length || 0,
            completedWorkflows: state.completedWorkflows?.length || 0
        };
    }
    
    /**
     * List completed sessions from disk (not in memory).
     * Returns most recent first, limited to specified count.
     */
    private sessionListCompleted(limit?: number): CompletedSessionListResponse {
        const completedIds = this.services.stateManager.getCompletedSessionIds();
        
        // Load session data for each ID
        const sessions: CompletedSessionInfo[] = [];
        for (const id of completedIds) {
            const session = this.services.stateManager.loadSessionFromDisk(id);
            if (session) {
                sessions.push({
                    id: session.id,
                    requirement: session.requirement.substring(0, 100) + (session.requirement.length > 100 ? '...' : ''),
                    completedAt: session.updatedAt,
                    createdAt: session.createdAt,
                    currentPlanPath: session.currentPlanPath,
                    taskProgress: session.execution?.progress
                });
            }
        }
        
        // Sort by completion date (most recent first)
        sessions.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());
        
        // Apply limit
        const limitedSessions = limit ? sessions.slice(0, limit) : sessions;
        
        return {
            sessions: limitedSessions,
            total: sessions.length
        };
    }
    
    /**
     * Reopen a completed session by setting its status back to 'reviewing'.
     * This allows users to continue working on a completed plan.
     */
    private sessionReopen(id: string): { data?: unknown; message?: string } {
        // Load session from disk (completed sessions aren't in memory)
        const session = this.services.stateManager.loadSessionFromDisk(id);
        if (!session) {
            throw new Error(`Session ${id} not found`);
        }
        
        if (session.status !== 'completed') {
            throw new Error(`Session ${id} is not completed (status: ${session.status})`);
        }
        
        // Change status to reviewing
        session.status = 'reviewing';
        session.updatedAt = new Date().toISOString();
        
        // Save to disk (this will also add it to the in-memory map)
        this.services.stateManager.savePlanningSession(session as PlanningSessionData);
        
        // Broadcast session reopened so UI refreshes
        this.broadcaster.broadcast('session.updated', { 
            sessionId: id, 
            status: 'reviewing',
            previousStatus: 'completed',
            changes: ['reopened'],
            updatedAt: session.updatedAt
        });
        
        return { 
            data: { sessionId: id, status: 'reviewing' },
            message: `Session ${id} reopened for review` 
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
                    params.docs as string[] | undefined,
                    params.complexity as string | undefined
                );
                // Broadcast session created so UI refreshes
                this.broadcaster.broadcast('session.created', { 
                    sessionId: result.sessionId, 
                    requirement: params.prompt as string,
                    complexity: params.complexity as string | undefined,
                    createdAt: new Date().toISOString()
                });
                return {
                    data: result,
                    message: `Planning session ${result.sessionId} created (complexity: ${params.complexity || 'auto'})`
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
            
            case 'add-task': {
                // Add a specific task to an existing plan
                // apc plan add-task --session ps_000001 --id T5 --desc "New task" --deps T3,T4
                const sessionId = (params.session || params.id) as string;
                if (!sessionId) {
                    throw new Error('Missing session parameter');
                }
                
                const taskId = params.task as string;
                if (!taskId) {
                    throw new Error('Missing task parameter (--task or --id)');
                }
                
                const description = (params.desc || params.description) as string;
                if (!description) {
                    throw new Error('Missing desc parameter');
                }
                
                // Parse dependencies (comma-separated)
                const depsStr = (params.deps || params.dependencies) as string;
                const dependencies = depsStr ? depsStr.split(',').map(d => d.trim()).filter(d => d) : [];
                
                // Parse optional parameters
                const engineer = params.engineer as string | undefined;
                const unityPipeline = params.unity as 'none' | 'prep' | 'prep_editmode' | 'prep_playmode' | 'prep_playtest' | 'full' | undefined;
                
                const result = await this.services.planningService.addTaskToPlan(sessionId, {
                    id: taskId,
                    description,
                    dependencies,
                    engineer,
                    unityPipeline
                });
                
                if (!result.success) {
                    throw new Error(result.error || 'Failed to add task to plan');
                }
                
                // Broadcast session update so UI refreshes
                this.broadcaster.broadcast('session.updated', { 
                    sessionId, 
                    status: 'updated',
                    changes: ['task_added'],
                    taskId: result.taskId,
                    updatedAt: new Date().toISOString()
                });
                
                return { 
                    data: { sessionId, taskId: result.taskId },
                    message: `Task ${result.taskId} added to plan` 
                };
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
                // Check for critical missing dependencies before starting execution
                const criticalDepError = this.checkCriticalDependencies();
                if (criticalDepError) {
                    throw new Error(criticalDepError);
                }
                
                const workflowIds = await this.services.coordinator.startExecution(sessionId);
                return {
                    data: { sessionId, workflowIds },
                    message: `Execution started with ${workflowIds.length} task workflows`
                };
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
            // Note: Check session status for 'revising' state
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
                // Check for critical missing dependencies before dispatching workflow
                const criticalDepError = this.checkCriticalDependencies();
                if (criticalDepError) {
                    throw new Error(criticalDepError);
                }
                
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
            
            case 'cleanup': {
                // Force cleanup of stale workflows for a session (or all sessions)
                // This is useful when workflows get stuck in running/blocked state
                // but their tasks are already completed
                const sessionId = params.sessionId as string | undefined;
                
                let cleanedCount = 0;
                if (sessionId) {
                    // Cleanup specific session
                    cleanedCount = this.services.coordinator.forceCleanupStaleWorkflows(sessionId);
                } else {
                    // Cleanup all sessions
                    cleanedCount = this.services.coordinator.forceCleanupAllStaleWorkflows();
                }
                
                return {
                    data: { cleanedCount, sessionId: sessionId || 'all' },
                    message: `Cleaned up ${cleanedCount} stale workflow(s)`
                };
            }
            
            case 'summarize': {
                this.services.coordinator.updateWorkflowHistorySummary(
                    params.sessionId as string,
                    params.workflowId as string,
                    params.summary as string
                );
                return { message: `Workflow summary updated for ${params.workflowId}` };
            }
            
            // Custom workflow management
            case 'custom.list': {
                try {
                    const { ScriptableWorkflowRegistry } = await import('../services/workflows/ScriptableWorkflowRegistry');
                    const scriptableRegistry = ServiceLocator.resolve(ScriptableWorkflowRegistry);
                    const workflows = scriptableRegistry.getAllWorkflowInfo().map(info => ({
                        type: info.workflowType,
                        name: info.graph.name,
                        version: info.graph.version,
                        description: info.graph.description || '',
                        parameters: info.graph.parameters || [],
                        variables: info.graph.variables || [],
                        nodeCount: info.graph.nodes?.length || 0,
                        filePath: info.filePath,
                        requiresUnity: info.graph.nodes?.some(n => 
                            n.type === 'event' && n.config?.event_type?.includes('unity')
                        ) || false,
                        isValid: info.isValid,
                        validationError: info.validationError
                    }));
                    return { data: workflows };
                } catch (e: any) {
                    log.warn('ScriptableWorkflowRegistry not available:', e.message);
                    return { data: [] };
                }
            }
            
            case 'custom.create': {
                try {
                    log.info('workflow.custom.create received, params:', params);
                    const { ScriptableWorkflowRegistry } = await import('../services/workflows/ScriptableWorkflowRegistry');
                    const scriptableRegistry = ServiceLocator.resolve(ScriptableWorkflowRegistry);
                    log.info('ScriptableWorkflowRegistry resolved');
                    
                    const name = params.name as string;
                    if (!name) {
                        throw new Error('Workflow name is required');
                    }
                    
                    // Check if file already exists
                    const existingPath = scriptableRegistry.workflowFileExists(name);
                    if (existingPath && !params.overwrite) {
                        // Return exists flag so UI can prompt for confirmation
                        return {
                            data: { exists: true, filePath: existingPath, name },
                            message: `Workflow "${name}" already exists`
                        };
                    }
                    
                    log.info(`Creating workflow template: ${name}`);
                    
                    const filePath = await scriptableRegistry.createWorkflowTemplate(name);
                    log.info(`Workflow template created: ${filePath}`);
                    
                    return { 
                        data: { filePath, name, created: true },
                        message: `Custom workflow "${name}" created` 
                    };
                } catch (e: any) {
                    log.error('Failed to create custom workflow:', e);
                    throw new Error(`Failed to create custom workflow: ${e.message}`);
                }
            }
            
            case 'custom.delete': {
                try {
                    const { ScriptableWorkflowRegistry } = await import('../services/workflows/ScriptableWorkflowRegistry');
                    const scriptableRegistry = ServiceLocator.resolve(ScriptableWorkflowRegistry);
                    const workflowType = params.type as string;
                    if (!workflowType) {
                        throw new Error('Workflow type is required');
                    }
                    const info = scriptableRegistry.getWorkflowInfo(workflowType);
                    if (!info) {
                        throw new Error(`Workflow "${workflowType}" not found`);
                    }
                    // Delete the file - the watcher will unregister it
                    const fs = await import('fs');
                    await fs.promises.unlink(info.filePath);
                    return { message: `Custom workflow "${workflowType}" deleted` };
                } catch (e: any) {
                    throw new Error(`Failed to delete custom workflow: ${e.message}`);
                }
            }
            
            case 'event.response': {
                // Handle workflow event response from client
                const workflowId = params.workflowId as string;
                const eventType = params.eventType as string;
                const payload = params.payload as any;
                
                if (!workflowId || !eventType) {
                    throw new Error('workflowId and eventType are required');
                }
                
                this.services.coordinator.handleWorkflowEventResponse(workflowId, eventType, payload);
                return { message: `Event response processed for workflow ${workflowId}` };
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
                if (!agentPoolService.getAgentsOnBench) {
                    throw new Error('getAgentsOnBench method not available in AgentPoolService');
                }
                const agents = agentPoolService.getAgentsOnBench(sessionId);
                return { data: { agents } };
            }
            
            default:
                throw new Error(`Unknown pool action: ${action}`);
        }
    }
    
    private poolStatus(): PoolStatusResponse {
        const status = this.services.agentPoolService.getPoolStatus();
        const allocated = this.services.agentPoolService.getAllocatedAgents();
        const busy = this.services.agentPoolService.getBusyAgents();
        const resting = this.services.agentPoolService.getRestingAgents();
        
        return {
            total: status.total,
            available: status.available,
            allocated: allocated,
            busy: busy,
            resting: resting
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
        
        // Build signal (include rawTaskId if provided for parallel task support)
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
        const allocated = this.services.agentPoolService.getAllocatedAgents();
        const busy = this.services.agentPoolService.getBusyAgents();
        const resting = this.services.agentPoolService.getRestingAgents();
        
        return {
            availableCount: available.length,
            available,
            allocatedCount: allocated.length,
            allocated: allocated.map(a => ({
                name: a.name,
                roleId: a.roleId,
                workflowId: a.workflowId
            })),
            busyCount: busy.length,
            busy: busy.map(b => ({
                name: b.name,
                roleId: b.roleId,
                workflowId: b.workflowId,
                task: b.task
            })),
            restingCount: resting.length,
            resting: resting
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
        const rawTaskId = (params.task || params.rawTaskId || params.id) as string;
        
        // Helper to get global task ID - delegates to class method for consistent normalization
        const toGlobalTaskId = (rawTaskId: string, session: string): string => {
            return this.toGlobalTaskId(rawTaskId, session);
        };
        
        // Helper to validate and normalize task type
        const normalizeTaskType = (type: unknown): 'implementation' | 'error_fix' => {
            const typeStr = String(type || 'implementation').toLowerCase();
            // Map common mistakes to valid types
            if (typeStr === 'bugfix' || typeStr === 'bug_fix' || typeStr === 'fix') {
                log.debug(`Normalized task type: "${type}" → "error_fix"`);
                return 'error_fix';
            }
            if (typeStr === 'implementation' || typeStr === 'impl' || typeStr === 'feature') {
                return 'implementation';
            }
            if (typeStr === 'error_fix') {
                return 'error_fix';
            }
            // Default to implementation if unknown
            log.debug(`Unknown task type "${type}", defaulting to "implementation"`);
            return 'implementation';
        };
        
        switch (action) {
            case 'list': {
                // List all tasks, optionally filtered by session
                let allTasks = this.services.taskManager.getAllTasks();
                
                // If no tasks in memory, try reloading from disk (daemon may have started before tasks were created)
                if (allTasks.length === 0) {
                    log.debug('No tasks in memory, attempting reload from disk...');
                    try {
                        // TaskManager exposes reloadPersistedTasks for this purpose
                        if (this.services.taskManager.reloadPersistedTasks) {
                            this.services.taskManager.reloadPersistedTasks();
                            allTasks = this.services.taskManager.getAllTasks();
                            log.debug(`Reloaded ${allTasks.length} tasks from disk`);
                        }
                    } catch (e) {
                        log.warn('Failed to reload tasks:', e);
                    }
                }
                
                const tasks = sessionId 
                    ? allTasks.filter(t => t.sessionId.toUpperCase() === sessionId.toUpperCase())
                    : allTasks;
                
                return {
                    data: tasks.map(t => ({
                        // Always use global ID - no simple ID extraction
                        id: t.id,
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
            
            case 'getFilePath': {
                // Get the tasks.json file path for a session
                // This is used by the dependency map to read tasks directly from disk
                // (bypassing TaskManager which may have removed completed tasks from memory)
                if (!sessionId) {
                    throw new Error('Missing session parameter');
                }
                
                const tasksFilePath = this.services.stateManager.getSessionTasksFilePath(sessionId);
                
                return {
                    data: {
                        sessionId,
                        filePath: tasksFilePath,
                        exists: require('fs').existsSync(tasksFilePath)
                    },
                    message: `Tasks file path: ${tasksFilePath}`
                };
            }
            
            case 'listAllFilePaths': {
                // Get all tasks.json file paths from all sessions (including completed ones)
                // This is used by the dependency map global view to read tasks directly from disk
                // (daemon memory may not have all tasks, especially completed ones)
                const fs = require('fs');
                const path = require('path');
                
                const filePaths: Array<{ sessionId: string; filePath: string; exists: boolean }> = [];
                
                // Get plans directory path
                const plansDir = this.services.stateManager.getPlansDirectory();
                log.debug(`[task.listAllFilePaths] Plans directory: ${plansDir}`);
                log.debug(`[task.listAllFilePaths] Plans directory exists: ${fs.existsSync(plansDir)}`);
                
                if (fs.existsSync(plansDir)) {
                    // Scan all session folders
                    const sessionFolders = fs.readdirSync(plansDir, { withFileTypes: true })
                        .filter((d: any) => d.isDirectory())
                        .map((d: any) => d.name);
                    
                    log.debug(`[task.listAllFilePaths] Found ${sessionFolders.length} session folders: ${sessionFolders.join(', ')}`);
                    
                    for (const sessionId of sessionFolders) {
                        const filePath = this.services.stateManager.getSessionTasksFilePath(sessionId);
                        const exists = fs.existsSync(filePath);
                        log.debug(`[task.listAllFilePaths] Session ${sessionId}: ${filePath} exists=${exists}`);
                        // Only include sessions that have tasks.json files
                        if (exists) {
                            filePaths.push({ sessionId, filePath, exists });
                        }
                    }
                } else {
                    log.warn(`[task.listAllFilePaths] Plans directory does not exist: ${plansDir}`);
                }
                
                return {
                    data: filePaths,
                    message: `Found ${filePaths.length} session(s) with task files`
                };
            }
            
            case 'create': {
                if (!sessionId) {
                    throw new Error('Missing session parameter');
                }
                if (!rawTaskId) {
                    throw new Error('Missing id parameter');
                }
                if (!params.desc && !params.description) {
                    throw new Error('Missing desc parameter');
                }
                
                // Validate unity pipeline config if provided
                const validUnityConfigs = ['none', 'prep', 'prep_editmode', 'prep_playmode', 'prep_playtest', 'full'];
                const unityPipeline = params.unity as string | undefined;
                if (unityPipeline && !validUnityConfigs.includes(unityPipeline)) {
                    throw new Error(`Invalid unity pipeline config "${unityPipeline}". Valid values: ${validUnityConfigs.join(', ')}`);
                }
                
                // Get --needs-context parameter (for tasks that need context gathering before implementation)
                const needsContext = params['needs-context'] === 'true' || params['needs-context'] === true || params.needsContext === true;
                
                const result = this.services.taskManager.createTaskFromCli({
                    sessionId,
                    taskId: rawTaskId,
                    description: (params.desc || params.description) as string,
                    dependencies: params.deps ? String(params.deps).split(',').filter(d => d.trim()) : [],
                    taskType: normalizeTaskType(params.type),
                    priority: params.priority ? Number(params.priority) : 0,
                    errorText: params.errorText as string | undefined,
                    unityPipeline: unityPipeline as 'none' | 'prep' | 'prep_editmode' | 'prep_playmode' | 'prep_playtest' | 'full' | undefined,
                    needsContext
                });
                
                if (!result.success) {
                    throw new Error(result.error || 'Failed to create task');
                }
                
                const contextMsg = needsContext ? ' (needs context gathering)' : '';
                return { message: `Task ${rawTaskId} created in session ${sessionId}${contextMsg}` };
            }
            
            case 'start': {
                if (!sessionId) {
                    throw new Error('Missing session parameter');
                }
                if (!rawTaskId) {
                    throw new Error('Missing id parameter');
                }
                
                // Check for critical missing dependencies before starting workflow
                const criticalDepError = this.checkCriticalDependencies();
                if (criticalDepError) {
                    throw new Error(criticalDepError);
                }
                
                const workflowType = (params.workflow || 'task_implementation') as string;
                
                // Get the task to verify it exists
                const globalTaskId = toGlobalTaskId(rawTaskId, sessionId);
                const task = this.services.taskManager.getTask(globalTaskId);
                if (!task) {
                    throw new Error(`Task ${rawTaskId} not found in session ${sessionId}`);
                }
                
                // Validate task format - if invalid, delete and fail
                // This triggers coordinator to recreate with correct format
                if (this.services.taskManager.validateTaskFormat) {
                    const validation = this.services.taskManager.validateTaskFormat(task);
                    if (!validation.valid) {
                        const reason = `Invalid task format: ${validation.reason}`;
                        this.services.taskManager.deleteTask?.(globalTaskId, reason);
                        throw new Error(`Task ${rawTaskId} deleted due to invalid format (${validation.reason}). Coordinator will recreate.`);
                    }
                }
                
                // Validate task can be started
                if (task.status === 'blocked') {
                    // Don't trust cached blocked status - verify dependencies are actually unmet
                    // The blocking status might be stale if dependencies completed recently
                    const actuallyUnmetDeps = task.dependencies.filter(depId => {
                        const depTask = this.services.taskManager!.getTask(depId);
                        return !depTask || depTask.status !== 'completed';
                    });
                    
                    if (actuallyUnmetDeps.length > 0) {
                        // Dependencies are truly unmet
                        throw new Error(`Task ${rawTaskId} is blocked by unmet dependencies: ${actuallyUnmetDeps.join(', ')}`);
                    } else {
                        // All dependencies are complete - update task status and continue
                        // Status will be persisted when workflow starts (changes to in_progress)
                        log.info(`Task ${rawTaskId} was marked blocked but all dependencies are complete - allowing start`);
                        task.status = 'created';
                    }
                } else if (task.status === 'succeeded') {
                    throw new Error(`Task ${rawTaskId} is already succeeded`);
                }
                // NOTE: No 'failed' check - tasks can always be retried from awaiting_decision
                
                // CRITICAL: Check for active workflow in coordinator's in-memory state
                // This prevents duplicate workflows (race condition)
                if (this.services.coordinator) {
                    const sessionState = this.services.coordinator.getSessionState(sessionId);
                    if (sessionState?.activeWorkflows) {
                        for (const [wfId, wfProgress] of sessionState.activeWorkflows) {
                            // Check if this workflow is for this task
                            const workflowSummaries = this.services.coordinator.getWorkflowSummaries(sessionId);
                            const wfSummary = workflowSummaries.find(s => s.id === wfId);
                            if (wfSummary?.taskId?.toUpperCase() === task.id.toUpperCase()) {
                                const status = wfProgress.status;
                                if (status === 'running' || status === 'pending' || status === 'blocked') {
                                    throw new Error(
                                        `Task ${rawTaskId} already has an active workflow (${wfId.substring(0, 8)}..., status: ${status}). ` +
                                        `Wait for it to complete before starting a new one. ` +
                                        `Use 'apc task status --session ${sessionId} --task ${rawTaskId}' to check status.`
                                    );
                                }
                            }
                        }
                    }
                }
                
                // Check dependencies - but only if the workflow requires it
                // Some workflows (like context_gathering) can start even with incomplete dependencies
                const workflowRegistry = this.services.coordinator?.getWorkflowRegistry?.();
                const workflowMetadata = workflowRegistry?.getMetadata(workflowType);
                
                if (workflowMetadata?.requiresCompleteDependencies !== false) {
                    // This workflow requires all dependencies to be complete
                    // Dependencies are stored as global IDs (e.g., "ps_000001_T1")
                    const unmetDeps = task.dependencies.filter(depId => {
                        const depTask = this.services.taskManager!.getTask(depId);
                        return !depTask || depTask.status !== 'completed';
                    });
                    
                    if (unmetDeps.length > 0) {
                        throw new Error(`Task ${globalTaskId} has unmet dependencies: ${unmetDeps.join(', ')}. The workflow '${workflowType}' requires all dependencies to be completed first.`);
                    }
                } else {
                    // This workflow can proceed with incomplete dependencies
                    log.debug(`Workflow '${workflowType}' does not require complete dependencies - allowing start`);
                }
                
                // Start workflow for this task via coordinator
                if (this.services.coordinator) {
                    // Pass optional input (used for context_gathering workflows)
                    const workflowInput = params.input as Record<string, any> | undefined;
                    await this.services.coordinator.startTaskWorkflow(sessionId, rawTaskId, workflowType, workflowInput);
                    return { message: `Started ${workflowType} workflow for task ${rawTaskId}` };
                } else {
                    throw new Error('Coordinator not available to start workflow');
                }
            }
            
            case 'complete': {
                if (!sessionId) {
                    throw new Error('Missing session parameter');
                }
                if (!rawTaskId) {
                    throw new Error('Missing id parameter');
                }
                
                const globalTaskId = toGlobalTaskId(rawTaskId, sessionId);
                this.services.taskManager.completeTask(globalTaskId, params.summary as string);
                
                return { message: `Task ${rawTaskId} marked complete` };
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
                if (!rawTaskId) {
                    throw new Error('Missing task parameter');
                }
                return { data: this.taskStatus(sessionId, rawTaskId) };
            }
            
            // NOTE: 'fail' case was removed - tasks should never be permanently abandoned
            // Tasks stay in 'awaiting_decision' until coordinator retries or user intervenes
            
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
            
            case 'addDep':
            case 'add-dep': {
                // Add a dependency to a task (supports cross-plan dependencies)
                // apc task add-dep --session ps_000001 --task T3 --depends-on ps_000002_T5
                if (!sessionId) {
                    throw new Error('Missing session parameter');
                }
                if (!rawTaskId) {
                    throw new Error('Missing task parameter');
                }
                
                const dependsOn = params['depends-on'] || params.dependsOn;
                if (!dependsOn) {
                    throw new Error('Missing depends-on parameter');
                }
                
                const globalTaskId = toGlobalTaskId(rawTaskId, sessionId);
                const dependsOnId = String(dependsOn);
                
                const result = this.services.taskManager.addDependency(globalTaskId, dependsOnId);
                if (!result.success) {
                    throw new Error(result.error || 'Failed to add dependency');
                }
                
                return { message: `Added dependency: ${rawTaskId} → ${dependsOnId}` };
            }
            
            case 'remove-dep': {
                // Remove a dependency from a task
                // apc task remove-dep --session ps_000001 --task T3 --dep ps_000002_T5
                if (!sessionId) {
                    throw new Error('Missing session parameter');
                }
                if (!rawTaskId) {
                    throw new Error('Missing task parameter');
                }
                
                const depToRemove = params.dep;
                if (!depToRemove) {
                    throw new Error('Missing dep parameter');
                }
                
                const globalTaskId = toGlobalTaskId(rawTaskId, sessionId);
                const depId = String(depToRemove);
                
                const result = this.services.taskManager.removeDependency(globalTaskId, depId);
                if (!result.success) {
                    throw new Error(result.error || 'Failed to remove dependency');
                }
                
                return { message: `Removed dependency: ${rawTaskId} → ${depId}` };
            }
            
            case 'update': {
                // Update a task's description and/or dependencies
                // apc task update --session ps_000001 --id T3 [--desc "new desc"] [--deps T1,T2]
                if (!sessionId) {
                    throw new Error('Missing session parameter');
                }
                if (!rawTaskId) {
                    throw new Error('Missing id parameter');
                }
                
                const globalTaskId = toGlobalTaskId(rawTaskId, sessionId);
                
                // Parse dependencies if provided
                let dependencies: string[] | undefined;
                if (params.deps) {
                    const depsRaw = String(params.deps);
                    dependencies = depsRaw.split(',').map(d => d.trim().toUpperCase()).filter(Boolean);
                }
                
                const result = this.services.taskManager.updateTaskFromCli({
                    sessionId,
                    taskId: globalTaskId,
                    description: params.desc as string | undefined,
                    dependencies
                });
                
                if (!result.success) {
                    throw new Error(result.error || 'Failed to update task');
                }
                
                return { message: `Task ${rawTaskId} updated` };
            }
            
            case 'remove': {
                // Remove a task entirely
                // apc task remove --session ps_000001 --id T3 [--reason "why removed"]
                if (!sessionId) {
                    throw new Error('Missing session parameter');
                }
                if (!rawTaskId) {
                    throw new Error('Missing id parameter');
                }
                
                const globalTaskId = toGlobalTaskId(rawTaskId, sessionId);
                const reason = params.reason as string | undefined;
                
                const result = this.services.taskManager.removeTaskFromCli(sessionId, globalTaskId, reason);
                
                if (!result.success) {
                    throw new Error(result.error || 'Failed to remove task');
                }
                
                const msg = result.cancelledWorkflows && result.cancelledWorkflows > 0
                    ? `Task ${rawTaskId} removed (cancelled ${result.cancelledWorkflows} workflow(s))`
                    : `Task ${rawTaskId} removed`;
                
                return { message: msg };
            }
            
            default:
                throw new Error(`Unknown task action: ${action}`);
        }
    }
    
    private taskProgress(sessionId: string): {
        sessionId: string;
        progress: { completed: number; pending: number; inProgress: number; ready: number; total: number; percentage: number };
        tasks: Array<{ id: string; description: string; status: string; stage?: string; dependencies: string[]; actualAgent?: string }>;
    } {
        const progress = this.services.taskManager!.getProgressForSession(sessionId);
        const tasks = this.services.taskManager!.getTasksForSession(sessionId);
        
        return {
            sessionId,
            progress,
            tasks: tasks.map(t => ({
                // Always use global ID - no simple ID fallback
                id: t.id,
                description: t.description,
                status: t.status,
                stage: t.stage,
                dependencies: t.dependencies,
                actualAgent: t.actualAgent
            }))
        };
    }
    
    private taskStatus(sessionId: string, rawTaskId: string): {
        id: string;
        globalId: string;
        description: string;
        status: string;
        dependencies: string[];
        actualAgent?: string;
        filesModified?: string[];
        startedAt?: string;
        completedAt?: string;
        activeWorkflowId?: string;
        workflowStatus?: string;
    } {
        // Use class method for consistent task ID normalization (UPPERCASE)
        const globalTaskId = this.toGlobalTaskId(rawTaskId, sessionId);
        const task = this.services.taskManager!.getTask(globalTaskId);
        
        if (!task) {
            // Get all tasks for this session to help with debugging
            const sessionTasks = this.services.taskManager!.getTasksForSession(sessionId);
            const taskList = sessionTasks.length > 0 
                // Always use global IDs - no simple ID fallback
                ? sessionTasks.map(t => t.id).join(', ')
                : '(no tasks)';
            
            throw new Error(
                `Task ${rawTaskId} not found in session ${sessionId}. ` +
                `Available tasks for this session: ${taskList}`
            );
        }
        
        // Get current workflow status if task has one
        let workflowStatus: string | undefined;
        if (task.activeWorkflow) {
            const progress = this.services.coordinator.getWorkflowStatus(sessionId, task.activeWorkflow.id);
            workflowStatus = progress?.status;
        }
        
        return {
            id: rawTaskId,
            globalId: globalTaskId,
            description: task.description,
            status: task.status,
            dependencies: task.dependencies,
            actualAgent: task.actualAgent,
            filesModified: task.filesModified,
            startedAt: task.startedAt,
            completedAt: task.completedAt,
            activeWorkflowId: task.activeWorkflow?.id,
            workflowStatus
        };
    }
    
    // NOTE: taskFail() was removed - tasks should never be permanently abandoned
    
    // ========================================================================
    // TaskAgent Handlers
    // ========================================================================
    
    private async handleTaskAgent(action: string, params: Record<string, unknown>): Promise<{ data?: unknown; message?: string }> {
        const sessionId = (params.session || params.sessionId) as string;
        
        switch (action) {
            case 'evaluate': {
                // Trigger TaskAgent to evaluate and sync tasks for a session
                if (!sessionId) {
                    throw new Error('Missing session parameter');
                }
                
                const reason = params.reason as string | undefined;
                log.info(`TaskAgent evaluate requested for session ${sessionId}${reason ? `: ${reason}` : ''}`);
                
                // Get or create TaskAgent instance
                const { TaskAgent } = await import('../services/TaskAgent');
                let taskAgent: InstanceType<typeof TaskAgent>;
                
                try {
                    taskAgent = ServiceLocator.resolve(TaskAgent);
                } catch {
                    // TaskAgent not registered - create a temporary instance
                    const { AgentRoleRegistry } = await import('../services/AgentRoleRegistry');
                    let roleRegistry: InstanceType<typeof AgentRoleRegistry> | undefined;
                    try {
                        roleRegistry = ServiceLocator.resolve(AgentRoleRegistry);
                    } catch {
                        // Registry not available
                    }
                    taskAgent = new TaskAgent({}, roleRegistry);
                    
                    // Set workspace root from state manager
                    const workspaceRoot = this.services.stateManager.getWorkspaceRoot();
                    taskAgent.setWorkspaceRoot(workspaceRoot);
                }
                
                // Run verification asynchronously (don't block the API call)
                // The caller can poll status to check progress
                taskAgent.verifyTasks(sessionId).then(result => {
                    log.info(`TaskAgent verification complete for ${sessionId}: ${result.status}`);
                }).catch(err => {
                    log.error(`TaskAgent verification failed for ${sessionId}: ${err}`);
                });
                
                return { 
                    message: `TaskAgent evaluation triggered for session ${sessionId}${reason ? ` (${reason})` : ''}` 
                };
            }
            
            case 'status': {
                // Get TaskAgent status for a session
                if (!sessionId) {
                    throw new Error('Missing session parameter');
                }
                
                const session = this.services.stateManager.getPlanningSession(sessionId);
                
                // Try to get TaskAgent status if available
                let taskAgentStatus: { state: string; evaluationCount: number; lastEvaluation?: string } | null = null;
                try {
                    const { TaskAgent } = await import('../services/TaskAgent');
                    const taskAgent = ServiceLocator.resolve(TaskAgent);
                    const status = taskAgent.getStatus();
                    if (status.sessionId === sessionId) {
                        taskAgentStatus = {
                            state: status.state,
                            evaluationCount: status.evaluationCount,
                            lastEvaluation: status.lastEvaluation
                        };
                    }
                } catch {
                    // TaskAgent not registered
                }
                
                return {
                    data: {
                        sessionId,
                        sessionStatus: session?.status,
                        taskAgentState: taskAgentStatus?.state || (session?.status === 'verifying' ? 'verifying' : 'idle'),
                        evaluationCount: taskAgentStatus?.evaluationCount || 0,
                        lastEvaluationAt: taskAgentStatus?.lastEvaluation || null
                    }
                };
            }
            
            default:
                throw new Error(`Unknown taskAgent action: ${action}`);
        }
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
                // Route through pipeline system for consistency
                const pipelineId = this.services.unityManager.queuePipeline(
                    params.coordinatorId as string || 'manual',
                    ['prep'],
                    [],
                    true
                );
                return {
                    data: { pipelineId, type: 'prep' },
                    message: 'Unity compilation queued'
                };
            }
            
            case 'test': {
                // Route through pipeline system: prep + test
                const testOp = params.mode === 'playmode' ? 'test_playmode' : 'test_editmode';
                const pipelineId = this.services.unityManager.queuePipeline(
                    params.coordinatorId as string || 'manual',
                    ['prep', testOp],
                    [],
                    true
                );
                return {
                    data: { pipelineId, type: testOp },
                    message: `Unity ${params.mode} tests queued`
                };
            }
            
            case 'pipeline': {
                // Queue a pipeline with specified operations
                const operations = params.operations as string[];
                if (!operations || !Array.isArray(operations) || operations.length === 0) {
                    throw new Error('Pipeline requires at least one operation');
                }
                
                const validOps = ['prep', 'test_editmode', 'test_playmode', 'test_player_playmode'];
                for (const op of operations) {
                    if (!validOps.includes(op)) {
                        throw new Error(`Invalid pipeline operation: ${op}`);
                    }
                }
                
                const pipelineId = this.services.unityManager.queuePipeline(
                    params.coordinatorId as string || 'manual-gui',
                    operations as any,
                    [], // No specific tasks - manual trigger
                    params.mergeEnabled !== false // Default to true
                );
                
                return {
                    data: { pipelineId },
                    message: `Unity pipeline queued: ${operations.join(' → ')}`
                };
            }
            
            case 'playerTestStart': {
                // User clicked "Start Testing" in popup - signal to begin playtest
                const pipelineId = params.pipelineId as string;
                if (!pipelineId) {
                    throw new Error('pipelineId required for playerTestStart');
                }
                (this.services.unityManager as any).handlePlayerTestStart?.(pipelineId);
                return { message: 'Player test started' };
            }
            
            case 'playerTestFinish': {
                // User clicked "Finished Testing" in popup - signal to stop playtest
                const pipelineId = params.pipelineId as string;
                if (!pipelineId) {
                    throw new Error('pipelineId required for playerTestFinish');
                }
                (this.services.unityManager as any).handlePlayerTestFinish?.(pipelineId);
                return { message: 'Player test finished' };
            }
            
            case 'playerTestCancel': {
                // User cancelled player test popup
                const pipelineId = params.pipelineId as string;
                if (!pipelineId) {
                    throw new Error('pipelineId required for playerTestCancel');
                }
                (this.services.unityManager as any).handlePlayerTestCancel?.(pipelineId);
                return { message: 'Player test cancelled' };
            }
            
            // Unity client registration (from Unity package)
            case 'register': {
                return this.handleUnityRegister(params);
            }
            
            // Direct Unity commands (routed to Unity package via WebSocket)
            case 'direct.getState':
            case 'direct.enterPlayMode':
            case 'direct.exitPlayMode':
            case 'direct.loadScene':
            case 'direct.createScene':
            case 'direct.runTests':
            case 'direct.compile':
            case 'direct.focusEditor': {
                return await this.handleUnityDirect(action, params);
            }
            
            default:
                throw new Error(`Unknown unity action: ${action}`);
        }
    }
    
    /**
     * Handle Unity client registration
     */
    private handleUnityRegister(params: Record<string, unknown>): { data?: unknown; message?: string } {
        const projectPath = params.projectPath as string;
        const unityVersion = params.unityVersion as string;
        
        if (!projectPath) {
            throw new Error('Missing projectPath parameter');
        }
        
        // Get daemon instance to register the Unity client
        // The clientId should be passed from the request context
        const clientId = params.clientId as string;
        if (!clientId) {
            throw new Error('Missing clientId - cannot register Unity client');
        }
        
        // Access daemon through services
        const daemon = (this.services as any)._daemon;
        if (!daemon || typeof daemon.registerUnityClient !== 'function') {
            // If daemon not available directly, we need a different approach
            // For now, just accept the registration and let UnityControlManager handle it
            log.info(`Unity client registration request: ${projectPath} (${unityVersion})`);
            return {
                data: { 
                    registered: true,
                    projectPath,
                    unityVersion
                },
                message: 'Unity client registered'
            };
        }
        
        const result = daemon.registerUnityClient(clientId, projectPath);
        
        if (!result.success) {
            throw new Error(result.error);
        }
        
        return {
            data: { 
                registered: true,
                projectPath,
                unityVersion
            },
            message: 'Unity client registered'
        };
    }
    
    /**
     * Handle direct Unity commands - forwarded to Unity package via WebSocket
     */
    private async handleUnityDirect(action: string, params: Record<string, unknown>): Promise<{ data?: unknown; message?: string }> {
        // Access daemon to check if Unity client is connected
        const daemon = (this.services as any)._daemon;
        
        if (!daemon || typeof daemon.isUnityClientConnected !== 'function') {
            throw new Error('Unity direct commands not available - daemon not configured');
        }
        
        if (!daemon.isUnityClientConnected()) {
            throw new Error('Unity client not connected. Install the APC Unity Bridge package in your Unity project.');
        }
        
        // Map action to full command
        const cmd = `unity.${action}`;
        
        // Send request to Unity and wait for response
        const response = await daemon.sendRequestToUnity(cmd, params);
        
        if (!response) {
            throw new Error('Failed to communicate with Unity client');
        }
        
        if (!response.success) {
            throw new Error(response.error || 'Unity command failed');
        }
        
        return {
            data: response.data,
            message: response.message
        };
    }
    
    private unityStatus(): UnityStatusResponse {
        const state = this.services.unityManager!.getState();
        const editorStatus = this.services.unityManager!.getUnityStatus();
        
        // Combine manager state with editor status from Unity Bridge
        return {
            status: state.status,
            connected: state.status !== 'disconnected',
            isPlaying: editorStatus?.isPlaying ?? false,
            isCompiling: editorStatus?.isCompiling ?? false,
            hasErrors: false,  // Errors now tracked via pipeline results
            errorCount: 0,     // Errors now tracked via pipeline results
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
            
            case 'getAll': {
                // Return both roles and system prompts for the UI panel
                const roles = this.services.roleRegistry.getAllRoles();
                const systemPrompts = this.services.roleRegistry.getAllSystemPrompts().map(p => p.toJSON());
                return { 
                    data: {
                        roles,
                        systemPrompts
                    }
                };
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
                // Graceful shutdown - cancel all active workflows and release agents
                if (!this.services.coordinator.gracefulShutdown) {
                    throw new Error('Graceful shutdown not supported by coordinator');
                }
                
                const result = await this.services.coordinator.gracefulShutdown();
                return { 
                    data: { 
                        workflowsCancelled: result.workflowsCancelled,
                        agentsReleased: result.agentsReleased
                    },
                    message: `Graceful shutdown: ${result.workflowsCancelled} workflows cancelled, ${result.agentsReleased} agents released`
                };
            }
            
            default:
                throw new Error(`Unknown coordinator action: ${action}`);
        }
    }
    
    // ========================================================================
    // Prompts Handler
    // ========================================================================
    
    private async handlePrompts(action: string, params: Record<string, unknown>): Promise<{ data?: unknown; message?: string }> {
        if (!this.services.roleRegistry) {
            throw new Error('Role registry not available');
        }
        
        switch (action) {
            // Generic system prompt handlers (used by SystemSettingsPanel)
            case 'getSystemPrompt': {
                const id = params.id as string;
                if (!id) {
                    throw new Error('Missing id parameter');
                }
                const prompt = this.services.roleRegistry.getSystemPrompt(id);
                return { 
                    data: { prompt: prompt?.toJSON() }
                };
            }
            
            case 'updateSystemPrompt': {
                const id = params.id as string;
                const config = params.config as Record<string, unknown>;
                if (!id) {
                    throw new Error('Missing id parameter');
                }
                if (!config) {
                    throw new Error('Missing config parameter');
                }
                // Create a SystemPromptConfig-like object for update
                const promptConfig = {
                    id,
                    ...config,
                    toJSON: () => ({ id, ...config })
                };
                this.services.roleRegistry.updateSystemPrompt(promptConfig as any);
                return { message: `System prompt ${id} updated successfully` };
            }
            
            case 'resetSystemPrompt': {
                const id = params.id as string;
                if (!id) {
                    throw new Error('Missing id parameter');
                }
                const resetPrompt = this.services.roleRegistry.resetSystemPromptToDefault(id);
                return { 
                    data: { prompt: resetPrompt?.toJSON() },
                    message: `System prompt ${id} reset to defaults`
                };
            }
            
            default:
                throw new Error(`Unknown prompts action: ${action}`);
        }
    }
    
    // ========================================================================
    // Config Handler
    // ========================================================================
    
    private async handleConfig(action: string, params: Record<string, unknown>): Promise<{ data?: unknown; message?: string }> {
        // Use daemon's ConfigLoader if available for live updates
        // Otherwise fall back to creating a new one (shouldn't happen in normal operation)
        let configLoader = this.services.configLoader;
        
        if (!configLoader) {
            // Fallback: create new ConfigLoader (changes won't affect live daemon config)
            const workspaceRoot = this.services.stateManager.getWorkspaceRoot();
            if (!workspaceRoot) {
                throw new Error('Workspace root not available');
            }
            configLoader = new ConfigLoader(workspaceRoot);
            log.warn('Using fallback ConfigLoader - changes may not take effect until daemon restart');
        }
        
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
        
        // Get working directory from state manager
        const workingDir = this.services.stateManager.getWorkingDir();
        
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
    // Dependency Management
    // ========================================================================
    
    /**
     * Handle dependency-related commands
     */
    private async handleDeps(action: string, params: Record<string, unknown>): Promise<{ data?: unknown; message?: string }> {
        let depService: DependencyService;
        try {
            depService = ServiceLocator.resolve(DependencyService);
        } catch {
            throw new Error('DependencyService not available');
        }
        
        switch (action) {
            case 'status': {
                const allDeps = depService.getCachedStatus();
                const platform = process.platform;
                const dependencies = allDeps.filter(d => d.platform === platform || d.platform === 'all');
                const missingDeps = dependencies.filter(d => d.required && !d.installed);
                const missingCount = missingDeps.length;
                const hasCriticalMissing = missingDeps.some(d => 
                    d.name.includes('Python') || d.name.includes('APC CLI')
                );
                
                // Map to client-friendly format with install info
                const missingDependencies = missingDeps.map(d => ({
                    name: d.name,
                    description: d.description,
                    installUrl: d.installUrl,
                    installCommand: d.installCommand,
                    // Use installType from DependencyService if present, otherwise compute it
                    installType: d.installType || this.getInstallType(d)
                }));
                
                return { 
                    data: { 
                        dependencies,
                        missingDependencies,
                        missingCount,
                        hasCriticalMissing
                    } 
                };
            }
            
            case 'refresh': {
                // Clear initialization cache before re-checking dependencies
                // This allows late-joining clients to see fresh dependency check results
                // and sets daemon back to 'initializing_services' state
                if (this.services.daemon) {
                    this.services.daemon.clearInitializationCache();
                }
                
                // Broadcast the full list of dependencies upfront (same as initial startup)
                const dependencyList = depService.getDependencyList();
                this.broadcaster.broadcast('deps.list' as any, { dependencies: dependencyList });
                
                // Re-check all dependencies (progress will be broadcast via callback)
                // This will WAIT for the 15+ second Unity MCP connectivity test
                const freshDeps = await depService.checkAllDependencies();
                const platform = process.platform;
                const dependencies = freshDeps.filter(d => d.platform === platform || d.platform === 'all');
                const missingDeps = dependencies.filter(d => d.required && !d.installed);
                const missingCount = missingDeps.length;
                const hasCriticalMissing = missingDeps.some(d => 
                    d.name.includes('Python') || d.name.includes('APC CLI')
                );
                
                const missingDependencies = missingDeps.map(d => ({
                    name: d.name,
                    description: d.description,
                    installUrl: d.installUrl,
                    installCommand: d.installCommand,
                    installType: this.getInstallType(d)
                }));
                
                // Mark dependency check as complete - sets daemon back to 'ready' state
                // and re-broadcasts daemon.ready event so UI updates
                if (this.services.daemon) {
                    this.services.daemon.setDependencyCheckComplete();
                }
                
                return { 
                    data: { 
                        dependencies,
                        missingDependencies,
                        missingCount,
                        hasCriticalMissing
                    },
                    message: 'Dependencies refreshed'
                };
            }
            
            default:
                throw new Error(`Unknown deps action: ${action}`);
        }
    }
    
    /**
     * Determine the install type for a dependency
     */
    private getInstallType(dep: DependencyStatus): 'url' | 'command' | 'apc-cli' | 'vscode-command' | 'cursor-agent-cli' | 'unity-mcp' | 'unity-bridge' {
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
        // Unity Bridge package
        if (dep.name === 'APC Unity Bridge') {
            return 'unity-bridge';
        }
        // Unity MCP
        if (dep.name === 'MCP for Unity') {
            return 'unity-mcp';
        }
        if (dep.installUrl) {
            return 'url';
        }
        if (dep.installCommand) {
            return 'command';
        }
        return 'url';
    }
    
    // ========================================================================
    // Process Management
    // ========================================================================
    
    /**
     * Handle process management commands
     */
    private async handleProcess(action: string, params: Record<string, unknown>): Promise<{ data?: unknown; message?: string }> {
        const processManager = this.services.processManager;
        
        switch (action) {
            case 'cleanup':
            case 'kill-orphans': {
                const killedCount = await processManager.killOrphanCursorAgents();
                return { 
                    data: { killedCount },
                    message: killedCount > 0 
                        ? `Killed ${killedCount} orphan cursor-agent processes`
                        : 'No orphan cursor-agent processes found'
                };
            }
            
            case 'count': {
                // Count cursor-agent processes (cross-platform)
                try {
                    const { countCursorAgentProcesses } = await import('../utils/orphanCleanup');
                    const count = countCursorAgentProcesses();
                    return { data: { processCount: count } };
                } catch (err) {
                    return { data: { processCount: 0, error: String(err) } };
                }
            }
            
            case 'network-diagnostics': {
                // Run network diagnostics to help troubleshoot fetch failures
                const { runNetworkDiagnostics, formatDiagnosticsReport } = await import('../utils/networkDiagnostics');
                const report = await runNetworkDiagnostics();
                return {
                    data: report,
                    message: formatDiagnosticsReport(report)
                };
            }
            
            default:
                throw new Error(`Unknown process action: ${action}`);
        }
    }
    
    // ========================================================================
    // System Management
    // ========================================================================
    
    /**
     * Handle system-level commands (installation, configuration, etc.)
     */
    private async handleSystem(action: string, params: Record<string, unknown>): Promise<{ data?: unknown; message?: string }> {
        switch (action) {
            case 'installUnityMcp': {
                try {
                    log.info('[ApiHandler] Processing installUnityMcp request...');
                    const { DependencyService } = await import('../services/DependencyService');
                    const depService = ServiceLocator.resolve(DependencyService);
                    log.info('[ApiHandler] Calling installUnityMcpComplete...');
                    const result = await depService.installUnityMcpComplete();
                    log.info('[ApiHandler] installUnityMcpComplete result:', result);
                    
                    return { 
                        data: result,
                        message: result.success ? 'Installation completed' : 'Installation failed'
                    };
                } catch (e: any) {
                    log.error('[ApiHandler] installUnityMcp exception:', e);
                    return {
                        data: { success: false, message: e.message || String(e) },
                        message: `Installation failed: ${e.message || String(e)}`
                    };
                }
            }
            
            case 'enableCacheForNextCheck': {
                try {
                    log.info('[ApiHandler] Processing enableCacheForNextCheck request...');
                    const { DependencyService } = await import('../services/DependencyService');
                    const depService = ServiceLocator.resolve(DependencyService);
                    depService.enableCacheForNextCheck();
                    
                    return { 
                        data: { success: true },
                        message: 'Cache enabled for next dependency check'
                    };
                } catch (e: any) {
                    log.error('[ApiHandler] enableCacheForNextCheck exception:', e);
                    return {
                        data: { success: false, message: e.message || String(e) },
                        message: `Failed to enable cache: ${e.message || String(e)}`
                    };
                }
            }
            
            case 'installUnityBridge': {
                try {
                    log.info('[ApiHandler] Processing installUnityBridge request...');
                    const { DependencyService } = await import('../services/DependencyService');
                    const depService = ServiceLocator.resolve(DependencyService);
                    const result = await depService.installApcUnityBridge();
                    log.info('[ApiHandler] installApcUnityBridge result:', result);
                    
                    return { 
                        data: result,
                        message: result.success ? 'APC Unity Bridge installed' : 'Installation failed'
                    };
                } catch (e: any) {
                    log.error('[ApiHandler] installUnityBridge exception:', e);
                    return {
                        data: { success: false, message: e.message || String(e) },
                        message: `Installation failed: ${e.message || String(e)}`
                    };
                }
            }
            
            default:
                throw new Error(`Unknown system action: ${action}`);
        }
    }
    
    // ========================================================================
    // User Interaction Handlers (Ask/Respond for clarifications)
    // ========================================================================
    
    private async handleUser(action: string, params: Record<string, unknown>): Promise<{ data?: unknown; message?: string }> {
        const taskManager = this.services.taskManager;
        if (!taskManager) {
            throw new Error('TaskManager not available');
        }
        
        switch (action) {
            case 'ask': {
                const session = params.session as string;
                const taskId = params.task as string;
                const question = params.question as string;
                const context = params.context as string | undefined;
                
                if (!session || !taskId || !question) {
                    throw new Error('Missing required parameters: session, task, question');
                }
                
                // Normalize task ID
                const globalTaskId = this.toGlobalTaskId(taskId, session);
                
                // Get task for summary
                const task = taskManager.getTask(globalTaskId);
                if (!task) {
                    throw new Error(`Task ${globalTaskId} not found`);
                }
                
                // Add question to task
                const result = taskManager.addQuestionToTask(globalTaskId, question);
                if (!result.success) {
                    throw new Error(result.error || 'Failed to add question');
                }
                
                // Build respond command for the chat agent
                const respondCommand = `apc user respond --session ${session} --task ${globalTaskId} --id ${result.questionId} --response "<user's answer>"`;
                
                // Broadcast event to VS Code extension
                this.broadcaster.broadcast('user.questionAsked', {
                    sessionId: session,
                    taskId: globalTaskId,
                    questionId: result.questionId!,
                    taskSummary: `${task.id}: ${task.description}`,
                    question,
                    respondCommand,
                    timestamp: new Date().toISOString()
                }, session);
                
                return {
                    data: {
                        success: true,
                        questionId: result.questionId,
                        respondCommand
                    },
                    message: `Question asked for task ${globalTaskId}. VS Code will open chat window for user response.`
                };
            }
            
            case 'respond': {
                const session = params.session as string;
                const taskId = params.task as string;
                const questionId = params.questionId as string | undefined;
                const response = params.response as string;
                
                if (!session || !taskId || !response) {
                    throw new Error('Missing required parameters: session, task, response');
                }
                
                // Normalize task ID
                const globalTaskId = this.toGlobalTaskId(taskId, session);
                
                // If no questionId provided, find the pending question
                let qId = questionId;
                if (!qId) {
                    const pending = taskManager.getPendingQuestion(globalTaskId);
                    if (!pending) {
                        throw new Error(`No pending question found for task ${globalTaskId}`);
                    }
                    qId = pending.id;
                }
                
                // Answer the question
                const result = taskManager.answerTaskQuestion(globalTaskId, qId, response);
                if (!result.success) {
                    throw new Error(result.error || 'Failed to answer question');
                }
                
                // Trigger coordinator evaluation with user_responded event
                const coordinator = this.services.coordinator;
                if (coordinator?.triggerCoordinatorEvaluation) {
                    coordinator.triggerCoordinatorEvaluation(session, 'user_responded', {
                        type: 'user_responded',
                        taskId: globalTaskId,
                        questionId: qId,
                        response
                    });
                }
                
                return {
                    data: {
                        success: true,
                        taskId: globalTaskId,
                        questionId: qId,
                        response
                    },
                    message: `Response recorded for task ${globalTaskId}. Coordinator will evaluate next action.`
                };
            }
            
            default:
                throw new Error(`Unknown user action: ${action}`);
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

