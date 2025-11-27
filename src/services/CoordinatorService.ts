import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { StateManager } from './StateManager';
import { EngineerPoolService } from './EngineerPoolService';
import { TerminalManager } from './TerminalManager';
import { CoordinatorState, CoordinatorStartResponse, EngineerSessionInfo } from '../types';

export class CoordinatorService {
    private stateManager: StateManager;
    private engineerPoolService: EngineerPoolService;
    private terminalManager: TerminalManager;
    private engineerProcesses: Map<string, ChildProcess> = new Map();

    constructor(
        stateManager: StateManager,
        engineerPoolService: EngineerPoolService,
        terminalManager: TerminalManager
    ) {
        this.stateManager = stateManager;
        this.engineerPoolService = engineerPoolService;
        this.terminalManager = terminalManager;
    }

    /**
     * Start a new coordinator for a plan
     */
    async startCoordinator(
        planPath: string,
        options: {
            mode?: 'auto' | 'interactive';
            engineerCount?: number;
            planSessionId?: string;
        } = {}
    ): Promise<{ coordinatorId: string; engineersAllocated: string[]; status: string }> {
        const coordinatorId = this.stateManager.generateCoordinatorId();
        const mode = options.mode || 'auto';
        
        // Determine how many engineers to allocate
        const requestedCount = options.engineerCount || this.getRecommendedEngineerCount(planPath);
        const availableEngineers = this.engineerPoolService.getAvailableEngineers();
        
        if (availableEngineers.length === 0) {
            throw new Error('No engineers available in the pool');
        }

        const engineerCount = Math.min(requestedCount, availableEngineers.length);
        const allocatedEngineers = this.engineerPoolService.allocateEngineers(coordinatorId, engineerCount);

        // Create coordinator state
        const coordinator: CoordinatorState = {
            id: coordinatorId,
            planPath: planPath,
            planSessionId: options.planSessionId,
            status: 'initializing',
            mode: mode,
            engineerSessions: {},
            planVersion: 1,
            progress: { completed: 0, total: 0, percentage: 0 },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        // Initialize engineer sessions
        for (const engineerName of allocatedEngineers) {
            const sessionId = this.stateManager.generateSessionId(engineerName);
            const logFile = path.join(
                this.stateManager.getWorkingDir(),
                'Logs',
                'engineers',
                `${engineerName}_${sessionId}.log`
            );

            coordinator.engineerSessions[engineerName] = {
                sessionId,
                status: 'starting',
                logFile,
                startTime: new Date().toISOString()
            };

            // Update pool with session info
            this.engineerPoolService.updateEngineerSession(engineerName, {
                sessionId,
                logFile
            });
        }

        // Save coordinator state
        this.stateManager.saveCoordinator(coordinator);

        // Start engineer sessions
        await this.startEngineerSessions(coordinator);

        // Update status to running
        coordinator.status = 'running';
        coordinator.updatedAt = new Date().toISOString();
        this.stateManager.saveCoordinator(coordinator);

        return {
            coordinatorId,
            engineersAllocated: allocatedEngineers,
            status: 'running'
        };
    }

    /**
     * Start engineer sessions for a coordinator
     */
    private async startEngineerSessions(coordinator: CoordinatorState): Promise<void> {
        const workspaceRoot = this.stateManager.getWorkspaceRoot();
        const settings = this.stateManager.getGlobalSettings();

        for (const [engineerName, sessionInfo] of Object.entries(coordinator.engineerSessions)) {
            // Ensure log file directory exists
            const logDir = path.dirname(sessionInfo.logFile);
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }

            // Create initial log file
            fs.writeFileSync(sessionInfo.logFile, `=== Engineer ${engineerName} Session ${sessionInfo.sessionId} ===\n`);
            fs.appendFileSync(sessionInfo.logFile, `Started: ${sessionInfo.startTime}\n`);
            fs.appendFileSync(sessionInfo.logFile, `Plan: ${coordinator.planPath}\n`);
            fs.appendFileSync(sessionInfo.logFile, `Mode: ${coordinator.mode}\n`);
            fs.appendFileSync(sessionInfo.logFile, `\n--- Session Output ---\n\n`);

            // Create terminal for this engineer
            const terminal = this.terminalManager.createEngineerTerminal(
                engineerName,
                sessionInfo.sessionId,
                sessionInfo.logFile,
                workspaceRoot
            );

            // Start tailing the log
            this.terminalManager.startLogTail(engineerName);

            // Start the actual engineer process (background)
            await this.startEngineerProcess(engineerName, coordinator, sessionInfo);

            // Update session status
            sessionInfo.status = 'working';
        }
    }

    /**
     * Start an individual engineer process
     */
    private async startEngineerProcess(
        engineerName: string,
        coordinator: CoordinatorState,
        sessionInfo: EngineerSessionInfo
    ): Promise<void> {
        const workspaceRoot = this.stateManager.getWorkspaceRoot();
        const settings = this.stateManager.getGlobalSettings();
        
        // For now, we'll use a simple approach - spawn cursor agent in background
        // In production, this would use run_engineer.sh or similar
        
        const backend = settings.defaultBackend;
        let command: string;
        let args: string[];

        // Build the instruction for the engineer
        const instruction = `You are engineer ${engineerName} working on plan: ${coordinator.planPath}. 
Your session ID is ${sessionInfo.sessionId}. 
Work on your assigned tasks from the plan.
Log your progress to: ${sessionInfo.logFile}`;

        if (backend === 'cursor') {
            command = 'cursor';
            args = ['agent', '--message', instruction];
        } else if (backend === 'claude-code') {
            command = 'claude';
            args = ['--message', instruction];
        } else {
            // Default to cursor
            command = 'cursor';
            args = ['agent', '--message', instruction];
        }

        try {
            // Spawn the process
            const process = spawn(command, args, {
                cwd: workspaceRoot,
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            // Pipe output to log file
            const logStream = fs.createWriteStream(sessionInfo.logFile, { flags: 'a' });
            process.stdout?.pipe(logStream);
            process.stderr?.pipe(logStream);

            // Store process reference
            this.engineerProcesses.set(engineerName, process);
            sessionInfo.processId = process.pid;

            // Handle process exit
            process.on('exit', (code) => {
                fs.appendFileSync(sessionInfo.logFile, `\n--- Process exited with code ${code} ---\n`);
                this.engineerProcesses.delete(engineerName);
                
                // Update coordinator state
                const coord = this.stateManager.getCoordinator(coordinator.id);
                if (coord && coord.engineerSessions[engineerName]) {
                    coord.engineerSessions[engineerName].status = code === 0 ? 'completed' : 'error';
                    coord.updatedAt = new Date().toISOString();
                    this.stateManager.saveCoordinator(coord);
                }
            });

            // Unref to allow parent to exit independently
            process.unref();

        } catch (error) {
            fs.appendFileSync(sessionInfo.logFile, `\n--- Error starting process: ${error} ---\n`);
            sessionInfo.status = 'error';
        }
    }

    /**
     * Stop a coordinator and release its engineers
     */
    async stopCoordinator(coordinatorId: string): Promise<void> {
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        if (!coordinator) {
            throw new Error(`Coordinator ${coordinatorId} not found`);
        }

        // Stop all engineer processes
        for (const [engineerName, sessionInfo] of Object.entries(coordinator.engineerSessions)) {
            await this.stopEngineer(engineerName);
        }

        // Release engineers back to pool
        this.engineerPoolService.releaseCoordinatorEngineers(coordinatorId);

        // Update coordinator status
        coordinator.status = 'stopped';
        coordinator.updatedAt = new Date().toISOString();
        this.stateManager.saveCoordinator(coordinator);
    }

    /**
     * Pause a coordinator
     */
    async pauseCoordinator(coordinatorId: string): Promise<void> {
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        if (!coordinator) {
            throw new Error(`Coordinator ${coordinatorId} not found`);
        }

        // Pause all engineer sessions
        for (const engineerName of Object.keys(coordinator.engineerSessions)) {
            await this.pauseEngineer(engineerName);
        }

        coordinator.status = 'paused';
        coordinator.updatedAt = new Date().toISOString();
        this.stateManager.saveCoordinator(coordinator);
    }

    /**
     * Resume a paused coordinator
     */
    async resumeCoordinator(coordinatorId: string): Promise<void> {
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        if (!coordinator || coordinator.status !== 'paused') {
            throw new Error(`Coordinator ${coordinatorId} not found or not paused`);
        }

        // Resume all engineer sessions
        for (const engineerName of Object.keys(coordinator.engineerSessions)) {
            await this.resumeEngineer(engineerName);
        }

        coordinator.status = 'running';
        coordinator.updatedAt = new Date().toISOString();
        this.stateManager.saveCoordinator(coordinator);
    }

    /**
     * Stop an individual engineer
     */
    async stopEngineer(engineerName: string): Promise<void> {
        const process = this.engineerProcesses.get(engineerName);
        if (process && !process.killed) {
            process.kill('SIGTERM');
        }
        this.engineerProcesses.delete(engineerName);
        this.terminalManager.closeEngineerTerminal(engineerName);
    }

    /**
     * Pause an individual engineer
     */
    async pauseEngineer(engineerName: string): Promise<void> {
        const process = this.engineerProcesses.get(engineerName);
        if (process && !process.killed) {
            process.kill('SIGSTOP');
        }
    }

    /**
     * Resume a paused engineer
     */
    async resumeEngineer(engineerName: string): Promise<void> {
        const process = this.engineerProcesses.get(engineerName);
        if (process && !process.killed) {
            process.kill('SIGCONT');
        }
    }

    /**
     * Get coordinator status
     */
    getCoordinatorStatus(coordinatorId: string): CoordinatorState | undefined {
        return this.stateManager.getCoordinator(coordinatorId);
    }

    /**
     * Get recommended engineer count based on plan analysis
     */
    private getRecommendedEngineerCount(planPath: string): number {
        // TODO: Analyze plan to determine optimal engineer count
        // For now, return a default
        return 3;
    }

    /**
     * Read engineer log
     */
    readEngineerLog(engineerName: string, lines?: number): string {
        const poolStatus = this.engineerPoolService.getEngineerStatus(engineerName);
        if (!poolStatus || !poolStatus.logFile) {
            return '';
        }

        if (!fs.existsSync(poolStatus.logFile)) {
            return '';
        }

        const content = fs.readFileSync(poolStatus.logFile, 'utf-8');
        if (lines) {
            const allLines = content.split('\n');
            return allLines.slice(-lines).join('\n');
        }
        return content;
    }
}










