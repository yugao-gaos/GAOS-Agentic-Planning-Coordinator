import * as vscode from 'vscode';

/**
 * Singleton output channel manager to unify all APC output into a single channel
 */
export class OutputChannelManager {
    private static instance: OutputChannelManager;
    private outputChannel: vscode.OutputChannel;

    private constructor() {
        this.outputChannel = vscode.window.createOutputChannel('APC');
    }

    static getInstance(): OutputChannelManager {
        if (!OutputChannelManager.instance) {
            OutputChannelManager.instance = new OutputChannelManager();
        }
        return OutputChannelManager.instance;
    }

    /**
     * Get the unified output channel
     */
    getChannel(): vscode.OutputChannel {
        return this.outputChannel;
    }

    /**
     * Log a message with timestamp and source tag
     */
    log(source: string, message: string): void {
        const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
        this.outputChannel.appendLine(`[${timestamp}] [${source}] ${message}`);
    }

    /**
     * Append a line directly (without timestamp - for formatted output)
     */
    appendLine(message: string): void {
        this.outputChannel.appendLine(message);
    }

    /**
     * Log without timestamp (for headers, etc.)
     */
    logRaw(message: string): void {
        this.outputChannel.appendLine(message);
    }

    /**
     * Clear the output channel
     */
    clear(): void {
        this.outputChannel.clear();
    }

    /**
     * Show the output channel
     */
    show(preserveFocus: boolean = true): void {
        this.outputChannel.show(preserveFocus);
    }

    /**
     * Log a section header
     */
    logHeader(title: string): void {
        this.outputChannel.appendLine('');
        this.outputChannel.appendLine(`════════════════════════════════════════════════════════════`);
        this.outputChannel.appendLine(`  ${title}`);
        this.outputChannel.appendLine(`════════════════════════════════════════════════════════════`);
        this.outputChannel.appendLine('');
    }

    /**
     * Log a sub-section divider
     */
    logDivider(): void {
        this.outputChannel.appendLine(`────────────────────────────────────────────────────────────`);
    }
}

