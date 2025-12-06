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

const log = Logger.create('Daemon', 'Start');

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
    
    // Initialize all services
    const services = await initializeServices(config);
    
    // Create daemon with services
    const daemon = new ApcDaemon({
        port: config.port,
        workspaceRoot: config.workspaceRoot,
        services,
        verbose
    });
    
    // Setup shutdown handlers
    setupShutdownHandlers(daemon);
    
    // Start daemon
    await daemon.start();
    
    // Mark services as ready (since initializeServices doesn't have daemon reference)
    daemon.setServicesReady();
    
    return daemon;
}

/**
 * Start daemon in VS Code mode (services injected later)
 */
async function startVsCodeMode(config: CoreConfig, verbose: boolean): Promise<ApcDaemon> {
    log.info('Starting daemon for VS Code...');
    
    // Bootstrap essential services FIRST (EventBroadcaster, etc.)
    // These are needed by the daemon even before full initialization
    const { bootstrapDaemonServices } = await import('../services/DaemonBootstrap');
    bootstrapDaemonServices();
    log.info('Essential services bootstrapped');
    
    // Create daemon without full services (will initialize in background)
    const daemon = new ApcDaemon({
        port: config.port,
        workspaceRoot: config.workspaceRoot,
        services: undefined,  // No full services yet
        verbose
    });
    
    // Start daemon FIRST (writes port file, HTTP server starts)
    // This allows client to connect immediately!
    await daemon.start();
    log.info('Daemon HTTP server started - client can connect');
    
    // Initialize full services in background
    // Services will broadcast progress via WebSocket as they initialize
    log.info('Initializing services in background...');
    initializeServices(config, daemon).then(services => {
        log.info('Services initialization complete');
        // Set services on daemon once ready
        daemon.setServices(services);
    }).catch(err => {
        log.error('Services initialization failed:', err);
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

