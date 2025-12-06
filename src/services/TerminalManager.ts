import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AgentTerminal } from '../types';
import { ITerminalManager, IAgentTerminalInfo } from './ITerminalManager';
import { getLogStreamService, disposeLogStreamService, LogStreamService } from './LogStreamService';
import { Logger } from '../utils/Logger';

const log = Logger.create('Client', 'TerminalManager');

interface CoordinatorTerminal {
    coordinatorId: string;
    terminal: vscode.Terminal;
    logFile: string;
}

/**
 * Config provider function type for getting daemon config values
 */
export type ConfigProvider = () => Promise<{ autoOpenTerminals?: boolean }>;

/**
 * VS Code Terminal Manager - Creates terminals that tail log files
 * 
 * This is the VS Code-specific implementation of ITerminalManager.
 * For headless/daemon mode, use HeadlessTerminalManager instead.
 * 
 * Cross-platform: Uses Node.js LogStreamService for file streaming
 * instead of Unix-specific tail -f commands.
 */
export class TerminalManager implements ITerminalManager {
    private agentTerminals: Map<string, AgentTerminal> = new Map();
    private coordinatorTerminals: Map<string, CoordinatorTerminal> = new Map();
    private agentOutputChannels: Map<string, vscode.OutputChannel> = new Map();
    private disposables: vscode.Disposable[] = [];
    private logStreamService: LogStreamService;
    private configProvider: ConfigProvider | null = null;
    
    // Cached config values (updated when provider is set or refreshConfig is called)
    private cachedConfig: { autoOpenTerminals: boolean } = { autoOpenTerminals: true };
    
    // Debounce map to prevent duplicate streaming commands (agentName -> timestamp)
    private lastStreamingStart: Map<string, number> = new Map();
    private static readonly STREAMING_DEBOUNCE_MS = 2000; // 2 seconds

    constructor() {
        this.logStreamService = getLogStreamService();
        // Listen for terminal close events
        this.disposables.push(
            vscode.window.onDidCloseTerminal(terminal => {
                // Find and remove the closed terminal from our map
                for (const [name, agentTerminal] of this.agentTerminals) {
                    if (agentTerminal.terminal === terminal) {
                        // Don't remove from map - we want to track that the terminal was closed
                        // but the agent process may still be running
                        log.debug(`Terminal closed for agent: ${name}`);
                        break;
                    }
                }
            })
        );
    }

    /**
     * Set the config provider for getting daemon config values.
     * This should be called once the VsCodeClient is connected.
     * Automatically refreshes cached config values.
     */
    setConfigProvider(provider: ConfigProvider): void {
        this.configProvider = provider;
        this.refreshConfig();
    }

    /**
     * Refresh cached config values from daemon.
     * Call this when daemon config changes.
     */
    async refreshConfig(): Promise<void> {
        if (this.configProvider) {
            try {
                const config = await this.configProvider();
                this.cachedConfig.autoOpenTerminals = config.autoOpenTerminals ?? true;
            } catch {
                // Keep existing cached values on error
            }
        }
    }

    /**
     * Get whether terminals should auto-open.
     * Uses cached daemon config, falls back to VS Code settings.
     */
    private shouldAutoOpenTerminals(): boolean {
        // If we have a daemon config provider, use cached value
        if (this.configProvider) {
            return this.cachedConfig.autoOpenTerminals;
        }
        // Fall back to VS Code settings (for backwards compatibility during startup)
        const config = vscode.workspace.getConfiguration('agenticPlanning');
        return config.get<boolean>('autoOpenTerminals', true);
    }

    /**
     * Ensure directory exists for a file path (cross-platform)
     */
    private ensureDirectoryExists(filePath: string): void {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    /**
     * Ensure file exists (create if not exists, cross-platform)
     */
    private ensureFileExists(filePath: string): void {
        this.ensureDirectoryExists(filePath);
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, '');
        }
    }

    /**
     * Start streaming a log file to a terminal using Node.js (cross-platform)
     */
    private startLogStreaming(terminal: vscode.Terminal, logFile: string, agentName: string): void {
        // Stop any existing stream for this file
        this.logStreamService.stopStreaming(logFile);
        
        // Ensure the log file and directory exist
        this.ensureFileExists(logFile);
        
        // Show header in terminal
        terminal.sendText(`echo ""`);
        terminal.sendText(`echo "🔴 Streaming: ${logFile}"`);
        terminal.sendText(`echo ""`);
        
        // Start streaming with the LogStreamService
        this.logStreamService.startStreaming(logFile, (content) => {
            // Send each chunk to the terminal
            // Split by lines and send each line to avoid issues with large chunks
            const lines = content.split('\n');
            for (const line of lines) {
                if (line) {
                    // Use echo to display the content in the terminal
                    // Escape special characters for shell safety
                    const escaped = this.escapeForTerminal(line);
                    terminal.sendText(`echo "${escaped}"`, true);
                }
            }
        }, false); // Don't show existing content on start
    }

    /**
     * Escape a string for safe echo in terminal (cross-platform)
     */
    private escapeForTerminal(text: string): string {
        // Escape backslashes, double quotes, and dollar signs
        return text
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\$/g, '\\$')
            .replace(/`/g, '\\`');
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
        log.debug(`createAgentTerminal called for ${agentName} at ${now}`);
        const logFileName = logFile ? path.basename(logFile) : 'none';
        log.debug(`  sessionId=${sessionId}, logFile=${logFileName}`);
        
        // Debounce: skip if we recently started streaming for this agent
        const lastStart = this.lastStreamingStart.get(agentName);
        if (lastStart && (now - lastStart) < TerminalManager.STREAMING_DEBOUNCE_MS) {
            log.debug(`DEBOUNCE: Skipping duplicate for ${agentName} (last: ${now - lastStart}ms ago)`);
            const existing = this.agentTerminals.get(agentName);
            if (existing && this.isTerminalAlive(existing.terminal)) {
                return existing.terminal;
            }
            log.debug(`DEBOUNCE: But terminal not alive, will recreate`);
        }
        
        // Check if terminal already exists and is still valid
        const existing = this.agentTerminals.get(agentName);
        const terminalAlive = existing ? this.isTerminalAlive(existing.terminal) : false;
        log.debug(`  existing=${!!existing}, isAlive=${terminalAlive}, window.terminals.length=${vscode.window.terminals.length}`);
        
        if (existing && terminalAlive) {
            log.debug(`  REUSING existing terminal for ${agentName}`);
            // Update the stored info in case sessionId/logFile changed
            existing.sessionId = sessionId;
            existing.logFile = logFile;
            existing.terminal.show();
            
            // Restart streaming with the new log file (cross-platform)
            if (logFile) {
                this.lastStreamingStart.set(agentName, now);
                this.startLogStreaming(existing.terminal, logFile, agentName);
            }
            return existing.terminal;
        }

        // If existing terminal is dead, dispose it first
        if (existing) {
            log.debug(`  Cleaning up dead terminal reference for ${agentName}`);
            // Stop any streaming for the old log file
            if (existing.logFile) {
                this.logStreamService.stopStreaming(existing.logFile);
            }
            this.agentTerminals.delete(agentName);
        }

        log.debug(`  CREATING new terminal for ${agentName}`);
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

        // Show the terminal if autoOpenTerminals is enabled
        if (this.shouldAutoOpenTerminals()) {
            terminal.show(false); // false = don't take focus
        }

        // Start streaming the log file immediately if provided (cross-platform)
        if (logFile) {
            this.lastStreamingStart.set(agentName, Date.now());
            this.startLogStreaming(terminal, logFile, agentName);
        }

        return terminal;
    }

    /**
     * Start tailing the agent's log file in their terminal
     */
    startLogTail(agentName: string): void {
        const agentTerminal = this.agentTerminals.get(agentName);
        if (!agentTerminal) {
            log.warn(`No terminal found for agent: ${agentName}`);
            return;
        }

        if (!this.isTerminalAlive(agentTerminal.terminal)) {
            log.warn(`Terminal for ${agentName} is not alive`);
            return;
        }

        // Stop any existing stream and start fresh (cross-platform)
        if (agentTerminal.logFile) {
            this.logStreamService.stopStreaming(agentTerminal.logFile);
            
            // Show existing content first
            if (fs.existsSync(agentTerminal.logFile)) {
                try {
                    const content = fs.readFileSync(agentTerminal.logFile, 'utf-8');
                    if (content) {
                        agentTerminal.terminal.sendText(`echo "--- Existing log content ---"`);
                        const lines = content.split('\n');
                        for (const line of lines) {
                            if (line) {
                                const escaped = this.escapeForTerminal(line);
                                agentTerminal.terminal.sendText(`echo "${escaped}"`, true);
                            }
                        }
                    }
                } catch (e) {
                    // Ignore read errors
                }
            }
            
            agentTerminal.terminal.sendText(`echo "--- Live stream started ---"`);
            this.startLogStreaming(agentTerminal.terminal, agentTerminal.logFile, agentName);
        }
    }
    
    /**
     * Append text to an agent's terminal is now a no-op since we use tail -f on log file.
     * The CursorAgentRunner writes directly to the log file which the terminal tails.
     */
    appendToTerminal(agentName: string, text: string, type: 'text' | 'thinking' | 'tool' | 'tool_result' | 'error' | 'info'): void {
        // No-op: output goes to log file which terminal tails via startStreamingLog()
    }

    /**
     * Start streaming the log file in terminal
     * This shows live output as CursorAgentRunner writes to the log
     * Cross-platform implementation using Node.js LogStreamService
     */
    startStreamingLog(agentName: string, logFile: string): void {
        const agentTerminal = this.agentTerminals.get(agentName);
        if (!agentTerminal || !this.isTerminalAlive(agentTerminal.terminal)) {
            log.warn(`No terminal found for agent: ${agentName}`);
            return;
        }

        // Stop any existing stream for this file
        this.logStreamService.stopStreaming(logFile);
        
        // Clear terminal and start streaming (cross-platform)
        agentTerminal.terminal.sendText('clear || cls');
        this.startLogStreaming(agentTerminal.terminal, logFile, agentName);
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
            // Ensure streaming is started if we have a log file (cross-platform)
            if (agentTerminal.logFile) {
                this.startLogStreaming(agentTerminal.terminal, agentTerminal.logFile, agentName);
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

            // Stop any existing stream for old log file
            if (agentTerminal.logFile) {
                this.logStreamService.stopStreaming(agentTerminal.logFile);
            }

            this.agentTerminals.set(agentName, {
                ...agentTerminal,
                terminal
            });

            terminal.show();
            
            // Start streaming if log file path exists (cross-platform)
            if (agentTerminal.logFile) {
                terminal.sendText(`echo "📄 Reconnecting to: ${agentTerminal.logFile}"`);
                terminal.sendText(`echo ""`);
                this.startLogStreaming(terminal, agentTerminal.logFile, agentName);
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
        if (agentTerminal) {
            // Stop streaming for this log file
            if (agentTerminal.logFile) {
                this.logStreamService.stopStreaming(agentTerminal.logFile);
            }
            if (this.isTerminalAlive(agentTerminal.terminal)) {
                agentTerminal.terminal.dispose();
            }
        }
        this.agentTerminals.delete(agentName);
    }

    /**
     * Close all agent terminals
     */
    closeAllTerminals(): void {
        for (const [name, agentTerminal] of this.agentTerminals) {
            // Stop streaming for this log file
            if (agentTerminal.logFile) {
                this.logStreamService.stopStreaming(agentTerminal.logFile);
            }
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
            log.warn(`No terminal found for coordinator: ${coordinatorId}`);
            return;
        }

        if (!this.isTerminalAlive(coordTerminal.terminal)) {
            log.warn(`Terminal for ${coordinatorId} is not alive`);
            return;
        }

        // Stop any existing stream and start fresh (cross-platform)
        if (coordTerminal.logFile) {
            this.logStreamService.stopStreaming(coordTerminal.logFile);
            
            // Show existing content first
            if (fs.existsSync(coordTerminal.logFile)) {
                try {
                    const content = fs.readFileSync(coordTerminal.logFile, 'utf-8');
                    if (content) {
                        const lines = content.split('\n');
                        for (const line of lines) {
                            if (line) {
                                const escaped = this.escapeForTerminal(line);
                                coordTerminal.terminal.sendText(`echo "${escaped}"`, true);
                            }
                        }
                    }
                } catch (e) {
                    // Ignore read errors
                }
            }
            
            coordTerminal.terminal.sendText(`echo "--- Live stream started ---"`);
            this.startLogStreaming(coordTerminal.terminal, coordTerminal.logFile, coordinatorId);
        }
    }

    /**
     * Close a coordinator's terminal
     */
    closeCoordinatorTerminal(coordinatorId: string): void {
        const coordTerminal = this.coordinatorTerminals.get(coordinatorId);
        if (coordTerminal) {
            // Stop streaming for this log file
            if (coordTerminal.logFile) {
                this.logStreamService.stopStreaming(coordTerminal.logFile);
            }
            if (this.isTerminalAlive(coordTerminal.terminal)) {
                coordTerminal.terminal.dispose();
            }
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

            // Stop any existing stream for old log file
            if (coordTerminal.logFile) {
                this.logStreamService.stopStreaming(coordTerminal.logFile);
            }

            this.coordinatorTerminals.set(coordinatorId, {
                ...coordTerminal,
                terminal
            });

            terminal.show();
            
            // Start streaming if log file path exists (cross-platform)
            if (coordTerminal.logFile) {
                terminal.sendText(`echo "📄 Reconnecting to: ${coordTerminal.logFile}"`);
                terminal.sendText(`echo ""`);
                this.startLogStreaming(terminal, coordTerminal.logFile, coordinatorId);
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
                log.debug(`Cleaning up stale terminal reference for agent: ${name}`);
                this.agentTerminals.delete(name);
            }
        }
        
        // Clean up stale coordinator terminals
        for (const [id, coordTerminal] of this.coordinatorTerminals) {
            if (!this.isTerminalAlive(coordTerminal.terminal)) {
                log.debug(`Cleaning up stale terminal reference for coordinator: ${id}`);
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
            // Stop streaming for this log file
            if (coordTerminal.logFile) {
                this.logStreamService.stopStreaming(coordTerminal.logFile);
            }
            if (this.isTerminalAlive(coordTerminal.terminal)) {
                coordTerminal.terminal.dispose();
            }
        }
        this.coordinatorTerminals.clear();
        
        // Dispose the log stream service
        disposeLogStreamService();
    }
}










