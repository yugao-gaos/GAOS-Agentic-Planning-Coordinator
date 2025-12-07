import * as vscode from 'vscode';

/**
 * LogPseudoterminal - A VS Code pseudoterminal for displaying log output
 * 
 * This provides a clean way to stream log content to a terminal without
 * using shell commands like `echo`. Content is written directly to the
 * terminal output stream.
 * 
 * Benefits over echo-based approach:
 * - No shell command overhead
 * - Can handle high-volume streaming efficiently
 * - Clean ANSI color support
 * - No escaping issues
 */
export class LogPseudoterminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<void | number>();
    private nameChangeEmitter = new vscode.EventEmitter<string>();
    
    onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    onDidClose: vscode.Event<void | number> = this.closeEmitter.event;
    onDidChangeName: vscode.Event<string> = this.nameChangeEmitter.event;
    
    private dimensions: vscode.TerminalDimensions | undefined;
    private isOpen = false;
    private pendingWrites: string[] = [];
    
    constructor(
        private readonly name: string,
        private readonly initialMessage?: string
    ) {}
    
    /**
     * Called when the terminal is opened
     */
    open(initialDimensions: vscode.TerminalDimensions | undefined): void {
        this.dimensions = initialDimensions;
        this.isOpen = true;
        
        // Show initial message if provided
        if (this.initialMessage) {
            this.writeLine(this.initialMessage);
            this.writeLine('');
        }
        
        // Flush any pending writes that came before open
        for (const text of this.pendingWrites) {
            this.writeEmitter.fire(text);
        }
        this.pendingWrites = [];
    }
    
    /**
     * Called when the terminal is closed
     */
    close(): void {
        this.isOpen = false;
    }
    
    /**
     * Handle user input (optional - we're mostly read-only)
     * Could be used for commands like Ctrl+C to stop streaming
     */
    handleInput(data: string): void {
        // Ctrl+C = close terminal
        if (data === '\x03') {
            this.closeEmitter.fire();
        }
    }
    
    /**
     * Write raw text to the terminal (no newline added)
     */
    write(text: string): void {
        if (this.isOpen) {
            this.writeEmitter.fire(text);
        } else {
            // Queue writes that come before terminal is opened
            this.pendingWrites.push(text);
        }
    }
    
    /**
     * Write a line to the terminal (adds carriage return + newline)
     * Terminal needs \r\n for proper line handling
     */
    writeLine(text: string): void {
        this.write(text + '\r\n');
    }
    
    /**
     * Write multiple lines efficiently
     */
    writeLines(lines: string[]): void {
        // Batch all lines into a single write for efficiency
        const content = lines.map(line => line + '\r\n').join('');
        this.write(content);
    }
    
    /**
     * Write content that may contain newlines (converts \n to \r\n)
     */
    writeContent(content: string): void {
        // Convert Unix newlines to terminal newlines (\r\n)
        // But preserve any existing \r\n
        const converted = content
            .replace(/\r\n/g, '\n')  // Normalize to \n first
            .replace(/\n/g, '\r\n'); // Then convert all to \r\n
        this.write(converted);
    }
    
    /**
     * Clear the terminal screen
     */
    clear(): void {
        // ANSI escape sequence to clear screen and move cursor to top
        this.write('\x1b[2J\x1b[H');
    }
    
    /**
     * Change the terminal name
     */
    setName(name: string): void {
        this.nameChangeEmitter.fire(name);
    }
    
    /**
     * Get current terminal dimensions
     */
    getDimensions(): vscode.TerminalDimensions | undefined {
        return this.dimensions;
    }
    
    /**
     * Check if terminal is currently open
     */
    get opened(): boolean {
        return this.isOpen;
    }
    
    /**
     * Dispose resources
     */
    dispose(): void {
        this.writeEmitter.dispose();
        this.closeEmitter.dispose();
        this.nameChangeEmitter.dispose();
    }
}

