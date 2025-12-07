/**
 * DaemonManager.ts - Manages the APC daemon lifecycle from VS Code
 * 
 * This service is responsible for:
 * - Checking if daemon is running
 * - Starting daemon if not running
 * - Stopping daemon on extension deactivation
 * - Managing daemon health checks
 */

import * as vscode from 'vscode';
import { spawn, ChildProcess, execSync, SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import { Logger } from '../utils/Logger';

const log = Logger.create('Client', 'DaemonManager');

// Platform detection
const isWindows = process.platform === 'win32';

/**
 * Daemon status information
 */
export interface DaemonStatus {
    running: boolean;
    pid?: number;
    port?: number;
    workspaceRoot?: string;
    uptime?: number;
}

/**
 * Result from ensuring daemon is running
 */
export interface EnsureDaemonResult {
    /** Port the daemon is listening on */
    port: number;
    /** Whether we started the daemon (vs it was already running) */
    wasStarted: boolean;
    /** Whether the daemon was started externally (CLI, another process) */
    isExternal: boolean;
}

/**
 * Manager for the APC daemon process
 */
export class DaemonManager {
    private workspaceRoot: string;
    private daemonProcess: ChildProcess | null = null;
    private healthCheckInterval: NodeJS.Timeout | null = null;
    private extensionPath: string;
    
    constructor(workspaceRoot: string, extensionPath: string) {
        this.workspaceRoot = workspaceRoot;
        this.extensionPath = extensionPath;
    }
    
    /**
     * Get the workspace hash for unique identification
     */
    private getWorkspaceHash(): string {
        return crypto.createHash('md5').update(this.workspaceRoot).digest('hex').substring(0, 8);
    }
    
    /**
     * Get the daemon PID file path
     */
    private getPidPath(): string {
        return path.join(os.tmpdir(), `apc_daemon_${this.getWorkspaceHash()}.pid`);
    }
    
    /**
     * Get the daemon port file path
     */
    private getPortPath(): string {
        return path.join(os.tmpdir(), `apc_daemon_${this.getWorkspaceHash()}.port`);
    }
    
    /**
     * Check if daemon is running (cross-platform)
     */
    isDaemonRunning(): boolean {
        const pidPath = this.getPidPath();
        
        if (!fs.existsSync(pidPath)) {
            log.debug(`isDaemonRunning: PID file does not exist at ${pidPath}`);
            return false;
        }
        
        try {
            const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
            log.debug(`isDaemonRunning: Found PID file with PID=${pid}`);
            
            if (isWindows) {
                // Windows: Use tasklist to check if process exists
                try {
                    const result = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { 
                        encoding: 'utf-8',
                        windowsHide: true,
                        stdio: ['pipe', 'pipe', 'pipe']
                    });
                    // If process exists, tasklist returns info about it
                    // If not, it returns "INFO: No tasks are running..."
                    const isRunning = result.includes(pid.toString()) && !result.includes('No tasks');
                    log.debug(`isDaemonRunning: tasklist result for PID ${pid}: ${isRunning ? 'running' : 'not running'}`);
                    return isRunning;
                } catch (err) {
                    log.debug(`isDaemonRunning: tasklist failed:`, err);
                    return false;
                }
            } else {
                // Unix: Check if process exists (signal 0 just checks existence)
                process.kill(pid, 0);
                log.debug(`isDaemonRunning: Process ${pid} exists (Unix check)`);
                return true;
            }
        } catch (err) {
            log.debug(`isDaemonRunning: Check failed, cleaning up stale PID file:`, err);
            // Process doesn't exist or we don't have permission
            // Clean up stale PID file
            try {
                fs.unlinkSync(pidPath);
            } catch {
                // Ignore cleanup errors
            }
            return false;
        }
    }
    
    /**
     * Get daemon port if running
     */
    getDaemonPort(): number | null {
        const portPath = this.getPortPath();
        
        if (!fs.existsSync(portPath)) {
            return null;
        }
        
        try {
            return parseInt(fs.readFileSync(portPath, 'utf-8').trim(), 10);
        } catch {
            return null;
        }
    }
    
    /**
     * Get current daemon status
     */
    getStatus(): DaemonStatus {
        const running = this.isDaemonRunning();
        
        if (!running) {
            return { running: false };
        }
        
        const pidPath = this.getPidPath();
        const portPath = this.getPortPath();
        
        try {
            const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
            const port = fs.existsSync(portPath) 
                ? parseInt(fs.readFileSync(portPath, 'utf-8').trim(), 10) 
                : undefined;
            
            return {
                running: true,
                pid,
                port,
                workspaceRoot: this.workspaceRoot
            };
        } catch {
            return { running };
        }
    }
    
    /**
     * Ensure daemon is running, starting it if necessary
     * 
     * @returns Object with:
     *   - port: The daemon's WebSocket port
     *   - wasStarted: true if we started the daemon this call
     *   - isExternal: true if daemon was started by CLI/external process
     */
    async ensureDaemonRunning(): Promise<EnsureDaemonResult> {
        log.debug('ensureDaemonRunning: Checking if daemon is already running...');
        
        if (this.isDaemonRunning()) {
            const port = this.getDaemonPort();
            log.debug(`ensureDaemonRunning: isDaemonRunning=true, port=${port}`);
            if (port) {
                // Daemon already running - check if we started it
                const isOurs = this.daemonProcess !== null;
                log.info(`Daemon already running on port ${port} (${isOurs ? 'ours' : 'external'})`);
                return { 
                    port, 
                    wasStarted: false,
                    isExternal: !isOurs
                };
            }
            log.debug('ensureDaemonRunning: PID file exists but port file missing, will start new daemon');
        } else {
            log.debug('ensureDaemonRunning: isDaemonRunning=false, will start new daemon');
        }
        
        // Need to start daemon
        const port = await this.startDaemon();
        return { 
            port, 
            wasStarted: true,
            isExternal: false
        };
    }
    
    /**
     * Start the daemon process
     * 
     * Uses the unified daemon starter (start.js) with --vscode mode.
     * This ensures consistent daemon startup across CLI and VS Code.
     */
    async startDaemon(): Promise<number> {
        // Clean up any stale daemon files first
        this.cleanupDaemonFiles();
        
        // Use unified start script
        const startScript = path.join(this.extensionPath, 'out', 'daemon', 'start.js');
        
        log.debug(`Extension path: ${this.extensionPath}`);
        log.debug(`Start script: ${startScript}`);
        log.debug(`Workspace root: ${this.workspaceRoot}`);
        
        // Check if start script exists
        if (!fs.existsSync(startScript)) {
            throw new Error(`Daemon start script not found at ${startScript}. Run 'npm run compile' first.`);
        }
        
        // Start daemon with unified starter in --vscode mode
        // In vscode mode, services are NOT initialized by the daemon
        // They will be injected later by the extension
        log.info('Spawning daemon process...');
        
        // Cross-platform spawn options
        const spawnOptions: SpawnOptions = {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                APC_WORKSPACE_ROOT: this.workspaceRoot,
                APC_MODE: 'vscode'
            }
        };
        
        if (isWindows) {
            // Windows: Use detached + windowsHide to create independent process without console
            // This allows daemon to survive extension host reloads
            spawnOptions.detached = true;
            spawnOptions.windowsHide = true;
        } else {
            // Unix: Use detached for process group management
            spawnOptions.detached = true;
        }
        
        const daemonProcess = spawn('node', [
            startScript,
            '--vscode',
            this.workspaceRoot
        ], spawnOptions);
        
        // Store reference for later cleanup
        this.daemonProcess = daemonProcess;
        
        // Create or reuse dedicated daemon output channel for direct logs
        // This shows daemon logs WITHOUT client prefix for clarity
        const daemonOutputChannel = vscode.window.createOutputChannel('APC Daemon Logs');
        
        // Log daemon output for debugging
        // Send to TWO places:
        // 1. Daemon output channel (direct, no client prefix)
        // 2. Extension log (with prefix, for debugging client-daemon interaction)
        daemonProcess.stdout?.on('data', (data) => {
            const message = data.toString().trim();
            // Direct passthrough to daemon channel (no client prefix!)
            daemonOutputChannel.appendLine(message);
            // Also log to extension log with prefix for troubleshooting
            log.debug(`[Daemon stdout] ${message}`);
        });
        
        daemonProcess.stderr?.on('data', (data) => {
            const message = data.toString().trim();
            // Direct passthrough to daemon channel (no client prefix!)
            daemonOutputChannel.appendLine(`⚠️ ${message}`);
            // Also log to extension log with prefix
            log.error(`[Daemon stderr] ${message}`);
        });
        
        // Handle process exit
        daemonProcess.on('exit', (code, signal) => {
            log.info(`Daemon process exited with code ${code}, signal ${signal}`);
        });
        
        daemonProcess.on('error', (err) => {
            log.error(`Failed to spawn daemon:`, err);
        });
        
        // Unref so VS Code can exit independently (but after we set up handlers)
        daemonProcess.unref();
        
        // Wait for daemon to start and write port file
        // Daemon should be ready in <1 second (WebSocket starts immediately in vscode mode)
        const port = await this.waitForDaemonReady(5000);
        
        // Start health check
        this.startHealthCheck();
        
        log.info(`Daemon started on port ${port} (vscode mode)`);
        return port;
    }
    
    
    /**
     * Wait for daemon to be ready (port file written)
     */
    private async waitForDaemonReady(timeoutMs: number): Promise<number> {
        const startTime = Date.now();
        const portPath = this.getPortPath();
        
        log.debug('Waiting for daemon to write port file...');
        
        // Wait for port file
        let port: number | null = null;
        while (Date.now() - startTime < timeoutMs) {
            if (fs.existsSync(portPath)) {
                const p = parseInt(fs.readFileSync(portPath, 'utf-8').trim(), 10);
                if (!isNaN(p)) {
                    port = p;
                    log.debug(`Port file found: ${port} in ${Date.now() - startTime}ms`);
                    break;
                }
            }
            await this.delay(50);
        }
        
        if (!port) {
            throw new Error('Daemon failed to start within timeout (no port file)');
        }
        
        // Give WebSocket server 200ms to fully bind (port file written before listen completes)
        await this.delay(200);
        
        log.debug(`Daemon should be ready in ${Date.now() - startTime}ms`);
        return port;
    }
    
    /**
     * Check if daemon is responding on the given port
     */
    private checkDaemonHealth(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
                resolve(res.statusCode === 200);
            });
            req.on('error', (err) => {
                log.warn(`Health check error: ${err.message}`);
                resolve(false);
            });
            req.setTimeout(5000, () => { // Increased from 2000ms to 5000ms for very slow startups
                log.warn('Health check timed out after 5000ms');
                req.destroy();
                resolve(false);
            });
        });
    }
    
    /**
     * Stop the daemon (cross-platform)
     */
    async stopDaemon(): Promise<void> {
        log.info('[stopDaemon] Attempting to stop daemon...');
        
        // Stop health check
        this.stopHealthCheck();
        
        const pidPath = this.getPidPath();
        
        if (!fs.existsSync(pidPath)) {
            log.warn('[stopDaemon] PID file does not exist, daemon may not be running');
            // Still clean up any leftover files
            this.cleanupDaemonFiles();
            return;
        }
        
        try {
            const pidContent = fs.readFileSync(pidPath, 'utf-8').trim();
            const pid = parseInt(pidContent, 10);
            
            if (isNaN(pid)) {
                log.error(`[stopDaemon] Invalid PID in file: ${pidContent}`);
                this.cleanupDaemonFiles();
                throw new Error(`Invalid PID in file: ${pidContent}`);
            }
            
            log.info(`[stopDaemon] Found daemon PID: ${pid}`);
            
            if (isWindows) {
                // Windows: Use taskkill for graceful termination
                try {
                    log.info('[stopDaemon] Sending SIGTERM via taskkill (Windows)...');
                    execSync(`taskkill /PID ${pid} /T`, { 
                        stdio: 'ignore',
                        windowsHide: true 
                    });
                    log.info('[stopDaemon] taskkill command sent');
                } catch (killErr) {
                    // Process may already be dead
                    log.warn('[stopDaemon] taskkill error (process may already be stopped):', killErr);
                }
            } else {
                // Unix: Send SIGTERM for graceful shutdown
                try {
                    log.info('[stopDaemon] Sending SIGTERM (Unix)...');
                    process.kill(pid, 'SIGTERM');
                    log.info('[stopDaemon] SIGTERM sent');
                } catch (killErr) {
                    log.warn('[stopDaemon] kill error (process may already be stopped):', killErr);
                }
            }
            
            // Wait for process to exit
            log.info('[stopDaemon] Waiting for daemon to stop...');
            await this.waitForDaemonStop(5000);
            
            log.info('[stopDaemon] Daemon stopped successfully');
        } catch (err) {
            log.error('[stopDaemon] Error stopping daemon:', err);
            throw err;
        } finally {
            // Clean up files even if there were errors
            log.info('[stopDaemon] Cleaning up daemon files...');
            this.cleanupDaemonFiles();
        }
    }
    
    /**
     * Wait for daemon to stop (cross-platform)
     */
    private async waitForDaemonStop(timeoutMs: number): Promise<void> {
        const startTime = Date.now();
        let checkCount = 0;
        
        log.info(`[waitForDaemonStop] Waiting up to ${timeoutMs}ms for daemon to stop...`);
        
        while (Date.now() - startTime < timeoutMs) {
            if (!this.isDaemonRunning()) {
                log.info(`[waitForDaemonStop] Daemon stopped after ${Date.now() - startTime}ms (${checkCount} checks)`);
                return;
            }
            checkCount++;
            await this.delay(100);
        }
        
        log.warn(`[waitForDaemonStop] Daemon did not stop gracefully within ${timeoutMs}ms, forcing kill...`);
        
        // Force kill if still running
        const pidPath = this.getPidPath();
        if (fs.existsSync(pidPath)) {
            try {
                const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
                
                log.info(`[waitForDaemonStop] Force killing PID ${pid}...`);
                
                if (isWindows) {
                    // Windows: Use taskkill with /F for force kill
                    execSync(`taskkill /PID ${pid} /T /F`, { 
                        stdio: 'ignore',
                        windowsHide: true 
                    });
                    log.info('[waitForDaemonStop] Force kill command sent (Windows)');
                } else {
                    // Unix: Send SIGKILL
                    process.kill(pid, 'SIGKILL');
                    log.info('[waitForDaemonStop] SIGKILL sent (Unix)');
                }
            } catch (err) {
                log.warn('[waitForDaemonStop] Force kill error:', err);
            }
        } else {
            log.info('[waitForDaemonStop] PID file already removed');
        }
    }
    
    /**
     * Clean up daemon PID and port files
     */
    private cleanupDaemonFiles(): void {
        try {
            const pidPath = this.getPidPath();
            const portPath = this.getPortPath();
            
            if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
            if (fs.existsSync(portPath)) fs.unlinkSync(portPath);
        } catch {
            // Ignore cleanup errors
        }
    }
    
    /**
     * Start health check interval
     */
    private startHealthCheck(): void {
        this.stopHealthCheck();
        
        this.healthCheckInterval = setInterval(() => {
            if (!this.isDaemonRunning()) {
                log.warn('Daemon died unexpectedly');
                this.stopHealthCheck();
            }
        }, 30000); // Check every 30 seconds
    }
    
    /**
     * Stop health check interval
     */
    private stopHealthCheck(): void {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
    }
    
    /**
     * Dispose resources
     */
    async dispose(): Promise<void> {
        this.stopHealthCheck();
        
        // Note: We don't stop the daemon on dispose because it should continue
        // running for CLI access. Only stop if explicitly requested.
    }
    
    /**
     * Utility delay function
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

