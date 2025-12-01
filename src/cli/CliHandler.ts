import * as vscode from 'vscode';
import { StateManager } from '../services/StateManager';
import { AgentPoolService } from '../services/AgentPoolService';
import { UnifiedCoordinatorService } from '../services/UnifiedCoordinatorService';
import { PlanningService } from '../services/PlanningService';
import { TerminalManager } from '../services/TerminalManager';
import { UnityControlManager } from '../services/UnityControlManager';
import { CliResponse, StatusResponse, PoolStatusResponse } from '../types';
import { UnityTaskType, TaskRequester, PipelineOperation, PipelineTaskContext } from '../types/unity';
import { WorkflowType, WorkflowSummary, AgentCompletionSignal, AgentStage, AgentStageResult, AgentCompletionPayload } from '../types/workflow';
import { TaskManager } from '../services/TaskManager';
import { ServiceLocator } from '../services/ServiceLocator';

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
    private agentPoolService: AgentPoolService;
    private coordinator: UnifiedCoordinatorService;
    private planningService: PlanningService;
    private terminalManager: TerminalManager;

    constructor(
        stateManager: StateManager,
        agentPoolService: AgentPoolService,
        coordinator: UnifiedCoordinatorService,
        planningService: PlanningService,
        terminalManager: TerminalManager
    ) {
        this.stateManager = stateManager;
        this.agentPoolService = agentPoolService;
        this.coordinator = coordinator;
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
            
            case 'session':
                return this.handleSession(subArgs);
            
            case 'workflow':
                return this.handleWorkflow(subArgs);
            
            case 'exec':
            case 'execute':
                return this.handleExecution(subArgs);
            
            case 'pool':
                return this.handlePool(subArgs);
            
            case 'agent':
                return this.handleAgent(subArgs);
            
            case 'task':
                return this.handleTask(subArgs);
            
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
        const poolStatus = this.agentPoolService.getPoolStatus();

        const activeSessions = sessions.filter(s => 
            ['debating', 'reviewing', 'revising', 'executing'].includes(s.status)
        ).length;

        return {
            success: true,
            data: {
                activePlanningSessions: activeSessions,
                agentPool: {
                    total: poolStatus.total,
                    available: poolStatus.available.length,
                    busy: poolStatus.busy.length
                }
            }
        };
    }

    // ========================================================================
    // Session Commands - Workflow-based session management
    // ========================================================================

    private async handleSession(args: string[]): Promise<CliResponse> {
        if (args.length === 0) {
            return { success: false, error: 'Missing session subcommand. Use: list, status, pause, resume' };
        }

        const subCommand = args[0];
        const params = this.parseArgs(args.slice(1));

        switch (subCommand) {
            case 'list':
                return this.sessionList();
            
            case 'status':
                return this.sessionStatus(params);
            
            case 'pause':
                return this.sessionPause(params);
            
            case 'resume':
                return this.sessionResume(params);
            
            default:
                return { success: false, error: `Unknown session subcommand: ${subCommand}` };
        }
    }

    private async sessionList(): Promise<CliResponse> {
        const sessions = this.stateManager.getAllPlanningSessions();
        
        return {
            success: true,
            data: sessions.map(s => {
                const workflows = this.coordinator.getWorkflowSummaries(s.id);
                return {
                    id: s.id,
                    status: s.status,
                    requirement: s.requirement.substring(0, 50) + (s.requirement.length > 50 ? '...' : ''),
                    activeWorkflows: workflows.filter(w => w.status === 'running').length,
                    totalWorkflows: workflows.length
                };
            })
        };
    }

    private async sessionStatus(params: Record<string, string>): Promise<CliResponse> {
        const id = params['id'];
        if (!id) {
            return { success: false, error: 'Missing --id parameter' };
        }

        const state = this.coordinator.getSessionState(id);
        if (!state) {
            return { success: false, error: `Session ${id} not found` };
        }

        const workflows = this.coordinator.getWorkflowSummaries(id);

        return {
            success: true,
            data: {
                sessionId: id,
                isRevising: state.isRevising,
                workflows: workflows,
                pendingWorkflows: state.pendingWorkflows.length,
                completedWorkflows: state.completedWorkflows.length
            }
        };
    }

    private async sessionPause(params: Record<string, string>): Promise<CliResponse> {
        const id = params['id'];
        if (!id) {
            return { success: false, error: 'Missing --id parameter' };
        }

        await this.coordinator.pauseSession(id);
        return {
            success: true,
            message: `Session ${id} paused`
        };
    }

    private async sessionResume(params: Record<string, string>): Promise<CliResponse> {
        const id = params['id'];
        if (!id) {
            return { success: false, error: 'Missing --id parameter' };
        }

        await this.coordinator.resumeSession(id);
        return {
            success: true,
            message: `Session ${id} resumed`
        };
    }

    // ========================================================================
    // Workflow Commands - Direct workflow management
    // ========================================================================

    private async handleWorkflow(args: string[]): Promise<CliResponse> {
        if (args.length === 0) {
            return { success: false, error: 'Missing workflow subcommand. Use: dispatch, status, cancel, list' };
        }

        const subCommand = args[0];
        const params = this.parseArgs(args.slice(1));

        switch (subCommand) {
            case 'dispatch':
                return this.workflowDispatch(args.slice(1));
            
            case 'status':
                return this.workflowStatus(params);
            
            case 'cancel':
                return this.workflowCancel(params);
            
            case 'list':
                return this.workflowList(params);
            
            default:
                return { success: false, error: `Unknown workflow subcommand: ${subCommand}` };
        }
    }

    /**
     * Dispatch a workflow
     * Usage: apc workflow dispatch <sessionId> <type> [--input JSON]
     */
    private async workflowDispatch(args: string[]): Promise<CliResponse> {
        if (args.length < 2) {
            return { 
                success: false, 
                error: 'Usage: apc workflow dispatch <sessionId> <type> [--input JSON]' 
            };
        }

        const sessionId = args[0];
        const type = args[1] as WorkflowType;
        const params = this.parseArgs(args.slice(2));
        
        // Parse input JSON
        let input: Record<string, any> = {};
        if (params['input']) {
            try {
                input = JSON.parse(params['input']);
            } catch (e) {
                return { success: false, error: 'Invalid --input JSON' };
            }
        }

        const workflowId = await this.coordinator.dispatchWorkflow(sessionId, type, input);

        return {
            success: true,
            message: `Workflow ${type} dispatched`,
            data: { workflowId, sessionId, type }
        };
    }

    private async workflowStatus(params: Record<string, string>): Promise<CliResponse> {
        const sessionId = params['session'];
        const workflowId = params['id'];
        
        if (!sessionId || !workflowId) {
            return { success: false, error: 'Missing --session and --id parameters' };
        }

        const progress = this.coordinator.getWorkflowStatus(sessionId, workflowId);
        if (!progress) {
            return { success: false, error: `Workflow ${workflowId} not found` };
        }

        return {
            success: true,
            data: progress
        };
    }

    private async workflowCancel(params: Record<string, string>): Promise<CliResponse> {
        const sessionId = params['session'];
        const workflowId = params['id'];
        
        if (!sessionId || !workflowId) {
            return { success: false, error: 'Missing --session and --id parameters' };
        }

        await this.coordinator.cancelWorkflow(sessionId, workflowId);

        return {
            success: true,
            message: `Workflow ${workflowId} cancelled`
        };
    }

    private async workflowList(params: Record<string, string>): Promise<CliResponse> {
        const sessionId = params['session'];
        
        if (!sessionId) {
            return { success: false, error: 'Missing --session parameter' };
        }

        const workflows = this.coordinator.getWorkflowSummaries(sessionId);

        return {
            success: true,
            data: workflows
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
                recommendedAgents: result.recommendedAgents,
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

        try {
            const workflowIds = await this.coordinator.startExecution(sessionId);

            return {
                success: true,
                message: `Execution started for ${sessionId} with ${workflowIds.length} task workflows`,
                data: { sessionId, workflowIds }
            };
        } catch (error) {
            return { 
                success: false, 
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    private async execPause(params: Record<string, string>): Promise<CliResponse> {
        const sessionId = params['session'] || params['id'];
        if (!sessionId) {
            return { success: false, error: 'Missing --session or --id parameter' };
        }

        await this.coordinator.pauseSession(sessionId);

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

        await this.coordinator.resumeSession(sessionId);

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

        await this.coordinator.cancelSession(sessionId);

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

        const state = this.coordinator.getSessionState(sessionId);
        if (!state) {
            return { success: false, error: `Session ${sessionId} not found` };
        }

        const workflows = this.coordinator.getWorkflowSummaries(sessionId);

        return {
            success: true,
            data: {
                sessionId,
                isRevising: state.isRevising,
                workflows: workflows,
                activeWorkflows: workflows.filter(w => w.status === 'running').length,
                completedWorkflows: state.completedWorkflows.length
            }
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
        const status = this.agentPoolService.getPoolStatus();
        const busyEngineers = this.agentPoolService.getBusyAgents();

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

        const result = this.agentPoolService.resizePool(newSize);
        return {
            success: true,
            message: `Pool resized to ${newSize}`,
            data: result
        };
    }

    // ========================================================================
    // Agent Commands - For workflow agent management
    // ========================================================================

    private async handleAgent(args: string[]): Promise<CliResponse> {
        if (args.length === 0) {
            return { success: false, error: 'Missing agent subcommand. Use: pool, roles, release' };
        }

        const subCommand = args[0];
        const subArgs = args.slice(1);

        switch (subCommand) {
            case 'pool':
                return this.agentPool();
            
            case 'roles':
                return this.agentRoles();
            
            case 'release':
                return this.agentRelease(subArgs);
            
            case 'complete':
                return this.agentComplete(subArgs);
            
            default:
                return { success: false, error: `Unknown agent subcommand: ${subCommand}. Use: pool, roles, release, complete` };
        }
    }

    /**
     * Show available agents in the pool
     * Usage: apc agent pool
     */
    private async agentPool(): Promise<CliResponse> {
        const available = this.agentPoolService.getAvailableAgents();
        const busy = this.agentPoolService.getBusyAgents();

        return {
            success: true,
            data: {
                availableCount: available.length,
                available: available,
                busyCount: busy.length,
                busy: busy.map(e => ({
                    name: e.name,
                    coordinatorId: e.coordinatorId,
                    roleId: e.roleId,
                    task: e.task || 'unknown'
                }))
            }
        };
    }

    /**
     * Release an agent back to the pool
     * Usage: apc agent release <agent_name>
     */
    private async agentRelease(args: string[]): Promise<CliResponse> {
        if (args.length < 1) {
            return { success: false, error: 'Usage: apc agent release <agent_name>' };
        }

        const agentName = args[0];
        this.agentPoolService.releaseAgents([agentName]);

        return {
            success: true,
            message: `Released ${agentName} back to pool`,
            data: { released: agentName }
        };
    }

    /**
     * List all available agent roles
     * Usage: apc agent roles
     */
    private async agentRoles(): Promise<CliResponse> {
        const roles = this.agentPoolService.getAllRoles();
        
        return {
            success: true,
            data: {
                roles: roles.map(r => ({
                    id: r.id,
                    name: r.name,
                    description: r.description,
                    isBuiltIn: r.isBuiltIn,
                    defaultModel: r.defaultModel,
                    timeoutMs: r.timeoutMs
                }))
            }
        };
    }

    /**
     * Signal agent completion from CLI callback
     * 
     * This is the primary way agents report completion/results to the workflow system.
     * Replaces fragile output parsing with explicit structured callbacks.
     * 
     * Usage: apc agent complete --session <s> --workflow <w> --stage <stage> --result <r> [--data '<json>']
     * 
     * Stages: context, implementation, review, analysis, error_analysis, delta_context, finalize
     * Results: success, failed, approved, changes_requested, pass, critical, minor, complete
     * 
     * Examples:
     *   apc agent complete --session ps_001 --workflow wf_abc --stage implementation --result success --data '{"files":["a.cs"]}'
     *   apc agent complete --session ps_001 --workflow wf_abc --stage review --result approved
     *   apc agent complete --session ps_001 --workflow wf_abc --stage review --result changes_requested --data '{"feedback":"Fix line 42"}'
     */
    private async agentComplete(args: string[]): Promise<CliResponse> {
        const params = this.parseArgs(args);
        
        const sessionId = params['session'];
        const workflowId = params['workflow'];
        const stage = params['stage'] as AgentStage;
        const result = params['result'] as AgentStageResult;
        const dataJson = params['data'];
        
        // Validate required parameters
        if (!sessionId) {
            return { success: false, error: 'Missing --session parameter' };
        }
        if (!workflowId) {
            return { success: false, error: 'Missing --workflow parameter' };
        }
        if (!stage) {
            return { success: false, error: 'Missing --stage parameter (context, implementation, review, analysis, error_analysis, delta_context, finalize)' };
        }
        if (!result) {
            return { success: false, error: 'Missing --result parameter (success, failed, approved, changes_requested, pass, critical, minor, complete)' };
        }
        
        // Parse data payload if provided
        let payload: AgentCompletionPayload | undefined;
        if (dataJson) {
            try {
                payload = JSON.parse(dataJson);
            } catch (e) {
                return { success: false, error: `Invalid --data JSON: ${e instanceof Error ? e.message : String(e)}` };
            }
        }
        
        // Build the completion signal
        const signal: AgentCompletionSignal = {
            sessionId,
            workflowId,
            stage,
            result,
            payload
        };
        
        // Send to coordinator
        const delivered = this.coordinator.signalAgentCompletion(signal);
        
        if (delivered) {
            return {
                success: true,
                message: `Completion signaled: ${stage} → ${result}`,
                data: { sessionId, workflowId, stage, result, delivered: true }
            };
        } else {
            // Signal was not delivered - no workflow waiting
            // This is not necessarily an error (workflow may have timed out or been cancelled)
            return {
                success: true,
                message: `Signal sent but no workflow waiting (may have timed out)`,
                data: { sessionId, workflowId, stage, result, delivered: false }
            };
        }
    }

    // ========================================================================
    // Task Commands - Direct task management
    // ========================================================================

    private async handleTask(args: string[]): Promise<CliResponse> {
        if (args.length === 0) {
            return { success: false, error: 'Missing task subcommand. Use: fail, progress, status' };
        }

        const subCommand = args[0];
        const params = this.parseArgs(args.slice(1));

        switch (subCommand) {
            case 'fail':
                return this.taskFail(params);
            
            case 'progress':
                return this.taskProgress(params);
            
            case 'status':
                return this.taskStatus(params);
            
            default:
                return { success: false, error: `Unknown task subcommand: ${subCommand}. Use: fail, progress, status` };
        }
    }

    /**
     * Mark a task as failed
     * Usage: apc task fail --session <id> --task <task_id> --reason "error message"
     */
    private async taskFail(params: Record<string, string>): Promise<CliResponse> {
        const sessionId = params['session'];
        const taskId = params['task'];
        const reason = params['reason'];

        if (!sessionId) {
            return { success: false, error: 'Missing --session parameter' };
        }
        if (!taskId) {
            return { success: false, error: 'Missing --task parameter' };
        }
        if (!reason) {
            return { success: false, error: 'Missing --reason parameter' };
        }

        const taskManager = ServiceLocator.resolve(TaskManager);
        const globalTaskId = `${sessionId}_${taskId}`;
        
        taskManager.markTaskFailed(globalTaskId, reason);

        return {
            success: true,
            message: `Task ${taskId} marked as failed`,
            data: { sessionId, taskId, reason }
        };
    }

    /**
     * Get task progress for a session
     * Usage: apc task progress --session <id>
     */
    private async taskProgress(params: Record<string, string>): Promise<CliResponse> {
        const sessionId = params['session'];

        if (!sessionId) {
            return { success: false, error: 'Missing --session parameter' };
        }

        const taskManager = ServiceLocator.resolve(TaskManager);
        const progress = taskManager.getProgressForSession(sessionId);
        const tasks = taskManager.getTasksForSession(sessionId);

        return {
            success: true,
            data: {
                sessionId,
                progress,
                tasks: tasks.map(t => ({
                    id: t.id.replace(`${sessionId}_`, ''),
                    description: t.description,
                    status: t.status,
                    stage: t.stage,
                    dependencies: t.dependencies,
                    actualAgent: t.actualAgent
                }))
            }
        };
    }

    /**
     * Get status of a specific task
     * Usage: apc task status --session <id> --task <task_id>
     */
    private async taskStatus(params: Record<string, string>): Promise<CliResponse> {
        const sessionId = params['session'];
        const taskId = params['task'];

        if (!sessionId) {
            return { success: false, error: 'Missing --session parameter' };
        }
        if (!taskId) {
            return { success: false, error: 'Missing --task parameter' };
        }

        const taskManager = ServiceLocator.resolve(TaskManager);
        const globalTaskId = `${sessionId}_${taskId}`;
        const task = taskManager.getTask(globalTaskId);

        if (!task) {
            return { success: false, error: `Task ${taskId} not found in session ${sessionId}` };
        }

        return {
            success: true,
            data: {
                id: taskId,
                globalId: globalTaskId,
                description: task.description,
                status: task.status,
                stage: task.stage,
                dependencies: task.dependencies,
                actualAgent: task.actualAgent,
                filesModified: task.filesModified,
                startedAt: task.startedAt,
                completedAt: task.completedAt
            }
        };
    }

    // ========================================================================
    // Unity Commands - Agents interact with UnityControlManager via CLI
    // ========================================================================

    private async handleUnity(args: string[]): Promise<CliResponse> {
        // Check if Unity features are enabled
        const config = vscode.workspace.getConfiguration('agenticPlanning');
        const unityEnabled = config.get<boolean>('enableUnityFeatures', true);
        
        if (!unityEnabled) {
            return { 
                success: false, 
                error: 'Unity features are disabled. Enable via: agenticPlanning.enableUnityFeatures setting.' 
            };
        }
        
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

        const unityManager = ServiceLocator.resolve(UnityControlManager);
        unityManager.receiveStatusNotification(status);

        return {
            success: true,
            message: 'Status received',
            data: status
        };
    }

    /**
     * Queue compilation/prep_editor task
     * Usage: apc unity compile --coordinator coord_001 --agent Alex
     */
    private async unityCompile(args: string[]): Promise<CliResponse> {
        const params = this.parseArgs(args);
        const coordinatorId = params['coordinator'] || params['coord'];
        const agentName = params['agent'] || params['engineer'];

        if (!coordinatorId || !agentName) {
            return { 
                success: false, 
                error: 'Usage: apc unity compile --coordinator <id> --agent <name>' 
            };
        }

        const unityManager = ServiceLocator.resolve(UnityControlManager);
        const requester: TaskRequester = {
            coordinatorId,
            agentName
        };

        const taskId = unityManager.queueTask('prep_editor', requester);

        return {
            success: true,
            message: `Unity compilation queued`,
            data: { 
                taskId,
                type: 'prep_editor',
                requestedBy: { coordinatorId, agentName },
                hint: `Use 'apc unity wait --task ${taskId}' to wait for completion`
            }
        };
    }

    /**
     * Queue Unity test task
     * Usage: apc unity test editmode --coordinator coord_001 --agent Alex [--filter "TestName"]
     *        apc unity test playmode --coordinator coord_001 --agent Alex [--scene "Assets/Scenes/Test.unity"]
     */
    private async unityTest(args: string[]): Promise<CliResponse> {
        if (args.length === 0) {
            return { 
                success: false, 
                error: 'Usage: apc unity test <editmode|playmode> --coordinator <id> --agent <name> [--filter "TestName"]' 
            };
        }

        const mode = args[0].toLowerCase();
        const params = this.parseArgs(args.slice(1));
        const coordinatorId = params['coordinator'] || params['coord'];
        const agentName = params['agent'] || params['engineer'];

        if (!coordinatorId || !agentName) {
            return { 
                success: false, 
                error: 'Missing --coordinator and --agent parameters' 
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

        const unityManager = ServiceLocator.resolve(UnityControlManager);
        const requester: TaskRequester = {
            coordinatorId,
            agentName
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
                requestedBy: { coordinatorId, agentName },
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
        const unityManager = ServiceLocator.resolve(UnityControlManager);
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

        const unityManager = ServiceLocator.resolve(UnityControlManager);

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
        const unityManager = ServiceLocator.resolve(UnityControlManager);
        
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
Agentic Planning Coordinator CLI (Workflow-based)

Usage: apc <command> [subcommand] [options]

Commands:
  status                          Show overall status
  
  === Session Management ===
  session list                    List all sessions with workflow info
  session status --id <id>        Get session status with active workflows
  session pause --id <id>         Pause all workflows in session
  session resume --id <id>        Resume paused session
  
  === Workflow Management ===
  workflow dispatch <sessionId> <type> [--input JSON]
                                  Dispatch a new workflow
                                  Types: planning_new, planning_revision,
                                         task_implementation, error_resolution
  workflow status --session <id> --id <workflowId>
                                  Get workflow progress
  workflow cancel --session <id> --id <workflowId>
                                  Cancel a workflow
  workflow list --session <id>    List all workflows in a session
  
  === Planning ===
  plan list                       List all planning sessions
  plan start --prompt "<prompt>" [--docs <paths>]
                                  Start new planning session (dispatches planning_new workflow)
  plan status --id <id>           Get planning session status
  plan revise --id <id> --feedback "<feedback>"
                                  Revise a plan (dispatches planning_revision workflow)
  plan approve --id <id>          Approve a plan for execution
  plan cancel --id <id>           Cancel a planning session
  
  === Execution ===
  exec start --session <id>       Start execution (dispatches task workflows)
  exec pause --session <id>       Pause all execution workflows
  exec resume --session <id>      Resume execution
  exec stop --session <id>        Stop all execution workflows
  exec status --session <id>      Get execution status
  
  === Agent Pool ===
  pool status                     Show agent pool status
  pool resize --size <n>          Resize agent pool
  
  agent pool                      Show available agents in the pool
  agent roles                     List all available agent roles
  agent release <agent_name>      Release an agent back to pool
  agent complete --session <s> --workflow <w> --stage <stage> --result <r> [--data '<json>']
                                  Signal agent completion (CLI callback)
                                  Stages: context, implementation, review, analysis, 
                                          error_analysis, delta_context, finalize
                                  Results: success, failed, approved, changes_requested,
                                           pass, critical, minor, complete
  
  === Task Management ===
  task progress --session <id>    Get task progress for session
  task status --session <id> --task <task_id>
                                  Get specific task status
  task fail --session <id> --task <task_id> --reason "<msg>"
                                  Mark a task as failed
  
  === Unity ===
  unity compile --coordinator <id> --agent <name>
                                  Queue Unity compilation
  unity test <editmode|playmode> --coordinator <id> --agent <name>
                                  Queue Unity tests
  unity status                    Get Unity Control Manager status
  unity wait --task <taskId> [--timeout 120]
                                  Wait for Unity task to complete
  unity console [--type error|warning] [--count 10]
                                  Read Unity console messages
  
  help                            Show this help message

Workflow Types:
  - planning_new        Full planning loop (Context → Planner → Analysts → Finalize)
  - planning_revision   Quick revision (Planner → Codex → Finalize)
  - task_implementation Per-task execution (Context → Engineer → Review → Unity)
  - error_resolution    Fix compilation/test errors

Notes:
  - Session IDs start with 'ps_' (e.g., ps_000001)
  - Workflows are self-contained state machines that run concurrently
  - The UnifiedCoordinatorService manages all workflows for a session
  - Unity operations are serial (handled by UnityControlManager singleton)
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









