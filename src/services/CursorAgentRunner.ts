import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess, execSync } from 'child_process';
import { ProcessManager, ProcessState } from './ProcessManager';
import { IAgentBackend } from './AgentBackend';
import { ServiceLocator } from './ServiceLocator';

/**
 * Result from running a cursor agent
 */
export interface AgentRunResult {
    success: boolean;
    output: string;
    exitCode: number | null;
    durationMs: number;
    error?: string;
}

/**
 * Options for running a cursor agent
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
}

/**
 * Runs Cursor CLI agents with proper process management and streaming output parsing.
 * This is the canonical way to run cursor agents in the extension.
 * 
 * Implements IAgentBackend for use with the AgentRunner abstraction layer.
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
    }> = new Map();
    
    // Track runs that were intentionally stopped (so we don't log them as failures)
    private stoppedIntentionally: Set<string> = new Set();
    
    // Spinner animation frames for idle indicator
    private static readonly SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    private static readonly IDLE_THRESHOLD_MS = 5000;  // 5 seconds

    constructor() {
        this.processManager = ServiceLocator.resolve(ProcessManager);
    }

    /**
     * Run a cursor agent with the given prompt and options
     */
    async run(options: AgentRunOptions): Promise<AgentRunResult> {
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

        // Build the shell command
        // Using cat to pipe prompt avoids escaping issues with complex prompts
        // Always use stream-json format - text mode doesn't produce capturable stdout
        // simpleMode affects how we PARSE the output, not the output format
        // stdbuf -oL enables line-buffered output to prevent bash from buffering stdout
        const cursorFlags = `--model "${model}" -p --force --approve-mcps --output-format stream-json --stream-partial-output`;
        const shellCmd = `cat "${promptFile}" | stdbuf -oL cursor agent ${cursorFlags} 2>&1; rm -f "${promptFile}"`;
        
        if (logFile) {
            this.appendToLog(logFile, `[DEBUG] Shell command: ${shellCmd}\n`);
            this.appendToLog(logFile, `[DEBUG] simpleMode: ${simpleMode}\n`);
        }

        onProgress?.(`🚀 Starting cursor agent (${model})...`);
        if (logFile) {
            const C = this.COLORS;
            this.appendToLog(logFile, `${C.cyan}${C.bold}🚀 Agent started: ${new Date().toISOString()}${C.reset}\n`);
            this.appendToLog(logFile, `${C.gray}Model: ${model}${C.reset}\n`);
            this.appendToLog(logFile, `${C.gray}Process ID: ${id}${C.reset}\n`);
            this.appendToLog(logFile, `${C.gray}---${C.reset}\n\n`);
        }

        return new Promise((resolve) => {
            const proc = spawn('bash', ['-c', shellCmd], {
                cwd,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env },
                detached: true  // Create process group for reliable cleanup
            });

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
                idleSpinnerIndex: 0
            };
            this.activeRuns.set(id, runEntry);
            
            // Set up idle indicator interval (check every second)
            if (logFile) {
                runEntry.idleInterval = setInterval(() => {
                    const run = this.activeRuns.get(id);
                    if (!run) return;
                    
                    const idleTime = Date.now() - run.lastOutputTime;
                    if (idleTime >= CursorAgentRunner.IDLE_THRESHOLD_MS) {
                        // Show animated spinner
                        const frame = CursorAgentRunner.SPINNER_FRAMES[run.idleSpinnerIndex % CursorAgentRunner.SPINNER_FRAMES.length];
                        run.idleSpinnerIndex++;
                        
                        // Use ANSI escape to overwrite the same line
                        // \r moves cursor to start of line, \x1B[K clears to end of line
                        const seconds = Math.floor(idleTime / 1000);
                        this.appendToLog(logFile, `\r\x1B[K${this.COLORS.gray}${frame} Working... (${seconds}s)${this.COLORS.reset}`);
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
                const text = data.toString();
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
                const text = data.toString();
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
                }

                resolve({
                    success,
                    output: collectedOutput,
                    exitCode: code,
                    durationMs: duration,
                    error
                });
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

    // ANSI color codes for terminal output
    private readonly COLORS = {
        reset: '\x1b[0m',
        cyan: '\x1b[36m',
        yellow: '\x1b[33m',
        green: '\x1b[32m',
        red: '\x1b[31m',
        gray: '\x1b[90m',
        bold: '\x1b[1m',
    };

    /**
     * Parse a single line of cursor agent output
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
                                        this.appendToLog(logFile, newContent);
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
                                        this.appendToLog(logFile, newCommentary);
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
            // Not JSON - might be meaningful text output
            const trimmed = line.trim();
            if (trimmed.length > 5 && !trimmed.startsWith('{')) {
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
                                    this.appendToLog(logFile, newContent);
                                    run.lastLoggedLength = item.text.length;
                                }
                            } else {
                                this.appendToLog(logFile, item.text);
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
                        this.appendToLog(logFile, `\n${C.bold}📋 Final Result:${C.reset}\n${parsed.result}`);
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
            // Not JSON - log as-is
            const trimmed = line.trim();
            if (trimmed.length > 5) {
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
                console.log(`[CursorAgentRunner] Cleaned up ${cleanedCount} old temp files`);
            }
        } catch (e) {
            console.error('[CursorAgentRunner] Error cleaning temp files:', e);
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
     * Check if Cursor CLI is available on the system
     * Implements IAgentBackend.isAvailable()
     */
    async isAvailable(): Promise<boolean> {
        try {
            if (process.platform === 'win32') {
                execSync('where cursor', { stdio: 'ignore' });
            } else {
                execSync('which cursor', { stdio: 'ignore' });
            }
            return true;
        } catch {
            return false;
        }
    }
    
    /**
     * Dispose resources used by this runner
     * Implements IAgentBackend.dispose()
     */
    async dispose(): Promise<void> {
        console.log('[CursorAgentRunner] Disposing...');
        
        // Stop all active runs
        const runningIds = this.getRunningAgents();
        for (const id of runningIds) {
            await this.stop(id);
        }
        
        // Clean up any leftover temp files
        this.cleanupTempFiles(0); // Clean all temp files on dispose
        
        console.log('[CursorAgentRunner] Disposed');
    }

    private killProcess(id: string, proc: ChildProcess): void {
        // Clear idle interval before killing
        const run = this.activeRuns.get(id);
        if (run?.idleInterval) {
            clearInterval(run.idleInterval);
        }
        
        try {
            if (proc.pid && process.platform !== 'win32') {
                // Kill the entire process group
                try {
                    process.kill(-proc.pid, 'SIGTERM');
                } catch {
                    process.kill(proc.pid, 'SIGKILL');
                }
            } else {
                proc.kill('SIGKILL');
            }
        } catch (e) {
            console.error(`Error killing process ${id}:`, e);
        }
        this.activeRuns.delete(id);
    }

    private appendToLog(logFile: string, text: string): void {
        try {
            fs.appendFileSync(logFile, text);
        } catch (e) {
            console.error(`Error writing to log file ${logFile}:`, e);
        }
    }
}

