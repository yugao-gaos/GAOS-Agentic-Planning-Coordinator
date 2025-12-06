import * as fs from 'fs';
import * as path from 'path';

/**
 * Callback type for log output
 */
export type LogOutputCallback = (text: string) => void;

/**
 * Active stream tracking
 */
interface ActiveStream {
    logFile: string;
    watcher: fs.FSWatcher | null;
    pollInterval: NodeJS.Timeout | null;
    lastPosition: number;
    lastSize: number;
    callback: LogOutputCallback;
    fd: number | null;
}

/**
 * LogStreamService - Cross-platform log file streaming
 * 
 * Uses Node.js fs.watch() with fallback to polling for reliable
 * cross-platform file watching. Works on Windows, macOS, and Linux.
 * 
 * Replaces Unix-specific `tail -f` commands with pure Node.js implementation.
 */
export class LogStreamService {
    private activeStreams: Map<string, ActiveStream> = new Map();
    
    // Polling interval for fallback mode (ms)
    private static readonly POLL_INTERVAL_MS = 500;
    
    // Chunk size for reading (64KB)
    private static readonly READ_CHUNK_SIZE = 64 * 1024;

    /**
     * Start streaming a log file
     * 
     * @param logFile Path to the log file to stream
     * @param callback Function to call with new log content
     * @param showExisting If true, show existing content before streaming new content
     * @returns true if streaming started successfully
     */
    startStreaming(
        logFile: string, 
        callback: LogOutputCallback,
        showExisting: boolean = false
    ): boolean {
        // Normalize path for consistent key
        const normalizedPath = path.resolve(logFile);
        
        // Stop existing stream for this file if any
        this.stopStreaming(normalizedPath);
        
        // Ensure directory exists
        const dir = path.dirname(normalizedPath);
        if (!fs.existsSync(dir)) {
            try {
                fs.mkdirSync(dir, { recursive: true });
            } catch (e) {
                console.error(`[LogStreamService] Failed to create directory ${dir}:`, e);
                return false;
            }
        }
        
        // Create file if it doesn't exist
        if (!fs.existsSync(normalizedPath)) {
            try {
                fs.writeFileSync(normalizedPath, '');
            } catch (e) {
                console.error(`[LogStreamService] Failed to create log file ${normalizedPath}:`, e);
                return false;
            }
        }
        
        // Get initial file stats
        let initialSize = 0;
        try {
            const stats = fs.statSync(normalizedPath);
            initialSize = stats.size;
        } catch (e) {
            // File may have just been created, use 0
        }
        
        // Create stream entry
        const stream: ActiveStream = {
            logFile: normalizedPath,
            watcher: null,
            pollInterval: null,
            lastPosition: showExisting ? 0 : initialSize,
            lastSize: initialSize,
            callback,
            fd: null
        };
        
        this.activeStreams.set(normalizedPath, stream);
        
        // Show existing content if requested
        if (showExisting && initialSize > 0) {
            this.readAndSendContent(stream);
        }
        
        // Try to use fs.watch() first (more efficient)
        try {
            stream.watcher = fs.watch(normalizedPath, (eventType) => {
                if (eventType === 'change') {
                    this.readAndSendContent(stream);
                }
            });
            
            stream.watcher.on('error', (err) => {
                console.warn(`[LogStreamService] fs.watch error for ${normalizedPath}, falling back to polling:`, err);
                this.fallbackToPolling(stream);
            });
            
            // On some platforms (especially Windows network drives), fs.watch may not
            // reliably detect all changes. Use hybrid approach with less frequent polling.
            stream.pollInterval = setInterval(() => {
                this.checkForChanges(stream);
            }, LogStreamService.POLL_INTERVAL_MS * 2);
            
        } catch (e) {
            console.warn(`[LogStreamService] fs.watch failed for ${normalizedPath}, using polling:`, e);
            this.fallbackToPolling(stream);
        }
        
        return true;
    }

    /**
     * Stop streaming a log file
     */
    stopStreaming(logFile: string): void {
        const normalizedPath = path.resolve(logFile);
        const stream = this.activeStreams.get(normalizedPath);
        
        if (!stream) {
            return;
        }
        
        // Close watcher
        if (stream.watcher) {
            try {
                stream.watcher.close();
            } catch (e) {
                // Ignore close errors
            }
        }
        
        // Clear polling interval
        if (stream.pollInterval) {
            clearInterval(stream.pollInterval);
        }
        
        // Close file descriptor if open
        if (stream.fd !== null) {
            try {
                fs.closeSync(stream.fd);
            } catch (e) {
                // Ignore close errors
            }
        }
        
        this.activeStreams.delete(normalizedPath);
    }

    /**
     * Stop all active streams
     */
    stopAll(): void {
        for (const logFile of this.activeStreams.keys()) {
            this.stopStreaming(logFile);
        }
    }

    /**
     * Check if a file is currently being streamed
     */
    isStreaming(logFile: string): boolean {
        return this.activeStreams.has(path.resolve(logFile));
    }

    /**
     * Get list of all active stream paths
     */
    getActiveStreams(): string[] {
        return Array.from(this.activeStreams.keys());
    }

    /**
     * Fall back to polling mode when fs.watch fails
     */
    private fallbackToPolling(stream: ActiveStream): void {
        // Close watcher if it exists
        if (stream.watcher) {
            try {
                stream.watcher.close();
            } catch (e) {
                // Ignore
            }
            stream.watcher = null;
        }
        
        // Clear existing interval if any
        if (stream.pollInterval) {
            clearInterval(stream.pollInterval);
        }
        
        // Start polling
        stream.pollInterval = setInterval(() => {
            this.checkForChanges(stream);
        }, LogStreamService.POLL_INTERVAL_MS);
    }

    /**
     * Check for file changes (used by polling and hybrid mode)
     */
    private checkForChanges(stream: ActiveStream): void {
        try {
            const stats = fs.statSync(stream.logFile);
            
            // File has grown
            if (stats.size > stream.lastSize) {
                stream.lastSize = stats.size;
                this.readAndSendContent(stream);
            }
            // File was truncated (e.g., log rotation)
            else if (stats.size < stream.lastPosition) {
                stream.lastPosition = 0;
                stream.lastSize = stats.size;
                this.readAndSendContent(stream);
            }
        } catch (e) {
            // File may have been deleted, ignore
        }
    }

    /**
     * Read new content from file and send to callback
     */
    private readAndSendContent(stream: ActiveStream): void {
        try {
            const stats = fs.statSync(stream.logFile);
            const currentSize = stats.size;
            
            // Nothing new to read
            if (currentSize <= stream.lastPosition) {
                return;
            }
            
            // Calculate how much to read
            const bytesToRead = Math.min(
                currentSize - stream.lastPosition,
                LogStreamService.READ_CHUNK_SIZE
            );
            
            // Open file for reading
            const fd = fs.openSync(stream.logFile, 'r');
            try {
                // Create buffer and read from last position
                const buffer = Buffer.alloc(bytesToRead);
                const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, stream.lastPosition);
                
                if (bytesRead > 0) {
                    // Convert to string (UTF-8)
                    const content = buffer.toString('utf8', 0, bytesRead);
                    
                    // Update position
                    stream.lastPosition += bytesRead;
                    
                    // Send to callback
                    stream.callback(content);
                }
            } finally {
                fs.closeSync(fd);
            }
            
            // If there's more content, schedule another read
            if (stream.lastPosition < currentSize) {
                setImmediate(() => this.readAndSendContent(stream));
            }
            
        } catch (e) {
            // File may have been deleted or is inaccessible
            console.error(`[LogStreamService] Error reading ${stream.logFile}:`, e);
        }
    }

    /**
     * Dispose all resources
     */
    dispose(): void {
        this.stopAll();
    }
}

// Singleton instance for use across the extension
let logStreamServiceInstance: LogStreamService | null = null;

/**
 * Get the singleton LogStreamService instance
 */
export function getLogStreamService(): LogStreamService {
    if (!logStreamServiceInstance) {
        logStreamServiceInstance = new LogStreamService();
    }
    return logStreamServiceInstance;
}

/**
 * Dispose the singleton instance (call on extension deactivation)
 */
export function disposeLogStreamService(): void {
    if (logStreamServiceInstance) {
        logStreamServiceInstance.dispose();
        logStreamServiceInstance = null;
    }
}

