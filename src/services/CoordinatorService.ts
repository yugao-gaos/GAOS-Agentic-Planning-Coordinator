import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ChildProcess } from 'child_process';
import { StateManager } from './StateManager';
import { EngineerPoolService } from './EngineerPoolService';
import { TerminalManager } from './TerminalManager';
import { PlanParser, ParsedPlan } from './PlanParser';
import { TaskManager, ManagedTask, EngineerAssignment, DispatchDecision } from './TaskManager';
import { UnityControlAgent } from './UnityControlAgent';
import { ErrorRouter } from './ErrorRouter';
import { OutputChannelManager } from './OutputChannelManager';
import { ProcessManager } from './ProcessManager';
import { UnityTask, UnityTaskResult, UnityError, TaskRequester } from '../types/unity';
import { CoordinatorState, CoordinatorStatus, EngineerSessionInfo, TaskProgress } from '../types';

// ============================================================================
// Coordinator Service - Dynamic Task Coordination
// ============================================================================

/**
 * Pending Unity request tracking
 */
interface PendingUnityRequest {
    unityTaskId: string;
    engineerName: string;
    taskId?: string;
    type: 'compile' | 'test_editmode' | 'test_playmode' | 'test_player';
    requestedAt: string;
}

/**
 * Coordinator Service
 * 
 * Manages plan execution with dynamic task dispatch:
 * - Tasks dispatched as soon as dependencies are met (no strict waves)
 * - Engineers immediately reassigned when they complete tasks
 * - Unity operations queued through UnityControlAgent
 * - Errors routed back to relevant engineers
 * - Engineers released when only sequential work remains
 */
export class CoordinatorService {
    private stateManager: StateManager;
    private engineerPoolService: EngineerPoolService;
    private terminalManager: TerminalManager;
    private processManager: ProcessManager;
    private outputManager: OutputChannelManager;

    // Active coordinators and their task managers
    private taskManagers: Map<string, TaskManager> = new Map();
    private pendingUnityRequests: Map<string, PendingUnityRequest[]> = new Map();
    
    // Track which plan session has an active coordinator
    private planSessionCoordinators: Map<string, string> = new Map();
    
    // Monitoring intervals per coordinator
    private monitoringIntervals: Map<string, NodeJS.Timeout> = new Map();
    
    // Track pending context agents per coordinator
    private pendingContextAgents: Map<string, Set<string>> = new Map();

    // Unity Control Agent reference
    private unityAgent: UnityControlAgent;
    private errorRouter: ErrorRouter | null = null;

    // Configuration
    private readonly CHECK_INTERVAL = 30000;  // 30 seconds check interval
    private readonly DEFAULT_TIMEOUT = 3600;  // 1 hour engineer timeout

    constructor(
        stateManager: StateManager,
        engineerPoolService: EngineerPoolService,
        terminalManager: TerminalManager
    ) {
        this.stateManager = stateManager;
        this.engineerPoolService = engineerPoolService;
        this.terminalManager = terminalManager;
        this.outputManager = OutputChannelManager.getInstance();
        this.processManager = ProcessManager.getInstance();
        
        // Set state directory for process manager
        this.processManager.setStateDir(stateManager.getWorkingDir());

        // Get Unity Control Agent singleton
        this.unityAgent = UnityControlAgent.getInstance();

        // Listen for Unity task completions
        this.unityAgent.onTaskCompleted((event) => {
            this.handleUnityTaskCompleted(event.task, event.result);
        });
    }

    /**
     * Initialize error router (needs workspace root)
     */
    initializeErrorRouter(workspaceRoot: string): void {
        this.errorRouter = new ErrorRouter(workspaceRoot);
    }

    /**
     * Start a new coordinator for a plan
     * Enforces one coordinator per plan session
     */
    async startCoordinator(
        planPath: string,
        options: {
            mode?: 'auto' | 'interactive';
            engineerCount?: number;
            planSessionId?: string;
            reuseCoordinatorId?: string;  // Reuse existing coordinator ID (for restart after stop)
        } = {}
    ): Promise<{ coordinatorId: string; engineersAllocated: string[]; status: string }> {
        // Enforce one coordinator per plan session
        if (options.planSessionId) {
            const existingCoordId = this.planSessionCoordinators.get(options.planSessionId);
            if (existingCoordId) {
                const existingCoord = this.stateManager.getCoordinator(existingCoordId);
                if (existingCoord && ['initializing', 'running', 'paused'].includes(existingCoord.status)) {
                    this.log(`Plan session ${options.planSessionId} already has active coordinator ${existingCoordId}. Stopping it first.`);
                    await this.stopCoordinator(existingCoordId);
                }
                this.planSessionCoordinators.delete(options.planSessionId);
            }
        }
        
        // IMPORTANT: Reuse coordinator ID if provided (for consistent ID across restart cycles)
        // Otherwise generate a new one from plan session ID
        const coordinatorId = options.reuseCoordinatorId || this.stateManager.generateCoordinatorId(options.planSessionId);
        
        if (options.reuseCoordinatorId) {
            this.log(`Reusing coordinator ID ${coordinatorId} for plan session ${options.planSessionId}`);
        }
        const mode = options.mode || 'auto';
        
        // Track this coordinator for the plan session
        if (options.planSessionId) {
            this.planSessionCoordinators.set(options.planSessionId, coordinatorId);
        }
        
        this.log(`Starting coordinator ${coordinatorId} for plan: ${planPath}`);

        // Step 1: Parse plan file
        const planData = PlanParser.parsePlanFile(planPath);
        this.logCoord(coordinatorId, `Plan loaded: ${planData.title}`);
        this.logCoord(coordinatorId, `Engineers in plan: ${planData.engineersNeeded.join(', ')}`);
        this.logCoord(coordinatorId, `Current progress: ${planData.metadata.progress.toFixed(1)}%`);

        // Check if already complete
        if (planData.metadata.progress >= 100) {
            this.log('Plan is already complete!');
            return {
                coordinatorId,
                engineersAllocated: [],
                status: 'completed'
            };
        }

        // Step 2: Create TaskManager and initialize from plan
        const taskManager = new TaskManager(coordinatorId, planPath);
        taskManager.initializeFromPlan(planData);
        this.taskManagers.set(coordinatorId, taskManager);
        this.pendingUnityRequests.set(coordinatorId, []);

        // Set up TaskManager callbacks
        taskManager.onTaskCompleted((task) => {
            this.onTaskCompleted(coordinatorId, task);
        });

        taskManager.onEngineerIdle((engineer) => {
            this.onEngineerIdle(coordinatorId, engineer);
        });

        // Step 3: Allocate engineers
        const requestedCount = options.engineerCount || planData.engineersNeeded.length || 3;
        const availableEngineers = this.engineerPoolService.getAvailableEngineers();
        
        if (availableEngineers.length === 0) {
            throw new Error('No engineers available in the pool');
        }

        const engineerCount = Math.min(requestedCount, availableEngineers.length);
        const allocatedEngineers = this.engineerPoolService.allocateEngineers(coordinatorId, engineerCount);

        this.log(`Allocated ${allocatedEngineers.length} engineers: ${allocatedEngineers.join(', ')}`);

        // Step 4: Create coordinator log file
        // Structure: _AiDevLog/Plans/{sessionId}/logs/coordinator.log
        const workspaceRoot = this.stateManager.getWorkspaceRoot();
        if (options.planSessionId) {
            this.stateManager.ensurePlanDirectories(options.planSessionId);
        }
        const coordinatorLogFile = options.planSessionId 
            ? this.stateManager.getCoordinatorLogPath(options.planSessionId)
            : path.join(this.stateManager.getWorkingDir(), 'Logs', 'coordinators', `${coordinatorId}.log`);
        
        // Write log header
        const logHeader = `
════════════════════════════════════════════════════════════
  COORDINATOR: ${coordinatorId}
════════════════════════════════════════════════════════════
Plan: ${planPath}
Started: ${new Date().toISOString()}
Engineers: ${allocatedEngineers.join(', ')}
Progress: ${planData.metadata.completedTasks}/${planData.metadata.totalTasks} (${planData.metadata.progress.toFixed(1)}%)
════════════════════════════════════════════════════════════

`;
        fs.writeFileSync(coordinatorLogFile, logHeader);
        
        // Step 5: Create coordinator state
        const coordinator: CoordinatorState = {
            id: coordinatorId,
            planPath: planPath,
            planSessionId: options.planSessionId,
            status: 'initializing',
            mode: mode,
            engineerSessions: {},
            planVersion: planData.version,
            progress: {
                completed: planData.metadata.completedTasks,
                total: planData.metadata.totalTasks,
                percentage: planData.metadata.progress
            },
            logFile: coordinatorLogFile,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        
        // Create coordinator terminal and start tailing
        this.terminalManager.createCoordinatorTerminal(coordinatorId, coordinatorLogFile, workspaceRoot);
        this.terminalManager.startCoordinatorLogTail(coordinatorId);

        // Step 5: Register engineers with TaskManager
        // Structure: _AiDevLog/Plans/{sessionId}/logs/engineers/{EngineerName}_{sessionId}.log
        for (const engineerName of allocatedEngineers) {
            const engineerSessionId = this.stateManager.generateSessionId(engineerName);
            const logFile = options.planSessionId
                ? path.join(this.stateManager.getEngineerLogsFolder(options.planSessionId), `${engineerName}_${engineerSessionId}.log`)
                : path.join(this.stateManager.getWorkingDir(), 'Logs', 'engineers', `${engineerName}_${engineerSessionId}.log`);

            // Register with TaskManager
            taskManager.registerEngineer(engineerName, engineerSessionId, logFile);

            // Add to coordinator state
            coordinator.engineerSessions[engineerName] = {
                sessionId: engineerSessionId,
                status: 'starting',
                logFile,
                startTime: new Date().toISOString()
            };

            // Update pool
            this.engineerPoolService.updateEngineerSession(engineerName, {
                sessionId: engineerSessionId,
                logFile
            });
        }

        // Save coordinator state
        this.stateManager.saveCoordinator(coordinator);

        // Step 6: Start coordination
        coordinator.status = 'running';
        this.stateManager.saveCoordinator(coordinator);

        // Initial dispatch
        await this.dispatchReadyTasks(coordinatorId);

        // Start monitoring loop
        this.startMonitoringLoop(coordinatorId);

        return {
            coordinatorId,
            engineersAllocated: allocatedEngineers,
            status: 'running'
        };
    }

    /**
     * Dispatch all ready tasks to idle engineers
     */
    private async dispatchReadyTasks(coordinatorId: string): Promise<void> {
        const taskManager = this.taskManagers.get(coordinatorId);
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        if (!taskManager || !coordinator) return;

        // Get dispatch decisions
        const decisions = taskManager.findDispatchDecisions();

        for (const decision of decisions) {
            this.logCoord(coordinatorId, `Dispatching: ${decision.engineer.engineerName} → ${decision.task.description.substring(0, 50)}...`);
            this.logCoord(coordinatorId, `  Reason: ${decision.reason}`);

            // Update TaskManager
            taskManager.dispatchTask(decision.task.id, decision.engineer.engineerName);

            // Start the engineer process
            await this.startEngineerOnTask(
                coordinatorId,
                decision.engineer,
                decision.task
            );

            // Update coordinator state
            const sessionInfo = coordinator.engineerSessions[decision.engineer.engineerName];
            if (sessionInfo) {
                sessionInfo.status = 'working';
                sessionInfo.task = decision.task.description;
                sessionInfo.lastActivity = new Date().toISOString();
            }

            // Stagger launches
            await this.sleep(2000);
        }

        coordinator.updatedAt = new Date().toISOString();
        this.stateManager.saveCoordinator(coordinator);
    }

    /**
     * Start an engineer working on a specific task
     */
    private async startEngineerOnTask(
        coordinatorId: string,
        engineer: EngineerAssignment,
        task: ManagedTask
    ): Promise<void> {
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        if (!coordinator) return;

        const workspaceRoot = this.stateManager.getWorkspaceRoot();

        // Ensure log directory exists
        const logDir = path.dirname(engineer.logFile);
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }

        // Create/append to log file
        const logHeader = `
========================================
Engineer: ${engineer.engineerName}
Session: ${engineer.sessionId}
Task ID: ${task.id}
Task: ${task.description}
Started: ${new Date().toISOString()}
Plan: ${coordinator.planPath}
Coordinator: ${coordinatorId}
========================================

`;
        fs.appendFileSync(engineer.logFile, logHeader);

        // Create terminal and start log tail for real-time streaming
        this.terminalManager.createEngineerTerminal(
            engineer.engineerName,
            engineer.sessionId,
            engineer.logFile,
            workspaceRoot
        );
        
        // Start streaming log file in terminal (tail -f)
        // This must be done BEFORE starting the process so we catch the header
        this.terminalManager.startStreamingLog(engineer.engineerName, engineer.logFile);

        // Start engineer process
        await this.startEngineerProcess(
            engineer.engineerName,
            coordinator.planPath,
            task,
            engineer.logFile,
            workspaceRoot,
            coordinatorId
        );

        // Update TaskManager
        const taskManager = this.taskManagers.get(coordinatorId);
        taskManager?.markTaskInProgress(task.id);
    }

    /**
     * Start engineer process using CursorAgentRunner (TypeScript-based)
     * This is more reliable than shell scripts and provides better tracking
     */
    private async startEngineerProcess(
        engineerName: string,
        planPath: string,
        task: ManagedTask,
        logFile: string,
        workspaceRoot: string,
        coordinatorId: string
    ): Promise<void> {
        // Import CursorAgentRunner
        const { CursorAgentRunner } = await import('./CursorAgentRunner');
        const agentRunner = CursorAgentRunner.getInstance();
        
        // Get coordinator for completion report path
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        const completionReportPath = coordinator 
            ? this.getCompletionReportPath(coordinator, task)
            : `_AiDevLog/Completions/${task.id}_completion.md`;

        // Build the prompt for the engineer
        const prompt = `You are ${engineerName}, a software engineer working on a Unity game project.

========================================
🎯 CURRENT TASK: ${task.id}
${task.description}
========================================

📋 REFERENCE: Read the full plan at ${planPath} for complete context.

🔧 AVAILABLE TOOLS:
- unityMCP for Unity operations (read/write scripts, manage GameObjects, run tests)
- File operations for reading/writing code
- Terminal commands for git, compilation, etc.

📜 WORKFLOW:
1. FIRST: Read previous session logs from the plan folder to understand context
2. Read relevant existing docs in _AiDevLog/Docs/ for your task
3. Implement the task following the plan's specifications
4. Check _AiDevLog/Errors/error_registry.md before fixing ANY error (avoid duplicate fixes)
5. UPDATE DOCS: Prefer updating existing docs. For new systems, add new doc.
6. Mark your checkbox [x] in the plan when task is complete
7. Write completion report to: ${completionReportPath}
   - Include: what was done, files created/modified, tests added
   - If blocked, write "BLOCKED: reason" in the report

⚠️ IMPORTANT:
- Follow existing code patterns in the codebase
- Write clean, well-documented code
- If you encounter an error that's already in error_registry.md, check the fix there first
- Context will be updated automatically by coordinator after task completion`;

        // Create unique process ID
        const processId = `engineer_${coordinatorId}_${engineerName}_${Date.now()}`;

        // Write header to log file
        const header = `
========================================
Engineer: ${engineerName}
Task ID: ${task.id}
Task: ${task.description}
Started: ${new Date().toISOString()}
Plan: ${planPath}
Coordinator: ${coordinatorId}
========================================

`;
        fs.appendFileSync(logFile, header);

        this.logCoord(coordinatorId, `🚀 Starting ${engineerName} on task ${task.id}`);

        // Run the agent asynchronously
        agentRunner.run({
            id: processId,
            prompt,
            cwd: workspaceRoot,
            model: 'sonnet-4.5',
            logFile,
            timeoutMs: this.DEFAULT_TIMEOUT * 1000,  // Convert to ms
            metadata: { engineerName, coordinatorId, taskId: task.id, planPath },
            onOutput: (text, type) => {
                // Stream output to terminal
                this.terminalManager.appendToTerminal(engineerName, text, type);
            },
            onProgress: (message) => {
                this.logCoord(coordinatorId, `[${engineerName}] ${message}`);
            },
            onStart: (pid) => {
                this.logCoord(coordinatorId, `[${engineerName}] Process started (PID: ${pid})`);
            }
        }).then((result) => {
            // Handle completion
            fs.appendFileSync(logFile, `\n\n--- Process exited with code ${result.exitCode} ---\n`);
            
            const taskManager = this.taskManagers.get(coordinatorId);
            if (taskManager) {
                if (result.success) {
                    taskManager.markTaskCompleted(task.id);
                } else if (result.error) {
                    taskManager.markTaskFailed(task.id, result.error);
                } else {
                    taskManager.markTaskFailed(task.id, `Exit code ${result.exitCode}`);
                }
            }
            
            const coordinator = this.stateManager.getCoordinator(coordinatorId);
            if (coordinator?.engineerSessions[engineerName]) {
                coordinator.engineerSessions[engineerName].status = result.success ? 'completed' : 'error';
                this.stateManager.saveCoordinator(coordinator);
            }

            // Show completion in output channel
            this.terminalManager.showTaskCompletion(
                engineerName, 
                result.success, 
                `Task: ${task.id}\nDuration: ${Math.round(result.durationMs / 1000)}s\nExit code: ${result.exitCode}`
            );

            this.logCoord(coordinatorId, `[${engineerName}] ${result.success ? '✅' : '❌'} Task ${task.id} finished (${Math.round(result.durationMs / 1000)}s)`);
        }).catch((err) => {
            this.logCoord(coordinatorId, `[${engineerName}] ❌ Error: ${err.message}`);
            this.terminalManager.showTaskCompletion(engineerName, false, `Error: ${err.message}`);
        });

        this.logCoord(coordinatorId, `Started ${engineerName} on task ${task.id}`);
    }

    /**
     * Callback when a task is completed
     */
    private onTaskCompleted(coordinatorId: string, task: ManagedTask): void {
        this.logCoord(coordinatorId, `✅ Task completed: ${task.id} by ${task.actualEngineer}`);

        // Spawn context agent to update context for the completed task (async, don't wait)
        this.spawnContextAgentForTask(coordinatorId, task).catch(e => 
            this.log(`Error spawning context agent: ${e}`)
        );

        // Update coordinator progress
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        const taskManager = this.taskManagers.get(coordinatorId);
        if (coordinator && taskManager) {
            const progress = taskManager.getProgress();
            coordinator.progress = {
                completed: progress.completed,
                total: progress.total,
                percentage: progress.percentage
            };
            coordinator.updatedAt = new Date().toISOString();
            this.stateManager.saveCoordinator(coordinator);

            // Check if all tasks complete - start review process
            if (progress.percentage >= 100) {
                this.logCoord(coordinatorId, `📋 All ${progress.total} tasks done. Starting review process...`);
                coordinator.status = 'reviewing';
                this.stateManager.saveCoordinator(coordinator);
                
                // Wait for context agents then do review (async)
                this.startReviewProcess(coordinatorId).catch(e => 
                    this.log(`Error during review: ${e}`)
                );
                return; // Stop monitoring loop
            }
        }
    }
    
    /**
     * Spawn a context agent to update context after a task is completed
     */
    private async spawnContextAgentForTask(coordinatorId: string, task: ManagedTask): Promise<void> {
        const taskManager = this.taskManagers.get(coordinatorId);
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        if (!taskManager || !coordinator) return;
        
        const engineer = taskManager.getEngineer(task.actualEngineer || '');
        if (!engineer) return;
        
        const workspaceRoot = this.stateManager.getWorkspaceRoot();
        const contextDir = path.join(workspaceRoot, '_AiDevLog', 'Context');
        
        // Get files modified by the engineer (from their session)
        const filesModified = engineer.filesModified || [];
        if (filesModified.length === 0) {
            this.logCoord(coordinatorId, `   ℹ️ No files modified for context update`);
            return;
        }
        
        this.logCoord(coordinatorId, `   📚 Spawning context agent for ${filesModified.length} modified files...`);
        
        const contextPrompt = `You are a Context Agent. Your job is to update the project context based on recent code changes.

TASK: Update context for the following files that were modified during task "${task.id}: ${task.description}":
${filesModified.map(f => `- ${f}`).join('\n')}

INSTRUCTIONS:
1. Read each modified file to understand what was added/changed
2. Update existing context files in ${contextDir}/ if the changes relate to existing systems
3. Only create NEW context files for genuinely new systems/components
4. Keep context concise and focused on:
   - What the system does
   - Key classes/interfaces
   - How to use it
   - Dependencies and relationships

IMPORTANT:
- Prefer updating existing context over creating new files
- Don't duplicate information that's already in the code comments
- Focus on architectural decisions and usage patterns`;

        // Track this context agent
        const processId = `context_${coordinatorId}_${task.id}`;
        if (!this.pendingContextAgents.has(coordinatorId)) {
            this.pendingContextAgents.set(coordinatorId, new Set());
        }
        this.pendingContextAgents.get(coordinatorId)!.add(processId);

        // Run context agent in background
        this.processManager.spawn(processId, 'cursor', [
            'agent',
            '--model', 'sonnet-4.5',
            '-p',
            '--force',
            contextPrompt
        ], {
            cwd: workspaceRoot,
            metadata: { coordinatorId, taskId: task.id, type: 'context_update' },
            onExit: (code) => {
                // Remove from pending
                this.pendingContextAgents.get(coordinatorId)?.delete(processId);
                
                if (code === 0) {
                    this.logCoord(coordinatorId, `   ✓ Context updated for task ${task.id}`);
                } else {
                    this.logCoord(coordinatorId, `   ⚠️ Context agent exited with code ${code}`);
                }
                
                // Check if we should proceed with review
                this.checkReviewReady(coordinatorId);
            }
        });
    }
    
    /**
     * Check if review process can proceed (all context agents done)
     */
    private checkReviewReady(coordinatorId: string): void {
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        if (!coordinator || coordinator.status !== 'reviewing') return;
        
        const pending = this.pendingContextAgents.get(coordinatorId);
        if (pending && pending.size > 0) {
            this.logCoord(coordinatorId, `   ⏳ Waiting for ${pending.size} context agent(s) to finish...`);
            return;
        }
        
        // All context agents done - proceed with review
        this.logCoord(coordinatorId, `   ✓ All context agents finished. Generating execution summary...`);
        this.generateExecutionSummary(coordinatorId).catch(e => 
            this.log(`Error generating summary: ${e}`)
        );
    }
    
    /**
     * Start the review process after all tasks complete
     */
    private async startReviewProcess(coordinatorId: string): Promise<void> {
        // Stop monitoring loop
        this.stopMonitoringLoop(coordinatorId);
        
        // Release all engineers
        await this.releaseAllEngineersAsync(coordinatorId);
        this.logCoord(coordinatorId, `   ✓ Released all engineers`);
        
        // Check if we can proceed immediately (no pending context agents)
        this.checkReviewReady(coordinatorId);
    }
    
    /**
     * Generate execution summary and complete the plan
     */
    private async generateExecutionSummary(coordinatorId: string): Promise<void> {
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        if (!coordinator) return;
        
        const workspaceRoot = this.stateManager.getWorkspaceRoot();
        
        // Structure: _AiDevLog/Plans/{sessionId}/summaries/execution_summary.md
        const summaryPath = coordinator.planSessionId
            ? this.stateManager.getExecutionSummaryPath(coordinator.planSessionId)
            : path.join(this.stateManager.getWorkingDir(), 'Summaries', `${coordinatorId}_summary.md`);
        
        // Ensure parent directory exists
        const summaryDir = path.dirname(summaryPath);
        if (!fs.existsSync(summaryDir)) {
            fs.mkdirSync(summaryDir, { recursive: true });
        }
        const planPath = coordinator.planPath;
        
        this.logCoord(coordinatorId, `   📝 Generating execution summary...`);
        
        // Generate summary using an agent
        const summaryPrompt = `You are a Project Coordinator reviewing a completed execution.

TASK: Generate an execution summary for the plan at: ${planPath}

Read the plan file and generate a comprehensive summary including:

1. **Execution Overview**
   - Plan title and scope
   - Total tasks completed
   - Engineers involved
   - Total execution time

2. **What Was Accomplished**
   - List each major feature/component implemented
   - Notable achievements

3. **Code Changes Summary**
   - New files created
   - Major modifications
   - New tests added

4. **Context Updates**
   - What documentation was updated
   - What context was added

5. **Known Issues / Follow-up Items**
   - Any incomplete items
   - Recommended next steps

6. **Quality Assessment**
   - Code quality observations
   - Test coverage assessment
   - Areas for improvement

Write this summary to: ${summaryPath}

Keep it concise but comprehensive. Use markdown formatting.`;

        const processId = `summary_${coordinatorId}`;
        
        return new Promise((resolve) => {
            this.processManager.spawn(processId, 'cursor', [
                'agent',
                '--model', 'sonnet-4.5',
                '-p',
                '--force',
                summaryPrompt
            ], {
                cwd: workspaceRoot,
                metadata: { coordinatorId, type: 'execution_summary' },
                onExit: async (code) => {
                    if (code === 0) {
                        this.logCoord(coordinatorId, `   ✓ Execution summary generated`);
                        
                        // Update coordinator with summary path
                        coordinator.executionSummaryPath = summaryPath;
                        coordinator.status = 'completed';
                        coordinator.updatedAt = new Date().toISOString();
                        this.stateManager.saveCoordinator(coordinator);
                        
                        this.logCoord(coordinatorId, `🎉 EXECUTION COMPLETED!`);
                        this.logCoord(coordinatorId, `   Summary: ${summaryPath}`);
                        
                        // Final cleanup
                        await this.cleanupOnCompletion(coordinatorId);
                    } else {
                        this.logCoord(coordinatorId, `   ⚠️ Summary generation failed (code ${code}). Completing anyway.`);
                        
                        // Complete without summary
                        coordinator.status = 'completed';
                        coordinator.updatedAt = new Date().toISOString();
                        this.stateManager.saveCoordinator(coordinator);
                        
                        await this.cleanupOnCompletion(coordinatorId);
                    }
                    resolve();
                }
            });
        });
    }
    
    /**
     * Full cleanup when execution completes
     */
    private async cleanupOnCompletion(coordinatorId: string): Promise<void> {
        this.logCoord(coordinatorId, `🧹 Cleaning up after completion...`);
        
        // Stop monitoring loop
        this.stopMonitoringLoop(coordinatorId);
        
        // Release all engineers
        await this.releaseAllEngineersAsync(coordinatorId);
        this.logCoord(coordinatorId, `   ✓ Released all engineers`);
        
        // Clean up task manager
        this.taskManagers.delete(coordinatorId);
        
        // Clean up pending Unity requests
        this.pendingUnityRequests.delete(coordinatorId);
        
        // Clean up temp files
        await this.cleanupCoordinatorFiles(coordinatorId);
        this.logCoord(coordinatorId, `   ✓ Cleaned up temp files`);
        
        // Close coordinator terminal after a short delay (so user can see the completion message)
        setTimeout(() => {
            this.terminalManager.closeCoordinatorTerminal(coordinatorId);
        }, 5000); // 5 second delay before closing terminal
        
        this.logCoord(coordinatorId, `🎉 Cleanup complete. Terminal will close in 5 seconds.`);
    }

    /**
     * Callback when an engineer becomes idle
     */
    private async onEngineerIdle(coordinatorId: string, engineer: EngineerAssignment): Promise<void> {
        this.log(`Engineer idle: ${engineer.engineerName}`);

        const taskManager = this.taskManagers.get(coordinatorId);
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        if (!taskManager || !coordinator || coordinator.status !== 'running') return;

        // Check for more work
        const nextTask = taskManager.getBestTaskForEngineer(engineer.engineerName);

        if (nextTask) {
            // Dispatch next task
            this.log(`Assigning next task to ${engineer.engineerName}: ${nextTask.id}`);
            taskManager.dispatchTask(nextTask.id, engineer.engineerName);
            await this.startEngineerOnTask(coordinatorId, engineer, nextTask);
        } else {
            // Check if we should release this engineer
            const toRelease = taskManager.getEngineersToRelease();
            if (toRelease.some(e => e.engineerName === engineer.engineerName)) {
                this.log(`Releasing engineer ${engineer.engineerName} (no more parallel work)`);
                await this.releaseEngineerAsync(coordinatorId, engineer.engineerName);
            } else {
                this.log(`${engineer.engineerName} waiting for dependencies to clear`);
            }
        }
    }

    /**
     * Request Unity compilation for an engineer
     */
    async requestCompilation(coordinatorId: string, engineerName: string): Promise<string> {
        const taskManager = this.taskManagers.get(coordinatorId);
        const engineer = taskManager?.getAllEngineers().find(e => e.engineerName === engineerName);

        if (!engineer) {
            throw new Error(`Engineer ${engineerName} not found in coordinator ${coordinatorId}`);
        }

        // Mark task as waiting for Unity
        if (engineer.currentTask) {
            taskManager!.markTaskWaitingUnity(engineer.currentTask.id, 'compile');
        }

        // Queue with Unity Control Agent
        const unityTaskId = this.unityAgent.queueTask('prep_editor', {
            coordinatorId,
            engineerName
        });

        // Track the request
        const requests = this.pendingUnityRequests.get(coordinatorId) || [];
        requests.push({
            unityTaskId,
            engineerName,
            taskId: engineer.currentTask?.id,
            type: 'compile',
            requestedAt: new Date().toISOString()
        });
        this.pendingUnityRequests.set(coordinatorId, requests);

        this.log(`Queued compilation for ${engineerName} (Unity task: ${unityTaskId})`);
        return unityTaskId;
    }

    /**
     * Request Unity test for an engineer
     */
    async requestTest(
        coordinatorId: string,
        engineerName: string,
        testType: 'editmode' | 'playmode' | 'player'
    ): Promise<string> {
        const taskManager = this.taskManagers.get(coordinatorId);
        const engineer = taskManager?.getAllEngineers().find(e => e.engineerName === engineerName);

        if (!engineer) {
            throw new Error(`Engineer ${engineerName} not found`);
        }

        // Map test type to Unity task type
        const unityTaskType = testType === 'editmode' ? 'test_framework_editmode' :
                             testType === 'playmode' ? 'test_framework_playmode' :
                             'test_player_playmode';

        // Mark task as waiting
        if (engineer.currentTask) {
            taskManager!.markTaskWaitingUnity(engineer.currentTask.id, testType);
        }

        // Queue with Unity Control Agent
        const unityTaskId = this.unityAgent.queueTask(unityTaskType, {
            coordinatorId,
            engineerName
        });

        // Track request
        const requests = this.pendingUnityRequests.get(coordinatorId) || [];
        requests.push({
            unityTaskId,
            engineerName,
            taskId: engineer.currentTask?.id,
            type: `test_${testType}` as any,
            requestedAt: new Date().toISOString()
        });
        this.pendingUnityRequests.set(coordinatorId, requests);

        this.log(`Queued ${testType} test for ${engineerName} (Unity task: ${unityTaskId})`);
        return unityTaskId;
    }

    /**
     * Handle Unity task completion (callback from UnityControlAgent)
     */
    private async handleUnityTaskCompleted(task: UnityTask, result: UnityTaskResult): Promise<void> {
        this.log(`Unity task completed: ${task.id} (${task.type}) - ${result.success ? 'SUCCESS' : 'ERRORS'}`);

        // Find all coordinators that had pending requests for this task
        for (const [coordinatorId, requests] of this.pendingUnityRequests.entries()) {
            const relevantRequests = requests.filter(r => r.unityTaskId === task.id);
            if (relevantRequests.length === 0) continue;

            const taskManager = this.taskManagers.get(coordinatorId);
            const coordinator = this.stateManager.getCoordinator(coordinatorId);
            if (!taskManager || !coordinator) continue;

            for (const request of relevantRequests) {
                const engineer = taskManager.getAllEngineers()
                    .find(e => e.engineerName === request.engineerName);
                if (!engineer) continue;

                // Check if engineer has this in waiting tasks
                const waitingTask = taskManager.getWaitingTasks(request.engineerName)
                    .find(w => w.unityTaskId === task.id);

                if (waitingTask) {
                    // Engineer was freed to do other work - restart with result
                    this.log(`${request.engineerName}: Has waiting task, will restart with result`);

                    // Route errors if any
                    if (result.errors.length > 0) {
                        for (const error of result.errors) {
                            taskManager.assignErrorToEngineer(
                                request.engineerName,
                                error.id,
                                error.file ? [error.file] : []
                            );
                        }
                    }

                    // Restart engineer with result context
                    await this.restartEngineerWithResult(
                        coordinatorId,
                        request.engineerName,
                        waitingTask,
                        result
                    );

                } else if (engineer.status === 'waiting') {
                    // Engineer was paused (short wait) - resume with result
                    this.log(`${request.engineerName}: Was paused, resuming with result`);

                    if (result.success) {
                        // Advance task stage
                        if (engineer.currentTask) {
                            taskManager.advanceTaskStage(engineer.currentTask.id);
                        }
                        this.notifyEngineerToContinue(engineer);
                        await this.resumeEngineer(request.engineerName);
                        engineer.status = 'working';
                    } else {
                        // Route errors
                        for (const error of result.errors) {
                            taskManager.assignErrorToEngineer(
                                request.engineerName,
                                error.id,
                                error.file ? [error.file] : []
                            );
                            this.notifyEngineerOfError(engineer, error);
                        }
                        if (engineer.currentTask) {
                            taskManager.setTaskErrorFixing(engineer.currentTask.id);
                        }
                        await this.resumeEngineer(request.engineerName);
                        engineer.status = 'error_fixing';
                    }

                } else {
                    // Engineer still running - just notify via log
                    this.log(`${request.engineerName}: Still running, notifying via log`);

                    if (result.success) {
                        if (engineer.currentTask) {
                            taskManager.advanceTaskStage(engineer.currentTask.id);
                        }
                        this.notifyEngineerToContinue(engineer);
                    } else {
                        for (const error of result.errors) {
                            taskManager.assignErrorToEngineer(
                                request.engineerName,
                                error.id,
                                error.file ? [error.file] : []
                            );
                            this.notifyEngineerOfError(engineer, error);
                        }
                        if (engineer.currentTask) {
                            taskManager.setTaskErrorFixing(engineer.currentTask.id);
                        }
                    }
                }
                
                // Update coordinator state
                const sessionInfo = coordinator.engineerSessions[request.engineerName];
                if (sessionInfo) {
                    sessionInfo.lastActivity = new Date().toISOString();
                }
            }

            // Remove processed requests
            const remaining = requests.filter(r => r.unityTaskId !== task.id);
            this.pendingUnityRequests.set(coordinatorId, remaining);

            // Save coordinator state
            coordinator.updatedAt = new Date().toISOString();
            this.stateManager.saveCoordinator(coordinator);
        }
    }

    /**
     * Notify engineer of error to fix (append to their log)
     */
    private notifyEngineerOfError(engineer: EngineerAssignment, error: UnityError): void {
        const notification = `

========================================
⚠️ ERROR ASSIGNED TO YOU
========================================
Error ID: ${error.id}
Code: ${error.code || 'N/A'}
File: ${error.file || 'Unknown'}
Line: ${error.line || 'N/A'}
Message: ${error.message}

IMPORTANT: Check _AiDevLog/Errors/error_registry.md first!
Mark your status as FIXING before starting work.
========================================

`;
        fs.appendFileSync(engineer.logFile, notification);
    }

    /**
     * Notify engineer to continue after successful Unity operation
     */
    private notifyEngineerToContinue(engineer: EngineerAssignment): void {
        const notification = `

========================================
✅ UNITY OPERATION COMPLETE
========================================
No errors found. You may continue with your task.
========================================

`;
        fs.appendFileSync(engineer.logFile, notification);
    }

    /**
     * Start monitoring loop for a coordinator
     */
    private startMonitoringLoop(coordinatorId: string): void {
        const monitor = async () => {
            const coordinator = this.stateManager.getCoordinator(coordinatorId);
            if (!coordinator || coordinator.status !== 'running') {
                return; // Stop monitoring
            }

            const taskManager = this.taskManagers.get(coordinatorId);
            if (!taskManager) return;

            // Check engineer logs for UNITY_REQUEST markers
            await this.checkEngineerUnityRequests(coordinatorId);

            // Refresh from plan file (check for manual checkbox updates)
            taskManager.refreshFromPlan();

            // Log status
            const progress = taskManager.getProgress();
            this.logCoord(coordinatorId, `Progress: ${progress.completed}/${progress.total} (${progress.percentage.toFixed(1)}%)`);
            this.logCoord(coordinatorId, `  In progress: ${progress.inProgress}, Ready: ${progress.ready}, Pending: ${progress.pending}`);

            // Check for idle engineers and dispatch
            await this.dispatchReadyTasks(coordinatorId);

            // Check for engineers to release
            const toRelease = taskManager.getEngineersToRelease();
            if (toRelease.length > 0) {
                const readyTasks = taskManager.getReadyTasks().length;
                const pendingTasks = progress.pending;
                this.logCoord(coordinatorId, `📤 Releasing ${toRelease.length} idle engineer(s)`);
                this.logCoord(coordinatorId, `   Reason: ${readyTasks} ready tasks, ${pendingTasks} pending (waiting on dependencies)`);
                
                for (const engineer of toRelease) {
                    this.logCoord(coordinatorId, `   → ${engineer.engineerName} released back to pool`);
                    await this.releaseEngineerAsync(coordinatorId, engineer.engineerName);
                }
            }

            // Update coordinator state
            coordinator.progress = {
                completed: progress.completed,
                total: progress.total,
                percentage: progress.percentage
            };
            coordinator.updatedAt = new Date().toISOString();
            this.stateManager.saveCoordinator(coordinator);

            // Schedule next check
            setTimeout(monitor, this.CHECK_INTERVAL);
        };

        // Start first check
        setTimeout(monitor, this.CHECK_INTERVAL);
    }

    /**
     * Check engineer logs for UNITY_REQUEST markers and process them
     */
    private async checkEngineerUnityRequests(coordinatorId: string): Promise<void> {
        const taskManager = this.taskManagers.get(coordinatorId);
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        if (!taskManager || !coordinator) return;

        // Track processed requests to avoid duplicates
        const processedKey = `${coordinatorId}_processed_requests`;
        if (!this.processedUnityRequests) {
            this.processedUnityRequests = new Map();
        }
        const processed = this.processedUnityRequests.get(processedKey) || new Set<string>();

        for (const engineer of taskManager.getAllEngineers()) {
            if (!fs.existsSync(engineer.logFile)) continue;

            // Read last 2000 chars of log (recent activity)
            const stats = fs.statSync(engineer.logFile);
            const readSize = Math.min(stats.size, 2000);
            const fd = fs.openSync(engineer.logFile, 'r');
            const buffer = Buffer.alloc(readSize);
            fs.readSync(fd, buffer, 0, readSize, Math.max(0, stats.size - readSize));
            fs.closeSync(fd);
            const recentLog = buffer.toString('utf-8');

            // Look for UNITY_REQUEST markers
            const requestPattern = /UNITY_REQUEST:(compile|test_editmode|test_playmode|test_player)/gi;
            let match;
            while ((match = requestPattern.exec(recentLog)) !== null) {
                const requestType = match[1].toLowerCase();
                const requestKey = `${engineer.engineerName}_${requestType}_${stats.mtimeMs}`;

                // Skip if already processed
                if (processed.has(requestKey)) continue;
                processed.add(requestKey);

                this.log(`Detected UNITY_REQUEST:${requestType} from ${engineer.engineerName}`);

                // Handle the request with stop/resume or task-switch logic
                await this.handleUnityRequest(
                    coordinatorId,
                    engineer.engineerName,
                    requestType as 'compile' | 'test_editmode' | 'test_playmode' | 'test_player'
                );
            }

            // Check for BLOCKED marker
            if (recentLog.includes('BLOCKED:')) {
                const blockMatch = recentLog.match(/BLOCKED:\s*(.+?)(?:\n|$)/);
                if (blockMatch) {
                    this.log(`${engineer.engineerName} is BLOCKED: ${blockMatch[1]}`);
                }
            }
        }

        this.processedUnityRequests.set(processedKey, processed);
    }

    // Track processed Unity requests to avoid duplicates
    private processedUnityRequests: Map<string, Set<string>> = new Map();

    /**
     * Handle a Unity request with intelligent wait management
     */
    private async handleUnityRequest(
        coordinatorId: string,
        engineerName: string,
        requestType: 'compile' | 'test_editmode' | 'test_playmode' | 'test_player'
    ): Promise<void> {
        const taskManager = this.taskManagers.get(coordinatorId);
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        if (!taskManager || !coordinator) return;

        const engineer = taskManager.getAllEngineers().find(e => e.engineerName === engineerName);
        if (!engineer) return;

        // Map request type to Unity task type
        const unityTaskType = requestType === 'compile' ? 'prep_editor' :
                            requestType === 'test_editmode' ? 'test_framework_editmode' :
                            requestType === 'test_playmode' ? 'test_framework_playmode' :
                            'test_player_playmode';

        // Get estimated wait time
        const estimatedWaitMs = this.unityAgent.getEstimatedWaitTime(unityTaskType);
        this.log(`${engineerName}: Estimated wait for ${requestType}: ${Math.round(estimatedWaitMs / 1000)}s`);

        // Update task stage
        if (engineer.currentTask) {
            if (requestType === 'compile') {
                engineer.currentTask.stage = 'compiling';
            } else if (requestType === 'test_editmode') {
                engineer.currentTask.stage = 'testing_editmode';
            } else if (requestType === 'test_playmode') {
                engineer.currentTask.stage = 'testing_playmode';
            }
        }

        // Queue the Unity task
        const unityTaskId = this.unityAgent.queueTask(unityTaskType, {
            coordinatorId,
            engineerName
        });

        // Track the request
        const requests = this.pendingUnityRequests.get(coordinatorId) || [];
        requests.push({
            unityTaskId,
            engineerName,
            taskId: engineer.currentTask?.id,
            type: requestType as any,
            requestedAt: new Date().toISOString()
        });
        this.pendingUnityRequests.set(coordinatorId, requests);

        // Decision: Stop and wait, or let engineer work on something else
        const WAIT_THRESHOLD_MS = 60000; // 60 seconds

        if (estimatedWaitMs > WAIT_THRESHOLD_MS) {
            // Long wait - save context and free engineer for other work
            this.log(`${engineerName}: Wait > 60s, freeing for other work`);

            // Save session context
            if (engineer.currentTask) {
                taskManager.saveSessionContext(
                    engineerName,
                    `Waiting for ${requestType} to complete. Task ${engineer.currentTask.id} at stage: ${engineer.currentTask.stage}`,
                    engineer.currentTask.filesModified
                );

                // Add to waiting tasks
                taskManager.addWaitingTask(
                    engineerName,
                    engineer.currentTask,
                    unityTaskId,
                    requestType as any,
                    estimatedWaitMs
                );
            }

            // Stop the engineer process
            await this.stopEngineer(engineerName);

            // Update engineer status
            engineer.status = 'waiting';
            engineer.currentTask = undefined;

            // Notify engineer log
            fs.appendFileSync(engineer.logFile, `
========================================
⏳ UNITY REQUEST QUEUED
========================================
Request: ${requestType}
Estimated wait: ${Math.round(estimatedWaitMs / 1000)} seconds
Status: Your session is paused. You will be restarted when:
  - Unity operation completes (with result)
  - OR another task becomes available
========================================
`);

            // Check if there's another task this engineer can do
            const nextTask = taskManager.getBestTaskForEngineer(engineerName);
            if (nextTask) {
                this.log(`${engineerName}: Has another task available, will dispatch`);
                // Will be picked up by regular dispatch cycle
            }

        } else {
            // Short wait - stop engineer, wait for result, then resume
            this.log(`${engineerName}: Wait < 60s, will resume after result`);

            // Stop the engineer process
            await this.pauseEngineer(engineerName);

            // Update status
            engineer.status = 'waiting';

            // Notify engineer log
            fs.appendFileSync(engineer.logFile, `
========================================
⏳ UNITY REQUEST PROCESSING
========================================
Request: ${requestType}
Estimated wait: ${Math.round(estimatedWaitMs / 1000)} seconds
Status: Please wait for result...
========================================
`);
        }
    }

    /**
     * Handle Unity result for stopped engineer - restart with context
     */
    private async restartEngineerWithResult(
        coordinatorId: string,
        engineerName: string,
        waitingTask: import('./TaskManager').WaitingTask,
        result: UnityTaskResult
    ): Promise<void> {
        const taskManager = this.taskManagers.get(coordinatorId);
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        if (!taskManager || !coordinator) return;

        const engineer = taskManager.getAllEngineers().find(e => e.engineerName === engineerName);
        if (!engineer) return;

        // Get continuation context
        const context = taskManager.getContinuationContext(engineerName);

        // Build continuation prompt
        let continuationPrompt: string;

        if (result.success) {
            // Success - advance stage and continue
            taskManager.advanceTaskStage(waitingTask.task.id);

            continuationPrompt = `
You are ${engineerName}, continuing your work.

📋 PREVIOUS SESSION SUMMARY:
${context?.summary || 'No previous summary'}

✅ UNITY RESULT: SUCCESS
Your ${waitingTask.waitingFor} completed without errors.

🎯 CONTINUE WITH:
Task: ${waitingTask.task.description}
Current stage: ${waitingTask.task.stage}

Please continue where you left off. If task is complete, mark checkbox [x] in plan.
`;
        } else {
            // Errors - need to fix
            taskManager.setTaskErrorFixing(waitingTask.task.id);

            const errorSummary = result.errors.map(e =>
                `- ${e.code || 'Error'}: ${e.message} (${e.file || 'unknown'}:${e.line || '?'})`
            ).join('\n');

            continuationPrompt = `
You are ${engineerName}, continuing your work.

📋 PREVIOUS SESSION SUMMARY:
${context?.summary || 'No previous summary'}

❌ UNITY RESULT: ERRORS FOUND
${errorSummary}

🔧 YOUR TASK:
1. Check _AiDevLog/Errors/error_registry.md for your assigned errors
2. Fix the errors assigned to you
3. Write UNITY_REQUEST:compile to verify fixes

Previous task: ${waitingTask.task.description}
Files modified: ${waitingTask.task.filesModified.join(', ') || 'unknown'}
`;
        }

        // Remove from waiting tasks
        taskManager.removeWaitingTask(engineerName, waitingTask.unityTaskId);

        // Set the task back as current
        engineer.currentTask = waitingTask.task;
        engineer.status = 'working';

        // Start new engineer session with continuation prompt
        this.log(`${engineerName}: Restarting with ${result.success ? 'success' : 'error'} context`);
        await this.startEngineerWithContinuation(
            coordinatorId,
            engineer,
            waitingTask.task,
            continuationPrompt
        );
    }

    /**
     * Start engineer with continuation context
     */
    private async startEngineerWithContinuation(
        coordinatorId: string,
        engineer: import('./TaskManager').EngineerAssignment,
        task: import('./TaskManager').ManagedTask,
        continuationPrompt: string
    ): Promise<void> {
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        if (!coordinator) return;

        const workspaceRoot = this.stateManager.getWorkspaceRoot();

        // Append continuation header to log
        fs.appendFileSync(engineer.logFile, `
========================================
🔄 SESSION CONTINUATION
========================================
Time: ${new Date().toISOString()}
Task: ${task.id}
Stage: ${task.stage}
========================================

`);

        // Start new cursor agent with continuation prompt using ProcessManager
        const processId = `engineer_${coordinatorId}_${engineer.engineerName}`;
        
        this.processManager.spawn(processId, 'cursor', [
            'agent',
            '--model', 'sonnet-4.5',
            '-p',
            '--force',
            '--approve-mcps',
            continuationPrompt
        ], {
            cwd: workspaceRoot,
            metadata: {
                engineerName: engineer.engineerName,
                coordinatorId,
                taskId: task.id,
                continuation: true
            },
            onOutput: (data) => {
                fs.appendFileSync(engineer.logFile, data);
            },
            onExit: (code) => {
                fs.appendFileSync(engineer.logFile, `\n--- Process exited with code ${code} ---\n`);
            }
        });
    }

    /**
     * Stop a coordinator - comprehensive cleanup
     */
    async stopCoordinator(coordinatorId: string): Promise<void> {
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        if (!coordinator) {
            throw new Error(`Coordinator ${coordinatorId} not found`);
        }

        this.logCoord(coordinatorId, `⏹️ STOPPING coordinator...`);

        // Stop monitoring loop
        this.stopMonitoringLoop(coordinatorId);

        // Release all engineers (stops processes, closes terminals, releases to pool)
        await this.releaseAllEngineersAsync(coordinatorId);

        // Clean up task manager
        const taskManager = this.taskManagers.get(coordinatorId);
        if (taskManager) {
            this.taskManagers.delete(coordinatorId);
        }
        
        // Clean up pending Unity requests
        this.pendingUnityRequests.delete(coordinatorId);
        
        // Clean up plan session coordinator mapping
        if (coordinator.planSessionId) {
            this.planSessionCoordinators.delete(coordinator.planSessionId);
        }

        // Clean up temporary files
        await this.cleanupCoordinatorFiles(coordinatorId);
        
        // Close coordinator terminal
        this.terminalManager.closeCoordinatorTerminal(coordinatorId);

        // Update status
        coordinator.status = 'stopped';
        coordinator.updatedAt = new Date().toISOString();
        this.stateManager.saveCoordinator(coordinator);

        this.logCoord(coordinatorId, `Coordinator stopped and cleaned up`);
    }

    /**
     * Pause a coordinator - saves engineer states for resume
     */
    async pauseCoordinator(coordinatorId: string): Promise<void> {
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        if (!coordinator) {
            throw new Error(`Coordinator ${coordinatorId} not found`);
        }

        this.logCoord(coordinatorId, `⏸️ PAUSING coordinator...`);

        // Stop monitoring loop
        this.stopMonitoringLoop(coordinatorId);

        // Pause all engineer processes (saves state for resume)
        const engineers = Object.keys(coordinator.engineerSessions);
        for (const engineerName of engineers) {
            const processId = `engineer_${coordinatorId}_${engineerName}`;
            await this.processManager.pauseProcess(processId);
            
            // Update engineer session status
            const session = coordinator.engineerSessions[engineerName];
            if (session) {
                session.status = 'paused';
            }
            this.logCoord(coordinatorId, `  Paused engineer: ${engineerName}`);
        }

        coordinator.status = 'paused';
        coordinator.updatedAt = new Date().toISOString();
        this.stateManager.saveCoordinator(coordinator);
        
        this.logCoord(coordinatorId, `⏸️ PAUSED (${engineers.length} engineers paused)`);
        this.logCoord(coordinatorId, `   Terminals remain open for viewing logs.`);
        this.logCoord(coordinatorId, `   Use Resume to continue execution.`);
    }

    /**
     * Resume a paused coordinator - restarts work with fresh engineer allocation
     */
    async resumeCoordinator(coordinatorId: string): Promise<void> {
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        if (!coordinator || coordinator.status !== 'paused') {
            throw new Error(`Coordinator ${coordinatorId} not found or not paused`);
        }

        this.logCoord(coordinatorId, `▶️ RESUMING coordinator...`);

        const taskManager = this.taskManagers.get(coordinatorId);
        
        // Reset any in-progress tasks back to ready since processes were killed on pause
        if (taskManager) {
            const resetCount = taskManager.resetAllInProgressTasks();
            if (resetCount > 0) {
                this.logCoord(coordinatorId, `  Reset ${resetCount} in-progress tasks back to ready`);
            }
        }

        // Close old engineer terminals and release engineers
        const engineers = Object.keys(coordinator.engineerSessions);
        for (const engineerName of engineers) {
            // Stop any lingering processes
            const processId = `engineer_${coordinatorId}_${engineerName}`;
            await this.processManager.stopProcess(processId, true);
            
            // Close the old terminal
            this.terminalManager.closeEngineerTerminal(engineerName);
            
            // Release engineer back to pool
            this.engineerPoolService.releaseEngineers([engineerName]);
            this.logCoord(coordinatorId, `  Released engineer: ${engineerName}`);
        }
        
        // Clear engineer sessions - will be rebuilt by dispatch
        coordinator.engineerSessions = {};

        coordinator.status = 'running';
        coordinator.updatedAt = new Date().toISOString();
        this.stateManager.saveCoordinator(coordinator);

        // Restart monitoring
        this.startMonitoringLoop(coordinatorId);
        
        this.logCoord(coordinatorId, `▶️ RESUMED - dispatching tasks...`);
        
        // Dispatch ready tasks to fresh engineers (this creates new terminals)
        await this.dispatchReadyTasks(coordinatorId);
        
        this.logCoord(coordinatorId, `▶️ Coordinator running with fresh engineer allocation`);
    }
    
    /**
     * Stop monitoring loop for a coordinator
     */
    private stopMonitoringLoop(coordinatorId: string): void {
        const interval = this.monitoringIntervals.get(coordinatorId);
        if (interval) {
            clearInterval(interval);
            this.monitoringIntervals.delete(coordinatorId);
        }
    }
    
    /**
     * Clean up temporary files for a coordinator
     */
    private async cleanupCoordinatorFiles(coordinatorId: string): Promise<void> {
        const workingDir = this.stateManager.getWorkingDir();
        
        // Clean up paused process states (in OS temp dir)
        const pauseDir = path.join(os.tmpdir(), 'apc_paused_processes');
        if (fs.existsSync(pauseDir)) {
            try {
                const files = fs.readdirSync(pauseDir);
                for (const file of files) {
                    if (file.includes(coordinatorId)) {
                        fs.unlinkSync(path.join(pauseDir, file));
                    }
                }
            } catch (e) {
                // Ignore cleanup errors
            }
        }
    }
    
    /**
     * Handle engineer process exit
     */
    private handleEngineerExit(coordinatorId: string, engineerName: string, code: number | null): void {
        this.log(`Engineer ${engineerName} exited with code ${code}`);
        
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        if (!coordinator) return;
        
        const session = coordinator.engineerSessions[engineerName];
        if (session) {
            session.status = code === 0 ? 'completed' : 'error';
        }
        
        // Notify task manager
        const taskManager = this.taskManagers.get(coordinatorId);
        if (taskManager) {
            const engineer = taskManager.getEngineer(engineerName);
            if (engineer?.currentTask) {
                const taskId = engineer.currentTask.id;
                if (code === 0) {
                    taskManager.markTaskCompleted(taskId);
                } else {
                    taskManager.markTaskFailed(taskId, `Exit code ${code}`);
                }
            }
        }
        
        coordinator.updatedAt = new Date().toISOString();
        this.stateManager.saveCoordinator(coordinator);
    }
    
    /**
     * Release all engineers from coordinator (async version)
     */
    private async releaseAllEngineersAsync(coordinatorId: string): Promise<void> {
        const taskManager = this.taskManagers.get(coordinatorId);
        if (!taskManager) return;

        const engineers = taskManager.getAllEngineers();
        
        // Stop all processes in parallel
        await Promise.all(engineers.map(async (engineer) => {
            await this.releaseEngineerAsync(coordinatorId, engineer.engineerName);
        }));
    }
    
    /**
     * Release an engineer from coordinator (async version)
     */
    private async releaseEngineerAsync(coordinatorId: string, engineerName: string): Promise<void> {
        const taskManager = this.taskManagers.get(coordinatorId);
        const coordinator = this.stateManager.getCoordinator(coordinatorId);

        if (taskManager) {
            taskManager.releaseEngineer(engineerName);
        }

        // Stop process using ProcessManager
        const processId = `engineer_${coordinatorId}_${engineerName}`;
        await this.processManager.stopProcess(processId, false);  // Graceful stop

        // Close terminal
        this.terminalManager.closeEngineerTerminal(engineerName);

        // Remove from coordinator state
        if (coordinator) {
            delete coordinator.engineerSessions[engineerName];
            coordinator.updatedAt = new Date().toISOString();
            this.stateManager.saveCoordinator(coordinator);
        }

        // Release back to pool
        this.engineerPoolService.releaseEngineers([engineerName]);

        this.log(`Released ${engineerName} from coordinator ${coordinatorId}`);
    }

    /**
     * Get coordinator status
     */
    getCoordinatorStatus(coordinatorId: string): CoordinatorState | undefined {
        return this.stateManager.getCoordinator(coordinatorId);
    }

    /**
     * Get task manager for a coordinator
     */
    getTaskManager(coordinatorId: string): TaskManager | undefined {
        return this.taskManagers.get(coordinatorId);
    }

    /**
     * Stop an individual engineer
     */
    async stopEngineer(engineerName: string, coordinatorId?: string): Promise<void> {
        // Find coordinator for this engineer if not provided
        if (!coordinatorId) {
            for (const [coordId, tm] of this.taskManagers) {
                if (tm.getEngineer(engineerName)) {
                    coordinatorId = coordId;
                    break;
                }
            }
        }
        
        const processId = coordinatorId 
            ? `engineer_${coordinatorId}_${engineerName}`
            : `engineer_${engineerName}`;
            
        await this.processManager.stopProcess(processId, false);
        this.terminalManager.closeEngineerTerminal(engineerName);
        
        this.log(`Stopped engineer ${engineerName}`);
    }

    /**
     * Pause an individual engineer
     */
    async pauseEngineer(engineerName: string, coordinatorId?: string): Promise<void> {
        // Find coordinator for this engineer if not provided
        if (!coordinatorId) {
            for (const [coordId, tm] of this.taskManagers) {
                if (tm.getEngineer(engineerName)) {
                    coordinatorId = coordId;
                    break;
                }
            }
        }
        
        const processId = coordinatorId 
            ? `engineer_${coordinatorId}_${engineerName}`
            : `engineer_${engineerName}`;
            
        await this.processManager.pauseProcess(processId);
        
        // Update coordinator state
        if (coordinatorId) {
            const coordinator = this.stateManager.getCoordinator(coordinatorId);
            if (coordinator?.engineerSessions[engineerName]) {
                coordinator.engineerSessions[engineerName].status = 'paused';
                this.stateManager.saveCoordinator(coordinator);
            }
        }
        
        this.log(`Paused engineer ${engineerName}`);
    }

    /**
     * Resume a paused engineer
     */
    async resumeEngineer(engineerName: string, coordinatorId?: string): Promise<void> {
        // Find coordinator for this engineer if not provided
        if (!coordinatorId) {
            for (const [coordId, tm] of this.taskManagers) {
                if (tm.getEngineer(engineerName)) {
                    coordinatorId = coordId;
                    break;
                }
            }
        }
        
        const processId = coordinatorId 
            ? `engineer_${coordinatorId}_${engineerName}`
            : `engineer_${engineerName}`;
        
        const coordinator = coordinatorId ? this.stateManager.getCoordinator(coordinatorId) : null;
        const session = coordinator?.engineerSessions[engineerName];
            
        const proc = this.processManager.resumeProcess(processId, {
            onOutput: (data) => {
                if (session?.logFile) {
                    fs.appendFileSync(session.logFile, data);
                }
            },
            onExit: (code) => {
                if (coordinatorId) {
                    this.handleEngineerExit(coordinatorId, engineerName, code);
                }
            }
        });
        
        if (proc && coordinator?.engineerSessions[engineerName]) {
            coordinator.engineerSessions[engineerName].status = 'working';
            this.stateManager.saveCoordinator(coordinator);
        }
        
        this.log(`Resumed engineer ${engineerName}`);
    }

    /**
     * Get the path for a task completion report
     * Structure: _AiDevLog/Plans/{sessionId}/completions/{task_id}_completion.md
     */
    private getCompletionReportPath(coordinator: CoordinatorState, task: ManagedTask): string {
        if (coordinator.planSessionId) {
            const completionsDir = this.stateManager.getCompletionsFolder(coordinator.planSessionId);
            // Ensure directory exists
            if (!fs.existsSync(completionsDir)) {
                fs.mkdirSync(completionsDir, { recursive: true });
            }
            // Clean task ID for filename (replace dots/spaces with underscores)
            const cleanTaskId = task.id.replace(/[.\s]+/g, '_').toLowerCase();
            return path.join(completionsDir, `${cleanTaskId}_completion.md`);
        }
        // Fallback for coordinators without session ID
        return path.join(this.stateManager.getWorkingDir(), 'Completions', `${task.id}_completion.md`);
    }

    /**
     * Read engineer log
     */
    readEngineerLog(engineerName: string, lines?: number): string {
        const poolStatus = this.engineerPoolService.getEngineerStatus(engineerName);
        if (!poolStatus || !poolStatus.logFile) return '';
        if (!fs.existsSync(poolStatus.logFile)) return '';

        const content = fs.readFileSync(poolStatus.logFile, 'utf-8');
        if (lines) {
            return content.split('\n').slice(-lines).join('\n');
        }
        return content;
    }

    /**
     * Utility: Sleep
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Log to unified APC output channel
     */
    private log(message: string, coordinatorId?: string): void {
        this.outputManager.log('COORD', message);
        
        // Also write to coordinator's log file if available
        if (coordinatorId) {
            const coordinator = this.stateManager.getCoordinator(coordinatorId);
            if (coordinator?.logFile && fs.existsSync(coordinator.logFile)) {
                const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
                fs.appendFileSync(coordinator.logFile, `[${timestamp}] ${message}\n`);
            }
        }
    }
    
    /**
     * Log specifically for a coordinator (writes to both output and log file)
     */
    private logCoord(coordinatorId: string, message: string): void {
        this.log(message, coordinatorId);
    }

    /**
     * Show output channel
     */
    showOutput(): void {
        this.outputManager.show();
    }
}

