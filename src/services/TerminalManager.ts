import * as vscode from 'vscode';
import * as path from 'path';
import { EngineerTerminal } from '../types';

export class TerminalManager {
    private engineerTerminals: Map<string, EngineerTerminal> = new Map();
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
        const terminalName = `${engineerName}_${sessionId.substring(0, 8)}`;
        
        // Check if terminal already exists and is still valid
        const existing = this.engineerTerminals.get(engineerName);
        if (existing && this.isTerminalAlive(existing.terminal)) {
            existing.terminal.show();
            return existing.terminal;
        }

        // Create new terminal with custom name
        const terminal = vscode.window.createTerminal({
            name: terminalName,
            cwd: workspaceRoot,
            iconPath: new vscode.ThemeIcon('person'),
            message: `Engineer ${engineerName} - Session ${sessionId}`
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

        // Start tailing the log file
        engineerTerminal.terminal.sendText(`tail -f "${engineerTerminal.logFile}"`);
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
            const terminal = vscode.window.createTerminal({
                name: `${engineerName}_${engineerTerminal.sessionId.substring(0, 8)}`,
                iconPath: new vscode.ThemeIcon('person'),
                message: `Engineer ${engineerName} - Reconnected`
            });

            this.engineerTerminals.set(engineerName, {
                ...engineerTerminal,
                terminal
            });

            terminal.show();
            terminal.sendText(`tail -f "${engineerTerminal.logFile}"`);
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
    createCoordinatorTerminal(coordinatorId: string, workspaceRoot: string): vscode.Terminal {
        const terminal = vscode.window.createTerminal({
            name: `Coordinator_${coordinatorId}`,
            cwd: workspaceRoot,
            iconPath: new vscode.ThemeIcon('organization'),
            message: `Coordinator ${coordinatorId} - Monitoring`
        });

        return terminal;
    }

    dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.closeAllTerminals();
    }
}










