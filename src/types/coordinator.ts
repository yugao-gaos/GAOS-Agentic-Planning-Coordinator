// ============================================================================
// AI Coordinator Agent Types
// ============================================================================

import { WorkflowType, WorkflowStatus } from './workflow';

/**
 * Event types that trigger coordinator evaluation
 */
export type CoordinatorEventType =
    | 'execution_started'      // startExecution() called
    | 'workflow_completed'     // A workflow finished successfully
    | 'workflow_failed'        // A workflow failed
    | 'workflow_blocked'       // A workflow is blocked (needs dependency/clarification)
    | 'unity_error'            // Unity compilation/test errors detected
    | 'user_responded'         // User provided clarification
    | 'agent_available'        // An agent became available
    | 'manual_evaluation';     // Manual trigger for re-evaluation

/**
 * Event that triggers coordinator evaluation
 */
export interface CoordinatorEvent {
    type: CoordinatorEventType;
    sessionId: string;
    timestamp: string;
    payload: CoordinatorEventPayload;
}

/**
 * Event-specific payloads
 */
export type CoordinatorEventPayload = 
    | ExecutionStartedPayload
    | WorkflowCompletedPayload
    | WorkflowFailedPayload
    | WorkflowBlockedPayload
    | UnityErrorPayload
    | UserRespondedPayload
    | AgentAvailablePayload
    | ManualEvaluationPayload;

export interface ExecutionStartedPayload {
    type: 'execution_started';
    planPath: string;
    taskCount: number;
    /** Number of tasks successfully auto-created from plan */
    tasksCreated: number;
    /** Total number of tasks found in the plan file */
    totalTasksInPlan: number;
    /** Tasks that failed to create during auto-creation (coordinator should create these) */
    failedToCreate: string[];
}

export interface WorkflowCompletedPayload {
    type: 'workflow_completed';
    workflowId: string;
    workflowType: WorkflowType;
    taskId?: string;
    result?: any;
    duration: number;
}

export interface WorkflowFailedPayload {
    type: 'workflow_failed';
    workflowId: string;
    workflowType: WorkflowType;
    taskId?: string;
    error: string;
    attempts: number;
    canRetry: boolean;
}

export interface WorkflowBlockedPayload {
    type: 'workflow_blocked';
    workflowId: string;
    taskId?: string;
    reason: string;
    blockedBy?: string[];  // Task IDs or resource names
}

export interface UnityErrorPayload {
    type: 'unity_error';
    errors: Array<{
        id: string;
        message: string;
        file?: string;
        line?: number;
        code?: string;
    }>;
    affectedTaskIds: string[];
}

export interface UserRespondedPayload {
    type: 'user_responded';
    questionId: string;
    response: string;
    relatedTaskId?: string;
}

export interface AgentAvailablePayload {
    type: 'agent_available';
    agentName: string;
    roles: string[];
}

export interface ManualEvaluationPayload {
    type: 'manual_evaluation';
    reason?: string;
}

// ============================================================================
// Coordinator Input (what AI sees)
// ============================================================================

/**
 * Task summary for coordinator context
 */
export interface TaskSummary {
    id: string;
    sessionId?: string;  // Added for multi-plan support
    description: string;
    status: 'created' | 'pending' | 'in_progress' | 'succeeded' | 'blocked' | 'awaiting_decision';
    // NOTE: 'failed' removed - tasks are never permanently failed
    type: 'implementation' | 'error_fix' | 'context_gathering';
    dependencies: string[];
    dependencyStatus: 'all_complete' | 'some_pending' | 'some_failed';
    assignedAgent?: string;
    errors?: string[];
    errorCount?: number;
    retryCount?: number;
    attempts: number;
    priority: number;
    targetFiles?: string[];  // Files this task will modify - for cross-plan conflict detection
    contextGathered: boolean;      // Whether context has been gathered for this task
    contextPath?: string;          // Path to context file (if gathered)
    needsContext?: boolean;        // Whether task requires context gathering before implementation
    contextWorkflowStatus?: 'none' | 'running' | 'succeeded' | 'failed';  // Status of context workflow
}

/**
 * Active workflow summary for coordinator context
 */
export interface ActiveWorkflowSummary {
    id: string;
    type: WorkflowType;
    status: WorkflowStatus;
    taskId?: string;
    phase: string;
    phaseProgress: number;  // 0-100
    agentName?: string;
    startedAt: string;
    lastUpdate: string;
}

/**
 * Failed workflow summary for coordinator context
 * Provides details about recently failed workflows so coordinator can react appropriately
 */
export interface FailedWorkflowSummary {
    id: string;
    type: WorkflowType;
    taskId?: string;
    error: string;
    failedAt: string;
    phase: string;  // Phase where failure occurred
}

/**
 * Complete input provided to AI coordinator for decision-making
 */
/**
 * Summary of an approved plan for coordinator
 */
export interface PlanSummary {
    sessionId: string;
    planPath: string;
    requirement: string;
    status: string;
    recommendedAgents?: number;  // Recommended team size from plan
}

/**
 * Per-session capacity analysis for coordinator
 * Helps coordinator respect recommended team sizes per plan
 */
export interface SessionCapacity {
    sessionId: string;
    recommendedAgents: number;    // Max agents recommended by plan
    currentlyAllocated: number;   // Agents currently on this session (busy + bench)
    availableCapacity: number;    // Can still allocate this many agents
    activeWorkflows: number;      // Currently running workflows for this session
}

/**
 * Global file conflict info for cross-plan dependency detection
 * Shows which tasks from different sessions touch the same files
 */
export interface GlobalFileConflict {
    file: string;                 // The conflicting file path
    tasks: Array<{
        taskId: string;           // Global task ID (e.g., ps_000001_T3)
        sessionId: string;        // Session this task belongs to
        status: string;           // Current task status
        description: string;      // Task description for context
    }>;
}

export interface CoordinatorInput {
    /** The event that triggered this evaluation */
    event: CoordinatorEvent;
    
    /** Primary session identifier (for the triggering event) */
    sessionId: string;
    
    // ---- Plan Context (Multi-Plan Support) ----
    /** All approved and uncompleted plans */
    approvedPlans: PlanSummary[];
    
    /** @deprecated Use approvedPlans instead - kept for backward compatibility */
    planPath: string;
    /** @deprecated Use approvedPlans instead */
    planContent: string;
    /** @deprecated Use approvedPlans instead */
    planRequirement: string;
    
    // ---- History for Continuity ----
    /** Previous coordinator decisions and outcomes (last N entries) */
    history: CoordinatorHistoryEntry[];
    
    // ---- Current State ----
    /** Names of agents currently available */
    availableAgents: string[];
    /** All agents and their current status */
    agentStatuses: Array<{
        name: string;
        status: 'available' | 'busy' | 'offline';
        currentTask?: string;
        roles: string[];
    }>;
    /** All tasks across all sessions */
    tasks: TaskSummary[];
    /** Currently running workflows */
    activeWorkflows: ActiveWorkflowSummary[];
    /** Recently failed workflows (within last evaluation cycle) */
    recentlyFailedWorkflows: FailedWorkflowSummary[];
    /** Session status */
    sessionStatus: string;
    /** Any pending user questions */
    pendingQuestions: Array<{
        id: string;
        question: string;
        context: string;
        askedAt: string;
    }>;
    
    // ---- Capacity Planning (NEW) ----
    /** Per-session capacity analysis for respecting recommended team sizes */
    sessionCapacities: SessionCapacity[];
    
    // ---- Cross-Plan Conflict Detection ----
    /** Files that are touched by tasks from multiple sessions - requires sequencing */
    globalConflicts?: GlobalFileConflict[];
    
    // ---- Workflow Health Detection ----
    /** Health status of active workflows - identifies stuck workflows */
    workflowHealth?: WorkflowHealth[];
}

/**
 * Workflow health status for stuck detection
 */
export interface WorkflowHealth {
    workflowId: string;
    taskId?: string;
    status: string;
    minutesSinceActivity: number;
    /** null = healthy, otherwise indicates why workflow may be stuck */
    stuckReason: null | 'task_completed' | 'no_activity' | 'waiting_for_agent' | 'agents_idle';
    /** Additional context about the stuck condition */
    stuckDetail?: string;
}

// ============================================================================
// Coordinator Decision (what AI outputs)
// ============================================================================

/**
 * Decision output from AI coordinator
 * 
 * NOTE: The AI executes commands directly via run_terminal_cmd.
 * This interface is mostly for logging/history tracking.
 */
export interface CoordinatorDecision {
    /** AI's reasoning (logged for history/debugging) */
    reasoning: string;
    
    /** Confidence level 0-1 */
    confidence: number;
}

// ============================================================================
// Coordinator History (for continuity)
// ============================================================================

/**
 * A single history entry tracking one coordinator evaluation
 */
export interface CoordinatorHistoryEntry {
    /** When this evaluation happened */
    timestamp: string;
    
    /** The event that triggered the evaluation */
    event: {
        type: CoordinatorEventType;
        summary: string;  // Brief description
    };
    
    /** What the coordinator decided */
    decision: {
        dispatchCount: number;
        dispatchedTasks: string[];
        cancelledCount: number;
        reasoning: string;
    };
    
    /** Outcome of the decision (filled in after execution) */
    outcome?: {
        success: boolean;
        notes?: string;
        completedAt?: string;
    };
}

// ============================================================================
// Coordinator Configuration
// ============================================================================

/**
 * Configuration for the AI Coordinator Agent
 */
export interface CoordinatorAgentConfig {
    /** Maximum history entries to include in context */
    maxHistoryEntries: number;
    
    /** Timeout for AI evaluation (ms) */
    evaluationTimeout: number;
    
    /** Model tier to use for evaluation (low/mid/high) */
    model: 'low' | 'mid' | 'high';
    
    /** Enable debug logging */
    debug: boolean;
}

/**
 * Default coordinator configuration
 */
export const DEFAULT_COORDINATOR_CONFIG: CoordinatorAgentConfig = {
    maxHistoryEntries: 20,
    evaluationTimeout: 300000,  // 5 minutes - coordinator needs time to execute multiple commands
    model: 'mid',
    debug: false,
};

