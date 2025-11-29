import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { OutputChannelManager } from './OutputChannelManager';

/**
 * Process state for pause/resume
 */
export interface ProcessState {
    id: string;
    command: string;
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    startTime: string;
    status: 'running' | 'paused' | 'stopped' | 'completed' | 'error';
    lastOutput?: string;
    metadata?: Record<string, any>;
}

/**
 * Managed process with tracking
 */
interface ManagedProcess {
    proc: ChildProcess;
    state: ProcessState;
    outputBuffer: string[];
    onExit?: (code: number | null) => void;
    timeoutId?: NodeJS.Timeout;
    healthCheckId?: NodeJS.Timeout;
    lastActivityTime: number;
}

/**
 * ProcessManager - Reliable cross-platform process management
 * 
 * Features:
 * - Process group killing (kills all child processes)
 * - Cross-platform support (Windows/macOS/Linux)
 * - State-based pause/resume (saves state, kills, restarts)
 * - Graceful shutdown with timeout
 * - Output capture for debugging
 */
export class ProcessManager {
    private static instance: ProcessManager;
    private processes: Map<string, ManagedProcess> = new Map();
    private pausedStates: Map<string, ProcessState> = new Map();
    private outputManager: OutputChannelManager;
    private stateDir: string = '';

    private readonly GRACEFUL_TIMEOUT_MS = 5000;  // 5 seconds to gracefully stop
    private readonly FORCE_KILL_TIMEOUT_MS = 2000;  // 2 more seconds before SIGKILL
    private readonly DEFAULT_MAX_RUNTIME_MS = 60 * 60 * 1000;  // 1 hour default max runtime
    private readonly HEALTH_CHECK_INTERVAL_MS = 30 * 1000;  // Check health every 30 seconds
    private readonly STUCK_THRESHOLD_MS = 5 * 60 * 1000;  // Consider stuck if no output for 5 minutes
    
    // Event emitters for monitoring - use WeakRef-like pattern with IDs for cleanup
    private onStuckCallbacks: Map<string, (id: string, state: ProcessState) => void> = new Map();
    private onTimeoutCallbacks: Map<string, (id: string, state: ProcessState) => void> = new Map();
    private callbackIdCounter: number = 0;

    private constructor() {
        this.outputManager = OutputChannelManager.getInstance();
    }

    /**
     * Register callback for when a process appears stuck (no output for STUCK_THRESHOLD_MS)
     * Returns a callback ID that can be used to unregister the callback
     */
    onProcessStuck(callback: (id: string, state: ProcessState) => void): string {
        const callbackId = `stuck_${++this.callbackIdCounter}`;
        this.onStuckCallbacks.set(callbackId, callback);
        return callbackId;
    }

    /**
     * Register callback for when a process times out
     * Returns a callback ID that can be used to unregister the callback
     */
    onProcessTimeout(callback: (id: string, state: ProcessState) => void): string {
        const callbackId = `timeout_${++this.callbackIdCounter}`;
        this.onTimeoutCallbacks.set(callbackId, callback);
        return callbackId;
    }
    
    /**
     * Unregister a stuck callback by ID
     */
    offProcessStuck(callbackId: string): boolean {
        return this.onStuckCallbacks.delete(callbackId);
    }
    
    /**
     * Unregister a timeout callback by ID
     */
    offProcessTimeout(callbackId: string): boolean {
        return this.onTimeoutCallbacks.delete(callbackId);
    }
    
    /**
     * Clear all registered callbacks (for cleanup on deactivation)
     */
    clearAllCallbacks(): void {
        this.onStuckCallbacks.clear();
        this.onTimeoutCallbacks.clear();
        this.log('Cleared all process manager callbacks');
    }

    static getInstance(): ProcessManager {
        if (!ProcessManager.instance) {
            ProcessManager.instance = new ProcessManager();
        }
        return ProcessManager.instance;
    }

    /**
     * Set the state directory for saving pause states
     */
    setStateDir(dir: string): void {
        this.stateDir = dir;
        // Use OS temp dir for paused process states (not workspace)
        const pauseDir = path.join(os.tmpdir(), 'apc_paused_processes');
        if (!fs.existsSync(pauseDir)) {
            fs.mkdirSync(pauseDir, { recursive: true });
        }
    }

    /**
     * Spawn a managed process with optional timeout and health monitoring
     */
    spawn(
        id: string,
        command: string,
        args: string[],
        options: {
            cwd: string;
            env?: NodeJS.ProcessEnv;
            onOutput?: (data: string) => void;
            onExit?: (code: number | null) => void;
            metadata?: Record<string, any>;
            maxRuntimeMs?: number;  // Max runtime before auto-kill (default: 1 hour)
            enableHealthCheck?: boolean;  // Enable stuck detection (default: true)
        }
    ): ChildProcess {
        // Kill existing process with same ID if any
        if (this.processes.has(id)) {
            this.log(`Process ${id} already exists, stopping it first`);
            this.stopProcess(id, true);
        }

        const spawnOptions: SpawnOptions = {
            cwd: options.cwd,
            env: options.env || process.env,
            detached: process.platform !== 'win32',  // Use process groups on Unix
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: process.platform === 'win32'  // Use shell on Windows
        };

        const proc = spawn(command, args, spawnOptions);

        const state: ProcessState = {
            id,
            command,
            args,
            cwd: options.cwd,
            env: options.env,
            startTime: new Date().toISOString(),
            status: 'running',
            metadata: options.metadata
        };

        const managed: ManagedProcess = {
            proc,
            state,
            outputBuffer: [],
            onExit: options.onExit,
            lastActivityTime: Date.now()
        };

        // Capture stdout
        proc.stdout?.on('data', (data: Buffer) => {
            const text = data.toString();
            managed.outputBuffer.push(text);
            managed.lastActivityTime = Date.now();  // Update activity time
            // Keep last 100 lines
            if (managed.outputBuffer.length > 100) {
                managed.outputBuffer.shift();
            }
            state.lastOutput = text;
            options.onOutput?.(text);
        });

        // Capture stderr
        proc.stderr?.on('data', (data: Buffer) => {
            const text = data.toString();
            managed.outputBuffer.push(`[stderr] ${text}`);
            managed.lastActivityTime = Date.now();  // Update activity time
            if (managed.outputBuffer.length > 100) {
                managed.outputBuffer.shift();
            }
            options.onOutput?.(text);
        });

        // Handle exit
        proc.on('exit', (code) => {
            if (state.status === 'running') {
                state.status = code === 0 ? 'completed' : 'error';
            }
            // Clear timers
            if (managed.timeoutId) clearTimeout(managed.timeoutId);
            if (managed.healthCheckId) clearInterval(managed.healthCheckId);
            
            this.processes.delete(id);
            managed.onExit?.(code);
            this.log(`Process ${id} exited with code ${code}`);
        });

        proc.on('error', (err) => {
            this.log(`Process ${id} error: ${err.message}`);
            state.status = 'error';
        });

        this.processes.set(id, managed);
        
        // Set up timeout if specified
        const maxRuntime = options.maxRuntimeMs ?? this.DEFAULT_MAX_RUNTIME_MS;
        if (maxRuntime > 0) {
            managed.timeoutId = setTimeout(() => {
                this.log(`⏰ Process ${id} exceeded max runtime (${maxRuntime}ms), killing...`);
                this.onTimeoutCallbacks.forEach(cb => cb(id, state));
                this.stopProcess(id, true);
            }, maxRuntime);
        }

        // Set up health check if enabled (default: true)
        const enableHealthCheck = options.enableHealthCheck !== false;
        if (enableHealthCheck) {
            managed.healthCheckId = setInterval(() => {
                const timeSinceActivity = Date.now() - managed.lastActivityTime;
                if (timeSinceActivity > this.STUCK_THRESHOLD_MS && state.status === 'running') {
                    this.log(`⚠️ Process ${id} appears stuck (no output for ${Math.round(timeSinceActivity / 1000)}s)`);
                    this.onStuckCallbacks.forEach(cb => cb(id, state));
                }
            }, this.HEALTH_CHECK_INTERVAL_MS);
        }

        this.log(`Started process ${id}: ${command} ${args.slice(0, 3).join(' ')}...`);

        return proc;
    }

    /**
     * Register an externally-spawned process for tracking
     * Use this when you spawn a process outside of ProcessManager but want it tracked
     * for stuck detection, cleanup, and visibility in the UI.
     */
    registerExternalProcess(
        id: string,
        proc: ChildProcess,
        options: {
            command: string;
            args: string[];
            cwd: string;
            env?: NodeJS.ProcessEnv;
            metadata?: Record<string, any>;
            maxRuntimeMs?: number;
            enableHealthCheck?: boolean;
        }
    ): void {
        // Kill existing process with same ID if any
        if (this.processes.has(id)) {
            this.log(`Process ${id} already registered, stopping it first`);
            this.stopProcess(id, true);
        }

        const state: ProcessState = {
            id,
            command: options.command,
            args: options.args,
            cwd: options.cwd,
            env: options.env,
            startTime: new Date().toISOString(),
            status: 'running',
            metadata: options.metadata
        };

        const managed: ManagedProcess = {
            proc,
            state,
            outputBuffer: [],
            lastActivityTime: Date.now()
        };

        // Track stdout activity (if available)
        proc.stdout?.on('data', (data: Buffer) => {
            managed.lastActivityTime = Date.now();
            const text = data.toString();
            managed.outputBuffer.push(text);
            if (managed.outputBuffer.length > 100) {
                managed.outputBuffer.shift();
            }
            state.lastOutput = text;
        });

        // Track stderr activity (if available)
        proc.stderr?.on('data', (data: Buffer) => {
            managed.lastActivityTime = Date.now();
            const text = data.toString();
            managed.outputBuffer.push(`[stderr] ${text}`);
            if (managed.outputBuffer.length > 100) {
                managed.outputBuffer.shift();
            }
        });

        // Handle exit
        proc.on('exit', (code) => {
            if (state.status === 'running') {
                state.status = code === 0 ? 'completed' : 'error';
            }
            if (managed.timeoutId) clearTimeout(managed.timeoutId);
            if (managed.healthCheckId) clearInterval(managed.healthCheckId);
            this.processes.delete(id);
            this.log(`External process ${id} exited with code ${code}`);
        });

        proc.on('error', (err) => {
            this.log(`External process ${id} error: ${err.message}`);
            state.status = 'error';
        });

        this.processes.set(id, managed);

        // Set up timeout if specified
        const maxRuntime = options.maxRuntimeMs ?? this.DEFAULT_MAX_RUNTIME_MS;
        if (maxRuntime > 0) {
            managed.timeoutId = setTimeout(() => {
                this.log(`⏰ External process ${id} exceeded max runtime (${maxRuntime}ms), killing...`);
                this.onTimeoutCallbacks.forEach(cb => cb(id, state));
                this.stopProcess(id, true);
            }, maxRuntime);
        }

        // Set up health check if enabled
        const enableHealthCheck = options.enableHealthCheck !== false;
        if (enableHealthCheck) {
            managed.healthCheckId = setInterval(() => {
                const timeSinceActivity = Date.now() - managed.lastActivityTime;
                if (timeSinceActivity > this.STUCK_THRESHOLD_MS && state.status === 'running') {
                    this.log(`⚠️ External process ${id} appears stuck (no output for ${Math.round(timeSinceActivity / 1000)}s)`);
                    this.onStuckCallbacks.forEach(cb => cb(id, state));
                }
            }, this.HEALTH_CHECK_INTERVAL_MS);
        }

        this.log(`Registered external process ${id}: ${options.command} ${options.args.slice(0, 3).join(' ')}...`);
    }

    /**
     * Stop a process gracefully, then forcefully if needed
     */
    async stopProcess(id: string, force: boolean = false): Promise<boolean> {
        const managed = this.processes.get(id);
        if (!managed) {
            return true;  // Already stopped
        }

        const { proc, state } = managed;
        state.status = 'stopped';

        return new Promise((resolve) => {
            let resolved = false;

            const cleanup = () => {
                if (!resolved) {
                    resolved = true;
                    this.processes.delete(id);
                    this.cleanupPausedState(id);
                    resolve(true);
                }
            };

            // Listen for exit
            proc.once('exit', cleanup);

            if (force) {
                // Force kill immediately
                this.killProcess(proc, true);
                setTimeout(cleanup, 1000);
            } else {
                // Graceful shutdown
                this.killProcess(proc, false);

                // Wait for graceful timeout
                setTimeout(() => {
                    if (!resolved && !proc.killed) {
                        this.log(`Process ${id} didn't stop gracefully, forcing`);
                        this.killProcess(proc, true);
                        setTimeout(cleanup, this.FORCE_KILL_TIMEOUT_MS);
                    }
                }, this.GRACEFUL_TIMEOUT_MS);
            }
        });
    }

    /**
     * Pause a process (saves state, stops process)
     * Can be resumed later with resumeProcess()
     */
    async pauseProcess(id: string): Promise<boolean> {
        const managed = this.processes.get(id);
        if (!managed) {
            return false;
        }

        const { state } = managed;
        
        // Save state for resume
        const pauseState: ProcessState = {
            ...state,
            status: 'paused',
            lastOutput: managed.outputBuffer.slice(-10).join('')
        };
        
        this.pausedStates.set(id, pauseState);
        this.savePausedState(pauseState);

        // Stop the process
        await this.stopProcess(id, false);
        
        this.log(`Paused process ${id} (state saved)`);
        return true;
    }

    /**
     * Resume a paused process
     */
    resumeProcess(
        id: string,
        options?: {
            onOutput?: (data: string) => void;
            onExit?: (code: number | null) => void;
        }
    ): ChildProcess | null {
        // Check in-memory first
        let state: ProcessState | undefined = this.pausedStates.get(id);
        
        // Try to load from disk
        if (!state) {
            const loaded = this.loadPausedState(id);
            if (loaded) {
                state = loaded;
            }
        }

        if (!state) {
            this.log(`No paused state found for ${id}`);
            return null;
        }

        this.pausedStates.delete(id);
        this.cleanupPausedState(id);

        // Restart the process
        this.log(`Resuming process ${id}`);
        return this.spawn(id, state.command, state.args, {
            cwd: state.cwd,
            env: state.env,
            metadata: state.metadata,
            onOutput: options?.onOutput,
            onExit: options?.onExit
        });
    }

    /**
     * Check if a process is running
     */
    isRunning(id: string): boolean {
        const managed = this.processes.get(id);
        return managed?.state.status === 'running' && !managed.proc.killed;
    }

    /**
     * Check if a process is paused
     */
    isPaused(id: string): boolean {
        return this.pausedStates.has(id) || this.loadPausedState(id) !== null;
    }

    /**
     * Get process state
     */
    getState(id: string): ProcessState | undefined {
        const managed = this.processes.get(id);
        if (managed) {
            return managed.state;
        }
        return this.pausedStates.get(id) || this.loadPausedState(id) || undefined;
    }

    /**
     * Get all running process IDs
     */
    getRunningProcessIds(): string[] {
        return Array.from(this.processes.keys());
    }

    /**
     * Get all paused process IDs
     */
    getPausedProcessIds(): string[] {
        const inMemory = Array.from(this.pausedStates.keys());
        const onDisk = this.loadAllPausedStateIds();
        return [...new Set([...inMemory, ...onDisk])];
    }

    /**
     * Get detailed info about all running processes (for UI visibility)
     */
    getRunningProcessInfo(): Array<{
        id: string;
        command: string;
        startTime: string;
        runtimeMs: number;
        timeSinceActivityMs: number;
        status: string;
        metadata?: Record<string, any>;
        isStuck: boolean;
    }> {
        const now = Date.now();
        return Array.from(this.processes.entries()).map(([id, managed]) => ({
            id,
            command: `${managed.state.command} ${managed.state.args.slice(0, 2).join(' ')}...`,
            startTime: managed.state.startTime,
            runtimeMs: now - new Date(managed.state.startTime).getTime(),
            timeSinceActivityMs: now - managed.lastActivityTime,
            status: managed.state.status,
            metadata: managed.state.metadata,
            isStuck: (now - managed.lastActivityTime) > this.STUCK_THRESHOLD_MS
        }));
    }

    /**
     * Kill all stuck processes (no output for STUCK_THRESHOLD_MS)
     */
    async killStuckProcesses(): Promise<string[]> {
        const now = Date.now();
        const killedIds: string[] = [];
        
        for (const [id, managed] of this.processes.entries()) {
            const timeSinceActivity = now - managed.lastActivityTime;
            if (timeSinceActivity > this.STUCK_THRESHOLD_MS && managed.state.status === 'running') {
                this.log(`🗑️ Killing stuck process ${id} (no output for ${Math.round(timeSinceActivity / 1000)}s)`);
                await this.stopProcess(id, true);
                killedIds.push(id);
            }
        }
        
        return killedIds;
    }

    /**
     * Find and kill orphan cursor-agent processes not tracked by ProcessManager
     * This catches processes that survived extension restarts
     * Works on Windows, macOS, and Linux
     */
    async killOrphanCursorAgents(): Promise<number> {
        const { execSync } = require('child_process');
        let killedCount = 0;
        
        // Get PIDs currently tracked by ProcessManager
        const trackedPids = new Set(
            Array.from(this.processes.values())
                .map(m => m.proc.pid)
                .filter(pid => pid !== undefined)
        );

        if (process.platform === 'win32') {
            // Windows implementation using WMIC or PowerShell
            try {
                // Use WMIC to find cursor-agent processes
                // WMIC returns: Handle  Name  CommandLine
                let result: string;
                try {
                    // Try WMIC first (available on most Windows versions)
                    result = execSync(
                        'wmic process where "commandline like \'%cursor%agent%\'" get processid,commandline /format:csv',
                        { encoding: 'utf-8', timeout: 10000, windowsHide: true }
                    ).trim();
                } catch {
                    // Fall back to PowerShell if WMIC is not available (Windows 11+)
                    result = execSync(
                        'powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \'*cursor*agent*\' } | Select-Object ProcessId | ConvertTo-Csv -NoTypeInformation"',
                        { encoding: 'utf-8', timeout: 10000, windowsHide: true }
                    ).trim();
                }
                
                if (!result) return 0;
                
                // Parse CSV output to extract PIDs
                const lines = result.split('\n').filter((line: string) => line.trim());
                for (const line of lines) {
                    // Skip header lines
                    if (line.includes('ProcessId') || line.includes('Node')) continue;
                    
                    // Extract PID from CSV (last number in line for WMIC, quoted for PowerShell)
                    const pidMatch = line.match(/(\d+)\s*$/);
                    if (pidMatch) {
                        const pidNum = parseInt(pidMatch[1], 10);
                        if (!isNaN(pidNum) && !trackedPids.has(pidNum) && pidNum !== process.pid) {
                            try {
                                // Use taskkill to terminate the process tree
                                execSync(`taskkill /PID ${pidNum} /T /F`, { 
                                    timeout: 5000,
                                    windowsHide: true,
                                    stdio: 'ignore'
                                });
                                this.log(`🗑️ Killed orphan cursor-agent process ${pidNum} (Windows)`);
                                killedCount++;
                            } catch (e) {
                                // Process might already be dead or access denied
                            }
                        }
                    }
                }
            } catch (e) {
                this.log(`Error finding orphan processes on Windows: ${e}`);
            }
        } else {
            // Unix (macOS/Linux) implementation
            try {
                // Find cursor-agent processes
                const result = execSync(
                    'ps aux | grep -E "cursor.*(agent|--model)" | grep -v grep | awk \'{print $2}\'',
                    { encoding: 'utf-8', timeout: 5000 }
                ).trim();
                
                if (!result) return 0;
                
                const pids = result.split('\n').filter((p: string) => p.trim());
                
                for (const pid of pids) {
                    const pidNum = parseInt(pid, 10);
                    if (!isNaN(pidNum) && !trackedPids.has(pidNum) && pidNum !== process.pid) {
                        try {
                            process.kill(pidNum, 'SIGKILL');
                            this.log(`🗑️ Killed orphan cursor-agent process ${pidNum}`);
                            killedCount++;
                        } catch (e) {
                            // Process might already be dead
                        }
                    }
                }
            } catch (e) {
                this.log(`Error finding orphan processes: ${e}`);
            }
        }
        
        return killedCount;
    }

    /**
     * Stop all processes
     */
    async stopAll(force: boolean = false): Promise<void> {
        const ids = Array.from(this.processes.keys());
        await Promise.all(ids.map(id => this.stopProcess(id, force)));
        
        // Clear paused states
        this.pausedStates.clear();
        this.cleanupAllPausedStates();
    }

    /**
     * Kill process and its children
     */
    private killProcess(proc: ChildProcess, force: boolean): void {
        try {
            if (proc.killed) return;

            const signal = force ? 'SIGKILL' : 'SIGTERM';

            if (process.platform === 'win32') {
                // Windows: Use taskkill to kill process tree
                if (proc.pid) {
                    const { execSync } = require('child_process');
                    try {
                        execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' });
                    } catch (e) {
                        // Process might already be dead
                    }
                }
            } else {
                // Unix: Kill process group
                if (proc.pid) {
                    try {
                        // Negative PID kills the process group
                        process.kill(-proc.pid, signal);
                    } catch (e) {
                        // Try killing just the process
                        try {
                            proc.kill(signal);
                        } catch (e2) {
                            // Process already dead
                        }
                    }
                }
            }
        } catch (error) {
            this.log(`Error killing process: ${error}`);
        }
    }

    /**
     * Save paused state to disk
     */
    private savePausedState(state: ProcessState): void {
        if (!this.stateDir) return;
        
        const pauseDir = path.join(os.tmpdir(), 'apc_paused_processes');
        const filePath = path.join(pauseDir, `${state.id}.json`);
        
        try {
            fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
        } catch (e) {
            this.log(`Failed to save paused state: ${e}`);
        }
    }

    /**
     * Load paused state from disk
     */
    private loadPausedState(id: string): ProcessState | null {
        if (!this.stateDir) return null;
        
        const filePath = path.join(os.tmpdir(), 'apc_paused_processes', `${id}.json`);
        
        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf-8');
                return JSON.parse(content);
            }
        } catch (e) {
            this.log(`Failed to load paused state: ${e}`);
        }
        return null;
    }

    /**
     * Get all paused state IDs from disk
     */
    private loadAllPausedStateIds(): string[] {
        if (!this.stateDir) return [];
        
        const pauseDir = path.join(os.tmpdir(), 'apc_paused_processes');
        
        try {
            if (fs.existsSync(pauseDir)) {
                return fs.readdirSync(pauseDir)
                    .filter(f => f.endsWith('.json'))
                    .map(f => f.replace('.json', ''));
            }
        } catch (e) {
            // Ignore
        }
        return [];
    }

    /**
     * Delete paused state file
     */
    private cleanupPausedState(id: string): void {
        if (!this.stateDir) return;
        
        const filePath = path.join(os.tmpdir(), 'apc_paused_processes', `${id}.json`);
        
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (e) {
            // Ignore
        }
    }

    /**
     * Delete all paused state files
     */
    private cleanupAllPausedStates(): void {
        if (!this.stateDir) return;
        
        const pauseDir = path.join(os.tmpdir(), 'apc_paused_processes');
        
        try {
            if (fs.existsSync(pauseDir)) {
                const files = fs.readdirSync(pauseDir);
                for (const file of files) {
                    fs.unlinkSync(path.join(pauseDir, file));
                }
            }
        } catch (e) {
            // Ignore
        }
    }

    private log(message: string): void {
        this.outputManager.log(message, 'PROC');
    }
    
    /**
     * Full cleanup - stop all processes and clear all state
     * Call this on extension deactivation to prevent memory leaks
     */
    async dispose(): Promise<void> {
        this.log('Disposing ProcessManager...');
        
        // Stop all running processes
        await this.stopAll(true);
        
        // Clear all callbacks to prevent memory leaks
        this.clearAllCallbacks();
        
        // Clear all internal state
        this.processes.clear();
        this.pausedStates.clear();
        
        // Clean up temp files
        this.cleanupAllPausedStates();
        
        this.log('ProcessManager disposed');
    }
}

