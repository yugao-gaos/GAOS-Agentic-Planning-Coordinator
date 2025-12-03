import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

/**
 * Output target types
 */
export type OutputTarget = 'console' | 'file' | 'both';

/**
 * Log entry for event subscribers
 */
export interface LogEntry {
    timestamp: string;
    source: string;
    message: string;
    level: 'info' | 'warn' | 'error' | 'debug';
}

/**
 * OutputChannelManager - Unified logging for APC
 * 
 * In daemon mode: Logs to file and emits events
 * In VS Code mode: Also logs to vscode.OutputChannel
 * 
 * VS Code integration is optional - the manager works without it.
 * 
 * Obtain via ServiceLocator:
 *   const manager = ServiceLocator.resolve(OutputChannelManager);
 */
export class OutputChannelManager extends EventEmitter {
    private logFilePath: string | null = null;
    private outputTarget: OutputTarget = 'console';
    
    // Optional VS Code channel - set by VS Code extension
    private vscodeChannel: any = null;

    constructor() {
        super();
    }
    
    /**
     * Configure log file path
     */
    setLogFile(logPath: string): void {
        this.logFilePath = logPath;
        // Ensure directory exists
        const dir = path.dirname(logPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
    
    /**
     * Set output target
     */
    setOutputTarget(target: OutputTarget): void {
        this.outputTarget = target;
    }
    
    /**
     * Set VS Code output channel (called by VS Code extension)
     * This makes the manager VS Code aware without a direct import
     */
    setVsCodeChannel(channel: any): void {
        this.vscodeChannel = channel;
    }

    /**
     * Log a message with timestamp and source tag
     */
    log(source: string, message: string, level: 'info' | 'warn' | 'error' | 'debug' = 'info'): void {
        const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
        const formattedMessage = `[${timestamp}] [${source}] ${message}`;
        
        // Emit event for subscribers (daemon -> clients)
        const entry: LogEntry = { timestamp, source, message, level };
        this.emit('log', entry);
        
        // Console output
        if (this.outputTarget === 'console' || this.outputTarget === 'both') {
            if (level === 'error') {
                console.error(formattedMessage);
            } else if (level === 'warn') {
                console.warn(formattedMessage);
            } else {
                console.log(formattedMessage);
            }
        }
        
        // File output
        if ((this.outputTarget === 'file' || this.outputTarget === 'both') && this.logFilePath) {
            try {
                fs.appendFileSync(this.logFilePath, formattedMessage + '\n', 'utf8');
            } catch (e) {
                // Silently ignore file write errors
            }
        }
        
        // VS Code output channel (if available)
        if (this.vscodeChannel) {
            this.vscodeChannel.appendLine(formattedMessage);
        }
    }

    /**
     * Append a line directly (without timestamp - for formatted output)
     */
    appendLine(message: string): void {
        this.emit('log', { timestamp: '', source: '', message, level: 'info' });
        
        if (this.outputTarget === 'console' || this.outputTarget === 'both') {
            console.log(message);
        }
        
        if ((this.outputTarget === 'file' || this.outputTarget === 'both') && this.logFilePath) {
            try {
                fs.appendFileSync(this.logFilePath, message + '\n', 'utf8');
            } catch (e) {
                // Silently ignore
            }
        }
        
        if (this.vscodeChannel) {
            this.vscodeChannel.appendLine(message);
        }
    }

    /**
     * Log without timestamp (for headers, etc.)
     */
    logRaw(message: string): void {
        this.appendLine(message);
    }

    /**
     * Clear the output channel
     */
    clear(): void {
        if (this.logFilePath && fs.existsSync(this.logFilePath)) {
            try {
                fs.writeFileSync(this.logFilePath, '');
            } catch (e) {
                // Silently ignore
            }
        }
        
        if (this.vscodeChannel) {
            this.vscodeChannel.clear();
        }
    }

    /**
     * Show the output channel (VS Code only)
     */
    show(preserveFocus: boolean = true): void {
        if (this.vscodeChannel) {
            this.vscodeChannel.show(preserveFocus);
        }
    }

    /**
     * Log a section header
     */
    logHeader(title: string): void {
        this.appendLine('');
        this.appendLine(`════════════════════════════════════════════════════════════`);
        this.appendLine(`  ${title}`);
        this.appendLine(`════════════════════════════════════════════════════════════`);
        this.appendLine('');
    }

    /**
     * Log a sub-section divider
     */
    logDivider(): void {
        this.appendLine(`────────────────────────────────────────────────────────────`);
    }
    
    /**
     * Get channel for VS Code compatibility
     * Returns undefined if VS Code channel not set
     */
    getChannel(): any | undefined {
        return this.vscodeChannel;
    }
    
    /**
     * Dispose the output channel manager
     */
    dispose(): void {
        this.removeAllListeners();
    }
}
