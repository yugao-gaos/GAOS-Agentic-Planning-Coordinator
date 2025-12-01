/**
 * HeadlessTerminalManager - No-op terminal manager for daemon/CLI mode
 * 
 * This implementation does nothing - it's used when running without VS Code.
 * All actual logging still happens via log files (written by CursorAgentRunner).
 * This manager would normally display those logs in VS Code terminals.
 * 
 * In headless mode, users can:
 * - Read log files directly
 * - Use CLI commands to get status
 * - Watch files with their own tools (tail -f, etc.)
 */

import { ITerminalManager, IAgentTerminalInfo } from './ITerminalManager';

/**
 * Tracks agent terminal info even though we don't create actual terminals
 */
interface HeadlessAgentInfo {
    name: string;
    sessionId: string;
    logFile: string;
}

/**
 * Tracks coordinator terminal info
 */
interface HeadlessCoordinatorInfo {
    coordinatorId: string;
    logFile: string;
}

export class HeadlessTerminalManager implements ITerminalManager {
    private agentInfo: Map<string, HeadlessAgentInfo> = new Map();
    private coordinatorInfo: Map<string, HeadlessCoordinatorInfo> = new Map();

    constructor() {
        console.log('[HeadlessTerminalManager] Initialized (no terminals will be created)');
    }

    createAgentTerminal(
        agentName: string,
        sessionId: string,
        logFile: string,
        _workspaceRoot: string
    ): undefined {
        // Track the info but don't create a terminal
        this.agentInfo.set(agentName, {
            name: agentName,
            sessionId,
            logFile
        });
        console.log(`[HeadlessTerminalManager] Agent terminal registered: ${agentName} -> ${logFile}`);
        return undefined;
    }

    startLogTail(_agentName: string): void {
        // No-op in headless mode
    }

    startStreamingLog(agentName: string, logFile: string): void {
        // Update log file path
        const info = this.agentInfo.get(agentName);
        if (info) {
            info.logFile = logFile;
        }
        // No-op for actual streaming
    }

    showTaskHeader(_agentName: string, _taskId: string, _taskDescription: string): void {
        // No-op - this is now handled by CursorAgentRunner writing to log file
    }

    showTaskCompletion(_agentName: string, _success: boolean, _message?: string): void {
        // No-op - this is now handled by CursorAgentRunner writing to log file
    }

    sendCommand(_agentName: string, _command: string): boolean {
        // Cannot send commands without a terminal
        return false;
    }

    showAgentTerminal(_agentName: string): boolean {
        // No terminal to show
        return false;
    }

    closeAgentTerminal(agentName: string): void {
        this.agentInfo.delete(agentName);
    }

    closeAllTerminals(): void {
        this.agentInfo.clear();
    }

    getTerminalInfo(agentName: string): IAgentTerminalInfo | undefined {
        const info = this.agentInfo.get(agentName);
        if (info) {
            return {
                name: info.name,
                sessionId: info.sessionId,
                logFile: info.logFile
            };
        }
        return undefined;
    }

    getActiveTerminalNames(): string[] {
        // In headless mode, all "registered" agents are considered "active"
        return Array.from(this.agentInfo.keys());
    }

    createCoordinatorTerminal(
        coordinatorId: string,
        logFile: string,
        _workspaceRoot: string
    ): undefined {
        // Track the info but don't create a terminal
        this.coordinatorInfo.set(coordinatorId, {
            coordinatorId,
            logFile
        });
        console.log(`[HeadlessTerminalManager] Coordinator terminal registered: ${coordinatorId} -> ${logFile}`);
        return undefined;
    }

    startCoordinatorLogTail(_coordinatorId: string): void {
        // No-op in headless mode
    }

    closeCoordinatorTerminal(coordinatorId: string): void {
        this.coordinatorInfo.delete(coordinatorId);
    }

    showCoordinatorTerminal(_coordinatorId: string): boolean {
        // No terminal to show
        return false;
    }

    clearCoordinatorTerminals(coordinatorId: string, agentNames: string[]): void {
        this.closeCoordinatorTerminal(coordinatorId);
        for (const name of agentNames) {
            this.closeAgentTerminal(name);
        }
    }

    cleanupStaleTerminals(): void {
        // No stale terminals in headless mode
    }

    dispose(): void {
        this.agentInfo.clear();
        this.coordinatorInfo.clear();
        console.log('[HeadlessTerminalManager] Disposed');
    }
}

