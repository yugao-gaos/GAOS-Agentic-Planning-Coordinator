import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import { StateManager } from './StateManager';
import { PlanningSession, PlanStatus, ExecutionState } from '../types';
import { UnifiedCoordinatorService } from './UnifiedCoordinatorService';
import { OutputChannelManager } from './OutputChannelManager';
import { EventBroadcaster } from '../daemon/EventBroadcaster';
import { PlanningWorkflowInput } from '../types/workflow';
import { ServiceLocator } from './ServiceLocator';

/**
 * Configuration for PlanningService
 */
export interface PlanningServiceConfig {
    /** Unity best practices path (optional) */
    unityBestPracticesPath?: string;
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
     * Get the progress file path for a session
     */
    private getProgressFilePath(sessionId: string): string {
        return this.stateManager.getProgressLogPath(sessionId);
    }

    /**
     * Write progress update to both the progress file AND output channel
     */
    private writeProgress(sessionId: string, phase: string, message: string): void {
        const progressPath = this.getProgressFilePath(sessionId);
        const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
        const line = `[${timestamp}] [${phase}] ${message}`;
        
        this.outputManager.appendLine(line);
        
        const dir = path.dirname(progressPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        try {
            const fd = fs.openSync(progressPath, 'a');
            fs.writeSync(fd, line + '\n');
            fs.fsyncSync(fd);
            fs.closeSync(fd);
        } catch (e) {
            fs.appendFileSync(progressPath, line + '\n');
        }
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
     */
    async startPlanning(requirement: string, docs?: string[]): Promise<{
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
        
        // Build input and dispatch planning_new workflow
        const input: PlanningWorkflowInput = {
            requirement,
            docs: docs || []
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
                    // On success -> reviewing, on failure -> no_plan (planning failed)
                    updatedSession.status = event.result.success ? 'reviewing' : 'no_plan';
                    
                    if (event.result.success && event.result.output?.planPath) {
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
                    ['running', 'paused', 'blocked'].includes(w.status)
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
                        updatedSession.status = event.result.success ? 'reviewing' : previousStatus;
                        
                        if (event.result.success && event.result.output?.planPath) {
                            updatedSession.currentPlanPath = event.result.output.planPath;
                            updatedSession.planHistory.push({
                                version: newVersion,
                                path: event.result.output.planPath,
                                timestamp: new Date().toISOString()
                            });
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
            session.status = previousStatus || 'reviewing';
            session.updatedAt = new Date().toISOString();
            this.stateManager.savePlanningSession(session);
            this.notifyChange();

            this.notifyError(`Plan revision failed. Session reset to "${session.status}" status.`, sessionId);
            throw error;
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
        const tasksFound: Array<{ id: string; description: string; deps: string[] }> = [];

        // Check for checkbox format tasks
        const checkboxPattern = /^-\s*\[[ xX]\]\s*\*\*T(\d+)\*\*:\s*(.+?)(?:\s*\|\s*Deps?:\s*([^|]+))?(?:\s*\|\s*Engineer:\s*\w+)?$/gm;
        
        let match;
        while ((match = checkboxPattern.exec(planContent)) !== null) {
            const taskId = `T${match[1]}`;
            const description = match[2].trim();
            const depsStr = match[3]?.trim() || 'None';
            
            const deps: string[] = [];
            if (depsStr.toLowerCase() !== 'none' && depsStr !== '-') {
                const depMatches = depsStr.match(/T\d+/gi) || [];
                deps.push(...depMatches.map(d => d.toUpperCase()));
            }
            
            tasksFound.push({ id: taskId, description, deps });
        }

        if (tasksFound.length === 0) {
            issues.push('No tasks found in checkbox format. Expected format: - [ ] **T1**: Task description | Deps: None');
            
            const tablePattern = /\|\s*T\d+\s*\|/g;
            const tableMatches = planContent.match(tablePattern);
            if (tableMatches && tableMatches.length > 0) {
                issues.push(`Found ${tableMatches.length} tasks in TABLE format. Please convert to CHECKBOX format for tracking.`);
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

        this.writeProgress(sessionId, 'REVIEW', `Plan format review: ${tasksFound.length} tasks found`);
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
     */
    async approvePlan(sessionId: string, autoStart: boolean = true): Promise<void> {
        const session = this.stateManager.getPlanningSession(sessionId);
        if (!session) {
            throw new Error(`Planning session ${sessionId} not found`);
        }

        if (session.status !== 'reviewing') {
            throw new Error(`Plan is not ready for approval (status: ${session.status})`);
        }

        // Run format review before approval
        const reviewResult = await this.reviewPlanFormat(sessionId);
        if (!reviewResult.valid) {
            const errorMsg = `Plan format validation failed:\n${reviewResult.issues.join('\n')}`;
            this.notifyWarning(
                `Plan has format issues. Fix them before approval:\n${reviewResult.issues.slice(0, 3).join(', ')}${reviewResult.issues.length > 3 ? '...' : ''}`,
                sessionId
            );
            throw new Error(errorMsg);
        }

        session.status = 'approved';
        session.updatedAt = new Date().toISOString();
        this.stateManager.savePlanningSession(session);
        this.notifyChange();
        
        if (autoStart) {
            const result = await this.startExecution(sessionId);
            if (result.success) {
                this.notifyInfo(`Plan ${sessionId} approved and execution started with ${result.engineerCount} engineers!`, sessionId);
            } else {
                this.notifyWarning(`Plan ${sessionId} approved but execution failed to start: ${result.error}`, sessionId);
            }
        } else {
            this.notifyInfo(`Plan ${sessionId} approved and ready for execution`, sessionId);
        }
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
            const workflowIds = await this.coordinator.startExecution(sessionId);
            
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
            
            // Subscribe to workflow progress for UI updates
            this.coordinator.onWorkflowProgress((progress) => {
                if (progress.workflowId) {
                    this.updateSessionFromWorkflowProgress(sessionId);
                }
            });
            
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
     * Pause execution for a session
     * Note: Plan status stays 'approved'. Workflow pause state is tracked by workflows.
     */
    async pauseExecution(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            const session = this.stateManager.getPlanningSession(sessionId);
            if (!session) {
                return { success: false, error: `Session ${sessionId} not found` };
            }
            
            // Check if there are active workflows to pause
            const state = this.coordinator.getSessionState(sessionId);
            if (!state || state.activeWorkflows.size === 0) {
                return { success: false, error: `No active workflows to pause` };
            }
            
            await this.coordinator.pauseSession(sessionId);
            
            // Update execution timestamp, but NOT session status
            session.updatedAt = new Date().toISOString();
            if (session.execution) {
                session.execution.lastActivityAt = new Date().toISOString();
            }
            this.stateManager.savePlanningSession(session);
            this.notifyChange();
            
            this.writeProgress(sessionId, 'EXECUTION', '⏸️ WORKFLOWS PAUSED');
            
            return { success: true };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            return { success: false, error: errorMsg };
        }
    }
    
    /**
     * Resume paused workflows
     * Note: Plan status stays 'approved'. Workflow resume is handled by coordinator.
     */
    async resumeExecution(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            const session = this.stateManager.getPlanningSession(sessionId);
            if (!session) {
                return { success: false, error: `Session ${sessionId} not found` };
            }
            
            // Check if there are paused workflows to resume
            const hasPausedWorkflows = this.coordinator.hasPausedWorkflows(sessionId);
            if (!hasPausedWorkflows) {
                return { success: false, error: `No paused workflows to resume` };
            }
            
            await this.coordinator.resumeSession(sessionId);
            
            // Update execution timestamp, but NOT session status
            session.updatedAt = new Date().toISOString();
            if (session.execution) {
                session.execution.lastActivityAt = new Date().toISOString();
            }
            this.stateManager.savePlanningSession(session);
            this.notifyChange();
            
            this.writeProgress(sessionId, 'EXECUTION', '▶️ WORKFLOWS RESUMED');
            
            return { success: true };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            return { success: false, error: errorMsg };
        }
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
     * Pause a running session (pause all active workflows)
     */
    async pauseSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            const session = this.stateManager.getPlanningSession(sessionId);
            if (!session) {
                return { success: false, error: `Session ${sessionId} not found` };
            }

            // Delegate to pauseExecution which checks for active workflows
            return await this.pauseExecution(sessionId);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { success: false, error: `Failed to pause session: ${errorMessage}` };
        }
    }

    /**
     * Resume paused workflows
     * Note: Resumes paused workflows. For restarting execution, use startExecution.
     */
    async resumeSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            const session = this.stateManager.getPlanningSession(sessionId);
            if (!session) {
                return { success: false, error: `Session ${sessionId} not found` };
            }

            // Delegate to resumeExecution which checks for paused workflows
            return await this.resumeExecution(sessionId);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { success: false, error: `Failed to resume session: ${errorMessage}` };
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
     * Dispose resources
     */
    dispose(): void {
        this.removeAllListeners();
        console.log('PlanningService disposed');
    }
}
