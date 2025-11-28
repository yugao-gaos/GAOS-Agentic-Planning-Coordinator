import * as vscode from 'vscode';
import * as path from 'path';
import { EngineerTerminal } from '../types';

interface CoordinatorTerminal {
    coordinatorId: string;
    terminal: vscode.Terminal;
    logFile: string;
}

export class TerminalManager {
    private engineerTerminals: Map<string, EngineerTerminal> = new Map();
    private coordinatorTerminals: Map<string, CoordinatorTerminal> = new Map();
    private engineerOutputChannels: Map<string, vscode.OutputChannel> = new Map();
    private disposables: vscode.Disposable[] = [];

    constructor() {
        // Listen for terminal close events
        this.disposables.push(
            vscode.window.onDidCloseTerminal(terminal => {
                // Find and remove the closed terminal from our map
                for (const [name, engineerTerminal] of this.engineerTerminals) {
                    if (engineerTerminal.terminal === terminal) {
                        // Don't remove from map - we want to track that the terminal was closed
                        // but the engineer process may still be running
                        console.log(`Terminal closed for engineer: ${name}`);
                        break;
                    }
                }
            })
        );
    }

    /**
     * Create a new terminal for an engineer session
     */
    createEngineerTerminal(
        engineerName: string,
        sessionId: string,
        logFile: string,
        workspaceRoot: string
    ): vscode.Terminal {
        const terminalName = `🔧 ${engineerName}`;
        
        // Check if terminal already exists and is still valid
        const existing = this.engineerTerminals.get(engineerName);
        if (existing && this.isTerminalAlive(existing.terminal)) {
            // Update the stored info in case sessionId/logFile changed
            existing.sessionId = sessionId;
            existing.logFile = logFile;
            existing.terminal.show();
            return existing.terminal;
        }
        
        // If existing terminal is dead, dispose it first
        if (existing) {
            this.engineerTerminals.delete(engineerName);
        }

        // Create new terminal with proper engineer name
        const terminal = vscode.window.createTerminal({
            name: terminalName,
            cwd: workspaceRoot,
            iconPath: new vscode.ThemeIcon('person'),
            message: `Engineer ${engineerName} | Session: ${sessionId}`
        });

        // Store terminal reference
        this.engineerTerminals.set(engineerName, {
            name: engineerName,
            sessionId,
            terminal,
            logFile
        });

        // Show the terminal
        const config = vscode.workspace.getConfiguration('agenticPlanning');
        if (config.get<boolean>('autoOpenTerminals', true)) {
            terminal.show(false); // false = don't take focus
        }

        return terminal;
    }

    /**
     * Start tailing the engineer's log file in their terminal
     */
    startLogTail(engineerName: string): void {
        const engineerTerminal = this.engineerTerminals.get(engineerName);
        if (!engineerTerminal) {
            console.warn(`No terminal found for engineer: ${engineerName}`);
            return;
        }

        if (!this.isTerminalAlive(engineerTerminal.terminal)) {
            console.warn(`Terminal for ${engineerName} is not alive`);
            return;
        }

        // Ensure log file exists, show current content, then start tailing
        engineerTerminal.terminal.sendText(`touch "${engineerTerminal.logFile}" && cat "${engineerTerminal.logFile}" 2>/dev/null; echo "--- Live stream started ---"; tail -f "${engineerTerminal.logFile}"`);
    }
    
    /**
     * Append text to an engineer's terminal is now a no-op since we use tail -f on log file.
     * The CursorAgentRunner writes directly to the log file which the terminal tails.
     */
    appendToTerminal(engineerName: string, text: string, type: 'text' | 'thinking' | 'tool' | 'tool_result' | 'error' | 'info'): void {
        // No-op: output goes to log file which terminal tails via startStreamingLog()
    }

    /**
     * Start streaming the log file in terminal with tail -f
     * This shows live output as CursorAgentRunner writes to the log
     */
    startStreamingLog(engineerName: string, logFile: string): void {
        const engineerTerminal = this.engineerTerminals.get(engineerName);
        if (!engineerTerminal || !this.isTerminalAlive(engineerTerminal.terminal)) {
            console.warn(`No terminal found for engineer: ${engineerName}`);
            return;
        }

        // Clear terminal and start tailing the log file
        engineerTerminal.terminal.sendText('clear');
        engineerTerminal.terminal.sendText(`echo "🔴 Live streaming output from: ${logFile}"`);
        engineerTerminal.terminal.sendText(`echo ""`);
        // Touch to create file if it doesn't exist, then tail with -f for continuous streaming
        engineerTerminal.terminal.sendText(`touch "${logFile}" && tail -f "${logFile}"`);
        engineerTerminal.terminal.show();
    }

    /**
     * Show header in terminal for the engineer's task (writes to log file so it appears in tail)
     */
    showTaskHeader(engineerName: string, taskId: string, taskDescription: string): void {
        // This is now handled by CursorAgentRunner writing header to log file
        // The terminal will see it via tail -f
    }

    /**
     * Show completion message (writes to log file so it appears in tail)
     */
    showTaskCompletion(engineerName: string, success: boolean, message?: string): void {
        // This is now handled by CursorAgentRunner writing to log file
        // The terminal will see it via tail -f
    }

    /**
     * Send a command to an engineer's terminal
     */
    sendCommand(engineerName: string, command: string): boolean {
        const engineerTerminal = this.engineerTerminals.get(engineerName);
        if (!engineerTerminal || !this.isTerminalAlive(engineerTerminal.terminal)) {
            return false;
        }

        engineerTerminal.terminal.sendText(command);
        return true;
    }

    /**
     * Show an engineer's terminal (create if needed)
     */
    showEngineerTerminal(engineerName: string): boolean {
        const engineerTerminal = this.engineerTerminals.get(engineerName);
        
        if (engineerTerminal && this.isTerminalAlive(engineerTerminal.terminal)) {
            engineerTerminal.terminal.show();
            return true;
        }

        // Terminal was closed but we have the info - recreate it
        if (engineerTerminal) {
            const terminalName = `🔧 ${engineerName}`;
            const terminal = vscode.window.createTerminal({
                name: terminalName,
                iconPath: new vscode.ThemeIcon('person'),
                message: `Engineer ${engineerName} - Reconnected | Session: ${engineerTerminal.sessionId}`
            });

            this.engineerTerminals.set(engineerName, {
                ...engineerTerminal,
                terminal
            });

            terminal.show();
            // Only tail if log file path exists
            if (engineerTerminal.logFile) {
                terminal.sendText(`echo "📄 Reconnecting to log file..."`);
                terminal.sendText(`tail -f "${engineerTerminal.logFile}"`);
            }
            return true;
        }

        return false;
    }

    /**
     * Close an engineer's terminal
     */
    closeEngineerTerminal(engineerName: string): void {
        const engineerTerminal = this.engineerTerminals.get(engineerName);
        if (engineerTerminal && this.isTerminalAlive(engineerTerminal.terminal)) {
            engineerTerminal.terminal.dispose();
        }
        this.engineerTerminals.delete(engineerName);
    }

    /**
     * Close all engineer terminals
     */
    closeAllTerminals(): void {
        for (const [name, engineerTerminal] of this.engineerTerminals) {
            if (this.isTerminalAlive(engineerTerminal.terminal)) {
                engineerTerminal.terminal.dispose();
            }
        }
        this.engineerTerminals.clear();
    }

    /**
     * Get info about an engineer's terminal
     */
    getTerminalInfo(engineerName: string): EngineerTerminal | undefined {
        return this.engineerTerminals.get(engineerName);
    }

    /**
     * Check if a terminal is still alive
     */
    private isTerminalAlive(terminal: vscode.Terminal): boolean {
        // Check if terminal is in the list of active terminals
        return vscode.window.terminals.includes(terminal);
    }

    /**
     * Get all active engineer terminal names
     */
    getActiveTerminalNames(): string[] {
        const active: string[] = [];
        for (const [name, engineerTerminal] of this.engineerTerminals) {
            if (this.isTerminalAlive(engineerTerminal.terminal)) {
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

        // Ensure log file exists, show existing content, then tail
        // Use touch to create if missing, cat to show existing, then tail -f
        coordTerminal.terminal.sendText(`touch "${coordTerminal.logFile}" && cat "${coordTerminal.logFile}" 2>/dev/null; echo "--- Live stream started ---"; tail -f "${coordTerminal.logFile}"`);
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
                terminal.sendText(`echo "📄 Reconnecting to coordinator log..."`);
                terminal.sendText(`tail -f "${coordTerminal.logFile}"`);
            }
            return true;
        }
        
        return false;
    }
    
    /**
     * Clear all terminal references for a coordinator and its engineers
     * Call this when stopping/resetting a coordinator
     */
    clearCoordinatorTerminals(coordinatorId: string, engineerNames: string[]): void {
        // Close coordinator terminal
        this.closeCoordinatorTerminal(coordinatorId);
        
        // Close engineer terminals
        for (const name of engineerNames) {
            this.closeEngineerTerminal(name);
        }
    }
    
    /**
     * Remove stale (dead) terminal references without closing active ones
     */
    cleanupStaleTerminals(): void {
        // Clean up stale engineer terminals
        for (const [name, engineerTerminal] of this.engineerTerminals) {
            if (!this.isTerminalAlive(engineerTerminal.terminal)) {
                console.log(`Cleaning up stale terminal reference for engineer: ${name}`);
                this.engineerTerminals.delete(name);
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










