// ============================================================================
// UnifiedCoordinatorService - Central coordinator for all workflows
// ============================================================================

import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { TypedEventEmitter } from './TypedEventEmitter';
import { StateManager } from './StateManager';
import { AgentPoolService } from './AgentPoolService';
import { AgentRoleRegistry } from './AgentRoleRegistry';
import { UnityControlManager } from './UnityControlManager';
import { OutputChannelManager } from './OutputChannelManager';
import { ServiceLocator } from './ServiceLocator';
import { Logger } from '../utils/Logger';

const log = Logger.create('Daemon', 'Coordinator');
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
    CompletedWorkflowSummary,
    TaskImplementationInput,
    RevisionState,
    FailedTask,
    AgentCompletionSignal
} from '../types/workflow';
// PlanCache removed - tasks are now managed via TaskManager, not parsed from plan
import { TaskManager, ERROR_RESOLUTION_SESSION_ID } from './TaskManager';
import { EventBroadcaster } from '../daemon/EventBroadcaster';
import { CoordinatorAgent, CoordinatorStatus } from './CoordinatorAgent';
import { CoordinatorContext } from './CoordinatorContext';
import { getMemoryMonitor } from './MemoryMonitor';
import { WorkflowHistoryService } from './WorkflowHistoryService';
import { SavedWorkflowState } from './workflows/WorkflowPauseManager';
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
 * Archived workflow metadata (lightweight)
 */
interface ArchivedWorkflow {
    id: string;
    type: WorkflowType;
    status: 'completed' | 'failed' | 'cancelled';
    taskId?: string;
    startedAt: string;
    completedAt: string;
    archivedAt: string;
}

/**
 * Session state for tracking workflows
 */
interface SessionState {
    sessionId: string;
    workflows: Map<string, IWorkflow>;
    pendingWorkflowIds: string[];
    completedWorkflowIds: string[];
    workflowHistory: CompletedWorkflowSummary[];  // Completed workflow summaries (newest first)
    createdAt: string;
    updatedAt: string;
    
    // === Archived Workflows ===
    archivedWorkflows: Map<string, ArchivedWorkflow>;  // Lightweight workflow metadata after cleanup
    
    // === Event Listener Cleanup ===
    // Track event listener disposables to prevent memory leaks
    workflowDisposables: Map<string, Array<{ dispose: () => void }>>;
    
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
    private historyService: WorkflowHistoryService;
    
    /** Whether Unity features are enabled */
    private unityEnabled: boolean = true;
    
    // Workflow management
    private workflowRegistry: WorkflowRegistry;
    private sessions: Map<string, SessionState> = new Map();
    private agentRequestQueue: AgentRequest[] = [];
    private processingQueue: boolean = false;  // Guard to prevent concurrent queue processing
    
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
    
    private readonly _onAgentAllocated = new TypedEventEmitter<{ agentName: string; sessionId: string; roleId: string; workflowId: string }>();
    readonly onAgentAllocated = this._onAgentAllocated.event;
    
    private readonly _onCoordinatorStatusChanged = new TypedEventEmitter<CoordinatorStatus>();
    readonly onCoordinatorStatusChanged = this._onCoordinatorStatusChanged.event;
    
    // AI Coordinator Agent (handles debouncing, evaluation, and history)
    private coordinatorAgent: CoordinatorAgent;
    private coordinatorContext: CoordinatorContext;
    
    // Periodic cleanup timer
    private cleanupTimerId: NodeJS.Timeout | null = null;
    private readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    
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
        
        // Initialize workflow history service
        this.historyService = new WorkflowHistoryService(this.stateManager.getWorkspaceRoot());
        
        // Create workflow registry with all built-in types
        this.workflowRegistry = createWorkflowRegistry();
        
        // Create the AI Coordinator Agent with access to role registry for customizable prompts
        this.coordinatorAgent = new CoordinatorAgent({}, this.roleRegistry);
        
        // Give coordinator agent access to workflow registry for dynamic prompt injection
        this.coordinatorAgent.setWorkflowRegistry(this.workflowRegistry);
        this.coordinatorAgent.setUnityEnabled(this.unityEnabled);
        this.coordinatorAgent.setWorkspaceRoot(this.stateManager.getWorkspaceRoot());
        
        // Set up decision callback - just logs to history
        // (AI executes commands directly via run_terminal_cmd)
        this.coordinatorAgent.setExecuteDecisionCallback(async (sessionId, decision) => {
            // Log to history for tracking
            this.logDecisionToHistory(sessionId, decision);
        });
        
        // Forward coordinator state changes to service-level event
        this.coordinatorAgent.onStateChanged((status) => {
            this._onCoordinatorStatusChanged.fire(status);
        });
        
        // Create the context builder for AI evaluations
        this.coordinatorContext = new CoordinatorContext(this.stateManager, this.agentPoolService);
        
        // Register with memory monitor
        const memMonitor = getMemoryMonitor();
        memMonitor.registerService('UnifiedCoordinatorService', () => ({
            sessionCount: this.sessions.size,
            totalWorkflows: Array.from(this.sessions.values()).reduce((sum, s) => sum + s.workflows.size, 0),
            completionSignals: this.completionSignals.size,
            agentRequestQueue: this.agentRequestQueue.length
        }));
        
        // Start periodic cleanup
        this.startPeriodicCleanup();
        
        this.log('UnifiedCoordinatorService initialized');
    }
    
    /**
     * Start periodic cleanup of completed workflows and sessions
     */
    private startPeriodicCleanup(): void {
        if (this.cleanupTimerId) {
            return; // Already running
        }
        
        this.cleanupTimerId = setInterval(() => {
            this.performPeriodicCleanup();
        }, this.CLEANUP_INTERVAL_MS);
        
        this.log(`Started periodic cleanup (interval: ${this.CLEANUP_INTERVAL_MS / 1000}s)`);
    }
    
    /**
     * Stop periodic cleanup
     */
    private stopPeriodicCleanup(): void {
        if (this.cleanupTimerId) {
            clearInterval(this.cleanupTimerId);
            this.cleanupTimerId = null;
            this.log('Stopped periodic cleanup');
        }
    }
    
    /**
     * Perform periodic cleanup across all sessions
     * Runs every 5 minutes to free memory from completed workflows and sessions
     */
    private performPeriodicCleanup(): void {
        let totalWorkflowsCleaned = 0;
        let totalSessionsCleaned = 0;
        let totalStaleReferencesCleaned = 0;
        
        // Clean up old workflows in each session
        for (const [sessionId, _state] of this.sessions) {
            const beforeSize = _state.workflows.size;
            this.cleanupCompletedWorkflows(sessionId);
            const afterSize = _state.workflows.size;
            totalWorkflowsCleaned += (beforeSize - afterSize);
            
            // Clean up stale workflow references
            totalStaleReferencesCleaned += this.cleanupStaleWorkflows(sessionId);
        }
        
        // Clean up old completed sessions
        const beforeSessionCount = this.sessions.size;
        this.cleanupCompletedSessions(4 * 60 * 60 * 1000); // 4 hours for periodic cleanup
        totalSessionsCleaned = beforeSessionCount - this.sessions.size;
        
        // Clean up orphaned session subscriptions from EventBroadcaster
        try {
            const broadcaster = ServiceLocator.resolve(EventBroadcaster);
            broadcaster.cleanupOrphanedSessions();
        } catch (e) {
            // Broadcaster may not be available in some contexts
        }
        
        // Clean up stale completion signals
        this.cleanupStaleCompletionSignals();
        
        // Log summary if anything was cleaned
        if (totalWorkflowsCleaned > 0 || totalSessionsCleaned > 0 || totalStaleReferencesCleaned > 0) {
            this.log(`Periodic cleanup: ${totalWorkflowsCleaned} workflows, ${totalSessionsCleaned} sessions, ${totalStaleReferencesCleaned} stale refs removed`);
        }
    }
    
    /**
     * Force cleanup of stale workflows for a specific session
     * Public API for manual cleanup via CLI or UI
     * 
     * @param sessionId Session to cleanup
     * @returns Number of workflows cleaned up
     */
    forceCleanupStaleWorkflows(sessionId: string): number {
        this.log(`🧹 Force cleanup triggered for session ${sessionId}`);
        
        // Run both cleanup methods
        this.cleanupCompletedWorkflows(sessionId);
        const staleCount = this.cleanupStaleWorkflows(sessionId);
        
        return staleCount;
    }
    
    /**
     * Force cleanup of stale workflows across ALL sessions
     * Public API for manual cleanup via CLI or UI
     * 
     * @returns Total number of workflows cleaned up
     */
    forceCleanupAllStaleWorkflows(): number {
        this.log(`🧹 Force cleanup triggered for ALL sessions`);
        
        let totalCleaned = 0;
        for (const [sessionId, _state] of this.sessions) {
            this.cleanupCompletedWorkflows(sessionId);
            totalCleaned += this.cleanupStaleWorkflows(sessionId);
        }
        
        return totalCleaned;
    }
    
    /**
     * Enable or disable Unity features
     * @param enabled Whether Unity features should be enabled
     * @param unityManager Unity Control Manager instance (required if enabled is true)
     */
    setUnityEnabled(enabled: boolean, unityManager?: UnityControlManager): void {
        this.unityEnabled = enabled;
        this.unityManager = enabled ? unityManager : undefined;
        
        // Update coordinator agent so it knows which workflows to include in prompts
        this.coordinatorAgent.setUnityEnabled(enabled);
        
        this.log(`Unity features ${enabled ? 'enabled' : 'disabled'}`);
    }
    
    /**
     * Check if Unity features are enabled
     */
    isUnityEnabled(): boolean {
        return this.unityEnabled;
    }
    
    /**
     * Get the current coordinator status for UI display
     */
    getCoordinatorStatus(): CoordinatorStatus {
        return this.coordinatorAgent.getStatus();
    }
    
    /**
     * Get the workflow registry (for accessing workflow metadata)
     */
    getWorkflowRegistry(): WorkflowRegistry {
        return this.workflowRegistry;
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
        const savedCoordinatorHistory = this.stateManager.loadCoordinatorHistory(sessionId);
        
        // Load any existing workflow history from disk
        const savedWorkflowHistory = this.stateManager.loadWorkflowHistory(sessionId) as CompletedWorkflowSummary[];
        
        const state: SessionState = {
            sessionId,
            workflows: new Map(),
            pendingWorkflowIds: [],
            completedWorkflowIds: [],
            workflowHistory: savedWorkflowHistory,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            
            // Archived workflows (lightweight metadata after cleanup)
            archivedWorkflows: new Map(),
            
            // Event listener disposables for cleanup
            workflowDisposables: new Map(),
            
            // Revision state tracking
            isRevising: false,
            pausedForRevision: [],
            
            // Workflow-task mapping
            workflowToTaskMap: new Map(),
            
            // AI Coordinator history (loaded from disk if available)
            coordinatorHistory: savedCoordinatorHistory,
            pendingQuestions: []
        };
        
        this.sessions.set(sessionId, state);
        const historyInfo = [];
        if (savedCoordinatorHistory.length > 0) historyInfo.push(`${savedCoordinatorHistory.length} coordinator`);
        if (savedWorkflowHistory.length > 0) historyInfo.push(`${savedWorkflowHistory.length} workflow`);
        this.log(`Session initialized: ${sessionId}${historyInfo.length > 0 ? ` (loaded ${historyInfo.join(', ')} history entries)` : ''}`);
        
        // Restore any paused workflows from disk
        this.restorePausedWorkflows(sessionId);
        
        this._onSessionStateChanged.fire(sessionId);
    }
    
    /**
     * Restore paused workflows from disk after daemon restart
     * 
     * This recreates workflow objects from their saved state and puts them
     * in a paused state, ready to be resumed by the user or coordinator.
     */
    private restorePausedWorkflows(sessionId: string): void {
        const savedStates = this.stateManager.loadAllPausedWorkflows(sessionId);
        
        if (savedStates.size === 0) {
            return;
        }
        
        this.log(`Restoring ${savedStates.size} paused workflow(s) for session ${sessionId}`);
        
        const state = this.sessions.get(sessionId);
        if (!state) return;
        
        for (const [workflowId, rawState] of savedStates) {
            const savedState = rawState as SavedWorkflowState;
            
            try {
                // Recreate the workflow using the saved input and type
                const workflowType = savedState.workflowType as WorkflowType;
                
                // Create workflow config with the original ID (so we can track it)
                const config: WorkflowConfig = {
                    id: workflowId, // Keep the same ID for tracking
                    type: workflowType,
                    sessionId,
                    priority: savedState.priority,
                    input: savedState.workflowInput
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
                
                // Create the workflow instance
                const workflow = this.workflowRegistry.create(workflowType, config, services);
                
                // Restore its phase position
                workflow.restoreFromSavedState({
                    phaseIndex: savedState.phaseIndex,
                    phaseName: savedState.phaseName,
                    phaseProgress: savedState.phaseProgress,
                    filesModified: savedState.filesModified,
                    continuationContext: savedState.continuationPrompt ? {
                        phaseName: savedState.phaseName,
                        partialOutput: savedState.agentPartialOutput || '',
                        filesModified: savedState.filesModified,
                        whatWasDone: savedState.whatWasDone
                    } : undefined
                });
                
                // Subscribe to workflow events
                this.subscribeToWorkflow(workflow, sessionId);
                
                // Track workflow
                state.workflows.set(workflowId, workflow);
                
                // Track task mapping for task_implementation workflows
                if (workflowType === 'task_implementation' && savedState.taskId) {
                    state.workflowToTaskMap.set(workflowId, savedState.taskId);
                }
                
                this.log(`  Restored workflow ${workflowId} (${workflowType}) at phase ${savedState.phaseIndex} (${savedState.phaseName})`);
                this.log(`    Allocated agents: ${savedState.allocatedAgents.join(', ') || 'none'}`);
                
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                this.log(`  Failed to restore workflow ${workflowId}: ${errorMsg}`);
                
                // Clean up the failed state file
                this.stateManager.deletePausedWorkflow(sessionId, workflowId);
            }
        }
        
        state.updatedAt = new Date().toISOString();
    }
    
    /**
     * Get session workflow state for UI
     * Auto-initializes sessions that exist in StateManager but aren't in memory,
     * unless they're completed (no need to track completed sessions in memory).
     */
    getSessionState(sessionId: string): SessionWorkflowState | undefined {
        // Auto-initialize if session exists in StateManager but not in memory
        if (!this.sessions.has(sessionId)) {
            const planningSession = this.stateManager.getPlanningSession(sessionId);
            if (planningSession) {
                if (planningSession.status !== 'completed') {
                    // Initialize non-completed sessions to track workflow state
                    this.initSession(sessionId);
                } else {
                    // For completed sessions, return minimal state with workflow history from disk
                    const savedWorkflowHistory = this.stateManager.loadWorkflowHistory(sessionId) as CompletedWorkflowSummary[];
                    return {
                        sessionId,
                        activeWorkflows: new Map(),
                        pendingWorkflows: [],
                        completedWorkflows: [],
                        workflowHistory: savedWorkflowHistory,
                        isRevising: false,
                        pausedForRevision: []
                    };
                }
            }
        }
        
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
            workflowHistory: state.workflowHistory,
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
                percentage: progress.percentage,
                taskId: state.workflowToTaskMap.get(id) // Include task ID if this is a task workflow
            });
        }
        
        return summaries;
    }
    
    /**
     * Check if a session has any paused workflows
     */
    hasPausedWorkflows(sessionId: string): boolean {
        const state = this.sessions.get(sessionId);
        if (!state) return false;
        
        for (const workflow of state.workflows.values()) {
            if (workflow.getStatus() === 'paused') {
                return true;
            }
        }
        return false;
    }
    
    /**
     * Check if a session has any active (running/pending) workflows
     */
    hasActiveWorkflows(sessionId: string): boolean {
        const state = this.sessions.get(sessionId);
        if (!state) return false;
        
        for (const workflow of state.workflows.values()) {
            const status = workflow.getStatus();
            if (status === 'running' || status === 'pending' || status === 'blocked') {
                return true;
            }
        }
        return false;
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
     * Start a workflow for a specific task (called by coordinator AI via CLI)
     * 
     * @param sessionId - The planning session
     * @param taskId - The task ID (local, not global)
     * @param workflowType - The workflow type to run
     * @returns Workflow ID
     */
    async startTaskWorkflow(sessionId: string, taskId: string, workflowType: string): Promise<string> {
        const taskManager = ServiceLocator.resolve(TaskManager);
        const globalTaskId = `${sessionId}_${taskId}`;
        
        // VALIDATION: Only start workflows for approved plans
        const session = this.stateManager.getPlanningSession(sessionId);
        if (session && session.status !== 'approved') {
            throw new Error(
                `Cannot start workflow for session ${sessionId}: Plan status is '${session.status}'. ` +
                `Workflows can only be started for approved plans. Current status must be 'approved'.`
            );
        }
        
        // Get the task
        const task = taskManager.getTask(globalTaskId);
        if (!task) {
            throw new Error(`Task ${taskId} not found in session ${sessionId}`);
        }
        
        // VALIDATION: Prevent duplicate workflows on same task
        // A task can only have ONE active workflow at a time
        if (task.currentWorkflow) {
            // Check if the workflow is still active
            const state = this.sessions.get(sessionId);
            if (state) {
                const existingWorkflow = state.workflows.get(task.currentWorkflow);
                if (existingWorkflow) {
                    const status = existingWorkflow.getStatus();
                    if (status === 'running' || status === 'pending' || status === 'blocked' || status === 'paused') {
                        throw new Error(
                            `Task ${taskId} already has an active workflow (${task.currentWorkflow}, status: ${status}). ` +
                            `Wait for it to complete before starting a new one. ` +
                            `Use 'apc task status --session ${sessionId} --task ${taskId}' to check current status.`
                        );
                    }
                }
            }
        }
        
        // VALIDATION: Check dependencies if workflow requires it
        // Some workflows (like context_gathering) can start even with incomplete dependencies
        const workflowMetadata = this.workflowRegistry.getMetadata(workflowType as WorkflowType);
        
        if (workflowMetadata?.requiresCompleteDependencies !== false) {
            // This workflow requires all dependencies to be complete
            const unmetDeps = task.dependencies.filter(depId => {
                const depTask = taskManager.getTask(depId);
                return !depTask || depTask.status !== 'completed';
            });
            
            if (unmetDeps.length > 0) {
                throw new Error(
                    `Task ${taskId} has unmet dependencies: ${unmetDeps.join(', ')}. ` +
                    `The workflow '${workflowType}' requires all dependencies to be completed first.`
                );
            }
        } else {
            this.log(`Workflow '${workflowType}' does not require complete dependencies - allowing start for task ${taskId}`);
        }
        
        // Get plan path (session already declared above)
        const planPath = session?.currentPlanPath || '';
        
        // Build workflow input based on workflow type
        let input: Record<string, any>;
        
        if (workflowType === 'task_implementation') {
            input = {
                taskId,
                taskDescription: task.description,
                dependencies: task.dependencies,
                planPath
            };
        } else if (workflowType === 'error_resolution') {
            input = {
                taskId,
                errors: task.errorText ? [task.errorText] : [],
                previousAttempts: task.previousAttempts || 0,
                previousFixSummary: task.previousFixSummary
            };
        } else {
            input = {
                taskId,
                taskDescription: task.description,
                planPath
            };
        }
        
        // Mark task as in progress
        taskManager.markTaskInProgress(globalTaskId);
        
        // Dispatch the workflow
        return this.dispatchWorkflow(sessionId, workflowType as WorkflowType, input);
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
            
            // AI executes commands directly via run_terminal_cmd
            // Return empty - task IDs are managed by TaskManager
            return [];
        }
        
        // Regular session - read plan as context (no parsing)
        const session = this.stateManager.getPlanningSession(sessionId);
        if (!session?.currentPlanPath) {
            throw new Error('No plan available for execution');
        }
        
        // Read plan content as text - coordinator will understand it and create tasks via CLI
        let planContent = '';
        try {
            planContent = fs.readFileSync(session.currentPlanPath, 'utf-8');
        } catch (e) {
            throw new Error(`Failed to read plan file: ${session.currentPlanPath}`);
        }
        
        // Register session with global TaskManager (no task initialization - coordinator does that)
        taskManager.registerSession(sessionId, session.currentPlanPath);
        
        // Update session timestamp (status stays 'approved' - workflow states are tracked separately)
        session.updatedAt = new Date().toISOString();
        this.stateManager.savePlanningSession(session);
        
        this.log(`Starting execution for session ${sessionId}`);
        this.log(`Plan content length: ${planContent.length} chars`);
        
        // Trigger AI Coordinator to:
        // 1. Read and understand the plan
        // 2. Create tasks via CLI: apc task create --session ... --id ... --desc ...
        // 3. Start workflows via CLI: apc task start --session ... --id ... --workflow ...
        const decision = await this.triggerCoordinatorEvaluation(
            sessionId,
            'execution_started',
            {
                type: 'execution_started',
                planPath: session.currentPlanPath,
                planContent,  // Pass raw plan content for coordinator to read
                taskCount: 0  // Tasks don't exist yet - coordinator creates them
            } as ExecutionStartedPayload
        );
        
        // NOTE: The Coordinator AI now executes CLI commands directly via run_terminal_cmd
        // e.g., run_terminal_cmd("apc task create --session ps_001 --id T1 --desc ...")
        // No parsing/execution needed here - AI handles it directly
        
        // Return empty - tasks are created via CLI by the coordinator
        return [];
    }
    
    
    // =========================================================================
    // WORKFLOW LIFECYCLE
    // =========================================================================
    
    /**
     * Pause all workflows in a session
     * Note: Session status is NOT changed. Workflow pause state is tracked by workflows.
     */
    async pauseSession(sessionId: string): Promise<void> {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        
        this.log(`Pausing session: ${sessionId}`);
        
        for (const workflow of state.workflows.values()) {
            const status = workflow.getStatus();
            if (status === 'running' || status === 'pending') {
                await workflow.pause();
            }
        }
        
        // Update timestamp only (status stays unchanged - workflow states tracked separately)
        const session = this.stateManager.getPlanningSession(sessionId);
        if (session) {
            session.updatedAt = new Date().toISOString();
            this.stateManager.savePlanningSession(session);
        }
        
        this._onSessionStateChanged.fire(sessionId);
    }
    
    /**
     * Resume all paused workflows in a session
     * Note: Session status is NOT changed. Workflow resume is handled by individual workflows.
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
        
        // Update timestamp only (status stays unchanged - workflow states tracked separately)
        const session = this.stateManager.getPlanningSession(sessionId);
        if (session) {
            session.updatedAt = new Date().toISOString();
            this.stateManager.savePlanningSession(session);
        }
        
        this._onSessionStateChanged.fire(sessionId);
    }
    
    /**
     * Cancel all workflows in a session
     * 
     * Handles two scenarios:
     * 1. Normal cancellation: Cancel active workflows, keep session status as-is
     * 2. Orphan session recovery: If session is in 'planning'/'revising' state but has 
     *    no active workflows (e.g., daemon was killed mid-workflow), reset to appropriate status
     */
    async cancelSession(sessionId: string): Promise<void> {
        const state = this.sessions.get(sessionId);
        const session = this.stateManager.getPlanningSession(sessionId);
        
        if (!session) {
            this.log(`Session ${sessionId} not found, nothing to cancel`);
            return;
        }
        
        const previousStatus = session.status;
        const isOrphanPlanningSession = ['planning', 'revising'].includes(previousStatus) && 
            (!state || state.workflows.size === 0);
        
        this.log(`Cancelling session: ${sessionId} (status: ${previousStatus}, hasWorkflows: ${state?.workflows.size ?? 0})`);
        
        // Cancel any active workflows if state exists
        if (state) {
            for (const workflow of state.workflows.values()) {
                const status = workflow.getStatus();
                if (status !== 'completed' && status !== 'cancelled' && status !== 'failed') {
                    await workflow.cancel();
                }
            }
        }
        
        // Handle orphan sessions stuck in planning/revising with no workflows
        // This can happen when daemon was killed mid-workflow
        if (isOrphanPlanningSession) {
            // Release any agents that were allocated to this session
            // These are stuck because their workflows no longer exist in memory
            const releasedAgents = this.agentPoolService.releaseSessionAgents(sessionId);
            if (releasedAgents.length > 0) {
                this.log(`Released ${releasedAgents.length} orphaned agents: ${releasedAgents.join(', ')}`);
                
                // Broadcast pool change so UI updates immediately
                try {
                    const broadcaster = ServiceLocator.resolve(EventBroadcaster);
                    const poolStatus = this.agentPoolService.getPoolStatus();
                    const allocatedAgents = this.agentPoolService.getAllocatedAgents();
                    const busyAgents = this.agentPoolService.getBusyAgents();
                    const restingAgents = this.agentPoolService.getRestingAgents();
                    broadcaster.poolChanged(
                        poolStatus.total,
                        poolStatus.available,
                        allocatedAgents.map(a => ({ name: a.name, workflowId: a.workflowId, roleId: a.roleId })),
                        busyAgents.map(b => ({ name: b.name, coordinatorId: b.workflowId || '', roleId: b.roleId })),
                        restingAgents
                    );
                } catch (e) {
                    log.error(`Failed to broadcast pool.changed after orphan agent release:`, e);
                }
            }
            
            if (session.currentPlanPath) {
                // Has a plan file - go to reviewing status so user can restart or approve
                session.status = 'reviewing';
                session.metadata = session.metadata || {};
                session.metadata.recoveredFromOrphan = true;
                session.metadata.orphanRecoveredAt = new Date().toISOString();
                this.log(`Orphan session ${sessionId} recovered to 'reviewing' (has plan file)`);
            } else {
                // No plan file - go to no_plan status
                session.status = 'no_plan';
                session.metadata = session.metadata || {};
                session.metadata.recoveredFromOrphan = true;
                session.metadata.orphanRecoveredAt = new Date().toISOString();
                this.log(`Orphan session ${sessionId} recovered to 'no_plan' (no plan file)`);
            }
        }
        
        session.updatedAt = new Date().toISOString();
        this.stateManager.savePlanningSession(session);
        
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
     * Pause a specific workflow
     */
    async pauseWorkflow(sessionId: string, workflowId: string): Promise<void> {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        
        const workflow = state.workflows.get(workflowId);
        if (workflow) {
            await workflow.pause();
        }
    }
    
    /**
     * Resume a paused workflow
     */
    async resumeWorkflow(sessionId: string, workflowId: string): Promise<void> {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        
        const workflow = state.workflows.get(workflowId);
        if (workflow) {
            await workflow.resume();
        }
    }
    
    /**
     * Get workflow status
     */
    getWorkflowStatus(sessionId: string, workflowId: string): WorkflowProgress | undefined {
        const state = this.sessions.get(sessionId);
        if (!state) return undefined;
        
        // Check active workflows first
        const workflow = state.workflows.get(workflowId);
        if (workflow) {
            return workflow.getProgress();
        }
        
        // Check archived workflows
        const archived = state.archivedWorkflows.get(workflowId);
        if (archived) {
            return {
                workflowId: archived.id,
                type: archived.type,
                status: 'not_found',  // Use not_found to indicate it was cleaned up
                phase: 'archived',
                phaseIndex: 0,
                totalPhases: 0,
                percentage: 100,
                message: `Workflow completed and archived on ${new Date(archived.archivedAt).toLocaleString()}`,
                startedAt: archived.startedAt,
                updatedAt: archived.archivedAt,
                taskId: archived.taskId
            };
        }
        
        return undefined;
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
        
        // Try to fulfill requests (async, but don't wait - fire and forget)
        this.processAgentQueue().catch(err => {
            this.log(`Error processing agent queue: ${err}`);
        });
    }
    
    /**
     * Handle agent release from workflow
     */
    private handleAgentReleased(agentName: string): void {
        log.debug(`handleAgentReleased called for ${agentName}`);
        const taskManager = ServiceLocator.resolve(TaskManager);
        
        // Sync with TaskManager - release the agent assignment
        taskManager.releaseAgent(agentName);
        
        // Release from AgentPoolService (thin allocation layer)
        this.agentPoolService.releaseAgents([agentName]);
        this.log(`Agent released: ${agentName}`);
        
        // Clean up terminal for this agent to free resources
        // Note: Terminal cleanup is handled by the terminal manager if available
        // In headless mode, there are no terminals to clean up
        
        // Broadcast pool change so UI updates immediately
        try {
            const broadcaster = ServiceLocator.resolve(EventBroadcaster);
            const poolStatus = this.agentPoolService.getPoolStatus();
            const allocatedAgents = this.agentPoolService.getAllocatedAgents();
            const busyAgents = this.agentPoolService.getBusyAgents();
            const restingAgents = this.agentPoolService.getRestingAgents();
            log.debug(`Broadcasting pool.changed: available=${poolStatus.available.length}, allocated=${allocatedAgents.length}, busy=${busyAgents.length}, resting=${restingAgents.length}`);
            broadcaster.poolChanged(
                poolStatus.total,
                poolStatus.available,
                allocatedAgents.map(a => ({ name: a.name, workflowId: a.workflowId, roleId: a.roleId })),
                busyAgents.map(b => ({ name: b.name, coordinatorId: b.workflowId || '', roleId: b.roleId })),
                restingAgents
            );
            log.debug(`pool.changed broadcast complete`);
        } catch (e) {
            log.error(`Failed to broadcast pool.changed:`, e);
        }
        
        // Try to fulfill pending requests (async, fire and forget)
        this.processAgentQueue().catch(err => {
            this.log(`Error processing agent queue: ${err}`);
        });
        
        // Notify sessions that could use the agent (have ready tasks without running workflows)
        // This avoids triggering evaluations for sessions that can't benefit
        for (const [sessionId, state] of this.sessions) {
            // Check if session has tasks ready to dispatch
            const tasks = taskManager.getTasksForSession(sessionId);
            const hasReadyTasks = tasks.some(t => 
                t.status === 'created' || t.status === 'blocked'
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
     * Handle agent demotion to bench from workflow
     */
    private handleAgentDemotedToBench(agentName: string): void {
        log.debug(`handleAgentDemotedToBench called for ${agentName}`);
        
        // Demote from busy to bench (allocated but not busy)
        this.agentPoolService.demoteAgentToBench(agentName);
        this.log(`Agent demoted to bench: ${agentName}`);
        
        // Broadcast pool change so UI updates immediately
        try {
            const broadcaster = ServiceLocator.resolve(EventBroadcaster);
            const poolStatus = this.agentPoolService.getPoolStatus();
            const allocatedAgents = this.agentPoolService.getAllocatedAgents();
            const busyAgents = this.agentPoolService.getBusyAgents();
            const restingAgents = this.agentPoolService.getRestingAgents();
            log.debug(`Broadcasting pool.changed after bench demotion: available=${poolStatus.available.length}, allocated=${allocatedAgents.length}, busy=${busyAgents.length}, resting=${restingAgents.length}`);
            broadcaster.poolChanged(
                poolStatus.total,
                poolStatus.available,
                allocatedAgents.map(a => ({ name: a.name, workflowId: a.workflowId, roleId: a.roleId })),
                busyAgents.map(b => ({ name: b.name, coordinatorId: b.workflowId || '', roleId: b.roleId })),
                restingAgents
            );
        } catch (e) {
            log.error(`Failed to broadcast pool.changed:`, e);
        }
        
        // Note: We don't trigger coordinator evaluation here because the agent is still
        // allocated to the session and may be needed again soon (e.g., for plan revision loop)
    }
    
    /**
     * Process the agent request queue
     * 
     * ARCHITECTURE CHANGE:
     * - This method ONLY allocates agents to bench
     * - It does NOT auto-promote to busy
     * - Workflows must explicitly call AgentPoolService.promoteAgentToBusy() when work starts
     * 
     * THREAD SAFETY: Uses guard flag to prevent concurrent processing.
     * Only one processAgentQueue call can run at a time.
     */
    private async processAgentQueue(): Promise<void> {
        // Guard: If already processing, return immediately
        // The active processing loop will pick up any newly added requests
        if (this.processingQueue) {
            return;
        }
        
        this.processingQueue = true;
        
        try {
            const taskManager = ServiceLocator.resolve(TaskManager);
            
            while (this.agentRequestQueue.length > 0) {
            const request = this.agentRequestQueue[0];
            
            // Find session for this workflow
            let sessionId = '';
            for (const [sid, state] of this.sessions) {
                if (state.workflows.has(request.workflowId)) {
                    sessionId = sid;
                    break;
                }
            }
            
            if (!sessionId) {
                this.log(`Cannot allocate agent: workflow ${request.workflowId} not found`);
                this.agentRequestQueue.shift();
                continue;
            }
            
            // Try to get agent from THIS WORKFLOW's bench first
            // WORKFLOW-SCOPED: Only look at agents owned by this workflow
            const benchAgents = this.agentPoolService.getAgentsOnBench(request.workflowId)
                .filter(a => a.roleId === request.roleId);
            
            let agentName: string | undefined;
            
            if (benchAgents.length > 0) {
                // Use agent from this workflow's bench
                agentName = benchAgents[0].name;
                this.log(`Agent ${agentName} found on workflow ${request.workflowId}'s bench`);
            }
            
            if (!agentName) {
                // No agents on this workflow's bench - allocate new agent (now async with mutex)
                const allocated = await this.agentPoolService.allocateAgents(
                    sessionId,
                    request.workflowId,  // This workflow owns the agent
                    1, 
                    request.roleId
                );
                
                if (allocated.length === 0) {
                    // No agents available
                    break;
                }
                
                agentName = allocated[0];
                this.log(`Agent ${agentName} allocated to workflow ${request.workflowId}'s BENCH`);
            }
            
            // Remove from queue
            this.agentRequestQueue.shift();
            
            // Enhanced logging to trace agent allocation
            this.log(`📋 QUEUE: Processed request | agent=${agentName} role=${request.roleId} workflow=${request.workflowId.substring(0, 8)}...`);
            
            // Sync with TaskManager
            const roleId = this.mapRoleIdToAgentRole(request.roleId);
            taskManager.registerAgent(agentName, sessionId, '', roleId);
            
            // Fire allocation event
            this._onAgentAllocated.fire({
                agentName,
                sessionId,
                roleId: request.roleId,
                workflowId: request.workflowId
            });
            
            // Fulfill request - workflow will promote to busy when ready
            request.callback(agentName);
            this.log(`✓ Agent ${agentName} ready on bench for workflow ${request.workflowId.substring(0, 8)}... (role: ${request.roleId})`);
            }
        } finally {
            this.processingQueue = false;
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
            'planner': 'engineer',  // Planner uses engineer role for tracking
            'analyst_implementation': 'reviewer',
            'analyst_quality': 'reviewer',
            'analyst_architecture': 'reviewer'
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
                    const status = workflow?.getStatus();
                    if (workflow && (status === 'running' || status === 'blocked' || status === 'pending')) {
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
                const status = workflow?.getStatus();
                if (workflow && (status === 'running' || status === 'pending')) {
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
     * Store disposables for proper cleanup to prevent memory leaks
     */
    private subscribeToWorkflow(workflow: IWorkflow, sessionId: string): void {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        
        const disposables: Array<{ dispose: () => void }> = [];
        
        // Progress updates
        disposables.push(workflow.onProgress.event((progress) => {
            this._onWorkflowProgress.fire(progress);
        }));
        
        // Completion (auto-cleanup after completion)
        disposables.push(workflow.onComplete.event(async (result) => {
            await this.handleWorkflowComplete(sessionId, workflow.id, result);
            // Cleanup event listeners immediately after completion
            this.disposeWorkflowListeners(sessionId, workflow.id);
        }));
        
        // Agent requests
        disposables.push(workflow.onAgentNeeded.event((request) => {
            this.handleAgentRequest(request);
        }));
        
        // Agent releases
        disposables.push(workflow.onAgentReleased.event((agentName) => {
            this.handleAgentReleased(agentName);
        }));
        
        // Agent demoted to bench
        disposables.push(workflow.onAgentDemotedToBench.event((agentName) => {
            this.handleAgentDemotedToBench(agentName);
        }));
        
        // Task occupancy declared - inline delegation to TaskManager
        disposables.push(workflow.onTaskOccupancyDeclared.event((occupancy) => {
            const taskManager = ServiceLocator.resolve(TaskManager);
            taskManager.declareTaskOccupancy(workflow.id, occupancy.taskIds, occupancy.type, occupancy.reason);
        }));
        
        // Task occupancy released - inline delegation + resume waiting workflows
        disposables.push(workflow.onTaskOccupancyReleased.event((taskIds) => {
            const taskManager = ServiceLocator.resolve(TaskManager);
            taskManager.releaseTaskOccupancy(workflow.id, taskIds);
            this.resumeWaitingWorkflows(sessionId, taskIds);
        }));
        
        // Task conflicts declared - complex handling
        disposables.push(workflow.onTaskConflictDeclared.event((conflict) => {
            this.handleTaskConflictDeclared(sessionId, workflow.id, conflict);
        }));
        
        // Store disposables for cleanup
        state.workflowDisposables.set(workflow.id, disposables);
    }
    
    /**
     * Dispose event listeners for a specific workflow
     * CRITICAL: Prevents memory leaks by cleaning up all event subscriptions
     */
    private disposeWorkflowListeners(sessionId: string, workflowId: string): void {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        
        const disposables = state.workflowDisposables.get(workflowId);
        if (disposables) {
            let disposedCount = 0;
            for (const disposable of disposables) {
                try {
                    disposable.dispose();
                    disposedCount++;
                } catch (err) {
                    this.log(`Warning: Error disposing listener for workflow ${workflowId}: ${err}`);
                }
            }
            
            // Remove from map
            state.workflowDisposables.delete(workflowId);
            this.log(`🧹 Cleaned up ${disposedCount} event listeners for workflow ${workflowId.substring(0, 8)}`);
        }
    }
    
    /**
     * Dispose all event listeners for a session
     * Called when session is removed or cleaned up
     */
    private disposeSessionListeners(sessionId: string): void {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        
        let totalDisposed = 0;
        for (const [workflowId, disposables] of state.workflowDisposables) {
            for (const disposable of disposables) {
                try {
                    disposable.dispose();
                    totalDisposed++;
                } catch (err) {
                    this.log(`Warning: Error disposing listener for workflow ${workflowId}: ${err}`);
                }
            }
        }
        
        state.workflowDisposables.clear();
        this.log(`🧹 Cleaned up ${totalDisposed} event listeners for session ${sessionId}`);
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
     * Update workflow history with summary (called via CLI)
     */
    updateWorkflowHistorySummary(
        sessionId: string,
        workflowId: string,
        summary: string
    ): void {
        const state = this.sessions.get(sessionId);
        if (!state) {
            this.log(`Cannot update summary: session ${sessionId} not found`);
            return;
        }
        
        // Find the workflow in history and update its summary
        const historyEntry = state.workflowHistory.find(h => h.id === workflowId);
        if (historyEntry) {
            historyEntry.summary = summary;
            
            // Persist updated history to disk
            this.stateManager.saveWorkflowHistory(sessionId, state.workflowHistory);
            
            this.log(`✅ Updated workflow summary for ${workflowId.substring(0, 8)}`);
        } else {
            this.log(`Cannot update summary: workflow ${workflowId} not found in history`);
        }
    }
    
    /**
     * Handle workflow completion
     */
    private async handleWorkflowComplete(
        sessionId: string, 
        workflowId: string, 
        result: WorkflowResult
    ): Promise<void> {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        
        // Clean up any pending completion signals for this workflow
        this.cancelPendingSignal(workflowId);
        
        // Move to completed
        state.completedWorkflowIds.push(workflowId);
        state.updatedAt = new Date().toISOString();
        
        // Add to workflow history (newest first) with sliding window
        const workflow = state.workflows.get(workflowId);
        const taskId = state.workflowToTaskMap.get(workflowId);
        
        const historySummary: CompletedWorkflowSummary = {
            id: workflowId,
            type: workflow?.type || 'unknown',
            status: result.success ? 'completed' : 'failed',
            taskId,
            startedAt: workflow?.getProgress().startedAt || state.createdAt,
            completedAt: new Date().toISOString(),
            
            // New structured fields
            success: result.success,
            error: result.error,
            output: result.output,
            
            // Deprecated field (kept for backward compatibility)
            result: result.error,
            
            logPath: workflow?.getProgress().logPath
        };
        state.workflowHistory.unshift(historySummary); // Add to front (newest first)
        
        // Keep only last 100 workflow history entries (sliding window)
        const MAX_WORKFLOW_HISTORY = 100;
        if (state.workflowHistory.length > MAX_WORKFLOW_HISTORY) {
            state.workflowHistory = state.workflowHistory.slice(0, MAX_WORKFLOW_HISTORY);
        }
        
        // Persist workflow history to disk
        this.stateManager.saveWorkflowHistory(sessionId, state.workflowHistory);
        
        this.log(`Workflow ${workflowId.substring(0,8)} completed: ${result.success ? 'SUCCESS' : 'FAILED'}`);
        
        // Get task manager and global task ID
        const taskManager = ServiceLocator.resolve(TaskManager);
        const globalTaskId = taskId ? `${sessionId}_${taskId}` : undefined;
        
        // Clear the task's current workflow - but DON'T auto-complete the task
        // The coordinator will decide what to do next (another workflow, mark complete, etc.)
        if (globalTaskId) {
            taskManager.clearTaskCurrentWorkflow(globalTaskId);
            
            if (!result.success) {
                // Track failure for coordinator context
                this.trackFailedTask(sessionId, taskId!, workflowId, result.error || 'Unknown error');
            } else {
                // Clear from failed tasks if it was previously failed and now succeeded
                taskManager.clearFailedTask(sessionId, taskId!);
            }
        }
        
        // Update history with outcome
        this.updateHistoryOutcome(sessionId, workflowId, result.success, result.error);
        
        // Release any task occupancy held by this workflow (via TaskManager)
        taskManager.releaseAllTaskOccupancy(workflowId);
        
        // Fire event
        this._onWorkflowComplete.fire({ sessionId, workflowId, result });
        
        // Broadcast workflow completion to all WebSocket clients
        // This ensures the extension UI updates even when daemon runs separately
        try {
            const broadcaster = ServiceLocator.resolve(EventBroadcaster);
            broadcaster.broadcast('workflow.completed', {
                workflowId,
                sessionId,
                type: workflow?.type || 'unknown',
                success: result.success,
                output: result.output,
                error: result.error,
                duration: result.duration || 0,
                completedAt: new Date().toISOString()
            }, sessionId);
            this.log(`Broadcast workflow.completed for ${workflowId.substring(0, 8)}`);
        } catch (e) {
            // Broadcaster may not be available in some contexts
            log.warn(`Failed to broadcast workflow.completed:`, e);
        }
        
        // Save workflow to persistent history
        try {
            await this.historyService.saveWorkflow({
                id: workflowId,
                sessionId,
                type: workflow?.type || 'unknown',
                status: result.success ? 'completed' : 'failed',
                taskId,
                startedAt: workflow?.getProgress().startedAt || state.createdAt,
                completedAt: new Date().toISOString(),
                duration: result.duration || 0,
                success: result.success,
                output: result.output,
                error: result.error
            });
        } catch (e) {
            this.log(`Failed to save workflow history: ${e}`);
        }
        
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
        
        // If session is complete, cleanup and unsubscribe
        const session = this.stateManager.getPlanningSession(sessionId);
        if (session?.status === 'completed') {
            // Unsubscribe all clients from this completed session
            try {
                const broadcaster = ServiceLocator.resolve(EventBroadcaster);
                broadcaster.unsubscribeSession(sessionId);
                broadcaster.cleanupOrphanedSessions();
            } catch (e) {
                // Broadcaster may not be available in some contexts
            }
            
            // Clean up tasks for this session from memory
            const taskManager = ServiceLocator.resolve(TaskManager);
            taskManager.cleanupSessionTasks(sessionId);
            
            // Schedule session cleanup (not immediate to allow inspection)
            setTimeout(() => {
                this.cleanupCompletedSessions();
            }, 5 * 60 * 1000); // 5 minutes after completion
        }
        
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
        
        // Get current task IDs from TaskManager (not legacy plan parsing)
        // In the new architecture, tasks are created via CLI by the coordinator
        const taskManager = ServiceLocator.resolve(TaskManager);
        const currentTasks = taskManager.getTasksForSession(sessionId);
        const currentTaskIds = new Set<string>(
            currentTasks.map(t => t.id.replace(`${sessionId}_`, ''))  // Strip session prefix for matching
        );
        
        this.log(`\n📋 Resuming workflows after revision (${state.pausedForRevision.length} paused, ${currentTaskIds.size} tasks in TaskManager)`);
        
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
            log.warn(`Task "${taskId}" cannot be retried (permanent error).`);
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
            log.error(`Failed to retry task: ${errorMsg}`);
            return null;
        }
    }
    
    /**
     * Check if all workflows in a session are complete
     */
    private checkSessionCompletion(sessionId: string): void {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        
        // Don't auto-complete sessions that are still in planning/review states
        // Only 'approved' sessions (execution started) can become 'completed'
        const session = this.stateManager.getPlanningSession(sessionId);
        if (!session) return;
        
        const planningStates: string[] = ['no_plan', 'planning', 'reviewing', 'revising'];
        if (planningStates.includes(session.status)) {
            // Session is still in planning phase - don't auto-complete
            // The session needs to go through approval -> execution flow
            return;
        }
        
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
        
        // Only mark complete if:
        // 1. Session is approved (execution was started)
        // 2. All workflows are done
        // 3. All tasks are done (and there were tasks to begin with)
        const isSessionComplete = (
            session.status === 'approved' &&
            allWorkflowsComplete && 
            allTasksComplete && 
            taskProgress.total > 0
        );
        
        if (isSessionComplete) {
            session.status = 'completed';
            session.updatedAt = new Date().toISOString();
            this.stateManager.savePlanningSession(session);
            this.log(`Session ${sessionId} completed (workflows: ${state.workflows.size} done, tasks: ${taskProgress.completed}/${taskProgress.total} complete)`);
            
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
        const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes (reduced from 1 hour for faster cleanup)
        
        for (const [workflowId, workflow] of state.workflows) {
            const status = workflow.getStatus();
            if (status === 'completed' || status === 'cancelled' || status === 'failed') {
                // Check age - only cleanup if completed more than 5 minutes ago
                // This keeps recent completions available for inspection
                const progress = workflow.getProgress();
                const completedAt = new Date(progress.updatedAt).getTime();
                
                if (now - completedAt > MAX_AGE_MS) {
                    // Archive instead of just deleting
                    const archived: ArchivedWorkflow = {
                        id: workflowId,
                        type: workflow.type,
                        status: workflow.getStatus() as 'completed' | 'failed' | 'cancelled',
                        taskId: workflow.getProgress().taskId,
                        startedAt: workflow.getProgress().startedAt,
                        completedAt: workflow.getProgress().updatedAt,
                        archivedAt: new Date().toISOString()
                    };
                    
                    state.archivedWorkflows.set(workflowId, archived);
                    
                    // Dispose event listeners using helper method (prevents memory leaks)
                    this.disposeWorkflowListeners(sessionId, workflowId);
                    
                    // Dispose workflow before removing to clean up internal state
                    workflow.dispose();
                    state.workflows.delete(workflowId);
                    cleaned++;
                }
            }
        }
        
        if (cleaned > 0) {
            this.log(`🧹 Cleaned up ${cleaned} old workflows for session ${sessionId} (freed event listeners + workflow state)`);
            
            // Broadcast cleanup event so UI can update
            try {
                const broadcaster = ServiceLocator.resolve(EventBroadcaster);
                broadcaster.broadcast('workflows.cleaned', {
                    sessionId,
                    cleanedCount: cleaned,
                    timestamp: new Date().toISOString()
                }, sessionId);
            } catch (e) {
                // Ignore if broadcaster not available
            }
        }
    }
    
    /**
     * Log message to output channel
     */
    private log(message: string): void {
        this.outputManager.log('COORD', message);
    }
    
    // =========================================================================
    // AI COORDINATOR AGENT
    // =========================================================================
    
    /**
     * Trigger AI Coordinator evaluation for an event
     * 
     * Delegates to CoordinatorAgent which handles debouncing, event batching,
     * and evaluation. Decisions are executed asynchronously via callback.
     * 
     * IMPORTANT: Only triggers for approved sessions to prevent executing unapproved plans.
     */
    async triggerCoordinatorEvaluation(
        sessionId: string,
        eventType: CoordinatorEventType,
        payload: any
    ): Promise<CoordinatorDecision | null> {
        // Verify session is approved before triggering coordinator
        const session = this.stateManager.getPlanningSession(sessionId);
        if (!session) {
            this.log(`Cannot trigger coordinator: session ${sessionId} not found`);
            return null;
        }
        
        // CRITICAL: Only evaluate approved sessions
        // Plans must be explicitly approved by user before execution can begin
        if (session.status !== 'approved') {
            this.log(`Skipping coordinator evaluation: session ${sessionId} is '${session.status}' (not 'approved')`);
            return null;
        }
        
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
     * Clean up stale workflow references before coordinator evaluation
     * 
     * A workflow reference is stale if:
     * - Task has currentWorkflow set but workflow doesn't exist or is finished
     * - Task is completed but workflow is still running/paused (state mismatch)
     * - Orphan workflows exist that aren't referenced by any task
     * 
     * This happens when workflows crash/stall without properly completing,
     * or when tasks are marked complete externally while workflow is still running.
     */
    private cleanupStaleWorkflows(sessionId: string): number {
        const state = this.sessions.get(sessionId);
        if (!state) return 0;
        
        const taskManager = ServiceLocator.resolve(TaskManager);
        const tasks = taskManager.getTasksForSession(sessionId);
        
        let cleanedCount = 0;
        
        // Track which workflows are legitimately referenced by tasks
        const activeWorkflowRefs = new Set<string>();
        
        for (const task of tasks) {
            // Case 1: Task is COMPLETED but has a running workflow - cancel the workflow
            if (task.status === 'completed' && task.currentWorkflow) {
                const workflow = state.workflows.get(task.currentWorkflow);
                if (workflow) {
                    const status = workflow.getStatus();
                    if (status === 'running' || status === 'paused' || status === 'pending') {
                        this.log(`🧹 Cancelling orphan workflow for completed task: ${task.id} → ${task.currentWorkflow.substring(0, 8)}`);
                        
                        // Cancel and dispose the workflow
                        try {
                            workflow.cancel();
                            workflow.dispose();
                        } catch (e) {
                            this.log(`  ⚠️ Error disposing workflow: ${e}`);
                        }
                        
                        // Remove from active workflows
                        state.workflows.delete(task.currentWorkflow);
                        this.disposeWorkflowListeners(sessionId, task.currentWorkflow);
                        
                        // Clear task reference
                        taskManager.clearTaskCurrentWorkflow(task.id);
                        cleanedCount++;
                        continue;
                    }
                }
            }
            
            if (!task.currentWorkflow) continue;
            
            // Check if the workflow exists and is active
            const workflow = state.workflows.get(task.currentWorkflow);
            
            let isStale = false;
            if (!workflow) {
                // Workflow doesn't exist in session state - definitely stale
                isStale = true;
            } else {
                const status = workflow.getStatus();
                if (status === 'completed' || status === 'failed' || status === 'cancelled') {
                    // Workflow is done but task wasn't updated - stale
                    isStale = true;
                } else {
                    // Workflow is active and task references it - valid
                    activeWorkflowRefs.add(task.currentWorkflow);
                }
            }
            
            if (isStale) {
                this.log(`🧹 Cleaning stale workflow reference: ${task.id} → ${task.currentWorkflow?.substring(0, 8)}`);
                
                // Clear the workflow reference
                taskManager.clearTaskCurrentWorkflow(task.id);
                
                // Reset task to created if it's stuck in progress
                if (task.status === 'in_progress') {
                    taskManager.resetTaskToReady(task.id);
                }
                
                cleanedCount++;
            }
        }
        
        // Case 3: Clean up orphan workflows not referenced by any task
        // These can accumulate when tasks are deleted or workflows are started incorrectly
        for (const [workflowId, workflow] of state.workflows) {
            const status = workflow.getStatus();
            
            // Skip workflows that are legitimately referenced by tasks
            if (activeWorkflowRefs.has(workflowId)) continue;
            
            // Skip completed/failed/cancelled workflows (handled by cleanupCompletedWorkflows)
            if (status === 'completed' || status === 'failed' || status === 'cancelled') continue;
            
            // Check if this workflow has a task association via workflowToTaskMap
            const taskId = state.workflowToTaskMap.get(workflowId);
            if (taskId) {
                // Verify the task still exists and isn't completed
                const task = taskManager.getTask(`${sessionId}_${taskId}`);
                if (task && task.status !== 'completed') {
                    // Task exists and isn't complete - workflow might be legitimate
                    // But if task doesn't reference this workflow, it's orphaned
                    if (task.currentWorkflow !== workflowId) {
                        this.log(`🧹 Cancelling orphan workflow (task has different workflow): ${workflowId.substring(0, 8)} for task ${taskId}`);
                        try {
                            workflow.cancel();
                            workflow.dispose();
                        } catch (e) {
                            this.log(`  ⚠️ Error disposing workflow: ${e}`);
                        }
                        state.workflows.delete(workflowId);
                        state.workflowToTaskMap.delete(workflowId);
                        this.disposeWorkflowListeners(sessionId, workflowId);
                        cleanedCount++;
                    }
                } else if (task?.status === 'completed') {
                    // Task is completed - cancel the orphan workflow
                    this.log(`🧹 Cancelling orphan workflow for completed task: ${workflowId.substring(0, 8)} for task ${taskId}`);
                    try {
                        workflow.cancel();
                        workflow.dispose();
                    } catch (e) {
                        this.log(`  ⚠️ Error disposing workflow: ${e}`);
                    }
                    state.workflows.delete(workflowId);
                    state.workflowToTaskMap.delete(workflowId);
                    this.disposeWorkflowListeners(sessionId, workflowId);
                    cleanedCount++;
                }
            }
        }
        
        if (cleanedCount > 0) {
            this.log(`Cleaned ${cleanedCount} stale workflow(s) for session ${sessionId}`);
        }
        
        return cleanedCount;
    }
    
    /**
     * Build coordinator input context for AI evaluation
     */
    private async buildCoordinatorInput(
        sessionId: string,
        event: CoordinatorEvent
    ): Promise<CoordinatorInput> {
        // Clean up stale workflows before building input
        this.cleanupStaleWorkflows(sessionId);
        
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
    /**
     * Log coordinator decision to history for tracking
     * NOTE: AI executes commands directly via run_terminal_cmd,
     * so we only log reasoning/confidence - not dispatch counts.
     */
    private logDecisionToHistory(sessionId: string, decision: CoordinatorDecision): void {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        
        // Truncate long reasoning to save memory (keep first 500 chars)
        const truncatedReasoning = decision.reasoning.length > 500 
            ? decision.reasoning.substring(0, 500) + '... (truncated)'
            : decision.reasoning;
        
        const entry: CoordinatorHistoryEntry = {
            timestamp: new Date().toISOString(),
            event: {
                type: 'manual_evaluation',
                summary: 'Coordinator evaluation (commands executed via run_terminal_cmd)'
            },
            decision: {
                dispatchCount: 0,  // AI dispatches directly
                dispatchedTasks: [],
                askedUser: false,
                pausedCount: 0,
                resumedCount: 0,
                reasoning: truncatedReasoning
            }
        };
        
        state.coordinatorHistory.push(entry);
        
        // Keep history bounded with sliding window
        const MAX_COORDINATOR_HISTORY = 50;
        if (state.coordinatorHistory.length > MAX_COORDINATOR_HISTORY) {
            // Keep only the most recent entries
            state.coordinatorHistory = state.coordinatorHistory.slice(-MAX_COORDINATOR_HISTORY);
        }
        
        // Persist history to disk for recovery across restarts
        this.stateManager.saveCoordinatorHistory(sessionId, state.coordinatorHistory);
        
        this.log(`Logged coordinator decision. Reasoning: ${truncatedReasoning.substring(0, 100)}...`);
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
    
    // =========================================================================
    // NOTE: executeCoordinatorDecision removed
    // The Coordinator AI now calls run_terminal_cmd directly to execute commands.
    // This allows parallel execution and eliminates fragile text parsing.
    // If AI fails, it throws an error and the caller can retry.
    // =========================================================================
    
    // =========================================================================
    // AGENT CLI COMPLETION SIGNALS
    // =========================================================================
    
    /**
     * Signal agent completion from CLI callback
     * 
     * Called by CliHandler when an agent calls:
     *   apc agent complete --session <s> --workflow <w> --stage <stage> --result <r> [--task <t>] --data '<json>'
     * 
     * @param signal The completion signal from the agent
     * @returns true if signal was delivered to a waiting workflow, false otherwise
     */
    signalAgentCompletion(signal: AgentCompletionSignal): boolean {
        // Key includes taskId if present (for parallel tasks within same workflow/stage)
        const key = signal.taskId 
            ? `${signal.workflowId}_${signal.stage}_${signal.taskId}`
            : `${signal.workflowId}_${signal.stage}`;
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
     * @param taskId Optional unique task ID for parallel tasks within same workflow/stage
     * @returns Promise that resolves with the completion signal
     */
    waitForAgentCompletion(
        workflowId: string,
        stage: string,
        timeoutMs: number = 600000,
        taskId?: string
    ): Promise<AgentCompletionSignal> {
        return new Promise((resolve, reject) => {
            // Key includes taskId if present (for parallel tasks within same workflow/stage)
            const key = taskId 
                ? `${workflowId}_${stage}_${taskId}`
                : `${workflowId}_${stage}`;
            
            // Check if already waiting
            if (this.completionSignals.has(key)) {
                reject(new Error(`Already waiting for completion signal: ${key}`));
                return;
            }
            
            // Set up timeout
            const timeoutId = setTimeout(() => {
                this.completionSignals.delete(key);
                reject(new Error(`Timeout waiting for agent completion: ${stage}${taskId ? '/' + taskId : ''} (${timeoutMs}ms)`));
            }, timeoutMs);
            
            // Register the pending signal
            this.completionSignals.set(key, {
                stage,
                resolve,
                reject,
                timeoutId
            });
            
            this.log(`⏳ Waiting for agent completion: ${workflowId.substring(0, 8)}/${stage}${taskId ? '/' + taskId : ''}`);
        });
    }
    
    /**
     * Cancel a pending completion signal wait
     * 
     * Called when a workflow is cancelled or paused before receiving signal.
     * 
     * @param workflowId The workflow ID
     * @param stage The stage (optional - cancels all if not specified)
     * @param taskId Optional task ID for parallel tasks
     */
    cancelPendingSignal(workflowId: string, stage?: string, taskId?: string): void {
        if (stage) {
            // Key includes taskId if present
            const key = taskId 
                ? `${workflowId}_${stage}_${taskId}`
                : `${workflowId}_${stage}`;
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
     * Clean up completed sessions that are older than the specified age
     * @param maxAgeMs - Maximum age in milliseconds for completed sessions (default: 4 hours)
     */
    private cleanupCompletedSessions(maxAgeMs: number = 4 * 60 * 60 * 1000): void {
        const now = Date.now();
        const sessionsToRemove: string[] = [];
        
        for (const [sessionId, state] of this.sessions) {
            // Only cleanup completed sessions
            const session = this.stateManager.getPlanningSession(sessionId);
            if (!session || session.status !== 'completed') {
                continue;
            }
            
            // Check if session is old enough to cleanup
            // Use updatedAt as a proxy for completion time
            const sessionEndTime = new Date(session.updatedAt).getTime();
            
            if (now - sessionEndTime > maxAgeMs) {
                sessionsToRemove.push(sessionId);
            }
        }
        
        // Remove old sessions
        for (const sessionId of sessionsToRemove) {
            const state = this.sessions.get(sessionId);
            if (state) {
                // Dispose all event listeners using helper method
                this.disposeSessionListeners(sessionId);
                
                // Dispose all workflows
                for (const workflow of state.workflows.values()) {
                    workflow.dispose();
                }
                this.sessions.delete(sessionId);
                this.log(`🧹 Cleaned up old completed session ${sessionId}`);
            }
        }
    }
    
    /**
     * Clean up stale completion signals that have timed out but weren't properly removed
     * Should be called periodically to prevent memory leaks
     */
    private cleanupStaleCompletionSignals(): void {
        const now = Date.now();
        const staleKeys: string[] = [];
        
        // Find signals that should have timed out (we don't track creation time, so this is a safety net)
        // In practice, timeouts should handle this, but this catches edge cases
        for (const [key, _pending] of this.completionSignals) {
            // If a signal has been waiting for more than 1 hour, it's definitely stale
            // (normal timeout is 10 minutes, so 1 hour is extremely conservative)
            // We can't directly check age without modifying the structure, so we'll limit total count instead
        }
        
        // Safety limit: if we have more than 100 pending signals, something is wrong
        if (this.completionSignals.size > 100) {
            log.warn(`Large number of pending completion signals: ${this.completionSignals.size}`);
            // Log the first few for debugging
            let count = 0;
            for (const key of this.completionSignals.keys()) {
                if (count++ < 5) {
                    log.warn(`  - ${key}`);
                }
            }
        }
    }
    
    /**
     * Check if there's a pending signal wait for a workflow/stage
     * 
     * @param workflowId The workflow ID
     * @param stage The stage to check
     * @param taskId Optional task ID for parallel tasks
     */
    hasPendingSignal(workflowId: string, stage: string, taskId?: string): boolean {
        const key = taskId 
            ? `${workflowId}_${stage}_${taskId}`
            : `${workflowId}_${stage}`;
        return this.completionSignals.has(key);
    }
    
    // =========================================================================
    // CLEANUP
    // =========================================================================
    
    /**
     * Graceful shutdown - pauses all workflows (saving state) and releases agents
     * 
     * Call this before stopping the daemon to ensure workflows can be resumed on restart.
     * Unlike dispose(), this preserves workflow state for recovery.
     * 
     * @returns Number of workflows paused and agents released
     */
    async gracefulShutdown(): Promise<{ workflowsPaused: number; agentsReleased: number }> {
        this.log('Initiating graceful shutdown...');
        
        let workflowsPaused = 0;
        let agentsReleased = 0;
        
        // Pause all active workflows in all sessions
        // Each workflow persists its own state via BaseWorkflow.persistState()
        for (const [sessionId, state] of this.sessions) {
            this.log(`  Shutting down session ${sessionId}...`);
            
            for (const [workflowId, workflow] of state.workflows) {
                const status = workflow.getStatus();
                
                // Only pause running or pending workflows (paused are already saved)
                if (status === 'running' || status === 'pending' || status === 'blocked') {
                    try {
                        const progress = workflow.getProgress();
                        
                        // Pause with daemon_shutdown reason - this persists state
                        await workflow.pause({ 
                            force: true,  // Force-kill any running agent
                            reason: 'daemon_shutdown' 
                        });
                        
                        workflowsPaused++;
                        this.log(`    ⏸️  Paused workflow ${workflowId.substring(0, 12)} (${progress.type}) at phase ${progress.phaseIndex}`);
                        
                    } catch (e) {
                        this.log(`    ⚠️  Failed to pause workflow ${workflowId}: ${e}`);
                    }
                }
            }
        }
        
        // Note: We do NOT release agents here - they remain allocated to their workflows
        // On daemon restart, workflows are restored and agents stay allocated
        // If a workflow fails to restore, orphan cleanup will release its agents
        
        // Count agents that will remain allocated
        const allocatedAgents = this.agentPoolService.getAllocatedAgents();
        const busyAgents = this.agentPoolService.getBusyAgents();
        agentsReleased = 0; // We don't release agents anymore - they stay with their workflows
        
        this.log(`Graceful shutdown complete: ${workflowsPaused} workflows paused`);
        this.log(`  Agents preserved: ${allocatedAgents.length} allocated, ${busyAgents.length} busy (will be validated on restart)`);
        
        return { workflowsPaused, agentsReleased };
    }
    
    /**
     * Dispose all resources
     */
    dispose(): void {
        // Stop periodic cleanup
        this.stopPeriodicCleanup();
        
        // Cancel all pending completion signals with proper cleanup
        for (const [_key, pending] of this.completionSignals) {
            clearTimeout(pending.timeoutId);
            pending.reject(new Error('Service disposed'));
        }
        this.completionSignals.clear();
        
        // Dispose coordinator agent (clears debounce timer)
        this.coordinatorAgent.dispose();
        
        // Cancel all active workflows
        for (const [sessionId, state] of this.sessions) {
            // Dispose event listeners first to prevent memory leaks
            for (const [workflowId, disposables] of state.workflowDisposables) {
                for (const disposable of disposables) {
                    disposable.dispose();
                }
            }
            state.workflowDisposables.clear();
            
            // Dispose workflows
            for (const workflow of state.workflows.values()) {
                workflow.dispose();
            }
        }
        
        this.sessions.clear();
        this.agentRequestQueue = [];
        
        this._onWorkflowProgress.dispose();
        this._onWorkflowComplete.dispose();
        this._onSessionStateChanged.dispose();
        this._onCoordinatorStatusChanged.dispose();
    }
}

