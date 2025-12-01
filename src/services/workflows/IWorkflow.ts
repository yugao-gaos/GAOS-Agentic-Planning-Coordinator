// ============================================================================
// IWorkflow Interface - Base contract for all workflow implementations
// ============================================================================

import { TypedEventEmitter } from '../TypedEventEmitter';
import { 
    WorkflowType, 
    WorkflowStatus, 
    WorkflowProgress, 
    WorkflowResult,
    AgentRequest 
} from '../../types/workflow';

/**
 * Task occupancy declaration - what tasks a workflow is working on
 */
export interface TaskOccupancy {
    /** Task IDs this workflow is actively working on */
    taskIds: string[];
    
    /** Type of occupancy */
    type: 'exclusive' | 'shared';
    
    /** Reason for occupancy (for logging/UI) */
    reason?: string;
}

/**
 * Task conflict declaration - what tasks a workflow conflicts with
 */
export interface TaskConflict {
    /** Task IDs this workflow conflicts with (those tasks should pause) */
    taskIds: string[];
    
    /** How to handle the conflict */
    resolution: 'pause_others' | 'wait_for_others' | 'abort_if_occupied';
    
    /** Reason for conflict (for logging/UI) */
    reason?: string;
}

/**
 * Conflict resolution result from coordinator
 */
export interface ConflictResolution {
    /** Whether the workflow can proceed */
    canProceed: boolean;
    
    /** Workflow IDs that were paused */
    pausedWorkflowIds: string[];
    
    /** Task IDs that are still occupied by other workflows */
    blockedByTaskIds: string[];
    
    /** If canProceed is false, the workflow ID blocking us */
    blockedByWorkflowId?: string;
}

/**
 * Base interface for all workflows
 * 
 * Workflows are self-contained state machines that can run concurrently.
 * Each workflow manages its own phases, agent requests, and state.
 * 
 * ## Task Occupancy Model
 * 
 * Every workflow declares which tasks it occupies/conflicts with:
 * - `task_implementation` occupies its target task exclusively
 * - `planning_revision` conflicts with affected tasks (pauses them)
 * - `error_resolution` occupies tasks related to the error
 * 
 * The coordinator tracks occupancy and handles conflicts automatically.
 */
export interface IWorkflow {
    // ========================================================================
    // Identity
    // ========================================================================
    
    /** Unique workflow ID */
    readonly id: string;
    
    /** Type of workflow */
    readonly type: WorkflowType;
    
    /** Parent session ID */
    readonly sessionId: string;
    
    // ========================================================================
    // State
    // ========================================================================
    
    /** Get current workflow status */
    getStatus(): WorkflowStatus;
    
    /** Get progress for UI display */
    getProgress(): WorkflowProgress;
    
    /** Get serializable state for persistence/resume */
    getState(): object;
    
    // ========================================================================
    // Lifecycle
    // ========================================================================
    
    /** Start the workflow - runs until completion or error */
    start(): Promise<WorkflowResult>;
    
    /** 
     * Pause the workflow 
     * @param options.force If true, immediately kill any running agent and save state.
     *                      If false (default), pause happens at next phase boundary.
     */
    pause(options?: { force?: boolean }): Promise<void>;
    
    /** Resume a paused workflow */
    resume(): Promise<void>;
    
    /** Cancel the workflow */
    cancel(): Promise<void>;
    
    // ========================================================================
    // Events
    // ========================================================================
    
    /** Fired when progress updates */
    readonly onProgress: TypedEventEmitter<WorkflowProgress>;
    
    /** Fired when workflow completes (success or failure) */
    readonly onComplete: TypedEventEmitter<WorkflowResult>;
    
    /** Fired when an error occurs */
    readonly onError: TypedEventEmitter<Error>;
    
    /** Fired when workflow needs an agent */
    readonly onAgentNeeded: TypedEventEmitter<AgentRequest>;
    
    /** Fired when workflow releases an agent */
    readonly onAgentReleased: TypedEventEmitter<string>;
    
    /** Fired when workflow declares task occupancy (coordinator subscribes) */
    readonly onTaskOccupancyDeclared: TypedEventEmitter<TaskOccupancy>;
    
    /** Fired when workflow releases task occupancy */
    readonly onTaskOccupancyReleased: TypedEventEmitter<string[]>;
    
    /** Fired when workflow declares task conflicts */
    readonly onTaskConflictDeclared: TypedEventEmitter<TaskConflict>;
    
    // ========================================================================
    // Task Occupancy & Conflict
    // ========================================================================
    
    /** 
     * Get task IDs this workflow is currently occupying
     * Called by coordinator to track occupancy
     */
    getOccupiedTaskIds(): string[];
    
    /**
     * Get task IDs this workflow conflicts with
     * Called at startup to determine what to pause
     * Return empty array if no conflicts
     */
    getConflictingTaskIds(): string[];
    
    /**
     * Called by coordinator when a conflict is detected
     * Workflow can decide how to handle it
     * 
     * @param taskId The task that has a conflict
     * @param otherWorkflowId The workflow that occupies the task
     * @returns How to resolve: 'wait' (pause self), 'proceed' (ignore), 'abort' (cancel self)
     */
    handleConflict(taskId: string, otherWorkflowId: string): 'wait' | 'proceed' | 'abort';
    
    /**
     * Called by coordinator when conflicts are resolved (other workflows paused/completed)
     * Workflow can resume working on the conflicting tasks
     */
    onConflictsResolved?(resolvedTaskIds: string[]): void;
    
    // ========================================================================
    // Dependency Management
    // ========================================================================
    
    /** Get workflow IDs this depends on (must complete first) */
    getDependencies(): string[];
    
    /** Does this workflow block other workflows from starting? (e.g., revision) */
    isBlocking(): boolean;
    
    // ========================================================================
    // Cleanup
    // ========================================================================
    
    /** Dispose resources */
    dispose(): void;
}

/**
 * Factory function type for creating workflows
 */
export type WorkflowFactory = (
    config: import('../../types/workflow').WorkflowConfig,
    services: WorkflowServices
) => IWorkflow;

/**
 * Services injected into workflows
 */
export interface WorkflowServices {
    stateManager: import('../StateManager').StateManager;
    agentPoolService: import('../AgentPoolService').AgentPoolService;
    roleRegistry: import('../AgentRoleRegistry').AgentRoleRegistry;
    /** Unity Control Manager - only available when unityEnabled is true */
    unityManager?: import('../UnityControlManager').UnityControlManager;
    outputManager: import('../OutputChannelManager').OutputChannelManager;
    /** Whether Unity features are enabled for this session */
    unityEnabled: boolean;
}

/**
 * Workflow metadata - static information about a workflow class
 * Used by coordinator to filter available workflows
 */
export interface WorkflowMetadata {
    /** Workflow type identifier */
    type: WorkflowType;
    
    /** Human-readable name */
    name: string;
    
    /** 
     * Whether this workflow requires Unity features to function
     * If true, workflow won't be available when Unity features are disabled
     */
    requiresUnity: boolean;
    
    /**
     * Prompt text to inject into coordinator's workflow selection section.
     * Describes when and how the coordinator should use this workflow.
     * 
     * Example:
     * "- 'context_gathering' - Gather context on specific folders/files before implementation
     *    Use when: Starting work on unfamiliar code, after errors, or to update project knowledge"
     */
    coordinatorPrompt: string;
}

