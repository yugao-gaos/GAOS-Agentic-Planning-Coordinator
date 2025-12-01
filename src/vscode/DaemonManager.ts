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
import { spawn, ChildProcess, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';

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
     * Check if daemon is running
     */
    isDaemonRunning(): boolean {
        const pidPath = this.getPidPath();
        
        if (!fs.existsSync(pidPath)) {
            return false;
        }
        
        try {
            const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
            // Check if process exists (signal 0 just checks existence)
            process.kill(pid, 0);
            return true;
        } catch {
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
        if (this.isDaemonRunning()) {
            const port = this.getDaemonPort();
            if (port) {
                // Daemon already running - check if we started it
                const isOurs = this.daemonProcess !== null;
                console.log(`[DaemonManager] Daemon already running on port ${port} (${isOurs ? 'ours' : 'external'})`);
                return { 
                    port, 
                    wasStarted: false,
                    isExternal: !isOurs
                };
            }
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
        
        console.log(`[DaemonManager] Extension path: ${this.extensionPath}`);
        console.log(`[DaemonManager] Start script: ${startScript}`);
        console.log(`[DaemonManager] Workspace root: ${this.workspaceRoot}`);
        
        // Check if start script exists
        if (!fs.existsSync(startScript)) {
            // Fallback to legacy entry point
            const legacyEntry = path.join(this.extensionPath, 'out', 'daemon', 'index.js');
            console.log(`[DaemonManager] Start script not found, checking legacy: ${legacyEntry}`);
            if (!fs.existsSync(legacyEntry)) {
                throw new Error(`Daemon scripts not found at ${startScript}. Run 'npm run compile' first.`);
            }
            console.log('[DaemonManager] Using legacy daemon entry (start.js not found)');
            return this.startDaemonLegacy(legacyEntry);
        }
        
        // Start daemon with unified starter in --vscode mode
        // In vscode mode, services are NOT initialized by the daemon
        // They will be injected later by the extension
        console.log('[DaemonManager] Spawning daemon process...');
        const daemonProcess = spawn('node', [
            startScript,
            '--vscode',
            this.workspaceRoot
        ], {
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                APC_WORKSPACE_ROOT: this.workspaceRoot,
                APC_MODE: 'vscode'
            }
        });
        
        // Store reference for later cleanup
        this.daemonProcess = daemonProcess;
        
        // Log daemon output for debugging
        daemonProcess.stdout?.on('data', (data) => {
            console.log(`[Daemon] ${data.toString().trim()}`);
        });
        
        daemonProcess.stderr?.on('data', (data) => {
            console.error(`[Daemon Error] ${data.toString().trim()}`);
        });
        
        // Handle process exit
        daemonProcess.on('exit', (code, signal) => {
            console.log(`[DaemonManager] Daemon process exited with code ${code}, signal ${signal}`);
        });
        
        daemonProcess.on('error', (err) => {
            console.error(`[DaemonManager] Failed to spawn daemon:`, err);
        });
        
        // Unref so VS Code can exit independently (but after we set up handlers)
        daemonProcess.unref();
        
        // Wait for daemon to start and write port file
        const port = await this.waitForDaemonReady(5000);
        
        // Start health check
        this.startHealthCheck();
        
        console.log(`[DaemonManager] Daemon started on port ${port} (vscode mode)`);
        return port;
    }
    
    /**
     * Legacy daemon startup (fallback)
     */
    private async startDaemonLegacy(daemonEntry: string): Promise<number> {
        const daemonProcess = spawn('node', [daemonEntry, this.workspaceRoot], {
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                APC_WORKSPACE_ROOT: this.workspaceRoot
            }
        });
        
        daemonProcess.unref();
        this.daemonProcess = daemonProcess;
        
        daemonProcess.stdout?.on('data', (data) => {
            console.log(`[Daemon] ${data.toString().trim()}`);
        });
        
        daemonProcess.stderr?.on('data', (data) => {
            console.error(`[Daemon Error] ${data.toString().trim()}`);
        });
        
        const port = await this.waitForDaemonReady(5000);
        this.startHealthCheck();
        
        console.log(`[DaemonManager] Daemon started on port ${port} (legacy mode)`);
        return port;
    }
    
    /**
     * Wait for daemon to be ready (port file written AND daemon responding)
     */
    private async waitForDaemonReady(timeoutMs: number): Promise<number> {
        const startTime = Date.now();
        const portPath = this.getPortPath();
        
        // First wait for port file
        let port: number | null = null;
        while (Date.now() - startTime < timeoutMs) {
            if (fs.existsSync(portPath)) {
                const p = parseInt(fs.readFileSync(portPath, 'utf-8').trim(), 10);
                if (!isNaN(p)) {
                    port = p;
                    break;
                }
            }
            await this.delay(100);
        }
        
        if (!port) {
            throw new Error('Daemon failed to start within timeout (no port file)');
        }
        
        // Now verify daemon is actually responding
        console.log(`[DaemonManager] Port file found (${port}), verifying daemon is ready...`);
        while (Date.now() - startTime < timeoutMs) {
            try {
                const response = await this.checkDaemonHealth(port);
                if (response) {
                    console.log(`[DaemonManager] Daemon health check passed`);
                    return port;
                }
            } catch {
                // Daemon not ready yet, retry
            }
            await this.delay(100);
        }
        
        throw new Error('Daemon failed to respond within timeout');
    }
    
    /**
     * Check if daemon is responding on the given port
     */
    private checkDaemonHealth(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
                resolve(res.statusCode === 200);
            });
            req.on('error', () => resolve(false));
            req.setTimeout(500, () => {
                req.destroy();
                resolve(false);
            });
        });
    }
    
    /**
     * Stop the daemon
     */
    async stopDaemon(): Promise<void> {
        // Stop health check
        this.stopHealthCheck();
        
        const pidPath = this.getPidPath();
        
        if (!fs.existsSync(pidPath)) {
            return;
        }
        
        try {
            const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
            
            // Send SIGTERM for graceful shutdown
            process.kill(pid, 'SIGTERM');
            
            // Wait for process to exit
            await this.waitForDaemonStop(5000);
            
            console.log('[DaemonManager] Daemon stopped');
        } catch (err) {
            console.warn('[DaemonManager] Error stopping daemon:', err);
        }
        
        // Clean up files
        this.cleanupDaemonFiles();
    }
    
    /**
     * Wait for daemon to stop
     */
    private async waitForDaemonStop(timeoutMs: number): Promise<void> {
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeoutMs) {
            if (!this.isDaemonRunning()) {
                return;
            }
            await this.delay(100);
        }
        
        // Force kill if still running
        const pidPath = this.getPidPath();
        if (fs.existsSync(pidPath)) {
            try {
                const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
                process.kill(pid, 'SIGKILL');
            } catch {
                // Ignore kill errors
            }
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
                console.warn('[DaemonManager] Daemon died unexpectedly');
                this.stopHealthCheck();
                
                // Could auto-restart here if desired
                // this.startDaemon().catch(console.error);
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

