import * as vscode from 'vscode';
import * as path from 'path';
import { AgentTerminal } from '../types';
import { ITerminalManager, IAgentTerminalInfo } from './ITerminalManager';

interface CoordinatorTerminal {
    coordinatorId: string;
    terminal: vscode.Terminal;
    logFile: string;
}

/**
 * VS Code Terminal Manager - Creates terminals that tail log files
 * 
 * This is the VS Code-specific implementation of ITerminalManager.
 * For headless/daemon mode, use HeadlessTerminalManager instead.
 */
export class TerminalManager implements ITerminalManager {
    private agentTerminals: Map<string, AgentTerminal> = new Map();
    private coordinatorTerminals: Map<string, CoordinatorTerminal> = new Map();
    private agentOutputChannels: Map<string, vscode.OutputChannel> = new Map();
    private disposables: vscode.Disposable[] = [];
    
    // Debounce map to prevent duplicate streaming commands (agentName -> timestamp)
    private lastStreamingStart: Map<string, number> = new Map();
    private static readonly STREAMING_DEBOUNCE_MS = 2000; // 2 seconds

    constructor() {
        // Listen for terminal close events
        this.disposables.push(
            vscode.window.onDidCloseTerminal(terminal => {
                // Find and remove the closed terminal from our map
                for (const [name, agentTerminal] of this.agentTerminals) {
                    if (agentTerminal.terminal === terminal) {
                        // Don't remove from map - we want to track that the terminal was closed
                        // but the agent process may still be running
                        console.log(`Terminal closed for agent: ${name}`);
                        break;
                    }
                }
            })
        );
    }

    /**
     * Create a new terminal for an agent session
     */
    createAgentTerminal(
        agentName: string,
        sessionId: string,
        logFile: string,
        workspaceRoot: string
    ): vscode.Terminal {
        const terminalName = `🔧 ${agentName}`;
        const now = Date.now();
        
        // Log every call to help debug duplicate events
        console.log(`[TerminalManager] createAgentTerminal called for ${agentName} at ${now}`);
        console.log(`[TerminalManager]   sessionId=${sessionId}, logFile=${logFile?.substring(logFile.lastIndexOf('/') + 1)}`);
        
        // Debounce: skip if we recently started streaming for this agent
        const lastStart = this.lastStreamingStart.get(agentName);
        if (lastStart && (now - lastStart) < TerminalManager.STREAMING_DEBOUNCE_MS) {
            console.log(`[TerminalManager] DEBOUNCE: Skipping duplicate for ${agentName} (last: ${now - lastStart}ms ago)`);
            const existing = this.agentTerminals.get(agentName);
            if (existing && this.isTerminalAlive(existing.terminal)) {
                return existing.terminal;
            }
            console.log(`[TerminalManager] DEBOUNCE: But terminal not alive, will recreate`);
        }
        
        // Check if terminal already exists and is still valid
        const existing = this.agentTerminals.get(agentName);
        const terminalAlive = existing ? this.isTerminalAlive(existing.terminal) : false;
        console.log(`[TerminalManager]   existing=${!!existing}, isAlive=${terminalAlive}, window.terminals.length=${vscode.window.terminals.length}`);
        
        if (existing && terminalAlive) {
            console.log(`[TerminalManager]   REUSING existing terminal for ${agentName}`);
            // Update the stored info in case sessionId/logFile changed
            existing.sessionId = sessionId;
            existing.logFile = logFile;
            existing.terminal.show();
            
            // Restart tailing with the new log file
            // Use mkdir -p to ensure directory exists
            if (logFile) {
                this.lastStreamingStart.set(agentName, now);
                existing.terminal.sendText(
                    `pkill -INT -f "tail -f.*${path.basename(logFile)}" 2>/dev/null; ` +
                    `mkdir -p "$(dirname '${logFile}')" 2>/dev/null; ` +
                    `printf "\\n🔴 Streaming: ${logFile}\\n\\n"; ` +
                    `touch "${logFile}" && tail -f "${logFile}"`
                );
            }
            return existing.terminal;
        }

        // If existing terminal is dead, dispose it first
        if (existing) {
            console.log(`[TerminalManager]   Cleaning up dead terminal reference for ${agentName}`);
            this.agentTerminals.delete(agentName);
        }

        console.log(`[TerminalManager]   CREATING new terminal for ${agentName}`);
        // Create new terminal with proper agent name
        const terminal = vscode.window.createTerminal({
            name: terminalName,
            cwd: workspaceRoot,
            iconPath: new vscode.ThemeIcon('person'),
            message: `Agent ${agentName} | Session: ${sessionId}`
        });

        // Store terminal reference
        this.agentTerminals.set(agentName, {
            name: agentName,
            sessionId,
            terminal,
            logFile
        });

        // Show the terminal
        const config = vscode.workspace.getConfiguration('agenticPlanning');
        if (config.get<boolean>('autoOpenTerminals', true)) {
            terminal.show(false); // false = don't take focus
        }

        // Start tailing the log file immediately if provided
        // This ensures the terminal shows streaming output from the start
        // Use mkdir -p to create the directory if it doesn't exist (workflow may not have created it yet)
        if (logFile) {
            this.lastStreamingStart.set(agentName, Date.now());
            terminal.sendText(
                `mkdir -p "$(dirname '${logFile}')" 2>/dev/null; ` +
                `printf "\\n🔴 Streaming: ${logFile}\\n\\n"; ` +
                `touch "${logFile}" && tail -f "${logFile}"`
            );
        }

        return terminal;
    }

    /**
     * Start tailing the agent's log file in their terminal
     */
    startLogTail(agentName: string): void {
        const agentTerminal = this.agentTerminals.get(agentName);
        if (!agentTerminal) {
            console.warn(`No terminal found for agent: ${agentName}`);
            return;
        }

        if (!this.isTerminalAlive(agentTerminal.terminal)) {
            console.warn(`Terminal for ${agentName} is not alive`);
            return;
        }

        // Kill existing tail, show current content, then start fresh tail - all in one command
        agentTerminal.terminal.sendText(
            `pkill -INT -f "tail -f.*${path.basename(agentTerminal.logFile)}" 2>/dev/null; ` +
            `cat "${agentTerminal.logFile}" 2>/dev/null; ` +
            `printf "\\n--- Live stream started ---\\n"; ` +
            `tail -f "${agentTerminal.logFile}"`
        );
    }
    
    /**
     * Append text to an agent's terminal is now a no-op since we use tail -f on log file.
     * The CursorAgentRunner writes directly to the log file which the terminal tails.
     */
    appendToTerminal(agentName: string, text: string, type: 'text' | 'thinking' | 'tool' | 'tool_result' | 'error' | 'info'): void {
        // No-op: output goes to log file which terminal tails via startStreamingLog()
    }

    /**
     * Start streaming the log file in terminal with tail -f
     * This shows live output as CursorAgentRunner writes to the log
     */
    startStreamingLog(agentName: string, logFile: string): void {
        const agentTerminal = this.agentTerminals.get(agentName);
        if (!agentTerminal || !this.isTerminalAlive(agentTerminal.terminal)) {
            console.warn(`No terminal found for agent: ${agentName}`);
            return;
        }

        // Kill any existing tail, clear, show header, then start fresh tail - all in one command
        // Using pkill to kill any tail process in this terminal's process group
        // Use mkdir -p to ensure directory exists
        agentTerminal.terminal.sendText(
            `pkill -INT -f "tail -f.*${path.basename(logFile)}" 2>/dev/null; ` +
            `mkdir -p "$(dirname '${logFile}')" 2>/dev/null; ` +
            `clear; ` +
            `printf "\\n🔴 Streaming: ${logFile}\\n\\n"; ` +
            `touch "${logFile}" && tail -f "${logFile}"`
        );
        agentTerminal.terminal.show();
    }

    /**
     * Show header in terminal for the agent's task (writes to log file so it appears in tail)
     */
    showTaskHeader(agentName: string, taskId: string, taskDescription: string): void {
        // This is now handled by CursorAgentRunner writing header to log file
        // The terminal will see it via tail -f
    }

    /**
     * Show completion message (writes to log file so it appears in tail)
     */
    showTaskCompletion(agentName: string, success: boolean, message?: string): void {
        // This is now handled by CursorAgentRunner writing to log file
        // The terminal will see it via tail -f
    }

    /**
     * Send a command to an agent's terminal
     */
    sendCommand(agentName: string, command: string): boolean {
        const agentTerminal = this.agentTerminals.get(agentName);
        if (!agentTerminal || !this.isTerminalAlive(agentTerminal.terminal)) {
            return false;
        }

        agentTerminal.terminal.sendText(command);
        return true;
    }

    /**
     * Show an agent's terminal (create if needed) and start tailing log
     */
    showAgentTerminal(agentName: string): boolean {
        const agentTerminal = this.agentTerminals.get(agentName);
        
        if (agentTerminal && this.isTerminalAlive(agentTerminal.terminal)) {
            agentTerminal.terminal.show();
            // Ensure tailing is started if we have a log file
            if (agentTerminal.logFile) {
                // Kill existing tail, then restart - all in one command
                // Use mkdir -p to ensure directory exists
                agentTerminal.terminal.sendText(
                    `pkill -INT -f "tail -f.*${path.basename(agentTerminal.logFile)}" 2>/dev/null; ` +
                    `mkdir -p "$(dirname '${agentTerminal.logFile}')" 2>/dev/null; ` +
                    `printf "\\n📄 Streaming: ${agentTerminal.logFile}\\n\\n"; ` +
                    `touch "${agentTerminal.logFile}" && tail -f "${agentTerminal.logFile}"`
                );
            }
            return true;
        }

        // Terminal was closed but we have the info - recreate it
        if (agentTerminal) {
            const terminalName = `🔧 ${agentName}`;
            const terminal = vscode.window.createTerminal({
                name: terminalName,
                iconPath: new vscode.ThemeIcon('person'),
                message: `Agent ${agentName} - Reconnected | Session: ${agentTerminal.sessionId}`
            });

            this.agentTerminals.set(agentName, {
                ...agentTerminal,
                terminal
            });

            terminal.show();
            // Only tail if log file path exists
            // Use mkdir -p to ensure directory exists
            if (agentTerminal.logFile) {
                terminal.sendText(
                    `mkdir -p "$(dirname '${agentTerminal.logFile}')" 2>/dev/null; ` +
                    `printf "\\n📄 Reconnecting to: ${agentTerminal.logFile}\\n\\n"; ` +
                    `touch "${agentTerminal.logFile}" && tail -f "${agentTerminal.logFile}"`
                );
            }
            return true;
        }

        return false;
    }

    /**
     * Close an agent's terminal
     */
    closeAgentTerminal(agentName: string): void {
        const agentTerminal = this.agentTerminals.get(agentName);
        if (agentTerminal && this.isTerminalAlive(agentTerminal.terminal)) {
            agentTerminal.terminal.dispose();
        }
        this.agentTerminals.delete(agentName);
    }

    /**
     * Close all agent terminals
     */
    closeAllTerminals(): void {
        for (const [name, agentTerminal] of this.agentTerminals) {
            if (this.isTerminalAlive(agentTerminal.terminal)) {
                agentTerminal.terminal.dispose();
            }
        }
        this.agentTerminals.clear();
    }

    /**
     * Get info about an agent's terminal
     */
    getTerminalInfo(agentName: string): IAgentTerminalInfo | undefined {
        const info = this.agentTerminals.get(agentName);
        if (info) {
            return {
                name: info.name,
                sessionId: info.sessionId,
                logFile: info.logFile
            };
        }
        return undefined;
    }

    /**
     * Check if a terminal is still alive
     */
    private isTerminalAlive(terminal: vscode.Terminal): boolean {
        // Check if terminal is in the list of active terminals
        return vscode.window.terminals.includes(terminal);
    }

    /**
     * Get all active agent terminal names
     */
    getActiveTerminalNames(): string[] {
        const active: string[] = [];
        for (const [name, agentTerminal] of this.agentTerminals) {
            if (this.isTerminalAlive(agentTerminal.terminal)) {
                active.push(name);
            }
        }
        return active;
    }

    /**
     * Create a coordinator terminal for monitoring
     */
    createCoordinatorTerminal(
        coordinatorId: string, 
        logFile: string,
        workspaceRoot: string
    ): vscode.Terminal {
        // Check if terminal already exists
        const existing = this.coordinatorTerminals.get(coordinatorId);
        if (existing && this.isTerminalAlive(existing.terminal)) {
            existing.logFile = logFile; // Update in case it changed
            existing.terminal.show();
            return existing.terminal;
        }

        // Clean up dead terminal reference
        if (existing) {
            this.coordinatorTerminals.delete(coordinatorId);
        }

        const shortId = coordinatorId.replace('coord_', '').substring(0, 8);
        const terminal = vscode.window.createTerminal({
            name: `📋 Coordinator ${shortId}`,
            cwd: workspaceRoot,
            iconPath: new vscode.ThemeIcon('organization'),
            message: `Coordinator ${coordinatorId} - Real-time logs`
        });

        // Store terminal reference
        this.coordinatorTerminals.set(coordinatorId, {
            coordinatorId,
            terminal,
            logFile
        });

        // Show the terminal
        terminal.show(false);

        return terminal;
    }

    /**
     * Start tailing the coordinator's log file in their terminal
     */
    startCoordinatorLogTail(coordinatorId: string): void {
        const coordTerminal = this.coordinatorTerminals.get(coordinatorId);
        if (!coordTerminal) {
            console.warn(`No terminal found for coordinator: ${coordinatorId}`);
            return;
        }

        if (!this.isTerminalAlive(coordTerminal.terminal)) {
            console.warn(`Terminal for ${coordinatorId} is not alive`);
            return;
        }

        // Kill existing tail, show existing content, then start fresh tail - all in one command
        coordTerminal.terminal.sendText(
            `pkill -INT -f "tail -f.*${path.basename(coordTerminal.logFile)}" 2>/dev/null; ` +
            `cat "${coordTerminal.logFile}" 2>/dev/null; ` +
            `printf "\\n--- Live stream started ---\\n"; ` +
            `tail -f "${coordTerminal.logFile}"`
        );
    }

    /**
     * Close a coordinator's terminal
     */
    closeCoordinatorTerminal(coordinatorId: string): void {
        const coordTerminal = this.coordinatorTerminals.get(coordinatorId);
        if (coordTerminal && this.isTerminalAlive(coordTerminal.terminal)) {
            coordTerminal.terminal.dispose();
        }
        this.coordinatorTerminals.delete(coordinatorId);
    }

    /**
     * Show a coordinator's terminal (recreate if needed)
     */
    showCoordinatorTerminal(coordinatorId: string): boolean {
        const coordTerminal = this.coordinatorTerminals.get(coordinatorId);
        if (coordTerminal && this.isTerminalAlive(coordTerminal.terminal)) {
            coordTerminal.terminal.show();
            return true;
        }
        
        // Terminal was closed but we have the info - recreate it
        if (coordTerminal) {
            const shortId = coordinatorId.replace('coord_', '').substring(0, 8);
            const terminal = vscode.window.createTerminal({
                name: `📋 Coordinator ${shortId}`,
                iconPath: new vscode.ThemeIcon('organization'),
                message: `Coordinator ${coordinatorId} - Reconnected`
            });

            this.coordinatorTerminals.set(coordinatorId, {
                ...coordTerminal,
                terminal
            });

            terminal.show();
            if (coordTerminal.logFile) {
                terminal.sendText(
                    `mkdir -p "$(dirname '${coordTerminal.logFile}')" 2>/dev/null; ` +
                    `printf "\\n📄 Reconnecting to: ${coordTerminal.logFile}\\n\\n"; ` +
                    `touch "${coordTerminal.logFile}" && tail -f "${coordTerminal.logFile}"`
                );
            }
            return true;
        }
        
        return false;
    }
    
    /**
     * Clear all terminal references for a coordinator and its agents
     * Call this when stopping/resetting a coordinator
     */
    clearCoordinatorTerminals(coordinatorId: string, agentNames: string[]): void {
        // Close coordinator terminal
        this.closeCoordinatorTerminal(coordinatorId);
        
        // Close agent terminals
        for (const name of agentNames) {
            this.closeAgentTerminal(name);
        }
    }
    
    /**
     * Remove stale (dead) terminal references without closing active ones
     */
    cleanupStaleTerminals(): void {
        // Clean up stale agent terminals
        for (const [name, agentTerminal] of this.agentTerminals) {
            if (!this.isTerminalAlive(agentTerminal.terminal)) {
                console.log(`Cleaning up stale terminal reference for agent: ${name}`);
                this.agentTerminals.delete(name);
            }
        }
        
        // Clean up stale coordinator terminals
        for (const [id, coordTerminal] of this.coordinatorTerminals) {
            if (!this.isTerminalAlive(coordTerminal.terminal)) {
                console.log(`Cleaning up stale terminal reference for coordinator: ${id}`);
                this.coordinatorTerminals.delete(id);
            }
        }
    }

    dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.closeAllTerminals();
        
        // Close coordinator terminals
        for (const [id, coordTerminal] of this.coordinatorTerminals) {
            if (this.isTerminalAlive(coordTerminal.terminal)) {
                coordTerminal.terminal.dispose();
            }
        }
        this.coordinatorTerminals.clear();
    }
}










