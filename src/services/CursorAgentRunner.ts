import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';
import { ProcessManager, ProcessState } from './ProcessManager';

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
    /** Log file path to write output */
    logFile?: string;
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
}

/**
 * Runs Cursor CLI agents with proper process management and streaming output parsing.
 * This is the canonical way to run cursor agents in the extension.
 */
export class CursorAgentRunner {
    private static instance: CursorAgentRunner;
    private processManager: ProcessManager;
    private activeRuns: Map<string, {
        proc: ChildProcess;
        startTime: number;
        collectedOutput: string;
    }> = new Map();

    private constructor() {
        this.processManager = ProcessManager.getInstance();
    }

    static getInstance(): CursorAgentRunner {
        if (!CursorAgentRunner.instance) {
            CursorAgentRunner.instance = new CursorAgentRunner();
        }
        return CursorAgentRunner.instance;
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
            timeoutMs = 30 * 60 * 1000,  // 30 minutes default
            onOutput,
            onProgress,
            onStart,
            metadata
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
        const shellCmd = `cat "${promptFile}" | cursor agent --model "${model}" -p --force --approve-mcps --output-format stream-json --stream-partial-output 2>&1; rm -f "${promptFile}"`;

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

            this.activeRuns.set(id, { proc, startTime, collectedOutput: '' });

            // Register with ProcessManager for tracking
            const processState: ProcessState = {
                id,
                command: 'cursor',
                args: ['agent', '--model', model],
                cwd,
                startTime: new Date().toISOString(),
                status: 'running',
                metadata: { ...metadata, model, promptFile }
            };

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

            // Parse stdout streaming JSON
            proc.stdout?.on('data', (data) => {
                const text = data.toString();
                chunkCount++;
                totalBytes += text.length;

                // Update activity tracking
                const run = this.activeRuns.get(id);
                if (run) {
                    run.collectedOutput += text;
                }

                // Progress report every 20 chunks
                if (chunkCount % 20 === 0) {
                    onProgress?.(`📊 Progress: ${chunkCount} chunks, ${Math.round(totalBytes / 1024)}KB`);
                }

                // Parse each line as JSON
                const lines = text.split('\n').filter((l: string) => l.trim());
                for (const line of lines) {
                    this.parseLine(line, {
                        onOutput,
                        onProgress,
                        logFile,
                        collectedOutput: (text) => { collectedOutput += text; }
                    });
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

                this.activeRuns.delete(id);

                const success = code === 0 && !error;
                const statusIcon = success ? '✅' : '❌';
                onProgress?.(`${statusIcon} Agent finished (exit code: ${code}, duration: ${Math.round(duration / 1000)}s)`);

                if (logFile) {
                    const C = this.COLORS;
                    const color = success ? C.green : C.red;
                    this.appendToLog(logFile, `\n\n${C.gray}---${C.reset}\n`);
                    this.appendToLog(logFile, `${color}${C.bold}${statusIcon} Agent finished: ${new Date().toISOString()}${C.reset}\n`);
                    this.appendToLog(logFile, `${C.gray}Exit code: ${code}${C.reset}\n`);
                    this.appendToLog(logFile, `${C.gray}Duration: ${Math.round(duration / 1000)}s${C.reset}\n`);
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
     */
    private parseLine(
        line: string,
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
            else if (msgType === 'assistant' && parsed?.message?.content) {
                for (const item of parsed.message.content) {
                    if (item?.type === 'text' && item?.text) {
                        collectedOutput(item.text);
                        onOutput?.(item.text, 'text');
                        // Write text content to log (main output)
                        if (logFile) {
                            this.appendToLog(logFile, item.text);
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
     * Stop a running agent by ID
     */
    async stop(id: string): Promise<boolean> {
        const run = this.activeRuns.get(id);
        if (!run) {
            return false;
        }

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
     * Check if an agent is running
     */
    isRunning(id: string): boolean {
        return this.activeRuns.has(id);
    }

    private killProcess(id: string, proc: ChildProcess): void {
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

