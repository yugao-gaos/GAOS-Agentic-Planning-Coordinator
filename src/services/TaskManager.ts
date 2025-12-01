import * as fs from 'fs';
import * as path from 'path';
import { PlanParser, ParsedPlan, PlanTask } from './PlanParser';
import { OutputChannelManager } from './OutputChannelManager';
import { FailedTask, TaskOccupancyEntry } from '../types';
import { ErrorClassifier } from './workflows/ErrorClassifier';
import { EventBroadcaster } from '../daemon/EventBroadcaster';
import { ServiceLocator } from './ServiceLocator';

// ============================================================================
// Task Manager - Global Singleton for Cross-Plan Task Coordination
// ============================================================================

/**
 * Task stage - represents the execution pipeline stages
 * 
 * Per-Task Pipeline Flow:
 * pending → context_gathering → ready_for_agent → implementing
 *     ↓
 * ready_for_review → reviewing ←──┐
 *     ↓                           │
 * approved ──────────────────────-┘ (if changes requested)
 *     ↓
 * [Queue Unity + Delta Context in parallel]
 *     ↓
 * implemented (when delta context done)
 *     ↓
 * [Unity callback triggers Completion Reviewer]
 *     ↓
 * completed (or needs_work if related to errors)
 */
export type TaskStage = 
    // === Initial Stages ===
    | 'pending'                  // Waiting for dependencies
    
    // === Context Gathering ===
    | 'context_gathering'        // Context agent gathering task-specific info
    | 'ready_for_agent'          // Context done, waiting for implementation agent
    
    // === Agent Work ===
    | 'implementing'             // Agent actively coding
    | 'ready_for_review'         // Agent done, waiting for code reviewer
    
    // === Code Review Loop ===
    | 'reviewing'                // Code reviewer checking
    | 'review_changes_requested' // Reviewer requested changes, back to engineer
    
    // === Post-Approval ===
    | 'approved'                 // Code review passed, queue Unity + start delta context
    | 'delta_context_updating'   // Delta context agent updating _AiDevLog/Context/
    | 'implemented'              // Delta context done, awaiting Unity verification
    
    // === Unity Pipeline ===
    | 'awaiting_unity'           // Waiting for Unity pipeline
    | 'compiling'                // In Unity queue for compile
    | 'compile_failed'           // Compilation errors found
    | 'error_fixing'             // Fixing compilation/test errors  
    | 'compiled'                 // Compile passed
    | 'testing_editmode'         // Running EditMode tests
    | 'testing_playmode'         // Running PlayMode tests
    | 'waiting_player_test'      // Waiting for manual player testing
    | 'test_passed'              // Tests passed
    | 'test_failed'              // Tests failed
    | 'deferred'                 // Deferred due to overlap or blocked by error
    | 'paused'                   // Paused due to error in related task
    
    // === Final States ===
    | 'needs_work'               // Completion reviewer flagged as needing work
    | 'completed'                // Completion reviewer confirmed done
    | 'failed';                  // Failed and won't retry

/**
 * Task status in the coordinator's tracking (for dependency resolution and dispatch)
 */
export type TaskStatus = 
    | 'pending'           // Not yet ready (dependencies not met)
    | 'ready'             // Dependencies satisfied, can start context gathering
    | 'context_in_progress' // Context agent working
    | 'ready_for_agent'    // Context done, waiting for agent dispatch
    | 'agent_assigned'     // Agent dispatched but not yet started
    | 'agent_working'      // Agent actively implementing
    | 'ready_for_review'   // Agent done, waiting for reviewer dispatch
    | 'review_in_progress'  // Reviewer working
    | 'review_changes'      // Changes requested, back to engineer
    | 'approved'            // Review approved, finalizing
    | 'implemented'         // Delta context done, awaiting Unity verification
    | 'waiting_unity'       // Waiting for Unity (compile/test)
    | 'error_fixing'        // Fixing Unity errors
    | 'paused'              // Paused due to error
    | 'needs_work'          // Completion reviewer flagged issues
    | 'completed'           // Successfully completed
    | 'failed';             // Failed and won't retry

/**
 * Task type - determines what testing is appropriate
 */
export type TaskType = 
    | 'data_logic'    // Algorithms, state, calculations → EditMode only
    | 'component'     // MonoBehaviours, services → EditMode (if complex)
    | 'scene_ui'      // Layouts, prefabs, canvas → PlayMode only
    | 'gameplay'      // Mechanics, feel, balance → All tests
    | 'error_fix';    // Error-fixing task → Just compile verification

/**
 * Task requirements - which stages are required for this task
 */
export interface TaskRequirements {
    taskType: TaskType;
    needsCompile: boolean;        // Default: true
    needsEditModeTest: boolean;   // For pure logic testing
    needsPlayModeTest: boolean;   // For scene/component integration
    needsPlayerTest: boolean;     // For gameplay feel verification
}

/**
 * Managed task with full tracking
 * Now includes sessionId for cross-plan coordination
 */
export interface ManagedTask {
    id: string;                   // Globally unique: "ps_001_T1" or "ERR_FIX_xxx"
    sessionId: string;            // Which plan/session this belongs to
    description: string;
    assignedAgent?: string;       // Which agent should do this (from plan)
    actualAgent?: string;         // Who is actually doing it
    status: TaskStatus;
    stage: TaskStage;             // Current completion stage
    requirements: TaskRequirements; // What stages are required
    dependencies: string[];       // Task IDs this depends on
    dependents: string[];         // Task IDs that depend on this
    priority: number;             // Lower = higher priority (based on dependency depth)
    
    // Timing
    createdAt: string;
    dispatchedAt?: string;
    startedAt?: string;
    completedAt?: string;
    
    // Context for error routing
    filesModified: string[];      // Files touched during this task
    unityRequests: string[];      // Unity task IDs requested
    errors: string[];             // Error IDs assigned to this task
    
    // Session continuity
    sessionSummary?: string;      // Summary from previous session (for continuation)
    
    // Pause tracking
    pausedAt?: string;            // When task was paused
    pausedReason?: string;        // Why task was paused
    previousStage?: TaskStage;    // Stage before pause (for resume)
    
    // === Execution Pipeline Tracking ===
    
    // Context agent tracking
    contextAgentName?: string;     // Agent doing pre-task context gathering
    contextBriefPath?: string;     // Path to the task context brief file
    
    // Review loop tracking
    reviewIterations: number;      // How many review cycles (starts at 0)
    currentReviewerName?: string;  // Agent doing code review
    lastReviewFeedback?: string;   // Feedback from last review (if changes requested)
    lastReviewResult?: 'approved' | 'changes_requested';
    
    // Post-approval tracking
    deltaContextAgentName?: string;  // Agent doing delta context update
    deltaContextDone: boolean;       // Whether delta context update is complete
    unityRequestQueued: boolean;     // Whether Unity request has been queued
    
    // Completion tracking
    completionReviewResult?: 'complete' | 'needs_work' | 'unclear';
    relatedErrors?: string[];        // Errors related to this task (from completion review)
}

/**
 * Waiting task entry - task waiting for Unity result
 */
export interface WaitingTask {
    task: ManagedTask;
    unityTaskId: string;
    waitingFor: 'compile' | 'test_editmode' | 'test_playmode';
    queuedAt: string;
    estimatedWaitMs?: number;
}

/**
 * Session context for continuity across sessions
 */
export interface SessionContext {
    sessionId: string;
    previousSummary?: string;        // What was done in previous session
    pendingErrors: string[];         // Errors waiting to be fixed
    lastTaskState?: {
        taskId: string;
        stage: TaskStage;
        filesModified: string[];
    };
}

/**
 * Agent role in the execution pipeline
 */
export type AgentRole = 'context' | 'engineer' | 'reviewer' | 'delta_context';

/**
 * Agent assignment tracking (unified for all roles)
 * This is the canonical source of truth for agent assignments.
 * AgentPoolService provides allocation, but TaskManager tracks assignments.
 */
export interface AgentAssignment {
    agentName: string;
    sessionId: string;
    currentRole: AgentRole;
    status: 'idle' | 'working' | 'waiting' | 'error_fixing';
    
    // Current work
    currentTask?: ManagedTask;
    currentTaskId?: string;
    
    // Tasks waiting for Unity results (agent can work on other tasks)
    waitingTasks: WaitingTask[];
    
    // Context for error routing
    taskHistory: string[];          // Task IDs completed
    filesModified: string[];        // All files touched
    errorContext: Map<string, string[]>;  // errorId -> related files
    
    // Session info
    logFile: string;
    processId?: number;
    
    // Session continuity
    sessionContext: SessionContext;
    
    // Timing
    assignedAt: string;
    lastActivityAt: string;
}

/**
 * Task dispatch decision
 */
export interface DispatchDecision {
    task: ManagedTask;
    agent: AgentAssignment;
    reason: string;
}

/**
 * Session registration info
 */
interface SessionRegistration {
    sessionId: string;
    planPath: string;
    registeredAt: string;
}

/**
 * Paused task notification
 */
export interface PausedTaskNotification {
    sessionId: string;
    taskIds: string[];
    reason: string;
    pausedAt: string;
}

/**
 * Error for creating error-fixing tasks
 */
export interface ErrorInfo {
    id: string;
    message: string;
    file?: string;
    line?: number;
    code?: string;
}

/**
 * Special session ID for error resolution
 */
export const ERROR_RESOLUTION_SESSION_ID = 'ERROR_RESOLUTION';

// TaskOccupancyEntry imported from '../types'

/**
 * Conflict resolution strategy
 */
export type ConflictResolution = 'pause_others' | 'wait_for_others' | 'abort_if_occupied';

/**
 * Task conflict declaration
 */
export interface TaskConflictInfo {
    taskIds: string[];
    resolution: ConflictResolution;
    reason?: string;
}

/**
 * Task Manager - Global Task Coordinator
 * 
 * Manages ALL tasks across ALL plans:
 * - Tracks task dependencies and status globally
 * - Provides cross-plan file overlap detection
 * - Routes errors to relevant tasks/sessions
 * - Manages engineer assignments
 * - Creates error-fixing tasks
 * 
 * Obtain via ServiceLocator:
 *   const taskManager = ServiceLocator.resolve(TaskManager);
 */
export class TaskManager {
    // Global task storage (all tasks from all plans)
    private tasks: Map<string, ManagedTask> = new Map();
    
    // Agent tracking (global) - unified for all roles (engineer, context, reviewer, etc.)
    private agents: Map<string, AgentAssignment> = new Map();
    
    // Session tracking
    private sessions: Map<string, SessionRegistration> = new Map();
    
    // File-to-task index for O(1) lookups
    // Maps normalized filename (basename) -> Set of task IDs that modify that file
    private fileToTaskIndex: Map<string, Set<string>> = new Map();
    
    // Task occupancy tracking - which workflow owns which task
    // Key: taskId, Value: occupancy info
    private taskOccupancy: Map<string, TaskOccupancyEntry> = new Map();
    
    // Reverse lookup: workflowId -> taskIds it occupies
    private workflowOccupancy: Map<string, string[]> = new Map();
    
    // Workflows waiting for conflicts to resolve
    private waitingForConflicts: Map<string, {
        workflowId: string;
        conflictingTaskIds: string[];
        blockedByWorkflowIds: string[];
    }> = new Map();
    
    // Failed task tracking per session
    // Key: sessionId_taskId (global task ID format)
    private failedTasks: Map<string, FailedTask> = new Map();
    
    private outputManager: OutputChannelManager;

    // Callbacks
    private onTaskCompletedCallback?: (task: ManagedTask) => void;
    private onAgentIdleCallback?: (agent: AgentAssignment) => void;
    private onTasksPausedCallback?: (notification: PausedTaskNotification) => void;

    constructor() {
        this.outputManager = ServiceLocator.resolve(OutputChannelManager);
        this.log('Global TaskManager initialized');
    }
    
    // ========================================================================
    // File-to-Task Index Management
    // ========================================================================
    
    /**
     * Update the file-to-task index when a task's filesModified changes
     */
    private updateFileIndex(taskId: string, oldFiles: string[], newFiles: string[]): void {
        // Remove old file mappings
        for (const file of oldFiles) {
            const basename = path.basename(file);
            const taskIds = this.fileToTaskIndex.get(basename);
            if (taskIds) {
                taskIds.delete(taskId);
                if (taskIds.size === 0) {
                    this.fileToTaskIndex.delete(basename);
                }
            }
        }
        
        // Add new file mappings
        for (const file of newFiles) {
            const basename = path.basename(file);
            let taskIds = this.fileToTaskIndex.get(basename);
            if (!taskIds) {
                taskIds = new Set();
                this.fileToTaskIndex.set(basename, taskIds);
            }
            taskIds.add(taskId);
        }
    }
    
    /**
     * Add files to the index for a task (used when adding new files)
     */
    private addFilesToIndex(taskId: string, files: string[]): void {
        for (const file of files) {
            const basename = path.basename(file);
            let taskIds = this.fileToTaskIndex.get(basename);
            if (!taskIds) {
                taskIds = new Set();
                this.fileToTaskIndex.set(basename, taskIds);
            }
            taskIds.add(taskId);
        }
    }
    
    /**
     * Remove a task from the file index entirely
     */
    private removeTaskFromFileIndex(taskId: string): void {
        for (const taskIds of this.fileToTaskIndex.values()) {
            taskIds.delete(taskId);
        }
        // Clean up empty sets
        for (const [basename, taskIds] of this.fileToTaskIndex) {
            if (taskIds.size === 0) {
                this.fileToTaskIndex.delete(basename);
            }
        }
    }
    
    // ========================================================================
    // Stage/Status Helpers
    // ========================================================================
    
    /**
     * Derive TaskStatus from TaskStage
     * This helper ensures consistency between stage and status tracking.
     * 
     * The relationship:
     * - stage = execution pipeline position (what phase of implementation)
     * - status = coordinator tracking (for dependency resolution and dispatch)
     * 
     * @param stage The current task stage
     * @returns The corresponding task status
     */
    static stageToStatus(stage: TaskStage): TaskStatus {
        switch (stage) {
            case 'pending':
                return 'pending';
            case 'context_gathering':
                return 'context_in_progress';
            case 'ready_for_agent':
                return 'ready_for_agent';
            case 'implementing':
                return 'agent_working';
            case 'ready_for_review':
                return 'ready_for_review';
            case 'reviewing':
                return 'review_in_progress';
            case 'review_changes_requested':
                return 'review_changes';
            case 'approved':
            case 'delta_context_updating':
            case 'implemented':
                return 'approved';
            case 'awaiting_unity':
            case 'compiling':
            case 'compiled':
            case 'testing_editmode':
            case 'testing_playmode':
            case 'waiting_player_test':
            case 'test_passed':
                return 'waiting_unity';
            case 'compile_failed':
            case 'test_failed':
            case 'error_fixing':
                return 'error_fixing';
            case 'paused':
            case 'deferred':
                return 'paused';
            case 'needs_work':
                return 'needs_work';
            case 'completed':
                return 'completed';
            case 'failed':
                return 'failed';
            default:
                return 'pending';
        }
    }
    
    /**
     * Update task status to match stage (for consistency)
     * Call this after updating a task's stage to ensure status is synchronized.
     */
    syncTaskStatusWithStage(taskId: string): void {
        const task = this.tasks.get(taskId);
        if (task) {
            const derivedStatus = TaskManager.stageToStatus(task.stage);
            if (task.status !== derivedStatus) {
                this.log(`Syncing status for ${taskId}: ${task.status} -> ${derivedStatus} (from stage ${task.stage})`);
                task.status = derivedStatus;
            }
        }
    }

    // ========================================================================
    // Session Registration
    // ========================================================================
    
    /**
     * Register a session/plan with the global TaskManager
     * Call this when starting execution for a plan
     */
    registerSession(sessionId: string, planPath: string): void {
        if (this.sessions.has(sessionId)) {
            this.log(`Session ${sessionId} already registered, updating plan path`);
        }
        
        this.sessions.set(sessionId, {
            sessionId,
            planPath,
            registeredAt: new Date().toISOString()
        });
        
        this.log(`Registered session: ${sessionId} with plan: ${planPath}`);
    }
    
    /**
     * Unregister a session when it completes or is cancelled
     */
    unregisterSession(sessionId: string): void {
        this.sessions.delete(sessionId);
        
        // Optionally clean up tasks for this session
        // (or keep them for history - configurable)
        this.log(`Unregistered session: ${sessionId}`);
    }
    
    /**
     * Get all registered sessions
     */
    getRegisteredSessions(): string[] {
        return Array.from(this.sessions.keys());
    }
    
    /**
     * Get session registration info
     */
    getSessionInfo(sessionId: string): SessionRegistration | undefined {
        return this.sessions.get(sessionId);
    }

    // ========================================================================
    // Task Initialization
    // ========================================================================

    /**
     * Initialize tasks from plan file for a specific session
     * Task IDs are prefixed with sessionId for global uniqueness
     */
    initializeFromPlan(sessionId: string, planData: ParsedPlan): void {
        this.log(`Initializing tasks for session ${sessionId}...`);

        let taskIndex = 0;
        let completedCount = 0;
        let pendingCount = 0;
        
        for (const [engineerName, planTasks] of Object.entries(planData.engineerChecklists)) {
            for (const planTask of planTasks) {
                // Create globally unique task ID
                const globalTaskId = `${sessionId}_${planTask.id}`;
                
                // Determine requirements from task description
                const requirements = this.inferTaskRequirements(planTask.description);
                
                const isCompleted = planTask.completed;
                if (isCompleted) {
                    completedCount++;
                    this.log(`  ✓ Task ${globalTaskId} already completed (skipping)`);
                } else {
                    pendingCount++;
                }
                
                // Convert dependencies to global IDs
                const globalDependencies = (planTask.dependencies || []).map(
                    dep => `${sessionId}_${dep}`
                );
                
                const managedTask: ManagedTask = {
                    id: globalTaskId,
                    sessionId,
                    description: planTask.description,
                    assignedAgent: engineerName,
                    status: isCompleted ? 'completed' : 'pending',
                    stage: isCompleted ? 'completed' : 'pending',
                    requirements,
                    dependencies: globalDependencies,
                    dependents: [],
                    priority: taskIndex++,
                    createdAt: new Date().toISOString(),
                    filesModified: [],
                    unityRequests: [],
                    errors: [],
                    reviewIterations: 0,
                    deltaContextDone: false,
                    unityRequestQueued: false
                };

                this.tasks.set(globalTaskId, managedTask);
            }
        }
        
        this.log(`  ${completedCount} tasks already completed, ${pendingCount} tasks pending`);

        // Build dependents graph (reverse of dependencies) for this session
        for (const task of this.tasks.values()) {
            if (task.sessionId !== sessionId) continue;
            
            for (const depId of task.dependencies) {
                const depTask = this.tasks.get(depId);
                if (depTask) {
                    depTask.dependents.push(task.id);
                }
            }
        }

        // Calculate initial ready status
        this.updateReadyTasksForSession(sessionId);

        const sessionTasks = this.getTasksForSession(sessionId);
        this.log(`Initialized ${sessionTasks.length} tasks for session ${sessionId}`);
        this.log(`Ready tasks: ${this.getReadyTasksForSession(sessionId).length}`);
    }

    /**
     * Infer task requirements from description
     */
    private inferTaskRequirements(description: string): TaskRequirements {
        const descLower = description.toLowerCase();
        const taskType = this.inferTaskType(descLower);
        
        switch (taskType) {
            case 'data_logic':
                return {
                    taskType,
                    needsCompile: true,
                    needsEditModeTest: true,
                    needsPlayModeTest: false,
                    needsPlayerTest: false
                };
                
            case 'scene_ui':
                return {
                    taskType,
                    needsCompile: true,
                    needsEditModeTest: false,
                    needsPlayModeTest: true,
                    needsPlayerTest: false
                };
                
            case 'gameplay':
                return {
                    taskType,
                    needsCompile: true,
                    needsEditModeTest: true,
                    needsPlayModeTest: true,
                    needsPlayerTest: true
                };
                
            case 'error_fix':
                // Error-fixing tasks just need compile verification
                return {
                    taskType,
                    needsCompile: true,
                    needsEditModeTest: false,
                    needsPlayModeTest: false,
                    needsPlayerTest: false
                };
                
            case 'component':
            default:
                const isComplex = descLower.includes('logic') || 
                                  descLower.includes('algorithm') ||
                                  descLower.includes('state') ||
                                  descLower.includes('calculate');
                return {
                    taskType,
                    needsCompile: true,
                    needsEditModeTest: isComplex,
                    needsPlayModeTest: false,
                    needsPlayerTest: false
                };
        }
    }
    
    /**
     * Infer task type from description keywords
     */
    private inferTaskType(descLower: string): TaskType {
        const gameplayKeywords = [
            'gameplay', 'mechanic', 'player', 'input', 'movement',
            'combat', 'physics', 'feel', 'balance', 'game loop',
            'controller', 'character'
        ];
        if (gameplayKeywords.some(k => descLower.includes(k))) {
            return 'gameplay';
        }
        
        const sceneUiKeywords = [
            'scene', 'ui', 'canvas', 'prefab', 'layout', 'menu',
            'panel', 'button', 'screen', 'hud', 'animation', 
            'visual', 'spawn', 'instantiate'
        ];
        if (sceneUiKeywords.some(k => descLower.includes(k))) {
            return 'scene_ui';
        }
        
        const dataLogicKeywords = [
            'data', 'logic', 'algorithm', 'calculate', 'detect',
            'match', 'score', 'state machine', 'validator', 'parser',
            'utility', 'helper', 'service locator', 'math'
        ];
        if (dataLogicKeywords.some(k => descLower.includes(k))) {
            return 'data_logic';
        }
        
        return 'component';
    }

    // ========================================================================
    // Cross-Plan Task Queries
    // ========================================================================
    
    /**
     * Get all tasks for a specific session
     */
    getTasksForSession(sessionId: string): ManagedTask[] {
        return Array.from(this.tasks.values())
            .filter(t => t.sessionId === sessionId);
    }
    
    /**
     * Get ready tasks for a specific session
     */
    getReadyTasksForSession(sessionId: string): ManagedTask[] {
        return Array.from(this.tasks.values())
            .filter(t => t.sessionId === sessionId && t.status === 'ready')
            .sort((a, b) => a.priority - b.priority);
    }
    
    /**
     * Get all ready tasks across ALL sessions (for global dispatch)
     */
    getAllReadyTasks(): ManagedTask[] {
        return Array.from(this.tasks.values())
            .filter(t => t.status === 'ready')
            .sort((a, b) => a.priority - b.priority);
    }
    
    /**
     * Find tasks across ALL plans that touch the given files
     * Uses file-to-task index for O(1) lookups per file instead of O(n*m) scan.
     * Used for cross-plan conflict detection and error attribution.
     */
    findAffectedTasksAcrossPlans(files: string[]): Array<{ taskId: string; sessionId: string; filesOverlap: string[] }> {
        // Use index for fast lookup: collect candidate task IDs from all files
        const candidateTaskIds = new Set<string>();
        const fileBasenames = files.map(f => path.basename(f));
        
        for (const basename of fileBasenames) {
            const taskIds = this.fileToTaskIndex.get(basename);
            if (taskIds) {
                for (const taskId of taskIds) {
                    candidateTaskIds.add(taskId);
                }
            }
        }
        
        // Build result from candidates (already filtered by index)
        const affected: Array<{ taskId: string; sessionId: string; filesOverlap: string[] }> = [];
        
        for (const taskId of candidateTaskIds) {
            const task = this.tasks.get(taskId);
            if (!task) continue;
            
            // Skip completed tasks
            if (task.status === 'completed' || task.status === 'failed') continue;
            
            // Verify actual file overlap (index is based on basename, need full path check)
            const overlap = files.filter(f => 
                task.filesModified.some(tf => 
                    tf === f || 
                    tf.endsWith(path.basename(f)) ||
                    f.endsWith(path.basename(tf))
                )
            );
            
            if (overlap.length > 0) {
                affected.push({
                    taskId: task.id,
                    sessionId: task.sessionId,
                    filesOverlap: overlap
                });
            }
        }
        
        return affected;
    }
    
    /**
     * Pause tasks and their dependents
     * Returns a map of sessionId -> paused task IDs for notification
     */
    pauseTasksAndDependents(
        taskIds: string[], 
        reason: string
    ): Map<string, string[]> {
        const pausedBySession = new Map<string, string[]>();
        const toPause = new Set<string>(taskIds);
        const processed = new Set<string>();
        
        // BFS to find all dependents
        while (toPause.size > processed.size) {
            for (const taskId of toPause) {
                if (processed.has(taskId)) continue;
                processed.add(taskId);
                
                const task = this.tasks.get(taskId);
                if (!task) continue;
                
                // Add dependents to pause list
                for (const dependentId of task.dependents) {
                    toPause.add(dependentId);
                }
            }
        }
        
        // Pause all tasks
        const now = new Date().toISOString();
        for (const taskId of toPause) {
            const task = this.tasks.get(taskId);
            if (!task) continue;
            
            // Don't pause already completed/failed tasks
            if (task.status === 'completed' || task.status === 'failed') continue;
            
            // Store previous state for resume
            task.previousStage = task.stage;
            task.stage = 'paused';
            task.status = 'paused';
            task.pausedAt = now;
            task.pausedReason = reason;
            
            // Track by session
            if (!pausedBySession.has(task.sessionId)) {
                pausedBySession.set(task.sessionId, []);
            }
            pausedBySession.get(task.sessionId)!.push(taskId);
            
            this.log(`Paused task ${taskId} (${task.sessionId}): ${reason}`);
        }
        
        // Fire callback for each session
        for (const [sessionId, pausedTaskIds] of pausedBySession) {
            this.onTasksPausedCallback?.({
                sessionId,
                taskIds: pausedTaskIds,
                reason,
                pausedAt: now
            });
        }
        
        return pausedBySession;
    }
    
    /**
     * Resume paused tasks
     */
    resumePausedTasks(taskIds: string[]): void {
        for (const taskId of taskIds) {
            const task = this.tasks.get(taskId);
            if (!task || task.stage !== 'paused') continue;
            
            // Restore previous state
            if (task.previousStage) {
                task.stage = task.previousStage;
                // Map stage to appropriate status
                task.status = this.stageToStatus(task.stage);
            } else {
                task.stage = 'ready_for_agent';
                task.status = 'ready';
            }
            
            task.pausedAt = undefined;
            task.pausedReason = undefined;
            task.previousStage = undefined;
            
            this.log(`Resumed task ${taskId}`);
        }
        
        // Update ready tasks for affected sessions
        const sessions = new Set(taskIds.map(id => this.tasks.get(id)?.sessionId).filter(Boolean));
        for (const sessionId of sessions) {
            this.updateReadyTasksForSession(sessionId!);
        }
    }
    
    /**
     * Map stage to status
     */
    private stageToStatus(stage: TaskStage): TaskStatus {
        const mapping: Partial<Record<TaskStage, TaskStatus>> = {
            'pending': 'pending',
            'context_gathering': 'context_in_progress',
            'ready_for_agent': 'ready_for_agent',
            'implementing': 'agent_working',
            'ready_for_review': 'ready_for_review',
            'reviewing': 'review_in_progress',
            'review_changes_requested': 'review_changes',
            'approved': 'approved',
            'implemented': 'implemented',
            'awaiting_unity': 'waiting_unity',
            'error_fixing': 'error_fixing',
            'completed': 'completed',
            'failed': 'failed'
        };
        return mapping[stage] || 'ready';
    }

    // ========================================================================
    // Error-Fixing Task Creation
    // ========================================================================
    
    /**
     * Create error-fixing tasks from Unity errors
     * Groups errors by file and creates tasks in the ERROR_RESOLUTION session
     * 
     * @returns Created task IDs
     */
    createErrorFixingTasks(
        errors: ErrorInfo[],
        affectedTaskIds?: string[]
    ): string[] {
        const createdTaskIds: string[] = [];
        
        // Group errors by file
        const errorsByFile = new Map<string, ErrorInfo[]>();
        for (const error of errors) {
            const key = error.file || 'unknown';
            if (!errorsByFile.has(key)) {
                errorsByFile.set(key, []);
            }
            errorsByFile.get(key)!.push(error);
        }
        
        // Create one task per file (or group of related files)
        let errorTaskIndex = 0;
        const now = Date.now();
        
        for (const [file, fileErrors] of errorsByFile) {
            const taskId = `ERR_FIX_${now}_${errorTaskIndex++}`;
            
            // Find related original task by checking filesModified
            let relatedTask: ManagedTask | undefined;
            let relatedSessionId: string | undefined;
            
            for (const task of this.tasks.values()) {
                if (task.filesModified.some(f => f.includes(file) || file.includes(path.basename(f)))) {
                    relatedTask = task;
                    relatedSessionId = task.sessionId;
                    break;
                }
            }
            
            const description = fileErrors.length === 1
                ? `Fix error: ${fileErrors[0].message.substring(0, 80)}`
                : `Fix ${fileErrors.length} errors in ${path.basename(file)}`;
            
            const errorTask: ManagedTask = {
                id: taskId,
                sessionId: ERROR_RESOLUTION_SESSION_ID,
                description,
                assignedAgent: relatedTask?.actualAgent || relatedTask?.assignedAgent,
                status: 'ready',  // Error tasks are immediately ready
                stage: 'error_fixing',
                requirements: {
                    taskType: 'error_fix',
                    needsCompile: true,
                    needsEditModeTest: false,
                    needsPlayModeTest: false,
                    needsPlayerTest: false
                },
                dependencies: [],  // No dependencies - fix ASAP
                dependents: affectedTaskIds || [],  // Tasks blocked by this error
                priority: -1,  // Highest priority (negative = before normal tasks)
                createdAt: new Date().toISOString(),
                filesModified: [file],
                unityRequests: [],
                errors: fileErrors.map(e => e.id),
                reviewIterations: 0,
                deltaContextDone: false,
                unityRequestQueued: false,
                // Store related session for attribution
                sessionSummary: relatedSessionId ? `Related to session: ${relatedSessionId}` : undefined
            };
            
            this.tasks.set(taskId, errorTask);
            createdTaskIds.push(taskId);
            
            this.log(`Created error-fixing task ${taskId}: ${description}`);
        }
        
        return createdTaskIds;
    }
    
    /**
     * Get all error-fixing tasks
     */
    getErrorFixingTasks(): ManagedTask[] {
        return Array.from(this.tasks.values())
            .filter(t => t.sessionId === ERROR_RESOLUTION_SESSION_ID)
            .sort((a, b) => a.priority - b.priority);
    }
    
    /**
     * Get pending error-fixing tasks
     */
    getPendingErrorFixingTasks(): ManagedTask[] {
        return this.getErrorFixingTasks()
            .filter(t => t.status !== 'completed' && t.status !== 'failed');
    }
    
    /**
     * Mark error-fixing task as resolved and resume affected tasks
     */
    resolveErrorFixingTask(taskId: string): void {
        const task = this.tasks.get(taskId);
        if (!task || task.sessionId !== ERROR_RESOLUTION_SESSION_ID) return;
        
        task.status = 'completed';
        task.stage = 'completed';
        task.completedAt = new Date().toISOString();
        
        // Resume tasks that were blocked by this error
        if (task.dependents.length > 0) {
            this.resumePausedTasks(task.dependents);
            this.log(`Resumed ${task.dependents.length} tasks after error fix`);
        }
        
        this.log(`Error-fixing task ${taskId} resolved`);
        this.onTaskCompletedCallback?.(task);
    }

    // ========================================================================
    // Agent Management
    // ========================================================================

    /**
     * Register an agent with the TaskManager
     */
    registerAgent(
        agentName: string,
        sessionId: string,
        logFile: string,
        roleId: AgentRole = 'engineer'
    ): AgentAssignment {
        const assignment: AgentAssignment = {
            agentName,
            sessionId,
            status: 'idle',
            currentRole: roleId,
            waitingTasks: [],
            taskHistory: [],
            filesModified: [],
            errorContext: new Map(),
            logFile,
            sessionContext: {
                sessionId,
                pendingErrors: []
            },
            assignedAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString()
        };

        this.agents.set(agentName, assignment);
        this.log(`Registered agent: ${agentName} for session ${sessionId} (role: ${roleId})`);
        return assignment;
    }
    
    /**
     * Update an agent's role
     */
    updateAgentRole(agentName: string, roleId: AgentRole): void {
        const agent = this.agents.get(agentName);
        if (agent) {
            agent.currentRole = roleId;
            agent.lastActivityAt = new Date().toISOString();
            this.log(`Updated ${agentName} role to: ${roleId}`);
        }
    }
    
    /**
     * Get agent assignments for UI display
     * Returns all engineers with their current role and task info
     */
    getAgentAssignmentsForUI(): Array<{
        name: string;
        roleId: AgentRole;
        status: AgentAssignment['status'];
        sessionId: string;
        currentTaskId?: string;
        logFile: string;
        processId?: number;
        assignedAt: string;
        lastActivityAt: string;
    }> {
        return Array.from(this.agents.values()).map(a => ({
            name: a.agentName,
            roleId: a.currentRole,
            status: a.status,
            sessionId: a.sessionId,
            currentTaskId: a.currentTaskId || a.currentTask?.id,
            logFile: a.logFile,
            processId: a.processId,
            assignedAt: a.assignedAt,
            lastActivityAt: a.lastActivityAt
        }));
    }

    /**
     * Update which tasks are ready (dependencies satisfied) for a session
     */
    private updateReadyTasksForSession(sessionId: string): void {
        for (const task of this.tasks.values()) {
            if (task.sessionId !== sessionId) continue;
            if (task.status !== 'pending') continue;

            const depsCompleted = task.dependencies.every(depId => {
                const depTask = this.tasks.get(depId);
                return depTask && depTask.status === 'completed';
            });

            if (depsCompleted) {
                task.status = 'ready';
            }
        }
    }
    
    /**
     * Update ready tasks globally (all sessions)
     */
    updateReadyTasks(): void {
        for (const sessionId of this.sessions.keys()) {
            this.updateReadyTasksForSession(sessionId);
        }
    }

    /**
     * Get all ready tasks for a session (can be dispatched)
     */
    getReadyTasks(): ManagedTask[] {
        return Array.from(this.tasks.values())
            .filter(t => t.status === 'ready')
            .sort((a, b) => a.priority - b.priority);
    }

    /**
     * Get idle engineers
     */
    /**
     * Get idle agents
     */
    getIdleAgents(): AgentAssignment[] {
        return Array.from(this.agents.values())
            .filter(a => a.status === 'idle');
    }
    
    /**
     * Get best task for an agent (considers all sessions)
     */
    getBestTaskForAgent(agentName: string): ManagedTask | undefined {
        const agent = this.agents.get(agentName);
        if (!agent) return undefined;
        
        // Priority 1: Error-fixing tasks (highest priority)
        const errorTasks = this.getPendingErrorFixingTasks()
            .filter(t => t.status === 'ready');
        if (errorTasks.length > 0) {
            return errorTasks[0];
        }
        
        // Priority 2: Tasks assigned to this agent in their session
        const readyTasks = this.getReadyTasksForSession(agent.sessionId);
        const assignedTask = readyTasks.find(t => t.assignedAgent === agentName);
        if (assignedTask) return assignedTask;

        // Priority 3: Any ready task in their session
        const idleAgents = new Set(this.getIdleAgents().map(a => a.agentName));
        
        for (const task of readyTasks) {
            if (task.assignedAgent && 
                task.assignedAgent !== agentName && 
                idleAgents.has(task.assignedAgent)) {
                continue;
            }
            return task;
        }

        return undefined;
    }
    
    /**
     * Find optimal dispatch decisions
     */
    findDispatchDecisions(): DispatchDecision[] {
        const decisions: DispatchDecision[] = [];
        const idleAgents = this.getIdleAgents();

        if (idleAgents.length === 0) {
            return [];
        }

        const assignedTasks = new Set<string>();

        for (const agent of idleAgents) {
            const task = this.getBestTaskForAgent(agent.agentName);
            
            if (task && !assignedTasks.has(task.id)) {
                decisions.push({
                    task,
                    agent,
                    reason: task.sessionId === ERROR_RESOLUTION_SESSION_ID
                        ? `Error-fixing task for ${agent.agentName}`
                        : task.assignedAgent === agent.agentName
                            ? `Assigned task for ${agent.agentName}`
                            : `Available task for idle ${agent.agentName}`
                });
                assignedTasks.add(task.id);
            }
        }

        return decisions;
    }

    /**
     * Dispatch a task to an agent
     */
    dispatchTask(taskId: string, agentName: string): void {
        const task = this.tasks.get(taskId);
        const agent = this.agents.get(agentName);

        if (!task || !agent) {
            this.log(`Cannot dispatch: task=${taskId} agent=${agentName}`);
            return;
        }

        task.status = 'agent_assigned';
        task.actualAgent = agentName;
        task.dispatchedAt = new Date().toISOString();

        agent.status = 'working';
        agent.currentTask = task;
        agent.lastActivityAt = new Date().toISOString();

        this.log(`Dispatched ${taskId} to ${agentName}`);
    }

    /**
     * Mark task as in progress
     */
    markTaskInProgress(taskId: string): void {
        const task = this.tasks.get(taskId);
        if (task) {
            task.status = 'agent_working';
            task.stage = 'implementing';
            task.startedAt = new Date().toISOString();
            this.log(`Task ${taskId} in progress`);
        }
    }

    /**
     * Reset task to ready
     */
    resetTaskToReady(taskId: string): void {
        const task = this.tasks.get(taskId);
        if (task && (task.status === 'agent_working' || task.status === 'agent_assigned')) {
            task.status = 'ready';
            task.actualAgent = undefined;
            this.log(`Task ${taskId} reset to ready`);
        }
    }

    /**
     * Mark task as completed
     */
    markTaskCompleted(taskId: string, filesModified?: string[]): void {
        const task = this.tasks.get(taskId);
        if (!task) return;

        task.status = 'completed';
        task.stage = 'completed';
        task.completedAt = new Date().toISOString();
        
        if (filesModified) {
            const oldFiles = task.filesModified;
            task.filesModified = [...new Set([...task.filesModified, ...filesModified])];
            // Update file-to-task index with new files
            this.addFilesToIndex(taskId, filesModified.filter(f => !oldFiles.includes(f)));
        }

        // Update agent context
        if (task.actualAgent) {
            const agent = this.agents.get(task.actualAgent);
            if (agent) {
                agent.taskHistory.push(taskId);
                agent.filesModified.push(...(filesModified || []));
                agent.currentTask = undefined;
                agent.status = 'idle';
                agent.lastActivityAt = new Date().toISOString();
                this.onAgentIdleCallback?.(agent);
            }
        }

        // Update ready tasks for this session
        this.updateReadyTasksForSession(task.sessionId);
        
        this.onTaskCompletedCallback?.(task);
        this.log(`Task ${taskId} completed`);
    }

    /**
     * Mark task as failed
     */
    markTaskFailed(taskId: string, reason?: string): void {
        const task = this.tasks.get(taskId);
        if (!task) return;

        task.status = 'failed';
        task.stage = 'failed';
        task.completedAt = new Date().toISOString();

        if (task.actualAgent) {
            const agent = this.agents.get(task.actualAgent);
            if (agent) {
                agent.currentTask = undefined;
                agent.status = 'idle';
                this.onAgentIdleCallback?.(agent);
            }
        }

        this.log(`Task ${taskId} failed: ${reason || 'unknown'}`);
    }

    // ========================================================================
    // Task Stage Management
    // ========================================================================

    /**
     * Update task stage with reason
     */
    updateTaskStage(taskId: string, stage: TaskStage, reason?: string): void {
        const task = this.tasks.get(taskId);
        if (!task) {
            this.log(`Task ${taskId} not found for stage update`);
            return;
        }

        const oldStage = task.stage;
        task.stage = stage;
        task.status = this.stageToStatus(stage);

        if (stage === 'completed') {
            task.completedAt = new Date().toISOString();
            this.updateReadyTasksForSession(task.sessionId);
            this.onTaskCompletedCallback?.(task);
        } else if (stage === 'failed') {
            task.completedAt = new Date().toISOString();
        }

        this.log(`Task ${taskId}: ${oldStage} → ${stage}${reason ? ` (${reason})` : ''}`);
    }

    /**
     * Get task's current stage
     */
    getTaskStage(taskId: string): TaskStage | undefined {
        return this.tasks.get(taskId)?.stage;
    }

    /**
     * Get a specific task by ID
     */
    getTask(taskId: string): ManagedTask | undefined {
        return this.tasks.get(taskId);
    }

    /**
     * Get all tasks
     */
    getAllTasks(): ManagedTask[] {
        return Array.from(this.tasks.values());
    }

    /**
     * Get all engineers
     */
    /**
     * Get all agents
     */
    getAllAgents(): AgentAssignment[] {
        return Array.from(this.agents.values());
    }
    
    /**
     * Get agent by name
     */
    getAgent(agentName: string): AgentAssignment | undefined {
        return this.agents.get(agentName);
    }
    
    /**
     * Release agent
     */
    releaseAgent(agentName: string): void {
        this.agents.delete(agentName);
        this.log(`Released agent ${agentName}`);
    }
    
    /**
     * Get progress for a session
     */
    getProgressForSession(sessionId: string): {
        completed: number;
        inProgress: number;
        ready: number;
        pending: number;
        paused: number;
        total: number;
        percentage: number;
    } {
        const tasks = this.getTasksForSession(sessionId);
        const completed = tasks.filter(t => t.status === 'completed').length;
        const inProgress = tasks.filter(t => 
            ['agent_assigned', 'agent_working', 'context_in_progress', 
             'review_in_progress', 'approved', 'waiting_unity', 'error_fixing'].includes(t.status)
        ).length;
        const ready = tasks.filter(t => 
            ['ready', 'ready_for_agent', 'ready_for_review'].includes(t.status)
        ).length;
        const pending = tasks.filter(t => t.status === 'pending').length;
        const paused = tasks.filter(t => t.status === 'paused').length;

        return {
            completed,
            inProgress,
            ready,
            pending,
            paused,
            total: tasks.length,
            percentage: tasks.length > 0 ? (completed / tasks.length) * 100 : 0
        };
    }

    // ========================================================================
    // Callbacks
    // ========================================================================

    onTaskCompleted(callback: (task: ManagedTask) => void): void {
        this.onTaskCompletedCallback = callback;
    }

    /**
     * Register callback for when an agent becomes idle
     */
    onAgentIdle(callback: (agent: AgentAssignment) => void): void {
        this.onAgentIdleCallback = callback;
    }
    
    onTasksPaused(callback: (notification: PausedTaskNotification) => void): void {
        this.onTasksPausedCallback = callback;
    }

    // ========================================================================
    // Task Occupancy Management
    // ========================================================================
    
    /**
     * Declare that a workflow is occupying tasks
     * 
     * @param workflowId The workflow claiming occupancy
     * @param taskIds Task IDs being occupied
     * @param type 'exclusive' (only this workflow) or 'shared' (multiple allowed)
     * @param reason Optional reason for occupancy
     * @returns List of task IDs that couldn't be occupied (already exclusive)
     */
    declareTaskOccupancy(
        workflowId: string,
        taskIds: string[],
        type: 'exclusive' | 'shared',
        reason?: string
    ): string[] {
        const failed: string[] = [];
        
        for (const taskId of taskIds) {
            const existing = this.taskOccupancy.get(taskId);
            if (existing && existing.type === 'exclusive' && existing.workflowId !== workflowId) {
                this.log(`⚠️ Task ${taskId} already occupied by ${existing.workflowId}, cannot occupy`);
                failed.push(taskId);
                continue;
            }
            
            this.taskOccupancy.set(taskId, {
                workflowId,
                type,
                declaredAt: new Date().toISOString(),
                reason
            });
        }
        
        // Update reverse lookup
        const existing = this.workflowOccupancy.get(workflowId) || [];
        const newOccupied = taskIds.filter(id => !failed.includes(id));
        this.workflowOccupancy.set(workflowId, [...new Set([...existing, ...newOccupied])]);
        
        if (newOccupied.length > 0) {
            this.log(`📌 Workflow ${workflowId.substring(0, 8)} occupies tasks: ${newOccupied.join(', ')} (${type})`);
        }
        
        return failed;
    }
    
    /**
     * Release task occupancy for a workflow
     */
    releaseTaskOccupancy(workflowId: string, taskIds: string[]): void {
        for (const taskId of taskIds) {
            const entry = this.taskOccupancy.get(taskId);
            if (entry && entry.workflowId === workflowId) {
                this.taskOccupancy.delete(taskId);
            }
        }
        
        // Update reverse lookup
        const existing = this.workflowOccupancy.get(workflowId) || [];
        this.workflowOccupancy.set(workflowId, existing.filter(id => !taskIds.includes(id)));
        
        this.log(`📤 Workflow ${workflowId.substring(0, 8)} released tasks: ${taskIds.join(', ')}`);
    }
    
    /**
     * Release all task occupancy for a workflow
     */
    releaseAllTaskOccupancy(workflowId: string): void {
        const taskIds = this.workflowOccupancy.get(workflowId) || [];
        if (taskIds.length > 0) {
            this.releaseTaskOccupancy(workflowId, taskIds);
        }
        this.workflowOccupancy.delete(workflowId);
        this.waitingForConflicts.delete(workflowId);
    }
    
    /**
     * Check if a task is occupied
     */
    isTaskOccupied(taskId: string): boolean {
        return this.taskOccupancy.has(taskId);
    }
    
    /**
     * Get the workflow that occupies a task
     */
    getTaskOccupant(taskId: string): string | undefined {
        return this.taskOccupancy.get(taskId)?.workflowId;
    }
    
    /**
     * Get tasks occupied by a workflow
     */
    getWorkflowOccupiedTasks(workflowId: string): string[] {
        return this.workflowOccupancy.get(workflowId) || [];
    }
    
    /**
     * Check for conflicts with currently occupied tasks
     * 
     * @param workflowId The workflow checking for conflicts
     * @param taskIds Task IDs to check
     * @returns Array of {taskId, occupyingWorkflowId} for conflicts
     */
    checkTaskConflicts(
        workflowId: string,
        taskIds: string[]
    ): Array<{ taskId: string; occupyingWorkflowId: string }> {
        const conflicts: Array<{ taskId: string; occupyingWorkflowId: string }> = [];
        
        for (const taskId of taskIds) {
            const entry = this.taskOccupancy.get(taskId);
            if (entry && entry.workflowId !== workflowId && entry.type === 'exclusive') {
                conflicts.push({
                    taskId,
                    occupyingWorkflowId: entry.workflowId
                });
            }
        }
        
        return conflicts;
    }
    
    /**
     * Register a workflow as waiting for conflicts to resolve
     */
    registerWaitingForConflicts(
        workflowId: string,
        conflictingTaskIds: string[],
        blockedByWorkflowIds: string[]
    ): void {
        this.waitingForConflicts.set(workflowId, {
            workflowId,
            conflictingTaskIds,
            blockedByWorkflowIds
        });
        this.log(`⏳ Workflow ${workflowId.substring(0, 8)} waiting for conflicts to resolve`);
    }
    
    /**
     * Check if any waiting workflows can proceed after task release
     * 
     * @returns Array of workflow IDs that can now proceed
     */
    checkWaitingWorkflows(releasedTaskIds: string[]): string[] {
        const canProceed: string[] = [];
        
        for (const [waitingWorkflowId, waitInfo] of this.waitingForConflicts) {
            const stillBlocked = waitInfo.conflictingTaskIds.some(taskId => {
                if (releasedTaskIds.includes(taskId)) return false;
                return this.taskOccupancy.has(taskId);
            });
            
            if (!stillBlocked) {
                canProceed.push(waitingWorkflowId);
                this.waitingForConflicts.delete(waitingWorkflowId);
                this.log(`✅ Conflicts resolved for ${waitingWorkflowId.substring(0, 8)}`);
            }
        }
        
        return canProceed;
    }
    
    /**
     * Get all waiting workflows info
     */
    getWaitingWorkflows(): Map<string, { workflowId: string; conflictingTaskIds: string[]; blockedByWorkflowIds: string[] }> {
        return new Map(this.waitingForConflicts);
    }

    // ========================================================================
    // Failed Task Tracking
    // ========================================================================
    
    /**
     * Track a failed task with details for UI display and retry
     * 
     * @param sessionId The session the task belongs to
     * @param taskId The task ID (without session prefix)
     * @param workflowId The workflow that failed
     * @param errorMessage The error message
     * @param description Task description (optional, will look up from task)
     */
    trackFailedTask(
        sessionId: string,
        taskId: string,
        workflowId: string,
        errorMessage: string,
        description?: string
    ): FailedTask {
        const globalTaskId = `${sessionId}_${taskId}`;
        
        // Get task description from managed task if not provided
        if (!description) {
            const task = this.tasks.get(globalTaskId);
            description = task?.description || taskId;
        }
        
        // Classify the error
        const classifier = ServiceLocator.resolve(ErrorClassifier);
        const classification = classifier.classify(errorMessage);
        
        // Find blocked dependents
        const blockedDependents: string[] = [];
        const sessionTasks = this.getTasksForSession(sessionId);
        for (const task of sessionTasks) {
            if (task.dependencies?.includes(globalTaskId)) {
                // Strip sessionId prefix for UI display
                blockedDependents.push(task.id.replace(`${sessionId}_`, ''));
            }
        }
        
        // Update or create failed task entry
        const existingFailed = this.failedTasks.get(globalTaskId);
        const attempts = (existingFailed?.attempts || 0) + 1;
        
        const failedTask: FailedTask = {
            taskId,
            workflowId,
            description,
            attempts,
            lastError: errorMessage.substring(0, 500), // Truncate long errors
            errorType: classification.type,
            failedAt: new Date().toISOString(),
            canRetry: classification.type !== 'permanent' || attempts < 3,
            blockedDependents
        };
        
        this.failedTasks.set(globalTaskId, failedTask);
        
        this.log(`📛 Task ${taskId} failed (attempt ${attempts}): ${errorMessage.substring(0, 100)}`);
        if (blockedDependents.length > 0) {
            this.log(`   Blocked dependents: ${blockedDependents.join(', ')}`);
            
            // Mark dependent tasks as blocked
            for (const dependentId of blockedDependents) {
                this.updateTaskStage(`${sessionId}_${dependentId}`, 'deferred', `Blocked by failed task ${taskId}`);
            }
        }
        
        // Log warning for user awareness
        const canRetryText = failedTask.canRetry ? ' Use retry command.' : '';
        this.log(`⚠️ Task "${taskId}" failed after ${attempts} attempt(s).${canRetryText}`);
        
        // Broadcast task.failedFinal event to trigger user attention
        ServiceLocator.resolve(EventBroadcaster).broadcast('task.failedFinal', {
            sessionId,
            taskId,
            description: failedTask.description,
            attempts: failedTask.attempts,
            lastError: failedTask.lastError,
            errorType: failedTask.errorType,
            canRetry: failedTask.canRetry,
            clarityQuestion: failedTask.clarityQuestion,
            failedAt: failedTask.failedAt
        }, sessionId);
        
        return failedTask;
    }
    
    /**
     * Get failed tasks for a session
     */
    getFailedTasks(sessionId: string): FailedTask[] {
        const result: FailedTask[] = [];
        const prefix = `${sessionId}_`;
        
        for (const [key, task] of this.failedTasks) {
            if (key.startsWith(prefix)) {
                result.push(task);
            }
        }
        
        return result;
    }
    
    /**
     * Get a specific failed task
     */
    getFailedTask(sessionId: string, taskId: string): FailedTask | undefined {
        return this.failedTasks.get(`${sessionId}_${taskId}`);
    }
    
    /**
     * Remove a task from failed tracking (e.g., when retrying)
     */
    clearFailedTask(sessionId: string, taskId: string): boolean {
        const globalTaskId = `${sessionId}_${taskId}`;
        const existed = this.failedTasks.has(globalTaskId);
        this.failedTasks.delete(globalTaskId);
        
        if (existed) {
            this.log(`🔄 Cleared failed task ${taskId} for retry`);
        }
        
        return existed;
    }
    
    /**
     * Clear all failed tasks for a session
     */
    clearAllFailedTasks(sessionId: string): number {
        const prefix = `${sessionId}_`;
        let cleared = 0;
        
        for (const key of this.failedTasks.keys()) {
            if (key.startsWith(prefix)) {
                this.failedTasks.delete(key);
                cleared++;
            }
        }
        
        if (cleared > 0) {
            this.log(`Cleared ${cleared} failed tasks for session ${sessionId}`);
        }
        
        return cleared;
    }

    // ========================================================================
    // File Overlap Detection
    // ========================================================================

    /**
     * Check if any file overlaps with ongoing work across ALL sessions
     */
    checkFileOverlapGlobal(files: string[]): {
        taskId: string;
        sessionId: string;
        agentName: string;
        overlappingFiles: string[];
    } | null {
        for (const agent of this.agents.values()) {
            if (agent.status === 'working' && agent.currentTask) {
                const overlapping = files.filter(f => 
                    agent.filesModified.some(wf => 
                        wf === f || 
                        wf.endsWith(path.basename(f)) ||
                        f.endsWith(path.basename(wf))
                    )
                );
                
                if (overlapping.length > 0) {
                    return {
                        taskId: agent.currentTask.id,
                        sessionId: agent.sessionId,
                        agentName: agent.agentName,
                        overlappingFiles: overlapping
                    };
                }
            }
        }

        return null;
    }

    // ========================================================================
    // Logging
    // ========================================================================

    private log(message: string): void {
        this.outputManager.log('TASK', message);
    }

    showOutput(): void {
        this.outputManager.show();
    }
}
