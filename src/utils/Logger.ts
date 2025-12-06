/**
 * Logger.ts - Unified logging utility for APC
 * 
 * Provides consistent log formatting across daemon and client code.
 * Format: [Daemon|Client] [SystemName] [LEVEL] message
 */

export type LogContext = 'Daemon' | 'Client';
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/**
 * Logger instance for a specific context and system
 */
export class Logger {
    private readonly prefix: string;

    private constructor(context: LogContext, systemName: string) {
        this.prefix = `[${context}] [${systemName}]`;
    }

    /**
     * Create a logger for a specific context and system
     * @param context - 'Daemon' or 'Client' to identify where the log originates
     * @param systemName - Name of the system/module (e.g., 'AgentPoolService', 'Extension')
     */
    static create(context: LogContext, systemName: string): Logger {
        return new Logger(context, systemName);
    }

    /**
     * Log a debug message
     */
    debug(...args: unknown[]): void {
        console.log(`${this.prefix} [DEBUG]`, ...args);
    }

    /**
     * Log an info message
     */
    info(...args: unknown[]): void {
        console.log(`${this.prefix} [INFO]`, ...args);
    }

    /**
     * Log a warning message
     */
    warn(...args: unknown[]): void {
        console.warn(`${this.prefix} [WARN]`, ...args);
    }

    /**
     * Log an error message
     */
    error(...args: unknown[]): void {
        console.error(`${this.prefix} [ERROR]`, ...args);
    }
}

