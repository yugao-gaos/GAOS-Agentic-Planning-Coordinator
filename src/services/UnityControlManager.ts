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
import { AgentRoleRegistry } from './AgentRoleRegistry';
import { TaskManager, ERROR_RESOLUTION_SESSION_ID } from './TaskManager';
import { UnifiedCoordinatorService } from './UnifiedCoordinatorService';
import { StateManager } from './StateManager';
import { ServiceLocator } from './ServiceLocator';
import { EventBroadcaster } from '../daemon/EventBroadcaster';
import { getFolderStructureManager } from './FolderStructureManager';

// ============================================================================
// Unity Control Manager - Background Service
// ============================================================================

/**
 * Unity Editor state tracked via Unity Bridge events.
 * 
 * Note: Error tracking and log capture is handled by Unity Bridge internally.
 * Editor state (isCompiling, isPlaying, isPaused) is pushed from Unity Bridge.
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
 * - Unity Editor state monitoring via Unity Bridge WebSocket events
 * - Error collection and routing
 * 
 * All Unity operations are executed via the Unity Bridge package, which provides
 * direct WebSocket communication between Unity Editor and this daemon.
 * 
 * Engineers MUST use this manager (via CLI) for WRITE/BLOCKING operations:
 * - Compilation (prep_editor) - freezes Unity
 * - Tests (editmode/playmode) - requires exclusive access
 * - Play mode control - only one can run at a time
 * 
 * UNITY BRIDGE:
 * - Unity package (com.gaos.apc.bridge) connects via WebSocket to daemon
 * - Pushes state change events (compile, playmode, test progress)
 * - Receives commands (compile, runTests, enterPlayMode, etc.)
 * 
 * Only ONE Unity blocking operation can run at a time.
 * 
 * Obtain via ServiceLocator:
 *   const manager = ServiceLocator.resolve(UnityControlManager);
 */
export class UnityControlManager {
    private workspaceRoot: string = '';
    private status: UnityControlManagerStatus = 'idle';
    private tempScenePath: string = 'Assets/Scenes/_TempCompileCheck.unity';
    private errorRegistryPath: string = '';

    // Pipeline queue system
    private pipelineQueue: PipelineRequest[] = [];
    private currentPipeline: PipelineRequest | null = null;
    private pipelineIdCounter: number = 0;
    
    // Callback for notifying coordinator of pipeline completion
    private onPipelineCompleteCallback?: (result: PipelineResult) => void;

    // Unity editor status (updated via bridge events)
    private lastUnityStatus: UnityEditorStatus | null = null;

    // Event emitters
    private _onStatusChanged = new TypedEventEmitter<UnityControlManagerState>();
    readonly onStatusChanged = this._onStatusChanged.event;

    // Output channel for logging
    private outputManager: OutputChannelManager;
    
    // Log file path for Unity pipeline logs
    private logFilePath: string | null = null;
    
    // Agent Role Registry for customizable prompts
    private agentRoleRegistry: AgentRoleRegistry | null = null;
    
    // Direct Unity WebSocket connection (via daemon)
    private unityClientConnected: boolean = false;
    private sendToUnityClient?: (cmd: string, params?: Record<string, unknown>) => Promise<any>;
    private queryUnityState?: () => Promise<{ isCompiling: boolean; isPlaying: boolean; isBusy: boolean; editorReady: boolean } | null>;

    constructor() {
        this.outputManager = ServiceLocator.resolve(OutputChannelManager);
    }
    
    /**
     * Set up callbacks for direct Unity WebSocket communication.
     * Called by daemon when services are initialized.
     */
    setUnityDirectCallbacks(
        sendCommand: (cmd: string, params?: Record<string, unknown>) => Promise<any>,
        queryState: () => Promise<{ isCompiling: boolean; isPlaying: boolean; isBusy: boolean; editorReady: boolean } | null>
    ): void {
        this.sendToUnityClient = sendCommand;
        this.queryUnityState = queryState;
    }
    
    /**
     * Called by daemon when Unity client connects
     */
    onUnityClientConnected(): void {
        this.log('Unity client connected via WebSocket');
        this.unityClientConnected = true;
        this.emitStatusUpdate();  // Notify UI of connection
    }
    
    /**
     * Called by daemon when Unity client disconnects
     */
    onUnityClientDisconnected(): void {
        this.log('Unity client disconnected');
        this.unityClientConnected = false;
        
        // Clear any pending compile wait
        if (this.compileCompleteResolve) {
            this.compileCompleteResolve();
            this.compileCompleteResolve = null;
        }
        
        // Clear test complete wait
        if (this.testCompleteResolve) {
            this.testCompleteResolve({ passed: 0, failed: 0, skipped: 0, duration: 0 });
            this.testCompleteResolve = null;
        }
        
        this.emitStatusUpdate();  // Notify UI of disconnection
    }
    
    // ========================================================================
    // Unity Bridge Event Reception
    // ========================================================================
    
    /** Pending promise resolve for compile completion */
    private compileCompleteResolve: (() => void) | null = null;
    
    /** Pending promise resolve for test completion */
    private testCompleteResolve: ((result: { passed: number; failed: number; skipped: number; duration: number }) => void) | null = null;
    
    /** Last test progress data */
    private lastTestProgress: { phase: string; testCount?: number } | null = null;
    
    /**
     * Receive events from Unity Bridge (via daemon).
     * Called when Unity pushes state changes, compile events, test events, etc.
     */
    receiveUnityEvent(eventName: string, data: any): void {
        this.log(`Received Unity event: ${eventName}`);
        
        switch (eventName) {
            case 'unity.stateChanged':
                this.handleStateChangedEvent(data);
                break;
            case 'unity.compileStarted':
                this.handleCompileStartedEvent(data);
                break;
            case 'unity.compileComplete':
                this.handleCompileCompleteEvent(data);
                break;
            case 'unity.playModeChanged':
                this.handlePlayModeChangedEvent(data);
                break;
            case 'unity.testProgress':
                this.handleTestProgressEvent(data);
                break;
            case 'unity.testComplete':
                this.handleTestCompleteEvent(data);
                break;
            case 'unity.error':
                this.handleUnityErrorEvent(data);
                break;
            default:
                this.log(`Unknown Unity event: ${eventName}`);
        }
    }
    
    /**
     * Handle state changed event from Unity.
     * Updates internal status and broadcasts to UI.
     */
    private handleStateChangedEvent(data: {
        isCompiling: boolean;
        isPlaying: boolean;
        isPaused: boolean;
        isBusy: boolean;
        currentOperation?: string;
        editorReady: boolean;
    }): void {
        const wasCompiling = this.lastUnityStatus?.isCompiling ?? false;
        const nowCompiling = data.isCompiling;
        
        this.lastUnityStatus = {
            isCompiling: data.isCompiling,
            isPlaying: data.isPlaying,
            isPaused: data.isPaused,
            timestamp: Date.now()
        };
        
        // Detect compilation transitions
        if (!wasCompiling && nowCompiling) {
            this.log('Unity compilation started (from state event)');
            this.focusUnityEditor();
        } else if (wasCompiling && !nowCompiling) {
            this.log('Unity compilation complete (from state event)');
            this.resolveCompileComplete();
        }
        
        this.emitStatusUpdate();
    }
    
    /**
     * Handle compile started event from Unity.
     */
    private handleCompileStartedEvent(data: { timestamp: string }): void {
        this.log(`Compile started at ${data.timestamp}`);
        
        this.lastUnityStatus = {
            ...this.lastUnityStatus,
            isCompiling: true,
            timestamp: Date.now()
        } as UnityEditorStatus;
        
        this.focusUnityEditor();
        this.emitStatusUpdate();
    }
    
    /**
     * Handle compile complete event from Unity.
     */
    private handleCompileCompleteEvent(data: { timestamp: string }): void {
        this.log(`Compile complete at ${data.timestamp}`);
        
        this.lastUnityStatus = {
            ...this.lastUnityStatus,
            isCompiling: false,
            timestamp: Date.now()
        } as UnityEditorStatus;
        
        this.resolveCompileComplete();
        this.emitStatusUpdate();
    }
    
    /**
     * Handle play mode changed event from Unity.
     */
    private handlePlayModeChangedEvent(data: {
        state: string;
        isPlaying: boolean;
        isPaused: boolean;
        timestamp: string;
    }): void {
        this.log(`Play mode changed: ${data.state}`);
        
        this.lastUnityStatus = {
            ...this.lastUnityStatus,
            isPlaying: data.isPlaying,
            isPaused: data.isPaused,
            timestamp: Date.now()
        } as UnityEditorStatus;
        
        this.emitStatusUpdate();
    }
    
    /**
     * Handle test progress event from Unity.
     */
    private handleTestProgressEvent(data: { phase: string; testCount?: number }): void {
        this.log(`Test progress: ${data.phase}${data.testCount ? ` (${data.testCount} tests)` : ''}`);
        this.lastTestProgress = data;
    }
    
    /**
     * Handle test complete event from Unity.
     */
    private handleTestCompleteEvent(data: {
        operationId: string;
        mode: string;
        passed: number;
        failed: number;
        skipped: number;
        duration: number;
        failures?: Array<{ testName: string; message: string; stackTrace?: string }>;
    }): void {
        this.log(`Tests complete: ${data.passed} passed, ${data.failed} failed, ${data.skipped} skipped`);
        
        // Resolve any pending test wait
        if (this.testCompleteResolve) {
            this.testCompleteResolve({
                passed: data.passed,
                failed: data.failed,
                skipped: data.skipped,
                duration: data.duration
            });
            this.testCompleteResolve = null;
        }
        
        this.lastTestProgress = null;
    }
    
    /**
     * Handle error event from Unity.
     */
    private handleUnityErrorEvent(data: { message: string; stackTrace?: string }): void {
        this.log(`Unity error: ${data.message}`);
    }
    
    /**
     * Resolve compile complete promise if waiting.
     */
    private resolveCompileComplete(): void {
        if (this.compileCompleteResolve) {
            this.compileCompleteResolve();
            this.compileCompleteResolve = null;
        }
    }
    
    /**
     * Wait for compilation to complete via Unity Bridge events.
     * Returns true when compilation completes, false on timeout.
     */
    private waitForCompilationViaEvents(timeoutSeconds: number): Promise<boolean> {
        return new Promise((resolve) => {
            // Check if already not compiling
            if (this.lastUnityStatus && !this.lastUnityStatus.isCompiling) {
                resolve(true);
                return;
            }
            
            // Set up timeout
            const timeoutId = setTimeout(() => {
                this.log('Compile wait timed out');
                this.compileCompleteResolve = null;
                resolve(false);
            }, timeoutSeconds * 1000);
            
            // Store resolve function for event handler
            this.compileCompleteResolve = () => {
                clearTimeout(timeoutId);
                resolve(true);
            };
        });
    }
    
    /**
     * Wait for test completion via Unity Bridge events.
     * Returns test results when complete, or timeout result.
     */
    private waitForTestCompletionViaEvents(timeoutSeconds: number): Promise<{ passed: number; failed: number; skipped: number; duration: number }> {
        return new Promise((resolve) => {
            // Set up timeout
            const timeoutId = setTimeout(() => {
                this.log('Test wait timed out');
                this.testCompleteResolve = null;
                resolve({ passed: 0, failed: 0, skipped: 0, duration: 0 });
            }, timeoutSeconds * 1000);
            
            // Store resolve function for event handler
            this.testCompleteResolve = (result) => {
                clearTimeout(timeoutId);
                resolve(result);
            };
        });
    }
    
    /**
     * Check if direct Unity connection is available
     */
    isDirectConnectionAvailable(): boolean {
        return this.unityClientConnected && !!this.sendToUnityClient;
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

        this.log('Initializing Unity Control Manager...');
        this.log(`Workspace: ${workspaceRoot}`);

        // Create ERROR_RESOLUTION session/plan (persistent, lives forever)
        // This session handles all error-fixing tasks across all plans
        const taskManager = ServiceLocator.resolve(TaskManager);
        taskManager.registerSession(ERROR_RESOLUTION_SESSION_ID, '');
        this.log('ERROR_RESOLUTION plan initialized');

        // Ensure temp scene exists
        await this.ensureTempSceneExists();

        this.log('Unity Control Manager initialized');
    }

    /**
     * Ensure temp scene exists for compilation checks
     * Uses direct Unity Bridge connection to create if missing
     */
    async ensureTempSceneExists(): Promise<boolean> {
        const fullPath = path.join(this.workspaceRoot, this.tempScenePath);

        // Check if scene file exists on disk
        if (fs.existsSync(fullPath)) {
            this.log(`Temp scene exists: ${this.tempScenePath}`);
            return true;
        }

        // Need to create via direct connection
        this.log('Temp scene not found, creating via Unity Bridge...');

        if (!this.isDirectConnectionAvailable()) {
            this.log('Cannot create temp scene: Unity Bridge not connected');
            return false;
        }

        try {
            const result = await this.executeViaDirect('unity.direct.createScene', {
                name: '_TempCompileCheck',
                path: 'Assets/Scenes'
            });

            if (result?.success) {
                this.log('Temp scene created via Unity Bridge');
                return true;
            } else {
                this.log(`Failed to create temp scene: ${result?.error || 'unknown error'}`);
                return false;
            }
        } catch (error) {
            this.log(`Error creating temp scene: ${error}`);
            return false;
        }
    }

    // Note: Individual step execution methods removed - Unity Bridge handles all pipeline
    // steps internally via unity.direct.runPipeline command

    // ========================================================================
    // Helper Methods
    // ========================================================================

    /**
     * Focus Unity Editor window via Unity Bridge.
     * Requires Unity Bridge to be connected.
     */
    private async focusUnityEditor(): Promise<void> {
        if (!this.isDirectConnectionAvailable() || !this.sendToUnityClient) {
            this.log('Cannot focus Unity: Unity Bridge not connected');
            return;
        }
        
        try {
            const result = await this.executeViaDirect('unity.direct.focusEditor');
            if (result?.success) {
                this.log('Focused Unity Editor via bridge');
            } else {
                this.log(`Failed to focus Unity Editor: ${result?.error || 'unknown error'}`);
            }
        } catch (err) {
            this.log(`Failed to focus Unity Editor: ${err}`);
        }
    }

    /**
     * Wait for Unity compilation to complete
     * Uses direct Unity Bridge connection for monitoring
     */
    private async waitForCompilation(timeoutSeconds: number): Promise<boolean> {
        return this.waitForCompilationViaDirect(timeoutSeconds);
    }

    /**
     * Get Unity editor state via direct connection
     */
    private async getEditorState(): Promise<UnityEditorState> {
        if (!this.isDirectConnectionAvailable() || !this.queryUnityState) {
            return {
                isPlaying: false,
                isPaused: false,
                isCompiling: false,
                applicationPath: '',
                projectPath: '',
                unityVersion: ''
            };
        }

        try {
            const state = await this.queryUnityState();
            return {
                isPlaying: state?.isPlaying ?? false,
                isPaused: false, // Not tracked in direct connection
                isCompiling: state?.isCompiling ?? false,
                applicationPath: '',
                projectPath: '',
                unityVersion: ''
            };
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
     * Read Unity console for errors via direct connection
     * Note: Error detection is primarily done by Unity Bridge during pipeline execution
     */
    private async readUnityConsole(): Promise<{ errors: UnityError[]; warnings: UnityWarning[] }> {
        if (!this.isDirectConnectionAvailable()) {
            return { errors: [], warnings: [] };
        }

        try {
            const result = await this.executeViaDirect('unity.direct.getConsole', { count: 100 });
            
            if (!result) {
                return { errors: [], warnings: [] };
            }
            
            return {
                errors: (result.errors || []).map((e: any, i: number) => ({
                    id: `err_${Date.now()}_${i}`,
                    type: 'compilation' as const,
                    code: e.code,
                    message: e.message,
                    file: e.file,
                    line: e.line,
                    timestamp: new Date().toISOString()
                })),
                warnings: (result.warnings || []).map((w: any) => ({
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
     * Sleep utility
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    // ========================================================================
    // Direct Unity WebSocket Communication
    // ========================================================================
    
    /**
     * Query Unity state before executing an operation.
     * Requires Unity Bridge connection.
     */
    private async queryUnityStateBeforeOperation(): Promise<{
        ready: boolean;
        reason?: string;
        state?: { isCompiling: boolean; isPlaying: boolean; isBusy: boolean; editorReady: boolean };
    }> {
        if (!this.isDirectConnectionAvailable() || !this.queryUnityState) {
            return { ready: false, reason: 'Unity Bridge not connected' };
        }
        
        try {
            const state = await this.queryUnityState();
            if (!state) {
                return { ready: false, reason: 'Failed to query Unity state' };
            }
            
            if (state.isBusy) {
                return { ready: false, reason: 'Unity is busy with another operation', state };
            }
            if (state.isCompiling) {
                return { ready: false, reason: 'Unity is compiling', state };
            }
            if (!state.editorReady) {
                return { ready: false, reason: 'Unity Editor is not ready', state };
            }
            
            return { ready: true, state };
        } catch (err) {
            this.log(`Failed to query Unity state: ${err}`);
            return { ready: false, reason: `Query failed: ${err}` };
        }
    }
    
    /**
     * Execute a Unity command via direct WebSocket connection.
     * Throws error if connection not available.
     */
    private async executeViaDirect(cmd: string, params?: Record<string, unknown>): Promise<any> {
        if (!this.isDirectConnectionAvailable() || !this.sendToUnityClient) {
            throw new Error('Unity Bridge not connected');
        }
        
        try {
            // Query state first
            const stateCheck = await this.queryUnityStateBeforeOperation();
            if (!stateCheck.ready) {
                this.log(`Cannot execute ${cmd}: ${stateCheck.reason}`);
                throw new Error(stateCheck.reason || 'Unity not ready');
            }
            
            // Execute command
            this.log(`Executing via direct WebSocket: ${cmd}`);
            const result = await this.sendToUnityClient(cmd, params);
            return result;
        } catch (err) {
            this.log(`Direct execution failed: ${err}`);
            throw err;
        }
    }
    
    /**
     * Enter play mode - requires direct connection
     */
    async enterPlayMode(): Promise<boolean> {
        if (!this.isDirectConnectionAvailable()) {
            this.log('Cannot enter play mode: Unity Bridge not connected');
            return false;
        }
        
        try {
            const result = await this.executeViaDirect('unity.direct.enterPlayMode');
            return result?.success ?? false;
        } catch (err) {
            this.log(`Failed to enter play mode: ${err}`);
            return false;
        }
    }
    
    /**
     * Exit play mode - requires direct connection
     */
    async exitPlayMode(): Promise<boolean> {
        if (!this.isDirectConnectionAvailable()) {
            this.log('Cannot exit play mode: Unity Bridge not connected');
            return false;
        }
        
        try {
            const result = await this.executeViaDirect('unity.direct.exitPlayMode');
            return result?.success ?? false;
        } catch (err) {
            this.log(`Failed to exit play mode: ${err}`);
            return false;
        }
    }
    
    /**
     * Load a scene - requires direct connection
     */
    async loadScene(scenePath: string): Promise<boolean> {
        if (!this.isDirectConnectionAvailable()) {
            this.log('Cannot load scene: Unity Bridge not connected');
            return false;
        }
        
        try {
            const result = await this.executeViaDirect('unity.direct.loadScene', { path: scenePath });
            return result?.success ?? false;
        } catch (err) {
            this.log(`Failed to load scene: ${err}`);
            return false;
        }
    }
    
    /**
     * Trigger compilation - focuses Unity, waits for compile, then focuses back to Cursor
     * Requires direct connection for state monitoring
     */
    async triggerCompile(): Promise<boolean> {
        if (!this.isDirectConnectionAvailable()) {
            this.log('Cannot trigger compile: Unity Bridge not connected');
            return false;
        }
        
        try {
            // Step 1: Focus Unity Editor to trigger reimport/recompile
            this.log('Focusing Unity Editor to trigger compile...');
            await this.focusUnityEditor();
            
            // Step 2: Tell Unity Bridge we're triggering compile (it will track state)
            const result = await this.executeViaDirect('unity.direct.compile');
            if (!result?.success) {
                this.log('Unity Bridge compile command failed');
                return false;
            }
            
            // Check if compilation actually started
            const isCompiling = result?.data?.compiling ?? false;
            
            if (isCompiling) {
                // Step 3: Wait for compilation to complete
                this.log('Waiting for Unity compilation to complete...');
                await this.waitForCompilationViaDirect(120); // 2 minute timeout
            } else {
                this.log('No compilation needed (no script changes)');
            }
            
            // Step 4: Focus back to Cursor
            this.log('Compilation complete, focusing back to Cursor...');
            await this.focusCursorEditor();
            
            return true;
        } catch (err) {
            this.log(`Compile failed: ${err}`);
            // Try to focus back to Cursor even on failure
            await this.focusCursorEditor();
            return false;
        }
    }
    
    /**
     * Wait for compilation to complete via Unity Bridge events.
     * Uses event-driven approach - Unity pushes compileComplete event when done.
     */
    private async waitForCompilationViaDirect(timeoutSeconds: number): Promise<boolean> {
        if (!this.isDirectConnectionAvailable()) {
            this.log('Cannot wait for compile: Unity Bridge not connected');
            return false;
        }
        
        // Use event-driven waiting
        return this.waitForCompilationViaEvents(timeoutSeconds);
    }
    
    /**
     * Focus Cursor editor window
     * Works on macOS, Windows, and Linux
     * Uses aggressive techniques to overcome Windows foreground restrictions
     */
    private async focusCursorEditor(): Promise<void> {
        const platform = process.platform;
        
        // Get workspace name to match window title
        const workspaceName = path.basename(this.workspaceRoot);

        if (platform === 'darwin') {
            // macOS - use AppleScript
            await new Promise<void>((resolve, reject) => {
                const proc = spawn('osascript', ['-e', 'tell application "Cursor" to activate']);
                proc.on('close', () => resolve());
                proc.on('error', reject);
            });
        } else if (platform === 'win32') {
            // Windows - use PowerShell with aggressive focus techniques
            // Match by window title containing workspace name for accuracy
            await new Promise<void>((resolve) => {
                const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Focus {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, ref uint pvParam, uint fWinIni);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int dwProcessId);
    public const byte VK_MENU = 0x12;
    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000;
    public const uint SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001;
    public const uint SPIF_SENDCHANGE = 0x0002;
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_SHOWWINDOW = 0x0040;
    public const int SW_RESTORE = 9;
    public const int ASFW_ANY = -1;
    
    public static void FocusWindow(IntPtr hWnd) {
        uint oldTimeout = 0;
        SystemParametersInfo(SPI_GETFOREGROUNDLOCKTIMEOUT, 0, ref oldTimeout, 0);
        uint zero = 0;
        SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, ref zero, SPIF_SENDCHANGE);
        try {
            AllowSetForegroundWindow(ASFW_ANY);
            keybd_event(VK_MENU, 0, KEYEVENTF_EXTENDEDKEY, UIntPtr.Zero);
            keybd_event(VK_MENU, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, UIntPtr.Zero);
            if (IsIconic(hWnd)) { ShowWindow(hWnd, SW_RESTORE); } else { ShowWindow(hWnd, 5); }
            SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            SetWindowPos(hWnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            BringWindowToTop(hWnd);
            SetForegroundWindow(hWnd);
            SwitchToThisWindow(hWnd, true);
        } finally {
            SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, ref oldTimeout, SPIF_SENDCHANGE);
        }
    }
}
"@
# First try to find by window title containing workspace name (most accurate)
$workspaceName = "${workspaceName}"
$cursor = Get-Process -Name "Cursor" -ErrorAction SilentlyContinue | Where-Object { 
    $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -like "*$workspaceName*"
} | Select-Object -First 1

# Fallback to any Cursor window with a handle
if (-not $cursor) {
    $cursor = Get-Process -Name "Cursor" -ErrorAction SilentlyContinue | Where-Object { 
        $_.MainWindowHandle -ne [IntPtr]::Zero 
    } | Select-Object -First 1
}

if ($cursor) {
    [Win32Focus]::FocusWindow($cursor.MainWindowHandle)
}
`;
                const proc = spawn('powershell', ['-Command', psScript], { 
                    windowsHide: true,
                    stdio: 'ignore'
                });
                proc.on('close', () => resolve());
                proc.on('error', () => resolve());
            });
        } else {
            // Linux - use wmctrl or xdotool if available
            await new Promise<void>((resolve) => {
                const proc = spawn('wmctrl', ['-a', 'Cursor'], { stdio: 'ignore' });
                proc.on('close', () => resolve());
                proc.on('error', () => {
                    const proc2 = spawn('xdotool', ['search', '--name', 'Cursor', 'windowactivate'], { stdio: 'ignore' });
                    proc2.on('close', () => resolve());
                    proc2.on('error', () => resolve());
                });
            });
        }
    }
    
    /**
     * Run tests - requires direct connection
     */
    async runTests(mode: 'EditMode' | 'PlayMode', filter?: string[]): Promise<any | null> {
        if (!this.isDirectConnectionAvailable()) {
            this.log('Cannot run tests: Unity Bridge not connected');
            return null;
        }
        
        try {
            const result = await this.executeViaDirect('unity.direct.runTests', {
                mode,
                filter
            });
            return result;
        } catch (err) {
            this.log(`Failed to run tests: ${err}`);
            return null;
        }
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
     * Note: Error status is determined by pipeline results, not state events.
     * Error detection happens via Unity Bridge during pipeline operations.
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
        
        // Note: hasErrors and errorCount are determined by pipeline results.
        // Errors are detected by Unity Bridge during pipeline operations.
        
        // Compute queue length (pipeline queue + current pipeline if running)
        const queueLength = this.pipelineQueue.length + (this.currentPipeline ? 1 : 0);
        
        // Build current task info if there's an active pipeline
        const currentTask = this.currentPipeline ? {
            id: this.currentPipeline.id,
            type: this.currentPipeline.operations[this.currentPipeline.currentStep] || this.currentPipeline.operations[0],
            phase: this.currentPipeline.status
        } : undefined;
        
        broadcaster.unityStatusChanged(
            overallStatus,
            this.isDirectConnectionAvailable(),  // connected - true if Unity Bridge is connected
            this.lastUnityStatus?.isCompiling ?? false,
            this.lastUnityStatus?.isPlaying ?? false,
            this.lastUnityStatus?.isPaused ?? false,
            false,  // hasErrors - determined by pipeline results
            0,      // errorCount - determined by pipeline results
            queueLength,
            currentTask
        );
    }

    /**
     * Get current state
     */
    getState(): UnityControlManagerState {
        // Build current task from active pipeline if one is running
        let currentTask: UnityTask | undefined;
        
        if (this.currentPipeline) {
            const currentOp = this.currentPipeline.operations[this.currentPipeline.currentStep] || this.currentPipeline.operations[0];
            currentTask = {
                id: this.currentPipeline.id,
                type: currentOp as UnityTaskType,
                priority: 1,
                requestedBy: [{ coordinatorId: this.currentPipeline.coordinatorId, agentName: 'pipeline' }],
                status: this.currentPipeline.status === 'running' ? 'executing' : 'queued',
                phase: this.currentPipeline.status === 'running' ? 'running_tests' : undefined,
                createdAt: this.currentPipeline.createdAt,
                startedAt: this.currentPipeline.startedAt
            };
        }
        
        // Queue length includes pipeline queue + current pipeline if running
        const queueLength = this.pipelineQueue.length + (this.currentPipeline ? 1 : 0);
        
        return {
            status: this.status,
            currentTask,
            queueLength,
            tempScenePath: this.tempScenePath,
            lastActivity: new Date().toISOString(),
            errorRegistryPath: this.errorRegistryPath
        };
    }

    /**
     * Get pipeline queue
     */
    getPipelineQueue(): PipelineRequest[] {
        return [...this.pipelineQueue];
    }

    /**
     * Get last Unity editor status (from Unity Bridge events)
     */
    getUnityStatus(): UnityEditorStatus | null {
        return this.lastUnityStatus;
    }

    /**
     * Check if Unity Bridge is connected (replaces polling agent)
     */
    isUnityBridgeConnected(): boolean {
        return this.unityClientConnected;
    }

    /**
     * Estimate wait time for a new pipeline
     * Based on queue length and average operation duration
     */
    getEstimatedWaitTime(): number {
        // Average durations in milliseconds per operation
        const avgDurations: Record<PipelineOperation, number> = {
            'prep': 45000,                    // 45 seconds
            'test_editmode': 60000,           // 60 seconds
            'test_playmode': 120000,          // 2 minutes
            'test_player_playmode': 300000    // 5 minutes (variable)
        };

        let waitTime = 0;

        // Add current pipeline remaining time (estimate half done)
        if (this.currentPipeline) {
            const remainingOps = this.currentPipeline.operations.slice(this.currentPipeline.currentStep);
            for (const op of remainingOps) {
                waitTime += avgDurations[op] / 2;  // Assume half done on current
            }
        }

        // Add queued pipelines
        for (const pipeline of this.pipelineQueue) {
            for (const op of pipeline.operations) {
                waitTime += avgDurations[op];
            }
        }

        // Add buffer (10 seconds per pipeline for transitions)
        const totalPipelines = this.pipelineQueue.length + (this.currentPipeline ? 1 : 0);
        waitTime += totalPipelines * 10000;

        return waitTime;
    }

    /**
     * Get queue status summary
     */
    getQueueStatus(): {
        queueLength: number;
        currentOperation?: PipelineOperation;
        estimatedTotalWaitMs: number;
        isIdle: boolean;
    } {
        const currentOp = this.currentPipeline
            ? this.currentPipeline.operations[this.currentPipeline.currentStep]
            : undefined;
        
        return {
            queueLength: this.pipelineQueue.length + (this.currentPipeline ? 1 : 0),
            currentOperation: currentOp,
            estimatedTotalWaitMs: this.getEstimatedWaitTime(),
            isIdle: this.status === 'idle' && this.pipelineQueue.length === 0
        };
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
    
    // ========================================================================
    // Player Test Popup Handlers (called from ApiHandler)
    // ========================================================================
    
    /**
     * Process the pipeline queue.
     * Sends entire pipeline to Unity Bridge for execution.
     * Unity handles all steps, log capture, and screenshot capture internally.
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

        // Focus Unity before pipeline execution
        this.log('Focusing Unity Editor for pipeline execution...');
        await this.focusUnityEditor();

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
            console.warn('[UnityControlManager] Failed to broadcast pipeline start:', e);
        }

        let allSuccess = true;
        let failedAtStep: PipelineOperation | null = null;
        let logFolder: string | null = null;

        // Check Unity Bridge connection
        if (!this.isDirectConnectionAvailable()) {
            this.log('Pipeline failed: Unity Bridge not connected');
            allSuccess = false;
            failedAtStep = this.currentPipeline.operations[0];
        } else {
            // Send entire pipeline to Unity Bridge for execution
            try {
                this.log('Sending pipeline to Unity Bridge...');
                
                const unityResult = await this.executeViaDirect('unity.direct.runPipeline', {
                    pipelineId: this.currentPipeline.id,
                    operations: this.currentPipeline.operations,
                    testScene: 'Assets/Scenes/Main.unity'
                });

                if (unityResult?.data) {
                    allSuccess = unityResult.data.success;
                    failedAtStep = unityResult.data.failedAtStep || null;
                    logFolder = unityResult.data.logFolder || null;

                    // Convert Unity step results to our format
                    if (unityResult.data.stepResults) {
                        for (const step of unityResult.data.stepResults) {
                            this.currentPipeline.stepResults.push({
                                operation: step.op || step.Operation,
                                success: step.success || step.Success,
                                duration: 0, // Unity doesn't track per-step duration yet
                                errors: step.error ? [{
                                    id: `err_${Date.now()}`,
                                    type: 'runtime',
                                    message: step.error || step.Error,
                                    timestamp: new Date().toISOString()
                                }] : [],
                                logPath: step.logPath || step.LogPath
                            });
                        }
                    }

                    this.log(`Pipeline executed by Unity: success=${allSuccess}, logFolder=${logFolder}`);
                } else {
                    allSuccess = false;
                    failedAtStep = this.currentPipeline.operations[0];
                    this.log('Pipeline failed: No result from Unity Bridge');
                }
            } catch (err) {
                allSuccess = false;
                failedAtStep = this.currentPipeline.operations[0];
                this.log(`Pipeline failed: ${err}`);
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
            allTestFailures: this.aggregateTestFailures(this.currentPipeline.stepResults),
            logFolder: logFolder || undefined
        };

        this.log(`Pipeline ${this.currentPipeline.id} ${allSuccess ? 'completed' : 'failed'}`);

        // Focus back to Cursor at end of pipeline
        this.log('Pipeline complete, focusing back to Cursor...');
        await this.focusCursorEditor();

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

    // Note: Pipeline step execution is now handled by Unity Bridge via runPipeline command
    // Each step's log capture and screenshot capture is done internally by Unity

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

        // If there are errors or test failures, route them to global error handling
        if (result.allErrors.length > 0 || result.allTestFailures.length > 0) {
            this.log(`Routing ${result.allErrors.length} errors and ${result.allTestFailures.length} test failures to global error handler...`);
            await this.handlePipelineErrors(result);
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
     * Handle pipeline errors by routing to TaskAgent for error_fix task creation
     * 
     * This is the main entry point for handling Unity compilation/test errors.
     * New flow with TaskAgent:
     * 1. Finds affected tasks across all plans
     * 2. Routes errors to TaskAgent which creates error_fix tasks
     * 3. Coordinator then dispatches error_resolution workflows
     * 
     * @param result - Full pipeline result with errors, test failures, and log paths
     * @returns IDs of created error-fixing tasks
     */
    async handlePipelineErrors(result: PipelineResult): Promise<string[]> {
        const errors = result.allErrors;
        const testFailures = result.allTestFailures;
        const logFolder = result.logFolder;
        
        if (errors.length === 0 && testFailures.length === 0) {
            this.log('handlePipelineErrors: No errors or test failures to process');
            return [];
        }

        this.log(`handlePipelineErrors: Processing ${errors.length} errors, ${testFailures.length} test failures (logFolder: ${logFolder || 'none'})`);
        
        // Also log step-level log paths for debugging
        for (const step of result.stepResults) {
            if (step.logPath) {
                this.log(`  Step ${step.operation}: logPath=${step.logPath}`);
            }
        }

        // Route to TaskAgent to create error_fix tasks
        let createdTaskIds: string[] = [];
        try {
            const { TaskAgent } = await import('./TaskAgent');
            // Create TaskAgent instance (or get from ServiceLocator if registered)
            let taskAgent: InstanceType<typeof TaskAgent>;
            try {
                taskAgent = ServiceLocator.resolve(TaskAgent);
            } catch {
                // TaskAgent not registered - create a temporary instance
                taskAgent = new TaskAgent();
                taskAgent.setWorkspaceRoot(this.workspaceRoot);
            }
            
            // Convert errors to TaskAgent format
            const taskAgentErrors = errors.map(e => ({
                id: e.code || 'UNITY_ERR',
                message: e.message,
                file: e.file,
                line: e.line
            }));
            
            // Convert test failures to TaskAgent format
            const taskAgentTestFailures = testFailures.map(t => ({
                testName: t.testName,
                message: t.message || 'Test failed',
                stackTrace: t.stackTrace
            }));
            
            createdTaskIds = await taskAgent.handleUnityErrors(taskAgentErrors, {
                testFailures: taskAgentTestFailures,
                logFolder
            });
            this.log(`handlePipelineErrors: TaskAgent created ${createdTaskIds.length} error_fix tasks`);
        } catch (e) {
            // TaskAgent is the only handler for error task creation
            // If unavailable, log the error but don't fall back to coordinator
            this.log(`handlePipelineErrors: TaskAgent unavailable - cannot create error tasks: ${e}`);
            this.log(`  ${errors.length} errors need manual resolution`);
            
            // Log error details for manual debugging
            for (const err of errors.slice(0, 5)) {
                this.log(`  - ${err.file || 'unknown'}(${err.line || 0}): ${err.message.substring(0, 80)}`);
            }
            if (errors.length > 5) {
                this.log(`  ... and ${errors.length - 5} more errors`);
            }
        }

        // 3. Trigger coordinator to dispatch error_resolution workflows for new error tasks
        // NOTE: TaskAgent creates tasks, Coordinator only dispatches workflows
        if (createdTaskIds.length > 0) {
            try {
                const coordinator = ServiceLocator.resolve(UnifiedCoordinatorService);
                const stateManager = ServiceLocator.resolve(StateManager);
                const approvedSessions = stateManager.getAllPlanningSessions()
                    .filter(s => s.status === 'approved');
                
                if (approvedSessions.length > 0) {
                    // Notify coordinator that new error_fix tasks are ready for dispatch
                    // Use 'unity_error' event type - coordinator will dispatch error_resolution workflows
                    await coordinator.triggerCoordinatorEvaluation(
                        approvedSessions[0].id,
                        'unity_error',
                        {
                            type: 'unity_error',
                            taskIds: createdTaskIds,
                            errorCount: errors.length
                        }
                    );
                    this.log(`handlePipelineErrors: Notified coordinator to dispatch ${createdTaskIds.length} error tasks`);
                }
            } catch (e) {
                this.log(`handlePipelineErrors: Could not trigger coordinator for dispatch: ${e}`);
            }
        }

        return createdTaskIds;
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
            // Build minimal PipelineResult for ad-hoc error handling
            const result: PipelineResult = {
                pipelineId: `adhoc_${Date.now()}`,
                success: false,
                failedAtStep: 'prep',
                stepResults: [],
                tasksInvolved: [],
                allErrors: compilationErrors,
                allTestFailures: []
            };
            await this.handlePipelineErrors(result);
        }
    }

    /**
     * Stop the manager
     */
    async stop(): Promise<void> {
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
        
        this.log('Unity Control Manager disposed');
    }

    /**
     * Show output channel
     */
    showOutput(): void {
        this.outputManager.show();
    }
}

