import * as fs from 'fs';
import * as path from 'path';
import { OutputChannelManager } from './OutputChannelManager';
import { StateManager } from './StateManager';
import { TaskOccupancyEntry } from '../types';
import { UnityPipelineConfig } from '../types/unity';
import { ServiceLocator } from './ServiceLocator';
import { AgentPoolService } from './AgentPoolService';
import { atomicWriteFileSync } from './StateManager';
import { getMemoryMonitor } from './MemoryMonitor';
import { getFolderStructureManager } from './FolderStructureManager';
import { TaskIdValidator } from './TaskIdValidator';

// ============================================================================
// Task Manager - Global Singleton for Cross-Plan Task Coordination
// ============================================================================

/**
 * Simplified task status (7 values)
 * Coordinator manages task lifecycle via CLI commands
 * Workflows handle their own internal phases
 */
export type TaskStatus = 
    | 'created'            // Task exists, no workflow started yet
    | 'in_progress'        // Workflow running on this task
    | 'awaiting_decision'  // Workflow finished, waiting for coordinator to decide next action
    | 'blocked'            // Waiting for dependencies
    | 'succeeded';         // Coordinator verified work complete via CLI
    // NOTE: No 'failed' status - tasks are NEVER abandoned. They stay in 'awaiting_decision'
    // until coordinator retries or user intervenes.

/**
 * Simple task type for categorization
 */
export type TaskType = 'implementation' | 'error_fix';

/**
 * User clarification - Q&A entry for when coordinator asks user for input
 */
export interface UserClarification {
    id: string;
    question: string;
    answer?: string;
    askedAt: string;
    answeredAt?: string;
}

/**
 * Task-level workflow history entry
 * Tracks workflows run on each task for gating logic (e.g., context must succeed before implementation)
 */
export interface TaskWorkflowHistoryEntry {
    workflowId: string;
    workflowType: 'context_gathering' | 'task_implementation' | 'error_resolution';
    status: 'running' | 'succeeded' | 'failed' | 'cancelled';
    startedAt: string;
    completedAt?: string;
    error?: string;
}

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
    
    /** Unity pipeline configuration - determines which operations to run after implementation */
    unityPipeline?: UnityPipelineConfig;
    
    /** Whether this task needs context gathering before implementation */
    needsContext?: boolean;
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
    
    // Timing
    createdAt: string;
    startedAt?: string;           // First workflow started
    completedAt?: string;
    
    // Files modified (accumulated across workflows)
    filesModified: string[];
    
    // Attempt tracking (incremented each time a workflow fails on this task)
    attempts: number;
    lastError?: string;              // Error from last failed attempt
    
    // Error fix context (for error_fix tasks)
    previousAttempts?: number;       // Number of previous fix attempts
    previousFixSummary?: string;     // What previous fixes tried
    
    // Unity pipeline configuration (set by analyst during planning)
    unityPipeline?: UnityPipelineConfig;
    
    // Context gathering tracking
    contextPath?: string;          // Path to gathered context file
    contextGatheredAt?: string;    // When context was gathered
    
    // Context requirement (set by TaskAgent during creation)
    needsContext?: boolean;        // Whether this task needs context gathering before implementation
    
    // Task-level workflow history (for gating logic)
    workflowHistory?: TaskWorkflowHistoryEntry[];
    
    // User clarifications - Q&A history for this task
    userClarifications?: UserClarification[];
    
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
 * Agent task context tracking
 * Tracks task-specific information for agents.
 * 
 * NOTE: AgentPoolService is authoritative for agent allocation/status.
 * TaskManager only tracks task-related context for routing and history.
 */
export interface AgentTaskContext {
    agentName: string;
    
    // Current work
    currentTask?: ManagedTask;
    currentTaskId?: string;
    
    // Tasks waiting for Unity results (agent can work on other tasks)
    waitingTasks: WaitingTask[];
    
    // Context for error routing
    taskHistory: string[];          // Task IDs completed
    filesModified: string[];        // All files touched
    errorContext: Map<string, string[]>;  // errorId -> related files
    
    // Session continuity
    sessionContext: SessionContext;
    
    // Timing
    lastActivityAt: string;
}

/**
 * Task dispatch decision
 */
export interface DispatchDecision {
    task: ManagedTask;
    agentName: string;
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
 * - Tracks task-specific agent context (history, errors, files)
 * - Creates error-fixing tasks
 * 
 * NOTE: AgentPoolService is authoritative for agent allocation/status.
 * TaskManager delegates status queries to AgentPoolService.
 * 
 * Obtain via ServiceLocator:
 *   const taskManager = ServiceLocator.resolve(TaskManager);
 */
export class TaskManager {
    // Global task storage (all tasks from all plans)
    private tasks: Map<string, ManagedTask> = new Map();
    
    // Agent task context tracking (task history, errors, files)
    // NOTE: For allocation status, query AgentPoolService
    private agentTaskContext: Map<string, AgentTaskContext> = new Map();
    
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
    
    private outputManager: OutputChannelManager;

    // Callbacks
    private onTaskCompletedCallback?: (task: ManagedTask) => void;
    private onAgentIdleCallback?: (agentName: string) => void;

    // Periodic cleanup timer for completed session tasks
    private cleanupTimerId: NodeJS.Timeout | null = null;
    
    constructor() {
        this.outputManager = ServiceLocator.resolve(OutputChannelManager);
        this.log('Global TaskManager initialized');
        
        // Load persisted tasks on startup
        this.loadPersistedTasks();
        
        // Register with memory monitor
        const memMonitor = getMemoryMonitor();
        memMonitor.registerService('TaskManager', () => ({
            taskCount: this.tasks.size,
            agentContextCount: this.agentTaskContext.size,
            sessionCount: this.sessions.size,
            fileIndexSize: this.fileToTaskIndex.size,
            occupancyCount: this.taskOccupancy.size
        }));
        
        // Start periodic cleanup (every hour)
        this.startPeriodicCleanup();
    }
    
    /**
     * Get AgentPoolService for status queries
     * AgentPoolService is the authoritative source for agent allocation/status
     */
    private getAgentPoolService(): AgentPoolService | null {
        try {
            return ServiceLocator.resolve(AgentPoolService);
        } catch {
            return null;
        }
    }
    
    // ========================================================================
    // Task Persistence (Per-Plan Storage: {workingDir}/{plans}/{sessionId}/tasks.json)
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
     * Start periodic cleanup of old tasks
     */
    private startPeriodicCleanup(): void {
        // Run cleanup every hour
        this.cleanupTimerId = setInterval(() => {
            this.cleanupOldTasks();
        }, 60 * 60 * 1000); // 1 hour
        
        // Also run once immediately
        setTimeout(() => this.cleanupOldTasks(), 60 * 1000); // After 1 minute
    }
    
    /**
     * Stop periodic cleanup
     */
    private stopPeriodicCleanup(): void {
        if (this.cleanupTimerId) {
            clearInterval(this.cleanupTimerId);
            this.cleanupTimerId = null;
        }
    }
    
    /**
     * Clean up old completed tasks to prevent memory growth
     * 
     * IMPORTANT: Only cleans tasks from COMPLETED sessions!
     * Active sessions must keep all tasks in memory because:
     * - Coordinator needs completed task status for dependency checking
     * - getTask() must return completed tasks so dependents can proceed
     */
    private cleanupOldTasks(): void {
        const stateManager = this.getStateManager();
        if (!stateManager) return;
        
        let completedCleaned = 0;
        
        // Only clean up tasks from COMPLETED sessions
        // Active sessions need all their tasks in memory for dependency checking
        for (const [taskId, task] of this.tasks.entries()) {
            // Check if the session is completed
            const session = stateManager.getPlanningSession(task.sessionId);
            if (session?.status !== 'completed') {
                // Session is still active - keep ALL its tasks in memory
                continue;
            }
            
            // Session is completed - safe to remove from memory
            // (task history is preserved on disk via merge-based persistence)
            this.tasks.delete(taskId);
            
            // Remove from file index
            for (const file of task.filesModified) {
                const normalizedFile = this.normalizeFilename(file);
                const taskSet = this.fileToTaskIndex.get(normalizedFile);
                if (taskSet) {
                    taskSet.delete(taskId);
                    if (taskSet.size === 0) {
                        this.fileToTaskIndex.delete(normalizedFile);
                    }
                }
            }
            
            completedCleaned++;
        }
        
        if (completedCleaned > 0) {
            this.log(`Cleanup: removed ${completedCleaned} tasks from memory (completed sessions only)`);
            // NOTE: Do NOT persist here - this is memory-only cleanup.
            // Task history remains on disk and is preserved via merge-based persistence.
        }
    }
    
    /**
     * Clean up all tasks for a session from memory
     * Called when a session completes to free memory
     * Task files remain on disk for history/dependency views
     */
    cleanupSessionTasks(sessionId: string): void {
        let cleaned = 0;
        
        for (const [taskId, task] of this.tasks.entries()) {
            if (task.sessionId === sessionId) {
                this.tasks.delete(taskId);
                
                // Remove from file index
                for (const file of task.filesModified) {
                    const normalizedFile = this.normalizeFilename(file);
                    const taskSet = this.fileToTaskIndex.get(normalizedFile);
                    if (taskSet) {
                        taskSet.delete(taskId);
                        if (taskSet.size === 0) {
                            this.fileToTaskIndex.delete(normalizedFile);
                        }
                    }
                }
                
                // Remove from agent context
                for (const [agentName, context] of this.agentTaskContext.entries()) {
                    if (context.currentTaskId === taskId) {
                        this.agentTaskContext.delete(agentName);
                    }
                }
                
                cleaned++;
            }
        }
        
        if (cleaned > 0) {
            this.log(`Cleaned up ${cleaned} tasks from memory for session ${sessionId}`);
            // Note: Tasks remain on disk at {workingDir}/{plans}/{sessionId}/tasks.json
        }
    }
    
    /**
     * Persist all tasks to per-plan files
     * Each session's tasks are saved to {workingDir}/{plans}/{sessionId}/tasks.json
     * This reduces memory footprint as completed sessions can be unloaded
     */
    private persistTasks(): void {
        const stateManager = this.getStateManager();
        if (!stateManager) return;
        
        try {
            // Group tasks by session
            const tasksBySession = new Map<string, ManagedTask[]>();
            for (const task of this.tasks.values()) {
                if (!tasksBySession.has(task.sessionId)) {
                    tasksBySession.set(task.sessionId, []);
                }
                tasksBySession.get(task.sessionId)!.push(task);
            }
            
            // Save each session's tasks separately
            for (const [sessionId, tasks] of tasksBySession) {
                this.persistTasksForSession(sessionId, tasks);
            }
            
            this.log(`Persisted ${this.tasks.size} tasks across ${tasksBySession.size} sessions`);
        } catch (err) {
            this.log(`[ERROR] Failed to persist tasks: ${err}`);
        }
    }
    
    /**
     * Persist tasks for a specific session
     * Saves to {workingDir}/{plans}/{sessionId}/tasks.json
     * 
     * Uses MERGE-BASED persistence to preserve task history:
     * - Reads existing tasks from disk first
     * - Merges with in-memory tasks (in-memory wins for conflicts)
     * - This ensures tasks cleaned from memory are not lost from disk
     */
    private persistTasksForSession(sessionId: string, inMemoryTasks?: ManagedTask[]): void {
        const stateManager = this.getStateManager();
        if (!stateManager) return;
        
        try {
            // Get in-memory tasks for this session if not provided
            // Use case-insensitive matching for robustness
            if (!inMemoryTasks) {
                const normalizedSessionId = sessionId.toUpperCase();
                inMemoryTasks = Array.from(this.tasks.values()).filter(t => t.sessionId.toUpperCase() === normalizedSessionId);
            }
            
            const sessionFolder = stateManager.getSessionTasksFolder(sessionId);
            if (!fs.existsSync(sessionFolder)) {
                fs.mkdirSync(sessionFolder, { recursive: true });
            }
            
            const filePath = stateManager.getSessionTasksFilePath(sessionId);
            
            // MERGE-BASED PERSISTENCE: Read existing tasks from disk first
            // This preserves tasks that were cleaned from memory but should remain in history
            const mergedTasks = new Map<string, ManagedTask>();
            
            if (fs.existsSync(filePath)) {
                try {
                    const existingContent = fs.readFileSync(filePath, 'utf-8');
                    const existingData = JSON.parse(existingContent);
                    const existingTasks: ManagedTask[] = existingData.tasks || [];
                    
                    // Add all existing tasks to the merged map first
                    for (const task of existingTasks) {
                        if (task.id) {
                            mergedTasks.set(task.id, task);
                        }
                    }
                } catch (readErr) {
                    // If we can't read existing file, start fresh (file might be corrupted)
                    this.log(`[WARN] Could not read existing tasks file for merge, starting fresh: ${readErr}`);
                }
            }
            
            // Now add/update with in-memory tasks (in-memory wins for conflicts)
            for (const task of inMemoryTasks) {
                mergedTasks.set(task.id, task);
            }
            
            const finalTasks = Array.from(mergedTasks.values());
            
            const data = {
                sessionId,
                lastUpdated: new Date().toISOString(),
                taskCount: finalTasks.length,
                tasks: finalTasks
            };
            
            atomicWriteFileSync(filePath, JSON.stringify(data, null, 2));
        } catch (err) {
            this.log(`[ERROR] Failed to persist tasks for session ${sessionId}: ${err}`);
        }
    }
    
    /**
     * Load persisted tasks from disk on startup
     * Only loads tasks for active (non-completed) sessions to reduce memory usage
     * 
     * Tasks with invalid format are skipped (not loaded).
     * The coordinator will detect missing tasks and recreate them.
     * 
     * Loads from per-plan storage: {workingDir}/{plans}/{sessionId}/tasks.json
     */
    private loadPersistedTasks(): void {
        const stateManager = this.getStateManager();
        if (!stateManager) {
            this.log('[INFO] StateManager not yet available, will load tasks later');
            return;
        }
        
        try {
            // Get all session folders from FolderStructureManager
            const folderStructure = getFolderStructureManager();
            const plansDir = folderStructure.getFolderPath('plans');
            if (!fs.existsSync(plansDir)) {
                this.log('[INFO] No plans directory found, starting fresh');
                return;
            }
            
            const sessionFolders = fs.readdirSync(plansDir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);
            
            let totalLoaded = 0;
            let totalSkipped = 0;
            let sessionsLoaded = 0;
            
            for (const sessionId of sessionFolders) {
                // Check if session is completed
                const session = stateManager.getPlanningSession(sessionId);
                if (session?.status === 'completed') {
                    // Skip loading tasks for completed sessions
                    continue;
                }
                
                // Load tasks for this active session
                const filePath = stateManager.getSessionTasksFilePath(sessionId);
                if (!fs.existsSync(filePath)) {
                    continue;
                }
                
                const content = fs.readFileSync(filePath, 'utf-8');
                const data = JSON.parse(content);
                
                if (!data.tasks || !Array.isArray(data.tasks)) {
                    this.log(`[WARN] Invalid tasks file format for session ${sessionId}`);
                    continue;
                }
                
                let sessionLoadedCount = 0;
                let sessionSkippedCount = 0;
                
                for (const task of data.tasks) {
                    const validation = this.validateTaskFormat(task);
                    if (!validation.valid) {
                        this.log(`[SKIP] Task ${task.id}: ${validation.reason}`);
                        sessionSkippedCount++;
                        continue;
                    }
                    
                    // =========================================================
                    // VALIDATE: Task IDs must be global format - no auto-conversion
                    // Only uppercase normalization is allowed, not adding prefixes
                    // =========================================================
                    const originalId = task.id;
                    
                    // Validate task ID is in global format
                    const taskResult = TaskIdValidator.validateGlobalTaskId(task.id);
                    if (!taskResult.valid) {
                        this.log(`[ERROR] Skipping task with invalid ID "${task.id}" - must be global format PS_XXXXXX_TN`);
                        continue;
                    }
                    
                    // Normalize to uppercase (no prefix adding)
                    task.id = taskResult.normalizedId!;
                    task.sessionId = taskResult.sessionPart!;
                    
                    // Validate and normalize dependencies - skip invalid ones
                    if (task.dependencies && Array.isArray(task.dependencies)) {
                        task.dependencies = task.dependencies
                            .map((dep: string) => TaskIdValidator.normalizeGlobalTaskId(dep))
                            .filter((dep: string | null): dep is string => dep !== null);
                    }
                    
                    // Validate and normalize dependents - skip invalid ones
                    if (task.dependents && Array.isArray(task.dependents)) {
                        task.dependents = task.dependents
                            .map((dep: string) => TaskIdValidator.normalizeGlobalTaskId(dep))
                            .filter((dep: string | null): dep is string => dep !== null);
                    }
                    
                    if (originalId !== task.id) {
                        this.log(`[NORMALIZE] Task ${originalId} → ${task.id}`);
                    }
                    
                    this.tasks.set(task.id, task);
                    sessionLoadedCount++;
                    
                    // Rebuild file index with normalized ID
                    if (task.filesModified && task.filesModified.length > 0) {
                        this.addFilesToIndex(task.id, task.filesModified);
                    }
                }
                
                if (sessionLoadedCount > 0) {
                    totalLoaded += sessionLoadedCount;
                    totalSkipped += sessionSkippedCount;
                    sessionsLoaded++;
                }
            }
            
            this.log(`Loaded ${totalLoaded} tasks from ${sessionsLoaded} active sessions`);
            if (totalSkipped > 0) {
                this.log(`[WARN] Skipped ${totalSkipped} tasks with invalid format`);
            }
            
            // Persist immediately to save any ID normalizations to disk
            // This ensures migrated tasks are saved with their new UPPERCASE IDs
            if (totalLoaded > 0) {
                this.persistTasks();
            }
            
            // Clean up old paused_workflows folders (legacy cleanup)
            for (const sessionId of sessionFolders) {
                const stateManager = ServiceLocator.resolve(StateManager);
                const pausedDir = stateManager.getPausedWorkflowsFolder(sessionId);
                if (fs.existsSync(pausedDir)) {
                    fs.rmSync(pausedDir, { recursive: true });
                    this.log(`[CLEANUP] Deleted legacy paused_workflows/ for session ${sessionId}`);
                }
            }
            
            // Clean up orphaned in_progress tasks (daemon restart scenario)
            // Tasks that were in_progress when daemon stopped are reset to pending
            let recoveredCount = 0;
            for (const task of this.tasks.values()) {
                if (task.status === 'in_progress') {
                    this.log(`[RECOVERY] Resetting orphaned task ${task.id} from in_progress → created`);
                    task.status = 'created';
                    recoveredCount++;
                }
            }
            
            if (recoveredCount > 0) {
                this.log(`Recovered ${recoveredCount} orphaned tasks`);
                this.persistTasks(); // Save the cleaned state
            }
        } catch (err) {
            this.log(`[ERROR] Failed to load persisted tasks: ${err}`);
        }
    }
    
    /**
     * Validate task format
     * Returns { valid: true } or { valid: false, reason: string }
     */
    validateTaskFormat(task: any): { valid: true } | { valid: false; reason: string } {
        // Required fields
        if (!task.id || typeof task.id !== 'string') {
            return { valid: false, reason: 'missing or invalid id' };
        }
        if (!task.sessionId || typeof task.sessionId !== 'string') {
            return { valid: false, reason: 'missing or invalid sessionId' };
        }
        if (!task.description || typeof task.description !== 'string') {
            return { valid: false, reason: 'missing or invalid description' };
        }
        
        // Valid status values
        const validStatuses: TaskStatus[] = ['created', 'in_progress', 'blocked', 'succeeded', 'awaiting_decision'];
        if (!validStatuses.includes(task.status)) {
            return { valid: false, reason: `invalid status "${task.status}"` };
        }
        
        // Valid task types
        const validTypes: TaskType[] = ['implementation', 'error_fix'];
        if (!validTypes.includes(task.taskType)) {
            return { valid: false, reason: `invalid taskType "${task.taskType}"` };
        }
        
        // Dependencies must be array
        if (task.dependencies && !Array.isArray(task.dependencies)) {
            return { valid: false, reason: 'dependencies must be an array' };
        }
        
        return { valid: true };
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
     * Normalize a filename for conflict detection (extracts basename)
     */
    private normalizeFilename(file: string): string {
        return path.basename(file);
    }
    
    /**
     * Add files to the index for a task (used when adding new files)
     */
    private addFilesToIndex(taskId: string, files: string[]): void {
        for (const file of files) {
            const basename = this.normalizeFilename(file);
            let taskIds = this.fileToTaskIndex.get(basename);
            if (!taskIds) {
                taskIds = new Set();
                this.fileToTaskIndex.set(basename, taskIds);
            }
            taskIds.add(taskId);
        }
    }
    
    /**
     * Remove specific files from the index for a task
     */
    private removeFilesFromIndex(taskId: string, files: string[]): void {
        for (const file of files) {
            const basename = this.normalizeFilename(file);
            const taskIds = this.fileToTaskIndex.get(basename);
            if (taskIds) {
                taskIds.delete(taskId);
                if (taskIds.size === 0) {
                    this.fileToTaskIndex.delete(basename);
                }
            }
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
    
    /**
     * Delete a task from the system
     * Used when a task has invalid format and needs to be recreated by coordinator
     * 
     * @param taskId Global task ID (e.g., "ps_000001_T1")
     * @param reason Reason for deletion (for logging)
     * @returns true if task was deleted, false if not found
     */
    deleteTask(taskId: string, reason?: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task) {
            this.log(`[DELETE] Task ${taskId} not found`);
            return false;
        }
        
        // Remove from dependents lists of dependencies
        for (const depId of task.dependencies) {
            const depTask = this.tasks.get(depId);
            if (depTask) {
                depTask.dependents = depTask.dependents.filter(id => id !== taskId);
            }
        }
        
        // Remove from dependencies of dependent tasks (they'll be blocked again)
        for (const dependentId of task.dependents) {
            const dependentTask = this.tasks.get(dependentId);
            if (dependentTask) {
                dependentTask.dependencies = dependentTask.dependencies.filter(id => id !== taskId);
            }
        }
        
        // Remove from file index
        this.removeTaskFromFileIndex(taskId);
        
        // Remove from tasks map
        this.tasks.delete(taskId);
        
        this.log(`[DELETE] Task ${taskId} deleted${reason ? `: ${reason}` : ''}`);
        this.persistTasks();
        
        return true;
    }
    
    // ========================================================================
    // Stage/Status Helpers
    // ========================================================================
    
    /**
     * Derive TaskStatus from TaskStage
     * Map a status string to TaskStatus type (for legacy compatibility)
     */
    static mapToStatus(status: string): TaskStatus {
        const validStatuses: TaskStatus[] = ['created', 'in_progress', 'blocked', 'succeeded', 'awaiting_decision'];
        // Map legacy 'completed' to 'succeeded' and 'failed' to 'awaiting_decision'
        if (status === 'completed') return 'succeeded';
        if (status === 'failed') return 'awaiting_decision';
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
     * Delete all tasks for a session
     * Used when a plan/session is completely removed
     * 
     * @param sessionId The session ID whose tasks should be deleted
     * @returns Number of tasks deleted
     */
    deleteTasksForSession(sessionId: string): number {
        const tasksToDelete = this.getTasksForSession(sessionId);
        
        if (tasksToDelete.length === 0) {
            this.log(`[DELETE_SESSION] No tasks found for session ${sessionId}`);
            return 0;
        }
        
        this.log(`[DELETE_SESSION] Deleting ${tasksToDelete.length} tasks for session ${sessionId}`);
        
        let deleted = 0;
        for (const task of tasksToDelete) {
            // Remove from dependents lists of dependencies
            for (const depId of task.dependencies) {
                const depTask = this.tasks.get(depId);
                if (depTask) {
                    depTask.dependents = depTask.dependents.filter(id => id !== task.id);
                }
            }
            
            // Remove from dependencies of dependent tasks
            for (const dependentId of task.dependents) {
                const dependentTask = this.tasks.get(dependentId);
                if (dependentTask) {
                    dependentTask.dependencies = dependentTask.dependencies.filter(id => id !== task.id);
                }
            }
            
            // Remove from file index
            this.removeTaskFromFileIndex(task.id);
            
            // Remove from task occupancy tracking
            this.taskOccupancy.delete(task.id);
            
            // Remove from tasks map
            this.tasks.delete(task.id);
            deleted++;
        }
        
        // Persist after deletion
        this.persistTasks();
        
        this.log(`[DELETE_SESSION] Deleted ${deleted} tasks for session ${sessionId}`);
        return deleted;
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
     * 
     * Validates all input parameters before creating the task.
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
            previousFixSummary,
            unityPipeline,
            needsContext
        } = params;

        // Validate required fields
        if (!sessionId || typeof sessionId !== 'string' || sessionId.trim() === '') {
            return { success: false, error: 'Invalid sessionId: must be a non-empty string' };
        }
        if (!taskId || typeof taskId !== 'string' || taskId.trim() === '') {
            return { success: false, error: 'Invalid taskId: must be a non-empty string' };
        }
        if (!description || typeof description !== 'string' || description.trim() === '') {
            return { success: false, error: 'Invalid description: must be a non-empty string' };
        }
        
        // VALIDATION: Only create tasks for approved plans
        const stateManager = this.getStateManager();
        if (stateManager) {
            const session = stateManager.getPlanningSession(sessionId);
            if (session && session.status !== 'approved') {
                return { 
                    success: false, 
                    error: `Cannot create task for session ${sessionId}: Plan status is '${session.status}'. Tasks can only be created for approved plans. Current status must be 'approved'.` 
                };
            }
        }
        
        // Validate taskType
        const validTypes: TaskType[] = ['implementation', 'error_fix'];
        if (!validTypes.includes(taskType)) {
            return { success: false, error: `Invalid taskType "${taskType}": must be "implementation" or "error_fix"` };
        }
        
        // Validate dependencies format
        if (!Array.isArray(dependencies)) {
            return { success: false, error: 'Invalid dependencies: must be an array' };
        }
        for (const dep of dependencies) {
            if (typeof dep !== 'string' || dep.trim() === '') {
                return { success: false, error: `Invalid dependency "${dep}": must be a non-empty string` };
            }
        }

        // ========================================================================
        // STAGE 1: ID FORMAT VALIDATION (using TaskIdValidator - single source of truth)
        // ========================================================================

        // Validate sessionId format - must match PS_XXXXXX pattern
        const sessionResult = TaskIdValidator.validateSessionId(sessionId);
        if (!sessionResult.valid) {
            return { success: false, error: sessionResult.error! };
        }
        const normalizedSessionId = sessionResult.normalizedId!;

        // Validate taskId format - MUST be global format: PS_XXXXXX_TN
        const taskResult = TaskIdValidator.validateTaskIdForSession(taskId, sessionId);
        if (!taskResult.valid) {
            return { success: false, error: taskResult.error! };
        }
        const globalTaskId = taskResult.normalizedId!;

        // Validate dependency ID formats - ALL must be global format
        for (const dep of dependencies) {
            // Check for double-prefix error (e.g., PS_000001_PS_000001_T1)
            const doublePrefixError = TaskIdValidator.checkDoublePrefix(dep, normalizedSessionId);
            if (doublePrefixError) {
                return { success: false, error: doublePrefixError };
            }
            
            // ALL dependencies must be global format PS_XXXXXX_TN
            const depResult = TaskIdValidator.validateGlobalTaskId(dep);
            if (!depResult.valid) {
                return { success: false, error: depResult.error! };
            }
        }
        
        // Check if task already exists
        if (this.tasks.has(globalTaskId)) {
            return { success: false, error: `Task ${globalTaskId} already exists in session ${sessionId}` };
        }
        
        // All dependencies are already validated as global format - just normalize to UPPERCASE
        const globalDependencies = dependencies.map(dep => dep.toUpperCase());
        
        // ========================================================================
        // STAGE 2: DEPENDENCY EXISTENCE VALIDATION
        // ========================================================================

        // Check if dependencies exist - FAIL if missing (except for error tasks)
        if (sessionId !== ERROR_RESOLUTION_SESSION_ID) {
            const missingDeps: string[] = [];
            for (const depId of globalDependencies) {
                if (!this.tasks.has(depId)) {
                    missingDeps.push(depId);
                }
            }
            
            if (missingDeps.length > 0) {
                // Provide helpful error message with global IDs
                const depList = missingDeps.map(id => `"${id}"`).join(', ');
                
                return { 
                    success: false, 
                    error: `Cannot create task ${taskId}: Required dependencies not found: ${depList}. Create dependencies first, or check for typos in --deps parameter.` 
                };
            }
        }
        
        // Determine initial status based on dependencies
        const hasDependencies = globalDependencies.length > 0;
        const allDepsComplete = globalDependencies.every(depId => {
            const depTask = this.tasks.get(depId);
            return depTask && depTask.status === 'succeeded';
        });
        
        const initialStatus: TaskStatus = hasDependencies && !allDepsComplete ? 'blocked' : 'created';
        
        const managedTask: ManagedTask = {
            id: globalTaskId,
            sessionId: normalizedSessionId,  // Use normalized UPPERCASE sessionId for consistent storage
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
            
            // Timing
            createdAt: new Date().toISOString(),
            
            // Files
            filesModified: [],
            
            // Attempt tracking
            attempts: 0,
            
            // Error fix context
            previousAttempts,
            previousFixSummary,
            
            // Unity pipeline configuration
            unityPipeline,
            
            // Context requirement
            needsContext,
        };

        this.tasks.set(globalTaskId, managedTask);
        
        // Update dependents of dependency tasks
        for (const depId of globalDependencies) {
            const depTask = this.tasks.get(depId);
            if (depTask && !depTask.dependents.includes(globalTaskId)) {
                depTask.dependents.push(globalTaskId);
            }
        }
        
        // CRITICAL: Check for cycles after adding task (runtime check)
        // Check globally since we support cross-session dependencies
        const allTasks = this.getAllTasks();
        const { DependencyGraphUtils } = require('./DependencyGraphUtils');
        const taskNodes = allTasks.map(t => ({
            id: t.id,
            dependencies: t.dependencies
        }));
        
        const cycleCheck = DependencyGraphUtils.detectCycles(taskNodes);
        if (cycleCheck.hasCycle) {
            // Remove the task we just added
            this.tasks.delete(globalTaskId);
            
            // Also remove from dependents
            for (const depId of globalDependencies) {
                const depTask = this.tasks.get(depId);
                if (depTask) {
                    depTask.dependents = depTask.dependents.filter(d => d !== globalTaskId);
                }
            }
            
            return {
                success: false,
                error: `Cannot create task ${taskId}: Would create circular dependency.\n${cycleCheck.description}`
            };
        }
        
        this.log(`Created task ${globalTaskId}: ${description.substring(0, 50)}...`);
        
        // Persist tasks after creation
        this.persistTasks();
        
        return { success: true };
    }
    
    // ========================================================================
    // Dependency Management (including cross-plan dependencies)
    // ========================================================================
    
    /**
     * Add a dependency to a task (supports cross-plan dependencies)
     * Updates both task.dependencies and depTask.dependents bidirectionally
     * 
     * @param taskId - Global task ID (e.g., ps_000001_T3)
     * @param dependsOnId - Global task ID to depend on (e.g., ps_000002_T5)
     * @returns Success/failure with error message
     */
    addDependency(taskId: string, dependsOnId: string): { success: boolean; error?: string } {
        // Get both tasks
        const task = this.tasks.get(taskId);
        if (!task) {
            return { success: false, error: `Task ${taskId} not found` };
        }
        
        const depTask = this.tasks.get(dependsOnId);
        if (!depTask) {
            return { success: false, error: `Dependency task ${dependsOnId} not found` };
        }
        
        // Check if dependency already exists
        if (task.dependencies.includes(dependsOnId)) {
            return { success: false, error: `Task ${taskId} already depends on ${dependsOnId}` };
        }
        
        // Add dependency (update both sides)
        task.dependencies.push(dependsOnId);
        if (!depTask.dependents.includes(taskId)) {
            depTask.dependents.push(taskId);
        }
        
        // Check for cycles after adding dependency
        const allTasks = this.getAllTasks();
        const { DependencyGraphUtils } = require('./DependencyGraphUtils');
        const taskNodes = allTasks.map(t => ({
            id: t.id,
            dependencies: t.dependencies
        }));
        
        const cycleCheck = DependencyGraphUtils.detectCycles(taskNodes);
        if (cycleCheck.hasCycle) {
            // Rollback the dependency addition
            task.dependencies = task.dependencies.filter(d => d !== dependsOnId);
            depTask.dependents = depTask.dependents.filter(d => d !== taskId);
            
            return {
                success: false,
                error: `Cannot add dependency: Would create circular dependency.\n${cycleCheck.description}`
            };
        }
        
        // Update task status if dependency is not complete
        if (depTask.status !== 'succeeded') {
            task.status = 'blocked';
            this.log(`Task ${taskId} blocked by new dependency ${dependsOnId}`);
        }
        
        this.log(`Added dependency: ${taskId} → ${dependsOnId}`);
        this.persistTasks();
        
        return { success: true };
    }
    
    /**
     * Remove a dependency from a task
     * Updates both task.dependencies and depTask.dependents bidirectionally
     * 
     * @param taskId - Global task ID (e.g., ps_000001_T3)
     * @param depId - Global task ID of dependency to remove (e.g., ps_000002_T5)
     * @returns Success/failure with error message
     */
    removeDependency(taskId: string, depId: string): { success: boolean; error?: string } {
        const task = this.tasks.get(taskId);
        if (!task) {
            return { success: false, error: `Task ${taskId} not found` };
        }
        
        // Check if dependency exists
        if (!task.dependencies.includes(depId)) {
            return { success: false, error: `Task ${taskId} does not depend on ${depId}` };
        }
        
        // Remove from task.dependencies
        task.dependencies = task.dependencies.filter(d => d !== depId);
        
        // Remove from depTask.dependents (if depTask exists)
        const depTask = this.tasks.get(depId);
        if (depTask) {
            depTask.dependents = depTask.dependents.filter(d => d !== taskId);
        }
        
        // Check if task should be unblocked
        if (task.status === 'blocked') {
            const allDepsComplete = task.dependencies.every(d => {
                const dep = this.tasks.get(d);
                return dep && dep.status === 'succeeded';
            });
            
            if (allDepsComplete || task.dependencies.length === 0) {
                task.status = 'created';
                this.log(`Task ${taskId} unblocked after dependency removal`);
            }
        }
        
        this.log(`Removed dependency: ${taskId} → ${depId}`);
        this.persistTasks();
        
        return { success: true };
    }
    
    // ========================================================================
    // Task Update and Removal (CLI callable)
    // ========================================================================
    
    /**
     * Update a task from CLI command
     * Supports partial updates - only specified fields are changed.
     * 
     * @param params - Update parameters
     * @returns Success/failure with error message
     */
    updateTaskFromCli(params: { 
        sessionId: string; 
        taskId: string; 
        description?: string; 
        dependencies?: string[];
    }): { success: boolean; error?: string } {
        const { sessionId, taskId, description, dependencies } = params;
        
        // Normalize IDs to uppercase
        const normalizedSessionId = sessionId.toUpperCase();
        const normalizedTaskId = taskId.toUpperCase();
        
        // Validate task exists
        const task = this.tasks.get(normalizedTaskId);
        if (!task) {
            return { success: false, error: `Task ${normalizedTaskId} not found` };
        }
        
        // Validate session matches
        if (task.sessionId !== normalizedSessionId) {
            return { 
                success: false, 
                error: `Task ${normalizedTaskId} belongs to session ${task.sessionId}, not ${normalizedSessionId}` 
            };
        }
        
        // Check if task can be modified (not succeeded or in_progress)
        if (task.status === 'succeeded') {
            return { success: false, error: `Cannot update completed task ${normalizedTaskId}` };
        }
        
        if (task.status === 'in_progress') {
            return { success: false, error: `Cannot update task ${normalizedTaskId} while workflow is running` };
        }
        
        // Track changes for logging
        const changes: string[] = [];
        
        // Update description if provided
        if (description !== undefined && description !== task.description) {
            const oldDesc = task.description;
            task.description = description;
            changes.push(`description: "${oldDesc.substring(0, 30)}..." → "${description.substring(0, 30)}..."`);
        }
        
        // Update dependencies if provided
        if (dependencies !== undefined) {
            // Normalize dependency IDs
            const normalizedDeps = dependencies.map(d => d.toUpperCase());
            
            // Validate all dependencies exist
            for (const depId of normalizedDeps) {
                if (!this.tasks.has(depId)) {
                    return { success: false, error: `Dependency task ${depId} not found` };
                }
            }
            
            // Remove this task from old dependencies' dependents lists
            for (const oldDepId of task.dependencies) {
                const oldDep = this.tasks.get(oldDepId);
                if (oldDep) {
                    oldDep.dependents = oldDep.dependents.filter(d => d !== normalizedTaskId);
                }
            }
            
            // Set new dependencies
            const oldDeps = task.dependencies;
            task.dependencies = normalizedDeps;
            
            // Add this task to new dependencies' dependents lists
            for (const newDepId of normalizedDeps) {
                const newDep = this.tasks.get(newDepId);
                if (newDep && !newDep.dependents.includes(normalizedTaskId)) {
                    newDep.dependents.push(normalizedTaskId);
                }
            }
            
            // Check for cycles
            const allTasks = this.getAllTasks();
            const { DependencyGraphUtils } = require('./DependencyGraphUtils');
            const taskNodes = allTasks.map(t => ({
                id: t.id,
                dependencies: t.dependencies
            }));
            
            const cycleCheck = DependencyGraphUtils.detectCycles(taskNodes);
            if (cycleCheck.hasCycle) {
                // Rollback
                for (const newDepId of normalizedDeps) {
                    const newDep = this.tasks.get(newDepId);
                    if (newDep) {
                        newDep.dependents = newDep.dependents.filter(d => d !== normalizedTaskId);
                    }
                }
                task.dependencies = oldDeps;
                for (const oldDepId of oldDeps) {
                    const oldDep = this.tasks.get(oldDepId);
                    if (oldDep && !oldDep.dependents.includes(normalizedTaskId)) {
                        oldDep.dependents.push(normalizedTaskId);
                    }
                }
                
                return {
                    success: false,
                    error: `Cannot update dependencies: Would create circular dependency.\n${cycleCheck.description}`
                };
            }
            
            // Update task status based on new dependencies
            const hasIncompleteDeps = normalizedDeps.some(depId => {
                const dep = this.tasks.get(depId);
                return !dep || dep.status !== 'succeeded';
            });
            
            if (task.status === 'created' && hasIncompleteDeps) {
                task.status = 'blocked';
            } else if (task.status === 'blocked' && !hasIncompleteDeps) {
                task.status = 'created';
            }
            
            changes.push(`dependencies: [${oldDeps.join(', ')}] → [${normalizedDeps.join(', ')}]`);
        }
        
        if (changes.length === 0) {
            return { success: false, error: 'No changes specified' };
        }
        
        this.log(`Updated task ${normalizedTaskId}: ${changes.join('; ')}`);
        this.persistTasks();
        
        return { success: true };
    }
    
    /**
     * Remove a task from CLI command
     * Cancels any active workflows and cleans up dependencies.
     * 
     * @param sessionId - Session ID
     * @param taskId - Task ID to remove
     * @param reason - Optional reason for removal (included in summary)
     * @returns Success/failure with error message
     */
    removeTaskFromCli(
        sessionId: string, 
        taskId: string, 
        reason?: string
    ): { success: boolean; error?: string; cancelledWorkflows?: number } {
        // Normalize IDs to uppercase
        const normalizedSessionId = sessionId.toUpperCase();
        const normalizedTaskId = taskId.toUpperCase();
        
        // Validate task exists
        const task = this.tasks.get(normalizedTaskId);
        if (!task) {
            return { success: false, error: `Task ${normalizedTaskId} not found` };
        }
        
        // Validate session matches
        if (task.sessionId !== normalizedSessionId) {
            return { 
                success: false, 
                error: `Task ${normalizedTaskId} belongs to session ${task.sessionId}, not ${normalizedSessionId}` 
            };
        }
        
        // Don't allow removing tasks with dependents unless they're also being removed
        if (task.dependents.length > 0) {
            const activeDependents = task.dependents.filter(depId => {
                const dep = this.tasks.get(depId);
                return dep && dep.status !== 'succeeded';
            });
            
            if (activeDependents.length > 0) {
                return {
                    success: false,
                    error: `Cannot remove task ${normalizedTaskId}: Tasks depend on it: ${activeDependents.join(', ')}. Remove or update dependents first.`
                };
            }
        }
        
        // Cancel any active workflows for this task
        let cancelledWorkflows = 0;
        if (task.status === 'in_progress') {
            // Use dynamic import to avoid circular dependency
            import('./UnifiedCoordinatorService').then(async ({ UnifiedCoordinatorService }) => {
                try {
                    if (ServiceLocator.isRegistered(UnifiedCoordinatorService)) {
                        const coordinator = ServiceLocator.resolve(UnifiedCoordinatorService);
                        const count = await coordinator.cancelWorkflowsForTask(task.sessionId, normalizedTaskId);
                        if (count > 0) {
                            this.log(`Cancelled ${count} workflow(s) for removed task ${normalizedTaskId}${reason ? ` (${reason})` : ''}`);
                        }
                    }
                } catch (e) {
                    this.log(`[WARN] Could not cancel workflows for task ${normalizedTaskId}: ${e}`);
                }
            }).catch(() => {});
        }
        
        // Remove this task from its dependencies' dependents lists
        for (const depId of task.dependencies) {
            const dep = this.tasks.get(depId);
            if (dep) {
                dep.dependents = dep.dependents.filter(d => d !== normalizedTaskId);
            }
        }
        
        // Remove this task from succeeded dependents' dependencies lists
        // (only for succeeded tasks that no longer need the dependency)
        for (const dependentId of task.dependents) {
            const dependent = this.tasks.get(dependentId);
            if (dependent && dependent.status === 'succeeded') {
                dependent.dependencies = dependent.dependencies.filter(d => d !== normalizedTaskId);
            }
        }
        
        // Remove from file index
        if (task.filesModified) {
            this.removeFilesFromIndex(normalizedTaskId, task.filesModified);
        }
        if (task.targetFiles) {
            this.removeFilesFromIndex(normalizedTaskId, task.targetFiles);
        }
        
        // Remove occupancy
        this.taskOccupancy.delete(normalizedTaskId);
        
        // Remove the task
        this.tasks.delete(normalizedTaskId);
        
        const reasonText = reason ? ` (${reason})` : '';
        this.log(`Removed task ${normalizedTaskId}${reasonText}`);
        this.persistTasks();
        
        return { success: true, cancelledWorkflows };
    }
    
    /**
     * Update task description
     * Used during plan reconciliation when task description changes
     * 
     * @param taskId - Global task ID
     * @param description - New description
     */
    updateTaskDescription(taskId: string, description: string): void {
        const task = this.tasks.get(taskId);
        if (!task) {
            this.log(`Task ${taskId} not found for description update`);
            return;
        }
        
        const oldDesc = task.description;
        task.description = description;
        this.log(`Updated description for ${taskId}: "${oldDesc.substring(0, 30)}..." → "${description.substring(0, 30)}..."`);
        this.persistTasks();
    }
    
    /**
     * Update task dependencies (replace all dependencies)
     * Used during plan reconciliation when dependencies change
     * 
     * @param taskId - Global task ID
     * @param dependencies - New list of dependency task IDs
     */
    updateTaskDependencies(taskId: string, dependencies: string[]): void {
        const task = this.tasks.get(taskId);
        if (!task) {
            this.log(`Task ${taskId} not found for dependency update`);
            return;
        }
        
        // Remove this task from old dependencies' dependents lists
        for (const oldDepId of task.dependencies) {
            const oldDep = this.tasks.get(oldDepId);
            if (oldDep) {
                oldDep.dependents = oldDep.dependents.filter(d => d !== taskId);
            }
        }
        
        // Set new dependencies
        task.dependencies = dependencies;
        
        // Add this task to new dependencies' dependents lists
        for (const newDepId of dependencies) {
            const newDep = this.tasks.get(newDepId);
            if (newDep && !newDep.dependents.includes(taskId)) {
                newDep.dependents.push(taskId);
            }
        }
        
        // Check if task should be blocked/unblocked
        const hasIncompleteDeps = dependencies.some(depId => {
            const dep = this.tasks.get(depId);
            return !dep || dep.status !== 'succeeded';
        });
        
        if (task.status === 'created' && hasIncompleteDeps) {
            task.status = 'blocked';
            this.log(`Task ${taskId} blocked due to incomplete dependencies`);
        } else if (task.status === 'blocked' && !hasIncompleteDeps) {
            task.status = 'created';
            this.log(`Task ${taskId} unblocked - all dependencies complete`);
        }
        
        this.log(`Updated dependencies for ${taskId}: [${dependencies.join(', ')}]`);
        this.persistTasks();
    }
    
    /**
     * Mark a task as orphaned (removed from plan but still in progress)
     * Orphaned tasks will be auto-deleted when their workflow completes
     * 
     * @param taskId - Global task ID
     * @param reason - Reason for marking as orphaned
     */
    markTaskOrphaned(taskId: string, reason: string): void {
        const task = this.tasks.get(taskId);
        if (!task) {
            this.log(`Task ${taskId} not found for orphan marking`);
            return;
        }
        
        // Add orphaned metadata
        task.notes = task.notes 
            ? `${task.notes}\n[ORPHANED] ${reason}`
            : `[ORPHANED] ${reason}`;
        
        this.log(`⚠️ Task ${taskId} marked as orphaned: ${reason}`);
        this.persistTasks();
    }
    
    /**
     * Check if a task is marked as orphaned
     * 
     * @param taskId - Global task ID
     * @returns true if task is orphaned
     */
    isTaskOrphaned(taskId: string): boolean {
        const task = this.tasks.get(taskId);
        return task?.notes?.includes('[ORPHANED]') || false;
    }
    
    /**
     * Start a workflow on a task - marks task as in_progress
     * Called when dispatching a workflow for a task
     */
    startWorkflowOnTask(taskId: string, workflowId: string): void {
        const task = this.tasks.get(taskId);
        if (!task) {
            this.log(`Task ${taskId} not found for workflow assignment`);
            return;
        }
        
        task.status = 'in_progress';
        
        if (!task.startedAt) {
            task.startedAt = new Date().toISOString();
        }
        
        this.log(`Task ${taskId} started workflow ${workflowId}`);
        this.persistTasks();
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
        
        task.status = 'succeeded';
        task.completedAt = new Date().toISOString();
        
        if (summary) {
            task.notes = task.notes ? `${task.notes}\n\nCompletion: ${summary}` : `Completion: ${summary}`;
        }
        
        // Cancel any active workflows for this task and move them to history
        this.cancelWorkflowsForCompletedTask(taskId, task.sessionId);
        
        // Update dependent tasks - they may now be unblocked
        this.updateDependentStatuses(task);
        
        this.onTaskCompletedCallback?.(task);
        this.log(`Task ${taskId} marked completed via CLI`);
        this.persistTasks();
        
        // Sync plan.md checkbox
        this.syncPlanCheckbox(taskId, true);
    }
    
    /**
     * Sync plan.md checkbox to match task status
     * Called when task status changes
     */
    private syncPlanCheckbox(taskId: string, completed: boolean): void {
        try {
            const task = this.tasks.get(taskId);
            if (!task) return;
            
            const stateManager = ServiceLocator.resolve(StateManager);
            const session = stateManager.getPlanningSession(task.sessionId);
            const planPath = session?.currentPlanPath;
            
            if (!planPath || !fs.existsSync(planPath)) return;
            
            // Use global task ID for plan file matching
            const globalTaskId = task.id.toUpperCase();
            
            // Update checkbox in plan file
            let content = fs.readFileSync(planPath, 'utf-8');
            const checkbox = completed ? '[x]' : '[ ]';
            const oppositeCheckbox = completed ? '[ ]' : '[x]';
            
            // Pattern: - [ ] **PS_000001_T1**: or - [x] **PS_000001_T1**: (case-insensitive)
            const pattern = new RegExp(
                `(^\\s*-\\s*)\\[${completed ? ' ' : 'x'}\\](\\s*\\*\\*${globalTaskId}\\*\\*)`,
                'gmi'
            );
            
            if (pattern.test(content)) {
                content = content.replace(pattern, `$1${checkbox}$2`);
                fs.writeFileSync(planPath, content, 'utf-8');
                this.log(`📋 Synced plan checkbox: ${globalTaskId} → ${checkbox}`);
            }
        } catch (e) {
            // Non-critical - don't fail task completion if checkbox sync fails
            this.log(`[WARN] Failed to sync plan checkbox for ${taskId}: ${e}`);
        }
    }
    
    /**
     * Sync ALL plan checkboxes for a session to match TaskManager status
     * Called on startup and before coordinator evaluation
     */
    syncAllPlanCheckboxes(sessionId: string): number {
        let syncedCount = 0;
        
        try {
            const stateManager = ServiceLocator.resolve(StateManager);
            const session = stateManager.getPlanningSession(sessionId);
            const planPath = session?.currentPlanPath;
            
            if (!planPath || !fs.existsSync(planPath)) {
                return 0;
            }
            
            let content = fs.readFileSync(planPath, 'utf-8');
            let modified = false;
            
            const tasks = this.getTasksForSession(sessionId);
            
            for (const task of tasks) {
                // Use global task ID for plan file matching
                const globalTaskId = task.id.toUpperCase();
                
                const shouldBeChecked = task.status === 'succeeded';
                const currentCheckbox = shouldBeChecked ? '[ ]' : '[x]';
                const newCheckbox = shouldBeChecked ? '[x]' : '[ ]';
                
                // Only update if checkbox doesn't match status (case-insensitive)
                const pattern = new RegExp(
                    `(^\\s*-\\s*)\\[${shouldBeChecked ? ' ' : 'x'}\\](\\s*\\*\\*${globalTaskId}\\*\\*)`,
                    'gmi'
                );
                
                if (pattern.test(content)) {
                    content = content.replace(pattern, `$1${newCheckbox}$2`);
                    syncedCount++;
                    modified = true;
                }
            }
            
            if (modified) {
                fs.writeFileSync(planPath, content, 'utf-8');
                this.log(`📋 Synced ${syncedCount} plan checkboxes for session ${sessionId}`);
            }
        } catch (e) {
            this.log(`[WARN] Failed to sync plan checkboxes for ${sessionId}: ${e}`);
        }
        
        return syncedCount;
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
                return dt && dt.status === 'succeeded';
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
     * Uses case-insensitive matching for sessionId
     */
    getTasksForSession(sessionId: string): ManagedTask[] {
        const normalizedSessionId = sessionId.toUpperCase();
        return Array.from(this.tasks.values())
            .filter(t => t.sessionId.toUpperCase() === normalizedSessionId);
    }
    
    /**
     * Get ready tasks for a specific session (tasks with status 'created' that can have workflows started)
     * Uses case-insensitive matching for sessionId
     */
    getReadyTasksForSession(sessionId: string): ManagedTask[] {
        const normalizedSessionId = sessionId.toUpperCase();
        return Array.from(this.tasks.values())
            .filter(t => t.sessionId.toUpperCase() === normalizedSessionId && t.status === 'created')
            .sort((a, b) => a.priority - b.priority);
    }
    
    /**
     * Get tasks awaiting coordinator decision for a session
     * These are tasks where a workflow finished (success or failure) and the coordinator
     * needs to decide what to do next (mark complete, retry, or mark failed).
     * 
     * IMPORTANT: These tasks should NEVER be forgotten - the coordinator must act on them.
     */
    getAwaitingDecisionTasksForSession(sessionId: string): ManagedTask[] {
        const normalizedSessionId = sessionId.toUpperCase();
        return Array.from(this.tasks.values())
            .filter(t => t.sessionId.toUpperCase() === normalizedSessionId && t.status === 'awaiting_decision')
            .sort((a, b) => {
                // Prioritize tasks with failed attempts (they need retry attention)
                const aFailed = (a.attempts || 0) > 0 ? 1 : 0;
                const bFailed = (b.attempts || 0) > 0 ? 1 : 0;
                if (bFailed !== aFailed) return bFailed - aFailed; // Failed attempts first
                return a.priority - b.priority; // Then by priority
            });
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
            if (task.status === 'succeeded') continue;  // Skip succeeded tasks
            
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
            .filter(t => t.status !== 'succeeded');  // All non-succeeded error tasks are pending
    }
    
    // ========================================================================
    // Agent Management
    // ========================================================================

    /**
     * Register an agent with the TaskManager
     */
    /**
     * Register an agent's task context
     * NOTE: AgentPoolService is authoritative for allocation status.
     * This only creates task-specific tracking (history, errors, files).
     */
    registerAgent(
        agentName: string,
        sessionId: string,
        logFile: string,
        roleId: AgentRole = 'engineer'
    ): void {
        // Create task context if doesn't exist
        if (!this.agentTaskContext.has(agentName)) {
            const context: AgentTaskContext = {
                agentName,
                waitingTasks: [],
                taskHistory: [],
                filesModified: [],
                errorContext: new Map(),
                sessionContext: {
                    sessionId,
                    pendingErrors: []
                },
                lastActivityAt: new Date().toISOString()
            };
            this.agentTaskContext.set(agentName, context);
            this.log(`Registered task context for agent: ${agentName} (session: ${sessionId}, role: ${roleId})`);
        }
    }
    
    /**
     * Update an agent's role
     * NOTE: Role stored in AgentPoolService.
     */
    updateAgentRole(agentName: string, roleId: AgentRole): void {
        const context = this.agentTaskContext.get(agentName);
        if (context) {
            context.lastActivityAt = new Date().toISOString();
            this.log(`Updated ${agentName} role to: ${roleId}`);
        }
    }
    
    /**
     * Get agent assignments for UI display
     * Delegates to AgentPoolService for current status
     */
    getAgentAssignmentsForUI(): Array<{
        name: string;
        roleId: AgentRole;
        status: 'idle' | 'busy';
        sessionId: string;
        currentTaskId?: string;
        logFile: string;
        processId?: number;
        assignedAt: string;
        lastActivityAt: string;
    }> {
        const poolService = this.getAgentPoolService();
        if (!poolService) {
            return [];
        }
        
        const busyAgents = poolService.getBusyAgents();
        return busyAgents.map(agent => {
            const context = this.agentTaskContext.get(agent.name);
            return {
                name: agent.name,
                roleId: (agent.roleId === 'context_gatherer' ? 'context' : 
                        agent.roleId === 'code_reviewer' ? 'reviewer' : 
                        'engineer') as AgentRole,
                status: 'busy' as const,
                sessionId: agent.sessionId,
                currentTaskId: context?.currentTaskId || context?.currentTask?.id,
                logFile: agent.task || '',
                processId: undefined,
                assignedAt: new Date().toISOString(),
                lastActivityAt: context?.lastActivityAt || new Date().toISOString()
            };
        });
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
                return depTask && depTask.status === 'succeeded';
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
     * Get idle agents (available agents from AgentPoolService)
     * Returns just agent names since TaskManager doesn't own agent state
     */
    getIdleAgents(): string[] {
        const poolService = this.getAgentPoolService();
        if (!poolService) {
            return [];
        }
        
        return poolService.getAvailableAgents();
    }
    
    /**
     * Get best task for an agent (considers all sessions)
     * Uses AgentPoolService for agent session lookup
     */
    getBestTaskForAgent(agentName: string): ManagedTask | undefined {
        const poolService = this.getAgentPoolService();
        const agentStatus = poolService?.getAgentStatus(agentName);
        const sessionId = agentStatus?.sessionId || '';
        
        if (!sessionId) return undefined;
        
        // Priority 1: Error-fixing tasks (highest priority)
        const errorTasks = this.getPendingErrorFixingTasks()
            .filter(t => t.status === 'created');
        if (errorTasks.length > 0) {
            return errorTasks[0];
        }
        
        // Priority 2: Tasks assigned to this agent in their session
        const readyTasks = this.getReadyTasksForSession(sessionId);
        const assignedTask = readyTasks.find(t => t.assignedAgent === agentName);
        if (assignedTask) return assignedTask;

        // Priority 3: Any ready task in their session
        const idleAgents = new Set(this.getIdleAgents());
        
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
     * Returns recommendations for which agents should work on which tasks
     */
    findDispatchDecisions(): DispatchDecision[] {
        const decisions: DispatchDecision[] = [];
        const idleAgentNames = this.getIdleAgents(); // Now returns string[]

        if (idleAgentNames.length === 0) {
            return [];
        }

        const assignedTasks = new Set<string>();

        for (const agentName of idleAgentNames) {
            const task = this.getBestTaskForAgent(agentName);
            
            if (task && !assignedTasks.has(task.id)) {
                decisions.push({
                    task,
                    agentName,  // Now stores just the agent name
                    reason: task.sessionId === ERROR_RESOLUTION_SESSION_ID
                        ? `Error-fixing task for ${agentName}`
                        : task.assignedAgent === agentName
                            ? `Assigned task for ${agentName}`
                            : `Available task for idle ${agentName}`
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

        if (!task) {
            this.log(`Cannot dispatch: task=${taskId} not found`);
            return;
        }

        task.status = 'in_progress';
        task.actualAgent = agentName;
        if (!task.startedAt) {
            task.startedAt = new Date().toISOString();
        }

        // Update task context
        const context = this.agentTaskContext.get(agentName);
        if (context) {
            context.currentTask = task;
            context.currentTaskId = taskId;
            context.lastActivityAt = new Date().toISOString();
        }

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
     * Mark task as awaiting coordinator decision
     * Called when workflow completes - coordinator will decide next action
     * (mark complete, start another workflow, mark failed, etc.)
     */
    markTaskAwaitingDecision(taskId: string): void {
        const task = this.tasks.get(taskId);
        if (task) {
            task.status = 'awaiting_decision';
            this.log(`Task ${taskId} awaiting coordinator decision`);
            this.persistTasks();
        }
    }

    /**
     * Mark task as completed (internal - use markTaskCompletedViaCli for CLI)
     */
    markTaskCompleted(taskId: string, filesModified?: string[]): void {
        const task = this.tasks.get(taskId);
        if (!task) return;

        task.status = 'succeeded';
        task.completedAt = new Date().toISOString();
        
        if (filesModified) {
            const oldFiles = task.filesModified;
            task.filesModified = [...new Set([...task.filesModified, ...filesModified])];
            // Update file-to-task index with new files
            this.addFilesToIndex(taskId, filesModified.filter(f => !oldFiles.includes(f)));
        }

        // Update agent context
        if (task.actualAgent) {
            const context = this.agentTaskContext.get(task.actualAgent);
            if (context) {
                context.taskHistory.push(taskId);
                context.filesModified.push(...(filesModified || []));
                context.currentTask = undefined;
                context.currentTaskId = undefined;
                context.lastActivityAt = new Date().toISOString();
            }
            
            // Notify idle callback with agent name
            const poolService = this.getAgentPoolService();
            if (poolService?.getAgentStatus(task.actualAgent)) {
                this.onAgentIdleCallback?.(task.actualAgent);
            }
        }

        // Cancel any active workflows for this task and move them to history
        this.cancelWorkflowsForCompletedTask(taskId, task.sessionId);

        // Update dependent tasks
        this.updateDependentStatuses(task);
        
        this.onTaskCompletedCallback?.(task);
        this.log(`Task ${taskId} completed`);
        this.persistTasks();
        
        // Sync plan.md checkbox
        this.syncPlanCheckbox(taskId, true);
    }

    // NOTE: markTaskFailed() was removed - tasks should NEVER be permanently abandoned.
    // Tasks stay in 'awaiting_decision' until coordinator retries or user intervenes.
    // The attempts counter and lastError field track failure history.
    
    /**
     * Reset a completed task back to pending for re-implementation
     * Used by implementation review workflow when fixes are needed
     * 
     * @param taskId Global task ID
     * @param reviewNotes Notes from the review to attach to the task
     */
    resetTaskForReview(taskId: string, reviewNotes?: string): boolean {
        const task = this.tasks.get(taskId) || this.tasks.get(taskId.toUpperCase());
        if (!task) {
            this.log(`Cannot reset: task=${taskId} not found`);
            return false;
        }
        
        // Only reset completed tasks
        if (task.status !== 'succeeded') {
            this.log(`Cannot reset: task=${taskId} is not completed (status: ${task.status})`);
            return false;
        }
        
        // Reset to 'created' (pending) status
        task.status = 'created';
        task.completedAt = undefined;
        task.startedAt = undefined;
        task.actualAgent = undefined;
        
        // Increment attempts counter
        task.attempts = (task.attempts || 0) + 1;
        
        // Add review notes
        if (reviewNotes) {
            const timestamp = new Date().toISOString();
            const reviewSection = `\n[REVIEW ${timestamp}]\n${reviewNotes}`;
            task.notes = task.notes ? `${task.notes}${reviewSection}` : reviewSection;
        }
        
        this.log(`Task ${taskId} reset for review (attempt ${task.attempts})`);
        this.persistTasks();
        
        // Sync plan.md checkbox (mark unchecked)
        this.syncPlanCheckbox(taskId, false);
        
        return true;
    }
    
    /**
     * Set the context path for a task after context gathering completes
     * Called by UnifiedCoordinatorService when a context_gathering workflow finishes
     */
    setTaskContextPath(taskId: string, contextPath: string): void {
        const task = this.tasks.get(taskId);
        if (task) {
            task.contextPath = contextPath;
            task.contextGatheredAt = new Date().toISOString();
            this.log(`Task ${taskId} context gathered: ${contextPath}`);
            this.persistTasks();
        }
    }
    
    // ========================================================================
    // Task Workflow History - Track workflows run on each task
    // ========================================================================
    
    /**
     * Check if a task has a successful context_gathering workflow in its history
     * Used by coordinator to gate implementation workflow behind context gathering
     */
    hasSuccessfulContextGathering(taskId: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task || !task.workflowHistory) {
            return false;
        }
        return task.workflowHistory.some(
            entry => entry.workflowType === 'context_gathering' && entry.status === 'succeeded'
        );
    }
    
    /**
     * Get the current context workflow status for a task
     * Returns the status of the most recent context_gathering workflow
     */
    getContextWorkflowStatus(taskId: string): 'none' | 'running' | 'succeeded' | 'failed' {
        const task = this.tasks.get(taskId);
        if (!task || !task.workflowHistory) {
            return 'none';
        }
        
        // Find the most recent context_gathering workflow
        const contextWorkflows = task.workflowHistory.filter(
            entry => entry.workflowType === 'context_gathering'
        );
        
        if (contextWorkflows.length === 0) {
            return 'none';
        }
        
        // Sort by startedAt descending and get the most recent
        const mostRecent = contextWorkflows.sort(
            (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
        )[0];
        
        return mostRecent.status === 'cancelled' ? 'failed' : mostRecent.status;
    }
    
    /**
     * Add a workflow entry to a task's history
     * Called when a workflow starts on a task
     */
    addWorkflowToTaskHistory(taskId: string, entry: TaskWorkflowHistoryEntry): void {
        const task = this.tasks.get(taskId);
        if (!task) {
            this.log(`Cannot add workflow to history: task ${taskId} not found`);
            return;
        }
        
        // Initialize workflow history if needed
        if (!task.workflowHistory) {
            task.workflowHistory = [];
        }
        
        task.workflowHistory.push(entry);
        this.log(`Task ${taskId}: added workflow ${entry.workflowId} (${entry.workflowType}) to history`);
        this.persistTasks();
    }
    
    /**
     * Update a workflow entry in a task's history
     * Called when a workflow completes or fails
     */
    updateWorkflowInTaskHistory(
        taskId: string, 
        workflowId: string, 
        status: 'succeeded' | 'failed' | 'cancelled',
        error?: string
    ): void {
        const task = this.tasks.get(taskId);
        if (!task || !task.workflowHistory) {
            this.log(`Cannot update workflow in history: task ${taskId} not found or no history`);
            return;
        }
        
        const entry = task.workflowHistory.find(e => e.workflowId === workflowId);
        if (!entry) {
            this.log(`Cannot update workflow in history: workflow ${workflowId} not found in task ${taskId}`);
            return;
        }
        
        entry.status = status;
        entry.completedAt = new Date().toISOString();
        if (error) {
            entry.error = error;
        }
        
        this.log(`Task ${taskId}: updated workflow ${workflowId} to ${status}`);
        this.persistTasks();
    }
    
    // ========================================================================
    // User Clarifications - Q&A for tasks needing user input
    // ========================================================================
    
    /**
     * Add a pending question to a task
     * Called when coordinator needs user clarification
     * @returns The question ID for referencing in response
     */
    addQuestionToTask(taskId: string, question: string): { success: boolean; questionId?: string; error?: string } {
        const task = this.tasks.get(taskId);
        if (!task) {
            return { success: false, error: `Task ${taskId} not found` };
        }
        
        // Initialize clarifications array if needed
        if (!task.userClarifications) {
            task.userClarifications = [];
        }
        
        // Check for pending questions (no answer yet)
        const pendingQuestion = task.userClarifications.find(c => !c.answer);
        if (pendingQuestion) {
            return { 
                success: false, 
                error: `Task ${taskId} already has a pending question (${pendingQuestion.id})` 
            };
        }
        
        // Generate question ID
        const questionId = `q_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        
        task.userClarifications.push({
            id: questionId,
            question,
            askedAt: new Date().toISOString()
        });
        
        this.log(`Task ${taskId}: added question ${questionId}`);
        this.persistTasks();
        
        return { success: true, questionId };
    }
    
    /**
     * Answer a pending question on a task
     * Called when user provides clarification via chat
     * @returns Success and the clarification record
     */
    answerTaskQuestion(
        taskId: string, 
        questionId: string, 
        answer: string
    ): { success: boolean; clarification?: UserClarification; error?: string } {
        const task = this.tasks.get(taskId);
        if (!task) {
            return { success: false, error: `Task ${taskId} not found` };
        }
        
        if (!task.userClarifications) {
            return { success: false, error: `Task ${taskId} has no pending questions` };
        }
        
        const clarification = task.userClarifications.find(c => c.id === questionId);
        if (!clarification) {
            return { success: false, error: `Question ${questionId} not found on task ${taskId}` };
        }
        
        if (clarification.answer) {
            return { success: false, error: `Question ${questionId} was already answered` };
        }
        
        clarification.answer = answer;
        clarification.answeredAt = new Date().toISOString();
        
        this.log(`Task ${taskId}: question ${questionId} answered`);
        this.persistTasks();
        
        return { success: true, clarification };
    }
    
    /**
     * Get pending question for a task (if any)
     */
    getPendingQuestion(taskId: string): UserClarification | undefined {
        const task = this.tasks.get(taskId);
        if (!task?.userClarifications) return undefined;
        return task.userClarifications.find(c => !c.answer);
    }
    
    /**
     * Get all clarifications for a task (for building extra instructions)
     */
    getTaskClarifications(taskId: string): UserClarification[] {
        const task = this.tasks.get(taskId);
        return task?.userClarifications || [];
    }
    
    /**
     * Build extra instruction string from answered clarifications
     * Used when starting workflows to inject user answers into prompts
     */
    buildClarificationInstruction(taskId: string): string | undefined {
        const clarifications = this.getTaskClarifications(taskId);
        const answered = clarifications.filter(c => c.answer);
        
        if (answered.length === 0) return undefined;
        
        const lines = answered.map(c => 
            `**User Clarification:**\nQ: ${c.question}\nA: ${c.answer}`
        );
        
        return lines.join('\n\n');
    }
    
    /**
     * Cancel any active workflows for a completed task and move them to history.
     * This ensures no orphaned workflows remain running after a task is marked complete.
     */
    private cancelWorkflowsForCompletedTask(taskId: string, sessionId: string): void {
        // Dynamic import to avoid circular dependencies
        import('./UnifiedCoordinatorService').then(({ UnifiedCoordinatorService }) => {
            try {
                if (!ServiceLocator.isRegistered(UnifiedCoordinatorService)) {
                    return; // Coordinator not registered yet during startup
                }
                const coordinator = ServiceLocator.resolve(UnifiedCoordinatorService);
                // Fire and forget - don't block task completion on workflow cancellation
                coordinator.cancelWorkflowsForTask(sessionId, taskId).then(count => {
                    if (count > 0) {
                        this.log(`Cancelled ${count} workflow(s) for completed task ${taskId}`);
                    }
                }).catch(err => {
                    this.log(`[WARN] Failed to cancel workflows for task ${taskId}: ${err}`);
                });
            } catch (e) {
                // Coordinator might not be registered yet during startup
                this.log(`[WARN] Could not cancel workflows for task ${taskId}: coordinator not available`);
            }
        }).catch(() => {
            // Ignore import errors - should never happen in production
        });
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

        if (newStatus === 'succeeded') {
            task.completedAt = new Date().toISOString();
            // Cancel any active workflows for this task and move them to history
            this.cancelWorkflowsForCompletedTask(taskId, task.sessionId);
            this.updateDependentStatuses(task);
            this.onTaskCompletedCallback?.(task);
        }
        // NOTE: No 'failed' status handling - tasks stay in awaiting_decision

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
            'succeeded': 'succeeded',
            'awaiting_decision': 'awaiting_decision',
            
            // Legacy status mappings
            'completed': 'succeeded',      // Legacy: completed → succeeded
            'failed': 'awaiting_decision', // Legacy: failed → awaiting_decision (retry possible)
            
            // Legacy stage mappings (paused now maps to created)
            'paused': 'created',
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
     * Normalizes to uppercase for case-insensitive lookup
     */
    getTask(taskId: string): ManagedTask | undefined {
        // Normalize to uppercase for consistent lookup
        const normalizedId = taskId.toUpperCase();
        return this.tasks.get(normalizedId);
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
    /**
     * Get agent task context (task-specific tracking only)
     * For allocation status, query AgentPoolService directly
     */
    getAgentTaskContext(agentName: string): AgentTaskContext | undefined {
        return this.agentTaskContext.get(agentName);
    }
    
    /**
     * Get all agent task contexts
     */
    getAllAgentTaskContexts(): AgentTaskContext[] {
        return Array.from(this.agentTaskContext.values());
    }
    
    /**
     * Release agent task context
     * NOTE: AgentPoolService handles allocation release
     */
    releaseAgent(agentName: string): void {
        this.agentTaskContext.delete(agentName);
        this.log(`Released task context for agent ${agentName}`);
    }
    
    /**
     * Get progress for a session
     */
    getProgressForSession(sessionId: string): {
        completed: number;
        inProgress: number;
        ready: number;
        pending: number;
        total: number;
        percentage: number;
    } {
        const tasks = this.getTasksForSession(sessionId);
        const succeeded = tasks.filter(t => t.status === 'succeeded').length;
        const awaitingDecision = tasks.filter(t => t.status === 'awaiting_decision').length;
        const inProgress = tasks.filter(t => t.status === 'in_progress').length;
        const ready = tasks.filter(t => t.status === 'created').length;
        const pending = tasks.filter(t => t.status === 'blocked').length;

        return {
            completed: succeeded,  // Only count succeeded tasks as complete
            inProgress,
            ready,
            pending,
            total: tasks.length,
            percentage: tasks.length > 0 ? (succeeded / tasks.length) * 100 : 0
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
     * Callback receives agent name (query AgentPoolService for full status)
     */
    onAgentIdle(callback: (agentName: string) => void): void {
        this.onAgentIdleCallback = callback;
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
    // Task Attempt Tracking
    // ========================================================================
    
    /**
     * Record a workflow failure on a task
     * Increments the task's attempt counter and stores the last error.
     * The task remains incomplete - coordinator will naturally see it and decide to retry.
     * 
     * @param globalTaskId The global task ID (sessionId_taskId)
     * @param errorMessage The error message from the failed workflow
     */
    recordTaskFailure(globalTaskId: string, errorMessage: string): void {
        const task = this.tasks.get(globalTaskId);
        if (!task) {
            this.log(`[WARN] Cannot record failure for unknown task: ${globalTaskId}`);
            return;
        }
        
        task.attempts = (task.attempts || 0) + 1;
        task.lastError = errorMessage.substring(0, 500); // Truncate long errors
        
        this.log(`📛 Task ${globalTaskId} failed (attempt ${task.attempts}): ${errorMessage.substring(0, 100)}`);
        
        // Persist the updated task
        this.persistTasksForSession(task.sessionId, this.getTasksForSession(task.sessionId));
    }
    
    /**
     * Get the number of failed attempts for a task
     */
    getTaskAttempts(globalTaskId: string): number {
        const task = this.tasks.get(globalTaskId);
        return task?.attempts || 0;
    }
    
    /**
     * Get the last error for a task
     */
    getTaskLastError(globalTaskId: string): string | undefined {
        const task = this.tasks.get(globalTaskId);
        return task?.lastError;
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
        for (const context of this.agentTaskContext.values()) {
            if (context.currentTask) {
                const overlapping = files.filter(f => 
                    context.filesModified.some(wf => 
                        wf === f || 
                        wf.endsWith(path.basename(f)) ||
                        f.endsWith(path.basename(wf))
                    )
                );
                
                if (overlapping.length > 0) {
                    // Get session from AgentPoolService
                    const poolService = this.getAgentPoolService();
                    const agentStatus = poolService?.getAgentStatus(context.agentName);
                    
                    return {
                        taskId: context.currentTask.id,
                        sessionId: agentStatus?.sessionId || context.currentTask.sessionId,
                        agentName: context.agentName,
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
