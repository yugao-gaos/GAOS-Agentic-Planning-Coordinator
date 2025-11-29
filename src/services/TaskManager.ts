import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PlanParser, ParsedPlan, PlanTask } from './PlanParser';
import { OutputChannelManager } from './OutputChannelManager';

// ============================================================================
// Task Manager - Dynamic Task Coordination
// ============================================================================

/**
 * Task stage - represents completion stages
 * 
 * Flow:
 * pending → in_progress → implemented → awaiting_unity → compiled
 *                                                          ↓
 *     ┌────────────────────────────────────────────────────┘
 *     ↓
 * testing_editmode (if needed) → testing_playmode (if needed)
 *     ↓
 * test_passed OR test_failed → (fix cycle) → completed
 * 
 * Can be deferred if overlaps with ongoing work
 */
export type TaskStage = 
    | 'pending'              // Not started
    | 'in_progress'          // Engineer actively coding
    | 'implemented'          // Code written, needs compile
    | 'awaiting_unity'       // Waiting for Unity pipeline (engineer stopped)
    | 'compiling'            // Waiting in Unity queue for compile
    | 'compile_failed'       // Compilation errors found
    | 'error_fixing'         // Fixing compilation errors  
    | 'compiled'             // Compile passed
    | 'testing_editmode'     // Running EditMode tests (framework)
    | 'testing_playmode'     // Running PlayMode tests (framework)
    | 'waiting_player_test'  // Waiting for manual player testing
    | 'test_passed'          // Tests passed
    | 'test_failed'          // Tests failed, needs fixing
    | 'deferred'             // Deferred due to overlap with ongoing work
    | 'completed'            // All required stages passed
    | 'failed';              // Failed and won't retry

/**
 * Task status in the coordinator's tracking (for dependency resolution)
 */
export type TaskStatus = 
    | 'pending'      // Not yet ready (dependencies not met)
    | 'ready'        // Dependencies satisfied, can be dispatched
    | 'dispatched'   // Assigned to engineer, not yet started
    | 'in_progress'  // Engineer actively working
    | 'waiting_unity'// Waiting for Unity (compile/test)
    | 'error_fixing' // Fixing errors from Unity
    | 'completed'    // Successfully completed
    | 'failed';      // Failed and won't retry

/**
 * Task type - determines what testing is appropriate
 */
export type TaskType = 
    | 'data_logic'    // Algorithms, state, calculations → EditMode only
    | 'component'     // MonoBehaviours, services → EditMode (if complex)
    | 'scene_ui'      // Layouts, prefabs, canvas → PlayMode only
    | 'gameplay';     // Mechanics, feel, balance → All tests

/**
 * Task requirements - which stages are required for this task
 * 
 * Per best practices (Section 6):
 * - data_logic → EditMode only
 * - component → EditMode if has logic
 * - scene_ui → PlayMode only
 * - gameplay → EditMode + PlayMode + Player test
 * - Don't over-test! Simple data classes don't need tests.
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
 */
export interface ManagedTask {
    id: string;
    description: string;
    assignedEngineer?: string;      // Which engineer should do this (from plan)
    actualEngineer?: string;        // Who is actually doing it
    status: TaskStatus;
    stage: TaskStage;               // Current completion stage
    requirements: TaskRequirements; // What stages are required
    dependencies: string[];         // Task IDs this depends on
    dependents: string[];           // Task IDs that depend on this
    priority: number;               // Lower = higher priority (based on dependency depth)
    
    // Timing
    createdAt: string;
    dispatchedAt?: string;
    startedAt?: string;
    completedAt?: string;
    
    // Context for error routing
    filesModified: string[];        // Files touched during this task
    unityRequests: string[];        // Unity task IDs requested
    errors: string[];               // Error IDs assigned to this task
    
    // Session continuity
    sessionSummary?: string;        // Summary from previous session (for continuation)
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
 * Engineer assignment tracking
 */
export interface EngineerAssignment {
    engineerName: string;
    coordinatorId: string;
    status: 'idle' | 'working' | 'waiting' | 'error_fixing';
    
    // Current work
    currentTask?: ManagedTask;
    
    // Tasks waiting for Unity results (engineer can work on other tasks)
    waitingTasks: WaitingTask[];
    
    // Context for error routing
    taskHistory: string[];          // Task IDs completed
    filesModified: string[];        // All files touched
    errorContext: Map<string, string[]>;  // errorId -> related files
    
    // Session info
    sessionId: string;
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
    engineer: EngineerAssignment;
    reason: string;
}

/**
 * Task Manager
 * 
 * Manages tasks dynamically:
 * - Tracks task dependencies and status
 * - Finds ready tasks for dispatch
 * - Routes errors to relevant engineers
 * - Manages engineer assignments and release
 */
export class TaskManager {
    private coordinatorId: string;
    private planPath: string;
    private tasks: Map<string, ManagedTask> = new Map();
    private engineers: Map<string, EngineerAssignment> = new Map();
    private outputManager: OutputChannelManager;

    // Callbacks
    private onTaskCompletedCallback?: (task: ManagedTask) => void;
    private onEngineerIdleCallback?: (engineer: EngineerAssignment) => void;

    constructor(coordinatorId: string, planPath: string) {
        this.coordinatorId = coordinatorId;
        this.planPath = planPath;
        this.outputManager = OutputChannelManager.getInstance();
    }

    /**
     * Initialize from plan file
     */
    initializeFromPlan(planData: ParsedPlan): void {
        this.log('Initializing tasks from plan...');

        let taskIndex = 0;
        let completedCount = 0;
        let pendingCount = 0;
        
        for (const [engineerName, planTasks] of Object.entries(planData.engineerChecklists)) {
            for (const planTask of planTasks) {
                // Determine requirements from task description
                const requirements = this.inferTaskRequirements(planTask.description);
                
                const isCompleted = planTask.completed;
                if (isCompleted) {
                    completedCount++;
                    this.log(`  ✓ Task ${planTask.id} already completed (skipping)`);
                } else {
                    pendingCount++;
                }
                
                const managedTask: ManagedTask = {
                    id: planTask.id,
                    description: planTask.description,
                    assignedEngineer: engineerName,
                    status: isCompleted ? 'completed' : 'pending',
                    stage: isCompleted ? 'completed' : 'pending',
                    requirements,
                    dependencies: planTask.dependencies || [],
                    dependents: [],
                    priority: taskIndex++,
                    createdAt: new Date().toISOString(),
                    filesModified: [],
                    unityRequests: [],
                    errors: []
                };

                this.tasks.set(planTask.id, managedTask);
            }
        }
        
        this.log(`  ${completedCount} tasks already completed, ${pendingCount} tasks pending`);

        // Build dependents graph (reverse of dependencies)
        for (const task of this.tasks.values()) {
            for (const depId of task.dependencies) {
                const depTask = this.tasks.get(depId);
                if (depTask) {
                    depTask.dependents.push(task.id);
                }
            }
        }

        // Calculate initial ready status
        this.updateReadyTasks();

        this.log(`Initialized ${this.tasks.size} tasks`);
        this.log(`Ready tasks: ${this.getReadyTasks().length}`);
    }

    /**
     * Infer task requirements from description
     * 
     * Based on Unity Best Practices Section 6:
     * - data_logic tasks → EditMode only
     * - scene_ui tasks → PlayMode only
     * - gameplay tasks → EditMode + PlayMode + Player test
     * - component tasks → EditMode if has complex logic
     * 
     * IMPORTANT: Don't over-test! Match test type to task type.
     */
    private inferTaskRequirements(description: string): TaskRequirements {
        const descLower = description.toLowerCase();
        
        // Determine task type from keywords
        const taskType = this.inferTaskType(descLower);
        
        // Map task type to test requirements
        switch (taskType) {
            case 'data_logic':
                // Pure logic → EditMode only
                return {
                    taskType,
                    needsCompile: true,
                    needsEditModeTest: true,
                    needsPlayModeTest: false,
                    needsPlayerTest: false
                };
                
            case 'scene_ui':
                // Scene/UI → PlayMode only
                return {
                    taskType,
                    needsCompile: true,
                    needsEditModeTest: false,
                    needsPlayModeTest: true,
                    needsPlayerTest: false
                };
                
            case 'gameplay':
                // Gameplay → All tests (most thorough)
                return {
                    taskType,
                    needsCompile: true,
                    needsEditModeTest: true,
                    needsPlayModeTest: true,
                    needsPlayerTest: true
                };
                
            case 'component':
            default:
                // Component/default → EditMode if complex, otherwise just compile
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
        // Gameplay indicators (check first - most specific)
        const gameplayKeywords = [
            'gameplay', 'mechanic', 'player', 'input', 'movement',
            'combat', 'physics', 'feel', 'balance', 'game loop',
            'controller', 'character'
        ];
        if (gameplayKeywords.some(k => descLower.includes(k))) {
            return 'gameplay';
        }
        
        // Scene/UI indicators
        const sceneUiKeywords = [
            'scene', 'ui', 'canvas', 'prefab', 'layout', 'menu',
            'panel', 'button', 'screen', 'hud', 'animation', 
            'visual', 'spawn', 'instantiate'
        ];
        if (sceneUiKeywords.some(k => descLower.includes(k))) {
            return 'scene_ui';
        }
        
        // Data/Logic indicators
        const dataLogicKeywords = [
            'data', 'logic', 'algorithm', 'calculate', 'detect',
            'match', 'score', 'state machine', 'validator', 'parser',
            'utility', 'helper', 'service locator', 'math'
        ];
        if (dataLogicKeywords.some(k => descLower.includes(k))) {
            return 'data_logic';
        }
        
        // Default to component
        return 'component';
    }

    /**
     * Register an engineer with the coordinator
     */
    registerEngineer(
        engineerName: string,
        sessionId: string,
        logFile: string
    ): EngineerAssignment {
        const assignment: EngineerAssignment = {
            engineerName,
            coordinatorId: this.coordinatorId,
            status: 'idle',
            waitingTasks: [],
            taskHistory: [],
            filesModified: [],
            errorContext: new Map(),
            sessionId,
            logFile,
            sessionContext: {
                sessionId,
                pendingErrors: []
            },
            assignedAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString()
        };

        this.engineers.set(engineerName, assignment);
        this.log(`Registered engineer: ${engineerName}`);
        return assignment;
    }

    /**
     * Update which tasks are ready (dependencies satisfied)
     */
    private updateReadyTasks(): void {
        for (const task of this.tasks.values()) {
            if (task.status !== 'pending') continue;

            // Check if all dependencies are completed
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
     * Get all ready tasks (can be dispatched)
     */
    getReadyTasks(): ManagedTask[] {
        return Array.from(this.tasks.values())
            .filter(t => t.status === 'ready')
            .sort((a, b) => a.priority - b.priority);
    }

    /**
     * Get idle engineers
     */
    getIdleEngineers(): EngineerAssignment[] {
        return Array.from(this.engineers.values())
            .filter(e => e.status === 'idle');
    }

    /**
     * Get best task for an engineer
     * Prefers tasks assigned to them, then any ready task
     */
    getBestTaskForEngineer(engineerName: string): ManagedTask | undefined {
        const readyTasks = this.getReadyTasks();

        // First priority: Tasks assigned to this engineer
        const assignedTask = readyTasks.find(t => t.assignedEngineer === engineerName);
        if (assignedTask) return assignedTask;

        // Second priority: Any ready task not assigned to someone else who is idle
        const idleEngineers = new Set(this.getIdleEngineers().map(e => e.engineerName));
        
        for (const task of readyTasks) {
            // Skip if assigned to another idle engineer (let them do it)
            if (task.assignedEngineer && 
                task.assignedEngineer !== engineerName && 
                idleEngineers.has(task.assignedEngineer)) {
                continue;
            }
            return task;
        }

        return undefined;
    }

    /**
     * Find optimal dispatch decisions
     * Returns list of (engineer, task) pairs to dispatch
     */
    findDispatchDecisions(): DispatchDecision[] {
        const decisions: DispatchDecision[] = [];
        const readyTasks = this.getReadyTasks();
        const idleEngineers = this.getIdleEngineers();

        if (readyTasks.length === 0 || idleEngineers.length === 0) {
            return [];
        }

        // Track which tasks we've assigned in this batch
        const assignedTasks = new Set<string>();

        for (const engineer of idleEngineers) {
            // Find best task for this engineer
            for (const task of readyTasks) {
                if (assignedTasks.has(task.id)) continue;

                // Prefer tasks assigned to this engineer
                const isAssigned = task.assignedEngineer === engineer.engineerName;
                
                // Or tasks not specifically assigned to someone else
                const notOthersTask = !task.assignedEngineer || 
                    task.assignedEngineer === engineer.engineerName;

                if (isAssigned || notOthersTask) {
                    decisions.push({
                        task,
                        engineer,
                        reason: isAssigned 
                            ? `Assigned task for ${engineer.engineerName}`
                            : `Available task for idle ${engineer.engineerName}`
                    });
                    assignedTasks.add(task.id);
                    break;
                }
            }
        }

        return decisions;
    }

    /**
     * Dispatch a task to an engineer
     */
    dispatchTask(taskId: string, engineerName: string): void {
        const task = this.tasks.get(taskId);
        const engineer = this.engineers.get(engineerName);

        if (!task || !engineer) {
            this.log(`Cannot dispatch: task=${taskId} engineer=${engineerName}`);
            return;
        }

        task.status = 'dispatched';
        task.actualEngineer = engineerName;
        task.dispatchedAt = new Date().toISOString();

        engineer.status = 'working';
        engineer.currentTask = task;
        engineer.lastActivityAt = new Date().toISOString();

        this.log(`Dispatched ${taskId} to ${engineerName}`);
    }

    /**
     * Mark task as in progress
     */
    markTaskInProgress(taskId: string): void {
        const task = this.tasks.get(taskId);
        if (task) {
            task.status = 'in_progress';
            task.startedAt = new Date().toISOString();
            this.log(`Task ${taskId} in progress`);
        }
    }

    /**
     * Reset an in-progress task back to ready (used when engineer process dies or pause/resume)
     */
    resetTaskToReady(taskId: string): void {
        const task = this.tasks.get(taskId);
        if (task && (task.status === 'in_progress' || task.status === 'dispatched')) {
            task.status = 'ready';
            task.actualEngineer = undefined;
            this.log(`Task ${taskId} reset to ready (was ${task.status})`);
        }
    }

    /**
     * Reset all in-progress/dispatched tasks to ready (used on resume after pause)
     */
    resetAllInProgressTasks(): number {
        let count = 0;
        for (const [taskId, task] of this.tasks) {
            if (task.status === 'in_progress' || task.status === 'dispatched') {
                task.status = 'ready';
                task.actualEngineer = undefined;
                count++;
                this.log(`Task ${taskId} reset to ready`);
            }
        }
        return count;
    }

    /**
     * Mark task as waiting for Unity
     */
    markTaskWaitingUnity(taskId: string, unityTaskId: string): void {
        const task = this.tasks.get(taskId);
        if (task) {
            task.status = 'waiting_unity';
            task.unityRequests.push(unityTaskId);
            this.log(`Task ${taskId} waiting for Unity (${unityTaskId})`);
        }
    }

    /**
     * Mark task as completed
     */
    markTaskCompleted(taskId: string, filesModified?: string[]): void {
        const task = this.tasks.get(taskId);
        if (!task) return;

        task.status = 'completed';
        task.completedAt = new Date().toISOString();
        
        if (filesModified) {
            task.filesModified = filesModified;
        }

        // Update engineer context
        if (task.actualEngineer) {
            const engineer = this.engineers.get(task.actualEngineer);
            if (engineer) {
                engineer.taskHistory.push(taskId);
                engineer.filesModified.push(...(filesModified || []));
                engineer.currentTask = undefined;
                engineer.status = 'idle';
                engineer.lastActivityAt = new Date().toISOString();

                // Trigger idle callback
                this.onEngineerIdleCallback?.(engineer);
            }
        }

        // Update ready tasks
        this.updateReadyTasks();

        // Trigger completion callback
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
        task.completedAt = new Date().toISOString();

        // Free up engineer
        if (task.actualEngineer) {
            const engineer = this.engineers.get(task.actualEngineer);
            if (engineer) {
                engineer.currentTask = undefined;
                engineer.status = 'idle';
                this.onEngineerIdleCallback?.(engineer);
            }
        }

        this.log(`Task ${taskId} failed: ${reason || 'unknown'}`);
    }

    /**
     * Route an error to the most relevant engineer
     * Based on files modified and task history
     */
    routeError(
        errorId: string,
        filePath?: string,
        errorMessage?: string
    ): EngineerAssignment | undefined {
        this.log(`Routing error ${errorId} (file: ${filePath})`);

        // Strategy 1: Find engineer who modified the file
        if (filePath) {
            for (const engineer of this.engineers.values()) {
                if (engineer.filesModified.some(f => 
                    f === filePath || f.endsWith(path.basename(filePath))
                )) {
                    this.log(`Routed to ${engineer.engineerName} (file match)`);
                    return engineer;
                }
            }
        }

        // Strategy 2: Find engineer working on related task
        // (Parse task descriptions for keywords from error message)
        if (errorMessage) {
            const keywords = this.extractKeywords(errorMessage);
            for (const engineer of this.engineers.values()) {
                const currentTask = engineer.currentTask;
                if (currentTask) {
                    const taskKeywords = this.extractKeywords(currentTask.description);
                    const overlap = keywords.filter(k => taskKeywords.includes(k));
                    if (overlap.length > 0) {
                        this.log(`Routed to ${engineer.engineerName} (task keyword match: ${overlap.join(', ')})`);
                        return engineer;
                    }
                }
            }
        }

        // Strategy 3: Find least busy engineer
        const idleEngineers = this.getIdleEngineers();
        if (idleEngineers.length > 0) {
            this.log(`Routed to ${idleEngineers[0].engineerName} (idle)`);
            return idleEngineers[0];
        }

        this.log('No suitable engineer found for error');
        return undefined;
    }

    /**
     * Assign error fixing to an engineer
     */
    assignErrorToEngineer(
        engineerName: string,
        errorId: string,
        relatedFiles: string[]
    ): void {
        const engineer = this.engineers.get(engineerName);
        if (!engineer) return;

        engineer.status = 'error_fixing';
        engineer.errorContext.set(errorId, relatedFiles);
        engineer.lastActivityAt = new Date().toISOString();

        this.log(`Assigned error ${errorId} to ${engineerName}`);
    }

    /**
     * Check if we should release engineers
     * Release when:
     * - Only sequential tasks left
     * - Long-running tasks in progress
     * - More engineers than parallelizable work
     */
    getEngineersToRelease(): EngineerAssignment[] {
        const readyTasks = this.getReadyTasks();
        const idleEngineers = this.getIdleEngineers();

        // Count parallelizable work
        const parallelizableWork = readyTasks.length;
        
        // Count engineers needed
        const workingEngineers = Array.from(this.engineers.values())
            .filter(e => e.status === 'working' || e.status === 'error_fixing')
            .length;

        const totalNeeded = workingEngineers + parallelizableWork;
        const excessEngineers = idleEngineers.length - Math.max(0, parallelizableWork);

        if (excessEngineers > 0) {
            this.log(`Can release ${excessEngineers} engineers (parallelizable: ${parallelizableWork})`);
            return idleEngineers.slice(0, excessEngineers);
        }

        return [];
    }

    /**
     * Release an engineer from this coordinator
     */
    releaseEngineer(engineerName: string): void {
        const engineer = this.engineers.get(engineerName);
        if (!engineer) return;

        this.engineers.delete(engineerName);
        this.log(`Released engineer ${engineerName}`);
    }

    /**
     * Set callback for task completion
     */
    onTaskCompleted(callback: (task: ManagedTask) => void): void {
        this.onTaskCompletedCallback = callback;
    }

    /**
     * Set callback for engineer becoming idle
     */
    onEngineerIdle(callback: (engineer: EngineerAssignment) => void): void {
        this.onEngineerIdleCallback = callback;
    }

    /**
     * Get progress summary
     */
    getProgress(): {
        completed: number;
        inProgress: number;
        ready: number;
        pending: number;
        total: number;
        percentage: number;
    } {
        const tasks = Array.from(this.tasks.values());
        const completed = tasks.filter(t => t.status === 'completed').length;
        const inProgress = tasks.filter(t => 
            t.status === 'dispatched' || 
            t.status === 'in_progress' ||
            t.status === 'waiting_unity' ||
            t.status === 'error_fixing'
        ).length;
        const ready = tasks.filter(t => t.status === 'ready').length;
        const pending = tasks.filter(t => t.status === 'pending').length;

        return {
            completed,
            inProgress,
            ready,
            pending,
            total: tasks.length,
            percentage: tasks.length > 0 ? (completed / tasks.length) * 100 : 0
        };
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
    getAllEngineers(): EngineerAssignment[] {
        return Array.from(this.engineers.values());
    }

    /**
     * Get a specific engineer by name
     */
    getEngineer(engineerName: string): EngineerAssignment | undefined {
        return this.engineers.get(engineerName);
    }

    /**
     * Mark an engineer as available (idle)
     * Used when engineer process fails gracefully
     */
    markEngineerAvailable(engineerName: string): void {
        const engineer = this.engineers.get(engineerName);
        if (engineer) {
            engineer.status = 'idle';
            engineer.currentTask = undefined;
            this.log(`Engineer ${engineerName} marked as available`);
        }
    }

    /**
     * Extract keywords from text for matching
     */
    private extractKeywords(text: string): string[] {
        return text
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 3)
            .filter(w => !['this', 'that', 'with', 'from', 'have', 'been'].includes(w));
    }

    /**
     * Refresh from plan file (re-sync completion status)
     */
    refreshFromPlan(): void {
        const planData = PlanParser.parsePlanFile(this.planPath);
        
        for (const [engineerName, planTasks] of Object.entries(planData.engineerChecklists)) {
            for (const planTask of planTasks) {
                const managedTask = this.tasks.get(planTask.id);
                if (managedTask && managedTask.status !== 'completed' && planTask.completed) {
                    // Task was completed (checkbox marked in plan)
                    this.markTaskCompleted(planTask.id);
                }
            }
        }

        this.updateReadyTasks();
    }

    // ========================================================================
    // Task Stage Management
    // ========================================================================

    /**
     * Advance task to next stage
     * 
     * Per best practices, test requirements are based on task type:
     * - data_logic → EditMode only
     * - scene_ui → PlayMode only
     * - gameplay → EditMode + PlayMode + Player test
     * - component → EditMode if complex
     */
    advanceTaskStage(taskId: string): TaskStage | undefined {
        const task = this.tasks.get(taskId);
        if (!task) return undefined;

        const currentStage = task.stage;
        let nextStage: TaskStage;

        switch (currentStage) {
            case 'pending':
                nextStage = 'in_progress';
                break;
            case 'in_progress':
                nextStage = 'implemented';
                break;
            case 'implemented':
                nextStage = task.requirements.needsCompile ? 'compiling' : 'compiled';
                break;
            case 'compiling':
                nextStage = 'compiled';
                break;
            case 'error_fixing':
                nextStage = 'compiling'; // Go back to compile
                break;
            case 'compiled':
                // Determine next test stage based on requirements
                if (task.requirements.needsEditModeTest) {
                    nextStage = 'testing_editmode';
                } else if (task.requirements.needsPlayModeTest) {
                    nextStage = 'testing_playmode';
                } else if (task.requirements.needsPlayerTest) {
                    nextStage = 'waiting_player_test';
                } else {
                    nextStage = 'completed';
                }
                break;
            case 'testing_editmode':
                // After EditMode tests, check what's next
                if (task.requirements.needsPlayModeTest) {
                    nextStage = 'testing_playmode';
                } else if (task.requirements.needsPlayerTest) {
                    nextStage = 'waiting_player_test';
                } else {
                    nextStage = 'test_passed';
                }
                break;
            case 'testing_playmode':
                // After PlayMode tests, check if player test needed
                if (task.requirements.needsPlayerTest) {
                    nextStage = 'waiting_player_test';
                } else {
                    nextStage = 'test_passed';
                }
                break;
            case 'waiting_player_test':
                nextStage = 'test_passed';
                break;
            case 'test_passed':
                nextStage = 'completed';
                break;
            default:
                return currentStage;
        }

        task.stage = nextStage;
        this.log(`Task ${taskId} stage: ${currentStage} → ${nextStage}`);

        // Update status based on stage
        if (nextStage === 'completed') {
            task.status = 'completed';
            task.completedAt = new Date().toISOString();
            this.updateReadyTasks();
        }

        return nextStage;
    }

    /**
     * Set task stage to error_fixing
     */
    setTaskErrorFixing(taskId: string): void {
        const task = this.tasks.get(taskId);
        if (task) {
            task.stage = 'error_fixing';
            task.status = 'error_fixing';
            this.log(`Task ${taskId} stage → error_fixing`);
        }
    }

    /**
     * Get task's current stage
     */
    getTaskStage(taskId: string): TaskStage | undefined {
        return this.tasks.get(taskId)?.stage;
    }

    // ========================================================================
    // Engineer Waiting Task Management
    // ========================================================================

    /**
     * Add a task to engineer's waiting queue
     */
    addWaitingTask(
        engineerName: string,
        task: ManagedTask,
        unityTaskId: string,
        waitingFor: 'compile' | 'test_editmode' | 'test_playmode',
        estimatedWaitMs?: number
    ): void {
        const engineer = this.engineers.get(engineerName);
        if (!engineer) return;

        engineer.waitingTasks.push({
            task,
            unityTaskId,
            waitingFor,
            queuedAt: new Date().toISOString(),
            estimatedWaitMs
        });

        this.log(`${engineerName}: Added waiting task ${task.id} (${waitingFor}), estimate: ${estimatedWaitMs || 'unknown'}ms`);
    }

    /**
     * Remove a waiting task when Unity completes
     */
    removeWaitingTask(engineerName: string, unityTaskId: string): WaitingTask | undefined {
        const engineer = this.engineers.get(engineerName);
        if (!engineer) return undefined;

        const index = engineer.waitingTasks.findIndex(w => w.unityTaskId === unityTaskId);
        if (index >= 0) {
            const removed = engineer.waitingTasks.splice(index, 1)[0];
            this.log(`${engineerName}: Removed waiting task ${removed.task.id}`);
            return removed;
        }
        return undefined;
    }

    /**
     * Get engineer's waiting tasks
     */
    getWaitingTasks(engineerName: string): WaitingTask[] {
        return this.engineers.get(engineerName)?.waitingTasks || [];
    }

    /**
     * Check if engineer should switch to another task while waiting
     * Returns true if wait time is long enough to justify task switch
     */
    shouldSwitchTask(engineerName: string, estimatedWaitMs: number): boolean {
        const SWITCH_THRESHOLD_MS = 60000; // 60 seconds
        return estimatedWaitMs > SWITCH_THRESHOLD_MS;
    }

    /**
     * Save engineer session context for continuation
     */
    saveSessionContext(
        engineerName: string,
        summary: string,
        filesModified: string[]
    ): void {
        const engineer = this.engineers.get(engineerName);
        if (!engineer) return;

        engineer.sessionContext.previousSummary = summary;
        if (engineer.currentTask) {
            engineer.sessionContext.lastTaskState = {
                taskId: engineer.currentTask.id,
                stage: engineer.currentTask.stage,
                filesModified
            };
        }

        this.log(`${engineerName}: Saved session context`);
    }

    /**
     * Get continuation context for restarting engineer session
     */
    getContinuationContext(engineerName: string): {
        summary: string;
        lastTask?: ManagedTask;
        waitingResults: WaitingTask[];
        pendingErrors: string[];
    } | undefined {
        const engineer = this.engineers.get(engineerName);
        if (!engineer) return undefined;

        return {
            summary: engineer.sessionContext.previousSummary || '',
            lastTask: engineer.currentTask,
            waitingResults: engineer.waitingTasks,
            pendingErrors: engineer.sessionContext.pendingErrors
        };
    }

    /**
     * Check if engineer can take on more work
     * (idle or only has waiting tasks)
     */
    canTakeMoreWork(engineerName: string): boolean {
        const engineer = this.engineers.get(engineerName);
        if (!engineer) return false;

        // Can take work if idle or if only waiting for Unity
        return engineer.status === 'idle' || 
               (engineer.status === 'waiting' && !engineer.currentTask);
    }

    // ========================================================================
    // Task Status Updates - For Coordinator to update after pipeline results
    // ========================================================================

    /**
     * Update task stage with reason
     * Used by coordinator after pipeline completion
     */
    updateTaskStage(taskId: string, stage: TaskStage, reason?: string): void {
        const task = this.tasks.get(taskId);
        if (!task) {
            this.log(`Task ${taskId} not found for stage update`);
            return;
        }

        const oldStage = task.stage;
        task.stage = stage;

        // Update status based on stage
        if (stage === 'completed') {
            task.status = 'completed';
            task.completedAt = new Date().toISOString();
            this.updateReadyTasks();
            this.onTaskCompletedCallback?.(task);
        } else if (stage === 'failed') {
            task.status = 'failed';
            task.completedAt = new Date().toISOString();
        } else if (stage === 'awaiting_unity') {
            task.status = 'waiting_unity';
        } else if (stage === 'test_failed' || stage === 'compile_failed') {
            task.status = 'error_fixing';
        } else if (stage === 'deferred') {
            // Keep status as-is but mark deferred
        }

        this.log(`Task ${taskId}: ${oldStage} → ${stage}${reason ? ` (${reason})` : ''}`);
    }

    /**
     * Mark task as test failed with details
     */
    markTaskTestFailed(taskId: string, failures: string[], reason?: string): void {
        const task = this.tasks.get(taskId);
        if (!task) return;

        task.stage = 'test_failed';
        task.status = 'error_fixing';
        task.errors.push(...failures);
        
        this.log(`Task ${taskId} test failed: ${reason || failures.length + ' failures'}`);
    }

    /**
     * Mark task as compile failed with errors
     */
    markTaskCompileFailed(taskId: string, errors: string[], reason?: string): void {
        const task = this.tasks.get(taskId);
        if (!task) return;

        task.stage = 'compile_failed';
        task.status = 'error_fixing';
        task.errors.push(...errors);
        
        this.log(`Task ${taskId} compile failed: ${reason || errors.length + ' errors'}`);
    }

    /**
     * Defer a task (overlap with ongoing work)
     */
    deferTask(taskId: string, reason: string, blockedBy?: string): void {
        const task = this.tasks.get(taskId);
        if (!task) return;

        const previousStage = task.stage;
        task.stage = 'deferred';
        
        // Store context for un-deferring
        if (!task.sessionSummary) {
            task.sessionSummary = '';
        }
        task.sessionSummary += `[DEFERRED from ${previousStage}] ${reason}`;
        if (blockedBy) {
            task.sessionSummary += ` (blocked by ${blockedBy})`;
        }

        this.log(`Task ${taskId} deferred: ${reason}`);
    }

    /**
     * Un-defer a task (when blocker completes)
     */
    undeferTask(taskId: string): TaskStage | undefined {
        const task = this.tasks.get(taskId);
        if (!task || task.stage !== 'deferred') return undefined;

        // Restore to a reasonable state - error_fixing since it needs attention
        task.stage = 'error_fixing';
        task.status = 'ready';
        
        this.log(`Task ${taskId} un-deferred, now ready for error fixing`);
        this.updateReadyTasks();
        
        return task.stage;
    }

    /**
     * Get all tasks currently in progress (for overlap detection)
     */
    getInProgressTasks(): Array<{
        taskId: string;
        engineerName: string;
        stage: TaskStage;
        filesModified: string[];
    }> {
        const inProgress: Array<{
            taskId: string;
            engineerName: string;
            stage: TaskStage;
            filesModified: string[];
        }> = [];

        for (const engineer of this.engineers.values()) {
            if (engineer.status === 'working' && engineer.currentTask) {
                inProgress.push({
                    taskId: engineer.currentTask.id,
                    engineerName: engineer.engineerName,
                    stage: engineer.currentTask.stage,
                    filesModified: engineer.filesModified
                });
            }
        }

        return inProgress;
    }

    /**
     * Check if any file overlaps with ongoing work
     * Returns the task/engineer working on overlapping file, or null
     */
    checkFileOverlap(files: string[]): {
        taskId: string;
        engineerName: string;
        overlappingFiles: string[];
    } | null {
        const inProgress = this.getInProgressTasks();
        
        for (const work of inProgress) {
            const overlapping = files.filter(f => 
                work.filesModified.some(wf => 
                    wf === f || 
                    wf.endsWith(path.basename(f)) ||
                    f.endsWith(path.basename(wf))
                )
            );
            
            if (overlapping.length > 0) {
                return {
                    taskId: work.taskId,
                    engineerName: work.engineerName,
                    overlappingFiles: overlapping
                };
            }
        }

        return null;
    }

    /**
     * Get deferred tasks
     */
    getDeferredTasks(): ManagedTask[] {
        return Array.from(this.tasks.values()).filter(t => t.stage === 'deferred');
    }

    /**
     * Get tasks awaiting Unity pipeline results
     */
    getAwaitingUnityTasks(): ManagedTask[] {
        return Array.from(this.tasks.values()).filter(t => t.stage === 'awaiting_unity');
    }

    /**
     * Get a specific task by ID
     */
    getTask(taskId: string): ManagedTask | undefined {
        return this.tasks.get(taskId);
    }

    /**
     * Log to unified output channel
     */
    private log(message: string): void {
        this.outputManager.log('TASK', message);
    }

    /**
     * Show output channel
     */
    showOutput(): void {
        this.outputManager.show();
    }
}

