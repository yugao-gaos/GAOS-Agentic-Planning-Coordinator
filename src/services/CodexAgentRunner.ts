/**
 * CodexAgentRunner.ts - OpenAI Codex CLI Backend Implementation
 * 
 * Implements IAgentBackend for the Codex CLI (@openai/codex).
 * Uses `codex` CLI with `--approval-mode full-auto` for automated execution.
 * 
 * Auth: OPENAI_API_KEY environment variable
 * MCP Config: ~/.codex/mcp.json
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

const log = Logger.create('Daemon', 'CodexAgentRunner');

/**
 * Runs OpenAI Codex CLI with proper process management and streaming output parsing.
 * 
 * Implements IAgentBackend for use with the AgentRunner abstraction layer.
 */
export class CodexAgentRunner implements IAgentBackend {
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
     * Model tier to actual model name mapping for Codex backend
     * - low: Fast, cheap model for simple tasks (GPT-4.1 mini)
     * - mid: Balanced model for most tasks (GPT-4.1)
     * - high: Most capable model for complex tasks (o3)
     */
    private static readonly MODEL_TIER_MAP: Record<ModelTier, string> = {
        low: 'gpt-4.1-mini',
        mid: 'gpt-4.1',
        high: 'o3'
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
        return CodexAgentRunner.MODEL_TIER_MAP[tier] || CodexAgentRunner.MODEL_TIER_MAP.mid;
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
     * Run Codex CLI with the given prompt and options
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
     * Run Codex CLI once (internal implementation)
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

        // Build codex CLI flags
        // --approval-mode full-auto: Auto-approve all actions (edits + commands)
        // --model: Specify the model to use
        // Codex uses stdin for the prompt
        const codexFlags = `--model "${model}" --approval-mode full-auto`;
        
        if (logFile) {
            this.rotateLogIfNeeded(logFile);
        }

        onProgress?.(`🚀 Starting Codex CLI (${model})...`);
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
            this.appendToLog(logFile, `${C.gray}Backend: codex${C.reset}\n`);
            this.appendToLog(logFile, `${C.gray}---${C.reset}\n\n`);
        }

        return new Promise((resolve) => {
            let proc: ChildProcess;
            
            // Codex CLI command - pass prompt as argument (quoted)
            // Use exec mode with prompt file to avoid shell escaping issues
            const shellCmd = `codex ${codexFlags} "$(cat "${promptFile}")"; rm -f "${promptFile}"`;
            
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
                    if (idleTime >= CodexAgentRunner.IDLE_THRESHOLD_MS) {
                        const timeSinceLastLog = Date.now() - run.lastIdleLogTime;
                        if (timeSinceLastLog >= CodexAgentRunner.IDLE_LOG_INTERVAL_MS) {
                            const seconds = Math.floor(idleTime / 1000);
                            this.appendToLog(logFile, `${this.COLORS.gray}⏳ Agent working... (${seconds}s since last activity)${this.COLORS.reset}\n`);
                            run.lastIdleLogTime = Date.now();
                        }
                    }
                }, 1000);
            }

            this.processManager.registerExternalProcess(id, proc, {
                command: 'codex',
                args: ['--model', model],
                cwd,
                metadata: { ...metadata, model, promptFile, managedByCodexAgentRunner: true }
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

                // Codex outputs plain text or JSON depending on mode
                // Parse as plain text for now, collect output
                collectedOutput += text;
                onOutput?.(text, 'text');
                
                if (logFile) {
                    this.appendToLog(logFile, text);
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
     * Check if Codex CLI is available on the system
     */
    async isAvailable(): Promise<boolean> {
        const status = await this.getDependencyStatus(false);
        return status.installed;
    }
    
    /**
     * Get dependency status for Codex CLI
     * This is the authoritative source for Codex CLI availability
     * 
     * @param isCurrentBackend Whether codex is the currently active backend (affects 'required' field)
     */
    async getDependencyStatus(isCurrentBackend: boolean): Promise<BackendDependencyStatus> {
        let installed = false;
        let version: string | undefined;
        
        try {
            const { promisify } = require('util');
            const exec = promisify(require('child_process').exec);
            const { stdout } = await exec('codex --version', { timeout: 5000, windowsHide: true });
            installed = true;
            version = stdout.trim().split('\n')[0];
        } catch {
            // Try checking via npm global
            try {
                execSync('npm list -g @openai/codex', { stdio: 'ignore', timeout: 5000, windowsHide: true });
                installed = true;
            } catch {
                installed = false;
            }
        }
        
        const description = installed
            ? (isCurrentBackend 
                ? '✅ Installed and ready for codex backend'
                : 'Installed (not currently in use)')
            : (isCurrentBackend
                ? '❌ Codex CLI not installed!\n\n' +
                  'INSTALLATION:\n' +
                  '• npm install -g @openai/codex\n\n' +
                  'AUTHENTICATION:\n' +
                  '• Set OPENAI_API_KEY environment variable\n\n' +
                  '📖 Documentation: https://developers.openai.com/codex/cli'
                : 'Not needed (codex backend not in use)');
        
        return {
            name: 'Codex CLI',
            installed,
            version,
            required: isCurrentBackend,
            description,
            platform: 'all',
            installCommand: 'npm install -g @openai/codex'
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
            return { success: true, message: 'Codex CLI is already installed and available.' };
        }
        
        return {
            success: false,
            message: 'Codex CLI not found.\n\n' +
                     'Installation:\n' +
                     '1. Install via npm: npm install -g @openai/codex\n' +
                     '2. Set OPENAI_API_KEY environment variable\n' +
                     '3. Run "codex --version" to verify installation',
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
        return path.join(home, '.codex', 'mcp.json');
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
        // Codex CLI processes can be found by looking for 'codex' command
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

