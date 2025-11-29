import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ChildProcess } from 'child_process';
import { StateManager } from './StateManager';
import { EngineerPoolService } from './EngineerPoolService';
import { TerminalManager } from './TerminalManager';
import { TaskManager, ManagedTask, EngineerAssignment, DispatchDecision } from './TaskManager';
import { UnityControlManager } from './UnityControlManager';
import { ErrorRouter } from './ErrorRouter';
import { OutputChannelManager } from './OutputChannelManager';
import { ProcessManager } from './ProcessManager';
import { AgentRunner } from './AgentBackend';
import { UnityTask, UnityTaskResult, UnityError, TaskRequester, PipelineResult, PipelineTaskContext } from '../types/unity';
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
 * - Unity operations queued through UnityControlManager
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
    private unityManager: UnityControlManager;
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
        this.unityManager = UnityControlManager.getInstance();

        // Listen for Unity task completions (legacy single-task system)
        this.unityManager.onTaskCompleted((event) => {
            this.handleUnityTaskCompleted(event.task, event.result);
        });

        // Listen for pipeline completions (new batched system)
        this.unityManager.onPipelineComplete((result) => {
            this.handlePipelineCompleted(result);
        });
        
        // Rebuild planSessionCoordinators map from persisted coordinator states
        // This ensures the mapping survives extension restarts
        this.rebuildPlanSessionCoordinatorsMap();
    }
    
    /**
     * Rebuild the planSessionCoordinators map from persisted state
     * Called on startup to restore mappings after extension restart
     */
    private rebuildPlanSessionCoordinatorsMap(): void {
        const coordinators = this.stateManager.getAllCoordinators();
        for (const coordinator of coordinators) {
            if (coordinator.planSessionId && 
                ['initializing', 'running', 'paused'].includes(coordinator.status)) {
                this.planSessionCoordinators.set(coordinator.planSessionId, coordinator.id);
                this.log(`Restored mapping: ${coordinator.planSessionId} -> ${coordinator.id}`);
            }
        }
        this.log(`Rebuilt planSessionCoordinators map with ${this.planSessionCoordinators.size} entries`);
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

        // Step 1: Read plan metadata only (coordinator agent will read full plan)
        const planContent = fs.readFileSync(planPath, 'utf-8');
        
        // Extract title from first heading
        const titleMatch = planContent.match(/^#\s+(.+)$/m);
        const planTitle = titleMatch ? titleMatch[1].trim() : 'Untitled Plan';
        
        // Extract recommended engineer count (simple metadata extraction)
        const engineerMatch = planContent.match(/\*\*Recommended:\*\*\s*(\d+)\s*engineers/i);
        const recommendedEngineers = engineerMatch ? parseInt(engineerMatch[1], 10) : 5;
        
        this.logCoord(coordinatorId, `Plan loaded: ${planTitle}`);
        this.logCoord(coordinatorId, `Recommended engineers: ${recommendedEngineers}`);
        this.logCoord(coordinatorId, `📋 Coordinator agent will read plan and create tasks via CLI`);

        // Step 2: Create empty TaskManager
        // The Coordinator AGENT (AI) will read the plan and call:
        //   apc task create <coord_id> "<description>" --id T1 --deps T2,T3
        // for each task it identifies in the plan
        const taskManager = new TaskManager(coordinatorId, planPath);
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
        // Priority: explicit option > plan recommendation > pool size
        const poolSize = this.stateManager.getPoolSize();
        const requestedCount = options.engineerCount || recommendedEngineers || poolSize;
        const availableEngineers = this.engineerPoolService.getAvailableEngineers();
        
        if (availableEngineers.length === 0) {
            throw new Error('No engineers available in the pool');
        }

        // Use min of requested and available, but log if constrained
        const engineerCount = Math.min(requestedCount, availableEngineers.length);
        if (engineerCount < requestedCount) {
            this.logCoord(coordinatorId, `⚠️ Requested ${requestedCount} engineers but only ${availableEngineers.length} available`);
        }
        this.logCoord(coordinatorId, `Engineer allocation: ${engineerCount} (plan recommends: ${recommendedEngineers}, pool has: ${poolSize})`);
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
Progress: Awaiting task creation via CLI
════════════════════════════════════════════════════════════

`;
        fs.writeFileSync(coordinatorLogFile, logHeader);
        
        // Step 5: Create coordinator state
        // Progress starts at 0 - coordinator agent will create tasks via CLI
        const coordinator: CoordinatorState = {
            id: coordinatorId,
            planPath: planPath,
            planSessionId: options.planSessionId,
            status: 'initializing',
            mode: mode,
            engineerSessions: {},
            planVersion: 1,
            progress: {
                completed: 0,
                total: 0,  // Will be updated as coordinator agent creates tasks
                percentage: 0
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

        // Start coordinator agent to read plan and create tasks
        await this.startCoordinatorAgent(coordinatorId, planPath, allocatedEngineers, workspaceRoot);

        // Start monitoring loop
        this.startMonitoringLoop(coordinatorId);

        return {
            coordinatorId,
            engineersAllocated: allocatedEngineers,
            status: 'running'
        };
    }

    /**
     * Start the coordinator agent (AI) to read the plan and manage tasks
     * The coordinator agent will:
     * 1. Read the plan file
     * 2. Create tasks via CLI (apc task create)
     * 3. Monitor progress and dispatch engineers
     */
    private async startCoordinatorAgent(
        coordinatorId: string,
        planPath: string,
        engineers: string[],
        workspaceRoot: string
    ): Promise<void> {
        const agentRunner = AgentRunner.getInstance();
        
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        const logFile = coordinator?.logFile || '';

        // Build coordinator agent prompt with CLI documentation
        const prompt = `You are the COORDINATOR agent managing plan execution for a Unity game project.

========================================
🎯 YOUR ROLE: Read plan, create tasks, dispatch engineers, monitor progress
========================================

📋 PLAN FILE: ${planPath}

👥 AVAILABLE ENGINEERS: ${engineers.join(', ')}

🔧 TASK MANAGEMENT COMMANDS:

1. **Create tasks from the plan**:
   apc task create ${coordinatorId} "<description>" --id T1 --deps T2,T3
   
2. **Check ready tasks** (dependencies satisfied):
   apc task ready ${coordinatorId}
   
3. **Start engineer on task** (spawns AI process):
   apc task start ${coordinatorId} T1 --engineer Alex
   
4. **Check progress**:
   apc task progress ${coordinatorId}

5. **List all tasks**:
   apc task list ${coordinatorId}
   apc task list ${coordinatorId} --status deferred

6. **Update task status** (after pipeline results):
   apc task status ${coordinatorId} T1 test_passed --reason "All tests passed"
   apc task status ${coordinatorId} T1 test_failed --reason "BoardStateTests failed"

7. **Defer task** (overlaps with ongoing work):
   apc task defer ${coordinatorId} T1 --reason "Eve is modifying same files" --blocked-by T7

8. **Un-defer task** (blocker completed):
   apc task undefer ${coordinatorId} T1

👥 ENGINEER MANAGEMENT COMMANDS:

1. **List all engineers and status**:
   apc engineer list ${coordinatorId}
   
2. **Get detailed engineer status**:
   apc engineer status ${coordinatorId} Alex
   
3. **Read engineer's recent log output**:
   apc engineer log ${coordinatorId} Alex --lines 100

4. **Request more engineers from pool** (when all busy but tasks waiting):
   apc engineer request ${coordinatorId} 2

5. **Release idle engineer back to pool** (when no work for them):
   apc engineer release ${coordinatorId} Alex

6. **Check pool availability**:
   apc engineer pool

📜 WORKFLOW:

**PHASE 1 - SETUP:**
1. READ the plan file at ${planPath}
2. IDENTIFY all tasks (checkbox items: - [ ] **T1**: Description | Deps: None)
3. CREATE each task: apc task create ${coordinatorId} "<desc>" --id T1 --deps <deps>

**PHASE 2 - DISPATCH:**
4. CHECK ready tasks: apc task ready ${coordinatorId}
5. DISPATCH each ready task to an idle engineer:
   apc task start ${coordinatorId} T1 --engineer Alex
   apc task start ${coordinatorId} T4 --engineer Betty
   (Continue until all ready tasks are assigned)

**PHASE 3 - MONITOR (ongoing):**
6. WAIT for notifications in this log (task completed/failed events, pipeline results)
7. When notified of TASK COMPLETION:
   - apc task ready ${coordinatorId}  → see newly ready tasks
   - apc engineer list ${coordinatorId}  → see idle engineers
   - Dispatch new work: apc task start ${coordinatorId} <task> --engineer <name>

8. When notified of PIPELINE RESULT (Unity compilation/tests):
   - If SUCCESS: apc task status ${coordinatorId} <task> test_passed
   - If FAILED with overlap: apc task defer ${coordinatorId} <task> --reason "..." --blocked-by <blocking_task>
   - If FAILED no overlap: apc task start ${coordinatorId} <task> --engineer <name> (dispatch fix)

9. SCALING decisions:
   - All engineers busy + ready tasks: apc engineer request ${coordinatorId} 2
   - Idle engineers + no ready tasks: apc engineer release ${coordinatorId} <name>

10. If engineer seems stuck: apc engineer log ${coordinatorId} <name>

📢 NOTIFICATIONS YOU WILL RECEIVE:
- Engineer completes task stage → dispatches Unity pipeline automatically
- Unity pipeline completes (SUCCESS/FAILED with errors/test failures)
- Overlap warnings (error in file being modified by another engineer)
- Progress updates
- All tasks complete

⚠️ IMPORTANT:
- Parse dependencies: "Deps: T1, T2" → --deps T1,T2
- "Deps: None" → task is immediately ready
- Only dispatch tasks that are "ready"
- Distribute work: don't give all tasks to one engineer
- CHECK OVERLAP before dispatching error fixes
- Engineers EXIT after calling 'apc engineer complete' - they become available for redeployment
- Monitor logs if engineer takes too long

🚀 START NOW: Read the plan file and create all tasks.`;

        const processId = `coordinator_agent_${coordinatorId}`;

        // Write header to log file
        const header = `
========================================
COORDINATOR AGENT STARTED
Coordinator: ${coordinatorId}
Plan: ${planPath}
Engineers: ${engineers.join(', ')}
Started: ${new Date().toISOString()}
========================================

`;
        if (logFile) {
            fs.appendFileSync(logFile, header);
        }

        this.logCoord(coordinatorId, `🤖 Starting coordinator agent to read plan and create tasks`);

        // Run coordinator agent with retry logic
        const MAX_RETRIES = 2;
        this.runCoordinatorAgentWithRetry(
            agentRunner, processId, prompt, workspaceRoot, logFile,
            { coordinatorId, planPath, role: 'coordinator' },
            300000,  // 5 minutes timeout
            MAX_RETRIES
        ).then((result) => {
            this.logCoord(coordinatorId, `🤖 Coordinator agent finished (${result.success ? 'success' : 'failed'})`);
            
            // After coordinator agent creates tasks, start dispatching
            this.dispatchReadyTasks(coordinatorId);
        }).catch((err: Error) => {
            this.logCoord(coordinatorId, `🤖 Coordinator agent failed after ${MAX_RETRIES} retries: ${err.message}`);
            // Update coordinator status to indicate failure
            const coordinator = this.stateManager.getCoordinator(coordinatorId);
            if (coordinator) {
                coordinator.status = 'error';
                coordinator.updatedAt = new Date().toISOString();
                this.stateManager.saveCoordinator(coordinator);
            }
        });
    }

    /**
     * Run a coordinator agent with retry logic
     */
    private async runCoordinatorAgentWithRetry(
        agentRunner: { run: (options: {
            id: string;
            prompt: string;
            cwd: string;
            model: string;
            logFile?: string;
            timeoutMs: number;
            metadata: Record<string, unknown>;
            onOutput?: (text: string) => void;
            onProgress?: (message: string) => void;
        }) => Promise<{ success: boolean; output?: string; error?: string; exitCode?: number | null }> },
        processId: string,
        prompt: string,
        cwd: string,
        logFile: string,
        metadata: Record<string, unknown>,
        timeoutMs: number,
        maxRetries: number
    ): Promise<{ success: boolean; output?: string; error?: string }> {
        let lastError: Error | null = null;
        const coordinatorId = metadata.coordinatorId as string;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    this.logCoord(coordinatorId, `🔄 Retrying coordinator agent (attempt ${attempt + 1}/${maxRetries + 1})...`);
                    if (logFile) {
                        fs.appendFileSync(logFile, `\n--- RETRY ${attempt + 1}/${maxRetries + 1} ---\n`);
                    }
                }

                const result = await agentRunner.run({
                    id: `${processId}_${attempt}`,
                    prompt,
                    cwd,
                    model: 'sonnet-4.5',
                    logFile,
                    timeoutMs,
                    metadata: { ...metadata, attempt },
                    onOutput: (text: string) => {
                        if (logFile) {
                            fs.appendFileSync(logFile, text);
                        }
                    },
                    onProgress: (message: string) => {
                        this.logCoord(coordinatorId, `[COORD-AGENT] ${message}`);
                    }
                });

                if (result.success) {
                    return result;
                } else {
                    lastError = new Error(result.error || `Coordinator agent failed (exit code: ${result.exitCode})`);
                    this.logCoord(coordinatorId, `⚠️ Coordinator agent attempt ${attempt + 1} failed: ${lastError.message}`);
                }
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                this.logCoord(coordinatorId, `⚠️ Coordinator agent attempt ${attempt + 1} error: ${lastError.message}`);
            }
        }

        throw lastError || new Error('Coordinator agent failed after all retries');
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
     * Start engineer process using AgentRunner (TypeScript-based)
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
        // Use AgentRunner abstraction
        const agentRunner = AgentRunner.getInstance();
        
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
- unityMCP for Unity operations: scripts (create/read/edit), assets, GameObjects, scenes
- File operations for reading/writing code
- Terminal commands for git, etc.
- APC CLI (for task completion)

✅ MCP TOOLS YOU CAN USE DIRECTLY (READ operations):
- mcp_unityMCP_read_console - Read Unity console errors/warnings
- mcp_unityMCP_manage_editor action:"get_state" - Check editor state
- mcp_unityMCP_manage_scene action:"get_active", "get_hierarchy" - Read scene info
- mcp_unityMCP_manage_asset action:"search", "get_info" - Search/read assets

🚫 DO NOT USE DIRECTLY (blocking operations):
- mcp_unityMCP_run_tests - Use 'apc engineer complete --unity' instead
- mcp_unityMCP_manage_editor action:"play"/"stop" - Coordinator handles this

📜 WORKFLOW:

1. **READ CONTEXT**
   - Read previous session logs from the plan folder
   - Read relevant docs in _AiDevLog/Docs/ for your task
   - Check _AiDevLog/Errors/error_registry.md before fixing ANY error

2. **IMPLEMENT**
   - Write clean, well-documented code following existing patterns
   - Track files you modify (you'll need to report them)

3. **COMPLETE THE STAGE** (CRITICAL - read carefully!)
   When you finish implementation, call:
   
   apc engineer complete ${coordinatorId} --engineer ${engineerName} --task ${task.id} --stage impl_v1 --unity "prep,test_editmode" --files "File1.cs,File2.cs"
   
   This command:
   - Marks your task as 'awaiting_unity'
   - Marks YOU as 'available' (ready for redeployment)
   - Queues Unity pipeline (compile → test)
   - **YOUR PROCESS WILL EXIT** - this is expected!
   
   The COORDINATOR will:
   - Receive pipeline results (errors, test failures)
   - Update task status
   - Potentially redeploy you to fix errors

4. **IF ERROR FIXING** (coordinator restarted you):
   - Read the errors provided in this log
   - Fix them
   - Call 'apc engineer complete' again with --stage fix_v1

🔧 COMPLETION COMMAND OPTIONS:

  apc engineer complete ${coordinatorId} --engineer ${engineerName} --task ${task.id} \\
    --stage <stage_name> \\
    --unity "prep,test_editmode,test_playmode" \\
    --files "modified_file1.cs,modified_file2.cs"

Stage names: impl_v1, impl_v2, fix_v1, fix_v2, etc.
Unity operations: prep (compile), test_editmode, test_playmode, test_player_playmode

📊 OTHER CLI COMMANDS:
- apc task fail ${coordinatorId} ${task.id} --reason "blocked by X"
- apc task progress ${coordinatorId}

⚠️ CRITICAL RULES:
1. DO NOT call mcp_unityMCP_run_tests - use 'apc engineer complete --unity' 
2. Your process EXITS after 'apc engineer complete' - this is NORMAL
3. Coordinator handles Unity results and may redeploy you
4. Track ALL files you modify for the --files parameter
5. Check error_registry.md before fixing any error (avoid duplicates)
6. Update docs: prefer updating existing docs over creating new ones`;

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
                
                // Detect Unity operation requests from engineer output
                this.detectAndQueueUnityRequests(text, coordinatorId, engineerName, task.id);
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
                coordinator.engineerSessions[engineerName].lastActivity = new Date().toISOString();
                        this.stateManager.saveCoordinator(coordinator);
                    }
            
            // Show completion in output channel
            this.terminalManager.showTaskCompletion(
                engineerName, 
                result.success, 
                `Task: ${task.id}\nDuration: ${Math.round(result.durationMs / 1000)}s\nExit code: ${result.exitCode}`
            );

            this.logCoord(coordinatorId, `[${engineerName}] ${result.success ? '✅' : '❌'} Task ${task.id} finished (${Math.round(result.durationMs / 1000)}s)`);
            
            // Notify coordinator agent about task completion
            this.notifyCoordinatorAgent(coordinatorId, {
                event: 'task_completed',
                engineerName,
                taskId: task.id,
                success: result.success,
                duration: Math.round(result.durationMs / 1000)
            });
        }).catch((err: Error) => {
            // GRACEFUL FAILURE: Mark engineer available and notify coordinator
            const errorMessage = err?.message || String(err);
            this.logCoord(coordinatorId, `[${engineerName}] ❌ Error: ${errorMessage}`);
            
            // Write error to log file
            try {
                fs.appendFileSync(logFile, `\n\n--- PROCESS ERROR ---\n${errorMessage}\n`);
            } catch {
                // Ignore log write errors
            }
            
            // Update task status to failed (ready for retry or reassignment)
            const taskManager = this.taskManagers.get(coordinatorId);
            if (taskManager) {
                taskManager.markTaskFailed(task.id, `Process error: ${errorMessage}`);
            }
            
            // Mark engineer as IDLE (not 'error') - ready for new work
            const coordinator = this.stateManager.getCoordinator(coordinatorId);
            if (coordinator?.engineerSessions[engineerName]) {
                coordinator.engineerSessions[engineerName].status = 'idle';
                coordinator.engineerSessions[engineerName].lastActivity = new Date().toISOString();
                this.stateManager.saveCoordinator(coordinator);
            }
            
            // Also update in TaskManager
            if (taskManager) {
                taskManager.markEngineerAvailable(engineerName);
            }
            
            this.terminalManager.showTaskCompletion(engineerName, false, `Error: ${errorMessage}`);
            
            // NOTIFY COORDINATOR so it can decide: retry same task, assign different task, etc.
            this.notifyCoordinatorAgent(coordinatorId, {
                event: 'task_failed',
                engineerName,
                taskId: task.id,
                success: false,
                error: errorMessage
            });
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
    private async spawnContextAgentForTask(coordinatorId: string, task: ManagedTask, attempt: number = 0): Promise<void> {
        const maxRetries = 2;
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
        
        if (attempt > 0) {
            this.logCoord(coordinatorId, `   🔄 Context agent retry ${attempt}/${maxRetries}...`);
        } else {
            this.logCoord(coordinatorId, `   📚 Spawning context agent for ${filesModified.length} modified files...`);
        }
        
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
        const processId = attempt > 0 ? `context_${coordinatorId}_${task.id}_retry${attempt}` : `context_${coordinatorId}_${task.id}`;
        if (!this.pendingContextAgents.has(coordinatorId)) {
            this.pendingContextAgents.set(coordinatorId, new Set());
        }
        this.pendingContextAgents.get(coordinatorId)!.add(processId);

        // Run context agent in background using AgentRunner (gemini-3-pro for fast context updates)
        const agentRunner = AgentRunner.getInstance();
        
        // Run async (don't await) - fire and forget with completion handling
        agentRunner.run({
            id: processId,
            prompt: contextPrompt,
            cwd: workspaceRoot,
            model: 'gemini-3-pro',
            timeoutMs: 5 * 60 * 1000, // 5 minutes for context updates
            metadata: { coordinatorId, taskId: task.id, type: 'context_update' }
        }).then((result) => {
            // Remove from pending
            this.pendingContextAgents.get(coordinatorId)?.delete(processId);
            
            if (result.success) {
                this.logCoord(coordinatorId, `   ✓ Context updated for task ${task.id}`);
            } else if (attempt < maxRetries) {
                // RETRY on failure
                this.logCoord(coordinatorId, `   ⚠️ Context agent failed (${result.error || 'unknown error'}), will retry...`);
                setTimeout(() => {
                    this.spawnContextAgentForTask(coordinatorId, task, attempt + 1);
                }, 2000);
                return;
            } else {
                this.logCoord(coordinatorId, `   ⚠️ Context agent failed after ${maxRetries} retries`);
            }
            
            // Check if we should proceed with review
            this.checkReviewReady(coordinatorId);
        }).catch((error) => {
            // Remove from pending on error
            this.pendingContextAgents.get(coordinatorId)?.delete(processId);
            this.logCoord(coordinatorId, `   ⚠️ Context agent error: ${error.message}`);
            this.checkReviewReady(coordinatorId);
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
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        
        // Stop monitoring loop
        this.stopMonitoringLoop(coordinatorId);
        
        this.logCoord(coordinatorId, `📋 Starting review process...`);
        this.logCoord(coordinatorId, `   Stopping engineer processes and releasing to pool...`);
        
        // Release all engineers (stops processes, closes terminals, releases to pool)
        await this.releaseAllEngineersAsync(coordinatorId);
        this.logCoord(coordinatorId, `   ✓ All engineer processes stopped`);
        
        // Clean up engineer terminals
        if (coordinator) {
            const engineerNames = Object.keys(coordinator.engineerSessions);
            for (const name of engineerNames) {
                this.terminalManager.closeEngineerTerminal(name);
            }
            this.logCoord(coordinatorId, `   ✓ Closed ${engineerNames.length} engineer terminals`);
        }
        
        // Release engineers back to pool
        if (coordinator) {
            const engineerNames = Object.keys(coordinator.engineerSessions);
            this.engineerPoolService.releaseEngineers(engineerNames);
            this.logCoord(coordinatorId, `   ✓ Released engineers to pool`);
        }
        
        // Check if we can proceed immediately (no pending context agents)
        this.checkReviewReady(coordinatorId);
    }
    
    /**
     * Generate execution summary and complete the plan
     */
    private async generateExecutionSummary(coordinatorId: string, attempt: number = 0): Promise<void> {
        const maxRetries = 2;
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
        
        if (attempt > 0) {
            this.logCoord(coordinatorId, `   🔄 Summary agent retry ${attempt}/${maxRetries}...`);
        } else {
            this.logCoord(coordinatorId, `   📝 Generating execution summary...`);
        }
        
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

        const processId = attempt > 0 ? `summary_${coordinatorId}_retry${attempt}` : `summary_${coordinatorId}`;
        
        // Use AgentRunner for summary generation
        const agentRunner = AgentRunner.getInstance();
        
        try {
            const result = await agentRunner.run({
                id: processId,
                prompt: summaryPrompt,
                cwd: workspaceRoot,
                model: 'gemini-3-pro',
                timeoutMs: 10 * 60 * 1000, // 10 minutes for summary generation
                metadata: { coordinatorId, type: 'execution_summary' }
            });
            
            if (result.success) {
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
            } else if (attempt < maxRetries) {
                // RETRY on failure
                this.logCoord(coordinatorId, `   ⚠️ Summary agent failed (${result.error || 'unknown error'}), will retry...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                return this.generateExecutionSummary(coordinatorId, attempt + 1);
            } else {
                this.logCoord(coordinatorId, `   ⚠️ Summary generation failed after ${maxRetries} retries. Completing anyway.`);
                
                // Complete without summary
                coordinator.status = 'completed';
                coordinator.updatedAt = new Date().toISOString();
                this.stateManager.saveCoordinator(coordinator);
                
                await this.cleanupOnCompletion(coordinatorId);
            }
        } catch (error) {
            if (attempt < maxRetries) {
                this.logCoord(coordinatorId, `   ⚠️ Summary agent error, will retry...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                return this.generateExecutionSummary(coordinatorId, attempt + 1);
            } else {
                this.logCoord(coordinatorId, `   ⚠️ Summary generation error after ${maxRetries} retries. Completing anyway.`);
                
                // Complete without summary
                coordinator.status = 'completed';
                coordinator.updatedAt = new Date().toISOString();
                this.stateManager.saveCoordinator(coordinator);
                
                await this.cleanupOnCompletion(coordinatorId);
            }
        }
    }
    
    /**
     * Full cleanup when execution completes
     */
    private async cleanupOnCompletion(coordinatorId: string): Promise<void> {
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        this.logCoord(coordinatorId, `🧹 Cleaning up after completion...`);
        
        // Stop monitoring loop
        this.stopMonitoringLoop(coordinatorId);
        
        // Release all engineers (stops processes, closes terminals, releases to pool)
        await this.releaseAllEngineersAsync(coordinatorId);
        this.logCoord(coordinatorId, `   ✓ Released all engineers and stopped processes`);
        
        // Clean up task manager
        this.taskManagers.delete(coordinatorId);
        
        // Clean up pending Unity requests
        this.pendingUnityRequests.delete(coordinatorId);
        
        // Clean up temp files
        await this.cleanupCoordinatorFiles(coordinatorId);
        this.logCoord(coordinatorId, `   ✓ Cleaned up temp files`);
        
        // Clean up all engineer terminals for this coordinator
        if (coordinator) {
            const engineerNames = Object.keys(coordinator.engineerSessions);
            this.terminalManager.clearCoordinatorTerminals(coordinatorId, engineerNames);
        }
        
        // Clean up stale terminal references
        this.terminalManager.cleanupStaleTerminals();
        this.logCoord(coordinatorId, `   ✓ Cleaned up terminals`);
        
        this.logCoord(coordinatorId, `🎉 Cleanup complete!`);
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
            // No task for this engineer - let coordinator agent decide what to do
            this.log(`${engineer.engineerName} is idle, no ready tasks - coordinator agent will decide`);
            // The notification sent after task completion will inform coordinator agent
            // about idle engineers and let it decide whether to release them
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
        const unityTaskId = this.unityManager.queueTask('prep_editor', {
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
        const unityTaskId = this.unityManager.queueTask(unityTaskType, {
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
     * Detect [UNITY_REQUEST:*] markers in engineer output and queue appropriate Unity operations
     */
    private detectAndQueueUnityRequests(text: string, coordinatorId: string, engineerName: string, taskId: string): void {
        // Pattern: [UNITY_REQUEST:compile], [UNITY_REQUEST:test_editmode], [UNITY_REQUEST:test_playmode]
        const requestPattern = /\[UNITY_REQUEST:(compile|test_editmode|test_playmode)\]/gi;
        const matches = text.matchAll(requestPattern);
        
        for (const match of matches) {
            const requestType = match[1].toLowerCase() as 'compile' | 'test_editmode' | 'test_playmode';
            this.logCoord(coordinatorId, `🎮 ${engineerName} requested Unity operation: ${requestType}`);
            
            // Map request type to Unity task type
            const unityTaskTypeMap: Record<string, 'prep_editor' | 'test_framework_editmode' | 'test_framework_playmode'> = {
                'compile': 'prep_editor',
                'test_editmode': 'test_framework_editmode',
                'test_playmode': 'test_framework_playmode'
            };
            
            const unityTaskType = unityTaskTypeMap[requestType];
            if (!unityTaskType) {
                this.logCoord(coordinatorId, `⚠️ Unknown Unity request type: ${requestType}`);
                continue;
            }
            
            // Queue the Unity operation with proper TaskRequester format
            const unityTaskId = this.unityManager.queueTask(unityTaskType, {
                coordinatorId,
                engineerName
            });
            
            this.logCoord(coordinatorId, `📋 Queued Unity task ${unityTaskId} (${unityTaskType}) for ${engineerName}`);
            
            // Track the pending request with proper PendingUnityRequest format
            if (!this.pendingUnityRequests.has(coordinatorId)) {
                this.pendingUnityRequests.set(coordinatorId, []);
            }
            this.pendingUnityRequests.get(coordinatorId)!.push({
                unityTaskId,
                engineerName,
                taskId,
                type: requestType,
                requestedAt: new Date().toISOString()
            });
        }
    }

    /**
     * Handle Unity task completion (callback from UnityControlManager)
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

    // ========================================================================
    // Pipeline Completion Handling - New batched Unity operations system
    // ========================================================================

    /**
     * Handle pipeline completion (callback from UnityControlManager)
     * 
     * This is called when a batch of Unity operations completes.
     * Engineers have already stopped (they called apc engineer complete).
     * We notify the COORDINATOR AGENT to:
     * 1. Update affected task statuses
     * 2. Analyze overlap with ongoing work
     * 3. Dispatch error fixes or continue
     */
    private async handlePipelineCompleted(result: PipelineResult): Promise<void> {
        this.log(`Pipeline completed: ${result.pipelineId} - ${result.success ? 'SUCCESS' : 'FAILED'}`);

        // Find the coordinator for this pipeline
        const coordinatorId = result.tasksInvolved[0]?.engineerName 
            ? this.findCoordinatorByEngineer(result.tasksInvolved[0].engineerName)
            : null;

        if (!coordinatorId) {
            this.log(`No coordinator found for pipeline ${result.pipelineId}`);
            return;
        }

        const taskManager = this.taskManagers.get(coordinatorId);
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        if (!taskManager || !coordinator) return;

        // Step 1: Update task statuses based on pipeline result
        for (const taskCtx of result.tasksInvolved) {
            if (result.success) {
                // All steps passed - update to test_passed or completed
                taskManager.updateTaskStage(taskCtx.taskId, 'test_passed', 'Pipeline completed successfully');
            } else if (result.failedAtStep === 'prep') {
                // Compilation failed
                const errorMessages = result.allErrors.map(e => `${e.code || ''}: ${e.message}`);
                taskManager.markTaskCompileFailed(taskCtx.taskId, errorMessages, `Compilation failed at prep step`);
            } else if (result.failedAtStep === 'test_editmode' || result.failedAtStep === 'test_playmode') {
                // Tests failed
                const failures = result.allTestFailures.map(t => `${t.className}.${t.testName}`);
                taskManager.markTaskTestFailed(taskCtx.taskId, failures, `${result.failedAtStep} failed`);
            } else {
                // Other failure
                taskManager.updateTaskStage(taskCtx.taskId, 'failed', `Failed at ${result.failedAtStep}`);
            }
        }

        // Step 2: Check for overlap with ongoing work
        const inProgressTasks = taskManager.getInProgressTasks();
        const overlappingWork: Array<{
            taskId: string;
            engineerName: string;
            overlappingFiles: string[];
            error: string;
        }> = [];

        if (!result.success) {
            // Check each error for overlap with ongoing work
            for (const error of result.allErrors) {
                if (error.file) {
                    const overlap = taskManager.checkFileOverlap([error.file]);
                    if (overlap) {
                        overlappingWork.push({
                            taskId: overlap.taskId,
                            engineerName: overlap.engineerName,
                            overlappingFiles: overlap.overlappingFiles,
                            error: `${error.code || ''}: ${error.message}`
                        });
                    }
                }
            }

            for (const failure of result.allTestFailures) {
                // Check test class file
                const testFile = `${failure.className}.cs`;
                const overlap = taskManager.checkFileOverlap([testFile]);
                if (overlap) {
                    overlappingWork.push({
                        taskId: overlap.taskId,
                        engineerName: overlap.engineerName,
                        overlappingFiles: overlap.overlappingFiles,
                        error: `Test failed: ${failure.testName}`
                    });
                }
            }
        }

        // Step 3: Notify coordinator agent with full context
        await this.notifyCoordinatorOfPipelineResult(coordinatorId, result, overlappingWork);

        // Save coordinator state
        coordinator.updatedAt = new Date().toISOString();
        this.stateManager.saveCoordinator(coordinator);
    }

    /**
     * Find coordinator ID by engineer name
     */
    private findCoordinatorByEngineer(engineerName: string): string | null {
        for (const [coordinatorId, taskManager] of this.taskManagers.entries()) {
            const engineer = taskManager.getEngineer(engineerName);
            if (engineer) {
                return coordinatorId;
            }
        }
        return null;
    }

    /**
     * Notify coordinator agent about pipeline result with overlap analysis
     */
    private async notifyCoordinatorOfPipelineResult(
        coordinatorId: string,
        result: PipelineResult,
        overlappingWork: Array<{
            taskId: string;
            engineerName: string;
            overlappingFiles: string[];
            error: string;
        }>
    ): Promise<void> {
        const agentRunner = AgentRunner.getInstance();

        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        const taskManager = this.taskManagers.get(coordinatorId);
        if (!coordinator || !taskManager) return;

        const workspaceRoot = this.stateManager.getWorkspaceRoot();
        const logFile = coordinator.logFile;

        // Build task status summary
        const tasksSummary = result.tasksInvolved.map(t => {
            const task = taskManager.getTask(t.taskId);
            return `  ${t.taskId}: ${task?.stage || 'unknown'} (${t.engineerName})`;
        }).join('\n');

        // Build errors/failures summary
        const errorsSummary = result.allErrors.length > 0 
            ? result.allErrors.map(e => 
                `  • [${e.code || 'ERR'}] ${e.file || 'unknown'}:${e.line || '?'} - ${e.message}`
            ).join('\n')
            : '  (none)';

        const testFailures = result.allTestFailures.length > 0
            ? result.allTestFailures.map(t =>
                `  • ${t.className}.${t.testName}: ${t.message || 'failed'}`
            ).join('\n')
            : '  (none)';

        // Build overlap warning
        const overlapWarning = overlappingWork.length > 0
            ? `
⚠️ OVERLAP DETECTED - Some errors may be related to ONGOING WORK:
${overlappingWork.map(o => 
`  • Error "${o.error}" in files also being modified by ${o.engineerName} (${o.taskId})
    Files: ${o.overlappingFiles.join(', ')}
    RECOMMENDATION: DEFER this fix until ${o.taskId} completes`
).join('\n')}
`
            : '';

        // Get ready tasks and available engineers
        const readyTasks = taskManager.getReadyTasks();
        const idleEngineers = taskManager.getIdleEngineers();
        const inProgressTasks = taskManager.getInProgressTasks();

        // Build the notification prompt
        const prompt = `📢 UNITY PIPELINE RESULT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Pipeline: ${result.pipelineId}
Status: ${result.success ? '✅ SUCCESS' : `❌ FAILED at ${result.failedAtStep}`}
Operations: ${result.stepResults.map(s => `${s.operation}:${s.success ? '✓' : '✗'}`).join(' → ')}

📋 PLAN FILE: ${coordinator.planPath}

## Tasks Affected
${tasksSummary}

## Compilation/Runtime Errors
${errorsSummary}

## Test Failures
${testFailures}
${overlapWarning}
## Currently Working Engineers (for overlap check)
${inProgressTasks.length > 0 
    ? inProgressTasks.map(t => `  ${t.engineerName}: ${t.taskId} (${t.stage}) - modifying: ${t.filesModified.slice(0, 3).join(', ')}${t.filesModified.length > 3 ? '...' : ''}`).join('\n')
    : '  (none currently working)'}

## Available Engineers
${idleEngineers.length > 0
    ? idleEngineers.map(e => `  ${e.engineerName} (last: ${e.taskHistory[e.taskHistory.length - 1] || 'fresh'})`).join('\n')
    : '  (none available)'}

## Ready Tasks
${readyTasks.length > 0
    ? readyTasks.map(t => `  ${t.id}: ${t.description.substring(0, 50)}...`).join('\n')
    : '  (none ready)'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎯 YOUR DECISIONS:

1. **Update task status** based on result:
   - Success: apc task status ${coordinatorId} <task_id> test_passed
   - Compile fail: apc task status ${coordinatorId} <task_id> compile_failed --reason "CS0103..."
   - Test fail: apc task status ${coordinatorId} <task_id> test_failed --reason "BoardStateTests failed"

2. **For errors WITH overlap** (file being modified by another engineer):
   - DEFER the fix: apc task defer ${coordinatorId} <task_id> --reason "Waiting for <blocking_task>" --blocked-by <task_id>
   - The deferred task will be un-deferred when the blocking work completes

3. **For errors WITHOUT overlap** - Dispatch fix immediately:
   - apc task start ${coordinatorId} <task_id> --engineer <name>
   - Prefer the original engineer who knows the code

4. **For successful tasks** - Mark complete:
   - apc task complete ${coordinatorId} <task_id>

5. **Check deferred tasks** - Can any now proceed?
   - apc task list ${coordinatorId} --status deferred
   - If blocker completed: apc task undefer ${coordinatorId} <task_id>

6. **Scaling decisions**:
   - Need more engineers: apc engineer request ${coordinatorId} <count>
   - Too many idle: apc engineer release ${coordinatorId} <name>

ANALYZE the situation carefully. Consider:
- Which engineer is best suited for each error (original author preferred)
- Whether errors might be caused by incomplete work elsewhere
- Whether to wait for blocking work to complete before fixing`;

        // Write notification to coordinator log
        fs.appendFileSync(logFile, `\n\n${prompt}\n\n`);

        // Spawn continuation agent to process the result with retry
        const processId = `coordinator_pipeline_${coordinatorId}_${Date.now()}`;

        this.logCoord(coordinatorId, `📢 Notifying coordinator of pipeline result...`);

        const MAX_RETRIES = 2;
        this.runCoordinatorAgentWithRetry(
            agentRunner,
            processId,
            prompt,
            workspaceRoot,
            logFile,
            { coordinatorId, pipelineId: result.pipelineId, role: 'coordinator_pipeline' },
            120000,  // 2 minutes
            MAX_RETRIES
        ).then((agentResult) => {
            this.logCoord(coordinatorId, `📢 Coordinator processed pipeline result (${agentResult.success ? 'success' : 'failed'})`);
        }).catch((err: Error) => {
            this.logCoord(coordinatorId, `📢 Coordinator pipeline handler failed after ${MAX_RETRIES} retries: ${err.message}`);
        });
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
     * Notify coordinator agent about events (task completion, errors, etc.)
     * Spawns a continuation session for the coordinator agent with the notification
     */
    private async notifyCoordinatorAgent(
        coordinatorId: string,
        event: {
            event: 'task_completed' | 'task_failed' | 'engineer_idle' | 'all_complete';
            engineerName?: string;
            taskId?: string;
            success?: boolean;
            duration?: number;
            error?: string;
        }
    ): Promise<void> {
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        const taskManager = this.taskManagers.get(coordinatorId);
        if (!coordinator || !taskManager) return;

        // Get current progress for context
        const progress = taskManager.getProgress();
        
        // Get actionable data - ready tasks and idle engineers
        const readyTasks = taskManager.getReadyTasks();
        const idleEngineers = taskManager.getIdleEngineers();
        
        // Find tasks that became unblocked by this completion
        const unblockedTasks = event.taskId 
            ? this.findTasksUnblockedBy(taskManager, event.taskId)
            : [];

        // Build continuation prompt for coordinator agent
        let prompt = `You are the COORDINATOR agent continuing to manage plan execution.

📋 PLAN FILE: ${coordinator.planPath}
   (Read this for full task context, dependencies, and requirements)

========================================
`;
        
        switch (event.event) {
            case 'task_completed':
                prompt += `📢 TASK COMPLETED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Engineer: ${event.engineerName}
Task: ${event.taskId}
Status: ${event.success ? '✅ SUCCESS' : '❌ FAILED'}
Duration: ${event.duration}s
`;
                // Show which tasks were unblocked
                if (unblockedTasks.length > 0) {
                    prompt += `
🔓 TASKS NOW UNBLOCKED (${unblockedTasks.length}):
${unblockedTasks.map(t => `   - ${t.id}: ${t.description.substring(0, 60)}...`).join('\n')}
`;
                }
                break;
            
            case 'task_failed':
                prompt += `⚠️ TASK FAILED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Engineer: ${event.engineerName}
Task: ${event.taskId}
Error: ${event.error}
`;
                break;
            
            case 'all_complete':
                prompt += `🎉 ALL TASKS COMPLETED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
All tasks in the plan have been completed!
`;
                // Don't spawn continuation if complete
                this.logCoord(coordinatorId, '🏁 All tasks completed! Coordinator finishing.');
                return;
        }

        prompt += `
========================================

📊 CURRENT STATUS:
Progress: ${progress.completed}/${progress.total} (${progress.percentage.toFixed(1)}%)
Ready: ${progress.ready} | In Progress: ${progress.inProgress} | Pending: ${progress.pending}

`;

        // Show ready tasks directly - no need for AI to query CLI
        if (readyTasks.length > 0) {
            prompt += `🟢 READY TASKS (${readyTasks.length}) - can be dispatched NOW:
${readyTasks.map(t => `   ${t.id}: ${t.description.substring(0, 60)}... (priority: ${t.priority})`).join('\n')}

`;
        } else {
            prompt += `⏳ NO READY TASKS - waiting for dependencies
`;
        }

        // Show idle engineers with context about their recent work
        if (idleEngineers.length > 0) {
            prompt += `👥 IDLE ENGINEERS (${idleEngineers.length}) - available for work:
${idleEngineers.map(e => {
    const lastTask = e.taskHistory.length > 0 
        ? e.taskHistory[e.taskHistory.length - 1] 
        : null;
    const context = lastTask ? ` (last: ${lastTask})` : ' (fresh)';
    return `   - ${e.engineerName}${context}`;
}).join('\n')}

`;
        } else {
            prompt += `👷 ALL ENGINEERS BUSY - no idle engineers
`;
        }

        // Provide context for dispatch decisions
        if (readyTasks.length > 0 && idleEngineers.length > 0) {
            prompt += `🎯 DECISION NEEDED:
You have ${readyTasks.length} ready task(s) and ${idleEngineers.length} idle engineer(s).

Consider:
- Which tasks should be prioritized?
- Which engineer is best suited for each task?
- Should all idle engineers be assigned, or hold some back?
- Are there dependencies between ready tasks that affect order?

To dispatch: apc task start ${coordinatorId} <task_id> --engineer <name>
`;
        } else if (readyTasks.length === 0 && progress.pending > 0) {
            prompt += `
⏳ WAITING: ${progress.pending} tasks pending (blocked by in-progress dependencies)
   Consider checking on in-progress work or wait for more completions.
`;
            // Suggest releasing idle engineers if there are any
            if (idleEngineers.length > 0) {
                prompt += `
💡 You have ${idleEngineers.length} idle engineer(s) with no immediate work.
   Consider releasing some back to the pool for other coordinators:
   apc engineer release ${coordinatorId} <name>
`;
            }
        } else if (idleEngineers.length === 0 && readyTasks.length > 0) {
            // Check if there are engineers available in the pool
            const poolAvailable = this.engineerPoolService.getAvailableEngineers();
            
            prompt += `
👷 ALL ASSIGNED ENGINEERS BUSY: ${readyTasks.length} tasks ready but no idle engineers.
`;
            if (poolAvailable.length > 0) {
                prompt += `
🆕 POOL HAS ${poolAvailable.length} AVAILABLE ENGINEER(S): ${poolAvailable.join(', ')}

You can request additional engineers to help with ready tasks:
   apc engineer request ${coordinatorId} ${Math.min(poolAvailable.length, readyTasks.length)}

This will allocate more engineers to this coordinator for parallel work.
`;
            } else {
                prompt += `   No additional engineers available in pool.
   Tasks will be dispatched as engineers complete their current work.
`;
            }
        }

        prompt += `
🔧 CLI COMMANDS:

**Task Management:**
- apc task start ${coordinatorId} <task_id> --engineer <name>  → Assign task to engineer
- apc task ready ${coordinatorId}      → Refresh ready tasks  
- apc task list ${coordinatorId}       → List all tasks
- apc task list ${coordinatorId} --status deferred  → List deferred tasks
- apc task complete ${coordinatorId} <task_id>      → Mark task complete
- apc task status ${coordinatorId} <task_id> <status> → Update task status
- apc task defer ${coordinatorId} <task_id> --reason "..." --blocked-by <task>  → Defer task
- apc task undefer ${coordinatorId} <task_id>       → Un-defer task

**Engineer Management:**
- apc engineer list ${coordinatorId}   → Refresh engineer status  
- apc engineer log ${coordinatorId} <name> --lines 50  → Check engineer progress
- apc engineer request ${coordinatorId} <count>  → Request more engineers from pool
- apc engineer release ${coordinatorId} <name>   → Release idle engineer to pool
`;

        // Log the notification
        this.logCoord(coordinatorId, `\n📢 Notifying coordinator agent: ${event.event}`);

        // Write to coordinator log file
        if (coordinator.logFile && fs.existsSync(coordinator.logFile)) {
            fs.appendFileSync(coordinator.logFile, `\n--- Event: ${event.event} ---\n`);
        }

        // Spawn continuation coordinator agent session with retry
        const agentRunner = AgentRunner.getInstance();
        
        const continuationId = `coordinator_${coordinatorId}_cont_${Date.now()}`;
        const workspaceRoot = this.stateManager.getWorkspaceRoot();

        this.logCoord(coordinatorId, `🤖 Spawning coordinator continuation session...`);

        const MAX_RETRIES = 2;
        this.runCoordinatorAgentWithRetry(
            agentRunner,
            continuationId,
            prompt,
            workspaceRoot,
            coordinator.logFile || '',
            { coordinatorId, event: event.event, role: 'coordinator_continuation' },
            120000,  // 2 minutes for dispatch decisions
            MAX_RETRIES
        ).then((result) => {
            this.logCoord(coordinatorId, `🤖 Coordinator continuation ${result.success ? 'completed' : 'failed'}`);
        }).catch((err: Error) => {
            this.logCoord(coordinatorId, `🤖 Coordinator continuation failed after ${MAX_RETRIES} retries: ${err.message}`);
        });
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

            // NOTE: We no longer auto-release engineers here.
            // The coordinator agent decides about releasing via notifications.
            // This gives the AI coordinator control over resource allocation.
            
            // Log idle engineer status for visibility
            const idleEngineers = taskManager.getIdleEngineers();
            const readyTasks = taskManager.getReadyTasks();
            if (idleEngineers.length > 0 && readyTasks.length === 0 && progress.pending > 0) {
                this.logCoord(coordinatorId, `💤 ${idleEngineers.length} engineer(s) idle, waiting for ${progress.pending} blocked tasks`);
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
        const estimatedWaitMs = this.unityManager.getEstimatedWaitTime(unityTaskType);
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
        const unityTaskId = this.unityManager.queueTask(unityTaskType, {
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

        // Start new cursor agent with continuation prompt using AgentRunner
        const processId = `engineer_${coordinatorId}_${engineer.engineerName}`;
        const agentRunner = AgentRunner.getInstance();
        
        // Run in background (don't await) - fire and forget with output streaming
        agentRunner.run({
            id: processId,
            prompt: continuationPrompt,
            cwd: workspaceRoot,
            model: 'sonnet-4.5',
            logFile: engineer.logFile,
            timeoutMs: 30 * 60 * 1000, // 30 minutes for task work
            metadata: {
                engineerName: engineer.engineerName,
                coordinatorId,
                taskId: task.id,
                continuation: true
            },
            onOutput: (text) => {
                // AgentRunner already writes to logFile, but we can track parsed output here if needed
            }
        }).then((result) => {
            fs.appendFileSync(engineer.logFile, `\n--- Process exited (success: ${result.success}) ---\n`);
        }).catch((error) => {
            fs.appendFileSync(engineer.logFile, `\n--- Process error: ${error.message} ---\n`);
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
        
        // Close coordinator terminal and clean up all engineer terminals
        const engineerNames = Object.keys(coordinator.engineerSessions);
        this.terminalManager.clearCoordinatorTerminals(coordinatorId, engineerNames);
        
        // Also clean up any stale terminal references
        this.terminalManager.cleanupStaleTerminals();

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
        
        // Clean up any stale terminal references first
        this.terminalManager.cleanupStaleTerminals();

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
     * Find tasks that were unblocked by a completed task
     * Returns tasks whose last blocking dependency was the completed task
     */
    private findTasksUnblockedBy(taskManager: TaskManager, completedTaskId: string): ManagedTask[] {
        const allTasks = taskManager.getAllTasks();
        const unblockedTasks: ManagedTask[] = [];
        
        for (const task of allTasks) {
            // Skip if task is not ready (still has other blocking deps)
            if (task.status !== 'ready') continue;
            
            // Check if this task depended on the completed task
            if (task.dependencies.includes(completedTaskId)) {
                unblockedTasks.push(task);
            }
        }
        
        return unblockedTasks;
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

    // ========================================================================
    // Task CLI Methods - For Coordinator Agent to interact with TaskManager
    // ========================================================================

    /**
     * Create a task in TaskManager (called by coordinator after reading plan)
     */
    async createTask(coordinatorId: string, taskDef: {
        id: string;
        description: string;
        dependencies?: string[];
        engineer?: string;
    }): Promise<{ success: boolean; error?: string }> {
        const taskManager = this.taskManagers.get(coordinatorId);
        if (!taskManager) {
            return { success: false, error: `Coordinator ${coordinatorId} not found or not initialized` };
        }

        try {
            // Create task in TaskManager
            const task: ManagedTask = {
                id: taskDef.id,
                description: taskDef.description,
                assignedEngineer: taskDef.engineer,
                status: 'pending',
                stage: 'pending',
                requirements: {
                    taskType: 'component',
                    needsCompile: true,
                    needsEditModeTest: false,
                    needsPlayModeTest: false,
                    needsPlayerTest: false
                },
                dependencies: taskDef.dependencies || [],
                dependents: [],
                priority: 0,
                createdAt: new Date().toISOString(),
                filesModified: [],
                unityRequests: [],
                errors: []
            };

            // Add to TaskManager's internal map
            (taskManager as any).tasks.set(taskDef.id, task);
            
            // Update ready status
            (taskManager as any).updateReadyTasks();

            this.logCoord(coordinatorId, `Task created: ${taskDef.id} - ${taskDef.description}`);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Start a task (assign to engineer, mark in_progress, AND spawn engineer process)
     * This is the CLI method that coordinator agent calls to dispatch work
     */
    async startTask(coordinatorId: string, taskId: string, engineerName: string): Promise<{ success: boolean; error?: string }> {
        const taskManager = this.taskManagers.get(coordinatorId);
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        
        if (!taskManager) {
            return { success: false, error: `Coordinator ${coordinatorId} not found` };
        }
        if (!coordinator) {
            return { success: false, error: `Coordinator state not found` };
        }

        try {
            // Get the task
            const tasks = taskManager.getAllTasks();
            const task = tasks.find(t => t.id === taskId);
            if (!task) {
                return { success: false, error: `Task ${taskId} not found` };
            }

            // Get engineer info
            const engineer = taskManager.getEngineer(engineerName);
            if (!engineer) {
                // Register engineer if not already registered
                const engineerSessionId = this.stateManager.generateSessionId(engineerName);
                const logFile = coordinator.planSessionId
                    ? path.join(this.stateManager.getEngineerLogsFolder(coordinator.planSessionId), `${engineerName}_${engineerSessionId}.log`)
                    : path.join(this.stateManager.getWorkingDir(), 'Logs', 'engineers', `${engineerName}_${engineerSessionId}.log`);
                
                taskManager.registerEngineer(engineerName, engineerSessionId, logFile);
            }

            // Dispatch in TaskManager
            taskManager.dispatchTask(taskId, engineerName);
            taskManager.markTaskInProgress(taskId);
            
            // Get updated engineer with log file
            const updatedEngineer = taskManager.getEngineer(engineerName);
            if (!updatedEngineer) {
                return { success: false, error: `Failed to get engineer after registration` };
            }

            // Update coordinator state
            if (!coordinator.engineerSessions[engineerName]) {
                coordinator.engineerSessions[engineerName] = {
                    sessionId: updatedEngineer.sessionId,
                    status: 'starting',
                    logFile: updatedEngineer.logFile,
                    startTime: new Date().toISOString()
                };
            }
            coordinator.engineerSessions[engineerName].status = 'working';
            coordinator.engineerSessions[engineerName].task = taskId;
            this.stateManager.saveCoordinator(coordinator);

            // Actually spawn the engineer process
            const workspaceRoot = this.stateManager.getWorkspaceRoot();
            await this.startEngineerProcess(
                engineerName,
                coordinator.planPath,
                task,
                updatedEngineer.logFile,
                workspaceRoot,
                coordinatorId
            );

            this.logCoord(coordinatorId, `🚀 Task ${taskId} started by ${engineerName}`);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Mark a task as completed
     */
    async completeTask(coordinatorId: string, taskId: string, filesModified?: string[]): Promise<{ success: boolean; error?: string }> {
        const taskManager = this.taskManagers.get(coordinatorId);
        if (!taskManager) {
            return { success: false, error: `Coordinator ${coordinatorId} not found` };
        }

        try {
            taskManager.markTaskCompleted(taskId, filesModified);
            this.logCoord(coordinatorId, `Task ${taskId} completed`);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Mark a task as failed
     */
    async failTask(coordinatorId: string, taskId: string, reason: string): Promise<{ success: boolean; error?: string }> {
        const taskManager = this.taskManagers.get(coordinatorId);
        if (!taskManager) {
            return { success: false, error: `Coordinator ${coordinatorId} not found` };
        }

        try {
            taskManager.markTaskFailed(taskId, reason);
            this.logCoord(coordinatorId, `Task ${taskId} failed: ${reason}`);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Reset a task to ready state (for retry)
     */
    async resetTask(coordinatorId: string, taskId: string): Promise<{ success: boolean; error?: string }> {
        const taskManager = this.taskManagers.get(coordinatorId);
        if (!taskManager) {
            return { success: false, error: `Coordinator ${coordinatorId} not found` };
        }

        try {
            taskManager.resetTaskToReady(taskId);
            this.logCoord(coordinatorId, `Task ${taskId} reset to ready`);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Update task stage directly
     * Used by coordinator to update status after pipeline results
     */
    async updateTaskStage(
        coordinatorId: string, 
        taskId: string, 
        stage: string, 
        reason?: string
    ): Promise<{ success: boolean; error?: string }> {
        const taskManager = this.taskManagers.get(coordinatorId);
        if (!taskManager) {
            return { success: false, error: `Coordinator ${coordinatorId} not found` };
        }

        try {
            // Import TaskStage type for validation
            const validStages = [
                'pending', 'in_progress', 'implemented', 'awaiting_unity',
                'compiling', 'compile_failed', 'error_fixing', 'compiled',
                'testing_editmode', 'testing_playmode', 'waiting_player_test',
                'test_passed', 'test_failed', 'deferred', 'completed', 'failed'
            ];
            
            if (!validStages.includes(stage)) {
                return { success: false, error: `Invalid stage: ${stage}. Valid: ${validStages.join(', ')}` };
            }

            taskManager.updateTaskStage(taskId, stage as any, reason);
            this.logCoord(coordinatorId, `Task ${taskId} stage updated to ${stage}${reason ? `: ${reason}` : ''}`);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Mark engineer as available (after completing a task stage)
     * Engineer process should EXIT after calling this
     */
    async markEngineerAvailable(
        coordinatorId: string,
        engineerName: string,
        taskId: string,
        filesModified: string[]
    ): Promise<{ success: boolean; error?: string }> {
        const taskManager = this.taskManagers.get(coordinatorId);
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        if (!taskManager || !coordinator) {
            return { success: false, error: `Coordinator ${coordinatorId} not found` };
        }

        try {
            const engineer = taskManager.getEngineer(engineerName);
            if (!engineer) {
                return { success: false, error: `Engineer ${engineerName} not found` };
            }

            // Update engineer's files modified
            engineer.filesModified.push(...filesModified);
            engineer.status = 'idle';
            engineer.currentTask = undefined;
            engineer.lastActivityAt = new Date().toISOString();

            // Update coordinator state
            const sessionInfo = coordinator.engineerSessions[engineerName];
            if (sessionInfo) {
                sessionInfo.status = 'idle';
                sessionInfo.lastActivity = new Date().toISOString();
            }
            coordinator.updatedAt = new Date().toISOString();
            this.stateManager.saveCoordinator(coordinator);

            this.logCoord(coordinatorId, `Engineer ${engineerName} now available (completed ${taskId})`);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Defer a task (overlap with ongoing work)
     */
    async deferTask(
        coordinatorId: string,
        taskId: string,
        reason: string,
        blockedBy?: string
    ): Promise<{ success: boolean; error?: string }> {
        const taskManager = this.taskManagers.get(coordinatorId);
        if (!taskManager) {
            return { success: false, error: `Coordinator ${coordinatorId} not found` };
        }

        try {
            taskManager.deferTask(taskId, reason, blockedBy);
            this.logCoord(coordinatorId, `Task ${taskId} deferred: ${reason}`);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Un-defer a task
     */
    async undeferTask(
        coordinatorId: string,
        taskId: string
    ): Promise<{ success: boolean; newStage?: string; error?: string }> {
        const taskManager = this.taskManagers.get(coordinatorId);
        if (!taskManager) {
            return { success: false, error: `Coordinator ${coordinatorId} not found` };
        }

        try {
            const newStage = taskManager.undeferTask(taskId);
            if (!newStage) {
                return { success: false, error: `Task ${taskId} not found or not deferred` };
            }
            this.logCoord(coordinatorId, `Task ${taskId} un-deferred, now ${newStage}`);
            return { success: true, newStage };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }

    /**
     * List all tasks with optional status filter
     */
    async listTasks(coordinatorId: string, statusFilter?: string): Promise<{ success: boolean; tasks?: any[]; error?: string }> {
        const taskManager = this.taskManagers.get(coordinatorId);
        if (!taskManager) {
            return { success: false, error: `Coordinator ${coordinatorId} not found` };
        }

        try {
            let tasks = taskManager.getAllTasks();
            
            if (statusFilter) {
                tasks = tasks.filter(t => t.status === statusFilter);
            }

            return {
                success: true,
                tasks: tasks.map(t => ({
                    id: t.id,
                    description: t.description,
                    status: t.status,
                    stage: t.stage,
                    assignedEngineer: t.assignedEngineer,
                    actualEngineer: t.actualEngineer,
                    dependencies: t.dependencies
                }))
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Get ready tasks (dependencies satisfied)
     */
    async getReadyTasks(coordinatorId: string): Promise<{ success: boolean; tasks?: any[]; error?: string }> {
        const taskManager = this.taskManagers.get(coordinatorId);
        if (!taskManager) {
            return { success: false, error: `Coordinator ${coordinatorId} not found` };
        }

        try {
            const tasks = taskManager.getReadyTasks();
            return {
                success: true,
                tasks: tasks.map(t => ({
                    id: t.id,
                    description: t.description,
                    assignedEngineer: t.assignedEngineer,
                    dependencies: t.dependencies
                }))
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Get task progress stats
     */
    async getTaskProgress(coordinatorId: string): Promise<{ success: boolean; progress?: any; error?: string }> {
        const taskManager = this.taskManagers.get(coordinatorId);
        if (!taskManager) {
            return { success: false, error: `Coordinator ${coordinatorId} not found` };
        }

        try {
            const progress = taskManager.getProgress();
            return { success: true, progress };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }

    // ========================================================================
    // Engineer CLI Methods - For Coordinator Agent to monitor engineers
    // ========================================================================

    /**
     * List all engineers and their current status
     */
    async listEngineers(coordinatorId: string): Promise<{ success: boolean; engineers?: any[]; error?: string }> {
        const taskManager = this.taskManagers.get(coordinatorId);
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        
        if (!taskManager) {
            return { success: false, error: `Coordinator ${coordinatorId} not found` };
        }

        const engineers = taskManager.getAllEngineers().map(e => ({
            name: e.engineerName,
            status: e.status,
            currentTask: e.currentTask?.id || null,
            taskDescription: e.currentTask?.description?.substring(0, 50) || null,
            waitingTasks: e.waitingTasks.length,
            tasksCompleted: e.taskHistory.length,
            lastActivity: e.lastActivityAt
        }));

        return { success: true, engineers };
    }

    /**
     * Add additional engineers to a running coordinator
     * Called when coordinator needs more help (ready tasks but all engineers busy)
     */
    async addEngineersToCoordinator(
        coordinatorId: string, 
        engineerNames: string[]
    ): Promise<{ success: boolean; added?: string[]; error?: string }> {
        const taskManager = this.taskManagers.get(coordinatorId);
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        
        if (!taskManager || !coordinator) {
            return { success: false, error: `Coordinator ${coordinatorId} not found` };
        }

        if (coordinator.status !== 'running') {
            return { success: false, error: `Coordinator is not running (status: ${coordinator.status})` };
        }

        const workspaceRoot = this.stateManager.getWorkspaceRoot();
        const added: string[] = [];

        for (const engineerName of engineerNames) {
            // Generate session info for new engineer
            const engineerSessionId = this.stateManager.generateSessionId(engineerName);
            const logFile = coordinator.planSessionId
                ? path.join(this.stateManager.getEngineerLogsFolder(coordinator.planSessionId), `${engineerName}_${engineerSessionId}.log`)
                : path.join(this.stateManager.getWorkingDir(), 'Logs', 'engineers', `${engineerName}_${engineerSessionId}.log`);

            // Ensure log directory exists
            const logDir = path.dirname(logFile);
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }

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

            added.push(engineerName);
            this.logCoord(coordinatorId, `➕ Added engineer ${engineerName} to coordinator`);
        }

        // Save updated coordinator state
        coordinator.updatedAt = new Date().toISOString();
        this.stateManager.saveCoordinator(coordinator);

        // Immediately try to dispatch ready tasks to new engineers
        await this.dispatchReadyTasks(coordinatorId);

        return { success: true, added };
    }

    /**
     * Release an engineer from coordinator back to the pool
     * Called when coordinator decides it doesn't need as many engineers
     */
    async releaseEngineer(
        coordinatorId: string, 
        engineerName: string
    ): Promise<{ success: boolean; error?: string }> {
        const taskManager = this.taskManagers.get(coordinatorId);
        const coordinator = this.stateManager.getCoordinator(coordinatorId);
        
        if (!taskManager || !coordinator) {
            return { success: false, error: `Coordinator ${coordinatorId} not found` };
        }

        // Check if engineer exists in this coordinator
        const engineer = taskManager.getEngineer(engineerName);
        if (!engineer) {
            return { success: false, error: `Engineer ${engineerName} not found in coordinator` };
        }

        // Only release if engineer is idle
        if (engineer.status === 'working') {
            return { 
                success: false, 
                error: `Cannot release ${engineerName} - currently working on task ${engineer.currentTask?.id}` 
            };
        }

        // Release the engineer
        await this.releaseEngineerAsync(coordinatorId, engineerName);
        
        this.logCoord(coordinatorId, `➖ Released engineer ${engineerName} back to pool`);

        return { success: true };
    }

    /**
     * Get detailed status of one engineer
     */
    async getEngineerStatus(coordinatorId: string, engineerName: string): Promise<{ success: boolean; status?: any; error?: string }> {
        const taskManager = this.taskManagers.get(coordinatorId);
        
        if (!taskManager) {
            return { success: false, error: `Coordinator ${coordinatorId} not found` };
        }

        const engineer = taskManager.getEngineer(engineerName);
        if (!engineer) {
            return { success: false, error: `Engineer ${engineerName} not found in coordinator` };
        }

        return {
            success: true,
            status: {
                name: engineer.engineerName,
                status: engineer.status,
                currentTask: engineer.currentTask ? {
                    id: engineer.currentTask.id,
                    description: engineer.currentTask.description,
                    stage: engineer.currentTask.stage,
                    startedAt: engineer.currentTask.startedAt
                } : null,
                waitingTasks: engineer.waitingTasks.map(w => ({
                    taskId: w.task.id,
                    waitingFor: w.waitingFor,
                    queuedAt: w.queuedAt
                })),
                taskHistory: engineer.taskHistory,
                filesModified: engineer.filesModified,
                sessionId: engineer.sessionId,
                logFile: engineer.logFile,
                assignedAt: engineer.assignedAt,
                lastActivity: engineer.lastActivityAt
            }
        };
    }

    /**
     * Get recent log output from an engineer
     */
    async getEngineerLog(coordinatorId: string, engineerName: string, lines: number = 50): Promise<{ success: boolean; log?: string; error?: string }> {
        const taskManager = this.taskManagers.get(coordinatorId);
        
        if (!taskManager) {
            return { success: false, error: `Coordinator ${coordinatorId} not found` };
        }

        const engineer = taskManager.getEngineer(engineerName);
        if (!engineer) {
            return { success: false, error: `Engineer ${engineerName} not found in coordinator` };
        }

        if (!fs.existsSync(engineer.logFile)) {
            return { success: true, log: '(No log file yet)' };
        }

        const content = fs.readFileSync(engineer.logFile, 'utf-8');
        const logLines = content.split('\n');
        const recentLines = logLines.slice(-lines).join('\n');

        return { success: true, log: recentLines };
    }

    /**
     * Assign task to engineer (without starting)
     */
    async assignTask(coordinatorId: string, taskId: string, engineerName: string): Promise<{ success: boolean; error?: string }> {
        const taskManager = this.taskManagers.get(coordinatorId);
        if (!taskManager) {
            return { success: false, error: `Coordinator ${coordinatorId} not found` };
        }

        try {
            const tasks = (taskManager as any).tasks as Map<string, ManagedTask>;
            const task = tasks.get(taskId);
            if (!task) {
                return { success: false, error: `Task ${taskId} not found` };
            }

            task.assignedEngineer = engineerName;
            this.logCoord(coordinatorId, `Task ${taskId} assigned to ${engineerName}`);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }
    
    /**
     * Dispose all resources
     * Call this on extension deactivation
     */
    async dispose(): Promise<void> {
        this.log('CoordinatorService disposing...');
        
        // Clear all monitoring intervals
        for (const [id, interval] of this.monitoringIntervals) {
            clearInterval(interval);
            this.log(`Cleared monitoring interval for ${id}`);
        }
        this.monitoringIntervals.clear();
        
        // Stop all coordinators gracefully
        for (const coordinatorId of this.taskManagers.keys()) {
            try {
                await this.stopCoordinator(coordinatorId);
            } catch (e) {
                console.error(`Error stopping coordinator ${coordinatorId}:`, e);
            }
        }
        
        // Clear task managers
        this.taskManagers.clear();
        this.pendingUnityRequests.clear();
        this.pendingContextAgents.clear();
        this.planSessionCoordinators.clear();
        
        // Dispose error router if initialized
        if (this.errorRouter) {
            this.errorRouter.dispose();
        }
        
        this.log('CoordinatorService disposed');
    }
}

