import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess, execSync } from 'child_process';
import { ProcessManager, ProcessState } from './ProcessManager';
import { IAgentBackend } from './AgentBackend';
import { ServiceLocator } from './ServiceLocator';
import { Logger } from '../utils/Logger';
import { CursorSetupScripts } from './cursor/CursorSetupScripts';
import * as vscode from 'vscode';

const log = Logger.create('Daemon', 'AgentRunner');

/**
 * Result from running cursor-agent CLI
 */
export interface AgentRunResult {
    success: boolean;
    output: string;
    exitCode: number | null;
    durationMs: number;
    error?: string;
}

/**
 * Options for running cursor-agent CLI
 */
export interface AgentRunOptions {
    /** Unique identifier for this agent run */
    id: string;
    /** The prompt to send to the agent */
    prompt: string;
    /** Working directory */
    cwd: string;
    /** Model to use (default: sonnet-4.5) */
    model?: string;
    /** Log file path to write streaming output (commentary, reasoning, tool calls) */
    logFile?: string;
    /** Plan file path to stream plan content to (markdown starting with #) */
    planFile?: string;
    /** Timeout in milliseconds (default: 30 minutes) */
    timeoutMs?: number;
    /** Callback for streaming output */
    onOutput?: (text: string, type: 'text' | 'thinking' | 'tool' | 'tool_result' | 'error' | 'info') => void;
    /** Callback for progress updates */
    onProgress?: (message: string) => void;
    /** Callback when process starts */
    onStart?: (pid: number) => void;
    /** Additional metadata for tracking */
    metadata?: Record<string, any>;
    /** Use simple mode without streaming JSON output (for coordinator) */
    simpleMode?: boolean;
    /** Number of retry attempts for transient failures (default: 2) */
    maxRetries?: number;
    /** Delay between retries in milliseconds (default: 3000) */
    retryDelayMs?: number;
}

/**
 * Runs cursor-agent CLI with proper process management and streaming output parsing.
 * This is the canonical way to run cursor-agent in the extension.
 * 
 * Implements IAgentBackend for use with the AgentRunner abstraction layer.
 * 
 * Note: On Windows, cursor-agent requires WSL (Windows Subsystem for Linux).
 * 
 * Obtain via ServiceLocator:
 *   const runner = ServiceLocator.resolve(CursorAgentRunner);
 */
export class CursorAgentRunner implements IAgentBackend {
    private processManager: ProcessManager;
    private activeRuns: Map<string, {
        proc: ChildProcess;
        startTime: number;
        collectedOutput: string;
        lastLoggedLength: number;  // Track cumulative commentary logged to avoid duplication
        lastPlanLength: number;    // Track cumulative plan content written
        planStartIndex: number;    // Index where plan content starts (-1 if not found)
        lastOutputTime: number;    // Timestamp of last output (for idle detection)
        idleInterval?: NodeJS.Timeout;  // Interval for idle indicator
        idleSpinnerIndex: number;  // Current spinner frame index
        lastIdleLogTime: number;  // Last time we logged idle status to file
    }> = new Map();
    
    // Track runs that were intentionally stopped (so we don't log them as failures)
    private stoppedIntentionally: Set<string> = new Set();
    
    // Track open file descriptors for log files (for real-time streaming)
    private logFileDescriptors: Map<string, number> = new Map();
    
    // Spinner animation frames for idle indicator
    private static readonly SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    private static readonly IDLE_THRESHOLD_MS = 5000;  // 5 seconds
    private static readonly IDLE_LOG_INTERVAL_MS = 10000;  // Log idle status every 10 seconds (not every second)
    
    // ANSI color codes for terminal output
    private COLORS = {
        reset: '\x1b[0m',
        bold: '\x1b[1m',
        dim: '\x1b[2m',
        red: '\x1b[31m',
        green: '\x1b[32m',
        yellow: '\x1b[33m',
        blue: '\x1b[34m',
        magenta: '\x1b[35m',
        cyan: '\x1b[36m',
        gray: '\x1b[90m'
    };

    constructor() {
        this.processManager = ServiceLocator.resolve(ProcessManager);
    }

    /**
     * Format text for better terminal readability with markdown-aware formatting
     * Supports: bullet lists, headers, code blocks, sentence breaks, indentation
     */
    private formatTextForTerminal(text: string): string {
        if (!text) return text;
        
        // First, preserve existing newlines and structure
        const lines = text.split('\n');
        const formatted: string[] = [];
        
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            const trimmed = line.trim();
            
            // Preserve empty lines
            if (!trimmed) {
                formatted.push('');
                continue;
            }
            
            // Preserve headers (# ## ###)
            if (/^#{1,6}\s+/.test(trimmed)) {
                formatted.push(line);
                continue;
            }
            
            // Preserve bullet lists (-, *, •, 1., 2., etc.)
            if (/^[\s]*[-*•]\s+/.test(trimmed) || /^[\s]*\d+\.\s+/.test(trimmed)) {
                formatted.push(line);
                continue;
            }
            
            // Preserve code blocks
            if (trimmed.startsWith('```') || trimmed.startsWith('    ')) {
                formatted.push(line);
                continue;
            }
            
            // For regular text paragraphs, add line breaks after sentences
            // Only if the line is long enough and doesn't already have structure
            if (line.length > 80 && !line.includes('  ') && !line.startsWith(' ')) {
                // Add breaks after ". " followed by a capital letter or number
                line = line.replace(/\.\s+([A-Z0-9])/g, '.\n$1');
                // Add breaks after "! " and "? " for better readability
                line = line.replace(/([!?])\s+([A-Z])/g, '$1\n$2');
            }
            
            formatted.push(line);
        }
        
        return formatted.join('\n');
    }

    /**
     * Check if an error is likely a transient network failure that could be retried
     */
    private isTransientError(error: string | undefined, exitCode: number | null): boolean {
        if (!error) return false;
        
        const transientPatterns = [
            /fetch failed/i,
            /ECONNREFUSED/i,
            /ECONNRESET/i,
            /ETIMEDOUT/i,
            /ENOTFOUND/i,
            /socket hang up/i,
            /network error/i,
            /request timeout/i,
            /502|503|504/,  // Gateway errors
        ];
        
        return transientPatterns.some(pattern => pattern.test(error));
    }
    
    /**
     * Run cursor-agent CLI with the given prompt and options
     * Includes automatic retry logic for transient network failures
     */
    async run(options: AgentRunOptions): Promise<AgentRunResult> {
        const {
            maxRetries = 2,
            retryDelayMs = 3000,
            onProgress,
            logFile
        } = options;
        
        let lastResult: AgentRunResult | null = null;
        
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                const C = this.COLORS;
                onProgress?.(`🔄 Retry attempt ${attempt}/${maxRetries} after transient failure...`);
                if (logFile) {
                    this.appendToLog(logFile, `\n${C.yellow}🔄 Retry attempt ${attempt}/${maxRetries} after transient failure${C.reset}\n`);
                }
                // Wait before retry with exponential backoff
                await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
            }
            
            // Modify ID for retries to avoid conflicts
            const runOptions = attempt > 0 
                ? { ...options, id: `${options.id}_retry${attempt}` }
                : options;
            
            lastResult = await this.runOnce(runOptions);
            
            // If successful or not a transient error, return immediately
            if (lastResult.success || !this.isTransientError(lastResult.error, lastResult.exitCode)) {
                return lastResult;
            }
            
            // Log the transient failure
            const C = this.COLORS;
            if (attempt < maxRetries) {
                onProgress?.(`⚠️ Transient failure detected: ${lastResult.error?.substring(0, 100)}...`);
                if (logFile) {
                    this.appendToLog(logFile, `\n${C.yellow}⚠️ Transient failure: ${lastResult.error}${C.reset}\n`);
                }
            }
        }
        
        // All retries exhausted
        const C = this.COLORS;
        onProgress?.(`❌ All ${maxRetries + 1} attempts failed`);
        if (logFile) {
            this.appendToLog(logFile, `\n${C.red}❌ All ${maxRetries + 1} attempts failed${C.reset}\n`);
        }
        
        return lastResult!;
    }
    
    /**
     * Run cursor-agent CLI once (internal implementation)
     */
    private async runOnce(options: AgentRunOptions): Promise<AgentRunResult> {
        const {
            id,
            prompt,
            cwd,
            model = 'sonnet-4.5',
            logFile,
            planFile,
            timeoutMs = 30 * 60 * 1000,  // 30 minutes default
            onOutput,
            onProgress,
            onStart,
            metadata,
            simpleMode = false
        } = options;

        const startTime = Date.now();
        let collectedOutput = '';
        let exitCode: number | null = null;
        let error: string | undefined;

        // Write prompt to OS temp file to avoid shell escaping issues
        const tempDir = path.join(os.tmpdir(), 'apc_prompts');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        const promptFile = path.join(tempDir, `prompt_${id}_${Date.now()}.txt`);
        fs.writeFileSync(promptFile, prompt);

        // Build cursor-agent flags (common across platforms)
        // Always use stream-json format - text mode doesn't produce capturable stdout
        // simpleMode affects how we PARSE the output, not the output format
        // --approve-mcps: Auto-approve MCP servers (required for Unity MCP)
        const cursorFlags = `--model "${model}" -p --force --output-format stream-json --approve-mcps`;
        
        // Rotate log file if needed (1MB max, keep 3 backups)
        if (logFile) {
            this.rotateLogIfNeeded(logFile);
        }

        onProgress?.(`🚀 Starting cursor-agent (${model})...`);
        if (logFile) {
            const C = this.COLORS;
            this.appendToLog(logFile, `${C.cyan}${C.bold}🚀 Agent started: ${new Date().toISOString()}${C.reset}\n`);
            this.appendToLog(logFile, `${C.gray}Model: ${model}${C.reset}\n`);
            this.appendToLog(logFile, `${C.gray}Process ID: ${id}${C.reset}\n`);
            this.appendToLog(logFile, `${C.gray}Platform: ${process.platform}${C.reset}\n`);
            this.appendToLog(logFile, `${C.gray}---${C.reset}\n\n`);
        }

        return new Promise((resolve) => {
            let proc: ChildProcess;
            
            if (process.platform === 'win32') {
                // Windows: Use WSL to run cursor-agent (cursor-agent requires Unix environment)
                // Use Ubuntu distribution and pipe prompt file content
                // IMPORTANT: Use absolute path to cursor-agent since PATH may not be configured yet
                const cursorAgentPath = '$HOME/.local/bin/cursor-agent';
                const wslPromptPath = promptFile.replace(/\\/g, '/').replace(/^[A-Z]:/, (match) => `/mnt/${match.toLowerCase().charAt(0)}`);
                const bashCmd = `cat "${wslPromptPath}" | ${cursorAgentPath} ${cursorFlags} 2>&1; rm -f "${wslPromptPath}"`;
                
                if (logFile) {
                    this.appendToLog(logFile, `[DEBUG] WSL bash command: ${bashCmd}\n`);
                    this.appendToLog(logFile, `[DEBUG] Prompt file (Windows): ${promptFile}\n`);
                    this.appendToLog(logFile, `[DEBUG] Prompt file (WSL): ${wslPromptPath}\n`);
                    this.appendToLog(logFile, `[DEBUG] simpleMode: ${simpleMode}\n`);
                }
                
                proc = spawn('wsl', ['-d', 'Ubuntu', 'bash', '-c', bashCmd], {
                    cwd,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env: { ...process.env },
                    windowsHide: true  // Hide WSL window
                });
            } else {
                // macOS/Linux: Use bash with cat to pipe prompt
                // Try cursor-agent in PATH first, then check ~/.local/bin
                // Note: Using || for command chaining here is acceptable as it's shell-level command fallback
                // within a single operation, not data-level fallback masking errors
                const shellCmd = `cat "${promptFile}" | (cursor-agent ${cursorFlags} 2>&1 || $HOME/.local/bin/cursor-agent ${cursorFlags} 2>&1); rm -f "${promptFile}"`;
                if (logFile) {
                    this.appendToLog(logFile, `[DEBUG] Shell command: ${shellCmd}\n`);
                    this.appendToLog(logFile, `[DEBUG] simpleMode: ${simpleMode}\n`);
                }
                proc = spawn('bash', ['-c', shellCmd], {
                    cwd,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env: { ...process.env },
                    detached: true  // Create process group for reliable cleanup on Unix
                });
            }

            if (proc.pid) {
                onStart?.(proc.pid);
                onProgress?.(`📡 Process started (PID: ${proc.pid})`);
            }

            const runEntry = {
                proc,
                startTime,
                collectedOutput: '',
                lastLoggedLength: 0,
                lastPlanLength: 0,
                planStartIndex: -1,
                lastOutputTime: Date.now(),
                idleInterval: undefined as NodeJS.Timeout | undefined,
                idleSpinnerIndex: 0,
                lastIdleLogTime: 0
            };
            this.activeRuns.set(id, runEntry);
            
            // Set up idle indicator interval (check every second)
            if (logFile) {
                runEntry.idleInterval = setInterval(() => {
                    const run = this.activeRuns.get(id);
                    if (!run) return;
                    
                    const idleTime = Date.now() - run.lastOutputTime;
                    if (idleTime >= CursorAgentRunner.IDLE_THRESHOLD_MS) {
                        // For log files, don't use ANSI overwriting - just append periodic status updates
                        // Log idle status every 10 seconds to avoid spamming the log file
                        const timeSinceLastLog = Date.now() - run.lastIdleLogTime;
                        if (timeSinceLastLog >= CursorAgentRunner.IDLE_LOG_INTERVAL_MS) {
                            const seconds = Math.floor(idleTime / 1000);
                            // Use simple newline-terminated message (no ANSI overwriting)
                            this.appendToLog(logFile, `${this.COLORS.gray}⏳ Agent working... (${seconds}s since last activity)${this.COLORS.reset}\n`);
                            run.lastIdleLogTime = Date.now();
                        }
                    }
                }, 1000);
            }

            // Register the externally-spawned process with ProcessManager for tracking
            // This ensures the process can be found by killStuckProcesses() and killOrphanCursorAgents()
            this.processManager.registerExternalProcess(id, proc, {
                command: 'cursor',
                args: ['agent', '--model', model],
                cwd,
                metadata: { ...metadata, model, promptFile, managedByCursorAgentRunner: true }
            });

            // Set up timeout
            const timeoutId = setTimeout(() => {
                onProgress?.(`⏰ Agent timed out after ${timeoutMs}ms`);
                error = `Timeout after ${timeoutMs}ms`;
                this.killProcess(id, proc);
            }, timeoutMs);

            // Track chunks for progress reporting
            let chunkCount = 0;
            let totalBytes = 0;
            let lastProgressTime = Date.now();

            // Parse stdout - simple mode collects raw text, normal mode parses JSON
            proc.stdout?.on('data', (data) => {
                const text = data.toString('utf8');
                chunkCount++;
                totalBytes += text.length;

                // Debug: log first chunk to see what we're getting
                if (chunkCount === 1 && logFile) {
                    this.appendToLog(logFile, `[DEBUG] First stdout chunk (${text.length} bytes): ${text.substring(0, 200)}\n`);
                }

                // Update activity tracking
                const run = this.activeRuns.get(id);
                if (run) {
                    run.collectedOutput += text;
                    run.lastOutputTime = Date.now();
                }

                // Progress report every 20 chunks
                if (chunkCount % 20 === 0) {
                    onProgress?.(`📊 Progress: ${chunkCount} chunks, ${Math.round(totalBytes / 1024)}KB`);
                }

                // Parse each line as JSON (stream-json format)
                const lines = text.split('\n').filter((l: string) => l.trim());
                for (const line of lines) {
                    if (simpleMode) {
                        // Simple mode: extract text from JSON but don't do plan extraction
                        this.parseLineSimple(line, id, {
                            onOutput,
                            onProgress,
                            logFile,
                            collectedOutput: (text) => { collectedOutput += text; }
                        });
                    } else {
                        // Normal mode: full parsing with plan extraction
                        this.parseLine(line, id, {
                            onOutput,
                            onProgress,
                            logFile,
                            planFile,
                            collectedOutput: (text) => { collectedOutput += text; }
                        });
                    }
                }
            });

            // Handle stderr
            proc.stderr?.on('data', (data) => {
                const text = data.toString('utf8');
                if (text.trim()) {
                    onOutput?.(text, 'error');
                    if (logFile) {
                        this.appendToLog(logFile, `[STDERR] ${text}`);
                    }
                }
            });

            // Handle process exit
            proc.on('exit', (code) => {
                clearTimeout(timeoutId);
                exitCode = code;
                const duration = Date.now() - startTime;

                // Clear idle interval before deleting from activeRuns
                const exitingRun = this.activeRuns.get(id);
                if (exitingRun?.idleInterval) {
                    clearInterval(exitingRun.idleInterval);
                }
                this.activeRuns.delete(id);
                
                // Unregister from ProcessManager to prevent orphan processes
                // The process has already exited, so we just need to remove it from tracking
                try {
                    this.processManager.stopProcess(id, false).catch(() => {
                        // Process already exited, ignore errors
                    });
                } catch {
                    // Ignore - process already exited
                }
                
                // Clean up temp prompt file (in case shell didn't delete it)
                try {
                    if (fs.existsSync(promptFile)) {
                        fs.unlinkSync(promptFile);
                    }
                } catch {
                    // Ignore cleanup errors
                }

                // Check if this was an intentional stop (e.g., after CLI callback completed)
                const wasStoppedIntentionally = this.stoppedIntentionally.has(id);
                if (wasStoppedIntentionally) {
                    this.stoppedIntentionally.delete(id);  // Clean up
                }

                // Wait briefly for stdout/stderr to finish flushing buffered data
                // This prevents the "work completed" message from appearing before progress chunks
                const flushDelayMs = 200;  // 200ms should be enough for buffered data to flush
                
                setTimeout(() => {
                    // Success if: clean exit (code 0), OR intentionally stopped (CLI callback completed)
                    const success = (code === 0 && !error) || wasStoppedIntentionally;
                    const statusIcon = success ? '✅' : '❌';
                    const statusText = wasStoppedIntentionally 
                        ? 'Agent work completed successfully' 
                        : `Agent finished (exit code: ${code})`;
                    onProgress?.(`${statusIcon} ${statusText}, duration: ${Math.round(duration / 1000)}s`);

                    if (logFile) {
                        const C = this.COLORS;
                        const color = success ? C.green : C.red;
                        this.appendToLog(logFile, `\n\n${C.gray}---${C.reset}\n`);
                        this.appendToLog(logFile, `${color}${C.bold}${statusIcon} ${statusText}: ${new Date().toISOString()}${C.reset}\n`);
                        this.appendToLog(logFile, `${C.gray}Exit code: ${code}${C.reset}\n`);
                        this.appendToLog(logFile, `${C.gray}Duration: ${Math.round(duration / 1000)}s${C.reset}\n`);
                        this.appendToLog(logFile, `${C.gray}Collected output length: ${collectedOutput.length} chars${C.reset}\n`);
                        if (collectedOutput.length > 0) {
                            this.appendToLog(logFile, `${C.gray}Output preview: ${collectedOutput.substring(0, 500)}${C.reset}\n`);
                        }
                        
                        // Close log file descriptor now that agent is done
                        this.closeLogFile(logFile);
                    }

                    resolve({
                        success,
                        output: collectedOutput,
                        exitCode: code,
                        durationMs: duration,
                        error
                    });
                }, flushDelayMs);
            });

            proc.on('error', (err) => {
                clearTimeout(timeoutId);
                error = err.message;
                onOutput?.(err.message, 'error');
                
                // Clear idle interval before deleting from activeRuns
                const errorRun = this.activeRuns.get(id);
                if (errorRun?.idleInterval) {
                    clearInterval(errorRun.idleInterval);
                }
                this.activeRuns.delete(id);
                
                // Unregister from ProcessManager
                try {
                    this.processManager.stopProcess(id, false).catch(() => {});
                } catch {
                    // Ignore
                }
                
                // Clean up temp prompt file
                try {
                    if (fs.existsSync(promptFile)) {
                        fs.unlinkSync(promptFile);
                    }
                } catch {
                    // Ignore cleanup errors
                }
                
                resolve({
                    success: false,
                    output: collectedOutput,
                    exitCode: null,
                    durationMs: Date.now() - startTime,
                    error: err.message
                });
            });
        });
    }


    /**
     * Parse a single line of cursor-agent output
     * @param line The JSON line to parse
     * @param runId The ID of the current run (for delta tracking)
     * @param handlers Output handlers
     */
    private parseLine(
        line: string,
        runId: string,
        handlers: {
            onOutput?: (text: string, type: 'text' | 'thinking' | 'tool' | 'tool_result' | 'error' | 'info') => void;
            onProgress?: (message: string) => void;
            logFile?: string;
            planFile?: string;
            collectedOutput: (text: string) => void;
        }
    ): void {
        const { onOutput, onProgress, logFile, planFile, collectedOutput } = handlers;
        const C = this.COLORS;

        try {
            const parsed = JSON.parse(line);
            const msgType = parsed?.type;

            // Format 1: type="thinking" with text at top level
            if (msgType === 'thinking' && parsed?.text) {
                const thinkText = parsed.text.substring(0, 150).replace(/\n/g, ' ');
                onOutput?.(parsed.text, 'thinking');
                if (thinkText.length > 20) {
                    onProgress?.(`💭 ${thinkText}...`);
                }
                // Write thinking to log in gray
                if (logFile) {
                    this.appendToLog(logFile, `${C.gray}💭 ${thinkText}...${C.reset}\n`);
                }
            }

            // Format 2: type="assistant" with message.content[0].text
            // NOTE: With --stream-partial-output, assistant messages contain CUMULATIVE text.
            // We split content into:
            //   - Commentary (before plan starts) → log file
            //   - Plan content (starting from first # header) → plan file
            else if (msgType === 'assistant' && parsed?.message?.content) {
                for (const item of parsed.message.content) {
                    if (item?.type === 'text' && item?.text) {
                        // Don't collect partial outputs - they accumulate and cause duplication
                        // collectedOutput is only called for type="result" (final output)
                        onOutput?.(item.text, 'text');
                        
                        const run = this.activeRuns.get(runId);
                        if (run) {
                            // Update last output time for idle detection
                            run.lastOutputTime = Date.now();
                            run.idleSpinnerIndex = 0;  // Reset spinner
                            
                            // Find where plan content starts (first markdown header)
                            if (run.planStartIndex === -1) {
                                const planMatch = item.text.match(/^#\s+.+/m);
                                if (planMatch && planMatch.index !== undefined) {
                                    run.planStartIndex = planMatch.index;
                                }
                            }
                            
                            const planStart = run.planStartIndex;
                            
                            if (planStart === -1) {
                                // No plan content yet - all goes to log
                                if (logFile) {
                                    const newContent = item.text.substring(run.lastLoggedLength);
                                    if (newContent) {
                                        // Format text: preserve markdown structure and add smart line breaks
                                        const formatted = this.formatTextForTerminal(newContent);
                                        this.appendToLog(logFile, formatted);
                                        run.lastLoggedLength = item.text.length;
                                    }
                                }
                            } else {
                                // Split: commentary (before planStart) → log, plan content → planFile
                                const commentaryPart = item.text.substring(0, planStart);
                                const planPart = item.text.substring(planStart);
                                
                                // Write delta of commentary to log
                                if (logFile && run.lastLoggedLength < commentaryPart.length) {
                                    const newCommentary = commentaryPart.substring(run.lastLoggedLength);
                                    if (newCommentary) {
                                        // Format text: preserve markdown structure and add smart line breaks
                                        const formatted = this.formatTextForTerminal(newCommentary);
                                        this.appendToLog(logFile, formatted);
                                    }
                                    run.lastLoggedLength = commentaryPart.length;
                                }
                                
                                // Write delta of plan content to plan file
                                if (planFile && planPart.length > 0) {
                                    const planDelta = planPart.substring(run.lastPlanLength);
                                    if (planDelta) {
                                        // If this is the first plan content, truncate the file
                                        if (run.lastPlanLength === 0) {
                                            fs.writeFileSync(planFile, planDelta);
                                        } else {
                                            fs.appendFileSync(planFile, planDelta);
                                        }
                                        run.lastPlanLength = planPart.length;
                                    }
                                }
                            }
                        }
                        
                        // Show progress for meaningful content
                        if (item.text.includes('##') || 
                            item.text.includes('✅') ||
                            item.text.includes('❌') ||
                            item.text.includes('BLOCKED')) {
                            const preview = item.text.substring(0, 100).replace(/\n/g, ' ').trim();
                            onProgress?.(`📝 ${preview}`);
                        }
                    } else if (item?.type === 'tool_use') {
                        onOutput?.(`🔧 Tool: ${item.name || 'unknown'}`, 'tool');
                        onProgress?.(`🔧 Tool: ${item.name || 'unknown'}`);
                        // Write tool call in yellow
                        if (logFile) {
                            this.appendToLog(logFile, `\n${C.yellow}🔧 Tool: ${item.name}${C.reset}\n`);
                        }
                    } else if (item?.type === 'tool_result') {
                        const resultLen = item.content ? String(item.content).length : 0;
                        onOutput?.(`✓ Tool result (${resultLen} chars)`, 'tool_result');
                        // Write tool result in green (truncated)
                        if (logFile) {
                            const preview = resultLen < 200 ? String(item.content) : `(${resultLen} chars)`;
                            this.appendToLog(logFile, `${C.green}✓ Result: ${preview}${C.reset}\n`);
                        }
                    }
                }
            }

            // Format 3: type="tool_use" at top level
            else if (msgType === 'tool_use' && parsed?.name) {
                onOutput?.(`🔧 Tool: ${parsed.name}`, 'tool');
                onProgress?.(`🔧 Tool: ${parsed.name}`);
                if (logFile) {
                    this.appendToLog(logFile, `\n${C.yellow}🔧 Tool: ${parsed.name}${C.reset}\n`);
                }
            }

            // Format 4: type="tool_result" at top level  
            else if (msgType === 'tool_result') {
                onOutput?.('✓ Tool result received', 'tool_result');
                if (logFile) {
                    this.appendToLog(logFile, `${C.green}✓ Tool result received${C.reset}\n`);
                }
            }

            // Format 5: type="result" - final result
            // This is the ONLY place we call collectedOutput to avoid duplication
            // from streaming partial outputs in assistant messages
            else if (msgType === 'result') {
                if (parsed?.result) {
                    collectedOutput(parsed.result);
                    onOutput?.(parsed.result, 'text');
                    onProgress?.(`📋 Final result (${parsed.result.length} chars)`);
                    if (logFile) {
                        this.appendToLog(logFile, `\n${C.bold}📋 Final Result:${C.reset}\n${parsed.result}`);
                    }
                }
            }

            // Format 6: error at any level
            else if (parsed?.error) {
                onOutput?.(`❌ Error: ${parsed.error}`, 'error');
                onProgress?.(`❌ Error: ${parsed.error}`);
                if (logFile) {
                    this.appendToLog(logFile, `\n${C.red}❌ Error: ${parsed.error}${C.reset}\n`);
                }
            }

        } catch (parseErr) {
            // Not JSON or unparseable - skip logging raw JSON to avoid clutter
            // Only log if it looks like meaningful non-JSON text
            const trimmed = line.trim();
            if (trimmed.length > 5 && !trimmed.startsWith('{') && !trimmed.startsWith('"')) {
                onOutput?.(trimmed, 'info');
                if (logFile) {
                    this.appendToLog(logFile, `${C.cyan}ℹ️ ${trimmed}${C.reset}\n`);
                }
            }
        }
    }

    /**
     * Parse a line in simple mode - logs all activity but doesn't extract plans
     * Used for coordinator which just needs to see what commands were executed
     */
    private parseLineSimple(
        line: string,
        runId: string,
        handlers: {
            onOutput?: (text: string, type: 'text' | 'thinking' | 'tool' | 'tool_result' | 'error' | 'info') => void;
            onProgress?: (message: string) => void;
            logFile?: string;
            collectedOutput: (text: string) => void;
        }
    ): void {
        const { onOutput, onProgress, logFile, collectedOutput } = handlers;
        const C = this.COLORS;

        try {
            const parsed = JSON.parse(line);
            const msgType = parsed?.type;

            // Update activity tracking
            const run = this.activeRuns.get(runId);
            if (run) {
                run.lastOutputTime = Date.now();
                run.idleSpinnerIndex = 0;
            }

            // Thinking
            if (msgType === 'thinking' && parsed?.text) {
                const thinkText = parsed.text.substring(0, 150).replace(/\n/g, ' ');
                onOutput?.(parsed.text, 'thinking');
                if (logFile) {
                    this.appendToLog(logFile, `${C.gray}💭 ${thinkText}...${C.reset}\n`);
                }
            }

            // Assistant message - log text content and tool calls
            else if (msgType === 'assistant' && parsed?.message?.content) {
                for (const item of parsed.message.content) {
                    if (item?.type === 'text' && item?.text) {
                        onOutput?.(item.text, 'text');
                        // Log text content (show what coordinator is thinking/saying)
                        if (logFile) {
                            // For cumulative streaming, only log new content
                            if (run) {
                                const newContent = item.text.substring(run.lastLoggedLength);
                                if (newContent) {
                                    // Format text: preserve markdown structure and add smart line breaks
                                    const formatted = this.formatTextForTerminal(newContent);
                                    this.appendToLog(logFile, formatted);
                                    run.lastLoggedLength = item.text.length;
                                }
                            } else {
                                // Format text: preserve markdown structure and add smart line breaks
                                const formatted = this.formatTextForTerminal(item.text);
                                this.appendToLog(logFile, formatted);
                            }
                        }
                    } else if (item?.type === 'tool_use') {
                        // Log tool calls with full input
                        const toolName = item.name || 'unknown';
                        const toolInput = item.input ? JSON.stringify(item.input, null, 2) : '';
                        onOutput?.(`🔧 Tool: ${toolName}`, 'tool');
                        onProgress?.(`🔧 Tool: ${toolName}`);
                        if (logFile) {
                            this.appendToLog(logFile, `\n${C.yellow}🔧 Tool: ${toolName}${C.reset}\n`);
                            if (toolInput) {
                                // For run_terminal_cmd, show the command
                                if (toolName === 'run_terminal_cmd' && item.input?.command) {
                                    this.appendToLog(logFile, `${C.cyan}$ ${item.input.command}${C.reset}\n`);
                                } else {
                                    this.appendToLog(logFile, `${C.gray}Input: ${toolInput.substring(0, 500)}${C.reset}\n`);
                                }
                            }
                        }
                    } else if (item?.type === 'tool_result') {
                        const resultContent = item.content ? String(item.content) : '';
                        const resultLen = resultContent.length;
                        onOutput?.(`✓ Tool result (${resultLen} chars)`, 'tool_result');
                        if (logFile) {
                            // Show full result for command outputs
                            const preview = resultLen < 1000 ? resultContent : `${resultContent.substring(0, 1000)}...(truncated)`;
                            this.appendToLog(logFile, `${C.green}✓ Result:\n${preview}${C.reset}\n`);
                        }
                    }
                }
            }

            // Tool use at top level
            else if (msgType === 'tool_use' && parsed?.name) {
                const toolInput = parsed.input ? JSON.stringify(parsed.input, null, 2) : '';
                onOutput?.(`🔧 Tool: ${parsed.name}`, 'tool');
                onProgress?.(`🔧 Tool: ${parsed.name}`);
                if (logFile) {
                    this.appendToLog(logFile, `\n${C.yellow}🔧 Tool: ${parsed.name}${C.reset}\n`);
                    if (parsed.name === 'run_terminal_cmd' && parsed.input?.command) {
                        this.appendToLog(logFile, `${C.cyan}$ ${parsed.input.command}${C.reset}\n`);
                    } else if (toolInput) {
                        this.appendToLog(logFile, `${C.gray}Input: ${toolInput.substring(0, 500)}${C.reset}\n`);
                    }
                }
            }

            // Tool result at top level
            else if (msgType === 'tool_result') {
                const resultContent = parsed.content ? String(parsed.content) : '';
                onOutput?.('✓ Tool result received', 'tool_result');
                if (logFile) {
                    const preview = resultContent.length < 1000 ? resultContent : `${resultContent.substring(0, 1000)}...(truncated)`;
                    this.appendToLog(logFile, `${C.green}✓ Result:\n${preview}${C.reset}\n`);
                }
            }

            // Final result - this is what we collect for the return value
            else if (msgType === 'result') {
                if (parsed?.result) {
                    collectedOutput(parsed.result);
                    onOutput?.(parsed.result, 'text');
                    onProgress?.(`📋 Final result (${parsed.result.length} chars)`);
                    if (logFile) {
                        // Format text: preserve markdown structure and add smart line breaks
                        const formatted = this.formatTextForTerminal(parsed.result);
                        this.appendToLog(logFile, `\n${C.bold}📋 Final Result:${C.reset}\n${formatted}`);
                    }
                }
            }

            // Error
            else if (parsed?.error) {
                onOutput?.(`❌ Error: ${parsed.error}`, 'error');
                onProgress?.(`❌ Error: ${parsed.error}`);
                if (logFile) {
                    this.appendToLog(logFile, `\n${C.red}❌ Error: ${parsed.error}${C.reset}\n`);
                }
            }

        } catch (parseErr) {
            // Not JSON or unparseable - skip logging raw JSON to avoid clutter
            // Only log if it looks like meaningful non-JSON text (doesn't start with {)
            const trimmed = line.trim();
            if (trimmed.length > 5 && !trimmed.startsWith('{') && !trimmed.startsWith('"')) {
                onOutput?.(trimmed, 'info');
                if (logFile) {
                    this.appendToLog(logFile, `${trimmed}\n`);
                }
            }
        }
    }

    /**
     * Stop a running agent by ID
     * Marks the agent as intentionally stopped so exit handler shows success
     */
    async stop(id: string): Promise<boolean> {
        const run = this.activeRuns.get(id);
        if (!run) {
            return false;
        }

        // Mark as intentionally stopped before killing
        // This tells the exit handler to show success instead of failure
        this.stoppedIntentionally.add(id);
        this.killProcess(id, run.proc);
        return true;
    }

    /**
     * Get all running agent IDs
     */
    getRunningAgents(): string[] {
        return Array.from(this.activeRuns.keys());
    }
    
    /**
     * Get partial output collected so far for a running agent
     * Useful for saving state before killing
     */
    getPartialOutput(id: string): string | undefined {
        const run = this.activeRuns.get(id);
        return run?.collectedOutput;
    }
    
    /**
     * Check if an agent is currently running
     */
    isRunning(id: string): boolean {
        return this.activeRuns.has(id);
    }
    
    /**
     * Clean up old temp files (prompt files that weren't deleted)
     * Should be called periodically or on extension activation
     * 
     * @param maxAgeMs Maximum age of files to keep (default: 1 hour)
     * @returns Number of files cleaned up
     */
    cleanupTempFiles(maxAgeMs: number = 60 * 60 * 1000): number {
        const tempDir = path.join(os.tmpdir(), 'apc_prompts');
        let cleanedCount = 0;
        
        if (!fs.existsSync(tempDir)) {
            return 0;
        }
        
        try {
            const now = Date.now();
            const files = fs.readdirSync(tempDir);
            
            for (const file of files) {
                if (!file.startsWith('prompt_')) continue;
                
                const filePath = path.join(tempDir, file);
                try {
                    const stats = fs.statSync(filePath);
                    const age = now - stats.mtimeMs;
                    
                    if (age > maxAgeMs) {
                        fs.unlinkSync(filePath);
                        cleanedCount++;
                    }
                } catch (e) {
                    // File may have been deleted already, ignore
                }
            }
            
            if (cleanedCount > 0) {
                log.debug(`Cleaned up ${cleanedCount} old temp files`);
            }
        } catch (e) {
            log.error('Error cleaning temp files:', e);
        }
        
        return cleanedCount;
    }
    
    /**
     * Get the temp directory path used for prompt files
     */
    getTempDir(): string {
        return path.join(os.tmpdir(), 'apc_prompts');
    }
    
    /**
     * Check if cursor-agent is authenticated
     * Returns true if logged in, false otherwise
     */
    async checkLoginStatus(): Promise<{ loggedIn: boolean; error?: string }> {
        try {
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            
            let result: { stdout: string; stderr: string };
            
            if (process.platform === 'win32') {
                // On Windows, check in WSL
                result = await execAsync('wsl -d Ubuntu bash -c "~/.local/bin/cursor-agent status 2>&1"', { timeout: 5000 });
            } else {
                // On macOS/Linux
                result = await execAsync('cursor-agent status 2>&1', { timeout: 5000 });
            }
            
            const output = result.stdout + result.stderr;
            
            // If status command succeeds and doesn't mention authentication, we're logged in
            if (output.includes('Authenticated') || output.includes('Logged in') || (!output.includes('Authentication required') && !output.includes('login'))) {
                return { loggedIn: true };
            } else {
                return { loggedIn: false, error: 'Not authenticated' };
            }
        } catch (error: any) {
            // If command fails, check the error message
            const errorMsg = error.message || '';
            if (errorMsg.includes('Authentication required') || errorMsg.includes('login')) {
                return { loggedIn: false, error: 'Authentication required' };
            }
            // Other errors - assume not logged in to be safe
            return { loggedIn: false, error: 'Unable to check login status' };
        }
    }
    
    /**
     * Interactive login - opens terminal for user to login
     * @param interactive If true, opens terminal; if false, returns instruction message
     */
    async login(interactive: boolean = true): Promise<{ success: boolean; message: string }> {
        if (!interactive) {
            const platform = process.platform;
            const loginCmd = platform === 'win32' 
                ? 'wsl -d Ubuntu bash -c "$HOME/.local/bin/cursor-agent login"'
                : 'cursor-agent login';
            
            return {
                success: false,
                message: `Please run: ${loginCmd}\n\nOr set CURSOR_API_KEY environment variable.`
            };
        }
        
        // Interactive mode - open terminal
        const vscode = require('vscode');
        const platform = process.platform;
        
        try {
            const terminal = vscode.window.createTerminal({
                name: 'cursor-agent login',
                cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            });
            
            terminal.show();
            
            if (platform === 'win32') {
                terminal.sendText('wsl -d Ubuntu bash -c "$HOME/.local/bin/cursor-agent login"');
            } else {
                terminal.sendText('cursor-agent login');
            }
            
            return {
                success: true,
                message: 'Login terminal opened. Please complete authentication and try again.'
            };
        } catch (error: any) {
            return {
                success: false,
                message: `Failed to open login terminal: ${error.message}`
            };
        }
    }
    
    /**
     * Check if cursor-agent is available AND authenticated
     * This is a complete readiness check
     */
    async isAvailableAndAuthenticated(): Promise<{ available: boolean; authenticated: boolean; error?: string }> {
        const available = await this.isAvailable();
        if (!available) {
            return { available: false, authenticated: false, error: 'cursor-agent not installed' };
        }
        
        const loginStatus = await this.checkLoginStatus();
        return {
            available: true,
            authenticated: loginStatus.loggedIn,
            error: loginStatus.error
        };
    }
    
    /**
     * Check if Cursor CLI is available on the system
     * Implements IAgentBackend.isAvailable()
     * 
     * IMPORTANT: This uses the SAME detection logic as DependencyService.checkCursorAgentCli()
     * to ensure consistency across the codebase
     */
    async isAvailable(): Promise<boolean> {
        try {
            if (process.platform === 'win32') {
                // On Windows, check if cursor-agent exists in WSL
                // Use the EXACT SAME check as DependencyService for consistency
                const { execSync } = require('child_process');
                const result = execSync(
                    'wsl -d Ubuntu bash -c "if [ -f ~/.local/bin/cursor-agent ]; then ~/.local/bin/cursor-agent --version 2>&1; else echo NOT_FOUND; fi"',
                    { encoding: 'utf8', stdio: 'pipe', timeout: 5000 }
                );
                
                // Check if it returned a version (not NOT_FOUND)
                if (result && !result.includes('NOT_FOUND') && result.trim()) {
                    return true;
                }
                return false;
            } else {
                // On macOS/Linux, check if cursor-agent is in PATH
                execSync('which cursor-agent', { stdio: 'ignore' });
                return true;
            }
        } catch {
            return false;
        }
    }
    
    /**
     * Dispose resources used by this runner
     * Implements IAgentBackend.dispose()
     */
    async dispose(): Promise<void> {
        log.info('Disposing...');
        
        // Stop all active runs
        const runningIds = this.getRunningAgents();
        for (const id of runningIds) {
            await this.stop(id);
        }
        
        // Clean up any leftover temp files
        this.cleanupTempFiles(0); // Clean all temp files on dispose
        
        log.info('Disposed');
    }
    
    /**
     * Install the Cursor CLI
     * Cursor CLI is installed via Cursor app itself - show instructions
     */
    /**
     * Install the Cursor CLI (cursor-agent).
     * This delegates to the cursor-specific setup scripts.
     * 
     * Note: This method provides information/instructions rather than direct installation
     * because installation requires admin privileges and user interaction.
     * The actual installation is triggered via UI (DependencyService + SidebarViewProvider).
     */
    async installCLI(): Promise<{ success: boolean; message: string; requiresRestart?: boolean }> {
        const isAvailable = await this.isAvailable();
        if (isAvailable) {
            return { success: true, message: 'Cursor Agent CLI (cursor-agent) is already installed and available.' };
        }
        
        // For Windows, cursor-agent needs WSL setup
        if (process.platform === 'win32') {
            return {
                success: false,
                message: 'Cursor Agent CLI requires WSL setup on Windows.\n\n' +
                         'Click "Install" in the Dependencies panel to run the automated installer.\n' +
                         'The installer will:\n' +
                         '• Install/configure WSL and Ubuntu\n' +
                         '• Install cursor-agent CLI\n' +
                         '• Install Node.js in WSL\n' +
                         '• Setup apc CLI in WSL',
                requiresRestart: false
            };
        }
        
        // For Unix-like systems, provide installation instructions
        return {
            success: false,
            message: 'Cursor Agent CLI not found.\n\n' +
                     'Installation options:\n' +
                     '1. Via Cursor app: Command Palette > "Install cursor command"\n' +
                     '2. Via script: Run the install-cursor-agent.sh script from the extension',
            requiresRestart: true
        };
    }
    
    /**
     * Install/configure an MCP server in Cursor's mcp.json
     * If already configured, verifies and updates if URL is different
     */
    async installMCP(config: { name: string; url?: string; command?: string; args?: string[] }): Promise<{ success: boolean; message: string; requiresRestart?: boolean }> {
        try {
            const configPath = this.getMcpConfigPath();
            
            // Read existing config or create new
            let mcpConfig: any = { mcpServers: {} };
            let mcpServers: Record<string, any> = {};
            
            if (fs.existsSync(configPath)) {
                try {
                const content = fs.readFileSync(configPath, 'utf8');
                mcpConfig = JSON.parse(content);
                mcpServers = mcpConfig.mcpServers || {};
                } catch (parseError) {
                    log.warn(`MCP config exists but is invalid JSON, will recreate: ${parseError}`);
                    // Invalid JSON - start fresh
                    mcpConfig = { mcpServers: {} };
                    mcpServers = {};
                }
            }
            
            // Build new config entry
            let newMcpConfig: any;
            if (config.url) {
                // HTTP transport
                newMcpConfig = { url: config.url };
            } else if (config.command) {
                // stdio transport
                newMcpConfig = {
                    command: config.command,
                    args: config.args || []
                };
            } else {
                return { success: false, message: 'Invalid MCP config: must have either url or command' };
            }
            
            // Check if already configured with same config
            if (mcpServers[config.name]) {
                const existing = mcpServers[config.name];
                const isSame = config.url 
                    ? existing.url === config.url
                    : existing.command === config.command && JSON.stringify(existing.args) === JSON.stringify(config.args);
                
                if (isSame) {
                    return { 
                        success: true, 
                        message: `MCP '${config.name}' already configured correctly.`,
                        requiresRestart: false
                    };
                } else {
                    // Different config - update it
                    mcpServers[config.name] = newMcpConfig;
                    mcpConfig.mcpServers = mcpServers;
                    
                    // Ensure directory exists
                    const configDir = path.dirname(configPath);
                    if (!fs.existsSync(configDir)) {
                        fs.mkdirSync(configDir, { recursive: true });
                    }
                    
                    // Write config
                    fs.writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2));
                    
                    return {
                        success: true,
                        message: `MCP '${config.name}' configuration updated. Agents will use new config immediately.`,
                        requiresRestart: false
                    };
                }
            }
            
            // Not configured - add it
            mcpServers[config.name] = newMcpConfig;
            mcpConfig.mcpServers = mcpServers;
            
            // Ensure directory exists
            const configDir = path.dirname(configPath);
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }
            
            // Write config
            fs.writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2));
            
            return {
                success: true,
                message: `MCP '${config.name}' configured successfully. Agents will use it immediately on next run.`,
                requiresRestart: false
            };
        } catch (error) {
            return {
                success: false,
                message: `Failed to install MCP: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }
    
    /**
     * Get the MCP config file path for Cursor
     * 
     * IMPORTANT: On Windows, cursor-agent runs in WSL, so the config must be in WSL home directory!
     */
    getMcpConfigPath(): string {
        if (process.platform === 'win32') {
            // On Windows, cursor-agent runs in WSL, so config must be in WSL home
            // Get the actual WSL username dynamically
            try {
                const { execSync } = require('child_process');
                const wslUsername = execSync('wsl -d Ubuntu bash -c "whoami"', { encoding: 'utf8' }).trim();
                return `\\\\wsl$\\Ubuntu\\home\\${wslUsername}\\.cursor\\mcp.json`;
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                log.error(`Failed to detect WSL username: ${errorMsg}`);
                throw new Error(
                    `Cannot detect WSL username for MCP config path. ` +
                    `Please ensure WSL (Ubuntu) is properly installed and accessible. ` +
                    `Error: ${errorMsg}`
                );
            }
        } else if (process.platform === 'darwin') {
            const home = os.homedir();
            return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'cursor.mcp', 'mcp.json');
        } else {
            const home = os.homedir();
            return path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'cursor.mcp', 'mcp.json');
        }
    }
    
    /**
     * Check if a specific MCP is already configured
     */
    isMcpConfigured(name: string): boolean {
        try {
            const configPath = this.getMcpConfigPath();
            if (!fs.existsSync(configPath)) {
                return false;
            }
            
            const content = fs.readFileSync(configPath, 'utf8');
            const mcpConfig = JSON.parse(content);
            return Boolean(mcpConfig?.mcpServers?.[name]);
        } catch {
            return false;
        }
    }
    
    /**
     * Remove an MCP configuration
     */
    async removeMCP(name: string): Promise<{ success: boolean; message: string; requiresRestart?: boolean }> {
        try {
            const configPath = this.getMcpConfigPath();
            
            if (!fs.existsSync(configPath)) {
                return { success: true, message: `MCP '${name}' was not configured.` };
            }
            
            const content = fs.readFileSync(configPath, 'utf8');
            const mcpConfig = JSON.parse(content);
            
            if (!mcpConfig?.mcpServers?.[name]) {
                return { success: true, message: `MCP '${name}' was not configured.` };
            }
            
            delete mcpConfig.mcpServers[name];
            fs.writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2));
            
            return {
                success: true,
                message: `MCP '${name}' removed successfully. Restart Cursor to apply.`,
                requiresRestart: true
            };
        } catch (error) {
            return {
                success: false,
                message: `Failed to remove MCP: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    private killProcess(id: string, proc: ChildProcess): void {
        // Clear idle interval before killing
        const run = this.activeRuns.get(id);
        if (run?.idleInterval) {
            clearInterval(run.idleInterval);
        }
        
        try {
            if (proc.pid) {
                if (process.platform === 'win32') {
                    // Windows: Use taskkill to terminate the process tree
                    try {
                        execSync(`taskkill /PID ${proc.pid} /T /F`, { 
                            stdio: 'ignore',
                            windowsHide: true 
                        });
                    } catch {
                        // Process may already be dead, try direct kill
                        try {
                            proc.kill();
                        } catch {
                            // Ignore - process already dead
                        }
                    }
                } else {
                    // Unix: Kill the entire process group using negative PID
                    try {
                        process.kill(-proc.pid, 'SIGTERM');
                    } catch {
                        try {
                            process.kill(proc.pid, 'SIGKILL');
                        } catch {
                            // Ignore - process already dead
                        }
                    }
                }
            } else {
                // No PID available, try direct kill
                try {
                    proc.kill();
                } catch {
                    // Ignore - process already dead
                }
            }
        } catch (e) {
            log.error(`Error killing process ${id}:`, e);
        }
        this.activeRuns.delete(id);
    }

    /**
     * Rotate log file if it exceeds maxSize
     * Keeps up to maxBackups old log files
     */
    private rotateLogIfNeeded(logFile: string, maxSizeBytes: number = 1 * 1024 * 1024, maxBackups: number = 3): void {
        try {
            if (!fs.existsSync(logFile)) {
                return;
            }

            const stats = fs.statSync(logFile);
            if (stats.size < maxSizeBytes) {
                return;
            }

            // Close any open file descriptor for this log
            this.closeLogFile(logFile);

            // Rotate existing backups (log.3 -> delete, log.2 -> log.3, log.1 -> log.2)
            for (let i = maxBackups; i >= 1; i--) {
                const currentBackup = `${logFile}.${i}`;
                const nextBackup = `${logFile}.${i + 1}`;
                
                if (i === maxBackups) {
                    // Delete oldest backup
                    if (fs.existsSync(currentBackup)) {
                        fs.unlinkSync(currentBackup);
                    }
                } else {
                    // Shift backup to next number
                    if (fs.existsSync(currentBackup)) {
                        fs.renameSync(currentBackup, nextBackup);
                    }
                }
            }

            // Move current log to .1
            fs.renameSync(logFile, `${logFile}.1`);
            
            log.debug(`Log rotated: ${logFile} (${Math.round(stats.size / 1024)}KB -> 0KB, kept ${maxBackups} backups)`);
        } catch (e) {
            log.error(`Error rotating log file ${logFile}:`, e);
        }
    }

    private appendToLog(logFile: string, text: string): void {
        try {
            let fd = this.logFileDescriptors.get(logFile);
            
            if (!fd) {
                // Open file in append mode - keep it open for duration of agent run
                fd = fs.openSync(logFile, 'a');
                this.logFileDescriptors.set(logFile, fd);
            }
            
            // Write synchronously to file descriptor with explicit UTF-8 encoding
            // This bypasses Node.js buffering and makes output immediately visible to tail -f
            // Explicit UTF-8 encoding ensures Unicode characters are properly handled
            // No fsync needed - writeSync to file descriptor is sufficient for real-time streaming
            fs.writeSync(fd, text, null, 'utf8');
        } catch (e) {
            log.error(`Error writing to log file ${logFile}:`, e);
        }
    }
    
    private closeLogFile(logFile: string): void {
        const fd = this.logFileDescriptors.get(logFile);
        if (fd) {
            try {
                fs.closeSync(fd);
                this.logFileDescriptors.delete(logFile);
            } catch (e) {
                log.error(`Error closing log file ${logFile}:`, e);
            }
        }
    }
    
    /**
     * Kill orphaned cursor-agent processes from previous runs
     * Returns the number of processes killed
     */
    async killOrphanAgents(): Promise<number> {
        const { killOrphanCursorAgents } = await import('../utils/orphanCleanup');
        return await killOrphanCursorAgents(new Set(), '[CursorAgentRunner]');
    }
}

