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
    | 'paused'             // Manually paused
    | 'completed'          // Coordinator marked complete via CLI
    | 'failed';            // Coordinator marked failed via CLI

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
    
    /** Unity pipeline configuration - determines which operations to run after implementation */
    unityPipeline?: UnityPipelineConfig;
}

/**
 * Active workflow state - embedded in task for persistence
 * This is the single source of truth for active/paused workflow state.
 * Replaces the old paused_workflows/*.json files.
 */
export interface ActiveWorkflowState {
    id: string;                    // Workflow ID
    type: string;                  // Workflow type (task_implementation, etc.)
    status: 'pending' | 'running' | 'paused' | 'blocked';
    phaseIndex: number;            // Current phase index
    phaseName: string;             // Current phase name
    allocatedAgents: string[];     // Agents allocated to this workflow
    startedAt: string;             // When workflow started
    pausedAt?: string;             // When workflow was paused (if paused)
    
    // Continuation context for resuming paused workflows
    continuationContext?: {
        partialOutput: string;     // Partial agent output when paused
        filesModified: string[];   // Files modified before pause
        whatWasDone: string;       // Summary of completed work
    };
    
    // Original workflow input (needed to recreate workflow on restore)
    workflowInput: Record<string, any>;
    priority: number;
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
    
    // Active workflow (at most 1 per task) - replaces currentWorkflow + paused_workflows files
    activeWorkflow?: ActiveWorkflowState;
    
    // Timing
    createdAt: string;
    startedAt?: string;           // First workflow started
    completedAt?: string;
    
    // Files modified (accumulated across workflows)
    filesModified: string[];
    
    // Pause tracking
    pausedAt?: string;
    pausedReason?: string;
    
    // Attempt tracking (incremented each time a workflow fails on this task)
    attempts: number;
    lastError?: string;              // Error from last failed attempt
    
    // Error fix context (for error_fix tasks)
    previousAttempts?: number;       // Number of previous fix attempts
    previousFixSummary?: string;     // What previous fixes tried
    
    // Unity pipeline configuration (set by analyst during planning)
    unityPipeline?: UnityPipelineConfig;
    
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
    private onTasksPausedCallback?: (notification: PausedTaskNotification) => void;

    // Configuration for task retention
    private readonly COMPLETED_TASK_RETENTION_HOURS = 48; // Keep completed tasks for 48 hours
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
     */
    private cleanupOldTasks(): void {
        const now = Date.now();
        const completedRetentionMs = this.COMPLETED_TASK_RETENTION_HOURS * 60 * 60 * 1000;
        
        let completedCleaned = 0;
        
        // Clean up old completed tasks
        for (const [taskId, task] of this.tasks.entries()) {
            if (task.status === 'completed' && task.completedAt) {
                const completedAt = new Date(task.completedAt).getTime();
                if (now - completedAt > completedRetentionMs) {
                    // Remove from task map
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
            }
        }
        
        if (completedCleaned > 0) {
            this.log(`Cleanup: removed ${completedCleaned} completed tasks (>${this.COMPLETED_TASK_RETENTION_HOURS}h old)`);
            // Persist after cleanup
            this.persistTasks();
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
     */
    private persistTasksForSession(sessionId: string, tasks?: ManagedTask[]): void {
        const stateManager = this.getStateManager();
        if (!stateManager) return;
        
        try {
            // Get tasks for this session if not provided
            // Use case-insensitive matching for robustness
            if (!tasks) {
                const normalizedSessionId = sessionId.toUpperCase();
                tasks = Array.from(this.tasks.values()).filter(t => t.sessionId.toUpperCase() === normalizedSessionId);
            }
            
            const sessionFolder = stateManager.getSessionTasksFolder(sessionId);
            if (!fs.existsSync(sessionFolder)) {
                fs.mkdirSync(sessionFolder, { recursive: true });
            }
            
            const filePath = stateManager.getSessionTasksFilePath(sessionId);
            
            const data = {
                sessionId,
                lastUpdated: new Date().toISOString(),
                taskCount: tasks.length,
                tasks: tasks
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
                    // MIGRATION: Normalize task IDs to global UPPERCASE format
                    // Handles multiple legacy formats:
                    //   - Short form: "T1" → "PS_000001_T1"
                    //   - Lowercase full: "ps_000001_T1" → "PS_000001_T1"
                    //   - Correct format: "PS_000001_T1" → no change
                    // =========================================================
                    const originalId = task.id;
                    const normalizedSessionId = task.sessionId.toUpperCase();
                    
                    // Check if task.id already has session prefix
                    const hasPrefix = task.id.toUpperCase().startsWith(normalizedSessionId + '_');
                    
                    // Build normalized global ID
                    let normalizedId: string;
                    if (hasPrefix) {
                        // Already has prefix - just uppercase it
                        normalizedId = task.id.toUpperCase();
                    } else {
                        // Short form - prepend session prefix
                        normalizedId = `${normalizedSessionId}_${task.id.toUpperCase()}`;
                    }
                    
                    // Update task fields to normalized format
                    task.id = normalizedId;
                    task.sessionId = normalizedSessionId;
                    
                    // Normalize dependencies to global UPPERCASE format
                    if (task.dependencies && Array.isArray(task.dependencies)) {
                        task.dependencies = task.dependencies.map((dep: string) => {
                            const depUpper = dep.toUpperCase();
                            // Check if dependency already has a session prefix (ps_XXXXXX_)
                            if (depUpper.match(/^PS_\d{6}_/)) {
                                return depUpper;
                            }
                            // Short form - prepend current session prefix
                            return `${normalizedSessionId}_${depUpper}`;
                        });
                    }
                    
                    // Normalize dependents to global UPPERCASE format
                    if (task.dependents && Array.isArray(task.dependents)) {
                        task.dependents = task.dependents.map((dep: string) => {
                            const depUpper = dep.toUpperCase();
                            // Check if dependent already has a session prefix
                            if (depUpper.match(/^PS_\d{6}_/)) {
                                return depUpper;
                            }
                            // Short form - prepend current session prefix
                            return `${normalizedSessionId}_${depUpper}`;
                        });
                    }
                    
                    if (originalId !== normalizedId) {
                        this.log(`[MIGRATE] Task ${originalId} → ${normalizedId}`);
                    }
                    
                    this.tasks.set(normalizedId, task);
                    sessionLoadedCount++;
                    
                    // Rebuild file index with normalized ID
                    if (task.filesModified && task.filesModified.length > 0) {
                        this.addFilesToIndex(normalizedId, task.filesModified);
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
            
            // =========================================================================
            // MIGRATION: Convert old paused_workflows/*.json files to task.activeWorkflow
            // This is a one-time migration - after running, paused_workflows/ is deleted
            // =========================================================================
            let totalMigrated = 0;
            for (const sessionId of sessionFolders) {
                const session = stateManager.getPlanningSession(sessionId);
                if (session?.status === 'completed') continue;
                
                const pausedDir = stateManager.getPausedWorkflowsFolder(sessionId);
                if (!fs.existsSync(pausedDir)) continue;
                
                try {
                    const files = fs.readdirSync(pausedDir).filter(f => f.endsWith('.json'));
                    if (files.length === 0) {
                        // Empty folder, just delete it
                        fs.rmSync(pausedDir, { recursive: true });
                        continue;
                    }
                    
                    this.log(`[MIGRATION] Found ${files.length} old pause file(s) for session ${sessionId}`);
                    
                    let sessionMigrated = 0;
                    for (const file of files) {
                        try {
                            const workflowId = file.replace('.json', '');
                            const filePath = path.join(pausedDir, file);
                            const pauseState = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                            
                            // Find the corresponding task
                            const taskId = pauseState.taskId;
                            if (!taskId) {
                                this.log(`  [SKIP] ${workflowId}: no taskId in pause file`);
                                continue;
                            }
                            
                            // Normalize to UPPERCASE for consistent lookup
                            const globalTaskId = `${sessionId.toUpperCase()}_${taskId.toUpperCase()}`;
                            const task = this.tasks.get(globalTaskId);
                            
                            if (!task) {
                                this.log(`  [SKIP] ${workflowId}: task ${taskId} not found`);
                                continue;
                            }
                            
                            // Skip if task is already completed/failed
                            if (task.status === 'completed' || task.status === 'failed') {
                                this.log(`  [SKIP] ${workflowId}: task ${taskId} is ${task.status}`);
                                continue;
                            }
                            
                            // Skip if task already has an activeWorkflow
                            if (task.activeWorkflow) {
                                this.log(`  [SKIP] ${workflowId}: task ${taskId} already has activeWorkflow`);
                                continue;
                            }
                            
                            // Migrate pause state to activeWorkflow
                            task.activeWorkflow = {
                                id: workflowId,
                                type: pauseState.workflowType || 'task_implementation',
                                status: 'paused',
                                phaseIndex: pauseState.phaseIndex || 0,
                                phaseName: pauseState.phaseName || 'unknown',
                                allocatedAgents: pauseState.allocatedAgents || [],
                                startedAt: pauseState.pausedAt || new Date().toISOString(),
                                pausedAt: pauseState.pausedAt || new Date().toISOString(),
                                workflowInput: pauseState.workflowInput || { taskId },
                                priority: pauseState.priority || 10,
                                continuationContext: pauseState.continuationPrompt ? {
                                    partialOutput: pauseState.agentPartialOutput || '',
                                    filesModified: pauseState.filesModified || [],
                                    whatWasDone: pauseState.whatWasDone || ''
                                } : undefined
                            };
                            
                            this.log(`  [OK] Migrated ${workflowId} → task ${taskId}`);
                            sessionMigrated++;
                            
                        } catch (fileErr) {
                            this.log(`  [ERROR] Failed to migrate ${file}: ${fileErr}`);
                        }
                    }
                    
                    // Delete the paused_workflows folder after migration
                    fs.rmSync(pausedDir, { recursive: true });
                    this.log(`[MIGRATION] Deleted paused_workflows/ for session ${sessionId}`);
                    
                    totalMigrated += sessionMigrated;
                    
                } catch (err) {
                    this.log(`[MIGRATION ERROR] Session ${sessionId}: ${err}`);
                }
            }
            
            if (totalMigrated > 0) {
                this.log(`[MIGRATION] Migrated ${totalMigrated} workflow(s) to tasks.json`);
                this.persistTasks(); // Save migrated state
            }
            // =========================================================================
            
            // Clean up orphaned in_progress tasks (daemon restart scenario)
            let recoveredCount = 0;
            for (const task of this.tasks.values()) {
                if (task.status === 'in_progress' && !task.activeWorkflow) {
                    this.log(`[RECOVERY] Resetting orphaned task ${task.id} from in_progress → created`);
                    task.status = 'created';
                    task.activeWorkflow = undefined;
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
        const validStatuses: TaskStatus[] = ['created', 'in_progress', 'blocked', 'paused', 'completed', 'failed'];
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
            unityPipeline
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
        // STAGE 1: ID FORMAT VALIDATION
        // ========================================================================

        // Validate sessionId format - must match PS_XXXXXX pattern (case-insensitive)
        if (!sessionId.match(/^ps_\d{6}$/i)) {
            return { 
                success: false, 
                error: `Invalid sessionId "${sessionId}": Must match format "PS_XXXXXX" (e.g., "PS_000001")` 
            };
        }

        // ========================================================================
        // STRICT GLOBAL ID FORMAT - All IDs must be PS_XXXXXX_TN format
        // No simple IDs (T1, T2) accepted - single source of truth
        // ========================================================================
        
        // Validate taskId format - MUST be global format: PS_XXXXXX_TN
        const globalMatch = taskId.match(/^(ps_\d{6})_([^_]+)$/i);
        if (!globalMatch) {
            return { 
                success: false, 
                error: `Invalid taskId "${taskId}": Must be global format PS_XXXXXX_TN (e.g., "PS_000001_T1"). Simple IDs like "T1" are not accepted.` 
            };
        }
        
        const [, taskSessionId, taskPart] = globalMatch;
        
        // Session prefix must match the passed sessionId (case-insensitive)
        if (taskSessionId.toUpperCase() !== sessionId.toUpperCase()) {
            return { 
                success: false, 
                error: `Invalid taskId "${taskId}": Session prefix "${taskSessionId}" doesn't match passed sessionId "${sessionId}"` 
            };
        }
        
        // Normalize to UPPERCASE
        const normalizedSessionId = sessionId.toUpperCase();
        const normalizedTaskId = taskPart.toUpperCase();
        const globalTaskId = `${normalizedSessionId}_${normalizedTaskId}`;

        // Validate dependency ID formats - ALL must be global format
        for (const dep of dependencies) {
            // Check for double-prefix error (e.g., PS_000001_PS_000001_T1)
            const depUpper = dep.toUpperCase();
            if (depUpper.startsWith(`${normalizedSessionId}_${normalizedSessionId}_`)) {
                return { 
                    success: false, 
                    error: `Invalid dependency "${dep}": Contains double session prefix. Use global format "${normalizedSessionId}_T1"` 
                };
            }
            
            // ALL dependencies must be global format PS_XXXXXX_TN (supports cross-session)
            const depMatch = dep.match(/^(ps_\d{6})_([^_]+)$/i);
            if (!depMatch) {
                return { 
                    success: false, 
                    error: `Invalid dependency "${dep}": Must be global format PS_XXXXXX_TN (e.g., "PS_000001_T1"). Simple IDs like "T1" are not accepted.` 
                };
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
                // Provide helpful error message
                const depList = missingDeps.map(id => {
                    // Show both formats for clarity
                    const shortId = id.includes('_') ? id.split('_').pop() : id;
                    return `"${shortId}" (${id})`;
                }).join(', ');
                
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
            return depTask && depTask.status === 'completed';
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
            
            // Active workflow (none initially)
            activeWorkflow: undefined,
            
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
        if (depTask.status !== 'completed') {
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
                return dep && dep.status === 'completed';
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
    
    /**
     * Initialize active workflow for a task
     * Called when starting a workflow on a task
     */
    initializeActiveWorkflow(
        taskId: string, 
        workflowId: string, 
        workflowType: string,
        workflowInput: Record<string, any>,
        priority: number
    ): void {
        const task = this.tasks.get(taskId);
        if (!task) {
            this.log(`Task ${taskId} not found for workflow assignment`);
            return;
        }
        
        task.activeWorkflow = {
            id: workflowId,
            type: workflowType,
            status: 'pending',
            phaseIndex: 0,
            phaseName: 'initializing',
            allocatedAgents: [],
            startedAt: new Date().toISOString(),
            workflowInput,
            priority
        };
        task.status = 'in_progress';
        
        if (!task.startedAt) {
            task.startedAt = new Date().toISOString();
        }
        
        this.log(`Task ${taskId} started workflow ${workflowId}`);
        this.persistTasks();
    }
    
    /**
     * Save active workflow state (called during pause/checkpoint)
     * This persists the workflow's execution state into the task
     */
    saveActiveWorkflowState(taskId: string, state: Partial<ActiveWorkflowState>): void {
        const task = this.tasks.get(taskId);
        if (!task || !task.activeWorkflow) {
            this.log(`Task ${taskId} has no active workflow to update`);
            return;
        }
        
        // Update the active workflow state
        Object.assign(task.activeWorkflow, state);
        
        this.log(`Task ${taskId} workflow state updated (phase: ${task.activeWorkflow.phaseIndex})`);
        this.persistTasks();
    }
    
    /**
     * Get active workflow state for a task
     */
    getActiveWorkflowState(taskId: string): ActiveWorkflowState | undefined {
        const task = this.tasks.get(taskId);
        return task?.activeWorkflow;
    }
    
    /**
     * Clear the active workflow when it completes
     * Does NOT automatically complete the task - coordinator decides
     * Always persists changes to ensure stale references are removed from disk
     */
    clearActiveWorkflow(taskId: string): void {
        const task = this.tasks.get(taskId);
        if (!task) return;
        
        task.activeWorkflow = undefined;
        // Keep status as in_progress - coordinator will decide next step
        this.log(`Task ${taskId} workflow cleared, awaiting coordinator decision`);
        this.persistTasks();
    }
    
    /**
     * Get all tasks that have an active workflow (for restoration on startup)
     */
    getTasksWithActiveWorkflows(sessionId: string): ManagedTask[] {
        const result: ManagedTask[] = [];
        for (const task of this.tasks.values()) {
            if (task.sessionId === sessionId && task.activeWorkflow) {
                result.push(task);
            }
        }
        return result;
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
        task.activeWorkflow = undefined;
        
        if (summary) {
            task.notes = task.notes ? `${task.notes}\n\nCompletion: ${summary}` : `Completion: ${summary}`;
        }
        
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
            
            // Extract local task ID (e.g., "ps_000001_T1" → "T1")
            const localTaskId = task.id.includes('_') 
                ? task.id.split('_').pop() || task.id
                : task.id;
            
            // Update checkbox in plan file
            let content = fs.readFileSync(planPath, 'utf-8');
            const checkbox = completed ? '[x]' : '[ ]';
            const oppositeCheckbox = completed ? '[ ]' : '[x]';
            
            // Pattern: - [ ] **T1**: or - [x] **T1**:
            const pattern = new RegExp(
                `(^\\s*-\\s*)\\[${completed ? ' ' : 'x'}\\](\\s*\\*\\*${localTaskId}\\*\\*)`,
                'gm'
            );
            
            if (pattern.test(content)) {
                content = content.replace(pattern, `$1${checkbox}$2`);
                fs.writeFileSync(planPath, content, 'utf-8');
                this.log(`📋 Synced plan checkbox: ${localTaskId} → ${checkbox}`);
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
                const localTaskId = task.id.includes('_') 
                    ? task.id.split('_').pop() || task.id
                    : task.id;
                
                const shouldBeChecked = task.status === 'completed';
                const currentCheckbox = shouldBeChecked ? '[ ]' : '[x]';
                const newCheckbox = shouldBeChecked ? '[x]' : '[ ]';
                
                // Only update if checkbox doesn't match status
                const pattern = new RegExp(
                    `(^\\s*-\\s*)\\[${shouldBeChecked ? ' ' : 'x'}\\](\\s*\\*\\*${localTaskId}\\*\\*)`,
                    'gm'
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

        task.status = 'completed';
        task.completedAt = new Date().toISOString();
        task.activeWorkflow = undefined;
        
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

        // Update dependent tasks
        this.updateDependentStatuses(task);
        
        this.onTaskCompletedCallback?.(task);
        this.log(`Task ${taskId} completed`);
        this.persistTasks();
        
        // Sync plan.md checkbox
        this.syncPlanCheckbox(taskId, true);
    }

    /**
     * Mark task as failed
     */
    markTaskFailed(taskId: string, reason?: string): void {
        const task = this.tasks.get(taskId);
        if (!task) return;

        task.status = 'failed';
        task.completedAt = new Date().toISOString();
        task.activeWorkflow = undefined;

        if (task.actualAgent) {
            const context = this.agentTaskContext.get(task.actualAgent);
            if (context) {
                context.currentTask = undefined;
                context.currentTaskId = undefined;
            }
            
            // Notify idle callback with agent name
            const poolService = this.getAgentPoolService();
            if (poolService?.getAgentStatus(task.actualAgent)) {
                this.onAgentIdleCallback?.(task.actualAgent);
            }
        }

        this.log(`Task ${taskId} failed: ${reason || 'unknown'}`);
        this.persistTasks();
        
        // Sync plan.md checkbox (unchecked - failed tasks are not complete)
        this.syncPlanCheckbox(taskId, false);
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
     * Callback receives agent name (query AgentPoolService for full status)
     */
    onAgentIdle(callback: (agentName: string) => void): void {
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
