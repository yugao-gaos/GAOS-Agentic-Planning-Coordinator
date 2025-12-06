/**
 * Daemon module exports
 * 
 * This module provides the APC daemon server that hosts all business logic.
 * Clients connect via WebSocket to interact with planning and execution.
 * 
 * Starting the daemon:
 * 
 *   CLI:
 *     apc daemon run --headless     # Headless mode (automation)
 *     apc daemon run --vscode       # VS Code mode
 *     apc daemon run --interactive  # Interactive CLI mode
 * 
 *   Programmatic:
 *     import { startDaemon } from './daemon';
 *     await startDaemon({ mode: 'headless', workspaceRoot: '/path/to/project' });
 */

// Main daemon class
export { ApcDaemon, DaemonOptions, DaemonState, runStandalone } from './ApcDaemon';

// Configuration
export { 
    CoreConfig, 
    ConfigLoader, 
    DEFAULT_CONFIG,
    findWorkspaceRoot,
    getDaemonPidPath,
    getDaemonPortPath,
    isDaemonRunning,
    getDaemonPort,
    writeDaemonInfo,
    cleanupDaemonInfo,
    createWorkspaceHash
} from './DaemonConfig';

// API handling
export { ApiHandler, ApiServices } from './ApiHandler';

// Event broadcasting
export { EventBroadcaster, IEventBroadcaster, getBroadcaster } from './EventBroadcaster';

// Standalone service initialization
export { initializeServices } from './standalone';

// Unified daemon starter
export { 
    startDaemon, 
    DaemonMode, 
    StartOptions, 
    StartResult,
    startHeadlessMode,
    startVsCodeMode,
    startInteractiveMode 
} from './start';

// Entry point when run directly
if (require.main === module) {
    // Running directly: node daemon/index.js [workspaceRoot]
    // Use unified start script
    import('./start').then(({ startDaemon }) => {
        // Default to headless mode when run directly
        const workspaceRoot = process.argv[2];
        startDaemon({ 
            mode: 'headless', 
            workspaceRoot,
            verbose: process.env.APC_VERBOSE === 'true'
        }).then(result => {
            if (!result.success) {
                console.error('Failed to start daemon:', result.error);
                process.exit(1);
            }
        }).catch(err => {
            console.error('Failed to start daemon:', err);
            process.exit(1);
        });
    });
}

