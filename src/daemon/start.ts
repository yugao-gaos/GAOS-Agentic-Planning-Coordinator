#!/usr/bin/env node
/**
 * Unified Daemon Starter
 * 
 * This script provides a unified way to start the APC daemon in different modes:
 * 
 * Modes:
 *   --headless    Start daemon for automation/headless operation (no VS Code)
 *   --vscode      Start daemon for VS Code extension (services injected later)
 *   --interactive Start daemon for interactive CLI (future TUI support)
 * 
 * Usage:
 *   node start.js [--headless|--vscode|--interactive] [workspaceRoot]
 *   
 * Environment Variables:
 *   APC_WORKSPACE_ROOT - Workspace root path
 *   APC_PORT - Port to listen on (default: 19840)
 *   APC_VERBOSE - Enable verbose logging
 *   APC_MODE - Daemon mode (headless, vscode, interactive)
 */

import { ApcDaemon, DaemonOptions } from './ApcDaemon';
import { 
    findWorkspaceRoot, 
    ConfigLoader, 
    isDaemonRunning, 
    getDaemonPort,
    CoreConfig 
} from './DaemonConfig';
import { initializeServices } from './standalone';
import { bootstrapDaemonServices } from '../services/DaemonBootstrap';
import { Logger } from '../utils/Logger';
import { execSync } from 'child_process';
import * as net from 'net';

const log = Logger.create('Daemon', 'Start');

// ============================================================================
// Port Management Utilities
// ============================================================================

/**
 * Check if a port is already in use
 */
async function isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                resolve(true);
            } else {
                resolve(false);
            }
        });
        server.once('listening', () => {
            server.close();
            resolve(false);
        });
        server.listen(port, '127.0.0.1');
    });
}

/**
 * Kill any process listening on the specified port
 */
async function killProcessOnPort(port: number): Promise<void> {
    const isWindows = process.platform === 'win32';
    
    try {
        if (isWindows) {
            // Windows: Use netstat to find PID, then taskkill
            try {
                const result = execSync(
                    `netstat -ano | findstr :${port} | findstr LISTENING`,
                    { encoding: 'utf-8', windowsHide: true, timeout: 5000 }
                ).trim();
                
                // Parse PID from netstat output (last column)
                const lines = result.split('\n');
                const pids = new Set<number>();
                for (const line of lines) {
                    const parts = line.trim().split(/\s+/);
                    const pid = parseInt(parts[parts.length - 1], 10);
                    if (!isNaN(pid) && pid > 0) {
                        pids.add(pid);
                    }
                }
                
                for (const pid of pids) {
                    log.info(`Killing process ${pid} on port ${port}...`);
                    try {
                        execSync(`taskkill /PID ${pid} /F /T`, { 
                            windowsHide: true, 
                            stdio: 'ignore',
                            timeout: 5000 
                        });
                    } catch {
                        // Process might already be dead
                    }
                }
            } catch {
                // No process found on port, or command failed
            }
        } else {
            // Unix: Use lsof or fuser
            try {
                const result = execSync(
                    `lsof -ti:${port}`,
                    { encoding: 'utf-8', timeout: 5000 }
                ).trim();
                
                const pids = result.split('\n').filter(p => p.trim());
                for (const pid of pids) {
                    log.info(`Killing process ${pid} on port ${port}...`);
                    try {
                        process.kill(parseInt(pid, 10), 'SIGKILL');
                    } catch {
                        // Process might already be dead
                    }
                }
            } catch {
                // No process found on port
            }
        }
    } catch (err) {
        log.warn(`Failed to kill process on port ${port}: ${err}`);
    }
}

// ============================================================================
// Types
// ============================================================================

export type DaemonMode = 'headless' | 'vscode' | 'interactive';

export interface StartOptions {
    /** Daemon mode */
    mode: DaemonMode;
    /** Workspace root (auto-detected if not provided) */
    workspaceRoot?: string;
    /** Port override */
    port?: number;
    /** Enable verbose logging */
    verbose?: boolean;
    /** Force start even if daemon is running */
    force?: boolean;
}

export interface StartResult {
    success: boolean;
    port?: number;
    pid?: number;
    error?: string;
    alreadyRunning?: boolean;
}

// ============================================================================
// Daemon Starter
// ============================================================================

/**
 * Start the APC daemon
 */
export async function startDaemon(options: StartOptions): Promise<StartResult> {
    const workspaceRoot = options.workspaceRoot || process.env.APC_WORKSPACE_ROOT || findWorkspaceRoot();
    const verbose = options.verbose || process.env.APC_VERBOSE === 'true';
    
    log.info(`Starting daemon in ${options.mode} mode...`);
    log.info(`Workspace: ${workspaceRoot}`);
    
    // Check if daemon is already running
    if (!options.force && isDaemonRunning(workspaceRoot)) {
        const existingPort = getDaemonPort(workspaceRoot);
        log.info(`Daemon already running on port ${existingPort}`);
        return {
            success: true,
            port: existingPort || undefined,
            alreadyRunning: true
        };
    }
    
    // Load configuration
    const configLoader = new ConfigLoader(workspaceRoot);
    const config = configLoader.getConfig();
    
    // Apply overrides
    if (options.port) {
        config.port = options.port;
    }
    if (process.env.APC_PORT) {
        config.port = parseInt(process.env.APC_PORT, 10);
    }
    
    try {
        let daemon: ApcDaemon;
        
        switch (options.mode) {
            case 'headless':
                // Full standalone mode - initialize all services
                daemon = await startHeadlessMode(config, verbose);
                break;
                
            case 'vscode':
                // VS Code mode - daemon starts without services
                // Services will be injected by the VS Code extension
                daemon = await startVsCodeMode(config, verbose);
                break;
                
            case 'interactive':
                // Interactive CLI mode (future)
                // Similar to headless but with TUI support
                daemon = await startInteractiveMode(config, verbose);
                break;
                
            default:
                throw new Error(`Unknown mode: ${options.mode}`);
        }
        
        // Get final port
        const finalConfig = daemon.getConfig();
        
        log.info(`Daemon started successfully`);
        log.info(`Port: ${finalConfig.port}`);
        log.info(`Mode: ${options.mode}`);
        
        return {
            success: true,
            port: finalConfig.port,
            pid: process.pid
        };
        
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.error(`Failed to start daemon: ${errorMessage}`);
        return {
            success: false,
            error: errorMessage
        };
    }
}

/**
 * Start daemon in headless mode with all services initialized
 */
async function startHeadlessMode(config: CoreConfig, verbose: boolean): Promise<ApcDaemon> {
    log.info('Initializing services for headless mode...');
    
    // Create daemon first to get its configLoader for live config updates
    const daemon = new ApcDaemon({
        port: config.port,
        workspaceRoot: config.workspaceRoot,
        services: undefined,  // Will set services after initialization
        verbose
    });
    
    // Initialize all services with daemon's configLoader for live config updates
    const services = await initializeServices(config, daemon, false, daemon.getConfigLoader());
    
    // Set services on daemon
    daemon.setServices(services);
    
    // Setup shutdown handlers
    setupShutdownHandlers(daemon);
    
    // Start daemon
    await daemon.start();
    
    // Mark services as ready
    daemon.setServicesReady();
    
    return daemon;
}

/**
 * Start daemon in VS Code mode (services injected later)
 */
async function startVsCodeMode(config: CoreConfig, verbose: boolean): Promise<ApcDaemon> {
    const startTime = Date.now();
    const logProgress = (step: string) => {
        log.info(`[${Date.now() - startTime}ms] ${step}`);
    };
    
    logProgress('Starting daemon for VS Code...');
    
    // ========================================================================
    // PHASE 1: Clean up stale resources (before any initialization)
    // ========================================================================
    
    // Step 1a: Check if port is already in use (old daemon might still be running)
    logProgress('Checking if port is in use...');
    const portInUse = await isPortInUse(config.port);
    if (portInUse) {
        log.warn(`Port ${config.port} is already in use - killing process on that port...`);
        await killProcessOnPort(config.port);
        // Wait for port to be released
        await new Promise(resolve => setTimeout(resolve, 500));
        logProgress('Port cleanup complete');
    } else {
        logProgress('Port is available');
    }
    
    // Step 1b: Kill orphan cursor-agent processes (no dependencies needed)
    // This ensures a clean slate before starting any services
    logProgress('Checking for orphan cursor-agent processes...');
    try {
        const { killOrphanCursorAgents, countCursorAgentProcesses } = await import('../utils/orphanCleanup');
        logProgress('Orphan cleanup module loaded');
        const beforeCount = countCursorAgentProcesses();
        logProgress(`Counted ${beforeCount} cursor-agent processes`);
        if (beforeCount > 0) {
            log.info(`Found ${beforeCount} orphan cursor-agent processes - cleaning up...`);
            const killed = await killOrphanCursorAgents(new Set(), '[DaemonStartup]');
            // Brief wait for processes to terminate
            await new Promise(resolve => setTimeout(resolve, 300));
            const afterCount = countCursorAgentProcesses();
            if (afterCount === 0) {
                logProgress(`✅ Cleaned up ${killed} orphan processes`);
            } else {
                logProgress(`${afterCount} cursor-agent processes remain (likely Cursor IDE worker-server)`);
            }
        } else {
            logProgress('No orphan cursor-agent processes found');
        }
    } catch (err) {
        logProgress(`Orphan cleanup skipped: ${err}`);
    }
    
    // ========================================================================
    // PHASE 2: Initialize services
    // ========================================================================
    
    // Bootstrap essential services (EventBroadcaster, etc.)
    logProgress('Bootstrapping essential services...');
    const { bootstrapDaemonServices } = await import('../services/DaemonBootstrap');
    bootstrapDaemonServices();
    logProgress('Essential services bootstrapped');
    
    // Create daemon without full services (will initialize in background)
    logProgress('Creating ApcDaemon instance...');
    const daemon = new ApcDaemon({
        port: config.port,
        workspaceRoot: config.workspaceRoot,
        services: undefined,  // No full services yet
        verbose
    });
    logProgress('ApcDaemon instance created');
    
    // Start daemon FIRST (writes port file, HTTP server starts)
    // This allows client to connect immediately!
    logProgress('Starting HTTP server and writing port file...');
    await daemon.start();
    logProgress('Daemon HTTP server started - client can connect');
    
    // Initialize full services in background
    // Services will broadcast progress via WebSocket as they initialize
    log.info('Initializing services in background...');
    initializeServices(config, daemon, true /* skipOrphanCleanup - already done above */, daemon.getConfigLoader()).then(services => {
        log.info('Services initialization complete');
        // Set services on daemon once ready
        daemon.setServices(services);
    }).catch(async (err) => {
        log.error('Services initialization failed:', err);
        // Daemon cannot function without services - broadcast error and shutdown
        try {
            const { ServiceLocator } = await import('../services/ServiceLocator');
            const { EventBroadcaster } = await import('./EventBroadcaster');
            if (ServiceLocator.isRegistered(EventBroadcaster)) {
                const broadcaster = ServiceLocator.resolve(EventBroadcaster);
                broadcaster.broadcast('daemon.error', {
                    fatal: true,
                    message: `Services initialization failed: ${err instanceof Error ? err.message : String(err)}`,
                    timestamp: new Date().toISOString()
                });
            }
        } catch {
            // Ignore broadcast errors during shutdown
        }
        // Give clients a moment to receive the error message
        setTimeout(async () => {
            log.info('Shutting down daemon due to service initialization failure');
            await daemon.stop('service_init_failed');
            process.exit(1);
        }, 1000);
    });
    
    // Don't setup shutdown handlers - VS Code manages lifecycle
    
    return daemon;
}

/**
 * Start daemon in interactive mode (future TUI support)
 */
async function startInteractiveMode(config: CoreConfig, verbose: boolean): Promise<ApcDaemon> {
    log.info('Starting daemon in interactive mode...');
    log.info('Note: Interactive TUI is not yet implemented. Using headless mode.');
    
    // For now, same as headless
    // Future: Add TUI components, readline interface, etc.
    return startHeadlessMode(config, verbose);
}

/**
 * Setup process shutdown handlers
 */
function setupShutdownHandlers(daemon: ApcDaemon): void {
    const shutdown = async (signal: string) => {
        log.info(`Received ${signal}, shutting down...`);
        await daemon.stop(signal);
        process.exit(0);
    };
    
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ============================================================================
// CLI Entry Point
// ============================================================================

function printUsage(): void {
    console.log(`
APC Daemon Starter

Usage: node start.js [options] [workspaceRoot]

Options:
  --headless      Start in headless mode (for automation)
  --vscode        Start in VS Code mode (services injected later)
  --interactive   Start in interactive mode (future TUI)
  --port <port>   Override daemon port
  --force         Force start even if daemon is already running
  --verbose       Enable verbose logging
  --help          Show this help message

Environment Variables:
  APC_WORKSPACE_ROOT  Workspace root path
  APC_PORT            Port to listen on (default: 19840)
  APC_VERBOSE         Enable verbose logging (true/false)
  APC_MODE            Daemon mode (headless, vscode, interactive)

Examples:
  node start.js --headless
  node start.js --headless /path/to/project
  APC_PORT=19841 node start.js --vscode
`);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    
    // Parse arguments
    let mode: DaemonMode = 'headless';
    let workspaceRoot: string | undefined;
    let port: number | undefined;
    let verbose = false;
    let force = false;
    
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        
        switch (arg) {
            case '--headless':
                mode = 'headless';
                break;
            case '--vscode':
                mode = 'vscode';
                break;
            case '--interactive':
                mode = 'interactive';
                break;
            case '--port':
                port = parseInt(args[++i], 10);
                break;
            case '--force':
                force = true;
                break;
            case '--verbose':
            case '-v':
                verbose = true;
                break;
            case '--help':
            case '-h':
                printUsage();
                process.exit(0);
                break;
            default:
                if (!arg.startsWith('-')) {
                    workspaceRoot = arg;
                } else {
                    console.error(`Unknown option: ${arg}`);
                    printUsage();
                    process.exit(1);
                }
        }
    }
    
    // Check for mode in environment
    if (process.env.APC_MODE) {
        const envMode = process.env.APC_MODE.toLowerCase();
        if (['headless', 'vscode', 'interactive'].includes(envMode)) {
            mode = envMode as DaemonMode;
        }
    }
    
    // Start daemon
    const result = await startDaemon({
        mode,
        workspaceRoot,
        port,
        verbose,
        force
    });
    
    if (!result.success) {
        log.error(`Failed: ${result.error}`);
        process.exit(1);
    }
    
    if (result.alreadyRunning) {
        log.info(`Using existing daemon on port ${result.port}`);
        // For headless mode, we might want to exit since daemon is already running
        // For vscode mode, we continue to let VS Code connect
        if (mode === 'headless') {
            process.exit(0);
        }
    }
    
    // Keep process alive
    log.info('Daemon is running. Press Ctrl+C to stop.');
}

// Run if executed directly
if (require.main === module) {
    main().catch(err => {
        log.error('Fatal error:', err);
        process.exit(1);
    });
}

export { startHeadlessMode, startVsCodeMode, startInteractiveMode, setupShutdownHandlers };

