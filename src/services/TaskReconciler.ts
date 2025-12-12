// ============================================================================
// TaskReconciler - Synchronizes TaskManager with revised plan file
// ============================================================================

import { ServiceLocator } from './ServiceLocator';
import { TaskManager, ManagedTask, TaskStatus } from './TaskManager';
import { PlanParser, PlanTask } from './PlanParser';
import { TaskIdValidator } from './TaskIdValidator';
import { OutputChannelManager } from './OutputChannelManager';
import * as fs from 'fs';

/**
 * Result of a single task reconciliation action
 */
export interface TaskReconciliationAction {
    taskId: string;
    action: 'created' | 'deleted' | 'updated' | 'preserved' | 'conflict';
    reason: string;
    details?: {
        previousDescription?: string;
        newDescription?: string;
        previousDeps?: string[];
        newDeps?: string[];
        previousStatus?: TaskStatus;
    };
}

/**
 * Overall reconciliation result
 */
export interface ReconciliationResult {
    /** Session ID that was reconciled */
    sessionId: string;
    
    /** Tasks that were created (new in plan) */
    created: string[];
    
    /** Tasks that were deleted (removed from plan, were created/blocked) */
    deleted: string[];
    
    /** Tasks that were updated (description/deps changed) */
    updated: string[];
    
    /** Tasks that were preserved (in-progress or succeeded) */
    preserved: string[];
    
    /** Tasks with conflicts (removed from plan but in-progress) */
    conflicts: string[];
    
    /** Detailed actions for logging */
    actions: TaskReconciliationAction[];
    
    /** Summary statistics */
    summary: {
        planTaskCount: number;
        managerTaskCount: number;
        createdCount: number;
        deletedCount: number;
        updatedCount: number;
        preservedCount: number;
        conflictCount: number;
    };
}

/**
 * Options for reconciliation
 */
export interface ReconciliationOptions {
    /** If true, don't actually modify TaskManager - just report what would happen */
    dryRun?: boolean;
    
    /** If true, force delete in-progress tasks (dangerous!) */
    forceDeleteInProgress?: boolean;
}

/**
 * TaskReconciler
 * 
 * Synchronizes tasks in TaskManager with tasks defined in a plan file.
 * Used after plan revision to ensure TaskManager reflects the updated plan.
 * 
 * Reconciliation Rules:
 * - Task in plan + exists in TaskManager (created/blocked): Update if changed
 * - Task in plan + exists in TaskManager (in_progress): Keep, flag if scope changed
 * - Task in plan + exists in TaskManager (succeeded): Keep as-is
 * - Task in plan + NOT in TaskManager: Create task
 * - Task NOT in plan + exists in TaskManager (created/blocked): Delete
 * - Task NOT in plan + exists in TaskManager (in_progress): Conflict (keep, mark orphaned)
 * - Task NOT in plan + exists in TaskManager (succeeded): Keep (work was done)
 */
export class TaskReconciler {
    private outputManager: OutputChannelManager;
    
    constructor() {
        this.outputManager = ServiceLocator.resolve(OutputChannelManager);
    }
    
    /**
     * Reconcile TaskManager with a revised plan file
     * 
     * @param sessionId The session to reconcile
     * @param planPath Path to the revised plan file
     * @param options Reconciliation options
     * @returns Reconciliation result with details
     */
    reconcile(
        sessionId: string,
        planPath: string,
        options: ReconciliationOptions = {}
    ): ReconciliationResult {
        const { dryRun = false, forceDeleteInProgress = false } = options;
        
        const taskManager = ServiceLocator.resolve(TaskManager);
        
        // Initialize result
        const result: ReconciliationResult = {
            sessionId,
            created: [],
            deleted: [],
            updated: [],
            preserved: [],
            conflicts: [],
            actions: [],
            summary: {
                planTaskCount: 0,
                managerTaskCount: 0,
                createdCount: 0,
                deletedCount: 0,
                updatedCount: 0,
                preservedCount: 0,
                conflictCount: 0
            }
        };
        
        // Parse plan file to get current tasks
        if (!fs.existsSync(planPath)) {
            this.log(`❌ Plan file not found: ${planPath}`);
            return result;
        }
        
        const parsedPlan = PlanParser.parsePlanFile(planPath);
        const planTasks = parsedPlan.tasks || [];
        result.summary.planTaskCount = planTasks.length;
        
        // Get existing tasks from TaskManager
        const existingTasks = taskManager.getTasksForSession(sessionId);
        result.summary.managerTaskCount = existingTasks.length;
        
        // Build lookup maps
        const planTaskMap = new Map<string, PlanTask>();
        for (const task of planTasks) {
            const normalizedId = TaskIdValidator.normalizeGlobalTaskId(task.id);
            if (normalizedId) {
                planTaskMap.set(normalizedId, task);
            }
        }
        
        const existingTaskMap = new Map<string, ManagedTask>();
        for (const task of existingTasks) {
            existingTaskMap.set(task.id, task);
        }
        
        this.log(`\n${'─'.repeat(50)}`);
        this.log(`🔄 TASK RECONCILIATION: ${sessionId}`);
        this.log(`   Plan tasks: ${planTasks.length}`);
        this.log(`   TaskManager tasks: ${existingTasks.length}`);
        this.log(`${'─'.repeat(50)}`);
        
        // Process tasks in plan
        for (const [taskId, planTask] of planTaskMap) {
            const existingTask = existingTaskMap.get(taskId);
            
            if (existingTask) {
                // Task exists in both - check if update needed
                const action = this.reconcileExistingTask(
                    planTask,
                    existingTask,
                    taskManager,
                    dryRun
                );
                result.actions.push(action);
                
                switch (action.action) {
                    case 'updated':
                        result.updated.push(taskId);
                        result.summary.updatedCount++;
                        break;
                    case 'preserved':
                        result.preserved.push(taskId);
                        result.summary.preservedCount++;
                        break;
                }
            } else {
                // Task only in plan - create it
                const action = this.createTask(
                    sessionId,
                    planTask,
                    taskManager,
                    dryRun
                );
                result.actions.push(action);
                
                if (action.action === 'created') {
                    result.created.push(taskId);
                    result.summary.createdCount++;
                }
            }
        }
        
        // Process tasks NOT in plan (exist in TaskManager only)
        for (const [taskId, existingTask] of existingTaskMap) {
            if (!planTaskMap.has(taskId)) {
                const action = this.handleRemovedTask(
                    existingTask,
                    taskManager,
                    dryRun,
                    forceDeleteInProgress
                );
                result.actions.push(action);
                
                switch (action.action) {
                    case 'deleted':
                        result.deleted.push(taskId);
                        result.summary.deletedCount++;
                        break;
                    case 'preserved':
                        result.preserved.push(taskId);
                        result.summary.preservedCount++;
                        break;
                    case 'conflict':
                        result.conflicts.push(taskId);
                        result.summary.conflictCount++;
                        break;
                }
            }
        }
        
        // Log summary
        this.log(`\n📊 RECONCILIATION SUMMARY:`);
        this.log(`   ✅ Created: ${result.summary.createdCount}`);
        this.log(`   🗑️  Deleted: ${result.summary.deletedCount}`);
        this.log(`   📝 Updated: ${result.summary.updatedCount}`);
        this.log(`   💾 Preserved: ${result.summary.preservedCount}`);
        if (result.summary.conflictCount > 0) {
            this.log(`   ⚠️  Conflicts: ${result.summary.conflictCount}`);
            for (const conflictId of result.conflicts) {
                this.log(`      - ${conflictId} (in-progress but removed from plan)`);
            }
        }
        this.log(`${'─'.repeat(50)}\n`);
        
        return result;
    }
    
    /**
     * Reconcile an existing task (exists in both plan and TaskManager)
     */
    private reconcileExistingTask(
        planTask: PlanTask,
        existingTask: ManagedTask,
        taskManager: TaskManager,
        dryRun: boolean
    ): TaskReconciliationAction {
        const taskId = existingTask.id;
        
        // Check if task is in a terminal or active state
        const isCompleted = existingTask.status === 'succeeded';
        const isInProgress = existingTask.status === 'in_progress';
        
        if (isCompleted) {
            // Completed tasks are preserved as-is
            return {
                taskId,
                action: 'preserved',
                reason: 'Task already completed',
                details: { previousStatus: existingTask.status }
            };
        }
        
        // Normalize dependencies for comparison
        const existingDeps = existingTask.dependencies.map(d => d.toUpperCase()).sort();
        const planDeps = planTask.dependencies.map(d => {
            const normalized = TaskIdValidator.normalizeGlobalTaskId(d);
            return normalized || d.toUpperCase();
        }).sort();
        
        // Check what changed
        const descriptionChanged = planTask.description !== existingTask.description;
        const depsChanged = JSON.stringify(existingDeps) !== JSON.stringify(planDeps);
        
        if (!descriptionChanged && !depsChanged) {
            // No changes needed
            return {
                taskId,
                action: 'preserved',
                reason: 'No changes detected',
                details: { previousStatus: existingTask.status }
            };
        }
        
        if (isInProgress) {
            // In-progress task - preserve but log warning
            this.log(`   ⚠️  ${taskId}: In-progress, changes not applied`);
            return {
                taskId,
                action: 'preserved',
                reason: 'Task in-progress, changes deferred',
                details: {
                    previousDescription: existingTask.description,
                    newDescription: descriptionChanged ? planTask.description : undefined,
                    previousDeps: existingDeps,
                    newDeps: depsChanged ? planDeps : undefined,
                    previousStatus: existingTask.status
                }
            };
        }
        
        // Apply updates
        if (!dryRun) {
            if (descriptionChanged) {
                taskManager.updateTaskDescription(taskId, planTask.description);
            }
            if (depsChanged) {
                taskManager.updateTaskDependencies(taskId, planDeps);
            }
        }
        
        const changes: string[] = [];
        if (descriptionChanged) changes.push('description');
        if (depsChanged) changes.push('dependencies');
        
        this.log(`   📝 ${taskId}: Updated (${changes.join(', ')})`);
        
        return {
            taskId,
            action: 'updated',
            reason: `Updated: ${changes.join(', ')}`,
            details: {
                previousDescription: existingTask.description,
                newDescription: planTask.description,
                previousDeps: existingDeps,
                newDeps: planDeps,
                previousStatus: existingTask.status
            }
        };
    }
    
    /**
     * Create a new task from plan
     */
    private createTask(
        sessionId: string,
        planTask: PlanTask,
        taskManager: TaskManager,
        dryRun: boolean
    ): TaskReconciliationAction {
        const taskId = TaskIdValidator.normalizeGlobalTaskId(planTask.id);
        if (!taskId) {
            return {
                taskId: planTask.id,
                action: 'conflict',
                reason: `Invalid task ID format: ${planTask.id}`
            };
        }
        
        // Normalize dependencies
        const deps = planTask.dependencies.map(d => {
            const normalized = TaskIdValidator.normalizeGlobalTaskId(d);
            return normalized || d.toUpperCase();
        });
        
        if (!dryRun) {
            const result = taskManager.createTaskFromCli({
                sessionId,
                taskId,
                description: planTask.description,
                dependencies: deps,
                taskType: 'implementation',
                priority: 10
            });
            
            if (!result.success) {
                this.log(`   ❌ ${taskId}: Failed to create - ${result.error}`);
                return {
                    taskId,
                    action: 'conflict',
                    reason: `Failed to create: ${result.error}`
                };
            }
        }
        
        this.log(`   ✅ ${taskId}: Created`);
        
        return {
            taskId,
            action: 'created',
            reason: 'New task from revised plan',
            details: {
                newDescription: planTask.description,
                newDeps: deps
            }
        };
    }
    
    /**
     * Handle a task that was removed from plan
     */
    private handleRemovedTask(
        existingTask: ManagedTask,
        taskManager: TaskManager,
        dryRun: boolean,
        forceDeleteInProgress: boolean
    ): TaskReconciliationAction {
        const taskId = existingTask.id;
        const status = existingTask.status;
        
        // Succeeded tasks are always preserved (work was done)
        if (status === 'succeeded') {
            this.log(`   💾 ${taskId}: Preserved (completed work)`);
            return {
                taskId,
                action: 'preserved',
                reason: 'Completed task preserved (work was done)',
                details: { previousStatus: status }
            };
        }
        
        // In-progress tasks are conflicts (unless force delete)
        if (status === 'in_progress') {
            if (forceDeleteInProgress) {
                if (!dryRun) {
                    taskManager.deleteTask(taskId, 'Removed from plan (force delete)');
                }
                this.log(`   🗑️  ${taskId}: Force deleted (was in-progress)`);
                return {
                    taskId,
                    action: 'deleted',
                    reason: 'Force deleted in-progress task',
                    details: { previousStatus: status }
                };
            }
            
            // Mark as orphaned (will be cleaned up when workflow completes)
            if (!dryRun) {
                taskManager.markTaskOrphaned(taskId, 'Removed from plan during revision');
            }
            this.log(`   ⚠️  ${taskId}: Conflict (in-progress, removed from plan)`);
            return {
                taskId,
                action: 'conflict',
                reason: 'In-progress task removed from plan (marked orphaned)',
                details: { previousStatus: status }
            };
        }
        
        // Created, blocked, or awaiting_decision tasks can be deleted
        if (['created', 'blocked', 'awaiting_decision'].includes(status)) {
            if (!dryRun) {
                taskManager.deleteTask(taskId, 'Removed from plan during revision');
            }
            this.log(`   🗑️  ${taskId}: Deleted (was ${status})`);
            return {
                taskId,
                action: 'deleted',
                reason: `Deleted (status was ${status})`,
                details: { previousStatus: status }
            };
        }
        
        // Unknown status - preserve to be safe
        this.log(`   💾 ${taskId}: Preserved (unknown status: ${status})`);
        return {
            taskId,
            action: 'preserved',
            reason: `Preserved (unknown status: ${status})`,
            details: { previousStatus: status }
        };
    }
    
    /**
     * Log to output channel
     */
    private log(message: string): void {
        this.outputManager.log('RECONCILE', message);
    }
}

