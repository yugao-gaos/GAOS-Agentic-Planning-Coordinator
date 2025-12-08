import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Timestamped log segment captured during monitoring
 */
export interface LogSegment {
    timestamp: number;      // When this segment was detected
    content: string;        // Raw log content
    hasError: boolean;      // Contains error indicator
    hasException: boolean;  // Contains exception indicator
    hasWarning: boolean;    // Contains warning indicator
}

/**
 * Result from log monitoring session
 */
export interface LogMonitorResult {
    segments: LogSegment[];     // All captured segments with timestamps
    errorCount: number;         // Number of segments with errors
    exceptionCount: number;     // Number of segments with exceptions
    warningCount: number;       // Number of segments with warnings
    totalSegments: number;      // Total segments captured
    persistedPath: string | null;  // Path where logs were persisted (if any)
    startTime: number;          // When monitoring started
    endTime: number;            // When monitoring stopped
}

/**
 * Unity Editor.log Monitor
 * 
 * Monitors Unity's Editor.log file during pipeline operations to capture
 * log content with accurate timestamps. Uses high-frequency polling (10/sec)
 * with delta-read optimization for efficiency.
 * 
 * Design Philosophy:
 * - Capture raw log content with timestamps, don't parse/extract details
 * - Just detect presence of errors/exceptions for counting
 * - Persist captured logs to file for AI/coordinator analysis
 * - Pass file path to coordinator - it can see full context
 * 
 * Since Unity's Editor.log doesn't include timestamps per entry (they're only
 * shown in the Console UI), we achieve timing by:
 * 1. Recording baseline file position at start
 * 2. Polling every 100ms for new content
 * 3. Timestamping segments when detected (~100ms precision)
 * 
 * Usage:
 *   const monitor = new UnityLogMonitor(workspaceRoot);
 *   monitor.startMonitoring();
 *   // ... run Unity operation ...
 *   const result = monitor.stopMonitoring('pipeline_123');
 *   // result.persistedPath contains path to log file for AI analysis
 */
export class UnityLogMonitor {
    private logPath: string | null = null;
    private fd: number | null = null;
    private lastPosition: number = 0;
    private pollInterval: NodeJS.Timeout | null = null;
    private segments: LogSegment[] = [];
    private isMonitoring: boolean = false;
    private incompleteLineBuffer: string = '';
    private startTime: number = 0;
    private workspaceRoot: string;

    // Polling interval in milliseconds (10 times per second)
    private static readonly POLL_INTERVAL_MS = 100;

    constructor(workspaceRoot: string = '') {
        this.workspaceRoot = workspaceRoot;
        this.logPath = this.findEditorLogPath();
    }
    
    /**
     * Set workspace root (for log persistence path)
     */
    setWorkspaceRoot(workspaceRoot: string): void {
        this.workspaceRoot = workspaceRoot;
    }

    /**
     * Find Unity Editor.log path based on OS
     */
    private findEditorLogPath(): string | null {
        const platform = os.platform();
        const homeDir = os.homedir();

        let logPath: string;

        switch (platform) {
            case 'win32':
                // Windows: C:\Users\{user}\AppData\Local\Unity\Editor\Editor.log
                logPath = path.join(
                    process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local'),
                    'Unity',
                    'Editor',
                    'Editor.log'
                );
                break;

            case 'darwin':
                // macOS: ~/Library/Logs/Unity/Editor.log
                logPath = path.join(homeDir, 'Library', 'Logs', 'Unity', 'Editor.log');
                break;

            case 'linux':
                // Linux: ~/.config/unity3d/Editor.log
                logPath = path.join(homeDir, '.config', 'unity3d', 'Editor.log');
                break;

            default:
                console.warn(`[UnityLogMonitor] Unsupported platform: ${platform}`);
                return null;
        }

        // Verify file exists
        if (fs.existsSync(logPath)) {
            return logPath;
        }

        console.warn(`[UnityLogMonitor] Editor.log not found at: ${logPath}`);
        return null;
    }

    /**
     * Check if monitoring is available (log file exists)
     */
    isAvailable(): boolean {
        return this.logPath !== null && fs.existsSync(this.logPath);
    }

    /**
     * Get the log file path
     */
    getLogPath(): string | null {
        return this.logPath;
    }

    /**
     * Start monitoring the Editor.log file
     * Call this at the beginning of a pipeline step
     */
    startMonitoring(): boolean {
        if (!this.logPath) {
            console.warn('[UnityLogMonitor] Cannot start monitoring: log file not found');
            return false;
        }

        // If already monitoring, reset state
        if (this.isMonitoring) {
            console.warn('[UnityLogMonitor] Already monitoring - resetting');
            this.segments = [];
        }

        try {
            // Close any existing fd
            if (this.fd !== null) {
                try { fs.closeSync(this.fd); } catch { /* ignore */ }
            }
            
            // Open file with read-only flag
            this.fd = fs.openSync(this.logPath, 'r');

            // Seek to end - this is our baseline
            const stats = fs.fstatSync(this.fd);
            this.lastPosition = stats.size;

            // Clear previous state
            this.segments = [];
            this.incompleteLineBuffer = '';
            this.isMonitoring = true;
            this.startTime = Date.now();

            // Start polling
            this.pollInterval = setInterval(() => this.poll(), UnityLogMonitor.POLL_INTERVAL_MS);

            return true;
        } catch (err) {
            console.error(`[UnityLogMonitor] Failed to start monitoring: ${err}`);
            this.cleanup();
            return false;
        }
    }

    /**
     * Poll for new content in the log file
     * Called every 100ms during monitoring
     */
    private poll(): void {
        if (!this.fd || !this.isMonitoring) return;

        try {
            const stats = fs.fstatSync(this.fd);

            // Detect file truncation (Unity Editor restart)
            if (stats.size < this.lastPosition) {
                this.lastPosition = 0;
                this.incompleteLineBuffer = '';
            }

            const delta = stats.size - this.lastPosition;
            if (delta <= 0) return; // No new content

            // Read ONLY the delta bytes - O(delta), not O(fileSize)
            const buffer = Buffer.alloc(delta);
            fs.readSync(this.fd, buffer, 0, delta, this.lastPosition);

            const timestamp = Date.now();
            const newContent = this.incompleteLineBuffer + buffer.toString('utf8');

            // Split into complete lines
            const lines = newContent.split('\n');
            const hasTrailingNewline = newContent.endsWith('\n');
            this.incompleteLineBuffer = hasTrailingNewline ? '' : lines.pop() || '';
            
            // Join complete lines as content for this segment
            const segmentContent = lines.join('\n');
            
            if (segmentContent.trim()) {
                // Simple detection - just check if content contains error/warning indicators
                const segment: LogSegment = {
                    timestamp,
                    content: segmentContent,
                    hasError: this.detectError(segmentContent),
                    hasException: this.detectException(segmentContent),
                    hasWarning: this.detectWarning(segmentContent)
                };
                this.segments.push(segment);
            }

            this.lastPosition = stats.size;
        } catch (err) {
            // Log error but don't stop monitoring - file might be temporarily locked
            console.warn(`[UnityLogMonitor] Poll error: ${err}`);
        }
    }
    
    /**
     * Simple error detection - checks for compilation errors and Debug.LogError
     */
    private detectError(content: string): boolean {
        const lower = content.toLowerCase();
        return (
            lower.includes(': error cs') ||      // Compilation error
            lower.includes('error cs') ||        // Compilation error alt format
            content.includes('Debug:LogError') || // Debug.LogError in stack trace
            content.includes('LogError (')        // LogError call
        );
    }
    
    /**
     * Simple exception detection
     */
    private detectException(content: string): boolean {
        const lower = content.toLowerCase();
        return (
            lower.includes('exception:') ||
            lower.includes('nullreferenceexception') ||
            lower.includes('argumentexception') ||
            lower.includes('invalidoperationexception') ||
            lower.includes('indexoutofrangeexception')
        );
    }
    
    /**
     * Simple warning detection
     */
    private detectWarning(content: string): boolean {
        const lower = content.toLowerCase();
        return (
            lower.includes(': warning cs') ||     // Compilation warning
            lower.includes('warning cs') ||       // Compilation warning alt format
            content.includes('Debug:LogWarning') || // Debug.LogWarning in stack trace
            content.includes('LogWarning (')       // LogWarning call
        );
    }

    /**
     * Stop monitoring and return results
     * Persists captured logs to file for AI analysis
     * 
     * @param sessionId - Identifier for naming the persisted log file (e.g., pipeline ID)
     */
    stopMonitoring(sessionId?: string): LogMonitorResult {
        const endTime = Date.now();
        this.isMonitoring = false;

        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }

        // Do one final poll to catch any last entries
        if (this.fd) {
            this.poll();
        }

        this.cleanup();

        // Calculate counts
        const errorCount = this.segments.filter(s => s.hasError).length;
        const exceptionCount = this.segments.filter(s => s.hasException).length;
        const warningCount = this.segments.filter(s => s.hasWarning).length;

        // Persist logs if we have content and a workspace
        let persistedPath: string | null = null;
        if (this.segments.length > 0 && this.workspaceRoot) {
            persistedPath = this.persistLogs(sessionId || `session_${Date.now()}`);
        }

        const result: LogMonitorResult = {
            segments: [...this.segments],
            errorCount,
            exceptionCount,
            warningCount,
            totalSegments: this.segments.length,
            persistedPath,
            startTime: this.startTime,
            endTime
        };

        // Clear state
        this.segments = [];
        this.startTime = 0;

        return result;
    }
    
    /**
     * Persist captured logs to a file for AI/coordinator analysis
     * 
     * Format:
     * ```
     * === Unity Log Monitor Session ===
     * Start: 2024-01-01T12:00:00.000Z
     * End: 2024-01-01T12:05:00.000Z
     * Errors: 2, Exceptions: 1, Warnings: 5
     * 
     * --- [12:00:01.234] ---
     * <log content>
     * 
     * --- [12:00:02.567] ---
     * <log content>
     * ```
     */
    private persistLogs(sessionId: string): string | null {
        try {
            // Get logs directory from folder structure or default
            const logsDir = path.join(this.workspaceRoot, '_AiDevLog', 'Logs');
            
            // Ensure directory exists
            if (!fs.existsSync(logsDir)) {
                fs.mkdirSync(logsDir, { recursive: true });
            }
            
            // Create filename with timestamp
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `unity_log_${sessionId}_${timestamp}.log`;
            const filePath = path.join(logsDir, filename);
            
            // Build file content
            const lines: string[] = [];
            lines.push('=== Unity Log Monitor Session ===');
            lines.push(`Session: ${sessionId}`);
            lines.push(`Start: ${new Date(this.startTime).toISOString()}`);
            lines.push(`End: ${new Date().toISOString()}`);
            lines.push(`Duration: ${((Date.now() - this.startTime) / 1000).toFixed(1)}s`);
            lines.push(`Errors: ${this.segments.filter(s => s.hasError).length}`);
            lines.push(`Exceptions: ${this.segments.filter(s => s.hasException).length}`);
            lines.push(`Warnings: ${this.segments.filter(s => s.hasWarning).length}`);
            lines.push(`Total Segments: ${this.segments.length}`);
            lines.push('');
            
            for (const segment of this.segments) {
                const time = new Date(segment.timestamp).toISOString();
                const flags = [
                    segment.hasError ? 'ERROR' : null,
                    segment.hasException ? 'EXCEPTION' : null,
                    segment.hasWarning ? 'WARNING' : null
                ].filter(Boolean).join(', ');
                
                lines.push(`--- [${time}]${flags ? ` [${flags}]` : ''} ---`);
                lines.push(segment.content);
                lines.push('');
            }
            
            // Write file
            fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
            
            return filePath;
        } catch (err) {
            console.error(`[UnityLogMonitor] Failed to persist logs: ${err}`);
            return null;
        }
    }

    /**
     * Clean up resources
     */
    private cleanup(): void {
        if (this.fd !== null) {
            try {
                fs.closeSync(this.fd);
            } catch {
                // Ignore close errors
            }
            this.fd = null;
        }
        this.incompleteLineBuffer = '';
    }

    /**
     * Get current monitoring state
     */
    getState(): { isMonitoring: boolean; segmentCount: number; errorCount: number } {
        return {
            isMonitoring: this.isMonitoring,
            segmentCount: this.segments.length,
            errorCount: this.segments.filter(s => s.hasError || s.hasException).length
        };
    }

    /**
     * Check if any errors have been captured so far (without stopping)
     */
    hasErrors(): boolean {
        return this.segments.some(s => s.hasError || s.hasException);
    }

    /**
     * Check if any warnings have been captured so far (without stopping)
     */
    hasWarnings(): boolean {
        return this.segments.some(s => s.hasWarning);
    }
}

