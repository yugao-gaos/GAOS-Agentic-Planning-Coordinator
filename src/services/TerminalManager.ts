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

        // Create new terminal with session ID as name
        const terminal = vscode.window.createTerminal({
            name: sessionId,
            cwd: workspaceRoot,
            iconPath: new vscode.ThemeIcon('person'),
            message: `Engineer ${engineerName}`
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
     * Run cursor agent directly in the terminal with streaming output
     * @param promptFile Path to a file containing the prompt (avoids shell escaping issues)
     */
    runCursorAgent(engineerName: string, promptFile: string, logFile: string): boolean {
        const engineerTerminal = this.engineerTerminals.get(engineerName);
        if (!engineerTerminal || !this.isTerminalAlive(engineerTerminal.terminal)) {
            return false;
        }

        // Run cursor agent with streaming JSON output, parsed and written to log
        // This mimics what run_engineer.sh does for consistent output format
        const command = `cursor agent --model sonnet-4.5 -p --force --approve-mcps --output-format stream-json --stream-partial-output "$(cat '${promptFile}')" 2>&1 | while IFS= read -r line; do content=$(echo "$line" | jq -r '.message.content[0].text // empty' 2>/dev/null); [ -n "$content" ] && [ "$content" != "null" ] && printf "%s" "$content"; done | tee -a "${logFile}"`;
        
        engineerTerminal.terminal.sendText(command);
        return true;
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
                name: engineerTerminal.sessionId,
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
    createCoordinatorTerminal(
        coordinatorId: string, 
        logFile: string,
        workspaceRoot: string
    ): vscode.Terminal {
        // Check if terminal already exists
        const existing = this.coordinatorTerminals.get(coordinatorId);
        if (existing && this.isTerminalAlive(existing.terminal)) {
            existing.terminal.show();
            return existing.terminal;
        }

        const terminal = vscode.window.createTerminal({
            name: coordinatorId,
            cwd: workspaceRoot,
            iconPath: new vscode.ThemeIcon('organization'),
            message: `Coordinator - Real-time logs`
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
     * Show a coordinator's terminal
     */
    showCoordinatorTerminal(coordinatorId: string): boolean {
        const coordTerminal = this.coordinatorTerminals.get(coordinatorId);
        if (coordTerminal && this.isTerminalAlive(coordTerminal.terminal)) {
            coordTerminal.terminal.show();
            return true;
        }
        return false;
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










