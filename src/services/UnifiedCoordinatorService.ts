// ============================================================================
// UnifiedCoordinatorService - Central coordinator for all workflows
// ============================================================================

import { v4 as uuidv4 } from 'uuid';
import { TypedEventEmitter } from './TypedEventEmitter';
import { StateManager } from './StateManager';
import { AgentPoolService } from './AgentPoolService';
import { AgentRoleRegistry } from './AgentRoleRegistry';
import { UnityControlManager } from './UnityControlManager';
import { OutputChannelManager } from './OutputChannelManager';
import { ServiceLocator } from './ServiceLocator';
// Note: RevisionImpactAnalyzer is used in PlanningRevisionWorkflow, not here
import { 
    WorkflowRegistry, 
    IWorkflow, 
    WorkflowServices,
    createWorkflowRegistry,
    TaskOccupancy,
    TaskConflict,
    ConflictResolution
} from './workflows';
import { 
    WorkflowType, 
    WorkflowStatus, 
    WorkflowProgress, 
    WorkflowResult,
    WorkflowConfig,
    AgentRequest,
    SessionWorkflowState,
    WorkflowSummary,
    TaskImplementationInput,
    RevisionState,
    FailedTask,
    AgentCompletionSignal
} from '../types/workflow';
import { PlanParser } from './PlanParser';
import { PlanCache } from './PlanCache';
import { TaskManager, ERROR_RESOLUTION_SESSION_ID, ErrorInfo } from './TaskManager';
import { EventBroadcaster } from '../daemon/EventBroadcaster';
import { CoordinatorAgent } from './CoordinatorAgent';
import { CoordinatorContext } from './CoordinatorContext';
import {
    CoordinatorEvent,
    CoordinatorEventType,
    CoordinatorInput,
    CoordinatorDecision,
    CoordinatorHistoryEntry,
    ExecutionStartedPayload,
    WorkflowCompletedPayload,
    WorkflowFailedPayload,
    UnityErrorPayload,
    AgentAvailablePayload
} from '../types/coordinator';

/**
 * Session state for tracking workflows
 */
interface SessionState {
    sessionId: string;
    workflows: Map<string, IWorkflow>;
    pendingWorkflowIds: string[];
    completedWorkflowIds: string[];
    createdAt: string;
    updatedAt: string;
    
    // === Revision State Tracking ===
    // Used when planning_revision workflow pauses other workflows
    isRevising: boolean;
    pausedForRevision: string[];  // Workflow IDs paused during revision
    revisionState?: RevisionState;
    
    // === Workflow-Task Mapping ===
    workflowToTaskMap: Map<string, string>;
    
    // === AI Coordinator History ===
    /** History of coordinator decisions for continuity across evaluations */
    coordinatorHistory: CoordinatorHistoryEntry[];
    
    /** Pending questions awaiting user response */
    pendingQuestions: Array<{
        id: string;
        question: string;
        context: string;
        askedAt: string;
        relatedTaskId?: string;
    }>;
}

/**
 * Options for dispatching a workflow
 */
export interface DispatchOptions {
    priority?: number;
    dependencies?: string[];
    blocking?: boolean;
}

/**
 * UnifiedCoordinatorService
 * 
 * Central coordinator that manages all workflow instances.
 * Handles:
 * - Session initialization and workflow tracking
 * - Workflow dispatch with dependency checking
 * - Agent allocation queue (priority-based)
 * - Revision handling (pause task dispatch, run revision, resume)
 * - Event routing to UI
 * 
 * Obtain via ServiceLocator:
 *   const coordinator = ServiceLocator.resolve(UnifiedCoordinatorService);
 * 
 * NOTE: This service requires StateManager, AgentPoolService, and AgentRoleRegistry
 * to be passed to the constructor. Register it in extension.ts after creating those services:
 * 
 *   ServiceLocator.register(UnifiedCoordinatorService, () => 
 *       new UnifiedCoordinatorService(stateManager, agentPoolService, agentRoleRegistry)
 *   );
 */
export class UnifiedCoordinatorService {
    // Core services
    private stateManager: StateManager;
    private agentPoolService: AgentPoolService;
    private roleRegistry: AgentRoleRegistry;
    /** Unity Control Manager - only available when Unity features are enabled */
    private unityManager: UnityControlManager | undefined;
    private outputManager: OutputChannelManager;
    
    /** Whether Unity features are enabled */
    private unityEnabled: boolean = true;
    
    // Workflow management
    private workflowRegistry: WorkflowRegistry;
    private sessions: Map<string, SessionState> = new Map();
    private agentRequestQueue: AgentRequest[] = [];
    
    // Agent CLI completion signals
    // Key: `${workflowId}_${stage}` -> resolve function
    private completionSignals: Map<string, {
        stage: string;
        resolve: (signal: AgentCompletionSignal) => void;
        reject: (error: Error) => void;
        timeoutId: NodeJS.Timeout;
    }> = new Map();
    
    // Events
    private readonly _onWorkflowProgress = new TypedEventEmitter<WorkflowProgress>();
    readonly onWorkflowProgress = this._onWorkflowProgress.event;
    
    private readonly _onWorkflowComplete = new TypedEventEmitter<{ sessionId: string; workflowId: string; result: WorkflowResult }>();
    readonly onWorkflowComplete = this._onWorkflowComplete.event;
    
    private readonly _onSessionStateChanged = new TypedEventEmitter<string>();
    readonly onSessionStateChanged = this._onSessionStateChanged.event;
    
    // AI Coordinator Agent (handles debouncing, evaluation, and history)
    private coordinatorAgent: CoordinatorAgent;
    private coordinatorContext: CoordinatorContext;
    
    constructor(
        stateManager: StateManager,
        agentPoolService: AgentPoolService,
        roleRegistry: AgentRoleRegistry
    ) {
        this.stateManager = stateManager;
        this.agentPoolService = agentPoolService;
        this.roleRegistry = roleRegistry;
        // Unity manager will be set via setUnityEnabled() when Unity features are enabled
        this.unityManager = undefined;
        this.outputManager = ServiceLocator.resolve(OutputChannelManager);
        
        // Create workflow registry with all built-in types
        this.workflowRegistry = createWorkflowRegistry();
        
        // Create the AI Coordinator Agent with access to role registry for customizable prompts
        this.coordinatorAgent = new CoordinatorAgent({}, this.roleRegistry);
        
        // Set up decision execution callback
        this.coordinatorAgent.setExecuteDecisionCallback(async (sessionId, decision) => {
            await this.executeCoordinatorDecision(sessionId, decision);
            
            // Log to history
            const state = this.sessions.get(sessionId);
            if (state) {
                // Note: The event is embedded in the decision context, we use a placeholder
                this.logDecisionToHistory(sessionId, decision);
            }
        });
        
        // Create the context builder for AI evaluations
        this.coordinatorContext = new CoordinatorContext(this.stateManager, this.agentPoolService);
        
        this.log('UnifiedCoordinatorService initialized');
    }
    
    /**
     * Enable or disable Unity features
     * @param enabled Whether Unity features should be enabled
     * @param unityManager Unity Control Manager instance (required if enabled is true)
     */
    setUnityEnabled(enabled: boolean, unityManager?: UnityControlManager): void {
        this.unityEnabled = enabled;
        this.unityManager = enabled ? unityManager : undefined;
        this.log(`Unity features ${enabled ? 'enabled' : 'disabled'}`);
    }
    
    /**
     * Check if Unity features are enabled
     */
    isUnityEnabled(): boolean {
        return this.unityEnabled;
    }
    
    // =========================================================================
    // SESSION MANAGEMENT
    // =========================================================================
    
    /**
     * Initialize a session for workflow tracking
     */
    initSession(sessionId: string): void {
        if (this.sessions.has(sessionId)) {
            this.log(`Session ${sessionId} already initialized`);
            return;
        }
        
        // Load any existing coordinator history from disk
        const savedHistory = this.stateManager.loadCoordinatorHistory(sessionId);
        
        const state: SessionState = {
            sessionId,
            workflows: new Map(),
            pendingWorkflowIds: [],
            completedWorkflowIds: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            
            // Revision state tracking
            isRevising: false,
            pausedForRevision: [],
            
            // Workflow-task mapping
            workflowToTaskMap: new Map(),
            
            // AI Coordinator history (loaded from disk if available)
            coordinatorHistory: savedHistory,
            pendingQuestions: []
        };
        
        this.sessions.set(sessionId, state);
        this.log(`Session initialized: ${sessionId}${savedHistory.length > 0 ? ` (loaded ${savedHistory.length} history entries)` : ''}`);
        this._onSessionStateChanged.fire(sessionId);
    }
    
    /**
     * Get session workflow state for UI
     */
    getSessionState(sessionId: string): SessionWorkflowState | undefined {
        const state = this.sessions.get(sessionId);
        if (!state) return undefined;
        
        const activeWorkflows = new Map<string, WorkflowProgress>();
        for (const [id, workflow] of state.workflows) {
            if (workflow.getStatus() !== 'completed' && workflow.getStatus() !== 'cancelled') {
                activeWorkflows.set(id, workflow.getProgress());
            }
        }
        
        return {
            sessionId,
            activeWorkflows,
            pendingWorkflows: state.pendingWorkflowIds,
            completedWorkflows: state.completedWorkflowIds,
            isRevising: state.isRevising,
            pausedForRevision: state.pausedForRevision,
            revisionState: state.revisionState
        };
    }
    
    /**
     * Get workflow summaries for UI display
     */
    getWorkflowSummaries(sessionId: string): WorkflowSummary[] {
        const state = this.sessions.get(sessionId);
        if (!state) return [];
        
        const summaries: WorkflowSummary[] = [];
        for (const [id, workflow] of state.workflows) {
            const progress = workflow.getProgress();
            summaries.push({
                id,
                type: workflow.type,
                status: progress.status,
                phase: progress.phase,
                percentage: progress.percentage
            });
        }
        
        return summaries;
    }
    
    // =========================================================================
    // WORKFLOW DISPATCH
    // =========================================================================
    
    /**
     * Dispatch a workflow for a session
     * 
     * Task occupancy/conflict is handled generically:
     * - Workflows declare occupancy via onTaskOccupancyDeclared
     * - Workflows declare conflicts via onTaskConflictDeclared
     * - Coordinator handles pause/resume based on conflict resolution strategy
     * 
     * @returns Workflow ID
     */
    async dispatchWorkflow(
        sessionId: string,
        type: WorkflowType,
        input: Record<string, any>,
        options: DispatchOptions = {}
    ): Promise<string> {
        // Ensure session exists
        if (!this.sessions.has(sessionId)) {
            this.initSession(sessionId);
        }
        
        const state = this.sessions.get(sessionId)!;
        
        // Create workflow config
        const config: WorkflowConfig = {
            id: uuidv4(),
            type,
            sessionId,
            priority: options.priority ?? 10,
            input
        };
        
        // Get workflow services
        const services: WorkflowServices = {
            stateManager: this.stateManager,
            agentPoolService: this.agentPoolService,
            roleRegistry: this.roleRegistry,
            unityManager: this.unityManager,
            outputManager: this.outputManager,
            unityEnabled: this.unityEnabled
        };
        
        // Create workflow instance
        const workflow = this.workflowRegistry.create(type, config, services);
        
        // Subscribe to workflow events (including occupancy/conflict)
        this.subscribeToWorkflow(workflow, sessionId);
        
        // Track workflow
        state.workflows.set(config.id, workflow);
        state.updatedAt = new Date().toISOString();
        
        // Track task ID for task_implementation workflows (for legacy compatibility)
        if (type === 'task_implementation') {
            const taskInput = input as TaskImplementationInput;
            state.workflowToTaskMap.set(config.id, taskInput.taskId);
        }
        
        this.log(`Dispatched workflow: ${type} (${config.id}) for session ${sessionId}`);
        this._onSessionStateChanged.fire(sessionId);
        
        // Start workflow asynchronously
        this.startWorkflow(workflow, sessionId);
        
        return config.id;
    }
    
    
    /**
     * Start execution by triggering AI Coordinator evaluation
     * 
     * The AI Coordinator will:
     * 1. Analyze all tasks and their dependencies
     * 2. Check available agents
     * 3. Decide which workflows to dispatch for which tasks
     * 4. Potentially ask user for clarification if needed
     */
    async startExecution(sessionId: string): Promise<string[]> {
        const taskManager = ServiceLocator.resolve(TaskManager);
        
        // Initialize session state if needed
        if (!this.sessions.has(sessionId)) {
            this.initSession(sessionId);
        }
        
        // For ERROR_RESOLUTION session, tasks are already in TaskManager
        // Just trigger the coordinator
        if (sessionId === ERROR_RESOLUTION_SESSION_ID) {
            const errorTasks = taskManager.getTasksForSession(sessionId);
            
            this.log(`Starting ERROR_RESOLUTION execution with ${errorTasks.length} error tasks`);
            
            // Trigger AI Coordinator to decide how to handle errors
            const decision = await this.triggerCoordinatorEvaluation(
                sessionId,
                'execution_started',
                {
                    type: 'execution_started',
                    planPath: '',
                    taskCount: errorTasks.length
                } as ExecutionStartedPayload
            );
            
            // If in cooldown, decision is null - return empty (will dispatch after cooldown)
            return decision?.dispatch.map(d => d.taskId) || [];
        }
        
        // Regular session - parse plan file and initialize tasks
        const session = this.stateManager.getPlanningSession(sessionId);
        if (!session?.currentPlanPath) {
            throw new Error('No plan available for execution');
        }
        
        // Parse the plan to get tasks (using cache for performance)
        const planCache = ServiceLocator.resolve(PlanCache);
        const plan = planCache.getPlan(session.currentPlanPath);
        
        // Register session with global TaskManager and initialize tasks
        taskManager.registerSession(sessionId, session.currentPlanPath);
        taskManager.initializeFromPlan(sessionId, plan);
        
        // Count tasks
        let taskCount = 0;
        for (const tasks of Object.values(plan.engineerChecklists)) {
            taskCount += tasks.filter(t => !t.completed).length;
        }
        
        // Update session status
        session.status = 'executing';
        session.updatedAt = new Date().toISOString();
        this.stateManager.savePlanningSession(session);
        
        this.log(`Starting execution for session ${sessionId} with ${taskCount} tasks`);
        
        // Trigger AI Coordinator to analyze tasks and dispatch workflows
        // The AI decides:
        // - Which tasks to dispatch (based on dependencies)
        // - What workflow type for each (implementation, error_resolution, context_gathering)
        // - Priority and agent assignment
        const decision = await this.triggerCoordinatorEvaluation(
            sessionId,
            'execution_started',
            {
                type: 'execution_started',
                planPath: session.currentPlanPath,
                taskCount
            } as ExecutionStartedPayload
        );
        
        const dispatchCount = decision?.dispatch.length || 0;
        this.log(`AI Coordinator dispatched ${dispatchCount} workflows`);
        
        // Return the task IDs that were dispatched (empty if in cooldown)
        return decision?.dispatch.map(d => d.taskId) || [];
    }
    
    
    // =========================================================================
    // WORKFLOW LIFECYCLE
    // =========================================================================
    
    /**
     * Pause all workflows in a session
     */
    async pauseSession(sessionId: string): Promise<void> {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        
        this.log(`Pausing session: ${sessionId}`);
        
        for (const workflow of state.workflows.values()) {
            if (workflow.getStatus() === 'running') {
                await workflow.pause();
            }
        }
        
        // Update planning session status
        const session = this.stateManager.getPlanningSession(sessionId);
        if (session) {
            session.status = 'paused';
            session.updatedAt = new Date().toISOString();
            this.stateManager.savePlanningSession(session);
        }
        
        this._onSessionStateChanged.fire(sessionId);
    }
    
    /**
     * Resume all paused workflows in a session
     */
    async resumeSession(sessionId: string): Promise<void> {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        
        this.log(`Resuming session: ${sessionId}`);
        
        for (const workflow of state.workflows.values()) {
            if (workflow.getStatus() === 'paused') {
                await workflow.resume();
            }
        }
        
        // Update planning session status
        const session = this.stateManager.getPlanningSession(sessionId);
        if (session) {
            session.status = 'executing';
            session.updatedAt = new Date().toISOString();
            this.stateManager.savePlanningSession(session);
        }
        
        this._onSessionStateChanged.fire(sessionId);
    }
    
    /**
     * Cancel all workflows in a session
     */
    async cancelSession(sessionId: string): Promise<void> {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        
        this.log(`Cancelling session: ${sessionId}`);
        
        for (const workflow of state.workflows.values()) {
            const status = workflow.getStatus();
            if (status !== 'completed' && status !== 'cancelled' && status !== 'failed') {
                await workflow.cancel();
            }
        }
        
        // Update planning session status
        const session = this.stateManager.getPlanningSession(sessionId);
        if (session) {
            session.status = 'stopped';
            session.updatedAt = new Date().toISOString();
            this.stateManager.savePlanningSession(session);
        }
        
        // Clean up TaskManager (but don't unregister ERROR_RESOLUTION - it lives forever)
        if (sessionId !== ERROR_RESOLUTION_SESSION_ID) {
            const taskManager = ServiceLocator.resolve(TaskManager);
            taskManager.unregisterSession(sessionId);
        }
        
        this._onSessionStateChanged.fire(sessionId);
    }
    
    /**
     * Cancel a specific workflow
     */
    async cancelWorkflow(sessionId: string, workflowId: string): Promise<void> {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        
        const workflow = state.workflows.get(workflowId);
        if (workflow) {
            await workflow.cancel();
        }
    }
    
    /**
     * Get workflow status
     */
    getWorkflowStatus(sessionId: string, workflowId: string): WorkflowProgress | undefined {
        const state = this.sessions.get(sessionId);
        if (!state) return undefined;
        
        const workflow = state.workflows.get(workflowId);
        return workflow?.getProgress();
    }
    
    // =========================================================================
    // AGENT MANAGEMENT
    // =========================================================================
    
    /**
     * Handle agent request from workflow
     */
    private handleAgentRequest(request: AgentRequest): void {
        // Add to queue
        this.agentRequestQueue.push(request);
        this.agentRequestQueue.sort((a, b) => a.priority - b.priority);
        
        // Try to fulfill requests
        this.processAgentQueue();
    }
    
    /**
     * Handle agent release from workflow
     */
    private handleAgentReleased(agentName: string): void {
        const taskManager = ServiceLocator.resolve(TaskManager);
        
        // Sync with TaskManager - release the agent assignment
        taskManager.releaseAgent(agentName);
        
        // Release from AgentPoolService (thin allocation layer)
        this.agentPoolService.releaseAgents([agentName]);
        this.log(`Agent released: ${agentName}`);
        
        // Try to fulfill pending requests
        this.processAgentQueue();
        
        // Notify sessions that could use the agent (have ready tasks without running workflows)
        // This avoids triggering evaluations for sessions that can't benefit
        for (const [sessionId, state] of this.sessions) {
            // Check if session has tasks ready to dispatch
            const tasks = taskManager.getTasksForSession(sessionId);
            const hasReadyTasks = tasks.some(t => 
                t.status === 'pending' || t.status === 'ready' || t.status === 'ready_for_agent'
            );
            
            if (hasReadyTasks) {
                this.triggerCoordinatorEvaluation(sessionId, 'agent_available', {
                    type: 'agent_available',
                    agentName,
                    roles: ['engineer']
                } as AgentAvailablePayload).catch(e => {
                    this.log(`Failed to notify session ${sessionId} of agent availability: ${e}`);
                });
            }
        }
    }
    
    /**
     * Process the agent request queue
     */
    private processAgentQueue(): void {
        const taskManager = ServiceLocator.resolve(TaskManager);
        
        while (this.agentRequestQueue.length > 0) {
            const request = this.agentRequestQueue[0];
            
            // Try to allocate an agent from the pool
            const agents = this.agentPoolService.allocateAgents(request.workflowId, 1, request.roleId);
            
            if (agents.length > 0) {
                // Remove request from queue
                this.agentRequestQueue.shift();
                
                const agentName = agents[0];
                
                // Find which session this workflow belongs to
                let sessionId = '';
                for (const [sid, state] of this.sessions) {
                    if (state.workflows.has(request.workflowId)) {
                        sessionId = sid;
                        break;
                    }
                }
                
                // Sync with TaskManager - register the agent with role
                // Map the string roleId to the AgentRole type
                const roleId = this.mapRoleIdToAgentRole(request.roleId);
                taskManager.registerAgent(agentName, sessionId, '', roleId);
                
                // Fulfill the request
                request.callback(agentName);
                this.log(`Agent ${agentName} allocated for workflow ${request.workflowId} (role: ${request.roleId})`);
            } else {
                // No agents available, stop processing
                break;
            }
        }
    }
    
    /**
     * Map a string role ID to the AgentRole type
     */
    private mapRoleIdToAgentRole(roleId: string): import('./TaskManager').AgentRole {
        const mapping: Record<string, import('./TaskManager').AgentRole> = {
            'engineer': 'engineer',
            'context': 'context',
            'context_gatherer': 'context',
            'code_reviewer': 'reviewer',
            'delta_context': 'delta_context',
            'planner': 'engineer',  // Planner uses engineer role for tracking
            'analyst_codex': 'reviewer',
            'analyst_gemini': 'reviewer',
            'analyst_reviewer': 'reviewer',
            'error_analyst': 'reviewer'
        };
        return mapping[roleId] || 'engineer';
    }
    
    // =========================================================================
    // TASK CONFLICT MANAGEMENT
    // =========================================================================
    
    /**
     * Handle workflow declaring task conflicts
     * This is the main coordination point for conflict resolution
     */
    private async handleTaskConflictDeclared(
        sessionId: string,
        workflowId: string,
        conflict: TaskConflict
    ): Promise<void> {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        
        const taskManager = ServiceLocator.resolve(TaskManager);
        const { taskIds, resolution, reason } = conflict;
        
        this.log(`⚔️  CONFLICT: ${workflowId.substring(0, 8)} → ${taskIds.join(', ')} (${resolution})`);
        if (reason) this.log(`   Reason: ${reason}`);
        
        const occupiedTasks = taskManager.checkTaskConflicts(workflowId, taskIds);
        
        if (occupiedTasks.length === 0) {
            this.log(`   ✅ No conflicts - all tasks free`);
            return;
        }
        
        this.log(`   🔒 Occupied: ${occupiedTasks.map(o => `${o.taskId}→${o.occupyingWorkflowId.substring(0,8)}`).join(', ')}`);
        
        switch (resolution) {
            case 'pause_others': {
                const workflowsToPause = [...new Set(occupiedTasks.map(o => o.occupyingWorkflowId))];
                for (const otherWorkflowId of workflowsToPause) {
                    const workflow = state.workflows.get(otherWorkflowId);
                    if (workflow && (workflow.getStatus() === 'running' || workflow.getStatus() === 'blocked')) {
                        await workflow.pause({ force: true });
                        state.pausedForRevision.push(otherWorkflowId);
                        this.log(`   ⏸️  Force-paused ${otherWorkflowId.substring(0, 8)}`);
                        
                        const taskId = state.workflowToTaskMap.get(otherWorkflowId);
                        if (taskId) {
                            taskManager.updateTaskStage(`${sessionId}_${taskId}`, 'deferred', 'Paused due to conflict');
                        }
                    }
                }
                state.isRevising = true;
                break;
            }
            
            case 'wait_for_others': {
                taskManager.registerWaitingForConflicts(
                    workflowId,
                    taskIds,
                    [...new Set(occupiedTasks.map(o => o.occupyingWorkflowId))]
                );
                const workflow = state.workflows.get(workflowId);
                if (workflow && workflow.getStatus() === 'running') {
                    await workflow.pause();
                }
                break;
            }
            
            case 'abort_if_occupied': {
                const workflow = state.workflows.get(workflowId);
                if (workflow) {
                    await workflow.cancel();
                    this.log(`   ❌ Aborted ${workflowId.substring(0, 8)}`);
                }
                break;
            }
        }
        
        state.updatedAt = new Date().toISOString();
        this._onSessionStateChanged.fire(sessionId);
    }
    
    /**
     * Resume workflows waiting for released tasks
     */
    private async resumeWaitingWorkflows(sessionId: string, releasedTaskIds: string[]): Promise<void> {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        
        const taskManager = ServiceLocator.resolve(TaskManager);
        const waitingWorkflows = taskManager.getWaitingWorkflows();
        const canProceed = taskManager.checkWaitingWorkflows(releasedTaskIds);
        
        for (const workflowId of canProceed) {
            const workflow = state.workflows.get(workflowId);
            const waitInfo = waitingWorkflows.get(workflowId);
            
            if (workflow?.getStatus() === 'paused' && waitInfo) {
                workflow.onConflictsResolved?.(waitInfo.conflictingTaskIds);
                await workflow.resume();
                this.log(`   ▶️  Resumed ${workflowId.substring(0, 8)}`);
            }
        }
    }
    
    
    // =========================================================================
    // INTERNAL HELPERS
    // =========================================================================
    
    /**
     * Subscribe to workflow events
     */
    private subscribeToWorkflow(workflow: IWorkflow, sessionId: string): void {
        // Progress updates
        workflow.onProgress.event((progress) => {
            this._onWorkflowProgress.fire(progress);
        });
        
        // Completion
        workflow.onComplete.event((result) => {
            this.handleWorkflowComplete(sessionId, workflow.id, result);
        });
        
        // Agent requests
        workflow.onAgentNeeded.event((request) => {
            this.handleAgentRequest(request);
        });
        
        // Agent releases
        workflow.onAgentReleased.event((agentName) => {
            this.handleAgentReleased(agentName);
        });
        
        // Task occupancy declared - inline delegation to TaskManager
        workflow.onTaskOccupancyDeclared.event((occupancy) => {
            const taskManager = ServiceLocator.resolve(TaskManager);
            taskManager.declareTaskOccupancy(workflow.id, occupancy.taskIds, occupancy.type, occupancy.reason);
        });
        
        // Task occupancy released - inline delegation + resume waiting workflows
        workflow.onTaskOccupancyReleased.event((taskIds) => {
            const taskManager = ServiceLocator.resolve(TaskManager);
            taskManager.releaseTaskOccupancy(workflow.id, taskIds);
            this.resumeWaitingWorkflows(sessionId, taskIds);
        });
        
        // Task conflicts declared - complex handling
        workflow.onTaskConflictDeclared.event((conflict) => {
            this.handleTaskConflictDeclared(sessionId, workflow.id, conflict);
        });
    }
    
    /**
     * Start a workflow (async, doesn't block)
     */
    private async startWorkflow(workflow: IWorkflow, sessionId: string): Promise<void> {
        try {
            await workflow.start();
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.log(`Workflow ${workflow.id} failed: ${errorMsg}`);
        }
    }
    
    /**
     * Handle workflow completion
     */
    private handleWorkflowComplete(
        sessionId: string, 
        workflowId: string, 
        result: WorkflowResult
    ): void {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        
        // Move to completed
        state.completedWorkflowIds.push(workflowId);
        state.updatedAt = new Date().toISOString();
        
        this.log(`Workflow ${workflowId.substring(0,8)} completed: ${result.success ? 'SUCCESS' : 'FAILED'}`);
        
        // Sync task stage with global TaskManager
        const taskId = state.workflowToTaskMap.get(workflowId);
        const workflow = state.workflows.get(workflowId);
        const taskManager = ServiceLocator.resolve(TaskManager);
        const globalTaskId = taskId ? `${sessionId}_${taskId}` : undefined;
        
        if (globalTaskId) {
            if (result.success) {
                taskManager.updateTaskStage(globalTaskId, 'completed', 'Workflow completed successfully');
                
                // Clear from failed tasks if it was previously failed and now succeeded
                taskManager.clearFailedTask(sessionId, taskId!);
            } else {
                taskManager.updateTaskStage(globalTaskId, 'failed', result.error || 'Workflow failed');
                
                // Track as failed task (via TaskManager)
                this.trackFailedTask(sessionId, taskId!, workflowId, result.error || 'Unknown error');
            }
        }
        
        // Update history with outcome
        this.updateHistoryOutcome(sessionId, workflowId, result.success, result.error);
        
        // Release any task occupancy held by this workflow (via TaskManager)
        taskManager.releaseAllTaskOccupancy(workflowId);
        
        // Fire event
        this._onWorkflowComplete.fire({ sessionId, workflowId, result });
        
        // Handle revision workflow completion (cleanup legacy state)
        // Note: workflow variable already declared above
        if (workflow?.type === 'planning_revision') {
            state.isRevising = false;
            state.revisionState = undefined;
            this.log(`Revision complete, resuming paused workflows`);
            
            // Resume any workflows that were paused for revision
            this.resumePendingWorkflows(sessionId);
        }
        
        // Check if all workflows are complete
        this.checkSessionCompletion(sessionId);
        
        // Clean up old completed workflows to prevent memory growth
        this.cleanupCompletedWorkflows(sessionId);
        
        this._onSessionStateChanged.fire(sessionId);
        
        // Trigger AI Coordinator re-evaluation to dispatch next tasks
        // (Do this async to not block the completion handler)
        const eventType = result.success ? 'workflow_completed' : 'workflow_failed';
        const payload = result.success 
            ? {
                type: 'workflow_completed' as const,
                workflowId,
                workflowType: workflow?.type || 'task_implementation',
                taskId,
                result: result.output,
                duration: result.duration
            } as WorkflowCompletedPayload
            : (() => {
                const failedTask = taskManager.getFailedTask(sessionId, taskId!);
                return {
                    type: 'workflow_failed' as const,
                    workflowId,
                    workflowType: workflow?.type || 'task_implementation',
                    taskId,
                    error: result.error || 'Unknown error',
                    attempts: failedTask?.attempts || 1,
                    canRetry: failedTask?.canRetry || false
                } as WorkflowFailedPayload;
            })();
        
        // Trigger async (don't await)
        this.triggerCoordinatorEvaluation(sessionId, eventType, payload).catch(e => {
            this.log(`Failed to trigger coordinator re-evaluation: ${e}`);
        });
    }
    
    /**
     * Resume pending workflows after revision
     * 
     * Workflows that were paused because their tasks were affected will resume.
     * Workflows for tasks that were REMOVED by the revision will be cancelled.
     */
    private async resumePendingWorkflows(sessionId: string): Promise<void> {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        
        const session = this.stateManager.getPlanningSession(sessionId);
        const planPath = session?.currentPlanPath;
        
        // Get the updated task list from the revised plan
        let currentTaskIds = new Set<string>();
        if (planPath) {
            const planCache = ServiceLocator.resolve(PlanCache);
            const plan = planCache.getPlan(planPath);
            for (const tasks of Object.values(plan.engineerChecklists)) {
                for (const task of tasks) {
                    currentTaskIds.add(task.id);
                }
            }
        }
        
        this.log(`\n📋 Resuming workflows after revision (${state.pausedForRevision.length} paused)`);
        
        // Resume or cancel paused workflows based on whether their tasks still exist
        for (const workflowId of state.pausedForRevision) {
            const workflow = state.workflows.get(workflowId);
            if (!workflow || workflow.getStatus() !== 'paused') continue;
            
            const taskId = state.workflowToTaskMap.get(workflowId);
            
            if (taskId && currentTaskIds.has(taskId)) {
                // Task still exists - resume the workflow
                await workflow.resume();
                this.log(`   ▶️  Resumed workflow for task ${taskId}`);
                
                // Sync task stage with global TaskManager - back to implementing
                const taskManager = ServiceLocator.resolve(TaskManager);
                taskManager.updateTaskStage(`${sessionId}_${taskId}`, 'implementing', 'Resumed after revision');
            } else if (taskId) {
                // Task was removed by revision - cancel the workflow
                await workflow.cancel();
                this.log(`   ❌ Cancelled workflow for removed task ${taskId}`);
                
                // Task was removed, no need to update stage
            } else {
                // Unknown task - resume to be safe
                await workflow.resume();
                this.log(`   ▶️  Resumed workflow ${workflowId} (unknown task)`);
            }
        }
        
        state.pausedForRevision = [];
        
        // Clear revision state
        state.revisionState = undefined;
        
        // Re-dispatch any pending workflows for tasks that still exist
        const pendingToDispatch = [...state.pendingWorkflowIds];
        state.pendingWorkflowIds = [];
        
        this.log(`   📤 Re-dispatching ${pendingToDispatch.length} pending workflows`);
        
        for (const pendingId of pendingToDispatch) {
            const taskId = state.workflowToTaskMap.get(pendingId);
            
            if (taskId && !currentTaskIds.has(taskId)) {
                // Task was removed - don't dispatch
                this.log(`   ⏭️  Skipping removed task ${taskId}`);
                continue;
            }
            
            // Re-dispatch happens via AI Coordinator's next evaluation cycle
            // when it detects ready tasks without active workflows
            this.log(`   📋 Task ${taskId || pendingId} ready for next dispatch cycle`);
        }
        
        this._onSessionStateChanged.fire(sessionId);
    }
    
    /**
     * Track a failed task - delegates to TaskManager
     */
    private trackFailedTask(
        sessionId: string,
        taskId: string,
        workflowId: string,
        errorMessage: string
    ): void {
        const taskManager = ServiceLocator.resolve(TaskManager);
        taskManager.trackFailedTask(sessionId, taskId, workflowId, errorMessage);
    }
    
    /**
     * Get failed tasks for a session - delegates to TaskManager
     */
    getFailedTasks(sessionId: string): FailedTask[] {
        const taskManager = ServiceLocator.resolve(TaskManager);
        return taskManager.getFailedTasks(sessionId);
    }
    
    /**
     * Retry a failed task
     * 
     * Creates a new task implementation workflow for the failed task.
     * The failed task is removed from the failed list.
     * 
     * @returns The new workflow ID, or null if the task can't be retried
     */
    async retryFailedTask(sessionId: string, taskId: string): Promise<string | null> {
        const taskManager = ServiceLocator.resolve(TaskManager);
        
        const failedTask = taskManager.getFailedTask(sessionId, taskId);
        if (!failedTask) {
            this.log(`Cannot retry task: ${taskId} not found in failed tasks`);
            return null;
        }
        
        if (!failedTask.canRetry) {
            this.log(`Cannot retry task: ${taskId} is marked as non-retriable`);
            console.warn(`[Coordinator] Task "${taskId}" cannot be retried (permanent error).`);
            return null;
        }
        
        // Get the plan path
        const session = this.stateManager.getPlanningSession(sessionId);
        if (!session?.currentPlanPath) {
            this.log(`Cannot retry task: no plan path for session ${sessionId}`);
            return null;
        }
        
        // Remove from failed tasks and update stage
        taskManager.clearFailedTask(sessionId, taskId);
        taskManager.updateTaskStage(`${sessionId}_${taskId}`, 'pending', 'Queued for retry');
        
        // Dispatch a new workflow for the task
        const input: TaskImplementationInput = {
            taskId,
            taskDescription: failedTask.description,
            dependencies: [],  // Dependencies may have changed, let workflow figure it out
            planPath: session.currentPlanPath
        };
        
        try {
            const workflowId = await this.dispatchWorkflow(
                sessionId,
                'task_implementation',
                input,
                { priority: 5 }  // Higher priority for retry
            );
            
            this.log(`✅ Retrying task "${taskId}"...`);
            return workflowId;
            
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.log(`❌ Failed to retry task ${taskId}: ${errorMsg}`);
            console.error(`[Coordinator] Failed to retry task: ${errorMsg}`);
            return null;
        }
    }
    
    /**
     * Check if all workflows in a session are complete
     */
    private checkSessionCompletion(sessionId: string): void {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        
        const taskManager = ServiceLocator.resolve(TaskManager);
        
        // Check if all workflows are done
        let allWorkflowsComplete = true;
        for (const workflow of state.workflows.values()) {
            const status = workflow.getStatus();
            if (status !== 'completed' && status !== 'cancelled' && status !== 'failed') {
                allWorkflowsComplete = false;
                break;
            }
        }
        
        // Also check TaskManager for any remaining tasks
        const taskProgress = taskManager.getProgressForSession(sessionId);
        const allTasksComplete = (
            taskProgress.pending === 0 && 
            taskProgress.inProgress === 0 &&
            taskProgress.ready === 0
        );
        
        // Only mark complete if BOTH workflows AND tasks are done
        const isSessionComplete = (
            (allWorkflowsComplete && state.workflows.size > 0) || 
            (allTasksComplete && taskProgress.total > 0)
        ) && allWorkflowsComplete && allTasksComplete;
        
        if (isSessionComplete) {
            const session = this.stateManager.getPlanningSession(sessionId);
            if (session) {
                session.status = 'completed';
                session.updatedAt = new Date().toISOString();
                this.stateManager.savePlanningSession(session);
                this.log(`Session ${sessionId} completed (workflows: ${state.workflows.size} done, tasks: ${taskProgress.completed}/${taskProgress.total} complete)`);
            }
            
            // Clean up TaskManager (but don't unregister ERROR_RESOLUTION - it lives forever)
            if (sessionId !== ERROR_RESOLUTION_SESSION_ID) {
                taskManager.unregisterSession(sessionId);
            }
        }
    }
    
    /**
     * Clean up completed workflow instances to free memory
     * Keeps workflow IDs in completedWorkflowIds for history, but removes the
     * actual workflow instances which can hold significant state.
     * 
     * Called after workflow completion to prevent memory growth during long sessions.
     */
    private cleanupCompletedWorkflows(sessionId: string): void {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        
        let cleaned = 0;
        const now = Date.now();
        const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
        
        for (const [workflowId, workflow] of state.workflows) {
            const status = workflow.getStatus();
            if (status === 'completed' || status === 'cancelled' || status === 'failed') {
                // Check age - only cleanup if completed more than an hour ago
                // This keeps recent completions available for inspection
                const progress = workflow.getProgress();
                const completedAt = new Date(progress.updatedAt).getTime();
                
                if (now - completedAt > MAX_AGE_MS) {
                    state.workflows.delete(workflowId);
                    cleaned++;
                }
            }
        }
        
        if (cleaned > 0) {
            this.log(`Cleaned up ${cleaned} old completed workflows for session ${sessionId}`);
        }
    }
    
    /**
     * Log message to output channel
     */
    private log(message: string): void {
        this.outputManager.log('COORD', message);
    }
    
    // =========================================================================
    // SESSION RECOVERY
    // =========================================================================
    
    /**
     * Recover paused workflows for a session after extension restart
     * 
     * This should be called during extension activation for any session
     * that was in 'executing' or 'paused' state when the extension was deactivated.
     * 
     * @param sessionId The session to recover
     * @returns Number of workflows recovered
     */
    async recoverSession(sessionId: string): Promise<number> {
        const session = this.stateManager.getPlanningSession(sessionId);
        if (!session) {
            this.log(`Cannot recover session ${sessionId} - not found`);
            return 0;
        }
        
        // Load paused workflow states from disk
        const { WorkflowPauseManager } = await import('./workflows/WorkflowPauseManager');
        const pauseManager = ServiceLocator.resolve(WorkflowPauseManager);
        pauseManager.setStateManager(this.stateManager);
        
        const pausedStates = await pauseManager.loadAllSavedStates(sessionId);
        
        if (pausedStates.size === 0) {
            this.log(`No paused workflows found for session ${sessionId}`);
            return 0;
        }
        
        this.log(`Recovering ${pausedStates.size} paused workflow(s) for session ${sessionId}`);
        
        // Initialize session state if needed
        if (!this.sessions.has(sessionId)) {
            this.initSession(sessionId);
        }
        
        const state = this.sessions.get(sessionId)!;
        let recoveredCount = 0;
        
        // Get workflow services
        const services: WorkflowServices = {
            stateManager: this.stateManager,
            agentPoolService: this.agentPoolService,
            roleRegistry: this.roleRegistry,
            unityManager: this.unityManager,
            outputManager: this.outputManager,
            unityEnabled: this.unityEnabled
        };
        
        for (const [workflowId, savedState] of pausedStates) {
            try {
                // Check if workflow type is registered
                const workflowType = savedState.workflowType as WorkflowType;
                if (!this.workflowRegistry.has(workflowType)) {
                    this.log(`  ⚠️ Unknown workflow type: ${workflowType}`);
                    continue;
                }
                
                // Log recovery info
                this.log(`  📋 Recovering ${workflowType} workflow ${workflowId.substring(0, 8)}`);
                this.log(`     Phase: ${savedState.phaseName} (${savedState.phaseProgress})`);
                if (savedState.taskId) {
                    this.log(`     Task: ${savedState.taskId}`);
                }
                
                // Reconstruct workflow input from saved state
                const input = this.reconstructWorkflowInput(workflowType, savedState, session);
                if (!input) {
                    this.log(`  ⚠️ Could not reconstruct input for ${workflowType}`);
                    continue;
                }
                
                // Create workflow config with the SAME ID as before
                const config: WorkflowConfig = {
                    id: workflowId,  // Use original workflow ID
                    type: workflowType,
                    sessionId,
                    priority: 10,  // Default priority
                    input
                };
                
                // Create workflow instance
                const workflow = this.workflowRegistry.create(workflowType, config, services);
                
                // Restore state from saved state
                const baseWorkflow = workflow as import('./workflows/BaseWorkflow').BaseWorkflow;
                if (typeof baseWorkflow.restoreFromSavedState === 'function') {
                    baseWorkflow.restoreFromSavedState({
                        phaseIndex: savedState.phaseIndex,
                        phaseName: savedState.phaseName,
                        phaseProgress: savedState.phaseProgress,
                        filesModified: savedState.filesModified,
                        continuationContext: savedState.agentPartialOutput ? {
                            phaseName: savedState.phaseName,
                            partialOutput: savedState.agentPartialOutput,
                            filesModified: savedState.filesModified,
                            whatWasDone: savedState.whatWasDone
                        } : undefined
                    });
                }
                
                // Subscribe to workflow events
                this.subscribeToWorkflow(workflow, sessionId);
                
                // Track workflow
                state.workflows.set(workflowId, workflow);
                
                // Track task ID for task_implementation workflows
                if (workflowType === 'task_implementation' && savedState.taskId) {
                    state.workflowToTaskMap.set(workflowId, savedState.taskId);
                }
                
                recoveredCount++;
                this.log(`  ✅ Workflow reconstructed and ready for resume`);
                
            } catch (e) {
                this.log(`  ❌ Failed to recover workflow ${workflowId}: ${e}`);
            }
        }
        
        if (recoveredCount > 0) {
            // Update session status
            session.status = 'paused';
            session.updatedAt = new Date().toISOString();
            this.stateManager.savePlanningSession(session);
            
            this.log(`Recovered ${recoveredCount} workflow(s) - ready for resume`);
            this._onSessionStateChanged.fire(sessionId);
        }
        
        return recoveredCount;
    }
    
    /**
     * Reconstruct workflow input from saved state
     */
    private reconstructWorkflowInput(
        workflowType: WorkflowType,
        savedState: import('./workflows/WorkflowPauseManager').SavedWorkflowState,
        session: import('../types').PlanningSession
    ): Record<string, any> | null {
        switch (workflowType) {
            case 'planning_new':
                return {
                    requirement: session.requirement || '',
                    docs: []
                };
                
            case 'planning_revision':
                return {
                    requirement: session.requirement || '',
                    existingPlanPath: session.currentPlanPath,
                    userFeedback: '' // Lost during restart, but workflow can continue
                };
                
            case 'task_implementation':
                if (!savedState.taskId) return null;
                return {
                    taskId: savedState.taskId,
                    taskDescription: '',  // Will be reconstructed from plan
                    dependencies: [],
                    planPath: session.currentPlanPath || ''
                };
                
            case 'error_resolution':
                return {
                    errors: [],  // Will need to be reconstructed from TaskManager
                    coordinatorId: savedState.sessionId
                };
                
            default:
                return null;
        }
    }
    
    /**
     * Recover all sessions that were active when extension was deactivated
     */
    async recoverAllSessions(): Promise<number> {
        let totalRecovered = 0;
        
        const sessions = this.stateManager.getAllPlanningSessions();
        for (const session of sessions) {
            // Only try to recover sessions that were in active states
            if (session.status === 'executing' || session.status === 'paused') {
                const recovered = await this.recoverSession(session.id);
                totalRecovered += recovered;
            }
        }
        
        return totalRecovered;
    }
    
    // =========================================================================
    // AI COORDINATOR AGENT
    // =========================================================================
    
    /**
     * Trigger AI Coordinator evaluation for an event
     * 
     * Delegates to CoordinatorAgent which handles debouncing, event batching,
     * and evaluation. Decisions are executed asynchronously via callback.
     */
    async triggerCoordinatorEvaluation(
        sessionId: string,
        eventType: CoordinatorEventType,
        payload: any
    ): Promise<CoordinatorDecision | null> {
        // Ensure session exists
        if (!this.sessions.has(sessionId)) {
            this.initSession(sessionId);
        }
        
        // Delegate to CoordinatorAgent which handles debouncing and batching
        this.coordinatorAgent.queueEvent(
            sessionId,
            eventType,
            payload,
            async (sid, event) => this.buildCoordinatorInput(sid, event)
        );
        
        // Always return null - decisions are made asynchronously via callback
        return null;
    }
    
    /**
     * Build coordinator input context for AI evaluation
     */
    private async buildCoordinatorInput(
        sessionId: string,
        event: CoordinatorEvent
    ): Promise<CoordinatorInput> {
        const state = this.sessions.get(sessionId);
        
        const sessionSnapshot = state ? {
            sessionId: state.sessionId,
            workflows: state.workflows,
            workflowToTaskMap: state.workflowToTaskMap,
            coordinatorHistory: state.coordinatorHistory,
            pendingQuestions: state.pendingQuestions
        } : undefined;
        
        return this.coordinatorContext.buildInput(sessionId, event, sessionSnapshot);
    }
    
    /**
     * Log decision to session history (called from decision callback)
     */
    private logDecisionToHistory(sessionId: string, decision: CoordinatorDecision): void {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        
        // Use coordinatorAgent to create the history entry
        // Note: We don't have the original event here, so we use a summary placeholder
        const entry: CoordinatorHistoryEntry = {
            timestamp: new Date().toISOString(),
            event: {
                type: 'manual_evaluation',  // Placeholder - actual type was in batch
                summary: `Decision with ${decision.dispatch.length} dispatches`
            },
            decision: {
                dispatchCount: decision.dispatch.length,
                dispatchedTasks: decision.dispatch.map(d => d.taskId),
                askedUser: !!decision.askUser,
                pausedCount: decision.pauseTasks.length,
                resumedCount: decision.resumeTasks.length,
                reasoning: decision.reasoning
            }
        };
        
        state.coordinatorHistory.push(entry);
        
        // Keep history bounded
        const maxHistory = 50;
        if (state.coordinatorHistory.length > maxHistory) {
            state.coordinatorHistory = state.coordinatorHistory.slice(-maxHistory);
        }
        
        // Persist history to disk for recovery across restarts
        this.stateManager.saveCoordinatorHistory(sessionId, state.coordinatorHistory);
        
        this.log(`Logged coordinator decision: ${entry.decision.dispatchCount} dispatches, reasoning: ${decision.reasoning.substring(0, 100)}...`);
    }
    
    /**
     * Update history with outcome when workflow completes
     */
    updateHistoryOutcome(
        sessionId: string,
        workflowId: string,
        success: boolean,
        notes?: string
    ): void {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        
        const taskId = state.workflowToTaskMap.get(workflowId);
        if (!taskId) return;
        
        for (let i = state.coordinatorHistory.length - 1; i >= 0; i--) {
            const entry = state.coordinatorHistory[i];
            if (entry.decision.dispatchedTasks.includes(taskId) && !entry.outcome) {
                entry.outcome = {
                    success,
                    notes,
                    completedAt: new Date().toISOString()
                };
                break;
            }
        }
    }
    
    /**
     * Execute the coordinator's decision
     */
    private async executeCoordinatorDecision(
        sessionId: string,
        decision: CoordinatorDecision
    ): Promise<void> {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        
        // 1. Pause tasks
        if (decision.pauseTasks.length > 0) {
            const taskManager = ServiceLocator.resolve(TaskManager);
            taskManager.pauseTasksAndDependents(decision.pauseTasks, 'Coordinator decision');
            this.log(`Paused ${decision.pauseTasks.length} tasks`);
        }
        
        // 2. Resume tasks
        if (decision.resumeTasks.length > 0) {
            const taskManager = ServiceLocator.resolve(TaskManager);
            for (const taskId of decision.resumeTasks) {
                // Set back to pending - the coordinator will re-evaluate and dispatch
                taskManager.updateTaskStage(taskId, 'pending', 'Resumed by coordinator');
            }
            this.log(`Resumed ${decision.resumeTasks.length} tasks`);
        }
        
        // 3. Create error tasks
        if (decision.createErrorTasks.length > 0) {
            const taskManager = ServiceLocator.resolve(TaskManager);
            const errorInfos: ErrorInfo[] = decision.createErrorTasks.map(e => ({
                id: e.errorId,
                message: e.errorMessage,
                file: e.file
            }));
            const affectedIds = decision.createErrorTasks.flatMap(e => e.affectedTaskIds);
            taskManager.createErrorFixingTasks(errorInfos, affectedIds);
            this.log(`Created ${decision.createErrorTasks.length} error tasks`);
        }
        
        // 4. Ask user (store question for UI to display)
        if (decision.askUser) {
            state.pendingQuestions.push({
                id: decision.askUser.questionId,
                question: decision.askUser.question,
                context: decision.askUser.context,
                askedAt: new Date().toISOString(),
                relatedTaskId: decision.askUser.relatedTaskId
            });
            this.log(`Asked user: ${decision.askUser.question}`);
            
            // Fire state change to notify UI of pending question
            this._onSessionStateChanged.fire(sessionId);
        }
        
        // 5. Dispatch workflows
        for (const dispatch of decision.dispatch) {
            try {
                const session = this.stateManager.getPlanningSession(sessionId);
                await this.dispatchWorkflow(
                    sessionId,
                    dispatch.workflowType,
                    {
                        taskId: dispatch.taskId,
                        taskDescription: dispatch.context || '',
                        dependencies: [],
                        planPath: session?.currentPlanPath || ''
                    },
                    { priority: dispatch.priority }
                );
                this.log(`Dispatched ${dispatch.workflowType} for task ${dispatch.taskId}`);
            } catch (e) {
                this.log(`Failed to dispatch for task ${dispatch.taskId}: ${e}`);
            }
        }
        
        this._onSessionStateChanged.fire(sessionId);
    }
    
    // =========================================================================
    // AGENT CLI COMPLETION SIGNALS
    // =========================================================================
    
    /**
     * Signal agent completion from CLI callback
     * 
     * Called by CliHandler when an agent calls:
     *   apc agent complete --session <s> --workflow <w> --stage <stage> --result <r> --data '<json>'
     * 
     * @param signal The completion signal from the agent
     * @returns true if signal was delivered to a waiting workflow, false otherwise
     */
    signalAgentCompletion(signal: AgentCompletionSignal): boolean {
        const key = `${signal.workflowId}_${signal.stage}`;
        const pending = this.completionSignals.get(key);
        
        if (pending) {
            // Clear timeout
            clearTimeout(pending.timeoutId);
            
            // Add timestamp
            signal.timestamp = new Date().toISOString();
            
            // Resolve the waiting promise
            pending.resolve(signal);
            this.completionSignals.delete(key);
            
            this.log(`✓ Agent completion signal delivered: ${signal.workflowId.substring(0, 8)}/${signal.stage} → ${signal.result}`);
            return true;
        } else {
            // No one waiting for this signal - log but don't error
            this.log(`⚠️ Agent completion signal received but no workflow waiting: ${signal.workflowId.substring(0, 8)}/${signal.stage}`);
            return false;
        }
    }
    
    /**
     * Wait for agent completion signal from CLI
     * 
     * Called by workflows to wait for agent CLI callback.
     * Returns when agent calls `apc agent complete` or timeout occurs.
     * 
     * @param workflowId The workflow waiting for completion
     * @param stage The stage to wait for (implementation, review, etc.)
     * @param timeoutMs Timeout in milliseconds (default 10 minutes)
     * @returns Promise that resolves with the completion signal
     */
    waitForAgentCompletion(
        workflowId: string,
        stage: string,
        timeoutMs: number = 600000
    ): Promise<AgentCompletionSignal> {
        return new Promise((resolve, reject) => {
            const key = `${workflowId}_${stage}`;
            
            // Check if already waiting
            if (this.completionSignals.has(key)) {
                reject(new Error(`Already waiting for completion signal: ${key}`));
                return;
            }
            
            // Set up timeout
            const timeoutId = setTimeout(() => {
                this.completionSignals.delete(key);
                reject(new Error(`Timeout waiting for agent completion: ${stage} (${timeoutMs}ms)`));
            }, timeoutMs);
            
            // Register the pending signal
            this.completionSignals.set(key, {
                stage,
                resolve,
                reject,
                timeoutId
            });
            
            this.log(`⏳ Waiting for agent completion: ${workflowId.substring(0, 8)}/${stage}`);
        });
    }
    
    /**
     * Cancel a pending completion signal wait
     * 
     * Called when a workflow is cancelled or paused before receiving signal.
     * 
     * @param workflowId The workflow ID
     * @param stage The stage (optional - cancels all if not specified)
     */
    cancelPendingSignal(workflowId: string, stage?: string): void {
        if (stage) {
            const key = `${workflowId}_${stage}`;
            const pending = this.completionSignals.get(key);
            if (pending) {
                clearTimeout(pending.timeoutId);
                pending.reject(new Error('Signal wait cancelled'));
                this.completionSignals.delete(key);
            }
        } else {
            // Cancel all signals for this workflow
            for (const [key, pending] of this.completionSignals) {
                if (key.startsWith(`${workflowId}_`)) {
                    clearTimeout(pending.timeoutId);
                    pending.reject(new Error('Signal wait cancelled'));
                    this.completionSignals.delete(key);
                }
            }
        }
    }
    
    /**
     * Check if there's a pending signal wait for a workflow/stage
     */
    hasPendingSignal(workflowId: string, stage: string): boolean {
        return this.completionSignals.has(`${workflowId}_${stage}`);
    }
    
    // =========================================================================
    // CLEANUP
    // =========================================================================
    
    /**
     * Dispose all resources
     */
    dispose(): void {
        // Cancel all pending completion signals
        for (const [key, pending] of this.completionSignals) {
            clearTimeout(pending.timeoutId);
            pending.reject(new Error('Service disposed'));
        }
        this.completionSignals.clear();
        // Dispose coordinator agent (clears debounce timer)
        this.coordinatorAgent.dispose();
        
        // Cancel all active workflows
        for (const [sessionId, state] of this.sessions) {
            for (const workflow of state.workflows.values()) {
                workflow.dispose();
            }
        }
        
        this.sessions.clear();
        this.agentRequestQueue = [];
        
        this._onWorkflowProgress.dispose();
        this._onWorkflowComplete.dispose();
        this._onSessionStateChanged.dispose();
    }
}

