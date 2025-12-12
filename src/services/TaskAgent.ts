// ============================================================================
// Task Agent
// ============================================================================
//
// AI agent that manages the task lifecycle:
// - Verifies parsed plan tasks against TaskManager state
// - Creates missing tasks from the plan (with --needs-context flag where appropriate)
// - Removes obsolete tasks (no longer in plan)
// - Updates changed tasks (description, dependencies)
// - Creates error_fix tasks from Unity errors
//
// The TaskAgent runs during plan approval (status: 'verifying') and loops
// until all tasks are synchronized, then transitions to 'approved'.

import * as fs from 'fs';
import * as path from 'path';
import { AgentRunner } from './AgentBackend';
import { OutputChannelManager } from './OutputChannelManager';
import { AgentRoleRegistry } from './AgentRoleRegistry';
import { ServiceLocator } from './ServiceLocator';
import { StateManager } from './StateManager';
import { TaskManager, ManagedTask } from './TaskManager';
import { PlanParser } from './PlanParser';
import { TypedEventEmitter } from './TypedEventEmitter';
import { DefaultSystemPrompts, SystemPromptConfig, ModelTier } from '../types';
import { Logger } from '../utils/Logger';

const log = Logger.create('Daemon', 'TaskAgent');

// ============================================================================
// Types
// ============================================================================

/**
 * Task Agent State
 */
export type TaskAgentState = 'idle' | 'verifying' | 'cooldown';

/**
 * Task Agent status for UI
 */
export interface TaskAgentStatus {
    state: TaskAgentState;
    sessionId?: string;
    evaluationCount: number;
    lastEvaluation?: string;
}

/**
 * Parsed task from plan with comparison info
 */
interface PlanTaskInfo {
    id: string;
    description: string;
    dependencies: string[];
    unityPipeline?: string;
}

/**
 * Comparison result between plan and TaskManager
 */
interface TaskComparison {
    missing: PlanTaskInfo[];      // In plan, not in TaskManager
    obsolete: ManagedTask[];      // In TaskManager, not in plan
    changed: Array<{              // In both, but different
        task: ManagedTask;
        planTask: PlanTaskInfo;
        changes: string[];
    }>;
    synced: ManagedTask[];        // Already in sync
}

/**
 * Input for TaskAgent evaluation
 */
export interface TaskAgentInput {
    sessionId: string;
    planPath: string;
    planTasks: PlanTaskInfo[];
    currentTasks: ManagedTask[];
    comparison: TaskComparison;
    reason?: string;
}

/**
 * Result from TaskAgent evaluation
 */
export interface TaskAgentResult {
    status: 'verifying' | 'verification_complete';
    actionsExecuted: string[];
    pending?: string;
}

/**
 * Configuration for TaskAgent
 */
export interface TaskAgentConfig {
    /** Model tier to use (low/mid/high) */
    model: ModelTier;
    evaluationTimeout: number;
    maxIterations: number;
    debug: boolean;
}

const DEFAULT_CONFIG: TaskAgentConfig = {
    model: 'mid',
    evaluationTimeout: 120000,  // 2 minutes
    maxIterations: 10,
    debug: false
};

// ============================================================================
// TaskAgent Service
// ============================================================================

/**
 * Task Agent - Manages task lifecycle during plan verification
 * 
 * This agent is triggered on plan approval and ensures TaskManager
 * accurately reflects the plan before execution begins.
 */
export class TaskAgent {
    private agentRunner: AgentRunner;
    private outputManager: OutputChannelManager;
    private config: TaskAgentConfig;
    private roleRegistry?: AgentRoleRegistry;
    private workspaceRoot: string = process.cwd();
    private evaluationCount: number = 0;
    
    // State tracking
    private currentState: TaskAgentState = 'idle';
    private currentSessionId?: string;
    private lastEvaluationTime?: string;
    private readonly _onStateChanged = new TypedEventEmitter<TaskAgentStatus>();
    readonly onStateChanged = this._onStateChanged.event;
    
    constructor(config: Partial<TaskAgentConfig> = {}, roleRegistry?: AgentRoleRegistry) {
        this.agentRunner = ServiceLocator.resolve(AgentRunner);
        this.outputManager = ServiceLocator.resolve(OutputChannelManager);
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.roleRegistry = roleRegistry;
    }
    
    /**
     * Set the role registry
     */
    setRoleRegistry(registry: AgentRoleRegistry): void {
        this.roleRegistry = registry;
    }
    
    /**
     * Set workspace root
     */
    setWorkspaceRoot(root: string): void {
        this.workspaceRoot = root;
    }
    
    // ========================================================================
    // State Tracking
    // ========================================================================
    
    getState(): TaskAgentState {
        return this.currentState;
    }
    
    getStatus(): TaskAgentStatus {
        return {
            state: this.currentState,
            sessionId: this.currentSessionId,
            evaluationCount: this.evaluationCount,
            lastEvaluation: this.lastEvaluationTime
        };
    }
    
    private setState(newState: TaskAgentState, sessionId?: string): void {
        if (this.currentState !== newState || this.currentSessionId !== sessionId) {
            this.currentState = newState;
            this.currentSessionId = sessionId;
            this._onStateChanged.fire(this.getStatus());
        }
    }
    
    private log(message: string): void {
        log.info(message);
        this.outputManager.log('TaskAgent', message);
    }
    
    // ========================================================================
    // Main Entry Points
    // ========================================================================
    
    /**
     * Verify and sync tasks for a session
     * 
     * This is the main entry point called on plan approval.
     * It loops until all tasks are synchronized or max iterations reached.
     * 
     * @param sessionId - Session to verify
     * @returns Final result with status
     */
    async verifyTasks(sessionId: string): Promise<TaskAgentResult> {
        this.log(`Starting task verification for session ${sessionId}`);
        this.setState('verifying', sessionId);
        
        try {
            const stateManager = ServiceLocator.resolve(StateManager);
            const taskManager = ServiceLocator.resolve(TaskManager);
            
            const session = stateManager.getPlanningSession(sessionId);
            if (!session?.currentPlanPath) {
                throw new Error(`Session ${sessionId} has no plan path`);
            }
            
            let iteration = 0;
            let lastResult: TaskAgentResult = {
                status: 'verifying',
                actionsExecuted: []
            };
            
            while (iteration < this.config.maxIterations) {
                iteration++;
                this.log(`Verification iteration ${iteration}/${this.config.maxIterations}`);
                
                // Build input context
                const input = this.buildInput(sessionId, session.currentPlanPath, taskManager);
                
                // Check if already synced
                if (this.isSynced(input.comparison)) {
                    this.log('All tasks synced - verification complete');
                    lastResult = {
                        status: 'verification_complete',
                        actionsExecuted: lastResult.actionsExecuted
                    };
                    break;
                }
                
                // Run AI evaluation
                const result = await this.evaluate(input);
                lastResult.actionsExecuted.push(...result.actionsExecuted);
                
                if (result.status === 'verification_complete') {
                    lastResult.status = 'verification_complete';
                    break;
                }
                
                // Small delay between iterations
                await new Promise(r => setTimeout(r, 1000));
            }
            
            if (lastResult.status !== 'verification_complete') {
                this.log(`Max iterations (${this.config.maxIterations}) reached - forcing complete`);
                lastResult.status = 'verification_complete';
            }
            
            this.lastEvaluationTime = new Date().toISOString();
            this.setState('idle');
            
            return lastResult;
            
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.log(`Verification failed: ${errorMsg}`);
            this.setState('idle');
            throw error;
        }
    }
    
    /**
     * Handle Unity errors by creating error_fix tasks
     * 
     * @param errors - Array of Unity errors
     * @returns IDs of created error_fix tasks
     */
    async handleUnityErrors(errors: Array<{
        id: string;
        message: string;
        file?: string;
        line?: number;
    }>): Promise<string[]> {
        this.log(`Handling ${errors.length} Unity errors`);
        
        const taskManager = ServiceLocator.resolve(TaskManager);
        const createdTaskIds: string[] = [];
        
        // Group errors by file for efficient task creation
        const errorsByFile = new Map<string, typeof errors>();
        for (const error of errors) {
            const file = error.file || 'unknown';
            if (!errorsByFile.has(file)) {
                errorsByFile.set(file, []);
            }
            errorsByFile.get(file)!.push(error);
        }
        
        // Find affected session (prioritize by file paths)
        const stateManager = ServiceLocator.resolve(StateManager);
        const approvedSessions = stateManager.getAllPlanningSessions()
            .filter(s => s.status === 'approved' || s.status === 'verifying');
        
        if (approvedSessions.length === 0) {
            this.log('No approved/verifying sessions - skipping error task creation');
            return [];
        }
        
        // Use first approved session (could be smarter about routing)
        const targetSession = approvedSessions[0];
        
        // Create error_fix task for each file with errors
        for (const [file, fileErrors] of errorsByFile) {
            const errorText = fileErrors.map(e => 
                `${e.file || 'unknown'}(${e.line || 0}): ${e.message}`
            ).join('\n');
            
            // Generate task ID
            const existingTasks = taskManager.getTasksForSession(targetSession.id);
            const errorTaskNum = existingTasks.filter(t => t.id.includes('_ERR')).length + 1;
            const taskId = `${targetSession.id.toUpperCase()}_ERR${errorTaskNum}`;
            
            const result = taskManager.createTaskFromCli({
                sessionId: targetSession.id,
                taskId,
                description: `Fix errors in ${path.basename(file)}`,
                taskType: 'error_fix',
                errorText,
                priority: 1  // High priority
            });
            
            if (result.success) {
                createdTaskIds.push(taskId);
                this.log(`Created error task ${taskId} for ${file}`);
            } else {
                this.log(`Failed to create error task: ${result.error}`);
            }
        }
        
        return createdTaskIds;
    }
    
    // ========================================================================
    // Input Building
    // ========================================================================
    
    private buildInput(sessionId: string, planPath: string, taskManager: TaskManager): TaskAgentInput {
        // Parse plan tasks
        const parsedPlan = PlanParser.parsePlanFile(planPath);
        const planTasks: PlanTaskInfo[] = (parsedPlan.tasks || []).map(t => ({
            id: t.id.toUpperCase(),
            description: t.description,
            dependencies: t.dependencies.map(d => d.toUpperCase())
            // Note: unityPipeline would need to be parsed from task line if needed
        }));
        
        // Get current tasks from TaskManager
        const currentTasks = taskManager.getTasksForSession(sessionId);
        
        // Build comparison
        const comparison = this.compareTaskStates(planTasks, currentTasks);
        
        return {
            sessionId,
            planPath,
            planTasks,
            currentTasks,
            comparison
        };
    }
    
    private compareTaskStates(planTasks: PlanTaskInfo[], currentTasks: ManagedTask[]): TaskComparison {
        const planTaskMap = new Map(planTasks.map(t => [t.id, t]));
        const currentTaskMap = new Map(currentTasks.map(t => [t.id, t]));
        
        const result: TaskComparison = {
            missing: [],
            obsolete: [],
            changed: [],
            synced: []
        };
        
        // Find missing tasks (in plan, not in TaskManager)
        for (const [id, planTask] of planTaskMap) {
            if (!currentTaskMap.has(id)) {
                result.missing.push(planTask);
            }
        }
        
        // Find obsolete and changed tasks
        for (const [id, currentTask] of currentTaskMap) {
            // Skip error tasks in obsolete check
            if (id.includes('_ERR')) {
                continue;
            }
            
            const planTask = planTaskMap.get(id);
            if (!planTask) {
                // Only mark as obsolete if not succeeded
                if (currentTask.status !== 'succeeded') {
                    result.obsolete.push(currentTask);
                }
            } else {
                // Check for changes
                const changes: string[] = [];
                
                if (currentTask.description !== planTask.description) {
                    changes.push('description');
                }
                
                const currentDeps = new Set(currentTask.dependencies);
                const planDeps = new Set(planTask.dependencies);
                if (currentDeps.size !== planDeps.size || 
                    ![...currentDeps].every(d => planDeps.has(d))) {
                    changes.push('dependencies');
                }
                
                if (changes.length > 0) {
                    result.changed.push({ task: currentTask, planTask, changes });
                } else {
                    result.synced.push(currentTask);
                }
            }
        }
        
        return result;
    }
    
    private isSynced(comparison: TaskComparison): boolean {
        return comparison.missing.length === 0 &&
               comparison.obsolete.length === 0 &&
               comparison.changed.length === 0;
    }
    
    // ========================================================================
    // AI Evaluation
    // ========================================================================
    
    private async evaluate(input: TaskAgentInput): Promise<TaskAgentResult> {
        this.evaluationCount++;
        const evalId = `task_agent_${this.evaluationCount}_${Date.now()}`;
        
        this.log(`Starting evaluation #${this.evaluationCount}`);
        
        // Check if cursor CLI is available
        const isAvailable = await this.agentRunner.isAvailable();
        if (!isAvailable) {
            throw new Error('Cursor CLI not available');
        }
        
        // Build prompt
        const prompt = this.buildPrompt(input);
        
        // Set up log file
        const stateManager = ServiceLocator.resolve(StateManager);
        const logDir = path.join(stateManager.getSessionTasksFolder(input.sessionId), 'task_agent_logs');
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const logFile = path.join(logDir, `${timestamp}_${evalId}_stream.log`);
        
        // Run AI
        const result = await this.agentRunner.run({
            id: evalId,
            prompt,
            cwd: this.workspaceRoot,
            model: this.config.model as ModelTier,
            timeoutMs: this.config.evaluationTimeout,
            logFile,
            simpleMode: true,
            onProgress: (msg) => this.log(`[eval] ${msg}`)
        });
        
        if (!result.success) {
            throw new Error(`TaskAgent evaluation failed: ${result.error}`);
        }
        
        // Parse response
        return this.parseResult(result.output);
    }
    
    private buildPrompt(input: TaskAgentInput): string {
        // Get prompt config
        const defaultConfig = DefaultSystemPrompts['task_agent'];
        const promptConfig = this.roleRegistry?.getSystemPrompt('task_agent') || 
            new SystemPromptConfig(defaultConfig);
        
        // Build dynamic sections
        const planTasksSection = this.formatPlanTasks(input.planTasks);
        const currentTasksSection = this.formatCurrentTasks(input.currentTasks);
        const analysisSection = this.formatAnalysis(input.comparison);
        
        return `${promptConfig.roleIntro}

═══════════════════════════════════════════════════════════════════════════════
SESSION
═══════════════════════════════════════════════════════════════════════════════

Session: ${input.sessionId}
Plan: ${input.planPath}
${input.reason ? `Reason: ${input.reason}` : ''}

═══════════════════════════════════════════════════════════════════════════════
PLAN TASKS (parsed from plan file)
═══════════════════════════════════════════════════════════════════════════════

${planTasksSection}

═══════════════════════════════════════════════════════════════════════════════
CURRENT TASKS (from TaskManager)
═══════════════════════════════════════════════════════════════════════════════

${currentTasksSection}

═══════════════════════════════════════════════════════════════════════════════
ANALYSIS
═══════════════════════════════════════════════════════════════════════════════

${analysisSection}

═══════════════════════════════════════════════════════════════════════════════
YOUR DECISION
═══════════════════════════════════════════════════════════════════════════════

${promptConfig.decisionInstructions}`;
    }
    
    private formatPlanTasks(tasks: PlanTaskInfo[]): string {
        if (tasks.length === 0) {
            return 'No tasks found in plan.';
        }
        
        return tasks.map(t => {
            const deps = t.dependencies.length > 0 ? t.dependencies.join(', ') : 'None';
            const unity = t.unityPipeline || 'none';
            return `- ${t.id}: ${t.description} | Deps: ${deps} | Unity: ${unity}`;
        }).join('\n');
    }
    
    private formatCurrentTasks(tasks: ManagedTask[]): string {
        if (tasks.length === 0) {
            return 'No tasks in TaskManager.';
        }
        
        return tasks.map(t => {
            const deps = t.dependencies.length > 0 ? t.dependencies.join(', ') : 'None';
            const depsStatus = t.dependencies.every(d => {
                // Check if dependency is complete
                return tasks.find(dt => dt.id === d)?.status === 'succeeded';
            }) ? 'complete' : 'incomplete';
            return `- ${t.id}: ${t.status} | ${t.description.substring(0, 50)}... | Deps: ${deps} (${depsStatus})`;
        }).join('\n');
    }
    
    private formatAnalysis(comparison: TaskComparison): string {
        const lines: string[] = [];
        
        if (comparison.missing.length > 0) {
            lines.push(`Missing from TaskManager (need to create): ${comparison.missing.map(t => t.id).join(', ')}`);
        }
        
        if (comparison.obsolete.length > 0) {
            lines.push(`Obsolete (not in plan, consider removing): ${comparison.obsolete.map(t => t.id).join(', ')}`);
        }
        
        if (comparison.changed.length > 0) {
            for (const { task, changes } of comparison.changed) {
                lines.push(`Changed: ${task.id} (${changes.join(', ')})`);
            }
        }
        
        if (lines.length === 0) {
            lines.push('✅ All tasks are synced!');
        }
        
        return lines.join('\n');
    }
    
    private parseResult(output: string): TaskAgentResult {
        const result: TaskAgentResult = {
            status: 'verifying',
            actionsExecuted: []
        };
        
        // Extract STATUS
        const statusMatch = output.match(/STATUS:\s*(VERIFYING|VERIFICATION_COMPLETE)/i);
        if (statusMatch) {
            result.status = statusMatch[1].toLowerCase() === 'verification_complete' 
                ? 'verification_complete' 
                : 'verifying';
        }
        
        // Extract ACTIONS
        const actionsMatch = output.match(/ACTIONS:\s*(.+?)(?=PENDING:|STATUS:|$)/is);
        if (actionsMatch) {
            const actionsText = actionsMatch[1].trim();
            // Parse command-like lines
            const commands = actionsText.split('\n')
                .map(l => l.trim())
                .filter(l => l.startsWith('apc ') || l.includes('task'));
            result.actionsExecuted = commands;
        }
        
        // Extract PENDING
        const pendingMatch = output.match(/PENDING:\s*(.+?)(?=STATUS:|$)/is);
        if (pendingMatch) {
            result.pending = pendingMatch[1].trim();
        }
        
        return result;
    }
}

