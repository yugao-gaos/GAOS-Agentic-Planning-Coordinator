/**
 * WslKeepaliveMonitor - Keeps WSL warm to prevent hibernation delays
 * 
 * On Windows, WSL (Windows Subsystem for Linux) can hibernate after a period of
 * inactivity, which causes significant delays when it needs to spin back up.
 * 
 * This monitor periodically runs a lightweight command in WSL to keep it active.
 * It only runs when:
 * - Platform is Windows
 * - Agent backend is 'cursor' (which requires WSL for cursor-agent)
 * 
 * The keepalive interval is 30 seconds by default, which is well within WSL's
 * idle timeout but not so frequent as to cause performance issues.
 */

import { spawn } from 'child_process';
import { OutputChannelManager } from '../services/OutputChannelManager';

export interface WslKeepaliveOptions {
    /** Interval between keepalive pings in milliseconds (default: 30000) */
    intervalMs?: number;
    /** WSL distribution name (default: Ubuntu) */
    distroName?: string;
    /** Output manager for logging */
    outputManager?: OutputChannelManager;
}

export class WslKeepaliveMonitor {
    private static readonly DEFAULT_INTERVAL_MS = 30000;  // 30 seconds
    private static readonly DEFAULT_DISTRO = 'Ubuntu';
    
    private intervalHandle: NodeJS.Timeout | null = null;
    private readonly intervalMs: number;
    private readonly distroName: string;
    private outputManager?: OutputChannelManager;
    private lastPingTime: number = 0;
    private pingCount: number = 0;
    private failureCount: number = 0;
    private isWindows: boolean;
    
    constructor(options: WslKeepaliveOptions = {}) {
        this.intervalMs = options.intervalMs ?? WslKeepaliveMonitor.DEFAULT_INTERVAL_MS;
        this.distroName = options.distroName ?? WslKeepaliveMonitor.DEFAULT_DISTRO;
        this.outputManager = options.outputManager;
        this.isWindows = process.platform === 'win32';
    }
    
    /**
     * Set the output manager for logging
     */
    setOutputManager(outputManager: OutputChannelManager): void {
        this.outputManager = outputManager;
    }
    
    /**
     * Start the WSL keepalive monitor
     * @returns true if started, false if not applicable (non-Windows platform)
     */
    start(): boolean {
        if (!this.isWindows) {
            this.log('WSL keepalive not needed on non-Windows platform');
            return false;
        }
        
        if (this.intervalHandle) {
            this.log('WSL keepalive already running');
            return true;
        }
        
        this.log(`Starting WSL keepalive (interval: ${this.intervalMs / 1000}s, distro: ${this.distroName})`);
        
        // Do an initial ping to verify WSL is accessible
        this.pingWsl().then(success => {
            if (success) {
                this.log('WSL keepalive: Initial ping successful - WSL is warm');
            } else {
                this.log('WSL keepalive: Initial ping failed - WSL may not be available');
            }
        });
        
        // Start periodic pings
        this.intervalHandle = setInterval(() => {
            this.pingWsl();
        }, this.intervalMs);
        
        return true;
    }
    
    /**
     * Stop the WSL keepalive monitor
     */
    stop(): void {
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
            this.log(`WSL keepalive stopped (total pings: ${this.pingCount}, failures: ${this.failureCount})`);
        }
    }
    
    /**
     * Check if the monitor is running
     */
    isRunning(): boolean {
        return this.intervalHandle !== null;
    }
    
    /**
     * Get current status
     */
    getStatus(): {
        running: boolean;
        platform: string;
        distro: string;
        intervalMs: number;
        pingCount: number;
        failureCount: number;
        lastPingTime: number | null;
        lastPingAgo: number | null;
    } {
        const now = Date.now();
        return {
            running: this.isRunning(),
            platform: process.platform,
            distro: this.distroName,
            intervalMs: this.intervalMs,
            pingCount: this.pingCount,
            failureCount: this.failureCount,
            lastPingTime: this.lastPingTime || null,
            lastPingAgo: this.lastPingTime ? Math.round((now - this.lastPingTime) / 1000) : null
        };
    }
    
    /**
     * Ping WSL with a lightweight command
     * Returns true if successful, false if failed
     */
    private async pingWsl(): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            // Use a very lightweight command - just echo a single character
            const proc = spawn('wsl', ['-d', this.distroName, 'echo', '1'], {
                stdio: 'pipe',
                windowsHide: true  // Hide WSL window
            });
            
            let resolved = false;
            
            // Set a timeout to avoid hanging
            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    this.failureCount++;
                    proc.kill();
                    // Only log failures occasionally to avoid spam
                    if (this.failureCount % 5 === 1) {
                        this.log(`WSL keepalive ping timeout (failure #${this.failureCount})`);
                    }
                    resolve(false);
                }
            }, 5000);  // 5 second timeout
            
            proc.on('close', (code) => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    this.lastPingTime = Date.now();
                    this.pingCount++;
                    
                    if (code === 0) {
                        // Success - only log every 10 pings to avoid spam
                        if (this.pingCount % 10 === 0) {
                            this.log(`WSL keepalive: ${this.pingCount} pings completed`);
                        }
                        resolve(true);
                    } else {
                        this.failureCount++;
                        if (this.failureCount % 5 === 1) {
                            this.log(`WSL keepalive ping failed (exit code: ${code}, failure #${this.failureCount})`);
                        }
                        resolve(false);
                    }
                }
            });
            
            proc.on('error', (err) => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    this.failureCount++;
                    if (this.failureCount % 5 === 1) {
                        this.log(`WSL keepalive ping error: ${err.message} (failure #${this.failureCount})`);
                    }
                    resolve(false);
                }
            });
        });
    }
    
    private log(message: string): void {
        const msg = `[WslKeepalive] ${message}`;
        if (this.outputManager) {
            this.outputManager.log('DAEMON', msg);
        } else {
            console.log(msg);
        }
    }
}

