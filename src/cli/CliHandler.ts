import * as vscode from 'vscode';
import { StateManager } from '../services/StateManager';
import { EngineerPoolService } from '../services/EngineerPoolService';
import { CoordinatorService } from '../services/CoordinatorService';
import { PlanningService } from '../services/PlanningService';
import { TerminalManager } from '../services/TerminalManager';
import { UnityControlManager } from '../services/UnityControlManager';
import { CliResponse, StatusResponse, PoolStatusResponse } from '../types';
import { UnityTaskType, TaskRequester, PipelineOperation, PipelineTaskContext } from '../types/unity';

/**
 * CLI Handler for AI Agent interaction
 * 
 * This class handles CLI commands that AI agents can invoke.
 * Commands are registered as VS Code commands and can be called via:
 * - VS Code command palette
 * - Terminal: `cursor --command agenticPlanning.cli --args '{"command": "status"}'`
 * - AI agent tools
 */
export class CliHandler {
    private stateManager: StateManager;
    private engineerPoolService: EngineerPoolService;
    private coordinatorService: CoordinatorService;
    private planningService: PlanningService;
    private terminalManager: TerminalManager;

    constructor(
        stateManager: StateManager,
        engineerPoolService: EngineerPoolService,
        coordinatorService: CoordinatorService,
        planningService: PlanningService,
        terminalManager: TerminalManager
    ) {
        this.stateManager = stateManager;
        this.engineerPoolService = engineerPoolService;
        this.coordinatorService = coordinatorService;
        this.planningService = planningService;
        this.terminalManager = terminalManager;
    }

    /**
     * Main CLI entry point
     * Parses command and routes to appropriate handler
     */
    async handleCommand(args: string[]): Promise<CliResponse> {
        if (args.length === 0) {
            return this.showHelp();
        }

        const command = args[0];
        const subArgs = args.slice(1);

        switch (command) {
            case 'status':
                return this.handleStatus();
            
            case 'plan':
                return this.handlePlan(subArgs);
            
            case 'exec':
            case 'execute':
                return this.handleExecution(subArgs);
            
            case 'coordinator':
                return this.handleCoordinator(subArgs);
            
            case 'pool':
                return this.handlePool(subArgs);
            
            case 'task':
                return this.handleTask(subArgs);
            
            case 'engineer':
                return this.handleEngineer(subArgs);
            
            case 'unity':
                return this.handleUnity(subArgs);
            
            case 'help':
                return this.showHelp();
            
            default:
                return {
                    success: false,
                    error: `Unknown command: ${command}. Use 'agentic help' for available commands.`
                };
        }
    }

    // ========================================================================
    // Status Command
    // ========================================================================

    private async handleStatus(): Promise<StatusResponse> {
        const sessions = this.stateManager.getAllPlanningSessions();
        const coordinators = this.stateManager.getAllCoordinators();
        const poolStatus = this.engineerPoolService.getPoolStatus();

        const activeSessions = sessions.filter(s => 
            ['debating', 'reviewing', 'revising'].includes(s.status)
        ).length;

        const activeCoordinators = coordinators.filter(c => 
            ['initializing', 'running', 'paused'].includes(c.status)
        ).length;

        return {
            success: true,
            data: {
                activePlanningSessions: activeSessions,
                activeCoordinators: activeCoordinators,
                engineerPool: {
                    total: poolStatus.total,
                    available: poolStatus.available.length,
                    busy: poolStatus.busy.length
                }
            }
        };
    }

    // ========================================================================
    // Plan Commands
    // ========================================================================

    private async handlePlan(args: string[]): Promise<CliResponse> {
        if (args.length === 0) {
            return { success: false, error: 'Missing plan subcommand. Use: list, start, status, revise, approve' };
        }

        const subCommand = args[0];
        const params = this.parseArgs(args.slice(1));

        switch (subCommand) {
            case 'list':
                return this.planList();
            
            case 'start':
                return this.planStart(params);
            
            case 'status':
                return this.planStatus(params);
            
            case 'revise':
                return this.planRevise(params);
            
            case 'approve':
                return this.planApprove(params);
            
            case 'cancel':
                return this.planCancel(params);
            
            default:
                return { success: false, error: `Unknown plan subcommand: ${subCommand}` };
        }
    }

    private async planList(): Promise<CliResponse> {
        const sessions = this.planningService.listPlanningSessions();
        return {
            success: true,
            data: sessions.map(s => ({
                id: s.id,
                status: s.status,
                requirement: s.requirement.substring(0, 50) + (s.requirement.length > 50 ? '...' : ''),
                currentPlan: s.currentPlanPath,
                version: s.planHistory.length
            }))
        };
    }

    private async planStart(params: Record<string, string>): Promise<CliResponse> {
        const prompt = params['prompt'];
        if (!prompt) {
            return { success: false, error: 'Missing --prompt parameter' };
        }

        // Parse docs parameter (comma-separated or space-separated paths)
        const docsParam = params['docs'];
        const docs = docsParam ? docsParam.split(/[,\s]+/).filter(d => d.length > 0) : [];

        const result = await this.planningService.startPlanning(prompt, docs);
        return {
            success: true,
            message: `Planning session ${result.sessionId} completed - ${result.status}`,
            data: {
                sessionId: result.sessionId,
                status: result.status,
                planPath: result.planPath,
                recommendedEngineers: result.recommendedEngineers,
                debateSummary: result.debateSummary
            }
        };
    }

    private async planStatus(params: Record<string, string>): Promise<CliResponse> {
        const id = params['id'];
        if (!id) {
            return { success: false, error: 'Missing --id parameter' };
        }

        const session = this.planningService.getPlanningStatus(id);
        if (!session) {
            return { success: false, error: `Planning session ${id} not found` };
        }

        return {
            success: true,
            data: session
        };
    }

    private async planRevise(params: Record<string, string>): Promise<CliResponse> {
        const id = params['id'];
        const feedback = params['feedback'];
        
        if (!id) {
            return { success: false, error: 'Missing --id parameter' };
        }
        if (!feedback) {
            return { success: false, error: 'Missing --feedback parameter' };
        }

        const result = await this.planningService.revisePlan(id, feedback);
        return {
            success: true,
            message: `Plan revision started`,
            data: result
        };
    }

    private async planApprove(params: Record<string, string>): Promise<CliResponse> {
        const id = params['id'];
        if (!id) {
            return { success: false, error: 'Missing --id parameter' };
        }

        await this.planningService.approvePlan(id);
        return {
            success: true,
            message: `Plan ${id} approved`
        };
    }

    private async planCancel(params: Record<string, string>): Promise<CliResponse> {
        const id = params['id'];
        if (!id) {
            return { success: false, error: 'Missing --id parameter' };
        }

        await this.planningService.cancelPlan(id);
        return {
            success: true,
            message: `Plan ${id} cancelled`
        };
    }

    // ========================================================================
    // Execution Commands (Higher-level than coordinator commands)
    // ========================================================================

    private async handleExecution(args: string[]): Promise<CliResponse> {
        if (args.length === 0) {
            return { success: false, error: 'Missing exec subcommand. Use: start, pause, resume, stop, status' };
        }

        const subCommand = args[0];
        const params = this.parseArgs(args.slice(1));

        switch (subCommand) {
            case 'start':
                return this.execStart(params);
            
            case 'pause':
                return this.execPause(params);
            
            case 'resume':
                return this.execResume(params);
            
            case 'stop':
                return this.execStop(params);
            
            case 'status':
                return this.execStatus(params);
            
            default:
                return { success: false, error: `Unknown exec subcommand: ${subCommand}` };
        }
    }

    private async execStart(params: Record<string, string>): Promise<CliResponse> {
        const sessionId = params['session'] || params['id'];
        if (!sessionId) {
            return { success: false, error: 'Missing --session or --id parameter (e.g., ps_001)' };
        }

        const mode = params['mode'] as 'auto' | 'interactive' || 'auto';
        const engineerCount = params['engineers'] ? parseInt(params['engineers']) : undefined;

        const result = await this.planningService.startExecution(sessionId, {
            mode,
            engineerCount
        });

        if (!result.success) {
            return { success: false, error: result.error };
        }

        return {
            success: true,
            message: `Execution started for ${sessionId} with ${result.engineerCount} engineers`,
            data: result
        };
    }

    private async execPause(params: Record<string, string>): Promise<CliResponse> {
        const sessionId = params['session'] || params['id'];
        if (!sessionId) {
            return { success: false, error: 'Missing --session or --id parameter' };
        }

        const result = await this.planningService.pauseExecution(sessionId);
        if (!result.success) {
            return { success: false, error: result.error };
        }

        return {
            success: true,
            message: `Execution paused for ${sessionId}`
        };
    }

    private async execResume(params: Record<string, string>): Promise<CliResponse> {
        const sessionId = params['session'] || params['id'];
        if (!sessionId) {
            return { success: false, error: 'Missing --session or --id parameter' };
        }

        const result = await this.planningService.resumeExecution(sessionId);
        if (!result.success) {
            return { success: false, error: result.error };
        }

        return {
            success: true,
            message: `Execution resumed for ${sessionId}`
        };
    }

    private async execStop(params: Record<string, string>): Promise<CliResponse> {
        const sessionId = params['session'] || params['id'];
        if (!sessionId) {
            return { success: false, error: 'Missing --session or --id parameter' };
        }

        const result = await this.planningService.stopExecution(sessionId);
        if (!result.success) {
            return { success: false, error: result.error };
        }

        return {
            success: true,
            message: `Execution stopped for ${sessionId}`
        };
    }

    private async execStatus(params: Record<string, string>): Promise<CliResponse> {
        const sessionId = params['session'] || params['id'];
        if (!sessionId) {
            return { success: false, error: 'Missing --session or --id parameter' };
        }

        const session = this.planningService.getPlanningStatus(sessionId);
        if (!session) {
            return { success: false, error: `Planning session ${sessionId} not found` };
        }

        return {
            success: true,
            data: {
                sessionId: session.id,
                status: session.status,
                execution: session.execution,
                progress: session.execution?.progress
            }
        };
    }

    // ========================================================================
    // Coordinator Commands
    // ========================================================================

    private async handleCoordinator(args: string[]): Promise<CliResponse> {
        if (args.length === 0) {
            return { success: false, error: 'Missing coordinator subcommand. Use: list, start, status, pause, resume, stop' };
        }

        const subCommand = args[0];
        const params = this.parseArgs(args.slice(1));

        switch (subCommand) {
            case 'list':
                return this.coordinatorList();
            
            case 'start':
                return this.coordinatorStart(params);
            
            case 'status':
                return this.coordinatorStatus(params);
            
            case 'pause':
                return this.coordinatorPause(params);
            
            case 'resume':
                return this.coordinatorResume(params);
            
            case 'stop':
                return this.coordinatorStop(params);
            
            default:
                return { success: false, error: `Unknown coordinator subcommand: ${subCommand}` };
        }
    }

    private async coordinatorList(): Promise<CliResponse> {
        const coordinators = this.stateManager.getAllCoordinators();
        return {
            success: true,
            data: coordinators.map(c => ({
                id: c.id,
                status: c.status,
                plan: c.planPath,
                engineers: Object.keys(c.engineerSessions).length,
                progress: c.progress
            }))
        };
    }

    private async coordinatorStart(params: Record<string, string>): Promise<CliResponse> {
        const planPath = params['plan'];
        const planSessionId = params['plan-session'];
        const mode = params['mode'] as 'auto' | 'interactive' || 'auto';
        const engineerCount = params['engineers'] ? parseInt(params['engineers']) : undefined;

        if (!planPath && !planSessionId) {
            return { success: false, error: 'Missing --plan or --plan-session parameter' };
        }

        let resolvedPlanPath = planPath;
        if (planSessionId && !planPath) {
            const session = this.stateManager.getPlanningSession(planSessionId);
            if (!session || !session.currentPlanPath) {
                return { success: false, error: `Planning session ${planSessionId} not found or has no plan` };
            }
            resolvedPlanPath = session.currentPlanPath;
        }

        const result = await this.coordinatorService.startCoordinator(resolvedPlanPath!, {
            mode,
            engineerCount,
            planSessionId
        });

        return {
            success: true,
            message: `Coordinator ${result.coordinatorId} started`,
            data: result
        };
    }

    private async coordinatorStatus(params: Record<string, string>): Promise<CliResponse> {
        const id = params['id'];
        if (!id) {
            return { success: false, error: 'Missing --id parameter' };
        }

        const coordinator = this.coordinatorService.getCoordinatorStatus(id);
        if (!coordinator) {
            return { success: false, error: `Coordinator ${id} not found` };
        }

        return {
            success: true,
            data: coordinator
        };
    }

    private async coordinatorPause(params: Record<string, string>): Promise<CliResponse> {
        const id = params['id'];
        if (!id) {
            return { success: false, error: 'Missing --id parameter' };
        }

        await this.coordinatorService.pauseCoordinator(id);
        return {
            success: true,
            message: `Coordinator ${id} paused`
        };
    }

    private async coordinatorResume(params: Record<string, string>): Promise<CliResponse> {
        const id = params['id'];
        if (!id) {
            return { success: false, error: 'Missing --id parameter' };
        }

        await this.coordinatorService.resumeCoordinator(id);
        return {
            success: true,
            message: `Coordinator ${id} resumed`
        };
    }

    private async coordinatorStop(params: Record<string, string>): Promise<CliResponse> {
        const id = params['id'];
        if (!id) {
            return { success: false, error: 'Missing --id parameter' };
        }

        await this.coordinatorService.stopCoordinator(id);
        return {
            success: true,
            message: `Coordinator ${id} stopped`
        };
    }

    // ========================================================================
    // Pool Commands
    // ========================================================================

    private async handlePool(args: string[]): Promise<CliResponse> {
        if (args.length === 0 || args[0] === 'status') {
            return this.poolStatus();
        }

        const subCommand = args[0];
        const params = this.parseArgs(args.slice(1));

        switch (subCommand) {
            case 'resize':
                return this.poolResize(params);
            
            default:
                return { success: false, error: `Unknown pool subcommand: ${subCommand}` };
        }
    }

    private async poolStatus(): Promise<PoolStatusResponse> {
        const status = this.engineerPoolService.getPoolStatus();
        const busyEngineers = this.engineerPoolService.getBusyEngineers();

        return {
            success: true,
            data: {
                total: status.total,
                available: status.available,
                busy: busyEngineers
            }
        };
    }

    private async poolResize(params: Record<string, string>): Promise<CliResponse> {
        const size = params['size'];
        if (!size) {
            return { success: false, error: 'Missing --size parameter' };
        }

        const newSize = parseInt(size);
        if (isNaN(newSize) || newSize < 1 || newSize > 20) {
            return { success: false, error: 'Size must be between 1 and 20' };
        }

        const result = this.engineerPoolService.resizePool(newSize);
        return {
            success: true,
            message: `Pool resized to ${newSize}`,
            data: result
        };
    }

    // ========================================================================
    // Task Commands - For Coordinator to interact with TaskManager
    // ========================================================================

    private async handleTask(args: string[]): Promise<CliResponse> {
        if (args.length === 0) {
            return { success: false, error: 'Missing task subcommand. Use: create, start, complete, fail, reset, list, ready, progress, status, defer, undefer' };
        }

        const subCommand = args[0];
        const subArgs = args.slice(1);

        switch (subCommand) {
            case 'create':
                return this.taskCreate(subArgs);
            
            case 'start':
                return this.taskStart(subArgs);
            
            case 'complete':
                return this.taskComplete(subArgs);
            
            case 'fail':
                return this.taskFail(subArgs);
            
            case 'reset':
                return this.taskReset(subArgs);
            
            case 'list':
                return this.taskList(subArgs);
            
            case 'ready':
                return this.taskReady(subArgs);
            
            case 'progress':
                return this.taskProgress(subArgs);
            
            case 'assign':
                return this.taskAssign(subArgs);
            
            case 'status':
                return this.taskSetStatus(subArgs);
            
            case 'defer':
                return this.taskDefer(subArgs);
            
            case 'undefer':
                return this.taskUndefer(subArgs);
            
            default:
                return { success: false, error: `Unknown task subcommand: ${subCommand}` };
        }
    }

    /**
     * Create a task in TaskManager
     * Usage: apc task create <coordinator_id> "<description>" --id T1 --deps T2 T3 --engineer Alex
     */
    private async taskCreate(args: string[]): Promise<CliResponse> {
        if (args.length < 2) {
            return { success: false, error: 'Usage: apc task create <coordinator_id> "<description>" --id T1 [--deps T2 T3] [--engineer Alex]' };
        }

        const coordinatorId = args[0];
        const description = args[1];
        const params = this.parseArgsWithMultiValue(args.slice(2));

        const taskId = params['id'];
        if (!taskId) {
            return { success: false, error: 'Missing --id parameter' };
        }

        const dependencies = params['deps'] ? params['deps'].split(',').map(d => d.trim()) : [];
        const engineer = params['engineer'];

        const result = await this.coordinatorService.createTask(coordinatorId, {
            id: taskId,
            description,
            dependencies,
            engineer
        });

        if (!result.success) {
            return { success: false, error: result.error };
        }

        return {
            success: true,
            message: `Task ${taskId} created`,
            data: { taskId, description, dependencies, engineer }
        };
    }

    /**
     * Start a task (assign to engineer and mark in_progress)
     * Usage: apc task start <coordinator_id> <task_id> --engineer Alex
     */
    private async taskStart(args: string[]): Promise<CliResponse> {
        if (args.length < 2) {
            return { success: false, error: 'Usage: apc task start <coordinator_id> <task_id> --engineer Alex' };
        }

        const coordinatorId = args[0];
        const taskId = args[1];
        const params = this.parseArgs(args.slice(2));
        const engineer = params['engineer'];

        if (!engineer) {
            return { success: false, error: 'Missing --engineer parameter' };
        }

        const result = await this.coordinatorService.startTask(coordinatorId, taskId, engineer);

        if (!result.success) {
            return { success: false, error: result.error };
        }

        return {
            success: true,
            message: `Task ${taskId} started by ${engineer}`,
            data: { taskId, engineer }
        };
    }

    /**
     * Complete a task
     * Usage: apc task complete <coordinator_id> <task_id> [--files "path1.cs" "path2.cs"]
     */
    private async taskComplete(args: string[]): Promise<CliResponse> {
        if (args.length < 2) {
            return { success: false, error: 'Usage: apc task complete <coordinator_id> <task_id> [--files "path1.cs,path2.cs"]' };
        }

        const coordinatorId = args[0];
        const taskId = args[1];
        const params = this.parseArgsWithMultiValue(args.slice(2));
        const files = params['files'] ? params['files'].split(',').map(f => f.trim()) : [];

        const result = await this.coordinatorService.completeTask(coordinatorId, taskId, files);

        if (!result.success) {
            return { success: false, error: result.error };
        }

        return {
            success: true,
            message: `Task ${taskId} completed`,
            data: { taskId, filesModified: files }
        };
    }

    /**
     * Fail a task
     * Usage: apc task fail <coordinator_id> <task_id> --reason "error message"
     */
    private async taskFail(args: string[]): Promise<CliResponse> {
        if (args.length < 2) {
            return { success: false, error: 'Usage: apc task fail <coordinator_id> <task_id> --reason "error message"' };
        }

        const coordinatorId = args[0];
        const taskId = args[1];
        const params = this.parseArgs(args.slice(2));
        const reason = params['reason'] || 'Unknown error';

        const result = await this.coordinatorService.failTask(coordinatorId, taskId, reason);

        if (!result.success) {
            return { success: false, error: result.error };
        }

        return {
            success: true,
            message: `Task ${taskId} marked as failed`,
            data: { taskId, reason }
        };
    }

    /**
     * Reset a task to ready state (for retry)
     * Usage: apc task reset <coordinator_id> <task_id>
     */
    private async taskReset(args: string[]): Promise<CliResponse> {
        if (args.length < 2) {
            return { success: false, error: 'Usage: apc task reset <coordinator_id> <task_id>' };
        }

        const coordinatorId = args[0];
        const taskId = args[1];

        const result = await this.coordinatorService.resetTask(coordinatorId, taskId);

        if (!result.success) {
            return { success: false, error: result.error };
        }

        return {
            success: true,
            message: `Task ${taskId} reset to ready`,
            data: { taskId }
        };
    }

    /**
     * List all tasks
     * Usage: apc task list <coordinator_id> [--status ready|pending|completed|in_progress]
     */
    private async taskList(args: string[]): Promise<CliResponse> {
        if (args.length < 1) {
            return { success: false, error: 'Usage: apc task list <coordinator_id> [--status ready|pending|completed]' };
        }

        const coordinatorId = args[0];
        const params = this.parseArgs(args.slice(1));
        const statusFilter = params['status'];

        const result = await this.coordinatorService.listTasks(coordinatorId, statusFilter);

        if (!result.success) {
            return { success: false, error: result.error };
        }

        return {
            success: true,
            data: result.tasks
        };
    }

    /**
     * Get ready tasks (dependencies satisfied)
     * Usage: apc task ready <coordinator_id>
     */
    private async taskReady(args: string[]): Promise<CliResponse> {
        if (args.length < 1) {
            return { success: false, error: 'Usage: apc task ready <coordinator_id>' };
        }

        const coordinatorId = args[0];

        const result = await this.coordinatorService.getReadyTasks(coordinatorId);

        if (!result.success) {
            return { success: false, error: result.error };
        }

        return {
            success: true,
            data: result.tasks,
            message: `${result.tasks?.length || 0} ready tasks`
        };
    }

    /**
     * Get task progress
     * Usage: apc task progress <coordinator_id>
     */
    private async taskProgress(args: string[]): Promise<CliResponse> {
        if (args.length < 1) {
            return { success: false, error: 'Usage: apc task progress <coordinator_id>' };
        }

        const coordinatorId = args[0];

        const result = await this.coordinatorService.getTaskProgress(coordinatorId);

        if (!result.success) {
            return { success: false, error: result.error };
        }

        return {
            success: true,
            data: result.progress
        };
    }

    /**
     * Assign task to engineer (without starting)
     * Usage: apc task assign <coordinator_id> <task_id> --engineer Betty
     */
    private async taskAssign(args: string[]): Promise<CliResponse> {
        if (args.length < 2) {
            return { success: false, error: 'Usage: apc task assign <coordinator_id> <task_id> --engineer Betty' };
        }

        const coordinatorId = args[0];
        const taskId = args[1];
        const params = this.parseArgs(args.slice(2));
        const engineer = params['engineer'];

        if (!engineer) {
            return { success: false, error: 'Missing --engineer parameter' };
        }

        const result = await this.coordinatorService.assignTask(coordinatorId, taskId, engineer);

        if (!result.success) {
            return { success: false, error: result.error };
        }

        return {
            success: true,
            message: `Task ${taskId} assigned to ${engineer}`,
            data: { taskId, engineer }
        };
    }

    /**
     * Set task status/stage directly
     * Usage: apc task status <coordinator_id> <task_id> <stage> [--reason "why"]
     * 
     * Valid stages: test_passed, test_failed, compile_failed, completed, failed, etc.
     * 
     * Used by coordinator after pipeline results to update task status.
     */
    private async taskSetStatus(args: string[]): Promise<CliResponse> {
        if (args.length < 3) {
            return { success: false, error: 'Usage: apc task status <coordinator_id> <task_id> <stage> [--reason "why"]' };
        }

        const coordinatorId = args[0];
        const taskId = args[1];
        const stage = args[2];
        const params = this.parseArgs(args.slice(3));
        const reason = params['reason'];

        const result = await this.coordinatorService.updateTaskStage(coordinatorId, taskId, stage, reason);

        if (!result.success) {
            return { success: false, error: result.error };
        }

        return {
            success: true,
            message: `Task ${taskId} status set to ${stage}`,
            data: { taskId, stage, reason }
        };
    }

    /**
     * Defer a task (due to overlap with ongoing work)
     * Usage: apc task defer <coordinator_id> <task_id> --reason "Waiting for T7"
     * 
     * Used when an error's fix would conflict with ongoing work.
     * The task will be un-deferred when the blocking work completes.
     */
    private async taskDefer(args: string[]): Promise<CliResponse> {
        if (args.length < 2) {
            return { success: false, error: 'Usage: apc task defer <coordinator_id> <task_id> --reason "why" [--blocked-by <task_id>]' };
        }

        const coordinatorId = args[0];
        const taskId = args[1];
        const params = this.parseArgs(args.slice(2));
        const reason = params['reason'] || 'Overlap with ongoing work';
        const blockedBy = params['blocked-by'];

        const result = await this.coordinatorService.deferTask(coordinatorId, taskId, reason, blockedBy);

        if (!result.success) {
            return { success: false, error: result.error };
        }

        return {
            success: true,
            message: `Task ${taskId} deferred: ${reason}`,
            data: { taskId, reason, blockedBy }
        };
    }

    /**
     * Un-defer a task (blocker completed)
     * Usage: apc task undefer <coordinator_id> <task_id>
     * 
     * Called when a blocking task completes and the deferred task can proceed.
     */
    private async taskUndefer(args: string[]): Promise<CliResponse> {
        if (args.length < 2) {
            return { success: false, error: 'Usage: apc task undefer <coordinator_id> <task_id>' };
        }

        const coordinatorId = args[0];
        const taskId = args[1];

        const result = await this.coordinatorService.undeferTask(coordinatorId, taskId);

        if (!result.success) {
            return { success: false, error: result.error };
        }

        return {
            success: true,
            message: `Task ${taskId} un-deferred and ready for work`,
            data: { taskId, newStage: result.newStage }
        };
    }

    // ========================================================================
    // Engineer Commands - For Coordinator to monitor engineer status
    // ========================================================================

    private async handleEngineer(args: string[]): Promise<CliResponse> {
        if (args.length === 0) {
            return { success: false, error: 'Missing engineer subcommand. Use: list, status, log, request, release, complete, pool' };
        }

        const subCommand = args[0];
        const subArgs = args.slice(1);

        switch (subCommand) {
            case 'list':
                return this.engineerList(subArgs);
            
            case 'status':
                return this.engineerStatus(subArgs);
            
            case 'log':
                return this.engineerLog(subArgs);
            
            case 'request':
                return this.engineerRequest(subArgs);
            
            case 'release':
                return this.engineerRelease(subArgs);
            
            case 'complete':
                return this.engineerComplete(subArgs);
            
            case 'pool':
                return this.engineerPool();
            
            default:
                return { success: false, error: `Unknown engineer subcommand: ${subCommand}` };
        }
    }

    /**
     * List all engineers and their status
     * Usage: apc engineer list <coordinator_id>
     */
    private async engineerList(args: string[]): Promise<CliResponse> {
        if (args.length < 1) {
            return { success: false, error: 'Usage: apc engineer list <coordinator_id>' };
        }

        const coordinatorId = args[0];
        const result = await this.coordinatorService.listEngineers(coordinatorId);

        if (!result.success) {
            return { success: false, error: result.error };
        }

        return {
            success: true,
            data: result.engineers
        };
    }

    /**
     * Get detailed status of one engineer
     * Usage: apc engineer status <coordinator_id> <engineer_name>
     */
    private async engineerStatus(args: string[]): Promise<CliResponse> {
        if (args.length < 2) {
            return { success: false, error: 'Usage: apc engineer status <coordinator_id> <engineer_name>' };
        }

        const coordinatorId = args[0];
        const engineerName = args[1];
        const result = await this.coordinatorService.getEngineerStatus(coordinatorId, engineerName);

        if (!result.success) {
            return { success: false, error: result.error };
        }

        return {
            success: true,
            data: result.status
        };
    }

    /**
     * Get recent log output from an engineer
     * Usage: apc engineer log <coordinator_id> <engineer_name> [--lines 50]
     */
    private async engineerLog(args: string[]): Promise<CliResponse> {
        if (args.length < 2) {
            return { success: false, error: 'Usage: apc engineer log <coordinator_id> <engineer_name> [--lines 50]' };
        }

        const coordinatorId = args[0];
        const engineerName = args[1];
        const params = this.parseArgs(args.slice(2));
        const lines = params['lines'] ? parseInt(params['lines'], 10) : 50;

        const result = await this.coordinatorService.getEngineerLog(coordinatorId, engineerName, lines);

        if (!result.success) {
            return { success: false, error: result.error };
        }

        return {
            success: true,
            data: { log: result.log }
        };
    }

    /**
     * Request additional engineers from the pool for a coordinator
     * Usage: apc engineer request <coordinator_id> [count]
     * 
     * This allows a coordinator to dynamically scale up when:
     * - All assigned engineers are busy
     * - There are ready tasks waiting
     * - There are available engineers in the pool
     */
    private async engineerRequest(args: string[]): Promise<CliResponse> {
        if (args.length < 1) {
            return { success: false, error: 'Usage: apc engineer request <coordinator_id> [count]' };
        }

        const coordinatorId = args[0];
        const requestedCount = args.length > 1 ? parseInt(args[1], 10) : 1;

        // Check coordinator exists
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        if (!coordinator) {
            return { success: false, error: `Coordinator not found: ${coordinatorId}` };
        }

        // Check pool availability
        const available = this.engineerPoolService.getAvailableEngineers();
        if (available.length === 0) {
            return { 
                success: false, 
                error: 'No engineers available in pool. All engineers are currently assigned to coordinators.',
                data: { availableInPool: 0 }
            };
        }

        // Allocate engineers
        const toAllocate = Math.min(requestedCount, available.length);
        const allocated = this.engineerPoolService.allocateEngineers(coordinatorId, toAllocate);

        if (allocated.length === 0) {
            return { success: false, error: 'Failed to allocate engineers' };
        }

        // Register new engineers with the coordinator's TaskManager
        const result = await this.coordinatorService.addEngineersToCoordinator(coordinatorId, allocated);

        if (!result.success) {
            // Rollback - release the engineers back
            this.engineerPoolService.releaseEngineers(allocated);
            return { success: false, error: result.error };
        }

        return {
            success: true,
            message: `Allocated ${allocated.length} additional engineer(s) to coordinator`,
            data: {
                allocated: allocated,
                remainingInPool: available.length - allocated.length
            }
        };
    }

    /**
     * Release an idle engineer back to the pool
     * Usage: apc engineer release <coordinator_id> <engineer_name>
     * 
     * This allows a coordinator to give back engineers when:
     * - No ready tasks to dispatch
     * - Want to free up resources for other coordinators
     */
    private async engineerRelease(args: string[]): Promise<CliResponse> {
        if (args.length < 2) {
            return { success: false, error: 'Usage: apc engineer release <coordinator_id> <engineer_name>' };
        }

        const coordinatorId = args[0];
        const engineerName = args[1];

        const result = await this.coordinatorService.releaseEngineer(coordinatorId, engineerName);

        if (!result.success) {
            return { success: false, error: result.error };
        }

        return {
            success: true,
            message: `Released ${engineerName} back to pool`,
            data: { released: engineerName }
        };
    }

    /**
     * Show available engineers in the pool (not assigned to any coordinator)
     * Usage: apc engineer pool
     */
    private async engineerPool(): Promise<CliResponse> {
        const available = this.engineerPoolService.getAvailableEngineers();
        const busy = this.engineerPoolService.getBusyEngineers();

        return {
            success: true,
            data: {
                availableCount: available.length,
                available: available,
                busyCount: busy.length,
                busy: busy.map(e => ({
                    name: e.name,
                    coordinator: e.coordinatorId,
                    task: e.task || 'unknown'
                }))
            }
        };
    }

    /**
     * Engineer completes a task stage and queues Unity pipeline
     * 
     * Usage: apc engineer complete <coordinator_id> --engineer <name> --task <task_id> --stage <stage> --unity "prep,test_editmode" --files "a.cs,b.cs"
     * 
     * This is called by engineers when they finish implementation:
     * 1. Engineer process STOPS (no longer running)
     * 2. Engineer status becomes 'available' (ready for redeployment)
     * 3. Task is marked 'awaiting_unity' 
     * 4. Unity pipeline is queued (prep → test_editmode → test_playmode → etc.)
     * 5. When pipeline completes, COORDINATOR is notified (not engineer)
     * 6. Coordinator decides how to dispatch fixes or continue
     */
    private async engineerComplete(args: string[]): Promise<CliResponse> {
        if (args.length < 1) {
            return { 
                success: false, 
                error: 'Usage: apc engineer complete <coordinator_id> --engineer <name> --task <task_id> --stage <stage> [--unity "prep,test_editmode"] [--files "a.cs,b.cs"]' 
            };
        }

        const coordinatorId = args[0];
        const params = this.parseArgsWithMultiValue(args.slice(1));

        const engineerName = params['engineer'];
        const taskId = params['task'];
        const stage = params['stage'];
        const unityOps = params['unity'];
        const files = params['files'] ? params['files'].split(',').map(f => f.trim()) : [];

        if (!engineerName || !taskId || !stage) {
            return { 
                success: false, 
                error: 'Missing required parameters: --engineer, --task, --stage' 
            };
        }

        // Update task to awaiting_unity status
        const taskResult = await this.coordinatorService.updateTaskStage(coordinatorId, taskId, 'awaiting_unity', stage);
        if (!taskResult.success) {
            return { success: false, error: taskResult.error };
        }

        // Mark engineer as available (they stopped working)
        const engineerResult = await this.coordinatorService.markEngineerAvailable(coordinatorId, engineerName, taskId, files);
        if (!engineerResult.success) {
            return { success: false, error: engineerResult.error };
        }

        // Queue Unity pipeline if requested
        let pipelineId: string | undefined;
        if (unityOps) {
            const operations = unityOps.split(',').map(op => op.trim() as PipelineOperation);
            
            // Validate operations
            const validOps: PipelineOperation[] = ['prep', 'test_editmode', 'test_playmode', 'test_player_playmode'];
            for (const op of operations) {
                if (!validOps.includes(op)) {
                    return { 
                        success: false, 
                        error: `Invalid operation: ${op}. Valid operations: ${validOps.join(', ')}` 
                    };
                }
            }

            // Build task context
            const taskContext: PipelineTaskContext = {
                taskId,
                stage,
                engineerName,
                filesModified: files
            };

            // Queue the pipeline
            const unityManager = UnityControlManager.getInstance();
            pipelineId = unityManager.queuePipeline(
                coordinatorId,
                operations,
                [taskContext],
                true  // mergeEnabled
            );
        }

        return {
            success: true,
            message: `Engineer ${engineerName} completed ${taskId} stage ${stage}${pipelineId ? `. Unity pipeline queued: ${pipelineId}` : ''}`,
            data: {
                coordinatorId,
                engineerName,
                taskId,
                stage,
                files,
                pipelineId,
                unityOperations: unityOps ? unityOps.split(',') : [],
                hint: pipelineId 
                    ? 'Engineer process should EXIT now. Coordinator will handle Unity results.' 
                    : 'No Unity operations queued. Task marked as awaiting review.'
            }
        };
    }

    // ========================================================================
    // Unity Commands - Engineers interact with UnityControlManager via CLI
    // ========================================================================

    private async handleUnity(args: string[]): Promise<CliResponse> {
        if (args.length === 0) {
            return { success: false, error: 'Missing unity subcommand. Use: compile, test, status, wait, console' };
        }

        const subCommand = args[0];
        const subArgs = args.slice(1);

        switch (subCommand) {
            case 'compile':
                return this.unityCompile(subArgs);
            
            case 'test':
                return this.unityTest(subArgs);
            
            case 'status':
                return this.unityStatus();
            
            case 'wait':
                return this.unityWait(subArgs);
            
            case 'console':
                return this.unityConsole(subArgs);
            
            case 'notify-status':
                return this.unityNotifyStatus(subArgs);
            
            default:
                return { success: false, error: `Unknown unity subcommand: ${subCommand}` };
        }
    }

    /**
     * Receive status notification from polling agent
     * Usage: apc unity notify-status --compiling true --playing false --errors 0
     */
    private async unityNotifyStatus(args: string[]): Promise<CliResponse> {
        const params = this.parseArgs(args);
        
        const status = {
            isCompiling: params['compiling'] === 'true',
            isPlaying: params['playing'] === 'true',
            isPaused: params['paused'] === 'true',
            hasErrors: parseInt(params['errors'] || '0', 10) > 0,
            errorCount: parseInt(params['errors'] || '0', 10),
            timestamp: Date.now()
        };

        const unityManager = UnityControlManager.getInstance();
        unityManager.receiveStatusNotification(status);

        return {
            success: true,
            message: 'Status received',
            data: status
        };
    }

    /**
     * Queue compilation/prep_editor task
     * Usage: apc unity compile --coordinator coord_001 --engineer Alex
     */
    private async unityCompile(args: string[]): Promise<CliResponse> {
        const params = this.parseArgs(args);
        const coordinatorId = params['coordinator'] || params['coord'];
        const engineerName = params['engineer'];

        if (!coordinatorId || !engineerName) {
            return { 
                success: false, 
                error: 'Usage: apc unity compile --coordinator <id> --engineer <name>' 
            };
        }

        const unityManager = UnityControlManager.getInstance();
        const requester: TaskRequester = {
            coordinatorId,
            engineerName
        };

        const taskId = unityManager.queueTask('prep_editor', requester);

        return {
            success: true,
            message: `Unity compilation queued`,
            data: { 
                taskId,
                type: 'prep_editor',
                requestedBy: { coordinatorId, engineerName },
                hint: `Use 'apc unity wait --task ${taskId}' to wait for completion`
            }
        };
    }

    /**
     * Queue Unity test task
     * Usage: apc unity test editmode --coordinator coord_001 --engineer Alex [--filter "TestName"]
     *        apc unity test playmode --coordinator coord_001 --engineer Alex [--scene "Assets/Scenes/Test.unity"]
     */
    private async unityTest(args: string[]): Promise<CliResponse> {
        if (args.length === 0) {
            return { 
                success: false, 
                error: 'Usage: apc unity test <editmode|playmode> --coordinator <id> --engineer <name> [--filter "TestName"]' 
            };
        }

        const mode = args[0].toLowerCase();
        const params = this.parseArgs(args.slice(1));
        const coordinatorId = params['coordinator'] || params['coord'];
        const engineerName = params['engineer'];

        if (!coordinatorId || !engineerName) {
            return { 
                success: false, 
                error: 'Missing --coordinator and --engineer parameters' 
            };
        }

        let taskType: UnityTaskType;
        if (mode === 'editmode' || mode === 'edit') {
            taskType = 'test_framework_editmode';
        } else if (mode === 'playmode' || mode === 'play') {
            taskType = 'test_framework_playmode';
        } else {
            return { success: false, error: `Unknown test mode: ${mode}. Use 'editmode' or 'playmode'` };
        }

        const unityManager = UnityControlManager.getInstance();
        const requester: TaskRequester = {
            coordinatorId,
            engineerName
        };

        // Parse optional filters
        const filter = params['filter'];
        const scene = params['scene'];
        const testFilter = filter ? filter.split(',').map(f => f.trim()) : undefined;

        const taskId = unityManager.queueTask(taskType, requester, {
            testFilter,
            testScene: scene
        });

        return {
            success: true,
            message: `Unity ${mode} tests queued`,
            data: { 
                taskId,
                type: taskType,
                requestedBy: { coordinatorId, engineerName },
                filter: testFilter,
                hint: `Use 'apc unity wait --task ${taskId}' to wait for completion`
            }
        };
    }

    /**
     * Get Unity Control Agent status
     * Usage: apc unity status
     */
    private async unityStatus(): Promise<CliResponse> {
        const unityManager = UnityControlManager.getInstance();
        const state = unityManager.getState();

        return {
            success: true,
            data: {
                status: state.status,
                currentTask: state.currentTask ? {
                    id: state.currentTask.id,
                    type: state.currentTask.type,
                    phase: state.currentTask.phase,
                    requestedBy: state.currentTask.requestedBy
                } : null,
                queueLength: state.queueLength,
                lastActivity: state.lastActivity
            }
        };
    }

    /**
     * Wait for a Unity task to complete
     * Usage: apc unity wait --task <taskId> [--timeout 120]
     */
    private async unityWait(args: string[]): Promise<CliResponse> {
        const params = this.parseArgs(args);
        const taskId = params['task'];
        const timeout = params['timeout'] ? parseInt(params['timeout'], 10) : 120;

        if (!taskId) {
            return { success: false, error: 'Usage: apc unity wait --task <taskId> [--timeout 120]' };
        }

        const unityManager = UnityControlManager.getInstance();

        // Poll for task completion
        const startTime = Date.now();
        const pollInterval = 2000; // 2 seconds

        while (Date.now() - startTime < timeout * 1000) {
            const state = unityManager.getState();
            
            // Check if task is still in queue or current
            const isQueued = state.queueLength > 0; // Simplified check
            const isCurrentTask = state.currentTask?.id === taskId;
            
            if (!isCurrentTask && !isQueued) {
                // Task might be completed - check recent results
                // For now, return that we've waited and task is no longer active
                return {
                    success: true,
                    message: `Task ${taskId} is no longer active (likely completed)`,
                    data: {
                        taskId,
                        waited: Math.round((Date.now() - startTime) / 1000),
                        status: 'completed_or_not_found'
                    }
                };
            }

            if (isCurrentTask && state.currentTask?.status === 'completed') {
                return {
                    success: true,
                    message: `Task ${taskId} completed`,
                    data: {
                        taskId,
                        waited: Math.round((Date.now() - startTime) / 1000),
                        result: state.currentTask.result
                    }
                };
            }

            if (isCurrentTask && state.currentTask?.status === 'failed') {
                return {
                    success: false,
                    error: `Task ${taskId} failed`,
                    data: {
                        taskId,
                        waited: Math.round((Date.now() - startTime) / 1000),
                        result: state.currentTask.result
                    }
                };
            }

            // Wait before next poll
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        return {
            success: false,
            error: `Timeout waiting for task ${taskId}`,
            data: {
                taskId,
                timeout,
                hint: 'Task is still running. Check status with: apc unity status'
            }
        };
    }

    /**
     * Read Unity console (errors/warnings)
     * Usage: apc unity console [--type error|warning|all] [--count 10]
     */
    private async unityConsole(args: string[]): Promise<CliResponse> {
        const params = this.parseArgs(args);
        const type = params['type'] || 'error';
        const count = params['count'] ? parseInt(params['count'], 10) : 10;

        // This will be handled by UnityControlManager using runCursorAgentCommand
        // For now, return a message explaining the workflow
        const unityManager = UnityControlManager.getInstance();
        
        // Queue a console read - this is handled internally
        // The UnityControlManager will use runCursorAgentCommand to call MCP
        return {
            success: true,
            message: 'Console read is performed during compile/test tasks automatically',
            data: {
                hint: 'Errors and warnings are captured and returned in task results',
                currentStatus: unityManager.getState().status
            }
        };
    }

    /**
     * Parse args allowing multi-value params (comma-separated)
     */
    private parseArgsWithMultiValue(args: string[]): Record<string, string> {
        const params: Record<string, string> = {};
        
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (arg.startsWith('--')) {
                const key = arg.substring(2);
                // Collect all following non-flag values
                const values: string[] = [];
                while (i + 1 < args.length && !args[i + 1].startsWith('--')) {
                    values.push(args[++i]);
                }
                params[key] = values.length > 0 ? values.join(',') : 'true';
            }
        }
        
        return params;
    }

    // ========================================================================
    // Help
    // ========================================================================

    private showHelp(): CliResponse {
        const help = `
Agentic Planning Coordinator CLI

Usage: apc <command> [subcommand] [options]

Commands:
  status                          Show overall status
  
  plan list                       List all planning sessions
  plan new "<prompt>" [--docs]    Start new planning session
  plan status <id>                Get planning session status
  plan revise <id> "<feedback>"   Revise a plan
  plan approve <id>               Approve a plan for execution
  plan cancel <id>                Cancel a planning session
  
  exec start <session_id>         Start execution for an approved plan
  exec pause <session_id>         Pause execution
  exec resume <session_id>        Resume execution
  exec stop <session_id>          Stop execution
  exec status <session_id>        Get execution status
  
  pool status                     Show engineer pool status
  pool resize <n>                 Resize engineer pool
  
  task create <coord_id> "<desc>" --id T1 [--deps T2,T3] [--engineer Alex]
                                  Create a task in TaskManager
  task start <coord_id> <task_id> --engineer Alex
                                  Start a task (spawns engineer AI process)
  task complete <coord_id> <task_id> [--files "a.cs,b.cs"]
                                  Mark task as completed
  task fail <coord_id> <task_id> --reason "error"
                                  Mark task as failed
  task reset <coord_id> <task_id> Reset task to ready (for retry)
  task list <coord_id> [--status ready|pending|completed|deferred]
                                  List all tasks
  task ready <coord_id>           Get tasks ready for dispatch
  task progress <coord_id>        Get completion progress
  task assign <coord_id> <task_id> --engineer Betty
                                  Assign task to engineer
  task status <coord_id> <task_id> <stage> [--reason "why"]
                                  Update task stage (test_passed|test_failed|compile_failed|completed|...)
  task defer <coord_id> <task_id> --reason "why" [--blocked-by T7]
                                  Defer task due to overlap with ongoing work
  task undefer <coord_id> <task_id>
                                  Un-defer task when blocker completes
  
  engineer list <coord_id>        List all engineers and their status
  engineer status <coord_id> <name>
                                  Get detailed status of one engineer
  engineer log <coord_id> <name> [--lines 50]
                                  Get recent log output from engineer
  engineer request <coord_id> [count]
                                  Request additional engineers from pool
                                  (for when all assigned engineers are busy)
  engineer release <coord_id> <name>
                                  Release an idle engineer back to pool
                                  (for when no ready tasks to work on)
  engineer complete <coord_id> --engineer <name> --task <task_id> --stage <stage> [--unity "prep,test_editmode"] [--files "a.cs,b.cs"]
                                  Engineer completes task stage & queues Unity pipeline
                                  CRITICAL: Engineer process should EXIT after this call
                                  Pipeline ops: prep, test_editmode, test_playmode, test_player_playmode
  engineer pool                   Show available engineers in the pool
  
  unity compile --coordinator <id> --engineer <name>
                                  Queue Unity compilation (reimport + compile)
  unity test <editmode|playmode> --coordinator <id> --engineer <name>
                                  Queue Unity tests
  unity status                    Get Unity Control Manager status
  unity wait --task <taskId> [--timeout 120]
                                  Wait for Unity task to complete
  unity console [--type error|warning] [--count 10]
                                  Read Unity console messages
  unity notify-status --compiling <bool> --playing <bool> --errors <n>
                                  (Internal) Polling agent status callback
  
  help                            Show this help message

Notes:
  - Session IDs start with 'ps_' (e.g., ps_000001)
  - Coordinator uses task commands to manage work after reading plan
  - Engineers CAN use MCP directly for READ operations:
    * mcp_unityMCP_read_console (read errors/warnings)
    * mcp_unityMCP_manage_scene action:get_active
  - Engineers MUST use 'apc unity' CLI for BLOCKING operations:
    * compile (freezes Unity during reimport/compile)
    * test (requires exclusive Unity access)
    * These go through UnityControlManager queue (one at a time)
`;

        return {
            success: true,
            message: help
        };
    }

    // ========================================================================
    // Utilities
    // ========================================================================

    private parseArgs(args: string[]): Record<string, string> {
        const params: Record<string, string> = {};
        
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (arg.startsWith('--')) {
                const key = arg.substring(2);
                const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
                params[key] = value;
            }
        }
        
        return params;
    }
}









