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
    | 'task_paused'            // Tasks were paused (e.g., due to errors)
    | 'task_resumed'           // Tasks were resumed
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
    | TaskPausedPayload
    | TaskResumedPayload
    | ManualEvaluationPayload;

export interface ExecutionStartedPayload {
    type: 'execution_started';
    planPath: string;
    taskCount: number;
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

export interface TaskPausedPayload {
    type: 'task_paused';
    taskIds: string[];
    reason: string;
}

export interface TaskResumedPayload {
    type: 'task_resumed';
    taskIds: string[];
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
    description: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'paused' | 'blocked';
    type: 'implementation' | 'error_fix' | 'context_gathering';
    dependencies: string[];
    dependencyStatus: 'all_complete' | 'some_pending' | 'some_failed';
    assignedAgent?: string;
    errors?: string[];
    attempts: number;
    priority: number;
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
 * Complete input provided to AI coordinator for decision-making
 */
export interface CoordinatorInput {
    /** The event that triggered this evaluation */
    event: CoordinatorEvent;
    
    /** Session identifier */
    sessionId: string;
    
    // ---- Plan Context ----
    /** Path to the plan file */
    planPath: string;
    /** Full plan content (markdown) */
    planContent: string;
    /** Original requirement that started this plan */
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
    /** All tasks in this session */
    tasks: TaskSummary[];
    /** Currently running workflows */
    activeWorkflows: ActiveWorkflowSummary[];
    /** Session status */
    sessionStatus: string;
    /** Any pending user questions */
    pendingQuestions: Array<{
        id: string;
        question: string;
        context: string;
        askedAt: string;
    }>;
}

// ============================================================================
// Coordinator Decision (what AI outputs)
// ============================================================================

/**
 * Dispatch instruction from coordinator
 */
export interface DispatchInstruction {
    taskId: string;
    workflowType: WorkflowType;
    priority: number;
    preferredAgent?: string;
    context?: string;  // Additional context for the workflow
}

/**
 * Question to ask user
 */
export interface UserQuestion {
    sessionId: string;
    questionId: string;
    question: string;
    context: string;
    relatedTaskId?: string;
    options?: string[];  // Optional multiple choice
    blocking: boolean;   // If true, pause related work until answered
}

/**
 * Error task creation instruction
 */
export interface ErrorTaskInstruction {
    errorId: string;
    errorMessage: string;
    file?: string;
    affectedTaskIds: string[];
    priority: number;
}

/**
 * Complete decision output from AI coordinator
 */
export interface CoordinatorDecision {
    /** Workflows to dispatch */
    dispatch: DispatchInstruction[];
    
    /** Question to ask user (null if none needed) */
    askUser: UserQuestion | null;
    
    /** Task IDs to pause */
    pauseTasks: string[];
    
    /** Task IDs to resume */
    resumeTasks: string[];
    
    /** Error tasks to create */
    createErrorTasks: ErrorTaskInstruction[];
    
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
        askedUser: boolean;
        pausedCount: number;
        resumedCount: number;
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
    
    /** Model to use for evaluation */
    model: string;
    
    /** Whether to include full plan content or just summary */
    includePlanContent: boolean;
    
    /** Maximum plan content length before truncation */
    maxPlanContentLength: number;
    
    /** Enable debug logging */
    debug: boolean;
}

/**
 * Default coordinator configuration
 */
export const DEFAULT_COORDINATOR_CONFIG: CoordinatorAgentConfig = {
    maxHistoryEntries: 20,
    evaluationTimeout: 30000,
    model: 'claude-sonnet',
    includePlanContent: true,
    maxPlanContentLength: 50000,
    debug: false,
};

