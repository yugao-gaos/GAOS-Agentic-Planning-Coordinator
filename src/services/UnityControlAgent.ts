import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import {
    UnityTask,
    UnityTaskType,
    UnityTaskResult,
    UnityError,
    UnityWarning,
    TaskRequester,
    UnityControlAgentState,
    UnityControlAgentStatus,
    UnityEditorState,
    UnityConsoleMessage
} from '../types/unity';
import { OutputChannelManager } from './OutputChannelManager';

// ============================================================================
// Unity Control Agent - Singleton Background Service
// ============================================================================

/**
 * Unity Control Agent - Manages all Unity Editor operations
 * 
 * This is a SINGLETON service that runs in the background and manages:
 * - Task queue (prep_editor, tests, etc.)
 * - Unity Editor state monitoring
 * - Error collection and routing
 * 
 * All engineers and coordinators queue their Unity requests through this agent.
 * Only ONE Unity operation can run at a time.
 */
export class UnityControlAgent {
    private static instance: UnityControlAgent;

    private workspaceRoot: string = '';
    private queue: UnityTask[] = [];
    private currentTask: UnityTask | null = null;
    private status: UnityControlAgentStatus = 'idle';
    private isRunning: boolean = false;
    private tempScenePath: string = 'Assets/Scenes/_TempCompileCheck.unity';
    private errorRegistryPath: string = '';

    // Event emitters
    private _onStatusChanged = new vscode.EventEmitter<UnityControlAgentState>();
    readonly onStatusChanged = this._onStatusChanged.event;

    private _onTaskCompleted = new vscode.EventEmitter<{ task: UnityTask; result: UnityTaskResult }>();
    readonly onTaskCompleted = this._onTaskCompleted.event;

    // Output channel for logging
    private outputManager: OutputChannelManager;

    // Task ID counter
    private taskIdCounter: number = 0;

    private constructor() {
        this.outputManager = OutputChannelManager.getInstance();
    }

    /**
     * Get singleton instance
     */
    static getInstance(): UnityControlAgent {
        if (!UnityControlAgent.instance) {
            UnityControlAgent.instance = new UnityControlAgent();
        }
        return UnityControlAgent.instance;
    }

    /**
     * Initialize the agent with workspace root
     */
    async initialize(workspaceRoot: string): Promise<void> {
        this.workspaceRoot = workspaceRoot;
        this.errorRegistryPath = path.join(workspaceRoot, '_AiDevLog/Errors/error_registry.md');

        this.log('Initializing Unity Control Agent...');
        this.log(`Workspace: ${workspaceRoot}`);

        // Ensure temp scene exists
        await this.ensureTempSceneExists();

        // Start the queue processor
        this.startQueueProcessor();

        this.log('Unity Control Agent initialized');
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

        // For now, we'll try to create it via a cursor agent call
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

        this.log(`Task queued: ${type} (ID: ${taskId}) from ${task.requestedBy.map(r => r.engineerName).join(', ')}`);
        this.emitStatusUpdate();

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

            // Step 5: Read console for errors
            this.log('Reading Unity console...');
            const consoleResult = await this.readUnityConsole();
            errors.push(...consoleResult.errors);
            warnings.push(...consoleResult.warnings);

            // Step 6: Route errors to coordinators (via ErrorRouter)
            if (errors.length > 0) {
                this.log(`Found ${errors.length} errors, routing to coordinators...`);
                // Error routing will be handled by ErrorRouter service
                // This service just collects and returns the errors
            }

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

        // Check for compilation errors first
        const consoleCheck = await this.readUnityConsole();
        const compilationErrors = consoleCheck.errors.filter(e => e.code?.startsWith('CS'));

        if (compilationErrors.length > 0) {
            this.log('Cannot run tests - compilation errors exist');
            return {
                success: false,
                errors: compilationErrors,
                warnings: consoleCheck.warnings,
                testsPassed: 0,
                testsFailed: 0
            };
        }

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

            // Show notification
            vscode.window.showInformationMessage(
                '🎮 Player Test Started - Play the game and exit playmode when done'
            );

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

                // Update notification with error count
                if (errors.length > 0) {
                    vscode.window.showWarningMessage(
                        `🎮 Playing... (${errors.length} errors collected)`
                    );
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
     */
    private async focusUnityEditor(): Promise<void> {
        const platform = process.platform;

        if (platform === 'darwin') {
            await new Promise<void>((resolve, reject) => {
                const proc = spawn('osascript', ['-e', 'tell application "Unity" to activate']);
                proc.on('close', () => resolve());
                proc.on('error', reject);
            });
        } else if (platform === 'win32') {
            // Windows - use PowerShell
            // TODO: Implement Windows focus
        }
    }

    /**
     * Wait for Unity compilation to complete
     */
    private async waitForCompilation(timeoutSeconds: number): Promise<boolean> {
        const startTime = Date.now();

        while ((Date.now() - startTime) / 1000 < timeoutSeconds) {
            const state = await this.getEditorState();

            if (!state.isCompiling && !state.isImporting) {
                return true;
            }

            this.log('Unity still compiling/importing...');
            await this.sleep(5000);
        }

        return false;
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
     */
    private async readUnityConsoleSince(sinceTimestamp: number): Promise<{ errors: UnityError[]; warnings: UnityWarning[] }> {
        // For now, just read all and filter by type
        // TODO: Implement proper timestamp filtering
        return this.readUnityConsole();
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
     * Run a cursor agent command and get the response
     */
    private async runCursorAgentCommand(prompt: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const proc = spawn('cursor', [
                'agent',
                '--print',
                '--output-format', 'text',
                '--approve-mcps',
                '--force',
                '--model', 'gpt-4o-mini',
                '--workspace', this.workspaceRoot,
                prompt
            ]);

            let output = '';
            let error = '';

            proc.stdout?.on('data', (data) => {
                output += data.toString();
            });

            proc.stderr?.on('data', (data) => {
                error += data.toString();
            });

            proc.on('close', (code) => {
                if (code === 0) {
                    // Get last line as result
                    const lines = output.trim().split('\n');
                    resolve(lines[lines.length - 1] || '');
                } else {
                    reject(new Error(`Cursor agent failed: ${error}`));
                }
            });

            proc.on('error', reject);
        });
    }

    /**
     * Sleep utility
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Log to unified output channel
     */
    private log(message: string): void {
        this.outputManager.log('UNITY', message);
    }

    /**
     * Emit status update
     */
    private emitStatusUpdate(): void {
        this._onStatusChanged.fire(this.getState());
    }

    /**
     * Get current state
     */
    getState(): UnityControlAgentState {
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

    /**
     * Stop the agent
     */
    stop(): void {
        this.isRunning = false;
        this.log('Unity Control Agent stopped');
    }

    /**
     * Show output channel
     */
    showOutput(): void {
        this.outputManager.show();
    }
}

