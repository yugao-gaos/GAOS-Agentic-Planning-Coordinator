// ============================================================================
// Workflow Types - Unified Coordinator System
// ============================================================================

// Note: This file is VS Code-free for daemon compatibility

/**
 * All possible workflow types in the system
 * 
 * NOTE: Unity pipeline is NOT a workflow type - it's a shared service
 * that workflows REQUEST from via UnityControlManager
 */
export type WorkflowType = 
    // Planning workflows
    | 'planning_new'           // Full planning loop: (Planner → Analysts)* → Finalize
    | 'planning_revision'      // Quick revision: Planner → Review → Finalize
    
    // Execution workflows  
    | 'task_implementation'    // Per-task: Engineer → Review → Approval → Delta → Unity
    | 'error_resolution'       // Error fixing after Unity failure
    
    // Context workflows
    | 'context_gathering';     // Standalone: Gather → Summarize → Persist to Context folder

/**
 * Workflow lifecycle states
 */
export type WorkflowStatus = 
    | 'pending'      // Created but not started
    | 'running'      // Actively executing
    | 'paused'       // Paused by user/system
    | 'blocked'      // Waiting on external dependency
    | 'completed'    // Successfully finished
    | 'failed'       // Failed with error
    | 'cancelled'    // Cancelled by user
    | 'not_found';   // Workflow was cleaned up from memory

/**
 * Progress tracking for UI updates
 */
export interface WorkflowProgress {
    workflowId: string;
    type: WorkflowType;
    status: WorkflowStatus;
    phase: string;           // Current phase name
    phaseIndex: number;      // Current phase (0-based)
    totalPhases: number;     // Total phases in workflow
    percentage: number;      // 0-100
    message: string;         // Human-readable status
    startedAt: string;
    updatedAt: string;
    taskId?: string;         // Task ID for task_implementation/error_resolution workflows
    estimatedRemaining?: number; // Milliseconds
    logPath?: string;        // Path to workflow log file
    waitingForAgent?: boolean;   // True when workflow is waiting for an agent to be allocated
    waitingForAgentRole?: string; // Role ID of the agent being waited for
}

/**
 * Workflow result when completed
 */
export interface WorkflowResult {
    success: boolean;
    output?: any;           // Workflow-specific output
    error?: string;
    duration: number;       // Milliseconds
    metadata?: Record<string, any>;
}

/**
 * Base workflow configuration for creating workflows
 */
export interface WorkflowConfig {
    id: string;
    type: WorkflowType;
    sessionId: string;      // Parent planning session
    priority: number;       // Lower = higher priority
    input: Record<string, any>; // Workflow-specific input
}

/**
 * Request for an agent from the pool
 */
export interface AgentRequest {
    workflowId: string;
    roleId: string;
    priority: number;
    callback: (agentName: string) => void;
}

/**
 * Revision state tracking
 */
export interface RevisionState {
    isActive: boolean;
    startedAt?: string;
    feedback?: string;
    
    /** Task IDs that are directly affected by the revision */
    affectedTaskIds: string[];
    
    /** Task IDs transitively affected (depend on affected tasks) */
    transitivelyAffectedTaskIds: string[];
    
    /** Workflow IDs that were paused due to revision */
    pausedWorkflowIds: string[];
    
    /** Whether this is a global revision affecting all tasks */
    isGlobalRevision: boolean;
}

/**
 * Summary of a completed workflow for history display
 */
export interface CompletedWorkflowSummary {
    id: string;
    type: string;
    status: 'completed' | 'failed' | 'cancelled';
    taskId?: string;
    startedAt: string;
    completedAt: string;
    result?: string;
    logPath?: string;
}

/**
 * Session workflow state - tracks all workflows for a planning session
 */
export interface SessionWorkflowState {
    sessionId: string;
    activeWorkflows: Map<string, WorkflowProgress>;
    pendingWorkflows: string[];      // Workflow IDs waiting to start
    completedWorkflows: string[];    // Workflow IDs that finished
    workflowHistory: CompletedWorkflowSummary[];  // Completed workflow details (newest first)
    
    // Cross-workflow state
    isRevising: boolean;             // Planning revision in progress
    pausedForRevision: string[];     // Workflow IDs paused for revision
    
    /** Detailed revision state for selective pausing */
    revisionState?: RevisionState;
}

/**
 * Workflow summary for UI display
 */
export interface WorkflowSummary {
    id: string;
    type: WorkflowType;
    status: WorkflowStatus;
    phase: string;
    percentage: number;
    taskId?: string;        // For task_implementation workflows
    agentName?: string;     // Currently assigned agent
}

/**
 * Planning workflow specific input
 */
export interface PlanningWorkflowInput {
    requirement: string;
    docs?: string[];
    existingPlanPath?: string;  // For revision
    userFeedback?: string;      // For revision
}

/**
 * Task implementation workflow specific input
 */
export interface TaskImplementationInput {
    taskId: string;
    taskDescription: string;
    dependencies: string[];
    planPath: string;
    contextBriefPath?: string;
    previousErrors?: string[];
}

/**
 * Error resolution workflow specific input
 */
export interface ErrorResolutionInput {
    errors: Array<{
        id: string;
        message: string;
        file?: string;
        line?: number;
        relatedTaskId?: string;
    }>;
    coordinatorId: string;
    sourceWorkflowId?: string;
    
    /** Number of previous fix attempts for these errors */
    previousAttempts?: number;
    
    /** Summary of what the previous fix attempt tried */
    previousFixSummary?: string;
}

// ============================================================================
// Context Gathering Workflow Types
// ============================================================================

/**
 * Configuration for a context gathering preset.
 * Presets define specialized prompts for different asset/code types.
 */
export interface ContextGatheringPresetConfig {
    /** Unique identifier for the preset */
    id: string;
    
    /** Human-readable name */
    name: string;
    
    /** Description of what this preset analyzes */
    description: string;
    
    /** Prompt additions for the gather phase */
    gatherPrompt: string;
    
    /** Prompt additions for the summarize phase */
    summarizePrompt: string;
    
    /** File extensions this preset handles (e.g., ['.vue', '.svelte']) */
    filePatterns: string[];
    
    /** Whether this preset requires Unity features */
    requiresUnity?: boolean;
    
    /** Whether this is a built-in preset (vs user-defined) */
    isBuiltIn?: boolean;
}

/**
 * User configuration for custom presets and extension overrides.
 * Loaded from _AiDevLog/Config/context_presets.json
 */
export interface ContextPresetUserConfig {
    /** Custom presets defined by user */
    customPresets?: ContextGatheringPresetConfig[];
    
    /** Override default extension → preset mappings */
    extensionOverrides?: Record<string, string>;
}

/**
 * Context gathering workflow specific input
 */
export interface ContextGatheringInput {
    /** Target folders/files to analyze */
    targets: string[];
    
    /** Manual override to use a single preset (skips auto-detection) */
    preset?: string;
    
    /** Optional focus areas (combined with preset prompts) */
    focusAreas?: string[];
    
    /** Optional task ID if gathering context for a specific task */
    taskId?: string;
    
    /** Output filename (without extension). Defaults to 'context' */
    outputName?: string;
    
    /** Depth of analysis: 'shallow' (quick scan) | 'deep' (thorough) */
    depth?: 'shallow' | 'deep';
    
    /** Whether to auto-detect asset types from file extensions. Default: true */
    autoDetect?: boolean;
}

/**
 * Workflow event types for coordinator communication
 */
export type WorkflowEventType = 
    | 'progress'
    | 'complete'
    | 'error'
    | 'agent_needed'
    | 'agent_released'
    | 'unity_requested'
    | 'unity_completed';

/**
 * Workflow event payload
 */
export interface WorkflowEvent {
    type: WorkflowEventType;
    workflowId: string;
    sessionId: string;
    timestamp: string;
    data?: any;
}

// ============================================================================
// Agent CLI Callback Types
// ============================================================================

/**
 * Signal sent by agents via CLI to report completion/results
 * This replaces fragile output parsing with explicit structured callbacks.
 * 
 * Usage: apc agent complete --session <s> --workflow <w> --stage <stage> --result <r> --data '<json>'
 */
export interface AgentCompletionSignal {
    /** Planning session ID */
    sessionId: string;
    
    /** Workflow ID that spawned this agent */
    workflowId: string;
    
    /** Stage within the workflow (implementation, review, analysis, etc.) */
    stage: AgentStage;
    
    /** Result of the stage */
    result: AgentStageResult;
    
    /** Optional task ID for parallel tasks within the same workflow/stage */
    taskId?: string;
    
    /** Structured payload with stage-specific data */
    payload?: AgentCompletionPayload;
    
    /** Timestamp when signal was received */
    timestamp?: string;
}

/**
 * Known agent stages for type safety
 */
export type AgentStage = 
    | 'context'           // Context gathering
    | 'implementation'    // Engineer implementation
    | 'review'            // Code review
    | 'analysis'          // Planning analyst review
    | 'error_analysis'    // Error analysis
    | 'delta_context'     // Context update after task
    | 'finalize'          // Finalization
    | string;             // Allow custom stages

/**
 * Result types for agent stages
 */
export type AgentStageResult =
    // Generic results
    | 'success'
    | 'failed'
    // Review results
    | 'approved'
    | 'changes_requested'
    // Analysis results  
    | 'pass'
    | 'critical'
    | 'minor'
    // Generic completion
    | 'complete'
    | string;             // Allow custom results

/**
 * Payload data for agent completion signals
 * Different stages populate different fields
 */
export interface AgentCompletionPayload {
    // Implementation stage
    files?: string[];              // Files modified by engineer
    
    // Review stage
    feedback?: string;             // Review feedback if changes requested
    
    // Analysis stage (planning analysts)
    issues?: string[];             // Critical issues found
    suggestions?: string[];        // Minor suggestions
    
    // Error analysis stage
    rootCause?: string;            // Root cause of error
    affectedFiles?: string[];      // Files affected by error
    suggestedFix?: string;         // Suggested fix approach
    relatedTask?: string;          // Related task ID (e.g., "T1")
    
    // Context stage
    briefPath?: string;            // Path to context brief file
    
    // Generic
    message?: string;              // Human-readable message
    error?: string;                // Error message if failed
}

/**
 * Get display name for workflow type
 */
export function getWorkflowTypeName(type: WorkflowType): string {
    switch (type) {
        case 'planning_new': return 'New Planning';
        case 'planning_revision': return 'Plan Revision';
        case 'task_implementation': return 'Task Implementation';
        case 'error_resolution': return 'Error Resolution';
        case 'context_gathering': return 'Context Gathering';
        default: return type;
    }
}

/**
 * Get icon for workflow type (VS Code ThemeIcon name)
 */
export function getWorkflowTypeIcon(type: WorkflowType): string {
    switch (type) {
        case 'planning_new': return 'note-add';
        case 'planning_revision': return 'edit';
        case 'task_implementation': return 'tools';
        case 'error_resolution': return 'bug';
        case 'context_gathering': return 'search';
        default: return 'circle-outline';
    }
}

/**
 * Get color for workflow status
 */
export function getWorkflowStatusColor(status: WorkflowStatus): string {
    switch (status) {
        case 'pending': return 'charts.gray';
        case 'running': return 'charts.blue';
        case 'paused': return 'charts.orange';
        case 'blocked': return 'charts.yellow';
        case 'completed': return 'charts.green';
        case 'failed': return 'charts.red';
        case 'cancelled': return 'charts.gray';
        default: return 'charts.gray';
    }
}

// ============================================================================
// Failed Task Tracking
// ============================================================================

/**
 * Information about a task that failed after retry attempts
 */
export interface FailedTask {
    /** Task ID from the plan */
    taskId: string;
    
    /** Workflow ID that was running the task */
    workflowId: string;
    
    /** Task description */
    description: string;
    
    /** Number of attempts made */
    attempts: number;
    
    /** The error message from the last attempt */
    lastError: string;
    
    /** Error classification (transient/permanent/unknown/needs_clarity) */
    errorType: 'transient' | 'permanent' | 'unknown' | 'needs_clarity';
    
    /** When the task failed */
    failedAt: string;
    
    /** Whether manual retry is possible */
    canRetry: boolean;
    
    /** Task IDs that are blocked because this task failed */
    blockedDependents: string[];
    
    /** Question for user if errorType is 'needs_clarity' (last resort after autonomous attempts) */
    clarityQuestion?: string;
}

/**
 * Summary of failed tasks for UI display
 */
export interface FailedTaskSummary {
    /** Total number of failed tasks */
    count: number;
    
    /** Number that can be retried */
    retriableCount: number;
    
    /** Number of tasks blocked by failures */
    blockedCount: number;
    
    /** The failed task entries */
    tasks: FailedTask[];
}

// ============================================================================
// Workflow Settings (User Customization)
// ============================================================================

/**
 * Per-workflow user settings stored in _AiDevLog/Config/workflow_settings.json
 */
export interface WorkflowUserSettings {
    /** Per-workflow coordinator prompt overrides */
    coordinatorPrompts: Record<WorkflowType, string>;
    
    /** Context gathering specific settings (presets, extension mappings) */
    contextGathering?: ContextPresetUserConfig;
}

/**
 * Default workflow user settings
 */
export const DEFAULT_WORKFLOW_USER_SETTINGS: WorkflowUserSettings = {
    coordinatorPrompts: {} as Record<WorkflowType, string>,
    contextGathering: {
        customPresets: [],
        extensionOverrides: {}
    }
};

