import * as vscode from 'vscode';
import { StateManager } from '../services/StateManager';
import { EngineerPoolService } from '../services/EngineerPoolService';
import { CoordinatorService } from '../services/CoordinatorService';
import { PlanningService } from '../services/PlanningService';
import { TerminalManager } from '../services/TerminalManager';
import { CliResponse, StatusResponse, PoolStatusResponse } from '../types';

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
  
  help                            Show this help message

Notes:
  - Session IDs start with 'ps_' (e.g., ps_000001)
  - Use the extension UI for individual engineer management
  - Unity operations are handled automatically by Unity Control Agent
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









