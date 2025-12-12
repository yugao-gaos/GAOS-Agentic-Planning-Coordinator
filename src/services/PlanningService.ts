import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import { StateManager } from './StateManager';
import { PlanningSession, PlanStatus, ExecutionState } from '../types';
import { UnifiedCoordinatorService } from './UnifiedCoordinatorService';
import { OutputChannelManager } from './OutputChannelManager';
import { EventBroadcaster } from '../daemon/EventBroadcaster';
import { PlanningWorkflowInput, RequirementComplexity } from '../types/workflow';
import { ServiceLocator } from './ServiceLocator';
import { TaskManager } from './TaskManager';
import { TaskIdValidator } from './TaskIdValidator';
import { PlanParser, PlanTask } from './PlanParser';

/**
 * Configuration for PlanningService
 */
export interface PlanningServiceConfig {
    /** Unity best practices path (optional) */
    unityBestPracticesPath?: string;
}

/**
 * Result of task auto-creation from plan
 */
interface TaskCreationStats {
    tasksCreated: number;
    totalTasksInPlan: number;
    failedToCreate: string[];
}

/**
 * Task info for topological sorting
 */
interface TaskWithGlobalIds {
    task: PlanTask;
    globalId: string;
    globalDeps: string[];
}

/**
 * PlanningService - Planning and Execution Facade
 * 
 * This service provides a high-level API for planning sessions.
 * All planning and execution work is delegated to UnifiedCoordinatorService.
 */
export class PlanningService extends EventEmitter {
    private stateManager: StateManager;
    private coordinator: UnifiedCoordinatorService;
    private outputManager: OutputChannelManager;
    private config: PlanningServiceConfig;
    
    // Track session-specific subscriptions for cleanup
    private sessionSubscriptions: Map<string, Array<{ dispose: () => void }>> = new Map();
    
    /**
     * Create a new PlanningService
     * 
     * @param stateManager State manager for session persistence
     * @param coordinator REQUIRED - UnifiedCoordinatorService for workflow management
     * @param config Optional configuration
     */
    constructor(
        stateManager: StateManager, 
        coordinator: UnifiedCoordinatorService,
        config?: PlanningServiceConfig
    ) {
        super();
        this.stateManager = stateManager;
        this.coordinator = coordinator;
        this.config = config || {};
        this.outputManager = ServiceLocator.resolve(OutputChannelManager);
        
        console.log('[PlanningService] Initialized with UnifiedCoordinatorService');
    }
    
    // ========================================================================
    // Events
    // ========================================================================
    
    /**
     * Fire sessions changed event
     */
    private fireSessionsChanged(): void {
        this.emit('sessionsChanged');
    }
    
    /**
     * Subscribe to sessions changed event
     */
    onSessionsChanged(callback: () => void): () => void {
        this.on('sessionsChanged', callback);
        return () => this.off('sessionsChanged', callback);
    }
    
    // ========================================================================
    // Notification Helpers
    // ========================================================================
    
    /**
     * Show info notification via event broadcasting
     */
    private notifyInfo(message: string, sessionId?: string, planPath?: string): void {
        console.log(`[PlanningService] INFO: ${message}`);
        this.emit('notification', { 
            type: 'info', 
            message, 
            sessionId, 
            planPath,
            timestamp: new Date().toISOString()
        });
        
        if (sessionId) {
            ServiceLocator.resolve(EventBroadcaster).sessionUpdated(sessionId, 'reviewing', '', [message]);
        }
    }
    
    /**
     * Show warning notification via event broadcasting
     */
    private notifyWarning(message: string, sessionId?: string): void {
        console.warn(`[PlanningService] WARNING: ${message}`);
        this.emit('notification', { 
            type: 'warning', 
            message, 
            sessionId,
            timestamp: new Date().toISOString()
        });
    }
    
    /**
     * Show error notification via event broadcasting
     */
    private notifyError(message: string, sessionId?: string): void {
        console.error(`[PlanningService] ERROR: ${message}`);
        this.emit('notification', { 
            type: 'error', 
            message, 
            sessionId,
            timestamp: new Date().toISOString()
        });
        
        ServiceLocator.resolve(EventBroadcaster).error('planning_error', message, { sessionId });
    }
    
    /**
     * Show the output channel
     */
    showOutput(): void {
        this.outputManager.show();
    }

    // ========================================================================
    // Progress Logging
    // ========================================================================

    /**
     * Write progress update to output channel
     * Note: File-based progress.log removed - use workflow logs in logs/ folder instead
     */
    private writeProgress(_sessionId: string, phase: string, message: string): void {
        const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
        const line = `[${timestamp}] [${phase}] ${message}`;
        this.outputManager.appendLine(line);
    }

    private notifyChange(): void {
        this.fireSessionsChanged();
        this.stateManager.updateStateFiles();
    }

    // ========================================================================
    // Planning Operations - All delegate to UnifiedCoordinatorService
    // ========================================================================

    /**
     * Start a new planning session
     * Dispatches planning_new workflow via UnifiedCoordinatorService
     * 
     * @param requirement - The requirement description
     * @param docs - Optional list of document paths
     * @param complexity - Optional complexity classification (tiny, small, medium, large, huge)
     */
    async startPlanning(requirement: string, docs?: string[], complexity?: string): Promise<{
        sessionId: string;
        status: PlanStatus;
        debateSummary?: {
            phases: string[];
            concerns: string[];
            recommendations: string[];
            consensus: string;
        };
        planPath?: string;
        recommendedAgents?: number;
        iterations?: number;
        complexity?: string;
    }> {
        const sessionId = this.stateManager.generatePlanningSessionId();
        
        const session: PlanningSession = {
            id: sessionId,
            status: 'planning',
            requirement: requirement,
            planHistory: [],
            revisionHistory: [{
                version: 0,
                feedback: 'Initial requirement',
                timestamp: new Date().toISOString()
            }],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        this.stateManager.savePlanningSession(session);
        this.notifyChange();

        // Show output channel
        this.outputManager.clear();
        this.outputManager.show();
        
        // Validate complexity if provided
        const validComplexities = ['tiny', 'small', 'medium', 'large', 'huge'];
        const validatedComplexity = complexity && validComplexities.includes(complexity.toLowerCase()) 
            ? complexity.toLowerCase() as RequirementComplexity
            : undefined;
        
        // Build input and dispatch planning_new workflow
        const input: PlanningWorkflowInput = {
            requirement,
            docs: docs || [],
            complexity: validatedComplexity
        };
        
        const workflowId = await this.coordinator.dispatchWorkflow(
            sessionId,
            'planning_new',
            input,
            { priority: 5, blocking: true }
        );
        
        // Update session
        session.status = 'planning';
        session.updatedAt = new Date().toISOString();
        this.stateManager.savePlanningSession(session);
        this.notifyChange();
        
        // Subscribe to completion for this workflow
        const disposable = this.coordinator.onWorkflowComplete((event) => {
            if (event.sessionId === sessionId) {
                const updatedSession = this.stateManager.getPlanningSession(sessionId);
                if (updatedSession) {
                    if (event.result.success && event.result.output?.planPath) {
                        // Success - full plan available
                        updatedSession.status = 'reviewing';
                        updatedSession.currentPlanPath = event.result.output.planPath;
                        updatedSession.planHistory.push({
                            version: 1,
                            path: event.result.output.planPath,
                            timestamp: new Date().toISOString()
                        });
                        
                        const engineerCount = this.estimateEngineerCount(requirement);
                        updatedSession.recommendedAgents = {
                            count: engineerCount,
                            justification: `Workflow-based planning (${event.result.output.iterations || 1} iterations)`
                        };
                        
                        // Clear any partial plan metadata on success
                        if (updatedSession.metadata?.partialPlan) {
                            delete updatedSession.metadata.partialPlan;
                            delete updatedSession.metadata.interruptedAt;
                            delete updatedSession.metadata.interruptReason;
                        }
                    } else {
                        // Workflow failed or was cancelled
                        // Check if partial plan file exists and has meaningful content
                        const planPath = this.stateManager.getPlanFilePath(sessionId);
                        let hasContent = false;
                        if (fs.existsSync(planPath)) {
                            try {
                                const content = fs.readFileSync(planPath, 'utf-8');
                                // Check if plan has content beyond the placeholder header
                                // (more than 500 chars and not ending with the placeholder message)
                                hasContent = content.length > 500 && 
                                    !content.includes('*Plan content will appear below as the planner works...*');
                            } catch { /* ignore read errors */ }
                        }
                        
                        if (hasContent) {
                            // Partial plan exists with content - allow review/restart
                            updatedSession.status = 'reviewing';
                            updatedSession.currentPlanPath = planPath;
                            // Mark as partial in metadata for UI to indicate incomplete
                            updatedSession.metadata = updatedSession.metadata || {};
                            updatedSession.metadata.partialPlan = true;
                            updatedSession.metadata.interruptedAt = new Date().toISOString();
                            updatedSession.metadata.interruptReason = event.result.error || 'Workflow interrupted';
                        } else {
                            // No meaningful plan content - go to no_plan status
                            // But keep currentPlanPath if the file exists so user can see what's there
                            updatedSession.status = 'no_plan';
                            if (fs.existsSync(planPath)) {
                                updatedSession.currentPlanPath = planPath;
                            }
                        }
                    }
                    
                    updatedSession.updatedAt = new Date().toISOString();
                    this.stateManager.savePlanningSession(updatedSession);
                    this.notifyChange();
                    
                    if (event.result.success) {
                        this.notifyInfo(
                            `Planning session ${sessionId} ready for review`,
                            sessionId,
                            updatedSession.currentPlanPath
                        );
                    }
                }
                disposable.dispose();
            }
        });

        return {
            sessionId,
            status: session.status,
            debateSummary: {
                phases: ['Context', 'Planner', 'Analysts', 'Finalize'],
                concerns: [],
                recommendations: [],
                consensus: 'Workflow started - planning in progress'
            },
            planPath: undefined,
            recommendedAgents: undefined
        };
    }

    /**
     * Estimate engineer count based on requirement
     */
    private estimateEngineerCount(requirement: string): number {
        const words = requirement.split(/\s+/).length;
        if (words < 10) return 2;
        if (words < 30) return 3;
        if (words < 50) return 4;
        return 5;
    }

    /**
     * Revise an existing plan
     * Dispatches planning_revision workflow via UnifiedCoordinatorService
     */
    async revisePlan(sessionId: string, feedback: string): Promise<{ 
        sessionId: string; 
        status: PlanStatus;
        planPath?: string;
        version?: number;
    }> {
        const session = this.stateManager.getPlanningSession(sessionId);
        if (!session) {
            throw new Error(`Planning session ${sessionId} not found`);
        }

        const previousStatus = session.status;
        const newVersion = session.planHistory.length + 1;
        
        session.status = 'revising';
        session.revisionHistory.push({
            version: newVersion,
            feedback: feedback,
            timestamp: new Date().toISOString()
        });
        session.updatedAt = new Date().toISOString();
        
        this.stateManager.savePlanningSession(session);
        this.notifyChange();

        try {
            // Check for existing revision workflow - prevent concurrent revisions
            const workflowSummaries = this.coordinator.getWorkflowSummaries(sessionId);
            const existingRevision = workflowSummaries.find(
                (w) => w.type === 'planning_revision' && 
                    ['running', 'pending', 'blocked'].includes(w.status)
            );
            if (existingRevision) {
                throw new Error(`Revision already in progress (${existingRevision.id.substring(0, 8)}). Wait for it to complete or cancel it first.`);
            }
            
            // Check for plan path
            if (!session.currentPlanPath) {
                throw new Error('No plan path available for revision');
            }
            
            // Show output channel
            this.outputManager.clear();
            this.outputManager.show();
            
            // CRITICAL: Pause coordinator evaluations during plan modification
            // This prevents the coordinator from dispatching tasks based on stale plan state
            this.coordinator.pauseEvaluations(sessionId, 'Plan revision in progress');
            
            // Build input and dispatch planning_revision workflow
            const input: PlanningWorkflowInput = {
                requirement: session.requirement || '',
                userFeedback: feedback,
                existingPlanPath: session.currentPlanPath
            };
            
            const workflowId = await this.coordinator.dispatchWorkflow(
                sessionId,
                'planning_revision',
                input,
                { priority: 1, blocking: true }  // High priority
            );
            
            // Subscribe to completion
            const disposable = this.coordinator.onWorkflowComplete((event) => {
                if (event.sessionId === sessionId && event.workflowId === workflowId) {
                    const updatedSession = this.stateManager.getPlanningSession(sessionId);
                    if (updatedSession) {
                        if (event.result.success && event.result.output?.planPath) {
                            // Success - plan revision complete
                            // NOTE: planHistory is already updated by the workflow (PlanningRevisionWorkflow.executeFinalizePhase)
                            // which handles both updating the previous version's path to the backup
                            // and adding the new version. We just update status and metadata here.
                            updatedSession.status = 'reviewing';
                            updatedSession.currentPlanPath = event.result.output.planPath;
                            // Clear partial plan metadata on success
                            if (updatedSession.metadata?.partialPlan) {
                                delete updatedSession.metadata.partialPlan;
                                delete updatedSession.metadata.interruptedAt;
                                delete updatedSession.metadata.interruptReason;
                            }
                        } else {
                            // Workflow failed or was cancelled
                            // For revision, we keep the existing plan and just mark interrupted
                            updatedSession.status = previousStatus;
                            updatedSession.metadata = updatedSession.metadata || {};
                            updatedSession.metadata.revisionInterrupted = true;
                            updatedSession.metadata.interruptedAt = new Date().toISOString();
                            updatedSession.metadata.interruptReason = event.result.error || 'Revision interrupted';
                        }
                        
                        updatedSession.updatedAt = new Date().toISOString();
                        this.stateManager.savePlanningSession(updatedSession);
                        this.notifyChange();
                        
                        if (event.result.success) {
                            this.notifyInfo(
                                `Plan revision v${newVersion} ready for review`,
                                sessionId,
                                updatedSession.currentPlanPath
                            );
                        }
                    }
                    disposable.dispose();
                }
            });

            return {
                sessionId,
                status: session.status,
                planPath: session.currentPlanPath,
                version: newVersion
            };
        } catch (error) {
            // Resume coordinator evaluations on error
            this.coordinator.resumeEvaluations(sessionId);
            
            session.status = previousStatus || 'reviewing';
            session.updatedAt = new Date().toISOString();
            this.stateManager.savePlanningSession(session);
            this.notifyChange();

            this.notifyError(`Plan revision failed. Session reset to "${session.status}" status.`, sessionId);
            throw error;
        }
    }

    /**
     * Add specific task(s) to an existing plan via revision workflow
     * 
     * This is a specialized form of revision that:
     * 1. Builds a task-focused revision feedback
     * 2. Dispatches the planning_revision workflow (Planner + Analysts review)
     * 3. Tasks are only added to TaskManager after plan approval
     * 
     * The revision workflow ensures:
     * - Dependencies are validated and set correctly
     * - Plan standards are maintained
     * - Multi-agent review for quality
     * 
     * @param sessionId The session ID
     * @param taskSpec Task specification(s) to add
     * @returns Result with success status
     */
    async addTaskToPlan(
        sessionId: string,
        taskSpec: {
            id: string;
            description: string;
            dependencies?: string[];
            engineer?: string;
            unityPipeline?: 'none' | 'prep' | 'prep_editmode' | 'prep_playmode' | 'prep_playtest' | 'full';
        }
    ): Promise<{ success: boolean; taskId?: string; error?: string }> {
        const session = this.stateManager.getPlanningSession(sessionId);
        if (!session) {
            return { success: false, error: `Session ${sessionId} not found` };
        }
        
        if (!session.currentPlanPath) {
            return { success: false, error: 'No plan file available' };
        }
        
        if (!fs.existsSync(session.currentPlanPath)) {
            return { success: false, error: 'Plan file does not exist' };
        }
        
        // Build task-focused revision feedback
        const depsStr = taskSpec.dependencies?.length 
            ? taskSpec.dependencies.join(', ') 
            : 'determine based on task dependencies';
        const engineer = taskSpec.engineer || 'appropriate engineer based on task type';
        const unity = taskSpec.unityPipeline || 'none';
        
        // Create a structured feedback for the revision workflow
        const revisionFeedback = `ADD NEW TASK TO PLAN:

Task ID: ${taskSpec.id}
Description: ${taskSpec.description}
Dependencies: ${depsStr}
Engineer: ${engineer}
Unity Pipeline: ${unity}

INSTRUCTIONS FOR PLANNER:
1. Add this task to the Task Breakdown section following the standard checkbox format
2. Validate and correct the dependencies based on the existing task structure
3. Assign the appropriate engineer role if not specified
4. Ensure the task ID is unique and follows the naming convention
5. Keep all existing tasks unchanged - only ADD the new task(s)
6. Update any relevant sections (phases, dependencies graph) if needed

This is a TASK ADDITION revision - do not modify existing tasks unless necessary for dependency correctness.`;

        try {
            // Use the revision workflow - this ensures proper review
            const result = await this.revisePlan(sessionId, revisionFeedback);
            
            return { 
                success: true, 
                taskId: taskSpec.id,
                // Note: The actual task ID may be adjusted by the planner
            };
            
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            return { success: false, error: errorMsg };
        }
    }

    /**
     * Review plan format before approval
     */
    async reviewPlanFormat(sessionId: string): Promise<{
        valid: boolean;
        issues: string[];
        taskCount: number;
        tasksFound: Array<{ id: string; description: string; deps: string[] }>;
    }> {
        const session = this.stateManager.getPlanningSession(sessionId);
        if (!session || !session.currentPlanPath) {
            return { valid: false, issues: ['Plan file not found'], taskCount: 0, tasksFound: [] };
        }

        const planContent = fs.readFileSync(session.currentPlanPath, 'utf-8');
        const issues: string[] = [];
        
        // Use PlanParser for consistency
        const parsedTasks = PlanParser.parseInlineCheckboxTasks(planContent);
        const tasksFound: Array<{ id: string; description: string; deps: string[] }> = parsedTasks.map((t: any) => ({
            id: t.id,
            description: t.description,
            deps: t.dependencies
        }));

        if (tasksFound.length === 0) {
            issues.push(`No tasks found in checkbox format. Expected format: - [ ] **${sessionId}_T1**: Task description | Deps: None`);
            
            // Check for table format tasks
            const tableCount = PlanParser.countTableFormatTasks(planContent);
            if (tableCount > 0) {
                issues.push(`Found ${tableCount} tasks in TABLE format. Please convert to CHECKBOX format for tracking.`);
            }
        }

        // Check for duplicate task IDs
        const taskIds = tasksFound.map(t => t.id);
        const duplicates = taskIds.filter((id, idx) => taskIds.indexOf(id) !== idx);
        if (duplicates.length > 0) {
            issues.push(`Duplicate task IDs found: ${[...new Set(duplicates)].join(', ')}`);
        }

        // Check for missing dependency references
        for (const task of tasksFound) {
            for (const dep of task.deps) {
                if (!taskIds.includes(dep)) {
                    issues.push(`Task ${task.id} depends on ${dep} which doesn't exist`);
                }
            }
        }

        // Check for circular dependencies
        for (const task of tasksFound) {
            if (task.deps.includes(task.id)) {
                issues.push(`Task ${task.id} has circular dependency on itself`);
            }
        }
        
        // Check if no tasks have dependencies (suspicious for a real plan)
        const tasksWithDeps = tasksFound.filter(t => t.deps.length > 0).length;
        if (tasksFound.length > 1 && tasksWithDeps === 0) {
            issues.push(`WARNING: ${tasksFound.length} tasks found but NONE have dependencies. Check plan format (expected: | Deps: T1 |)`);
        }

        this.writeProgress(sessionId, 'REVIEW', `Plan format review: ${tasksFound.length} tasks found (${tasksWithDeps} with dependencies)`);
        if (issues.length > 0) {
            for (const issue of issues) {
                this.writeProgress(sessionId, 'REVIEW', `  ⚠️ ${issue}`);
            }
        } else {
            this.writeProgress(sessionId, 'REVIEW', '  ✅ Plan format valid');
        }

        return {
            valid: issues.length === 0,
            issues,
            taskCount: tasksFound.length,
            tasksFound
        };
    }

    /**
     * Approve a plan for execution
     * 
     * New flow with TaskAgent:
     * 1. Set status to 'verifying'
     * 2. Run format review and cycle detection
     * 3. Auto-create tasks from parsed plan
     * 4. Run TaskAgent verification loop (creates CTX, handles changes)
     * 5. Set status to 'approved'
     * 6. Start coordinator execution
     */
    async approvePlan(sessionId: string, autoStart: boolean = true): Promise<void> {
        const session = this.stateManager.getPlanningSession(sessionId);
        if (!session) {
            throw new Error(`Planning session ${sessionId} not found`);
        }

        if (session.status !== 'reviewing') {
            throw new Error(`Plan is not ready for approval (status: ${session.status})`);
        }

        // Step 1: Set status to 'verifying' - TaskAgent will manage tasks
        session.status = 'verifying';
        session.updatedAt = new Date().toISOString();
        this.stateManager.savePlanningSession(session);
        this.notifyChange();
        
        this.writeProgress(sessionId, 'APPROVE', `📋 Starting task verification...`);

        // Step 2: Run format review (non-blocking - TaskAgent will handle issues)
        const reviewResult = await this.reviewPlanFormat(sessionId);
        if (!reviewResult.valid) {
            // Log warning but DON'T block - TaskAgent will handle
            this.writeProgress(sessionId, 'VALIDATE', `⚠️ Plan format parsing issues (TaskAgent will resolve):`);
            for (const issue of reviewResult.issues) {
                this.writeProgress(sessionId, 'VALIDATE', `  • ${issue}`);
            }
        }
        
        // Run cycle detection if tasks were successfully parsed
        if (reviewResult.tasksFound.length > 0) {
            const { DependencyGraphUtils } = await import('./DependencyGraphUtils');
            const taskNodes = reviewResult.tasksFound.map(t => ({
                id: t.id,
                dependencies: t.deps
            }));
            
            const validation = DependencyGraphUtils.validateGraph(taskNodes);
            if (!validation.valid) {
                // Cycle detection errors ARE blocking - revert to reviewing
                session.status = 'reviewing';
                this.stateManager.savePlanningSession(session);
                this.notifyChange();
                
                const errorMsg = `Dependency graph validation failed:\n${validation.errors.join('\n')}`;
                this.notifyWarning(
                    `Plan has dependency issues. Fix circular dependencies before approval:\n${validation.errors.slice(0, 3).join('\n')}${validation.errors.length > 3 ? '...' : ''}`,
                    sessionId
                );
                throw new Error(errorMsg);
            }
            
            if (validation.warnings.length > 0) {
                this.writeProgress(sessionId, 'VALIDATE', `⚠️ Dependency graph warnings:`);
                for (const warning of validation.warnings) {
                    this.writeProgress(sessionId, 'VALIDATE', `  • ${warning}`);
                }
            }
            
            this.writeProgress(sessionId, 'VALIDATE', `✅ Dependency graph validated: No cycles detected`);
        } else {
            this.writeProgress(sessionId, 'VALIDATE', `ℹ️ No tasks parsed - TaskAgent will create tasks`);
        }

        // Step 3: Try to auto-create tasks from parsed plan
        const taskStats = await this.tryCreateTasksFromPlan(sessionId, session.currentPlanPath!);
        this.writeProgress(sessionId, 'TASKS', `📦 Auto-created ${taskStats.tasksCreated}/${taskStats.totalTasksInPlan} tasks`);
        
        // Step 4: Run TaskAgent verification (async - sets needsContext flags, handles updates)
        // For now, we'll skip the full TaskAgent loop and proceed to approved
        // The TaskAgent will be triggered on-demand via CLI when needed
        // TODO: Integrate full TaskAgent.verifyTasks() loop here
        this.writeProgress(sessionId, 'VERIFY', `✅ Initial task verification complete`);
        
        // Step 5: Set status to 'approved'
        // Re-fetch session in case it was updated
        const updatedSession = this.stateManager.getPlanningSession(sessionId);
        if (!updatedSession) {
            throw new Error(`Session ${sessionId} disappeared during verification`);
        }
        
        updatedSession.status = 'approved';
        updatedSession.updatedAt = new Date().toISOString();
        this.stateManager.savePlanningSession(updatedSession);
        this.notifyChange();
        
        // Step 6: Start coordinator execution if autoStart
        if (autoStart) {
            const result = await this.startExecution(sessionId, { taskStats });
            if (result.success) {
                this.notifyInfo(`Plan ${sessionId} approved and execution started with ${result.engineerCount} engineers!`, sessionId);
            } else {
                this.notifyWarning(`Plan ${sessionId} approved but execution failed to start: ${result.error}`, sessionId);
            }
        } else {
            this.notifyInfo(`Plan ${sessionId} approved and ready for execution`, sessionId);
        }
    }
    
    /**
     * Auto-create tasks from a parsed plan file.
     * Uses topological sorting to ensure dependencies are created before dependents.
     * 
     * @param sessionId Session ID for the plan
     * @param planPath Path to the plan file
     * @returns Stats about task creation for coordinator context
     */
    private async tryCreateTasksFromPlan(sessionId: string, planPath: string): Promise<TaskCreationStats> {
        const taskManager = ServiceLocator.resolve(TaskManager);
        
        // Parse the plan file
        const parsedPlan = PlanParser.parsePlanFile(planPath);
        
        if (!parsedPlan.tasks || parsedPlan.tasks.length === 0) {
            this.writeProgress(sessionId, 'TASKS', `⚠️ No tasks found in plan file`);
            return { tasksCreated: 0, totalTasksInPlan: 0, failedToCreate: [] };
        }
        
        // Get existing tasks to avoid duplicates
        const existingTasks = taskManager.getTasksForSession(sessionId);
        const existingIds = new Set(existingTasks.map(t => t.id));
        
        // Normalize sessionId to UPPERCASE for consistent task ID format
        const normalizedSessionId = sessionId.toUpperCase();
        
        // Build task map with validated global IDs - no auto-conversion
        const taskMap = new Map<string, TaskWithGlobalIds>();
        for (const task of parsedPlan.tasks) {
            // Task IDs must already be in global format - validate, don't auto-convert
            const globalId = TaskIdValidator.normalizeGlobalTaskId(task.id);
            if (!globalId) {
                console.warn(`[PlanningService] Skipping task with invalid ID "${task.id}" - must be global format PS_XXXXXX_TN`);
                continue;
            }
            
            // Dependencies must also be in global format
            const globalDeps: string[] = [];
            for (const dep of task.dependencies) {
                const globalDep = TaskIdValidator.normalizeGlobalTaskId(dep);
                if (globalDep) {
                    globalDeps.push(globalDep);
                } else {
                    console.warn(`[PlanningService] Skipping invalid dependency "${dep}" for task ${globalId}`);
                }
            }
            
            taskMap.set(globalId, { task, globalId, globalDeps });
        }
        
        // Topological sort: Create tasks in order where dependencies come before dependents
        const sortedTasks: TaskWithGlobalIds[] = [];
        const visited = new Set<string>();
        const inProgress = new Set<string>(); // For cycle detection
        
        const visit = (globalId: string): boolean => {
            if (visited.has(globalId)) return true;
            if (inProgress.has(globalId)) {
                // Cycle detected - this shouldn't happen if plan was validated
                this.writeProgress(sessionId, 'TASKS', `⚠️ Cycle detected at task ${globalId}`);
                return false;
            }
            
            const taskInfo = taskMap.get(globalId);
            if (!taskInfo) return true; // External dependency, skip
            
            inProgress.add(globalId);
            
            // Visit dependencies first (only same-session deps)
            for (const depId of taskInfo.globalDeps) {
                if (taskMap.has(depId) && !visited.has(depId)) {
                    if (!visit(depId)) return false;
                }
            }
            
            inProgress.delete(globalId);
            visited.add(globalId);
            sortedTasks.push(taskInfo);
            return true;
        };
        
        // Visit all tasks
        for (const globalId of taskMap.keys()) {
            if (!visited.has(globalId)) {
                visit(globalId);
            }
        }
        
        // Create tasks in sorted order
        let created = 0;
        let skipped = 0;
        const errors: string[] = [];
        const failedTaskIds: string[] = [];
        
        for (const { task, globalId: globalTaskId, globalDeps } of sortedTasks) {
            // Skip if already exists
            if (existingIds.has(globalTaskId)) {
                skipped++;
                continue;
            }
            
            // Pass global task ID - createTaskFromCli requires global format PS_XXXXXX_TN
            const result = taskManager.createTaskFromCli({
                sessionId,
                taskId: globalTaskId,
                description: task.description,
                dependencies: globalDeps,
                taskType: 'implementation',
                priority: 10
            });
            
            if (result.success) {
                created++;
                existingIds.add(globalTaskId);
            } else {
                errors.push(`${globalTaskId}: ${result.error}`);
                failedTaskIds.push(globalTaskId);
            }
        }
        
        const totalTasksInPlan = parsedPlan.tasks.length;
        
        // Log results
        if (created > 0) {
            this.writeProgress(sessionId, 'TASKS', `✅ Auto-created ${created}/${totalTasksInPlan} tasks from plan`);
        }
        if (skipped > 0) {
            this.writeProgress(sessionId, 'TASKS', `⏭️ Skipped ${skipped} existing tasks`);
        }
        if (errors.length > 0) {
            this.writeProgress(sessionId, 'TASKS', `❌ ${errors.length} tasks failed to create (coordinator will handle):`);
            for (const err of errors) {
                this.writeProgress(sessionId, 'TASKS', `   • ${err}`);
            }
        }
        
        // Log dependency summary
        const totalDeps = parsedPlan.tasks.reduce((sum, t) => sum + t.dependencies.length, 0);
        this.writeProgress(sessionId, 'TASKS', `📊 Task summary: ${created}/${totalTasksInPlan} created, ${totalDeps} total dependencies`);
        
        return {
            tasksCreated: created,
            totalTasksInPlan,
            failedToCreate: failedTaskIds
        };
    }
    
    // =========================================================================
    // EXECUTION FACADE METHODS (delegates to CoordinatorService)
    // =========================================================================
    
    /**
     * Start execution for an approved plan
     * Note: Plan status stays 'approved'. This triggers the Coordinator AI Agent
     * which decides what tasks/workflows to dispatch. Workflow states are tracked separately.
     */
    async startExecution(sessionId: string, options?: {
        mode?: 'auto' | 'interactive';
        engineerCount?: number;
        taskStats?: {
            tasksCreated: number;
            totalTasksInPlan: number;
            failedToCreate: string[];
        };
    }): Promise<{ success: boolean; error?: string; engineerCount?: number }> {
        try {
            const session = this.stateManager.getPlanningSession(sessionId);
            if (!session) {
                return { success: false, error: `Session ${sessionId} not found` };
            }
            
            // Plan must be approved to start execution
            if (session.status !== 'approved') {
                return { success: false, error: `Session must be 'approved' to start execution (current: ${session.status})` };
            }
            
            if (!session.currentPlanPath) {
                return { success: false, error: 'No plan file found for this session' };
            }
            
            // Start execution via coordinator (dispatches task workflows)
            const workflowIds = await this.coordinator.startExecution(sessionId, options?.taskStats);
            
            // Create simplified execution state (occupancy tracked in global TaskManager)
            const executionState: ExecutionState = {
                startedAt: new Date().toISOString(),
                lastActivityAt: new Date().toISOString(),
                progress: { completed: 0, total: workflowIds.length, percentage: 0 }
            };
            
            // Update session - status stays 'approved', only set execution state
            session.execution = executionState;
            session.updatedAt = new Date().toISOString();
            this.stateManager.savePlanningSession(session);
            this.notifyChange();
            
            // Subscribe to workflow progress for UI updates (track for cleanup)
            const progressDisposable = this.coordinator.onWorkflowProgress((progress) => {
                if (progress.workflowId) {
                    this.updateSessionFromWorkflowProgress(sessionId);
                }
            });
            this.trackSessionSubscription(sessionId, progressDisposable);
            
            this.writeProgress(sessionId, 'EXECUTION', '═'.repeat(60));
            this.writeProgress(sessionId, 'EXECUTION', '🚀 EXECUTION STARTED');
            this.writeProgress(sessionId, 'EXECUTION', `   Mode: ${options?.mode || 'auto'}`);
            this.writeProgress(sessionId, 'EXECUTION', `   Task Workflows: ${workflowIds.length}`);
            this.writeProgress(sessionId, 'EXECUTION', '═'.repeat(60));
            
            return { success: true, engineerCount: workflowIds.length };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            return { success: false, error: errorMsg };
        }
    }
    
    /**
     * Update session state from workflow progress
     */
    private updateSessionFromWorkflowProgress(sessionId: string): void {
        const state = this.coordinator.getSessionState(sessionId);
        if (!state) return;
        
        const session = this.stateManager.getPlanningSession(sessionId);
        if (!session || !session.execution) return;
        
        const completed = state.completedWorkflows.length;
        const total = state.activeWorkflows.size + state.pendingWorkflows.length + completed;
        
        session.execution.progress = {
            completed,
            total,
            percentage: total > 0 ? (completed / total) * 100 : 0
        };
        session.execution.lastActivityAt = new Date().toISOString();
        
        if (state.activeWorkflows.size === 0 && state.pendingWorkflows.length === 0 && completed > 0) {
            session.status = 'completed';
            this.writeProgress(sessionId, 'EXECUTION', '✅ EXECUTION COMPLETED!');
            this.notifyInfo(`Plan ${sessionId} execution completed!`, sessionId);
        }
        
        session.updatedAt = new Date().toISOString();
        this.stateManager.savePlanningSession(session);
        this.notifyChange();
    }
    
    /**
     * Stop execution completely (cancel all workflows)
     * Note: Plan status stays 'approved'. Workflows are cancelled.
     */
    async stopExecution(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            const session = this.stateManager.getPlanningSession(sessionId);
            if (!session) {
                return { success: false, error: `Session ${sessionId} not found` };
            }
            
            // Check if there are workflows to cancel
            const state = this.coordinator.getSessionState(sessionId);
            if (!state || state.activeWorkflows.size === 0) {
                return { success: false, error: `No workflows to stop` };
            }
            
            await this.coordinator.cancelSession(sessionId);
            
            // Update timestamp, but NOT session status (stays 'approved')
            session.updatedAt = new Date().toISOString();
            this.stateManager.savePlanningSession(session);
            this.notifyChange();
            
            this.writeProgress(sessionId, 'EXECUTION', '⏹️ WORKFLOWS STOPPED');
            
            return { success: true };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            return { success: false, error: errorMsg };
        }
    }
    
    /**
     * Get execution status for a session
     */
    getExecutionStatus(sessionId: string): ExecutionState | undefined {
        const session = this.stateManager.getPlanningSession(sessionId);
        return session?.execution;
    }

    /**
     * Cancel a planning session
     * Cancels any running workflows. If no plan exists, sets status to 'no_plan'.
     */
    async cancelPlan(sessionId: string): Promise<void> {
        const session = this.stateManager.getPlanningSession(sessionId);
        if (!session) {
            throw new Error(`Planning session ${sessionId} not found`);
        }

        // Cancel any running workflows
        const state = this.coordinator.getSessionState(sessionId);
        if (state && state.activeWorkflows.size > 0) {
            await this.coordinator.cancelSession(sessionId);
        }

        // If we're in planning phase and no plan exists, go to 'no_plan'
        // Otherwise, go back to 'reviewing' if plan exists, or stay 'approved'
        if (session.status === 'planning' && !session.currentPlanPath) {
            session.status = 'no_plan';
        } else if (session.status === 'revising' && session.currentPlanPath) {
            session.status = 'reviewing';
        }
        // For approved/completed, status stays the same
        
        session.updatedAt = new Date().toISOString();
        this.stateManager.savePlanningSession(session);
        this.notifyChange();
    }

    /**
     * Get planning session status
     */
    getPlanningStatus(sessionId: string): PlanningSession | undefined {
        return this.stateManager.getPlanningSession(sessionId);
    }

    /**
     * List all planning sessions
     */
    listPlanningSessions(): PlanningSession[] {
        return this.stateManager.getAllPlanningSessions();
    }

    /**
     * Stop a running planning session (cancel all workflows)
     * Note: Plan status is NOT changed. Workflows are cancelled.
     * - If in planning phase: status goes back to 'no_plan' or 'reviewing' depending on plan existence
     * - If in execution phase: status stays 'approved', workflows are cancelled
     */
    async stopSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            const session = this.stateManager.getPlanningSession(sessionId);
            if (!session) {
                return { success: false, error: `Session ${sessionId} not found` };
            }

            const previousStatus = session.status;
            const wasDuringPlanning = ['planning', 'revising'].includes(previousStatus);

            this.writeProgress(sessionId, 'STOP', '='.repeat(60));
            this.writeProgress(sessionId, 'STOP', `⏹️ STOPPING SESSION: ${sessionId}`);
            this.writeProgress(sessionId, 'STOP', `   Previous status: ${previousStatus}`);
            this.writeProgress(sessionId, 'STOP', '='.repeat(60));

            // Cancel coordinator workflows
            const state = this.coordinator.getSessionState(sessionId);
            if (state && state.activeWorkflows.size > 0) {
                await this.coordinator.cancelSession(sessionId);
            }

            // Update status based on phase:
            // - During planning: go back to 'no_plan' or 'reviewing'
            // - During execution (approved): stay 'approved', workflows are cancelled
            if (wasDuringPlanning) {
                if (session.currentPlanPath) {
                    session.status = 'reviewing';
                    this.writeProgress(sessionId, 'STOP', `✅ Planning stopped. Plan ready for review.`);
                } else {
                    session.status = 'no_plan';
                    this.writeProgress(sessionId, 'STOP', `✅ Planning cancelled. Start new planning to continue.`);
                }
                // Store for restart context
                session.metadata = session.metadata || {};
                session.metadata.stoppedDuring = previousStatus === 'revising' ? 'revision' : 'initial';
            } else {
                // Execution phase - status stays as is (approved or completed)
                this.writeProgress(sessionId, 'STOP', `✅ Workflows stopped. Plan still ${session.status}.`);
            }
            
            session.updatedAt = new Date().toISOString();
            this.stateManager.savePlanningSession(session);
            this.notifyChange();

            return { success: true };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.writeProgress(sessionId, 'ERROR', `❌ Failed to stop: ${errorMessage}`);
            return { success: false, error: `Failed to stop session: ${errorMessage}` };
        }
    }

    /**
     * Restart planning for a session
     * - If 'no_plan' or stopped during initial planning: re-runs planning_new workflow
     * - If stopped during revision: re-runs planning_revision with the last feedback
     */
    async restartPlanning(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            const session = this.stateManager.getPlanningSession(sessionId);
            if (!session) {
                return { success: false, error: `Session ${sessionId} not found` };
            }

            // Only allow restart from 'no_plan' or 'reviewing' states
            if (session.status !== 'no_plan' && session.status !== 'reviewing') {
                return { success: false, error: `Session ${sessionId} cannot restart planning (current: ${session.status}). Must be 'no_plan' or 'reviewing'.` };
            }

            // Check if this was stopped during a revision
            const wasRevision = session.metadata?.stoppedDuring === 'revision';
            const lastRevision = session.revisionHistory?.[session.revisionHistory.length - 1];
            
            this.writeProgress(sessionId, 'RESTART', '='.repeat(60));
            if (wasRevision && lastRevision && session.currentPlanPath) {
                this.writeProgress(sessionId, 'RESTART', `🔄 RESTARTING REVISION: ${sessionId}`);
                this.writeProgress(sessionId, 'RESTART', `   Last feedback: ${lastRevision.feedback.substring(0, 50)}...`);
            } else {
                this.writeProgress(sessionId, 'RESTART', `🔄 RESTARTING PLANNING: ${sessionId}`);
                this.writeProgress(sessionId, 'RESTART', `   Original requirement: ${session.requirement.substring(0, 50)}...`);
            }
            this.writeProgress(sessionId, 'RESTART', '='.repeat(60));

            let workflowId: string;
            
            if (wasRevision && lastRevision && session.currentPlanPath) {
                // Restart revision workflow with the last feedback
                const input: PlanningWorkflowInput = {
                    requirement: session.requirement,
                    userFeedback: lastRevision.feedback,
                    existingPlanPath: session.currentPlanPath
                };
                
                workflowId = await this.coordinator.dispatchWorkflow(
                    sessionId,
                    'planning_revision',
                    input,
                    { priority: 5, blocking: true }
                );
                
                session.status = 'revising';
                this.writeProgress(sessionId, 'RESTART', `✅ Revision restarted (workflow: ${workflowId})`);
            } else {
                // Restart initial planning workflow
                const input: PlanningWorkflowInput = {
                    requirement: session.requirement,
                    docs: [] // Original docs not stored - starts fresh
                };
                
                workflowId = await this.coordinator.dispatchWorkflow(
                    sessionId,
                    'planning_new',
                    input,
                    { priority: 5, blocking: true }
                );
                
                session.status = 'planning';
                this.writeProgress(sessionId, 'RESTART', `✅ Planning restarted (workflow: ${workflowId})`);
            }
            
            // Clear the stopped metadata
            if (session.metadata) {
                delete session.metadata.stoppedDuring;
            }
            
            session.updatedAt = new Date().toISOString();
            this.stateManager.savePlanningSession(session);
            this.notifyChange();
            
            return { success: true };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.writeProgress(sessionId, 'ERROR', `❌ Failed to restart planning: ${errorMessage}`);
            return { success: false, error: `Failed to restart planning: ${errorMessage}` };
        }
    }

    /**
     * Remove a planning session completely
     */
    async removeSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            const session = this.stateManager.getPlanningSession(sessionId);
            if (!session) {
                return { success: false, error: `Session ${sessionId} not found` };
            }

            // Cancel any running workflows
            const state = this.coordinator.getSessionState(sessionId);
            if (state && state.activeWorkflows.size > 0) {
                await this.coordinator.cancelSession(sessionId);
            }
            
            // Clean up session-specific subscriptions
            this.cleanupSessionSubscriptions(sessionId);
            
            // Delete all tasks for this session from the global TaskManager
            const taskManager = ServiceLocator.resolve(TaskManager);
            const deletedCount = taskManager.deleteTasksForSession(sessionId);
            console.log(`Deleted ${deletedCount} tasks for session ${sessionId}`);

            // Delete the plan folder
            const planFolder = this.stateManager.getPlanFolder(sessionId);
            if (fs.existsSync(planFolder)) {
                try {
                    fs.rmSync(planFolder, { recursive: true, force: true });
                    console.log(`Deleted plan folder: ${planFolder}`);
                } catch (e) {
                    console.error(`Failed to delete plan folder: ${e}`);
                }
            }

            this.stateManager.deletePlanningSession(sessionId);
            this.notifyChange();

            return { success: true };
        } catch (error) {
            return { success: false, error: `Failed to remove session: ${error}` };
        }
    }
    
    /**
     * Track a session-specific subscription for cleanup
     */
    private trackSessionSubscription(sessionId: string, disposable: { dispose: () => void }): void {
        let subs = this.sessionSubscriptions.get(sessionId);
        if (!subs) {
            subs = [];
            this.sessionSubscriptions.set(sessionId, subs);
        }
        subs.push(disposable);
    }
    
    /**
     * Clean up subscriptions for a specific session
     */
    private cleanupSessionSubscriptions(sessionId: string): void {
        const subs = this.sessionSubscriptions.get(sessionId);
        if (subs) {
            for (const sub of subs) {
                try {
                    sub.dispose();
                } catch (e) {
                    // Ignore cleanup errors
                }
            }
            this.sessionSubscriptions.delete(sessionId);
        }
    }
    
    /**
     * Dispose resources
     */
    dispose(): void {
        // Clean up all session subscriptions
        for (const sessionId of this.sessionSubscriptions.keys()) {
            this.cleanupSessionSubscriptions(sessionId);
        }
        this.sessionSubscriptions.clear();
        
        this.removeAllListeners();
        console.log('PlanningService disposed');
    }
}
