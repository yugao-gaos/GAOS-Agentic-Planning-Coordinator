/**
 * ClaudeAgentRunner.ts - Claude CLI Backend Implementation
 * 
 * Implements IAgentBackend for the Claude CLI (claude-code).
 * Uses the `claude` CLI with `-p` flag for headless/print mode.
 * 
 * Auth: ANTHROPIC_API_KEY environment variable
 * MCP Config: ~/.claude/mcp.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess, execSync } from 'child_process';
import { ProcessManager } from './ProcessManager';
import { IAgentBackend, InstallResult, McpInstallConfig, BackendDependencyStatus } from './AgentBackend';
import { AgentRunOptions, AgentRunResult } from './CursorAgentRunner';
import { ServiceLocator } from './ServiceLocator';
import { Logger } from '../utils/Logger';
import { ModelTier } from '../types';

const log = Logger.create('Daemon', 'ClaudeAgentRunner');

/**
 * Runs Claude CLI with proper process management and streaming output parsing.
 * 
 * Implements IAgentBackend for use with the AgentRunner abstraction layer.
 */
export class ClaudeAgentRunner implements IAgentBackend {
    private processManager: ProcessManager;
    private activeRuns: Map<string, {
        proc: ChildProcess;
        startTime: number;
        collectedOutput: string;
        lastLoggedLength: number;
        lastPlanLength: number;
        planStartIndex: number;
        lastOutputTime: number;
        idleInterval?: NodeJS.Timeout;
        lastIdleLogTime: number;
    }> = new Map();
    
    private stoppedIntentionally: Set<string> = new Set();
    private logFileDescriptors: Map<string, number> = new Map();
    
    private static readonly IDLE_THRESHOLD_MS = 5000;
    private static readonly IDLE_LOG_INTERVAL_MS = 10000;
    
    /**
     * Model tier to actual model name mapping for Claude backend
     * - low: Fast, cheap model for simple tasks (Haiku)
     * - mid: Balanced model for most tasks (Sonnet)
     * - high: Most capable model for complex tasks (Opus)
     */
    private static readonly MODEL_TIER_MAP: Record<ModelTier, string> = {
        low: 'claude-haiku-3-5',
        mid: 'claude-sonnet-4-5',
        high: 'claude-opus-4-5'
    };
    
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
     * Convert model tier to actual model name
     */
    private resolveModel(tier: ModelTier): string {
        return ClaudeAgentRunner.MODEL_TIER_MAP[tier] || ClaudeAgentRunner.MODEL_TIER_MAP.mid;
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
            /502|503|504/,
        ];
        
        return transientPatterns.some(pattern => pattern.test(error));
    }

    /**
     * Run Claude CLI with the given prompt and options
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
                await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
            }
            
            const runOptions = attempt > 0 
                ? { ...options, id: `${options.id}_retry${attempt}` }
                : options;
            
            lastResult = await this.runOnce(runOptions);
            
            if (lastResult.success || !this.isTransientError(lastResult.error, lastResult.exitCode)) {
                return lastResult;
            }
            
            const C = this.COLORS;
            if (attempt < maxRetries) {
                onProgress?.(`⚠️ Transient failure detected: ${lastResult.error?.substring(0, 100)}...`);
                if (logFile) {
                    this.appendToLog(logFile, `\n${C.yellow}⚠️ Transient failure: ${lastResult.error}${C.reset}\n`);
                }
            }
        }
        
        const C = this.COLORS;
        onProgress?.(`❌ All ${maxRetries + 1} attempts failed`);
        if (logFile) {
            this.appendToLog(logFile, `\n${C.red}❌ All ${maxRetries + 1} attempts failed${C.reset}\n`);
        }
        
        return lastResult!;
    }

    /**
     * Run Claude CLI once (internal implementation)
     */
    private async runOnce(options: AgentRunOptions): Promise<AgentRunResult> {
        const {
            id,
            prompt,
            cwd,
            model: modelTier = 'mid',
            logFile,
            planFile,
            timeoutMs = 30 * 60 * 1000,
            onOutput,
            onProgress,
            onStart,
            metadata,
            simpleMode = false
        } = options;
        
        const model = this.resolveModel(modelTier);

        const startTime = Date.now();
        let collectedOutput = '';
        let exitCode: number | null = null;
        let error: string | undefined;

        // Write prompt to temp file
        const tempDir = path.join(os.tmpdir(), 'apc_prompts');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        const promptFile = path.join(tempDir, `prompt_${id}_${Date.now()}.txt`);
        fs.writeFileSync(promptFile, prompt);

        // Build claude CLI flags
        // -p: print mode (non-interactive)
        // --output-format stream-json: streaming JSON output
        // --allowedTools: allow all tools for full autonomy
        // --permission-mode acceptEdits: auto-accept file edits
        const claudeFlags = `--model "${model}" -p --output-format stream-json --allowedTools "Bash,Read,Write,Edit,MultiEdit,Glob,Grep,LS,WebFetch,TodoRead,TodoWrite,WebSearch" --permission-mode acceptEdits`;
        
        if (logFile) {
            this.rotateLogIfNeeded(logFile);
        }

        onProgress?.(`🚀 Starting Claude CLI (${model})...`);
        if (logFile) {
            const C = this.COLORS;
            this.appendToLog(logFile, `${'═'.repeat(80)}\n`);
            this.appendToLog(logFile, `${C.cyan}${C.bold}PROMPT SENT TO AGENT${C.reset}\n`);
            this.appendToLog(logFile, `${'═'.repeat(80)}\n\n`);
            this.appendToLog(logFile, `${prompt}\n\n`);
            this.appendToLog(logFile, `${'═'.repeat(80)}\n`);
            this.appendToLog(logFile, `${C.cyan}${C.bold}END OF PROMPT - AGENT OUTPUT BELOW${C.reset}\n`);
            this.appendToLog(logFile, `${'═'.repeat(80)}\n\n`);
            this.appendToLog(logFile, `${C.cyan}${C.bold}🚀 Agent started: ${new Date().toISOString()}${C.reset}\n`);
            this.appendToLog(logFile, `${C.gray}Model: ${model}${C.reset}\n`);
            this.appendToLog(logFile, `${C.gray}Process ID: ${id}${C.reset}\n`);
            this.appendToLog(logFile, `${C.gray}Backend: claude${C.reset}\n`);
            this.appendToLog(logFile, `${C.gray}---${C.reset}\n\n`);
        }

        return new Promise((resolve) => {
            let proc: ChildProcess;
            
            // Claude CLI command - pipe prompt from file
            const shellCmd = `cat "${promptFile}" | claude ${claudeFlags} 2>&1; rm -f "${promptFile}"`;
            
            if (logFile) {
                this.appendToLog(logFile, `[DEBUG] Shell command: ${shellCmd}\n`);
                this.appendToLog(logFile, `[DEBUG] simpleMode: ${simpleMode}\n`);
            }
            
            proc = spawn('bash', ['-c', shellCmd], {
                cwd,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env },
                detached: process.platform !== 'win32'
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
                lastIdleLogTime: 0
            };
            this.activeRuns.set(id, runEntry);
            
            if (logFile) {
                runEntry.idleInterval = setInterval(() => {
                    const run = this.activeRuns.get(id);
                    if (!run) return;
                    
                    const idleTime = Date.now() - run.lastOutputTime;
                    if (idleTime >= ClaudeAgentRunner.IDLE_THRESHOLD_MS) {
                        const timeSinceLastLog = Date.now() - run.lastIdleLogTime;
                        if (timeSinceLastLog >= ClaudeAgentRunner.IDLE_LOG_INTERVAL_MS) {
                            const seconds = Math.floor(idleTime / 1000);
                            this.appendToLog(logFile, `${this.COLORS.gray}⏳ Agent working... (${seconds}s since last activity)${this.COLORS.reset}\n`);
                            run.lastIdleLogTime = Date.now();
                        }
                    }
                }, 1000);
            }

            this.processManager.registerExternalProcess(id, proc, {
                command: 'claude',
                args: ['--model', model],
                cwd,
                metadata: { ...metadata, model, promptFile, managedByClaudeAgentRunner: true }
            });

            const timeoutId = setTimeout(() => {
                onProgress?.(`⏰ Agent timed out after ${timeoutMs}ms`);
                error = `Timeout after ${timeoutMs}ms`;
                this.killProcess(id, proc);
            }, timeoutMs);

            let chunkCount = 0;
            let totalBytes = 0;

            proc.stdout?.on('data', (data) => {
                const text = data.toString('utf8');
                chunkCount++;
                totalBytes += text.length;

                const run = this.activeRuns.get(id);
                if (run) {
                    run.collectedOutput += text;
                    run.lastOutputTime = Date.now();
                }

                if (chunkCount % 20 === 0) {
                    onProgress?.(`📊 Progress: ${chunkCount} chunks, ${Math.round(totalBytes / 1024)}KB`);
                }

                const lines = text.split('\n').filter((l: string) => l.trim());
                for (const line of lines) {
                    this.parseLine(line, id, simpleMode, {
                        onOutput,
                        onProgress,
                        logFile,
                        planFile,
                        collectedOutput: (text) => { collectedOutput += text; }
                    });
                }
            });

            proc.stderr?.on('data', (data) => {
                const text = data.toString('utf8');
                if (text.trim()) {
                    onOutput?.(text, 'error');
                    if (logFile) {
                        this.appendToLog(logFile, `[STDERR] ${text}`);
                    }
                }
            });

            proc.on('exit', (code) => {
                clearTimeout(timeoutId);
                exitCode = code;
                const duration = Date.now() - startTime;

                const exitingRun = this.activeRuns.get(id);
                if (exitingRun?.idleInterval) {
                    clearInterval(exitingRun.idleInterval);
                }
                this.activeRuns.delete(id);
                
                try {
                    this.processManager.stopProcess(id, false).catch(() => {});
                } catch {}
                
                try {
                    if (fs.existsSync(promptFile)) {
                        fs.unlinkSync(promptFile);
                    }
                } catch {}

                const wasStoppedIntentionally = this.stoppedIntentionally.has(id);
                if (wasStoppedIntentionally) {
                    this.stoppedIntentionally.delete(id);
                }

                const flushDelayMs = 200;
                
                setTimeout(() => {
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
                
                const errorRun = this.activeRuns.get(id);
                if (errorRun?.idleInterval) {
                    clearInterval(errorRun.idleInterval);
                }
                this.activeRuns.delete(id);
                
                try {
                    this.processManager.stopProcess(id, false).catch(() => {});
                } catch {}
                
                try {
                    if (fs.existsSync(promptFile)) {
                        fs.unlinkSync(promptFile);
                    }
                } catch {}
                
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
     * Parse a single line of Claude CLI output (stream-json format)
     */
    private parseLine(
        line: string,
        runId: string,
        simpleMode: boolean,
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

            const run = this.activeRuns.get(runId);
            if (run) {
                run.lastOutputTime = Date.now();
            }

            if (msgType === 'thinking' && parsed?.text) {
                const thinkText = parsed.text.substring(0, 150).replace(/\n/g, ' ');
                onOutput?.(parsed.text, 'thinking');
                if (logFile) {
                    this.appendToLog(logFile, `${C.gray}💭 ${thinkText}...${C.reset}\n`);
                }
            }
            else if (msgType === 'assistant' && parsed?.message?.content) {
                for (const item of parsed.message.content) {
                    if (item?.type === 'text' && item?.text) {
                        onOutput?.(item.text, 'text');
                        
                        if (run && logFile) {
                            const newContent = item.text.substring(run.lastLoggedLength);
                            if (newContent) {
                                this.appendToLog(logFile, newContent);
                                run.lastLoggedLength = item.text.length;
                            }
                        }
                    } else if (item?.type === 'tool_use') {
                        onOutput?.(`🔧 Tool: ${item.name || 'unknown'}`, 'tool');
                        onProgress?.(`🔧 Tool: ${item.name || 'unknown'}`);
                        if (logFile) {
                            this.appendToLog(logFile, `\n${C.yellow}🔧 Tool: ${item.name}${C.reset}\n`);
                        }
                    } else if (item?.type === 'tool_result') {
                        const resultLen = item.content ? String(item.content).length : 0;
                        onOutput?.(`✓ Tool result (${resultLen} chars)`, 'tool_result');
                        if (logFile) {
                            const preview = resultLen < 200 ? String(item.content) : `(${resultLen} chars)`;
                            this.appendToLog(logFile, `${C.green}✓ Result: ${preview}${C.reset}\n`);
                        }
                    }
                }
            }
            else if (msgType === 'tool_use' && parsed?.name) {
                onOutput?.(`🔧 Tool: ${parsed.name}`, 'tool');
                onProgress?.(`🔧 Tool: ${parsed.name}`);
                if (logFile) {
                    this.appendToLog(logFile, `\n${C.yellow}🔧 Tool: ${parsed.name}${C.reset}\n`);
                }
            }
            else if (msgType === 'tool_result') {
                onOutput?.('✓ Tool result received', 'tool_result');
                if (logFile) {
                    this.appendToLog(logFile, `${C.green}✓ Tool result received${C.reset}\n`);
                }
            }
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
            else if (parsed?.error) {
                onOutput?.(`❌ Error: ${parsed.error}`, 'error');
                onProgress?.(`❌ Error: ${parsed.error}`);
                if (logFile) {
                    this.appendToLog(logFile, `\n${C.red}❌ Error: ${parsed.error}${C.reset}\n`);
                }
            }

        } catch (parseErr) {
            const trimmed = line.trim();
            if (trimmed.length > 5 && !trimmed.startsWith('{') && !trimmed.startsWith('"')) {
                onOutput?.(trimmed, 'info');
                if (logFile) {
                    this.appendToLog(logFile, `${C.cyan}ℹ️ ${trimmed}${C.reset}\n`);
                }
            }
        }
    }

    async stop(id: string): Promise<boolean> {
        const run = this.activeRuns.get(id);
        if (!run) {
            return false;
        }
        this.stoppedIntentionally.add(id);
        this.killProcess(id, run.proc);
        return true;
    }

    getRunningAgents(): string[] {
        return Array.from(this.activeRuns.keys());
    }
    
    isRunning(id: string): boolean {
        return this.activeRuns.has(id);
    }
    
    /**
     * Check if Claude CLI is available on the system
     */
    async isAvailable(): Promise<boolean> {
        const status = await this.getDependencyStatus(false);
        return status.installed;
    }
    
    /**
     * Get dependency status for Claude CLI
     * This is the authoritative source for Claude CLI availability
     * 
     * @param isCurrentBackend Whether claude is the currently active backend (affects 'required' field)
     */
    async getDependencyStatus(isCurrentBackend: boolean): Promise<BackendDependencyStatus> {
        let installed = false;
        let version: string | undefined;
        
        try {
            const { promisify } = require('util');
            const exec = promisify(require('child_process').exec);
            const { stdout } = await exec('claude --version', { timeout: 5000, windowsHide: true });
            installed = true;
            version = stdout.trim().split('\n')[0];
        } catch {
            // Try common install locations
            const commonPaths = [
                path.join(os.homedir(), '.local', 'bin', 'claude'),
                '/usr/local/bin/claude'
            ];
            for (const p of commonPaths) {
                if (fs.existsSync(p)) {
                    installed = true;
                    break;
                }
            }
        }
        
        const description = installed
            ? (isCurrentBackend 
                ? '✅ Installed and ready for claude backend'
                : 'Installed (not currently in use)')
            : (isCurrentBackend
                ? '❌ Claude CLI not installed!\n\n' +
                  'INSTALLATION:\n' +
                  '• npm install -g @anthropic-ai/claude-code\n\n' +
                  'AUTHENTICATION:\n' +
                  '• Set ANTHROPIC_API_KEY environment variable\n\n' +
                  '📖 Documentation: https://docs.anthropic.com/claude/docs/claude-code'
                : 'Not needed (claude backend not in use)');
        
        return {
            name: 'Claude CLI',
            installed,
            version,
            required: isCurrentBackend,
            description,
            platform: 'all',
            installCommand: 'npm install -g @anthropic-ai/claude-code'
        };
    }
    
    async dispose(): Promise<void> {
        log.info('Disposing...');
        const runningIds = this.getRunningAgents();
        for (const id of runningIds) {
            await this.stop(id);
        }
        log.info('Disposed');
    }
    
    async installCLI(): Promise<InstallResult> {
        const isAvailable = await this.isAvailable();
        if (isAvailable) {
            return { success: true, message: 'Claude CLI is already installed and available.' };
        }
        
        return {
            success: false,
            message: 'Claude CLI not found.\n\n' +
                     'Installation:\n' +
                     '1. Install via npm: npm install -g @anthropic-ai/claude-code\n' +
                     '2. Set ANTHROPIC_API_KEY environment variable\n' +
                     '3. Run "claude --version" to verify installation',
            requiresRestart: true
        };
    }
    
    async installMCP(config: McpInstallConfig): Promise<InstallResult> {
        try {
            const configPath = this.getMcpConfigPath();
            
            let mcpConfig: any = { mcpServers: {} };
            let mcpServers: Record<string, any> = {};
            
            if (fs.existsSync(configPath)) {
                try {
                    const content = fs.readFileSync(configPath, 'utf8');
                    mcpConfig = JSON.parse(content);
                    mcpServers = mcpConfig.mcpServers || {};
                } catch (parseError) {
                    log.warn(`MCP config exists but is invalid JSON, will recreate: ${parseError}`);
                    mcpConfig = { mcpServers: {} };
                    mcpServers = {};
                }
            }
            
            let newMcpConfig: any;
            if (config.url) {
                newMcpConfig = { url: config.url };
            } else if (config.command) {
                newMcpConfig = {
                    command: config.command,
                    args: config.args || []
                };
            } else {
                return { success: false, message: 'Invalid MCP config: must have either url or command' };
            }
            
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
                }
            }
            
            mcpServers[config.name] = newMcpConfig;
            mcpConfig.mcpServers = mcpServers;
            
            const configDir = path.dirname(configPath);
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }
            
            fs.writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2));
            
            return {
                success: true,
                message: `MCP '${config.name}' configured successfully.`,
                requiresRestart: false
            };
        } catch (error) {
            return {
                success: false,
                message: `Failed to install MCP: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }
    
    getMcpConfigPath(): string {
        const home = os.homedir();
        return path.join(home, '.claude', 'mcp.json');
    }
    
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
    
    async removeMCP(name: string): Promise<InstallResult> {
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
                message: `MCP '${name}' removed successfully.`,
                requiresRestart: false
            };
        } catch (error) {
            return {
                success: false,
                message: `Failed to remove MCP: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }
    
    async killOrphanAgents(): Promise<number> {
        // Claude CLI processes can be found by looking for 'claude' command
        // For now, return 0 - orphan cleanup is primarily for cursor-agent
        return 0;
    }

    private killProcess(id: string, proc: ChildProcess): void {
        const run = this.activeRuns.get(id);
        if (run?.idleInterval) {
            clearInterval(run.idleInterval);
        }
        
        try {
            if (proc.pid) {
                if (process.platform === 'win32') {
                    try {
                        execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' });
                    } catch {
                        try { proc.kill(); } catch {}
                    }
                } else {
                    try {
                        process.kill(-proc.pid, 'SIGTERM');
                    } catch {
                        try { process.kill(proc.pid, 'SIGKILL'); } catch {}
                    }
                }
            } else {
                try { proc.kill(); } catch {}
            }
        } catch (e) {
            log.error(`Error killing process ${id}:`, e);
        }
        this.activeRuns.delete(id);
    }

    private rotateLogIfNeeded(logFile: string, maxSizeBytes: number = 1 * 1024 * 1024, maxBackups: number = 3): void {
        try {
            if (!fs.existsSync(logFile)) return;

            const stats = fs.statSync(logFile);
            if (stats.size < maxSizeBytes) return;

            this.closeLogFile(logFile);

            for (let i = maxBackups; i >= 1; i--) {
                const currentBackup = `${logFile}.${i}`;
                const nextBackup = `${logFile}.${i + 1}`;
                
                if (i === maxBackups) {
                    if (fs.existsSync(currentBackup)) {
                        fs.unlinkSync(currentBackup);
                    }
                } else {
                    if (fs.existsSync(currentBackup)) {
                        fs.renameSync(currentBackup, nextBackup);
                    }
                }
            }

            fs.renameSync(logFile, `${logFile}.1`);
        } catch (e) {
            log.error(`Error rotating log file ${logFile}:`, e);
        }
    }

    private appendToLog(logFile: string, text: string): void {
        try {
            let fd = this.logFileDescriptors.get(logFile);
            
            if (!fd) {
                fd = fs.openSync(logFile, 'a');
                this.logFileDescriptors.set(logFile, fd);
            }
            
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
}

