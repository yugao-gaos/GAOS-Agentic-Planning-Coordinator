import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
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

    private constructor() {
        this.outputManager = OutputChannelManager.getInstance();
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
        const pauseDir = path.join(dir, '.paused_processes');
        if (!fs.existsSync(pauseDir)) {
            fs.mkdirSync(pauseDir, { recursive: true });
        }
    }

    /**
     * Spawn a managed process
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
            onExit: options.onExit
        };

        // Capture stdout
        proc.stdout?.on('data', (data: Buffer) => {
            const text = data.toString();
            managed.outputBuffer.push(text);
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
            this.processes.delete(id);
            managed.onExit?.(code);
            this.log(`Process ${id} exited with code ${code}`);
        });

        proc.on('error', (err) => {
            this.log(`Process ${id} error: ${err.message}`);
            state.status = 'error';
        });

        this.processes.set(id, managed);
        this.log(`Started process ${id}: ${command} ${args.join(' ')}`);

        return proc;
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
        
        const pauseDir = path.join(this.stateDir, '.paused_processes');
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
        
        const filePath = path.join(this.stateDir, '.paused_processes', `${id}.json`);
        
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
        
        const pauseDir = path.join(this.stateDir, '.paused_processes');
        
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
        
        const filePath = path.join(this.stateDir, '.paused_processes', `${id}.json`);
        
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
        
        const pauseDir = path.join(this.stateDir, '.paused_processes');
        
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
}

