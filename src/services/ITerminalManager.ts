/**
 * ITerminalManager - Interface for terminal management
 * 
 * This interface allows different implementations:
 * - TerminalManager: VS Code terminals (for IDE use)
 * - HeadlessTerminalManager: No-op (for daemon/CLI use)
 * 
 * All actual logging goes through log files. The terminal manager
 * just provides a way to VIEW those logs (via tail -f in VS Code).
 */

/**
 * Terminal info for an agent
 */
export interface IAgentTerminalInfo {
    name: string;
    sessionId: string;
    logFile: string;
}

/**
 * Terminal manager interface
 * 
 * In VS Code: Creates terminals that tail log files
 * In headless mode: No-op (logs still go to files)
 */
export interface ITerminalManager {
    /**
     * Create a terminal for an agent session
     * In headless mode: no-op, returns undefined
     */
    createAgentTerminal(
        agentName: string,
        sessionId: string,
        logFile: string,
        workspaceRoot: string
    ): any; // Returns vscode.Terminal in VS Code, undefined in headless

    /**
     * Start tailing the agent's log file in their terminal
     */
    startLogTail(agentName: string): void;

    /**
     * Start streaming the log file in terminal
     */
    startStreamingLog(agentName: string, logFile: string): void;

    /**
     * Show task header (legacy - now writes to log file)
     */
    showTaskHeader(agentName: string, taskId: string, taskDescription: string): void;

    /**
     * Show task completion (legacy - now writes to log file)
     */
    showTaskCompletion(agentName: string, success: boolean, message?: string): void;

    /**
     * Send a command to an agent's terminal
     */
    sendCommand(agentName: string, command: string): boolean;

    /**
     * Show an agent's terminal
     */
    showAgentTerminal(agentName: string): boolean;

    /**
     * Close an agent's terminal
     */
    closeAgentTerminal(agentName: string): void;

    /**
     * Close all agent terminals
     */
    closeAllTerminals(): void;

    /**
     * Get info about an agent's terminal
     */
    getTerminalInfo(agentName: string): IAgentTerminalInfo | undefined;

    /**
     * Get all active agent terminal names
     */
    getActiveTerminalNames(): string[];

    /**
     * Create a coordinator terminal for monitoring
     */
    createCoordinatorTerminal(
        coordinatorId: string,
        logFile: string,
        workspaceRoot: string
    ): any; // Returns vscode.Terminal in VS Code, undefined in headless

    /**
     * Start tailing the coordinator's log file
     */
    startCoordinatorLogTail(coordinatorId: string): void;

    /**
     * Close a coordinator's terminal
     */
    closeCoordinatorTerminal(coordinatorId: string): void;

    /**
     * Show a coordinator's terminal
     */
    showCoordinatorTerminal(coordinatorId: string): boolean;

    /**
     * Clear all terminal references for a coordinator and its agents
     */
    clearCoordinatorTerminals(coordinatorId: string, agentNames: string[]): void;

    /**
     * Remove stale terminal references
     */
    cleanupStaleTerminals(): void;

    /**
     * Dispose all resources
     */
    dispose(): void;
}

