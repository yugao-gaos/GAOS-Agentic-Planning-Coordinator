import * as fs from 'fs';
import * as path from 'path';
import { OutputChannelManager } from './OutputChannelManager';
import { StateManager } from './StateManager';
import { FailedTask, TaskOccupancyEntry } from '../types';
import { ErrorClassifier } from './workflows/ErrorClassifier';
import { EventBroadcaster } from '../daemon/EventBroadcaster';
import { ServiceLocator } from './ServiceLocator';
import { atomicWriteFileSync } from './StateManager';

// ============================================================================
// Task Manager - Global Singleton for Cross-Plan Task Coordination
// ============================================================================

/**
 * Simplified task status (6 values)
 * Coordinator manages task lifecycle via CLI commands
 * Workflows handle their own internal phases
 */
export type TaskStatus = 
    | 'created'      // Task exists, no workflow started yet
    | 'in_progress'  // Workflow running on this task
    | 'blocked'      // Waiting for dependencies
    | 'paused'       // Manually paused
    | 'completed'    // Coordinator marked complete via CLI
    | 'failed';      // Coordinator marked failed via CLI

/**
 * Simple task type for categorization
 */
export type TaskType = 'implementation' | 'error_fix';

/**
 * Parameters for creating a task via CLI
 */
export interface TaskCreateParams {
    sessionId: string;
    taskId: string;
    description: string;
    dependencies?: string[];
    taskType?: TaskType;
    priority?: number;
    errorText?: string;
    planSection?: string;
    targetFiles?: string[];
    notes?: string;
    
    /** Number of previous fix attempts (for error_fix tasks) */
    previousAttempts?: number;
    
    /** Summary of what the previous fix attempt tried (for error_fix tasks) */
    previousFixSummary?: string;
}

/**
 * Managed task - simplified model
 * Coordinator creates tasks via CLI, workflows handle execution details
 */
export interface ManagedTask {
    id: string;                   // Globally unique: "ps_001_T1" or "ERR_xxx"
    sessionId: string;            // Which plan/session this belongs to
    description: string;
    status: TaskStatus;           // Simplified status
    taskType: TaskType;           // implementation or error_fix
    dependencies: string[];       // Task IDs this depends on (global IDs)
    dependents: string[];         // Task IDs that depend on this
    priority: number;             // Lower = higher priority
    
    // Rich metadata (set via CLI)
    errorText?: string;           // Raw error text for error tasks
    planSection?: string;         // Relevant plan excerpt
    targetFiles?: string[];       // Expected files to modify
    notes?: string;               // Additional context
    
    // Workflow tracking
    workflowHistory: string[];    // All workflow IDs run on this task
    currentWorkflow?: string;     // Currently running workflow (if any)
    
    // Timing
    createdAt: string;
    startedAt?: string;           // First workflow started
    completedAt?: string;
    
    // Files modified (accumulated across workflows)
    filesModified: string[];
    
    // Pause tracking
    pausedAt?: string;
    pausedReason?: string;
    
    // Error fix context (for error_fix tasks)
    previousAttempts?: number;       // Number of previous fix attempts
    previousFixSummary?: string;     // What previous fixes tried
    
    // Legacy fields for compatibility during migration
    // TODO: Remove these after full migration
    assignedAgent?: string;
    actualAgent?: string;
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
        status: TaskStatus;
        filesModified: string[];
    };
}

/**
 * Agent role in the execution pipeline
 */
export type AgentRole = 'context' | 'engineer' | 'reviewer';

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
        
        // Load persisted tasks on startup
        this.loadPersistedTasks();
    }
    
    // ========================================================================
    // Task Persistence (Global Storage: _AiDevLog/Tasks/tasks.json)
    // ========================================================================
    
    /**
     * Get the StateManager instance for persistence operations
     */
    private getStateManager(): StateManager | null {
        try {
            return ServiceLocator.resolve(StateManager);
        } catch {
            this.log('[WARN] StateManager not available for task persistence');
            return null;
        }
    }
    
    /**
     * Persist all tasks to disk
     * Called after any task modification (create, update, complete, etc.)
     * 
     * File structure: {
     *   lastUpdated: ISO string,
     *   taskCount: number,
     *   tasks: ManagedTask[]
     * }
     */
    private persistTasks(): void {
        const stateManager = this.getStateManager();
        if (!stateManager) return;
        
        try {
            stateManager.ensureGlobalTasksDirectory();
            const filePath = stateManager.getGlobalTasksFilePath();
            
            // Convert Map to array for JSON serialization
            const tasksArray = Array.from(this.tasks.values());
            
            const data = {
                lastUpdated: new Date().toISOString(),
                taskCount: tasksArray.length,
                tasks: tasksArray
            };
            
            atomicWriteFileSync(filePath, JSON.stringify(data, null, 2));
            this.log(`Persisted ${tasksArray.length} tasks to ${filePath}`);
        } catch (err) {
            this.log(`[ERROR] Failed to persist tasks: ${err}`);
        }
    }
    
    /**
     * Load persisted tasks from disk on startup
     * Restores tasks from previous daemon session
     */
    private loadPersistedTasks(): void {
        const stateManager = this.getStateManager();
        if (!stateManager) {
            this.log('[INFO] StateManager not yet available, will load tasks later');
            return;
        }
        
        try {
            const filePath = stateManager.getGlobalTasksFilePath();
            
            if (!fs.existsSync(filePath)) {
                this.log('[INFO] No persisted tasks file found, starting fresh');
                return;
            }
            
            const content = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(content);
            
            if (!data.tasks || !Array.isArray(data.tasks)) {
                this.log('[WARN] Invalid tasks file format, starting fresh');
                return;
            }
            
            // Restore tasks to Map with status validation/migration
            let migratedCount = 0;
            for (const task of data.tasks) {
                // Validate and migrate status if needed
                const validStatuses: TaskStatus[] = ['created', 'in_progress', 'blocked', 'paused', 'completed', 'failed'];
                if (!validStatuses.includes(task.status)) {
                    const oldStatus = task.status;
                    // Map legacy/invalid status values to valid ones
                    task.status = this.migrateInvalidStatus(task);
                    this.log(`[MIGRATE] Task ${task.id}: status "${oldStatus}" → "${task.status}"`);
                    migratedCount++;
                }
                
                this.tasks.set(task.id, task);
                
                // Rebuild file index
                if (task.filesModified && task.filesModified.length > 0) {
                    this.addFilesToIndex(task.id, task.filesModified);
                }
            }
            
            this.log(`Loaded ${data.tasks.length} tasks from ${filePath} (last updated: ${data.lastUpdated})`);
            
            // Persist if we migrated any tasks to save the corrected statuses
            if (migratedCount > 0) {
                this.log(`[MIGRATE] Migrated ${migratedCount} tasks with invalid status, persisting...`);
                this.persistTasks();
            }
        } catch (err) {
            this.log(`[ERROR] Failed to load persisted tasks: ${err}`);
        }
    }
    
    /**
     * Migrate invalid task status to a valid one
     * Used when loading tasks from disk that may have legacy status values
     */
    private migrateInvalidStatus(task: ManagedTask): TaskStatus {
        const status = task.status as string;
        
        // Map known legacy status values
        const legacyMapping: Record<string, TaskStatus> = {
            'waiting': 'blocked',      // Old "waiting for dependencies" status
            'pending': 'blocked',      // Old pending status
            'ready': 'created',        // Old ready-to-start status
            'running': 'in_progress',  // Old running status
            'done': 'completed',       // Old done status
            'error': 'failed',         // Old error status
        };
        
        if (legacyMapping[status]) {
            // If task has unmet dependencies, ensure it's blocked
            // If all deps are complete, it should be 'created' so it can be started
            if (status === 'waiting' || status === 'pending') {
                const allDepsComplete = (task.dependencies || []).every(depId => {
                    const depTask = this.tasks.get(depId);
                    return depTask && depTask.status === 'completed';
                });
                return allDepsComplete ? 'created' : 'blocked';
            }
            return legacyMapping[status];
        }
        
        // Default to 'created' for unknown status values
        return 'created';
    }
    
    /**
     * Reload tasks from disk (called after StateManager is initialized)
     * Use this if TaskManager was created before StateManager was available
     */
    reloadPersistedTasks(): void {
        this.loadPersistedTasks();
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
     * Map a status string to TaskStatus type (for legacy compatibility)
     */
    static mapToStatus(status: string): TaskStatus {
        const validStatuses: TaskStatus[] = ['created', 'in_progress', 'blocked', 'paused', 'completed', 'failed'];
        return validStatuses.includes(status as TaskStatus) ? status as TaskStatus : 'created';
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
    // Task Creation (via CLI)
    // ========================================================================

    /**
     * Create a task from CLI command
     * This is the only way tasks should be created in the new architecture
     */
    createTaskFromCli(params: TaskCreateParams): { success: boolean; error?: string } {
        const { 
            sessionId, 
            taskId, 
            description, 
            dependencies = [], 
            taskType = 'implementation',
            priority = 10,
            errorText,
            planSection,
            targetFiles,
            notes,
            previousAttempts,
            previousFixSummary
        } = params;

        const globalTaskId = `${sessionId}_${taskId}`;
        
        // Check if task already exists
        if (this.tasks.has(globalTaskId)) {
            return { success: false, error: `Task ${taskId} already exists in session ${sessionId}` };
        }
        
        // Convert dependencies to global IDs if they're not already
        const globalDependencies = dependencies.map(dep => 
            dep.includes('_') ? dep : `${sessionId}_${dep}`
        );
        
        // Check if dependencies exist (for non-error tasks)
        if (sessionId !== ERROR_RESOLUTION_SESSION_ID) {
            for (const depId of globalDependencies) {
                if (!this.tasks.has(depId)) {
                    this.log(`Warning: Dependency ${depId} not found for task ${taskId}`);
                }
            }
        }
        
        // Determine initial status based on dependencies
        const hasDependencies = globalDependencies.length > 0;
        const allDepsComplete = globalDependencies.every(depId => {
            const depTask = this.tasks.get(depId);
            return depTask && depTask.status === 'completed';
        });
        
        const initialStatus: TaskStatus = hasDependencies && !allDepsComplete ? 'blocked' : 'created';
        
        const managedTask: ManagedTask = {
            id: globalTaskId,
            sessionId,
            description,
            status: initialStatus,
            taskType,
            dependencies: globalDependencies,
            dependents: [],
            priority,
            
            // Rich metadata
            errorText,
            planSection,
            targetFiles,
            notes,
            
            // Workflow tracking
            workflowHistory: [],
            currentWorkflow: undefined,
            
            // Timing
            createdAt: new Date().toISOString(),
            
            // Files
            filesModified: [],
            
            // Error fix context
            previousAttempts,
            previousFixSummary,
        };

        this.tasks.set(globalTaskId, managedTask);
        
        // Update dependents of dependency tasks
        for (const depId of globalDependencies) {
            const depTask = this.tasks.get(depId);
            if (depTask && !depTask.dependents.includes(globalTaskId)) {
                depTask.dependents.push(globalTaskId);
            }
        }
        
        this.log(`Created task ${globalTaskId}: ${description.substring(0, 50)}...`);
        
        // Persist tasks after creation
        this.persistTasks();
        
        return { success: true };
    }
    
    /**
     * Set the current workflow for a task
     * Called when starting a workflow on a task
     */
    setTaskCurrentWorkflow(taskId: string, workflowId: string): void {
        const task = this.tasks.get(taskId);
        if (!task) {
            this.log(`Task ${taskId} not found for workflow assignment`);
            return;
        }
        
        task.currentWorkflow = workflowId;
        task.workflowHistory.push(workflowId);
        task.status = 'in_progress';
        
        if (!task.startedAt) {
            task.startedAt = new Date().toISOString();
        }
        
        this.log(`Task ${taskId} started workflow ${workflowId}`);
        this.persistTasks();
    }
    
    /**
     * Clear the current workflow when it completes
     * Does NOT automatically complete the task - coordinator decides
     */
    clearTaskCurrentWorkflow(taskId: string): void {
        const task = this.tasks.get(taskId);
        if (!task) return;
        
        task.currentWorkflow = undefined;
        // Keep status as in_progress - coordinator will decide next step
        this.log(`Task ${taskId} workflow cleared, awaiting coordinator decision`);
    }
    
    /**
     * Mark task as completed via CLI (coordinator decision)
     */
    markTaskCompletedViaCli(taskId: string, summary?: string): void {
        const task = this.tasks.get(taskId);
        if (!task) {
            this.log(`Task ${taskId} not found for completion`);
            return;
        }
        
        task.status = 'completed';
        task.completedAt = new Date().toISOString();
        task.currentWorkflow = undefined;
        
        if (summary) {
            task.notes = task.notes ? `${task.notes}\n\nCompletion: ${summary}` : `Completion: ${summary}`;
        }
        
        // Update dependent tasks - they may now be unblocked
        this.updateDependentStatuses(task);
        
        this.onTaskCompletedCallback?.(task);
        this.log(`Task ${taskId} marked completed via CLI`);
        this.persistTasks();
    }
    
    /**
     * Update status of tasks that depend on the completed task
     */
    private updateDependentStatuses(completedTask: ManagedTask): void {
        for (const dependentId of completedTask.dependents) {
            const depTask = this.tasks.get(dependentId);
            if (!depTask || depTask.status !== 'blocked') continue;
            
            // Check if all dependencies are now complete
            const allDepsComplete = depTask.dependencies.every(depId => {
                const dt = this.tasks.get(depId);
                return dt && dt.status === 'completed';
            });
            
            if (allDepsComplete) {
                depTask.status = 'created';
                this.log(`Task ${dependentId} unblocked (dependencies complete)`);
            }
        }
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
     * Get ready tasks for a specific session (tasks with status 'created' that can have workflows started)
     */
    getReadyTasksForSession(sessionId: string): ManagedTask[] {
        return Array.from(this.tasks.values())
            .filter(t => t.sessionId === sessionId && t.status === 'created')
            .sort((a, b) => a.priority - b.priority);
    }
    
    /**
     * Get all ready tasks across ALL sessions (tasks with status 'created')
     */
    getAllReadyTasks(): ManagedTask[] {
        return Array.from(this.tasks.values())
            .filter(t => t.status === 'created')
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
            
            // Store previous status for resume (using pausedReason to store it)
            const previousStatus = task.status;
            task.status = 'paused';
            task.pausedAt = now;
            task.pausedReason = `${reason} (was: ${previousStatus})`;
            
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
        
        // Persist after pausing
        if (pausedBySession.size > 0) {
            this.persistTasks();
        }
        
        return pausedBySession;
    }
    
    /**
     * Resume paused tasks
     */
    resumePausedTasks(taskIds: string[]): void {
        for (const taskId of taskIds) {
            const task = this.tasks.get(taskId);
            if (!task || task.status !== 'paused') continue;
            
            // Extract previous status from pausedReason if stored
            let previousStatus: TaskStatus = 'created';
            if (task.pausedReason) {
                const match = task.pausedReason.match(/\(was: (\w+)\)$/);
                if (match) {
                    previousStatus = TaskManager.mapToStatus(match[1]);
                }
            }
            
            task.status = previousStatus;
            task.pausedAt = undefined;
            task.pausedReason = undefined;
            
            this.log(`Resumed task ${taskId} to status ${previousStatus}`);
        }
        
        // Update dependent statuses for affected sessions
        const sessions = new Set(taskIds.map(id => this.tasks.get(id)?.sessionId).filter(Boolean));
        for (const sessionId of sessions) {
            // Re-evaluate blocked tasks in this session
            for (const task of this.getTasksForSession(sessionId!)) {
                if (task.status === 'blocked') {
                    const allDepsComplete = task.dependencies.every(depId => {
                        const dt = this.tasks.get(depId);
                        return dt && dt.status === 'completed';
                    });
                    if (allDepsComplete) {
                        task.status = 'created';
                    }
                }
            }
        }
        
        // Persist after resuming
        if (taskIds.length > 0) {
            this.persistTasks();
        }
    }

    // ========================================================================
    // Error Task Queries
    // ========================================================================
    
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
     * In the new model: blocked -> created when all deps are complete
     */
    private updateReadyTasksForSession(sessionId: string): void {
        for (const task of this.tasks.values()) {
            if (task.sessionId !== sessionId) continue;
            if (task.status !== 'blocked') continue;

            const depsCompleted = task.dependencies.every(depId => {
                const depTask = this.tasks.get(depId);
                return depTask && depTask.status === 'completed';
            });

            if (depsCompleted) {
                task.status = 'created';
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
     * Get all ready tasks for a session (status 'created')
     */
    getReadyTasks(): ManagedTask[] {
        return Array.from(this.tasks.values())
            .filter(t => t.status === 'created')
            .sort((a, b) => a.priority - b.priority);
    }

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
            .filter(t => t.status === 'created');
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

        task.status = 'in_progress';
        task.actualAgent = agentName;
        if (!task.startedAt) {
            task.startedAt = new Date().toISOString();
        }

        agent.status = 'working';
        agent.currentTask = task;
        agent.lastActivityAt = new Date().toISOString();

        this.log(`Dispatched ${taskId} to ${agentName}`);
    }

    /**
     * Mark task as in progress (legacy support)
     */
    markTaskInProgress(taskId: string): void {
        const task = this.tasks.get(taskId);
        if (task) {
            task.status = 'in_progress';
            if (!task.startedAt) {
                task.startedAt = new Date().toISOString();
            }
            this.log(`Task ${taskId} in progress`);
            this.persistTasks();
        }
    }

    /**
     * Reset task to created state
     */
    resetTaskToReady(taskId: string): void {
        const task = this.tasks.get(taskId);
        if (task && task.status === 'in_progress') {
            task.status = 'created';
            task.actualAgent = undefined;
            task.currentWorkflow = undefined;
            this.log(`Task ${taskId} reset to created`);
            this.persistTasks();
        }
    }

    /**
     * Mark task as completed (internal - use markTaskCompletedViaCli for CLI)
     */
    markTaskCompleted(taskId: string, filesModified?: string[]): void {
        const task = this.tasks.get(taskId);
        if (!task) return;

        task.status = 'completed';
        task.completedAt = new Date().toISOString();
        task.currentWorkflow = undefined;
        
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

        // Update dependent tasks
        this.updateDependentStatuses(task);
        
        this.onTaskCompletedCallback?.(task);
        this.log(`Task ${taskId} completed`);
        this.persistTasks();
    }

    /**
     * Mark task as failed
     */
    markTaskFailed(taskId: string, reason?: string): void {
        const task = this.tasks.get(taskId);
        if (!task) return;

        task.status = 'failed';
        task.completedAt = new Date().toISOString();
        task.currentWorkflow = undefined;

        if (task.actualAgent) {
            const agent = this.agents.get(task.actualAgent);
            if (agent) {
                agent.currentTask = undefined;
                agent.status = 'idle';
                this.onAgentIdleCallback?.(agent);
            }
        }

        this.log(`Task ${taskId} failed: ${reason || 'unknown'}`);
        this.persistTasks();
    }

    // ========================================================================
    // Task Status Management
    // ========================================================================

    /**
     * Update task status with reason
     * In the new architecture, status is simplified to 6 values
     * Legacy code may call this with old stage names - we map them
     */
    updateTaskStage(taskId: string, stage: string, reason?: string): void {
        const task = this.tasks.get(taskId);
        if (!task) {
            this.log(`Task ${taskId} not found for status update`);
            return;
        }

        // Map legacy stage names to new status values
        const oldStatus = task.status;
        const newStatus = this.mapLegacyStageToStatus(stage);
        task.status = newStatus;

        if (newStatus === 'completed') {
            task.completedAt = new Date().toISOString();
            this.updateDependentStatuses(task);
            this.onTaskCompletedCallback?.(task);
        } else if (newStatus === 'failed') {
            task.completedAt = new Date().toISOString();
        }

        this.log(`Task ${taskId}: ${oldStatus} → ${newStatus}${reason ? ` (${reason})` : ''}`);
        this.persistTasks();
    }
    
    /**
     * Map legacy stage names to simplified status values
     */
    private mapLegacyStageToStatus(stage: string): TaskStatus {
        const mapping: Record<string, TaskStatus> = {
            // Direct mappings
            'created': 'created',
            'in_progress': 'in_progress',
            'blocked': 'blocked',
            'paused': 'paused',
            'completed': 'completed',
            'failed': 'failed',
            
            // Legacy stage mappings
            'pending': 'blocked',
            'ready': 'created',
            'ready_for_agent': 'created',
            'context_gathering': 'in_progress',
            'implementing': 'in_progress',
            'reviewing': 'in_progress',
            'approved': 'in_progress',
            'waiting_unity': 'in_progress',
            'compiling': 'in_progress',
            'testing_editmode': 'in_progress',
            'testing_playmode': 'in_progress',
            'error_fixing': 'in_progress',
            'deferred': 'blocked',
            'needs_work': 'in_progress',
        };
        
        return mapping[stage] || 'created';
    }

    /**
     * Get task's current status
     */
    getTaskStatus(taskId: string): TaskStatus | undefined {
        return this.tasks.get(taskId)?.status;
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
        const failed = tasks.filter(t => t.status === 'failed').length;
        const inProgress = tasks.filter(t => t.status === 'in_progress').length;
        const ready = tasks.filter(t => t.status === 'created').length;
        const pending = tasks.filter(t => t.status === 'blocked').length;
        const paused = tasks.filter(t => t.status === 'paused').length;

        return {
            completed: completed + failed,  // Count failed as "done" for progress
            inProgress,
            ready,
            pending,
            paused,
            total: tasks.length,
            percentage: tasks.length > 0 ? ((completed + failed) / tasks.length) * 100 : 0
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
