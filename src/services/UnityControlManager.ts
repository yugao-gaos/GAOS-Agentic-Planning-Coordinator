import * as fs from 'fs';
import * as path from 'path';
import { TypedEventEmitter } from './TypedEventEmitter';
import { spawn } from 'child_process';
import {
    UnityTask,
    UnityTaskType,
    UnityTaskResult,
    UnityError,
    UnityWarning,
    TaskRequester,
    UnityControlManagerState,
    UnityControlManagerStatus,
    UnityEditorState,
    UnityConsoleMessage,
    PipelineRequest,
    PipelineResult,
    PipelineOperation,
    PipelineTaskContext,
    PipelineStepResult,
    TestResult
} from '../types/unity';
import { OutputChannelManager } from './OutputChannelManager';
import { AgentRunner, AgentRunResult } from './AgentBackend';
import { AgentRoleRegistry } from './AgentRoleRegistry';
import { UnityLogMonitor, LogMonitorResult } from './UnityLogMonitor';
import { TaskManager, ERROR_RESOLUTION_SESSION_ID } from './TaskManager';
import { UnifiedCoordinatorService } from './UnifiedCoordinatorService';
import { ServiceLocator } from './ServiceLocator';
import { EventBroadcaster } from '../daemon/EventBroadcaster';
import { getFolderStructureManager } from './FolderStructureManager';

// ============================================================================
// Unity Control Manager - Background Service
// ============================================================================

/**
 * Unity Editor state tracked by polling agent
 * 
 * Note: Error tracking is now handled by UnityLogMonitor via direct log file reading.
 * The polling agent only monitors editor state (isCompiling, isPlaying, isPaused).
 */
interface UnityEditorStatus {
    isCompiling: boolean;
    isPlaying: boolean;
    isPaused: boolean;
    timestamp: number;
}

/**
 * Unity Control Manager - Manages Unity Editor operations that need queuing
 * 
 * This service runs in the background and manages:
 * - Task queue for operations that can freeze Unity (compile, reimport, tests, playmode)
 * - Unity Editor state monitoring via long-running polling agent
 * - Error collection and routing
 * 
 * IMPORTANT: Engineers CAN call MCP tools directly for READ operations:
 * - mcp_unityMCP_read_console (read errors/warnings)
 * - mcp_unityMCP_manage_editor with action: get_state
 * - mcp_unityMCP_manage_scene with action: get_active, get_hierarchy
 * 
 * Engineers MUST use this manager (via CLI) for WRITE/BLOCKING operations:
 * - Compilation (prep_editor) - freezes Unity
 * - Tests (editmode/playmode) - requires exclusive access
 * - Play mode control - only one can run at a time
 * 
 * POLLING AGENT:
 * - A long-running cursor-agent process that polls Unity state every 5 seconds
 * - Lives at least 1 minute when tasks are in queue
 * - Max lifetime 15 minutes (then restarts if needed)
 * - Notifies manager via CLI: apc unity notify-status
 * 
 * Only ONE Unity blocking operation can run at a time.
 * 
 * Obtain via ServiceLocator:
 *   const manager = ServiceLocator.resolve(UnityControlManager);
 */
export class UnityControlManager {
    private workspaceRoot: string = '';
    private queue: UnityTask[] = [];
    private currentTask: UnityTask | null = null;
    private status: UnityControlManagerStatus = 'idle';
    private isRunning: boolean = false;
    private tempScenePath: string = 'Assets/Scenes/_TempCompileCheck.unity';
    private errorRegistryPath: string = '';

    // Pipeline queue system (new)
    private pipelineQueue: PipelineRequest[] = [];
    private currentPipeline: PipelineRequest | null = null;
    private pipelineIdCounter: number = 0;
    
    // Callback for notifying coordinator of pipeline completion
    private onPipelineCompleteCallback?: (result: PipelineResult) => void;

    // Polling agent state
    private agentRunner: AgentRunner;
    private pollingAgentId: string = 'unity_polling_agent';
    private pollingAgentRunning: boolean = false;
    private pollingAgentStartTime: number = 0;
    private pollingAgentMinLifetime: number = 60000;  // 1 minute minimum
    private pollingAgentMaxLifetime: number = 900000; // 15 minutes maximum
    private lastUnityStatus: UnityEditorStatus | null = null;
    private waitingForCompileComplete: boolean = false;
    private compileCompleteResolve: (() => void) | null = null;
    private pollingAgentRestartTimeout: NodeJS.Timeout | null = null;  // Track restart timeout

    // Event emitters
    private _onStatusChanged = new TypedEventEmitter<UnityControlManagerState>();
    readonly onStatusChanged = this._onStatusChanged.event;

    private _onTaskCompleted = new TypedEventEmitter<{ task: UnityTask; result: UnityTaskResult }>();
    readonly onTaskCompleted = this._onTaskCompleted.event;

    // Output channel for logging
    private outputManager: OutputChannelManager;
    
    // Log file path for Unity pipeline logs
    private logFilePath: string | null = null;

    // Task ID counter
    private taskIdCounter: number = 0;
    
    // Agent Role Registry for customizable prompts
    private agentRoleRegistry: AgentRoleRegistry | null = null;
    
    // Unity log monitor for capturing console output with timestamps
    private logMonitor: UnityLogMonitor;

    constructor() {
        this.outputManager = ServiceLocator.resolve(OutputChannelManager);
        this.agentRunner = ServiceLocator.resolve(AgentRunner);
        this.logMonitor = new UnityLogMonitor();
    }
    
    /**
     * Set workspace root for log monitor persistence
     */
    private initializeLogMonitor(): void {
        if (this.workspaceRoot) {
            this.logMonitor.setWorkspaceRoot(this.workspaceRoot);
        }
    }
    
    /**
     * Set the agent role registry (for customizable prompts)
     */
    setAgentRoleRegistry(registry: AgentRoleRegistry): void {
        this.agentRoleRegistry = registry;
    }

    /**
     * Initialize the manager with workspace root
     */
    async initialize(workspaceRoot: string): Promise<void> {
        this.workspaceRoot = workspaceRoot;
        this.errorRegistryPath = path.join(workspaceRoot, '_AiDevLog/Errors/error_registry.md');
        
        // Initialize log file in the configured Logs folder
        this.initializeLogFile();
        
        // Initialize log monitor with workspace for log persistence
        this.initializeLogMonitor();

        this.log('Initializing Unity Control Manager...');
        this.log(`Workspace: ${workspaceRoot}`);

        // Create ERROR_RESOLUTION session/plan (persistent, lives forever)
        // This session handles all error-fixing tasks across all plans
        const taskManager = ServiceLocator.resolve(TaskManager);
        taskManager.registerSession(ERROR_RESOLUTION_SESSION_ID, '');
        this.log('ERROR_RESOLUTION plan initialized');

        // Ensure temp scene exists
        await this.ensureTempSceneExists();

        // Start the queue processor
        this.startQueueProcessor();

        this.log('Unity Control Manager initialized');
    }

    /**
     * Ensure temp scene exists for compilation checks
     */
    async ensureTempSceneExists(): Promise<boolean> {
        const fullPath = path.join(this.workspaceRoot, this.tempScenePath);

        // Check if scene file exists on disk
        if (fs.existsSync(fullPath)) {
            this.log(`Temp scene exists: ${this.tempScenePath}`);
            return true;
        }

        // Need to create via MCP
        this.log('Temp scene not found, will create via MCP when Unity is available');

        // For now, we'll try to create it via cursor-agent CLI call
        // This is a one-time setup operation
        try {
            const result = await this.runCursorAgentCommand(
                `Use mcp_unityMCP_manage_scene to create a new scene. ` +
                `Action: 'create', name: '_TempCompileCheck', path: 'Assets/Scenes'. ` +
                `If it already exists, that's fine. Reply only: 'CREATED' or 'EXISTS' or 'ERROR: reason'`
            );

            if (result.includes('CREATED') || result.includes('EXISTS')) {
                this.log('Temp scene created/verified via MCP');
                return true;
            } else {
                this.log(`Failed to create temp scene: ${result}`);
                return false;
            }
        } catch (error) {
            this.log(`Error creating temp scene: ${error}`);
            return false;
        }
    }

    /**
     * Queue a Unity task
     */
    queueTask(
        type: UnityTaskType,
        requestedBy: TaskRequester | TaskRequester[],
        options: {
            testScene?: string;
            maxDuration?: number;
            testFilter?: string[];
        } = {}
    ): string {
        const taskId = `unity_${++this.taskIdCounter}_${Date.now()}`;

        const task: UnityTask = {
            id: taskId,
            type,
            priority: this.getPriority(type),
            requestedBy: Array.isArray(requestedBy) ? requestedBy : [requestedBy],
            testScene: options.testScene,
            maxDuration: options.maxDuration,
            testFilter: options.testFilter,
            status: 'queued',
            createdAt: new Date().toISOString()
        };

        // Check for combinable tasks
        const combined = this.tryCombineTask(task);
        if (!combined) {
            this.queue.push(task);
            this.sortQueue();
        }

        this.log(`Task queued: ${type} (ID: ${taskId}) from ${task.requestedBy.map(r => r.agentName).join(', ')}`);
        this.emitStatusUpdate();

        // Ensure polling agent is running when we have tasks
        this.ensurePollingAgentIfNeeded();

        return taskId;
    }

    /**
     * Get task priority (lower = higher priority)
     */
    private getPriority(type: UnityTaskType): number {
        switch (type) {
            case 'prep_editor': return 1;
            case 'test_framework_editmode': return 2;
            case 'test_framework_playmode': return 3;
            case 'test_player_playmode': return 4;
            default: return 5;
        }
    }

    /**
     * Try to combine task with existing queued task
     */
    private tryCombineTask(newTask: UnityTask): boolean {
        // Only prep_editor tasks can be combined
        if (newTask.type !== 'prep_editor') {
            return false;
        }

        const existingPrepTask = this.queue.find(t => t.type === 'prep_editor' && t.status === 'queued');
        if (existingPrepTask) {
            // Combine requesters
            existingPrepTask.requestedBy.push(...newTask.requestedBy);
            this.log(`Combined prep_editor task with existing (now ${existingPrepTask.requestedBy.length} requesters)`);
            return true;
        }

        return false;
    }

    /**
     * Sort queue by priority
     */
    private sortQueue(): void {
        this.queue.sort((a, b) => a.priority - b.priority);
    }

    /**
     * Start the queue processor loop
     */
    private startQueueProcessor(): void {
        if (this.isRunning) return;
        this.isRunning = true;

        this.processQueue();
    }

    /**
     * Main queue processing loop
     */
    private async processQueue(): Promise<void> {
        // Minimum time a task must be visible in queue before processing (ms)
        const QUEUE_COOLING_PERIOD = 1000;
        
        while (this.isRunning) {
            if (this.queue.length === 0 || this.currentTask) {
                await this.sleep(500);
                continue;
            }

            // Get next task, but check cooling period first
            const nextTask = this.queue[0];
            if (!nextTask) continue;
            
            // Calculate time since queued
            const queuedTime = new Date(nextTask.createdAt).getTime();
            const timeSinceQueued = Date.now() - queuedTime;
            
            // Wait for cooling period if task was just added
            if (timeSinceQueued < QUEUE_COOLING_PERIOD) {
                await this.sleep(QUEUE_COOLING_PERIOD - timeSinceQueued);
            }
            
            // Now dequeue and process
            const task = this.queue.shift();
            if (!task) continue;

            this.currentTask = task;
            task.status = 'executing';
            task.startedAt = new Date().toISOString();
            this.emitStatusUpdate();

            this.log(`Executing task: ${task.type} (ID: ${task.id})`);

            try {
                const result = await this.executeTask(task);
                task.result = result;
                task.status = result.success ? 'completed' : 'failed';
            } catch (error) {
                task.status = 'failed';
                task.result = {
                    success: false,
                    errors: [{
                        id: `err_${Date.now()}`,
                        type: 'runtime',
                        message: `Task execution failed: ${error}`,
                        timestamp: new Date().toISOString()
                    }],
                    warnings: []
                };
            }

            task.completedAt = new Date().toISOString();
            this._onTaskCompleted.fire({ task, result: task.result! });

            this.log(`Task completed: ${task.type} - ${task.status}`);

            this.currentTask = null;
            this.status = 'idle';
            this.emitStatusUpdate();

            // Buffer between tasks
            await this.sleep(2000);
        }
    }

    /**
     * Execute a Unity task
     */
    private async executeTask(task: UnityTask): Promise<UnityTaskResult> {
        switch (task.type) {
            case 'prep_editor':
                return this.executePrepEditor(task);
            case 'test_framework_editmode':
                return this.executeTestFrameworkEditMode(task);
            case 'test_framework_playmode':
                return this.executeTestFrameworkPlayMode(task);
            case 'test_player_playmode':
                return this.executeTestPlayerPlayMode(task);
            default:
                return {
                    success: false,
                    errors: [{
                        id: `err_${Date.now()}`,
                        type: 'runtime',
                        message: `Unknown task type: ${task.type}`,
                        timestamp: new Date().toISOString()
                    }],
                    warnings: []
                };
        }
    }

    /**
     * Execute prep_editor task (reimport + compile)
     */
    private async executePrepEditor(task: UnityTask): Promise<UnityTaskResult> {
        this.status = 'waiting_unity';
        task.phase = 'preparing';
        this.emitStatusUpdate();

        const errors: UnityError[] = [];
        const warnings: UnityWarning[] = [];

        try {
            // Step 1: Ensure temp scene exists
            await this.ensureTempSceneExists();

            // Step 2: Exit playmode and load temp scene via MCP
            this.log('Preparing Unity Editor via MCP...');
            const prepResult = await this.runCursorAgentCommand(
                `Prepare Unity for compilation check:
                1. Check editor state with fetch_mcp_resource uri='unity://editor/state'
                2. If isPlaying is true, use mcp_unityMCP_manage_editor action='stop'
                3. Load temp scene: mcp_unityMCP_manage_scene action='load' path='Assets/Scenes/_TempCompileCheck.unity'
                Reply: 'PREPARED' if successful, 'ERROR: reason' if failed`
            );

            if (prepResult.includes('ERROR')) {
                this.log(`Prep failed: ${prepResult}`);
            }

            // Step 3: Focus Unity to trigger reimport/recompile
            this.log('Focusing Unity Editor...');
            task.phase = 'waiting_import';
            this.emitStatusUpdate();
            await this.focusUnityEditor();

            // Step 4: Poll until compilation complete
            this.log('Waiting for Unity to finish compilation...');
            task.phase = 'waiting_compile';
            this.emitStatusUpdate();
            const compilationSuccess = await this.waitForCompilation(120);

            if (!compilationSuccess) {
                errors.push({
                    id: `err_${Date.now()}`,
                    type: 'compilation',
                    message: 'Compilation timed out',
                    timestamp: new Date().toISOString()
                });
            }

            // Note: Console errors are now captured by UnityLogMonitor at the pipeline step level
            // with accurate timestamps (100ms precision). See executePipelineStep().

            return {
                success: errors.filter(e => e.type === 'compilation').length === 0,
                errors,
                warnings
            };

        } catch (error) {
            return {
                success: false,
                errors: [{
                    id: `err_${Date.now()}`,
                    type: 'runtime',
                    message: `prep_editor failed: ${error}`,
                    timestamp: new Date().toISOString()
                }],
                warnings
            };
        }
    }

    /**
     * Execute test_framework_editmode task
     */
    private async executeTestFrameworkEditMode(task: UnityTask): Promise<UnityTaskResult> {
        this.status = 'executing';
        task.phase = 'running_tests';
        this.emitStatusUpdate();

        // Note: Compilation errors are now detected via UnityLogMonitor during the prep step.
        // If tests are run after prep, any compilation errors will have been captured.
        // If compilation errors exist, Unity's test runner will fail appropriately.

        // Run EditMode tests via MCP
        this.log('Running EditMode tests...');
        const result = await this.runCursorAgentCommand(
            `Run Unity EditMode tests:
            Use mcp_unityMCP_run_tests with mode='EditMode'
            Wait for completion (up to 5 minutes)
            Reply with JSON: { "passed": N, "failed": N, "failures": [...] }`
        );

        // Parse test results
        try {
            const testResult = JSON.parse(result);
            return {
                success: testResult.failed === 0,
                errors: [],
                warnings: [],
                testsPassed: testResult.passed,
                testsFailed: testResult.failed,
                testResults: testResult.failures
            };
        } catch {
            return {
                success: false,
                errors: [{
                    id: `err_${Date.now()}`,
                    type: 'test_failure',
                    message: `Failed to parse test results: ${result}`,
                    timestamp: new Date().toISOString()
                }],
                warnings: []
            };
        }
    }

    /**
     * Execute test_framework_playmode task
     */
    private async executeTestFrameworkPlayMode(task: UnityTask): Promise<UnityTaskResult> {
        this.status = 'executing';
        task.phase = 'running_tests';
        this.emitStatusUpdate();

        // Similar to EditMode but with PlayMode
        this.log('Running PlayMode tests...');
        const result = await this.runCursorAgentCommand(
            `Run Unity PlayMode tests:
            Use mcp_unityMCP_run_tests with mode='PlayMode'
            Wait for completion (up to 10 minutes)
            Reply with JSON: { "passed": N, "failed": N, "failures": [...] }`
        );

        try {
            const testResult = JSON.parse(result);
            return {
                success: testResult.failed === 0,
                errors: [],
                warnings: [],
                testsPassed: testResult.passed,
                testsFailed: testResult.failed,
                testResults: testResult.failures
            };
        } catch {
            return {
                success: false,
                errors: [{
                    id: `err_${Date.now()}`,
                    type: 'test_failure',
                    message: `Failed to parse test results: ${result}`,
                    timestamp: new Date().toISOString()
                }],
                warnings: []
            };
        }
    }

    /**
     * Execute test_player_playmode task (manual player testing)
     */
    private async executeTestPlayerPlayMode(task: UnityTask): Promise<UnityTaskResult> {
        this.status = 'monitoring';
        task.phase = 'monitoring';
        this.emitStatusUpdate();

        const errors: UnityError[] = [];
        const startTime = Date.now();
        const maxDuration = task.maxDuration || 600; // 10 minutes default

        try {
            // Load game scene and enter playmode
            const testScene = task.testScene || 'Assets/Scenes/Main.unity';
            this.log(`Starting player test in scene: ${testScene}`);

            await this.runCursorAgentCommand(
                `Start player playtest:
                1. Load scene: mcp_unityMCP_manage_scene action='load' path='${testScene}'
                2. Enter playmode: mcp_unityMCP_manage_editor action='play'
                Reply: 'STARTED' or 'ERROR: reason'`
            );

            // Focus Unity for player
            await this.focusUnityEditor();

            // Log notification
            this.log('🎮 Player Test Started - Play the game and exit playmode when done');

            // Monitor loop
            let lastCheckTime = Date.now();
            let exitReason: 'player_exit' | 'timeout' | 'error' | 'stopped' = 'player_exit';

            while (true) {
                await this.sleep(30000); // Check every 30 seconds

                // Check if still in playmode
                const state = await this.getEditorState();
                if (!state.isPlaying) {
                    this.log('Player exited playmode');
                    break;
                }

                // Collect errors since last check
                const newErrors = await this.readUnityConsoleSince(lastCheckTime);
                errors.push(...newErrors.errors);
                lastCheckTime = Date.now();

                // Timeout check
                const elapsed = (Date.now() - startTime) / 1000;
                if (elapsed > maxDuration) {
                    this.log('Player test timeout');
                    exitReason = 'timeout';
                    await this.runCursorAgentCommand(
                        `Exit playmode: mcp_unityMCP_manage_editor action='stop'`
                    );
                    break;
                }

                // Log error count
                if (errors.length > 0) {
                    this.log(`🎮 Playing... (${errors.length} errors collected)`);
                }
            }

            // Deduplicate errors
            const uniqueErrors = this.deduplicateErrors(errors);

            return {
                success: uniqueErrors.length === 0,
                errors: uniqueErrors,
                warnings: [],
                playDuration: (Date.now() - startTime) / 1000,
                exitReason
            };

        } catch (error) {
            return {
                success: false,
                errors: [{
                    id: `err_${Date.now()}`,
                    type: 'runtime',
                    message: `Player test failed: ${error}`,
                    timestamp: new Date().toISOString()
                }],
                warnings: [],
                exitReason: 'error'
            };
        }
    }

    // ========================================================================
    // Helper Methods
    // ========================================================================

    /**
     * Focus Unity Editor window
     * Works on macOS, Windows, and Linux
     */
    private async focusUnityEditor(): Promise<void> {
        const platform = process.platform;

        if (platform === 'darwin') {
            // macOS - use AppleScript
            await new Promise<void>((resolve, reject) => {
                const proc = spawn('osascript', ['-e', 'tell application "Unity" to activate']);
                proc.on('close', () => resolve());
                proc.on('error', reject);
            });
        } else if (platform === 'win32') {
            // Windows - use PowerShell to focus Unity window
            await new Promise<void>((resolve, reject) => {
                const psScript = `
                    Add-Type @"
                    using System;
                    using System.Runtime.InteropServices;
                    public class Win32 {
                        [DllImport("user32.dll")]
                        public static extern bool SetForegroundWindow(IntPtr hWnd);
                        [DllImport("user32.dll")]
                        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
                    }
"@
                    $unity = Get-Process -Name "Unity" -ErrorAction SilentlyContinue | Select-Object -First 1
                    if ($unity) {
                        [Win32]::ShowWindow($unity.MainWindowHandle, 9)
                        [Win32]::SetForegroundWindow($unity.MainWindowHandle)
                    }
                `.replace(/\n\s*/g, ' ');
                
                const proc = spawn('powershell', ['-Command', psScript], { 
                    windowsHide: true,
                    stdio: 'ignore'
                });
                proc.on('close', () => resolve());
                proc.on('error', () => resolve()); // Don't fail if PowerShell fails
            });
        } else {
            // Linux - use wmctrl or xdotool if available
            await new Promise<void>((resolve) => {
                const proc = spawn('wmctrl', ['-a', 'Unity'], { stdio: 'ignore' });
                proc.on('close', () => resolve());
                proc.on('error', () => {
                    // Try xdotool as fallback
                    const proc2 = spawn('xdotool', ['search', '--name', 'Unity', 'windowactivate'], { stdio: 'ignore' });
                    proc2.on('close', () => resolve());
                    proc2.on('error', () => resolve());
                });
            });
        }
    }

    /**
     * Wait for Unity compilation to complete
     * Uses the polling agent for efficient monitoring
     */
    private async waitForCompilation(timeoutSeconds: number): Promise<boolean> {
        // Use polling agent-based waiting (more efficient)
        return this.waitForCompilationViaPollingAgent(timeoutSeconds);
    }

    /**
     * Get Unity editor state via MCP
     */
    private async getEditorState(): Promise<UnityEditorState> {
        const result = await this.runCursorAgentCommand(
            `Get Unity editor state:
            Use fetch_mcp_resource with uri='unity://editor/state'
            Reply with JSON: { "isPlaying": bool, "isCompiling": bool, "isPaused": bool }`
        );

        try {
            return JSON.parse(result);
        } catch {
            return {
                isPlaying: false,
                isPaused: false,
                isCompiling: false,
                applicationPath: '',
                projectPath: '',
                unityVersion: ''
            };
        }
    }

    /**
     * Read Unity console for errors
     */
    private async readUnityConsole(): Promise<{ errors: UnityError[]; warnings: UnityWarning[] }> {
        const result = await this.runCursorAgentCommand(
            `Read Unity console:
            Use mcp_unityMCP_read_console with action='get' count='100' types=['error','warning']
            Parse the output and reply with JSON:
            { "errors": [{ "code": "CS...", "message": "...", "file": "...", "line": N }], "warnings": [...] }`
        );

        try {
            const parsed = JSON.parse(result);
            return {
                errors: (parsed.errors || []).map((e: any, i: number) => ({
                    id: `err_${Date.now()}_${i}`,
                    type: 'compilation' as const,
                    code: e.code,
                    message: e.message,
                    file: e.file,
                    line: e.line,
                    timestamp: new Date().toISOString()
                })),
                warnings: (parsed.warnings || []).map((w: any) => ({
                    code: w.code,
                    message: w.message,
                    file: w.file,
                    line: w.line,
                    timestamp: new Date().toISOString()
                }))
            };
        } catch {
            return { errors: [], warnings: [] };
        }
    }

    /**
     * Read Unity console since timestamp
     * Filters results to only include messages newer than the given timestamp
     */
    private async readUnityConsoleSince(sinceTimestamp: number): Promise<{ errors: UnityError[]; warnings: UnityWarning[] }> {
        const allMessages = await this.readUnityConsole();
        
        // Filter errors by timestamp
        const filteredErrors = allMessages.errors.filter(e => {
            const errorTime = new Date(e.timestamp).getTime();
            return errorTime > sinceTimestamp;
        });
        
        // Filter warnings by timestamp
        const filteredWarnings = allMessages.warnings.filter(w => {
            const warningTime = new Date(w.timestamp).getTime();
            return warningTime > sinceTimestamp;
        });
        
        return {
            errors: filteredErrors,
            warnings: filteredWarnings
        };
    }

    /**
     * Deduplicate errors (same error may fire multiple times)
     */
    private deduplicateErrors(errors: UnityError[]): UnityError[] {
        const seen = new Set<string>();
        return errors.filter(e => {
            const key = `${e.code || ''}_${e.file || ''}_${e.line || ''}_${e.message}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    /**
     * Run cursor-agent CLI command using AgentRunner
     * Provides consistent timeout handling and retry support
     */
    private async runCursorAgentCommand(prompt: string, retries: number = 2): Promise<string> {
        const agentRunner = ServiceLocator.resolve(AgentRunner);
        const processId = `unity_cmd_${Date.now()}`;
        
        let lastError: Error | null = null;
        
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                if (attempt > 0) {
                    this.log(`Retrying Unity command (attempt ${attempt + 1}/${retries + 1})...`);
                }
                
                let output = '';
                
                const result = await agentRunner.run({
                    id: `${processId}_${attempt}`,
                    prompt,
                    cwd: this.workspaceRoot,
                    model: 'gpt-4o-mini',
                    timeoutMs: 300000, // 5 minute timeout
                    metadata: { 
                        type: 'unity_command', 
                        prompt: prompt.substring(0, 100),
                        attempt 
                    },
                    onOutput: (text) => {
                        output += text;
                    }
                });
                
                if (result.success) {
                    // Get last line as result (for backward compatibility)
                    const fullOutput = output || result.output || '';
                    const lines = fullOutput.trim().split('\n');
                    return lines[lines.length - 1] || '';
                } else {
                    lastError = new Error(result.error || `Unity command failed (exit code: ${result.exitCode})`);
                }
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                this.log(`Unity command attempt ${attempt + 1} failed: ${lastError.message}`);
            }
        }
        
        throw lastError || new Error('Unity command failed after all retries');
    }

    /**
     * Sleep utility
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Initialize the log file in the configured Logs folder
     */
    private initializeLogFile(): void {
        try {
            const folderStructure = getFolderStructureManager();
            const logsDir = folderStructure.getFolderPath('logs');
            
            // Ensure logs directory exists
            if (!fs.existsSync(logsDir)) {
                fs.mkdirSync(logsDir, { recursive: true });
            }
            
            this.logFilePath = path.join(logsDir, 'unity_pipeline.log');
            
            // Write header to log file
            const header = `\n${'='.repeat(60)}\n` +
                `=== Unity Pipeline Log ===\n` +
                `Started: ${new Date().toISOString()}\n` +
                `${'='.repeat(60)}\n\n`;
            fs.appendFileSync(this.logFilePath, header);
        } catch (error) {
            // Silently ignore if FolderStructureManager not initialized yet
            // Log file will not be available, but output channel still works
        }
    }
    
    /**
     * Log to unified output channel and log file
     */
    private log(message: string): void {
        this.outputManager.log('UNITY', message);
        
        // Also write to log file if available
        if (this.logFilePath) {
            try {
                const timestamp = new Date().toISOString();
                fs.appendFileSync(this.logFilePath, `[${timestamp}] ${message}\n`);
            } catch {
                // Silently ignore file write errors
            }
        }
    }

    /**
     * Emit status update
     * 
     * Note: Error status is now determined by pipeline results, not polling.
     * The polling agent only monitors editor state (isCompiling, isPlaying, isPaused).
     * Error detection happens via UnityLogMonitor during pipeline operations.
     */
    private emitStatusUpdate(): void {
        this._onStatusChanged.fire(this.getState());
        
        // Broadcast Unity status to all clients
        const broadcaster = ServiceLocator.resolve(EventBroadcaster);
        
        // Determine overall status based on editor state
        let overallStatus: 'idle' | 'compiling' | 'testing' | 'playing' | 'error' = 'idle';
        if (this.lastUnityStatus?.isCompiling) {
            overallStatus = 'compiling';
        } else if (this.lastUnityStatus?.isPlaying) {
            overallStatus = 'playing';
        } else if (this.status === 'executing' || this.status === 'monitoring') {
            overallStatus = 'testing';
        }
        
        // Note: hasErrors and errorCount are now always false/0 from polling.
        // Errors are detected via UnityLogMonitor and reported through pipeline results.
        broadcaster.unityStatusChanged(
            overallStatus,
            this.lastUnityStatus?.isCompiling ?? false,
            this.lastUnityStatus?.isPlaying ?? false,
            this.lastUnityStatus?.isPaused ?? false,
            false,  // hasErrors - now determined by pipeline, not polling
            0       // errorCount - now determined by pipeline, not polling
        );
    }

    /**
     * Get current state
     */
    getState(): UnityControlManagerState {
        return {
            status: this.status,
            currentTask: this.currentTask || undefined,
            queueLength: this.queue.length,
            tempScenePath: this.tempScenePath,
            lastActivity: new Date().toISOString(),
            errorRegistryPath: this.errorRegistryPath
        };
    }

    /**
     * Get queue
     */
    getQueue(): UnityTask[] {
        return [...this.queue];
    }

    /**
     * Get last Unity editor status (from polling agent)
     */
    getUnityStatus(): UnityEditorStatus | null {
        return this.lastUnityStatus;
    }

    /**
     * Check if polling agent is running
     */
    isPollingAgentRunning(): boolean {
        return this.pollingAgentRunning;
    }

    /**
     * Estimate wait time for a new task
     * Based on queue length and average task duration
     */
    getEstimatedWaitTime(taskType: UnityTaskType): number {
        // Average durations in milliseconds
        const avgDurations: Record<UnityTaskType, number> = {
            'prep_editor': 45000,           // 45 seconds
            'test_framework_editmode': 60000, // 60 seconds
            'test_framework_playmode': 120000, // 2 minutes
            'test_player_playmode': 300000    // 5 minutes (variable)
        };

        // Calculate wait based on queue
        let waitTime = 0;

        // Add current task remaining time (estimate half done)
        if (this.currentTask) {
            waitTime += avgDurations[this.currentTask.type] / 2;
        }

        // Add queued tasks
        for (const task of this.queue) {
            waitTime += avgDurations[task.type];
        }

        // Add buffer (10 seconds per task for transitions)
        waitTime += (this.queue.length + (this.currentTask ? 1 : 0)) * 10000;

        return waitTime;
    }

    /**
     * Get queue status summary
     */
    getQueueStatus(): {
        queueLength: number;
        currentTaskType?: UnityTaskType;
        estimatedTotalWaitMs: number;
        isIdle: boolean;
    } {
        return {
            queueLength: this.queue.length,
            currentTaskType: this.currentTask?.type,
            estimatedTotalWaitMs: this.getEstimatedWaitTime('prep_editor'), // Use compile as baseline
            isIdle: this.status === 'idle' && this.queue.length === 0
        };
    }

    // ========================================================================
    // Polling Agent - Long-running agent for Unity state monitoring
    // ========================================================================

    /**
     * Start the polling agent if not already running
     * The polling agent continuously monitors Unity state and notifies via CLI
     */
    private async startPollingAgent(): Promise<void> {
        // Already running?
        if (this.pollingAgentRunning || this.agentRunner.isRunning(this.pollingAgentId)) {
            this.log('Polling agent already running');
            return;
        }

        this.log('Starting Unity polling agent...');
        this.pollingAgentRunning = true;
        this.pollingAgentStartTime = Date.now();

        const logFile = path.join(this.workspaceRoot, '_AiDevLog/Logs/unity_polling_agent.log');
        
        // Ensure log directory exists
        const logDir = path.dirname(logFile);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }

        try {
            const result = await this.agentRunner.run({
                id: this.pollingAgentId,
                prompt: this.getPollingAgentPrompt(),
                cwd: this.workspaceRoot,
                model: 'gpt-4o-mini',
                logFile,
                timeoutMs: this.pollingAgentMaxLifetime,
                onOutput: (text, type) => this.handlePollingAgentOutput(text, type),
                onProgress: (msg) => this.log(`[PollingAgent] ${msg}`),
                onStart: (pid) => this.log(`[PollingAgent] Started with PID: ${pid}`)
            });

            this.handlePollingAgentExit(result);
        } catch (error) {
            this.log(`[PollingAgent] Error: ${error}`);
            this.pollingAgentRunning = false;
        }
    }

    /**
     * Stop the polling agent
     */
    private async stopPollingAgent(): Promise<void> {
        // Clear any pending restart timeout
        if (this.pollingAgentRestartTimeout) {
            clearTimeout(this.pollingAgentRestartTimeout);
            this.pollingAgentRestartTimeout = null;
        }
        
        if (!this.pollingAgentRunning) {
            return;
        }

        this.log('Stopping polling agent...');
        await this.agentRunner.stop(this.pollingAgentId);
        this.pollingAgentRunning = false;
    }

    /**
     * Handle polling agent exit - restart if needed
     */
    private handlePollingAgentExit(result: AgentRunResult): void {
        this.pollingAgentRunning = false;
        const lifetime = Date.now() - this.pollingAgentStartTime;

        this.log(`[PollingAgent] Exited after ${Math.round(lifetime / 1000)}s, success: ${result.success}`);

        // Clear any existing restart timeout
        if (this.pollingAgentRestartTimeout) {
            clearTimeout(this.pollingAgentRestartTimeout);
            this.pollingAgentRestartTimeout = null;
        }

        // Check if we should restart
        const hasWork = this.queue.length > 0 || this.currentTask !== null;
        const minLifetimeMet = lifetime >= this.pollingAgentMinLifetime;

        if (hasWork && minLifetimeMet) {
            // Queue has work, restart the polling agent
            this.log('[PollingAgent] Queue has work, restarting polling agent...');
            this.pollingAgentRestartTimeout = setTimeout(() => this.startPollingAgent(), 2000);
        } else if (!hasWork && minLifetimeMet) {
            this.log('[PollingAgent] Queue empty, polling agent stopped');
        } else if (!minLifetimeMet) {
            // Didn't run long enough - might be an error, restart with delay
            this.log('[PollingAgent] Exited too early, will restart in 5s...');
            this.pollingAgentRestartTimeout = setTimeout(() => this.startPollingAgent(), 5000);
        }
    }

    /**
     * Handle output from polling agent
     * Parses status updates and updates internal state
     */
    private handlePollingAgentOutput(text: string, type: string): void {
        // Look for status markers in the output
        // The polling agent outputs status in a parseable format
        
        // Try to parse JSON status
        try {
            if (text.includes('"unity_status"')) {
                const match = text.match(/\{[^}]*"unity_status"[^}]*\}/);
                if (match) {
                    const status = JSON.parse(match[0]);
                    this.updateUnityStatus(status);
                }
            }
        } catch {
            // Not JSON, ignore
        }

        // Also look for simple markers
        if (text.includes('COMPILE_COMPLETE')) {
            this.onCompileComplete();
        } else if (text.includes('COMPILE_STARTED')) {
            this.lastUnityStatus = {
                ...this.lastUnityStatus,
                isCompiling: true,
                timestamp: Date.now()
            } as UnityEditorStatus;
        }
    }

    /**
     * Update Unity status from polling agent
     * 
     * Note: Error tracking is now handled by UnityLogMonitor, not the polling agent.
     */
    private updateUnityStatus(status: Partial<UnityEditorStatus>): void {
        const wasCompiling = this.lastUnityStatus?.isCompiling ?? false;
        
        this.lastUnityStatus = {
            isCompiling: status.isCompiling ?? false,
            isPlaying: status.isPlaying ?? false,
            isPaused: status.isPaused ?? false,
            timestamp: Date.now()
        };

        // Detect compilation complete
        if (wasCompiling && !this.lastUnityStatus.isCompiling) {
            this.onCompileComplete();
        }

        // Emit status update (which includes broadcast)
        this.emitStatusUpdate();
    }

    /**
     * Called when compilation completes
     */
    private onCompileComplete(): void {
        this.log('Unity compilation complete detected');
        
        // Resolve any waiting promises
        if (this.compileCompleteResolve) {
            this.compileCompleteResolve();
            this.compileCompleteResolve = null;
        }

        this.waitingForCompileComplete = false;
    }

    /**
     * Wait for compilation to complete using the polling agent
     */
    private async waitForCompilationViaPollingAgent(timeoutSeconds: number): Promise<boolean> {
        // Ensure polling agent is running
        if (!this.pollingAgentRunning) {
            await this.startPollingAgent();
        }

        this.waitingForCompileComplete = true;
        const startTime = Date.now();

        return new Promise((resolve) => {
            // Set up the resolve callback
            this.compileCompleteResolve = () => resolve(true);

            // Also set up timeout
            const checkInterval = setInterval(() => {
                const elapsed = (Date.now() - startTime) / 1000;
                
                // Check if compilation is already done
                if (this.lastUnityStatus && !this.lastUnityStatus.isCompiling) {
                    clearInterval(checkInterval);
                    this.waitingForCompileComplete = false;
                    this.compileCompleteResolve = null;
                    resolve(true);
                    return;
                }

                // Timeout check
                if (elapsed > timeoutSeconds) {
                    clearInterval(checkInterval);
                    this.waitingForCompileComplete = false;
                    this.compileCompleteResolve = null;
                    resolve(false);
                    return;
                }
            }, 1000);
        });
    }

    /**
     * Get the prompt for the polling agent
     */
    private getPollingAgentPrompt(): string {
        // Get base prompt from settings
        const basePrompt = this.agentRoleRegistry?.getEffectiveSystemPrompt('unity_polling');
        if (!basePrompt) {
            throw new Error('Missing system prompt for unity_polling - check DefaultSystemPrompts');
        }

        return `${basePrompt}

========================================
📋 POLLING SESSION - Editor State Only
========================================

IMPORTANT: You must keep running and polling continuously. Do NOT exit after one check.

🔧 MCP TOOL YOU USE:
- fetch_mcp_resource uri="unity://editor/state" → Get isPlaying, isPaused, isCompiling

NOTE: Console/error reading is now handled via direct log file monitoring (UnityLogMonitor).
Your only job is to report editor state changes.

📜 POLLING LOOP - Repeat every 5 seconds:

**Step 1: Get editor state**
\`\`\`
fetch_mcp_resource uri="unity://editor/state"
\`\`\`
Returns: { isPlaying, isPaused, isCompiling }

**Step 2: Report status** - Output this JSON line:
\`\`\`
{"unity_status": {"isCompiling": false, "isPlaying": false, "isPaused": false}}
\`\`\`

**Step 3: Track state changes**
- If was compiling → now not compiling: output "COMPILE_COMPLETE"
- If was not compiling → now compiling: output "COMPILE_STARTED"

**Step 4: Wait ~5 seconds, then repeat from Step 1**

⚠️ CRITICAL RULES:
1. Keep polling until timeout (~15 minutes) - DO NOT stop early
2. Output status JSON after EVERY poll cycle
3. Track state changes for COMPILE_STARTED/COMPILE_COMPLETE markers
4. If MCP call fails, log error and continue polling
5. You do NOT make decisions - you only report status

🔄 ALTERNATIVE: You can also call CLI to report status:
\`\`\`
apc unity notify-status --compiling true --playing false
\`\`\`

Begin polling now. First poll:`;
    }

    /**
     * Receive status notification from CLI (called by CliHandler)
     * This is an alternative to parsing polling agent output
     */
    receiveStatusNotification(status: Partial<UnityEditorStatus>): void {
        this.updateUnityStatus(status);
    }

    /**
     * Check if polling agent should be running
     */
    private ensurePollingAgentIfNeeded(): void {
        const hasWork = this.queue.length > 0 || this.currentTask !== null || 
                        this.pipelineQueue.length > 0 || this.currentPipeline !== null;
        
        if (hasWork && !this.pollingAgentRunning) {
            this.startPollingAgent();
        }
    }

    // ========================================================================
    // Pipeline System - Sequential Unity Operations with Fail-Fast
    // ========================================================================

    /**
     * Queue a pipeline of Unity operations
     * 
     * Agents call this when they complete a task stage and need Unity verification:
     *   apc agent complete --task T1 --stage impl_v1 --unity "prep,test_editmode"
     * 
     * @param coordinatorId - Which coordinator to notify on completion
     * @param operations - Sequence of operations (fail-fast)
     * @param tasksInvolved - Tasks that triggered this pipeline
     * @param mergeEnabled - If true, can merge with existing queued request
     */
    queuePipeline(
        coordinatorId: string,
        operations: PipelineOperation[],
        tasksInvolved: PipelineTaskContext[],
        mergeEnabled: boolean = true
    ): string {
        const pipelineId = `pipeline_${++this.pipelineIdCounter}_${Date.now()}`;

        const request: PipelineRequest = {
            id: pipelineId,
            operations,
            coordinatorId,
            tasksInvolved,
            status: 'queued',
            currentStep: 0,
            stepResults: [],
            createdAt: new Date().toISOString(),
            mergeEnabled
        };

        // Try to merge with first queued request if mergeEnabled
        if (mergeEnabled && this.pipelineQueue.length > 0) {
            const firstQueued = this.pipelineQueue[0];
            if (firstQueued.status === 'queued' && firstQueued.mergeEnabled) {
                // Merge: add tasks and expand operations if needed
                firstQueued.tasksInvolved.push(...tasksInvolved);
                
                // Merge operations (take the superset)
                for (const op of operations) {
                    if (!firstQueued.operations.includes(op)) {
                        firstQueued.operations.push(op);
                    }
                }
                
                // Sort operations by priority
                firstQueued.operations.sort((a, b) => 
                    this.getOperationPriority(a) - this.getOperationPriority(b)
                );

                this.log(`Merged pipeline request with ${firstQueued.id} (now ${firstQueued.tasksInvolved.length} tasks)`);
                this.emitStatusUpdate();
                return firstQueued.id;
            }
        }

        // Add to queue
        this.pipelineQueue.push(request);
        this.log(`Pipeline queued: ${pipelineId} (${operations.join(' → ')}) for ${tasksInvolved.length} task(s)`);
        this.emitStatusUpdate();

        // Ensure polling agent is running
        this.ensurePollingAgentIfNeeded();

        // Start processing if not already
        if (!this.currentPipeline && this.status === 'idle') {
            this.processPipelineQueue();
        }

        return pipelineId;
    }
    
    /**
     * Queue a pipeline request and wait for the result
     * This is a convenience wrapper for workflows that need to await the pipeline
     */
    async queuePipelineAndWait(
        coordinatorId: string,
        operations: PipelineOperation[],
        tasksInvolved: PipelineTaskContext[],
        mergeEnabled: boolean = true,
        timeoutMs: number = 600000 // 10 minute default timeout
    ): Promise<PipelineResult> {
        return new Promise((resolve, reject) => {
            const pipelineId = this.queuePipeline(coordinatorId, operations, tasksInvolved, mergeEnabled);
            
            // Set up a one-time listener for this specific pipeline
            const timeoutId = setTimeout(() => {
                reject(new Error(`Pipeline ${pipelineId} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            
            // Listen for completion
            const originalCallback = this.onPipelineCompleteCallback;
            this.onPipelineCompleteCallback = (result: PipelineResult) => {
                // Call original callback if exists
                if (originalCallback) {
                    originalCallback(result);
                }
                
                // Check if this is our pipeline
                if (result.pipelineId === pipelineId) {
                    clearTimeout(timeoutId);
                    // Restore original callback
                    this.onPipelineCompleteCallback = originalCallback;
                    resolve(result);
                }
            };
        });
    }

    /**
     * Get operation priority for sorting
     */
    private getOperationPriority(op: PipelineOperation): number {
        switch (op) {
            case 'prep': return 1;
            case 'test_editmode': return 2;
            case 'test_playmode': return 3;
            case 'test_player_playmode': return 4;
            default: return 5;
        }
    }

    /**
     * Process the pipeline queue
     */
    private async processPipelineQueue(): Promise<void> {
        if (this.pipelineQueue.length === 0 || this.currentPipeline) {
            return;
        }

        // Get next pipeline
        this.currentPipeline = this.pipelineQueue.shift()!;
        this.currentPipeline.status = 'running';
        this.currentPipeline.startedAt = new Date().toISOString();
        const pipelineStartTime = Date.now();
        this.status = 'executing';
        this.emitStatusUpdate();

        this.log(`Starting pipeline ${this.currentPipeline.id}: ${this.currentPipeline.operations.join(' → ')}`);

        // Broadcast pipeline started event to all clients
        try {
            const broadcaster = ServiceLocator.resolve(EventBroadcaster);
            broadcaster.unityPipelineStarted(
                this.currentPipeline.id,
                this.currentPipeline.operations,
                this.currentPipeline.tasksInvolved.map(t => ({ taskId: t.taskId, description: t.stage })),
                this.currentPipeline.coordinatorId
            );
        } catch (e) {
            // Broadcaster may not be available in some contexts
            console.warn('[UnityControlManager] Failed to broadcast pipeline start:', e);
        }

        // Execute each operation in sequence
        let allSuccess = true;
        let failedAtStep: PipelineOperation | null = null;

        for (let i = 0; i < this.currentPipeline.operations.length; i++) {
            const operation = this.currentPipeline.operations[i];
            this.currentPipeline.currentStep = i;
            this.emitStatusUpdate();

            this.log(`Pipeline step ${i + 1}/${this.currentPipeline.operations.length}: ${operation}`);

            // Broadcast progress
            try {
                const broadcaster = ServiceLocator.resolve(EventBroadcaster);
                broadcaster.unityPipelineProgress(
                    this.currentPipeline.id,
                    i + 1,
                    this.currentPipeline.operations.length,
                    operation,
                    this.currentPipeline.coordinatorId
                );
            } catch (e) {
                console.warn('[UnityControlManager] Failed to broadcast pipeline progress:', e);
            }

            const stepResult = await this.executePipelineStep(operation);
            this.currentPipeline.stepResults.push(stepResult);

            if (!stepResult.success) {
                allSuccess = false;
                failedAtStep = operation;
                this.log(`Pipeline failed at step: ${operation}`);
                break;  // Fail-fast
            }
        }

        // Complete the pipeline
        this.currentPipeline.status = allSuccess ? 'completed' : 'failed';
        this.currentPipeline.completedAt = new Date().toISOString();
        const duration = Date.now() - pipelineStartTime;

        // Build result for coordinator
        const result: PipelineResult = {
            pipelineId: this.currentPipeline.id,
            success: allSuccess,
            failedAtStep,
            stepResults: this.currentPipeline.stepResults,
            tasksInvolved: this.currentPipeline.tasksInvolved,
            allErrors: this.aggregateErrors(this.currentPipeline.stepResults),
            allTestFailures: this.aggregateTestFailures(this.currentPipeline.stepResults)
        };

        this.log(`Pipeline ${this.currentPipeline.id} ${allSuccess ? 'completed' : 'failed'}`);

        // Notify coordinator (and handle errors if any)
        await this.notifyPipelineComplete(result, duration);

        // Reset state
        this.currentPipeline = null;
        this.status = 'idle';
        this.emitStatusUpdate();

        // Process next in queue
        if (this.pipelineQueue.length > 0) {
            setTimeout(() => this.processPipelineQueue(), 2000);
        }
    }

    /**
     * Execute a single pipeline step
     * 
     * Uses UnityLogMonitor to capture console output with accurate timestamps
     * during the operation execution.
     */
    private async executePipelineStep(operation: PipelineOperation): Promise<PipelineStepResult> {
        const startTime = Date.now();
        let result: PipelineStepResult;

        // Start log monitoring for this step (captures console output with timestamps)
        const logMonitorStarted = this.logMonitor.startMonitoring();
        if (logMonitorStarted) {
            this.log(`[LogMonitor] Started monitoring for ${operation}`);
        }

        try {
            switch (operation) {
                case 'prep':
                    const prepResult = await this.executePrepEditor({
                        id: `step_prep_${Date.now()}`,
                        type: 'prep_editor',
                        priority: 1,
                        requestedBy: [],
                        status: 'executing',
                        createdAt: new Date().toISOString()
                    });
                    result = {
                        operation,
                        success: prepResult.success,
                        duration: Date.now() - startTime,
                        errors: prepResult.errors,
                        warnings: prepResult.warnings
                    };
                    break;

                case 'test_editmode':
                    const editResult = await this.executeTestFrameworkEditMode({
                        id: `step_editmode_${Date.now()}`,
                        type: 'test_framework_editmode',
                        priority: 2,
                        requestedBy: [],
                        status: 'executing',
                        createdAt: new Date().toISOString()
                    });
                    result = {
                        operation,
                        success: editResult.success,
                        duration: Date.now() - startTime,
                        errors: editResult.errors,
                        warnings: editResult.warnings,
                        testResults: editResult.testsPassed !== undefined ? {
                            passed: editResult.testsPassed,
                            failed: editResult.testsFailed || 0,
                            failures: editResult.testResults
                        } : undefined
                    };
                    break;

                case 'test_playmode':
                    const playResult = await this.executeTestFrameworkPlayMode({
                        id: `step_playmode_${Date.now()}`,
                        type: 'test_framework_playmode',
                        priority: 3,
                        requestedBy: [],
                        status: 'executing',
                        createdAt: new Date().toISOString()
                    });
                    result = {
                        operation,
                        success: playResult.success,
                        duration: Date.now() - startTime,
                        errors: playResult.errors,
                        warnings: playResult.warnings,
                        testResults: playResult.testsPassed !== undefined ? {
                            passed: playResult.testsPassed,
                            failed: playResult.testsFailed || 0,
                            failures: playResult.testResults
                        } : undefined
                    };
                    break;

                case 'test_player_playmode':
                    const playerResult = await this.executeTestPlayerPlayMode({
                        id: `step_player_${Date.now()}`,
                        type: 'test_player_playmode',
                        priority: 4,
                        requestedBy: [],
                        status: 'executing',
                        createdAt: new Date().toISOString()
                    });
                    result = {
                        operation,
                        success: playerResult.success,
                        duration: Date.now() - startTime,
                        errors: playerResult.errors,
                        warnings: playerResult.warnings
                    };
                    break;

                default:
                    result = {
                        operation,
                        success: false,
                        duration: Date.now() - startTime,
                        errors: [{
                            id: `err_${Date.now()}`,
                            type: 'runtime',
                            message: `Unknown operation: ${operation}`,
                            timestamp: new Date().toISOString()
                        }]
                    };
            }
        } catch (error) {
            result = {
                operation,
                success: false,
                duration: Date.now() - startTime,
                errors: [{
                    id: `err_${Date.now()}`,
                    type: 'runtime',
                    message: `Pipeline step failed: ${error}`,
                    timestamp: new Date().toISOString()
                }]
            };
        }

        // Stop log monitoring and capture results
        let logResult: LogMonitorResult | null = null;
        if (logMonitorStarted) {
            const pipelineId = this.currentPipeline?.id || `step_${operation}_${Date.now()}`;
            logResult = this.logMonitor.stopMonitoring(pipelineId);
            
            this.log(`[LogMonitor] Captured ${logResult.totalSegments} segments for ${operation}`);
            this.log(`[LogMonitor] Errors: ${logResult.errorCount}, Exceptions: ${logResult.exceptionCount}, Warnings: ${logResult.warningCount}`);
            
            if (logResult.persistedPath) {
                this.log(`[LogMonitor] Logs persisted to: ${logResult.persistedPath}`);
            }
            
            // Update success based on detected errors/exceptions
            // Coordinator will analyze the persisted log file for full context
            if (logResult.errorCount > 0 || logResult.exceptionCount > 0) {
                result.success = false;
                
                // Add a summary error entry pointing to the log file
                // Full error details are in the persisted log for AI analysis
                if (!result.errors) result.errors = [];
                result.errors.push({
                    id: `log_${Date.now()}`,
                    type: 'compilation',
                    message: `Detected ${logResult.errorCount} error(s) and ${logResult.exceptionCount} exception(s). See log file for details.`,
                    timestamp: new Date().toISOString(),
                    // Store the path in a way the coordinator can access
                    file: logResult.persistedPath || undefined
                });
            }
        }

        return result;
    }

    /**
     * Aggregate errors from all pipeline steps
     */
    private aggregateErrors(stepResults: PipelineStepResult[]): UnityError[] {
        const errors: UnityError[] = [];
        for (const step of stepResults) {
            if (step.errors) {
                errors.push(...step.errors);
            }
        }
        return errors;
    }

    /**
     * Aggregate test failures from all pipeline steps
     */
    private aggregateTestFailures(stepResults: PipelineStepResult[]): TestResult[] {
        const failures: TestResult[] = [];
        for (const step of stepResults) {
            if (step.testResults?.failures) {
                failures.push(...step.testResults.failures);
            }
        }
        return failures;
    }

    /**
     * Notify coordinator of pipeline completion
     */
    private async notifyPipelineComplete(result: PipelineResult, duration: number): Promise<void> {
        // Fire callback
        if (this.onPipelineCompleteCallback) {
            this.onPipelineCompleteCallback(result);
        }

        // Log summary
        this.log(`📢 Pipeline ${result.pipelineId} complete:`);
        this.log(`   Success: ${result.success}`);
        this.log(`   Failed at: ${result.failedAtStep || 'none'}`);
        this.log(`   Errors: ${result.allErrors.length}`);
        this.log(`   Test failures: ${result.allTestFailures.length}`);
        this.log(`   Tasks involved: ${result.tasksInvolved.map(t => t.taskId).join(', ')}`);

        // Broadcast pipeline completed event to all clients
        try {
            const broadcaster = ServiceLocator.resolve(EventBroadcaster);
            
            // Extract session ID from coordinator ID (if it's a session)
            const sessionId = result.tasksInvolved[0] && this.currentPipeline 
                ? this.currentPipeline.coordinatorId 
                : undefined;
            
            broadcaster.unityPipelineCompleted(
                result.pipelineId,
                result.success,
                this.currentPipeline?.operations || [],
                result.allErrors,
                result.allTestFailures.map(t => ({ test: t.testName, message: t.message || '' })),
                result.tasksInvolved.map(t => ({ taskId: t.taskId, description: t.stage })),
                duration,
                result.failedAtStep || undefined,
                sessionId
            );
            
            this.log(`✓ Broadcast pipeline completion to all clients`);
        } catch (e) {
            // Broadcaster may not be available in some contexts
            console.warn('[UnityControlManager] Failed to broadcast pipeline completion:', e);
        }

        // If there are errors, route them to global error handling
        if (result.allErrors.length > 0) {
            this.log(`Routing ${result.allErrors.length} errors to global error handler...`);
            await this.handlePipelineErrors(result.allErrors);
        }
    }

    /**
     * Set callback for pipeline completion notifications
     */
    onPipelineComplete(callback: (result: PipelineResult) => void): void {
        this.onPipelineCompleteCallback = callback;
    }

    /**
     * Get current pipeline status
     */
    getPipelineStatus(): {
        currentPipeline: PipelineRequest | null;
        queueLength: number;
        queuedPipelines: Array<{ id: string; operations: string[]; taskCount: number }>;
    } {
        return {
            currentPipeline: this.currentPipeline,
            queueLength: this.pipelineQueue.length,
            queuedPipelines: this.pipelineQueue.map(p => ({
                id: p.id,
                operations: p.operations,
                taskCount: p.tasksInvolved.length
            }))
        };
    }

    // ========================================================================
    // Global Error Handling - Cross-Plan Error Resolution
    // ========================================================================

    /**
     * Handle pipeline errors by creating error-fixing tasks and pausing affected work
     * 
     * This is the main entry point for handling Unity compilation/test errors.
     * It:
     * 1. Finds all tasks across all plans that touch the affected files
     * 2. Pauses those tasks and their dependents
     * 3. Creates error-fixing tasks in the ERROR_RESOLUTION plan
     * 4. Tells coordinator to execute ERROR_RESOLUTION plan
     * 
     * @param errors - Array of Unity errors from pipeline
     * @returns IDs of created error-fixing tasks
     */
    async handlePipelineErrors(errors: UnityError[]): Promise<string[]> {
        if (errors.length === 0) {
            this.log('handlePipelineErrors: No errors to process');
            return [];
        }

        this.log(`handlePipelineErrors: Processing ${errors.length} errors`);

        // Get global TaskManager
        const taskManager = ServiceLocator.resolve(TaskManager);

        // Extract files from errors
        const errorFiles = errors
            .filter(e => e.file)
            .map(e => e.file!);

        if (errorFiles.length === 0) {
            this.log('handlePipelineErrors: No files identified in errors');
        }

        // 1. Find affected tasks across all plans
        const affected = taskManager.findAffectedTasksAcrossPlans(errorFiles);
        this.log(`handlePipelineErrors: Found ${affected.length} affected tasks across plans`);

        const affectedTaskIds = affected.map(a => a.taskId);

        if (affectedTaskIds.length > 0) {
            // Pause affected tasks and their dependents
            const pausedBySession = taskManager.pauseTasksAndDependents(
                affectedTaskIds,
                `Unity error in files: ${errorFiles.slice(0, 3).join(', ')}${errorFiles.length > 3 ? '...' : ''}`
            );
            
            this.log(`handlePipelineErrors: Paused tasks in ${pausedBySession.size} session(s)`);
            
            for (const [sessionId, pausedTaskIds] of pausedBySession) {
                this.log(`  Session ${sessionId}: ${pausedTaskIds.length} tasks paused`);
            }
        }

        // 2. Build raw error text for coordinator
        const rawErrorText = errors
            .map(e => `${e.file || 'unknown'}(${e.line || 0}): ${e.code || ''} ${e.message}`)
            .join('\n');

        // 3. Trigger coordinator with raw error text - it will create tasks via CLI
        try {
            const coordinator = ServiceLocator.resolve(UnifiedCoordinatorService);
            await coordinator.triggerCoordinatorEvaluation(
                ERROR_RESOLUTION_SESSION_ID,
                'unity_error',
                {
                    type: 'unity_error',
                    errorText: rawErrorText,
                    errorCount: errors.length,
                    affectedTaskIds,
                    files: errorFiles
                }
            );
            this.log(`handlePipelineErrors: Triggered coordinator with ${errors.length} errors`);
        } catch (e) {
            // Coordinator may not be initialized yet - that's ok
            this.log(`handlePipelineErrors: Could not trigger coordinator: ${e}`);
        }

        // Return empty - tasks are now created via CLI by coordinator
        return [];
    }

    /**
     * Check for errors after a pipeline step and handle them
     * Called automatically after prep/compile steps
     */
    private async checkAndHandleErrors(): Promise<void> {
        const console = await this.readUnityConsole();
        const compilationErrors = console.errors.filter(e => 
            e.type === 'compilation' || e.code?.startsWith('CS')
        );

        if (compilationErrors.length > 0) {
            this.log(`Detected ${compilationErrors.length} compilation errors, routing to global handler`);
            await this.handlePipelineErrors(compilationErrors);
        }
    }

    /**
     * Stop the manager
     */
    async stop(): Promise<void> {
        this.isRunning = false;
        
        // Clear any pending restart timeout
        if (this.pollingAgentRestartTimeout) {
            clearTimeout(this.pollingAgentRestartTimeout);
            this.pollingAgentRestartTimeout = null;
        }
        
        await this.stopPollingAgent();
        this.log('Unity Control Manager stopped');
    }
    
    /**
     * Dispose all resources
     * Call this on extension deactivation
     */
    async dispose(): Promise<void> {
        await this.stop();
        
        // Dispose event emitters
        this._onStatusChanged.dispose();
        this._onTaskCompleted.dispose();
        
        this.log('Unity Control Manager disposed');
    }

    /**
     * Show output channel
     */
    showOutput(): void {
        this.outputManager.show();
    }
}

