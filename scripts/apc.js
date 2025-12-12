#!/usr/bin/env node
/**
 * APC - Agentic Planning Coordinator CLI
 * 
 * Cross-platform Node.js CLI for communicating with the APC daemon via WebSocket.
 * Works on Windows, macOS, and Linux without any shell dependencies.
 * 
 * Usage: node apc.js <command> [subcommand] [options]
 * 
 * Examples:
 *   apc status
 *   apc plan new "Create a feature"
 *   apc plan status <session_id>
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_PORT = 19840;
const CONNECT_TIMEOUT = 5000;
const REQUEST_TIMEOUT = 30000;

// ANSI color codes (work on all platforms with modern terminals)
const COLORS = {
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

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Print colored text
 */
function print(text, color = '') {
    if (color) {
        console.log(`${color}${text}${COLORS.reset}`);
    } else {
        console.log(text);
    }
}

/**
 * Print error message
 */
function printError(text) {
    print(`✗ Error: ${text}`, COLORS.red);
}

/**
 * Print success message
 */
function printSuccess(text) {
    print(`✓ ${text}`, COLORS.green);
}

/**
 * Print warning message
 */
function printWarning(text) {
    print(`⚠ ${text}`, COLORS.yellow);
}

/**
 * Print header box
 */
function printHeader(title) {
    print('╔══════════════════════════════════════════════════════════╗', COLORS.cyan);
    print(`║  ${title.padEnd(56)}║`, COLORS.cyan);
    print('╚══════════════════════════════════════════════════════════╝', COLORS.cyan);
    console.log('');
}

/**
 * Get workspace root by looking for markers
 */
function findWorkspaceRoot() {
    // Allow override via environment variable
    if (process.env.APC_WORKSPACE_ROOT) {
        // Don't normalize here - the hash function will normalize for comparison
        // but we need the actual path for filesystem operations
        return process.env.APC_WORKSPACE_ROOT;
    }
    
    let dir = process.cwd();
    
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, '_AiDevLog')) || 
            fs.existsSync(path.join(dir, '.git'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    
    return process.cwd();
}

/**
 * Get the correct Windows username when running in WSL
 * Needed for finding Windows temp directory
 */
function getWslWindowsUsername() {
    try {
        // Method 1: Check WSLENV or Windows environment variables that might be passed through
        // In WSL2 with interop, we can run cmd to get the Windows username
        const { execSync } = require('child_process');
        try {
            const result = execSync('cmd.exe /c echo %USERNAME%', { 
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: 5000,
                windowsHide: true
            }).trim();
            if (result && !result.includes('%')) {
                return result;
            }
        } catch {}
        
        // Method 2: Try to read from /mnt/c/Users/ to find user directories with AppData
        const usersDir = '/mnt/c/Users';
        if (fs.existsSync(usersDir)) {
            const entries = fs.readdirSync(usersDir);
            // Filter out system directories and short names (8.3 format like ADMINI~1)
            const users = entries.filter(e => 
                !['Default', 'Public', 'Default User', 'All Users'].includes(e) &&
                !e.includes('~') && // Skip 8.3 short names
                e.length > 2 && // Real usernames are longer
                fs.existsSync(path.join(usersDir, e, 'AppData', 'Local', 'Temp'))
            );
            if (users.length > 0) {
                return users[0];
            }
        }
    } catch {}
    return process.env.USER || 'default';
}

/**
 * Detect if running in WSL
 */
function isRunningInWsl() {
    try {
        // Check for WSL-specific file
        if (fs.existsSync('/proc/version')) {
            const version = fs.readFileSync('/proc/version', 'utf-8');
            return version.toLowerCase().includes('microsoft') || version.toLowerCase().includes('wsl');
        }
    } catch {}
    return false;
}

/**
 * Normalize workspace path for cross-platform daemon discovery
 * Converts WSL paths (/mnt/d/...) to Windows paths (d:\...) for consistent hashing
 * Also normalizes Windows drive letters to lowercase for consistent hashing
 */
function normalizeWorkspacePath(workspaceRoot) {
    if (isRunningInWsl() && workspaceRoot.startsWith('/mnt/')) {
        // Convert /mnt/d/path/to/workspace to d:\path\to\workspace
        const match = workspaceRoot.match(/^\/mnt\/([a-z])\/(.*)$/i);
        if (match) {
            const drive = match[1].toLowerCase();
            const rest = match[2].replace(/\//g, '\\');
            return `${drive}:\\${rest}`;
        }
    }
    
    // On Windows, normalize drive letter to lowercase for consistent hashing
    // e.g., D:\Project -> d:\Project (daemon uses lowercase)
    if (process.platform === 'win32' && /^[A-Z]:/.test(workspaceRoot)) {
        return workspaceRoot[0].toLowerCase() + workspaceRoot.slice(1);
    }
    
    return workspaceRoot;
}

/**
 * Get the temp directory for daemon files
 * In WSL, use Windows temp directory for consistency with Windows daemon
 */
function getDaemonTempDir() {
    if (isRunningInWsl()) {
        // Access Windows temp via WSL mount - need Windows username, not WSL username
        const username = getWslWindowsUsername();
        // Try common Windows temp locations via WSL
        const candidates = [
            `/mnt/c/Users/${username}/AppData/Local/Temp`,
            '/mnt/c/Windows/Temp'
        ];
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }
    return os.tmpdir();
}

/**
 * Get workspace hash for daemon identification
 * Uses normalized path for consistent hashing across Windows and WSL
 */
function getWorkspaceHash(workspaceRoot) {
    const normalizedPath = normalizeWorkspacePath(workspaceRoot);
    return crypto.createHash('md5').update(normalizedPath).digest('hex').substring(0, 8);
}

/**
 * Get daemon port from port file
 */
function getDaemonPort(workspaceRoot) {
    const hash = getWorkspaceHash(workspaceRoot);
    const tempDir = getDaemonTempDir();
    const portPath = path.join(tempDir, `apc_daemon_${hash}.port`);
    
    if (fs.existsSync(portPath)) {
        try {
            return parseInt(fs.readFileSync(portPath, 'utf-8').trim(), 10);
        } catch {
            return null;
        }
    }
    
    return null;
}

/**
 * Get daemon PID from pid file
 */
function getDaemonPid(workspaceRoot) {
    const hash = getWorkspaceHash(workspaceRoot);
    const tempDir = getDaemonTempDir();
    const pidPath = path.join(tempDir, `apc_daemon_${hash}.pid`);
    
    if (fs.existsSync(pidPath)) {
        try {
            return parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
        } catch {
            return null;
        }
    }
    
    return null;
}

/**
 * Check if daemon is running
 */
function isDaemonRunning(workspaceRoot) {
    const pid = getDaemonPid(workspaceRoot);
    const port = getDaemonPort(workspaceRoot);
    
    if (!pid || !port) {
        return false;
    }
    
    // In WSL, Windows PIDs don't exist as processes, so we can't use process.kill
    // Instead, check if port file exists (which implies daemon was started)
    // The actual connectivity will be verified when we try to connect
    if (isRunningInWsl()) {
        // In WSL, if we have both PID and port files, assume daemon is running
        // The WebSocket connection will fail if it's actually not running
        return true;
    }
    
    try {
        // Signal 0 just checks if process exists (only works on native platform)
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Generate unique request ID
 */
function generateRequestId() {
    return `cli_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// ============================================================================
// WebSocket Communication
// ============================================================================

/**
 * Send a command to the daemon and wait for response
 */
async function sendCommand(cmd, params = {}) {
    const workspaceRoot = findWorkspaceRoot();
    
    // Check if daemon is running
    if (!isDaemonRunning(workspaceRoot)) {
        throw new Error('APC daemon is not running. Start Cursor or run: apc system run --headless');
    }
    
    const port = getDaemonPort(workspaceRoot) || DEFAULT_PORT;
    const url = `ws://127.0.0.1:${port}`;
    
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, {
            headers: {
                'X-APC-Client-Type': 'cli'
            }
        });
        
        const requestId = generateRequestId();
        let timeoutHandle;
        
        // Connect timeout
        const connectTimeout = setTimeout(() => {
            ws.terminate();
            reject(new Error(`Connection timeout (${CONNECT_TIMEOUT}ms)`));
        }, CONNECT_TIMEOUT);
        
        ws.on('open', () => {
            clearTimeout(connectTimeout);
            
            // Send request
            const request = {
                type: 'request',
                payload: {
                    id: requestId,
                    cmd,
                    params,
                    clientId: 'cli'
                }
            };
            
            ws.send(JSON.stringify(request));
            
            // Response timeout
            timeoutHandle = setTimeout(() => {
                ws.close();
                reject(new Error(`Request timeout (${REQUEST_TIMEOUT}ms)`));
            }, REQUEST_TIMEOUT);
        });
        
        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                
                if (message.type === 'response' && message.payload.id === requestId) {
                    clearTimeout(timeoutHandle);
                    ws.close();
                    
                    if (message.payload.success) {
                        resolve(message.payload);
                    } else {
                        reject(new Error(message.payload.error || 'Unknown error'));
                    }
                }
            } catch (err) {
                // Ignore parse errors
            }
        });
        
        ws.on('error', (err) => {
            clearTimeout(connectTimeout);
            clearTimeout(timeoutHandle);
            reject(new Error(`WebSocket error: ${err.message}`));
        });
        
        ws.on('close', () => {
            clearTimeout(connectTimeout);
            clearTimeout(timeoutHandle);
        });
    });
}

/**
 * Display formatted response
 */
function displayResponse(response) {
    if (response.message) {
        printSuccess(response.message);
    }
    
    if (response.data) {
        if (typeof response.data === 'object') {
            console.log(JSON.stringify(response.data, null, 2));
        } else {
            console.log(response.data);
        }
    }
}

// ============================================================================
// Command Handlers
// ============================================================================

/**
 * Handle plan commands
 */
async function handlePlan(args) {
    const subCmd = args[0] || 'list';
    
    try {
        switch (subCmd) {
            case 'list':
            case 'ls': {
                print('Planning Sessions:', COLORS.cyan);
                const response = await sendCommand('plan.list', {});
                displayResponse(response);
                break;
            }
            
            case 'new':
            case 'n':
            case 'create': {
                // Parse prompt - remove flag sections
                const prompt = args.slice(1).join(' ')
                    .replace(/--docs.*?(--complexity|$)/, '')
                    .replace(/--complexity\s+\w+/, '')
                    .trim();
                if (!prompt) {
                    printError('Usage: apc plan new "<requirement>" --complexity <level> [--docs <paths>]');
                    printError('Complexity levels: tiny, small, medium, large, huge');
                    process.exit(1);
                }
                
                // Parse --complexity flag (required for proper task estimation)
                let complexity = null;
                const complexityIndex = args.indexOf('--complexity');
                if (complexityIndex !== -1 && args[complexityIndex + 1]) {
                    const level = args[complexityIndex + 1].toLowerCase();
                    const validLevels = ['tiny', 'small', 'medium', 'large', 'huge'];
                    if (validLevels.includes(level)) {
                        complexity = level;
                    } else {
                        printError(`Invalid complexity level: ${level}`);
                        printError('Valid levels: tiny (1-3 tasks), small (4-12), medium (13-25), large (26-50), huge (51+)');
                        process.exit(1);
                    }
                }
                
                // Parse --docs flag
                let docs = [];
                const docsIndex = args.indexOf('--docs');
                if (docsIndex !== -1) {
                    docs = args.slice(docsIndex + 1).filter(d => !d.startsWith('--'));
                }
                
                // Show complexity info
                if (complexity) {
                    const ranges = { tiny: '1-3', small: '4-12', medium: '13-25', large: '26-50', huge: '51+' };
                    print(`Complexity: ${complexity.toUpperCase()} (${ranges[complexity]} tasks expected)`, COLORS.cyan);
                } else {
                    print('Note: No --complexity specified. Planner will estimate scope.', COLORS.yellow);
                }
                
                printHeader('Starting Planning Session...');
                const response = await sendCommand('plan.create', { prompt, docs, complexity });
                displayResponse(response);
                break;
            }
            
            case 'status':
            case 'st': {
                const id = args[1];
                if (!id) {
                    printError('Usage: apc plan status <session_id>');
                    process.exit(1);
                }
                const response = await sendCommand('plan.status', { id });
                displayResponse(response);
                break;
            }
            
            case 'revise':
            case 'r': {
                const id = args[1];
                const feedback = args.slice(2).join(' ');
                if (!id || !feedback) {
                    printError('Usage: apc plan revise <session_id> "<feedback>"');
                    printError('');
                    printError('To change complexity, include in feedback:');
                    printError('  apc plan revise ps_001 "change complexity to medium, add more detail to T3"');
                    printError('  apc plan revise ps_001 "complexity: large - expand scope to include X"');
                    process.exit(1);
                }
                
                // Check if feedback mentions complexity change
                const complexityMatch = feedback.match(/complexity[:\s]+(\w+)/i);
                if (complexityMatch) {
                    const level = complexityMatch[1].toLowerCase();
                    const validLevels = ['tiny', 'small', 'medium', 'large', 'huge'];
                    if (validLevels.includes(level)) {
                        const ranges = { tiny: '1-3', small: '4-12', medium: '13-25', large: '26-50', huge: '51+' };
                        print(`Complexity change detected: ${level.toUpperCase()} (${ranges[level]} tasks)`, COLORS.cyan);
                    }
                }
                
                const response = await sendCommand('plan.revise', { id, feedback });
                displayResponse(response);
                break;
            }
            
            case 'approve':
            case 'a': {
                const id = args[1];
                const autoStart = args.includes('--auto-start') || args.includes('-a');
                if (!id) {
                    printError('Usage: apc plan approve <session_id> [--auto-start]');
                    process.exit(1);
                }
                const response = await sendCommand('plan.approve', { id, autoStart });
                displayResponse(response);
                break;
            }
            
            case 'cancel':
            case 'c': {
                const id = args[1];
                if (!id) {
                    printError('Usage: apc plan cancel <session_id>');
                    process.exit(1);
                }
                const response = await sendCommand('plan.cancel', { id });
                displayResponse(response);
                break;
            }
            
            default:
                print('Usage: apc plan [list|new|status|revise|approve|cancel]', COLORS.yellow);
                console.log('');
                console.log('  list              List all planning sessions');
                console.log('  new "<prompt>"    Start new planning session');
                console.log('  status <id>       Get session status');
                console.log('  revise <id> ".."  Revise plan with feedback');
                console.log('  approve <id>      Approve plan for execution');
                console.log('  cancel <id>       Cancel planning session');
        }
    } catch (err) {
        printError(err.message);
        process.exit(1);
    }
}

/**
 * Handle exec commands
 */
async function handleExec(args) {
    const subCmd = args[0] || 'status';
    
    try {
        switch (subCmd) {
            case 'start':
            case 's': {
                const sessionId = args[1];
                if (!sessionId) {
                    printError('Usage: apc exec start <session_id>');
                    process.exit(1);
                }
                print(`Starting execution for ${sessionId}...`, COLORS.cyan);
                const response = await sendCommand('exec.start', { sessionId });
                displayResponse(response);
                break;
            }
            
            case 'status':
            case 'st': {
                const sessionId = args[1];
                if (!sessionId) {
                    printError('Usage: apc exec status <session_id>');
                    process.exit(1);
                }
                const response = await sendCommand('exec.status', { sessionId });
                displayResponse(response);
                break;
            }
            
            case 'pause':
            case 'p': {
                const sessionId = args[1];
                if (!sessionId) {
                    printError('Usage: apc exec pause <session_id>');
                    process.exit(1);
                }
                const response = await sendCommand('exec.pause', { sessionId });
                displayResponse(response);
                break;
            }
            
            case 'resume':
            case 'r': {
                const sessionId = args[1];
                if (!sessionId) {
                    printError('Usage: apc exec resume <session_id>');
                    process.exit(1);
                }
                const response = await sendCommand('exec.resume', { sessionId });
                displayResponse(response);
                break;
            }
            
            case 'stop':
            case 'x': {
                const sessionId = args[1];
                if (!sessionId) {
                    printError('Usage: apc exec stop <session_id>');
                    process.exit(1);
                }
                const response = await sendCommand('exec.stop', { sessionId });
                displayResponse(response);
                break;
            }
            
            default:
                print('Usage: apc exec [start|status|pause|resume|stop]', COLORS.yellow);
                console.log('');
                console.log('  start <id>    Start execution for approved plan');
                console.log('  status <id>   Get execution status');
                console.log('  pause <id>    Pause execution');
                console.log('  resume <id>   Resume paused execution');
                console.log('  stop <id>     Stop execution');
        }
    } catch (err) {
        printError(err.message);
        process.exit(1);
    }
}

/**
 * Handle workflow commands
 */
async function handleWorkflow(args) {
    const subCmd = args[0] || 'list';
    
    try {
        switch (subCmd) {
            case 'list':
            case 'ls': {
                const sessionId = args[1];
                if (!sessionId) {
                    printError('Usage: apc workflow list <session_id>');
                    process.exit(1);
                }
                const response = await sendCommand('workflow.list', { sessionId });
                displayResponse(response);
                break;
            }
            
            case 'status':
            case 'st': {
                const sessionId = args[1];
                const workflowId = args[2];
                if (!sessionId || !workflowId) {
                    printError('Usage: apc workflow status <session_id> <workflow_id>');
                    process.exit(1);
                }
                const response = await sendCommand('workflow.status', { sessionId, workflowId });
                displayResponse(response);
                break;
            }
            
            case 'cancel':
            case 'c': {
                const sessionId = args[1];
                const workflowId = args[2];
                if (!sessionId || !workflowId) {
                    printError('Usage: apc workflow cancel <session_id> <workflow_id>');
                    process.exit(1);
                }
                const response = await sendCommand('workflow.cancel', { sessionId, workflowId });
                displayResponse(response);
                break;
            }
            
            case 'summarize':
            case 'sum': {
                // Parse named parameters
                const params = parseNamedParams(args.slice(1), ['session', 'workflow', 'summary']);
                if (!params.session || !params.workflow || !params.summary) {
                    printError('Usage: apc workflow summarize --session <id> --workflow <id> --summary "<text>"');
                    process.exit(1);
                }
                const response = await sendCommand('workflow.summarize', {
                    sessionId: params.session,
                    workflowId: params.workflow,
                    summary: params.summary
                });
                displayResponse(response);
                break;
            }
            
            default:
                print('Usage: apc workflow [list|status|cancel|summarize]', COLORS.yellow);
        }
    } catch (err) {
        printError(err.message);
        process.exit(1);
    }
}

/**
 * Handle task commands
 */
async function handleTask(args) {
    const subCmd = args[0] || 'list';
    
    try {
        switch (subCmd) {
            case 'list':
            case 'ls': {
                const session = args[1];
                const response = await sendCommand('task.list', session ? { session } : {});
                displayResponse(response);
                break;
            }
            
            case 'create':
            case 'c': {
                const params = parseNamedParams(args.slice(1), ['session', 'id', 'desc', 'deps', 'type', 'priority', 'error-text', 'unity']);
                if (!params.session || !params.id || !params.desc) {
                    printError('Usage: apc task create --session <id> --id <taskId> --desc "description" [--deps T1,T2] [--type implementation|error_fix] [--unity none|prep|prep_editmode|prep_playmode|prep_playtest|full]');
                    process.exit(1);
                }
                const response = await sendCommand('task.create', {
                    session: params.session,
                    id: params.id,
                    desc: params.desc,
                    deps: params.deps,
                    type: params.type || 'implementation',
                    priority: params.priority ? parseInt(params.priority, 10) : undefined,
                    errorText: params['error-text'],
                    unity: params.unity
                });
                displayResponse(response);
                break;
            }
            
            case 'start':
            case 's': {
                const params = parseNamedParams(args.slice(1), ['session', 'id', 'workflow', 'input']);
                if (!params.session || !params.id) {
                    printError('Usage: apc task start --session <id> --id <taskId> [--workflow task_implementation] [--input JSON]');
                    process.exit(1);
                }
                // Parse input JSON if provided (for context_gathering workflows)
                let parsedInput = undefined;
                if (params.input) {
                    try {
                        parsedInput = JSON.parse(params.input);
                    } catch (e) {
                        printError(`Invalid JSON in --input: ${e.message}`);
                        process.exit(1);
                    }
                }
                const response = await sendCommand('task.start', {
                    session: params.session,
                    id: params.id,
                    workflow: params.workflow || 'task_implementation',
                    input: parsedInput
                });
                displayResponse(response);
                break;
            }
            
            case 'complete':
            case 'done': {
                const params = parseNamedParams(args.slice(1), ['session', 'id', 'summary']);
                if (!params.session || !params.id) {
                    printError('Usage: apc task complete --session <id> --id <taskId> [--summary "Done"]');
                    process.exit(1);
                }
                const response = await sendCommand('task.complete', {
                    session: params.session,
                    id: params.id,
                    summary: params.summary
                });
                displayResponse(response);
                break;
            }
            
            case 'status':
            case 'st': {
                // Support both positional and named parameters
                let session, taskId;
                if (args[1] && args[1].startsWith('--')) {
                    const params = parseNamedParams(args.slice(1), ['session', 'id', 'task']);
                    session = params.session;
                    taskId = params.id || params.task;
                } else {
                    session = args[1];
                    taskId = args[2];
                }
                
                if (!session || !taskId) {
                    printError('Usage: apc task status <session_id> <task_id>');
                    process.exit(1);
                }
                const response = await sendCommand('task.status', { session, task: taskId });
                displayResponse(response);
                break;
            }
            
            case 'fail':
            case 'f': {
                const params = parseNamedParams(args.slice(1), ['session', 'id', 'reason']);
                if (!params.session || !params.id || !params.reason) {
                    printError('Usage: apc task fail --session <id> --id <taskId> --reason "why it failed"');
                    process.exit(1);
                }
                const response = await sendCommand('task.fail', {
                    session: params.session,
                    task: params.id,
                    reason: params.reason
                });
                displayResponse(response);
                break;
            }
            
            case 'update':
            case 'u': {
                const params = parseNamedParams(args.slice(1), ['session', 'id', 'desc', 'deps']);
                if (!params.session || !params.id) {
                    printError('Usage: apc task update --session <id> --id <taskId> [--desc "new description"] [--deps T1,T2]');
                    process.exit(1);
                }
                if (!params.desc && !params.deps) {
                    printError('At least one of --desc or --deps must be provided');
                    process.exit(1);
                }
                const response = await sendCommand('task.update', {
                    session: params.session,
                    id: params.id,
                    desc: params.desc,
                    deps: params.deps
                });
                displayResponse(response);
                break;
            }
            
            case 'remove':
            case 'rm': {
                const params = parseNamedParams(args.slice(1), ['session', 'id', 'reason']);
                if (!params.session || !params.id) {
                    printError('Usage: apc task remove --session <id> --id <taskId> [--reason "why removed"]');
                    process.exit(1);
                }
                const response = await sendCommand('task.remove', {
                    session: params.session,
                    id: params.id,
                    reason: params.reason
                });
                displayResponse(response);
                break;
            }
            
            case 'add-dep': {
                const params = parseNamedParams(args.slice(1), ['session', 'task', 'depends-on']);
                if (!params.session || !params.task || !params['depends-on']) {
                    printError('Usage: apc task add-dep --session <id> --task <taskId> --depends-on <depId>');
                    process.exit(1);
                }
                const response = await sendCommand('task.addDep', {
                    session: params.session,
                    task: params.task,
                    dependsOn: params['depends-on']
                });
                displayResponse(response);
                break;
            }
            
            default:
                print('Usage: apc task [list|create|start|complete|fail|update|remove|add-dep|status]', COLORS.yellow);
                console.log('');
                console.log('  list [session]              List all tasks (optionally for a session)');
                console.log('  create --session <id> --id <taskId> --desc "..."');
                console.log('  start --session <id> --id <taskId>');
                console.log('  complete --session <id> --id <taskId> [--summary "..."]');
                console.log('  fail --session <id> --id <taskId> --reason "..."');
                console.log('  update --session <id> --id <taskId> [--desc "..."] [--deps T1,T2]');
                console.log('  remove --session <id> --id <taskId> [--reason "..."]');
                console.log('  add-dep --session <id> --task <taskId> --depends-on <depId>');
                console.log('  status <session_id> <task_id>');
        }
    } catch (err) {
        printError(err.message);
        process.exit(1);
    }
}

/**
 * Handle task-agent commands
 */
async function handleTaskAgent(args) {
    const subCmd = args[0] || 'status';
    
    try {
        switch (subCmd) {
            case 'evaluate':
            case 'eval': {
                const params = parseNamedParams(args.slice(1), ['session', 'reason']);
                if (!params.session) {
                    printError('Usage: apc task-agent evaluate --session <id> [--reason "why evaluation needed"]');
                    process.exit(1);
                }
                const response = await sendCommand('taskAgent.evaluate', {
                    session: params.session,
                    reason: params.reason
                });
                displayResponse(response);
                break;
            }
            
            case 'status':
            case 'st': {
                const params = parseNamedParams(args.slice(1), ['session']);
                if (!params.session) {
                    printError('Usage: apc task-agent status --session <id>');
                    process.exit(1);
                }
                const response = await sendCommand('taskAgent.status', {
                    session: params.session
                });
                displayResponse(response);
                break;
            }
            
            default:
                print('Usage: apc task-agent [evaluate|status]', COLORS.yellow);
                console.log('');
                console.log('  evaluate --session <id> [--reason "..."]  Trigger TaskAgent to verify/sync tasks');
                console.log('  status --session <id>                     Check TaskAgent status for session');
        }
    } catch (err) {
        printError(err.message);
        process.exit(1);
    }
}

/**
 * Handle pool commands
 */
async function handlePool(args) {
    const subCmd = args[0] || 'status';
    
    try {
        switch (subCmd) {
            case 'status':
            case 'st': {
                const response = await sendCommand('pool.status', {});
                displayResponse(response);
                break;
            }
            
            case 'resize':
            case 'r': {
                const size = parseInt(args[1], 10);
                if (isNaN(size)) {
                    printError('Usage: apc pool resize <size>');
                    process.exit(1);
                }
                const response = await sendCommand('pool.resize', { size });
                displayResponse(response);
                break;
            }
            
            default:
                print('Usage: apc pool [status|resize]', COLORS.yellow);
        }
    } catch (err) {
        printError(err.message);
        process.exit(1);
    }
}

/**
 * Handle agent commands
 */
async function handleAgent(args) {
    const subCmd = args[0] || 'pool';
    
    try {
        switch (subCmd) {
            case 'pool':
            case 'p': {
                const response = await sendCommand('agent.pool', {});
                displayResponse(response);
                break;
            }
            
            case 'roles':
            case 'r': {
                const response = await sendCommand('agent.roles', {});
                displayResponse(response);
                break;
            }
            
            case 'release': {
                const agentName = args[1];
                if (!agentName) {
                    printError('Usage: apc agent release <agent_name>');
                    process.exit(1);
                }
                const response = await sendCommand('agent.release', { agentName });
                displayResponse(response);
                break;
            }
            
            case 'complete':
            case 'c': {
                const params = parseNamedParams(args.slice(1), ['session', 'workflow', 'stage', 'task', 'result', 'data']);
                if (!params.session || !params.workflow || !params.stage || !params.result) {
                    printError('Usage: apc agent complete --session <id> --workflow <id> --stage <stage> --result <result> [--task <id>] [--data \'<json>\']');
                    process.exit(1);
                }
                
                let data = {};
                if (params.data) {
                    try {
                        data = JSON.parse(params.data);
                    } catch {
                        printError('Invalid JSON in --data parameter');
                        process.exit(1);
                    }
                }
                
                const response = await sendCommand('agent.complete', {
                    session: params.session,
                    workflow: params.workflow,
                    stage: params.stage,
                    task: params.task,
                    result: params.result,
                    data
                });
                displayResponse(response);
                break;
            }
            
            default:
                print('Usage: apc agent [pool|roles|release|complete]', COLORS.yellow);
        }
    } catch (err) {
        printError(err.message);
        process.exit(1);
    }
}

/**
 * Handle user interaction commands (ask/respond for clarifications)
 */
async function handleUser(args) {
    const subCmd = args[0] || 'help';
    
    try {
        switch (subCmd) {
            case 'ask': {
                const params = parseNamedParams(args.slice(1), ['session', 'task', 'question', 'context']);
                if (!params.session || !params.task || !params.question) {
                    printError('Usage: apc user ask --session <id> --task <id> --question "..." [--context "..."]');
                    process.exit(1);
                }
                const response = await sendCommand('user.ask', {
                    session: params.session,
                    task: params.task,
                    question: params.question,
                    context: params.context
                });
                displayResponse(response);
                break;
            }
            
            case 'respond': {
                const params = parseNamedParams(args.slice(1), ['session', 'task', 'id', 'response']);
                if (!params.session || !params.task || !params.response) {
                    printError('Usage: apc user respond --session <id> --task <id> [--id <questionId>] --response "..."');
                    process.exit(1);
                }
                const response = await sendCommand('user.respond', {
                    session: params.session,
                    task: params.task,
                    questionId: params.id,
                    response: params.response
                });
                displayResponse(response);
                break;
            }
            
            default:
                print('Usage: apc user [ask|respond]', COLORS.yellow);
                print('', COLORS.reset);
                print('Commands:', COLORS.cyan);
                print('  ask      --session <s> --task <t> --question "..."', COLORS.reset);
                print('           Ask user for clarification about a task', COLORS.reset);
                print('  respond  --session <s> --task <t> --response "..."', COLORS.reset);
                print('           Provide answer to pending question', COLORS.reset);
        }
    } catch (err) {
        printError(err.message);
        process.exit(1);
    }
}

/**
 * Handle unity commands
 */
async function handleUnity(args) {
    const subCmd = args[0] || 'status';
    
    try {
        switch (subCmd) {
            case 'status':
            case 'st': {
                const response = await sendCommand('unity.status', {});
                displayResponse(response);
                break;
            }
            
            case 'compile':
            case 'c': {
                const response = await sendCommand('unity.compile', {});
                displayResponse(response);
                break;
            }
            
            case 'test':
            case 't': {
                const mode = args[1] || 'editmode';
                const response = await sendCommand('unity.test', { mode });
                displayResponse(response);
                break;
            }
            
            default:
                print('Usage: apc unity [status|compile|test]', COLORS.yellow);
        }
    } catch (err) {
        printError(err.message);
        process.exit(1);
    }
}

/**
 * Handle session commands
 */
async function handleSession(args) {
    const subCmd = args[0] || 'list';
    
    try {
        switch (subCmd) {
            case 'list':
            case 'ls': {
                const response = await sendCommand('session.list', {});
                displayResponse(response);
                break;
            }
            
            case 'status':
            case 'st': {
                const id = args[1];
                if (!id) {
                    printError('Usage: apc session status <session_id>');
                    process.exit(1);
                }
                const response = await sendCommand('session.status', { id });
                displayResponse(response);
                break;
            }
            
            case 'pause':
            case 'p': {
                const id = args[1];
                if (!id) {
                    printError('Usage: apc session pause <session_id>');
                    process.exit(1);
                }
                const response = await sendCommand('session.pause', { id });
                displayResponse(response);
                break;
            }
            
            case 'resume':
            case 'r': {
                const id = args[1];
                if (!id) {
                    printError('Usage: apc session resume <session_id>');
                    process.exit(1);
                }
                const response = await sendCommand('session.resume', { id });
                displayResponse(response);
                break;
            }
            
            default:
                print('Usage: apc session [list|status|pause|resume]', COLORS.yellow);
        }
    } catch (err) {
        printError(err.message);
        process.exit(1);
    }
}

/**
 * Handle config commands
 */
async function handleConfig(args) {
    const subCmd = args[0] || 'get';
    
    try {
        switch (subCmd) {
            case 'get':
            case 'g': {
                const key = args[1];
                const response = await sendCommand('config.get', key ? { key } : {});
                displayResponse(response);
                break;
            }
            
            case 'set':
            case 's': {
                const key = args[1];
                const value = args[2];
                if (!key || !value) {
                    printError('Usage: apc config set <key> <value>');
                    process.exit(1);
                }
                const response = await sendCommand('config.set', { key, value });
                displayResponse(response);
                break;
            }
            
            case 'reset':
            case 'r': {
                const key = args[1];
                const response = await sendCommand('config.reset', key ? { key } : {});
                displayResponse(response);
                break;
            }
            
            case 'folders':
            case 'f': {
                await handleConfigFolders(args.slice(1));
                break;
            }
            
            default:
                print('Usage: apc config [get|set|reset|folders]', COLORS.yellow);
                console.log('');
                console.log('  get [key]          Get config (all or specific key)');
                console.log('  set <key> <value>  Set config value');
                console.log('  reset [key]        Reset to default (all or specific key)');
                console.log('  folders <sub>      Manage folder structure');
        }
    } catch (err) {
        printError(err.message);
        process.exit(1);
    }
}

/**
 * Handle config folders subcommands
 */
async function handleConfigFolders(args) {
    const subCmd = args[0] || 'get';
    
    try {
        switch (subCmd) {
            case 'get':
            case 'g': {
                const folder = args[1];
                const response = await sendCommand('folders.get', folder ? { folder } : {});
                displayResponse(response);
                break;
            }
            
            case 'set':
            case 's': {
                const folder = args[1];
                const name = args[2];
                if (!folder || !name) {
                    printError('Usage: apc config folders set <folder> <name>');
                    process.exit(1);
                }
                const response = await sendCommand('folders.set', { folder, name });
                displayResponse(response);
                break;
            }
            
            case 'reset':
            case 'r': {
                const folder = args[1];
                const response = await sendCommand('folders.reset', folder ? { folder } : {});
                displayResponse(response);
                break;
            }
            
            default:
                print('Usage: apc config folders [get|set|reset]', COLORS.yellow);
        }
    } catch (err) {
        printError(err.message);
        process.exit(1);
    }
}

/**
 * Handle daemon commands (daemon lifecycle management)
 */
async function handleDaemon(args) {
    const subCmd = args[0] || 'status';
    const workspaceRoot = findWorkspaceRoot();
    
    switch (subCmd) {
        case 'status':
        case 'st': {
            printHeader('APC Daemon Status');
            
            // Check if daemon is running (file-based check)
            if (!isDaemonRunning(workspaceRoot)) {
                printWarning('Daemon is not running.');
                print('Run \'apc daemon run --headless\' to start the daemon.', COLORS.gray);
                process.exit(1);
            }
            
            const port = getDaemonPort(workspaceRoot);
            const pid = getDaemonPid(workspaceRoot);
            
            // Try to get detailed status from daemon
            try {
                const response = await sendCommand('daemon.status', {});
                console.log(`  ${COLORS.green}●${COLORS.reset} Daemon Running`);
                console.log(`  PID:       ${pid}`);
                console.log(`  Port:      ${port}`);
                console.log(`  Workspace: ${workspaceRoot}`);
                console.log('');
                displayResponse(response);
            } catch (err) {
                // Daemon process exists but not responding
                printWarning('Daemon process exists but not responding');
                console.log(`  PID:  ${pid}`);
                console.log(`  Port: ${port}`);
                console.log(`  Error: ${err.message}`);
                print('Try \'apc daemon restart\' to fix connection issues.', COLORS.gray);
            }
            break;
        }
        
        case 'run':
        case 'start': {
            // Parse options
            let mode = 'headless';
            let port = null;
            let verbose = false;
            let force = false;
            
            for (let i = 1; i < args.length; i++) {
                const arg = args[i];
                switch (arg) {
                    case '--headless':
                    case '-h':
                        mode = 'headless';
                        break;
                    case '--vscode':
                    case '-v':
                        mode = 'vscode';
                        break;
                    case '--interactive':
                    case '-i':
                        mode = 'interactive';
                        break;
                    case '--port':
                    case '-p':
                        port = parseInt(args[++i], 10);
                        break;
                    case '--verbose':
                        verbose = true;
                        break;
                    case '--force':
                    case '-f':
                        force = true;
                        break;
                }
            }
            
            printHeader(`Starting APC Daemon (${mode} mode)`);
            
            // Check if daemon is already running (unless --force)
            if (!force && isDaemonRunning(workspaceRoot)) {
                const existingPort = getDaemonPort(workspaceRoot);
                printSuccess(`Daemon already running on port ${existingPort}`);
                print('Use --force to restart', COLORS.gray);
                return;
            }
            
            // Find start script
            const scriptDir = path.dirname(__filename);
            let startScript = path.join(scriptDir, '..', 'out', 'daemon', 'start.js');
            
            if (!fs.existsSync(startScript)) {
                startScript = path.join(scriptDir, 'out', 'daemon', 'start.js');
            }
            
            if (!fs.existsSync(startScript)) {
                printError('Daemon start script not found.');
                print('Make sure the extension is compiled: npm run compile', COLORS.yellow);
                process.exit(1);
            }
            
            // Build command arguments
            const cmdArgs = [startScript, `--${mode}`, workspaceRoot];
            if (port) cmdArgs.push('--port', port.toString());
            if (verbose) cmdArgs.push('--verbose');
            if (force) cmdArgs.push('--force');
            
            print(`Starting: node ${cmdArgs.join(' ')}`, COLORS.gray);
            console.log('');
            
            // Execute
            const proc = spawn('node', cmdArgs, {
                detached: true,
                stdio: mode === 'headless' ? 'ignore' : 'inherit',
                windowsHide: mode === 'headless'  // Hide window in headless mode
            });
            
            if (mode === 'headless') {
                proc.unref();
                
                // Wait for daemon to start
                await new Promise(r => setTimeout(r, 2000));
                
                if (isDaemonRunning(workspaceRoot)) {
                    const runningPort = getDaemonPort(workspaceRoot);
                    printSuccess(`Daemon started on port ${runningPort}`);
                } else {
                    printError('Daemon failed to start. Check logs for details.');
                    process.exit(1);
                }
            }
            break;
        }
        
        case 'stop': {
            printHeader('Stopping APC Daemon');
            
            if (!isDaemonRunning(workspaceRoot)) {
                printWarning('Daemon is not running');
                return;
            }
            
            const pid = getDaemonPid(workspaceRoot);
            print(`Stopping daemon (PID: ${pid})...`, COLORS.cyan);
            
            try {
                if (process.platform === 'win32') {
                    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true });
                } else {
                    process.kill(pid, 'SIGTERM');
                }
                
                // Wait for shutdown
                await new Promise(r => setTimeout(r, 1000));
                
                if (!isDaemonRunning(workspaceRoot)) {
                    printSuccess('Daemon stopped');
                } else {
                    printWarning('Daemon may still be running (force kill required)');
                }
            } catch (err) {
                printError(`Failed to stop daemon: ${err.message}`);
            }
            break;
        }
        
        case 'restart': {
            print('Restarting daemon...', COLORS.cyan);
            
            // Stop first
            if (isDaemonRunning(workspaceRoot)) {
                const pid = getDaemonPid(workspaceRoot);
                try {
                    if (process.platform === 'win32') {
                        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true });
                    } else {
                        process.kill(pid, 'SIGTERM');
                    }
                    // Wait briefly
                    await new Promise(r => setTimeout(r, 1000));
                } catch {
                    // Ignore errors
                }
            }
            
            // Start with remaining args
            await handleDaemon(['run', ...args.slice(1)]);
            break;
        }
        
        default:
            print('Usage: apc daemon [status|run|stop|restart]', COLORS.yellow);
            console.log('');
            console.log('  status            Show daemon status (detailed)');
            console.log('');
            console.log('  run [options]     Start the daemon');
            console.log('    --headless      Headless mode (automation, scripts)');
            console.log('    --vscode        VS Code mode (extension integration)');
            console.log('    --interactive   Interactive CLI mode (future)');
            console.log('    --port <port>   Override port (default: 19840)');
            console.log('    --force         Force restart if already running');
            console.log('    --verbose       Enable verbose logging');
            console.log('');
            console.log('  stop              Stop the running daemon');
            console.log('  restart           Restart the daemon');
            console.log('');
            print('Examples:', COLORS.green);
            console.log('  apc daemon status');
            console.log('  apc daemon run --headless');
            console.log('  apc daemon run --headless --port 19841');
            console.log('  apc daemon stop');
    }
}

/**
 * Print help message
 */
function printHelp() {
    printHeader(`${COLORS.bold}APC - Agentic Planning Coordinator${COLORS.reset}${COLORS.cyan}`);
    
    console.log('Usage: apc <command> [subcommand] [options]');
    console.log('');
    
    print('Daemon:', COLORS.green);
    console.log('  daemon status             Show daemon status (detailed)');
    console.log('  daemon run --headless     Start daemon (headless mode)');
    console.log('  daemon run --vscode       Start daemon (VS Code mode)');
    console.log('  daemon stop               Stop the daemon');
    console.log('  daemon restart            Restart the daemon');
    console.log('');
    
    print('Planning:', COLORS.green);
    console.log('  plan list           List all planning sessions');
    console.log('  plan new "<prompt>" Start new planning session');
    console.log('  plan status <id>    Get session status');
    console.log('  plan revise <id>    Revise plan with feedback');
    console.log('  plan approve <id>   Approve plan for execution');
    console.log('  plan cancel <id>    Cancel planning session');
    console.log('');
    
    print('Execution:', COLORS.green);
    console.log('  exec start <id>     Start execution');
    console.log('  exec status <id>    Get execution status');
    console.log('  exec pause <id>     Pause execution');
    console.log('  exec resume <id>    Resume execution');
    console.log('  exec stop <id>      Stop execution');
    console.log('');
    
    print('Workflows:', COLORS.green);
    console.log('  workflow list <id>  List workflows for session');
    console.log('  workflow status     Get workflow status');
    console.log('  workflow cancel     Cancel a workflow');
    console.log('');
    
    print('Tasks:', COLORS.green);
    console.log('  task list [session] List all tasks');
    console.log('  task create ...     Create a new task');
    console.log('  task start ...      Start a task workflow');
    console.log('  task complete ...   Mark task complete');
    console.log('  task status <s> <t> Get task status');
    console.log('');
    
    print('Agents:', COLORS.green);
    console.log('  pool status         Show agent pool status');
    console.log('  pool resize <n>     Resize agent pool');
    console.log('  agent roles         List available roles');
    console.log('  agent release <n>   Release agent back to pool');
    console.log('');
    
    print('Config:', COLORS.green);
    console.log('  config get [key]          Get config (all or specific)');
    console.log('  config set <key> <value>  Set config value');
    console.log('  config reset [key]        Reset to default');
    console.log('  config folders get        Show folder structure');
    console.log('');
    
    print('Unity:', COLORS.green);
    console.log('  unity status        Unity control status');
    console.log('  unity compile       Queue compilation');
    console.log('  unity test <mode>   Queue tests (editmode/playmode)');
    console.log('');
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Parse named parameters (--key value)
 */
function parseNamedParams(args, knownParams) {
    const result = {};
    
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        
        if (arg.startsWith('--')) {
            const key = arg.substring(2);
            if (knownParams.includes(key) && i + 1 < args.length && !args[i + 1].startsWith('--')) {
                result[key] = args[++i];
            }
        } else if (arg.startsWith('-') && arg.length === 2) {
            // Short form: -s for --session, -w for --workflow, etc.
            const shortMap = {
                's': 'session',
                'w': 'workflow',
                'i': 'id',
                't': 'task',
                'd': 'desc',
                'r': 'result',
                'p': 'priority'
            };
            const key = shortMap[arg[1]];
            if (key && knownParams.includes(key) && i + 1 < args.length && !args[i + 1].startsWith('-')) {
                result[key] = args[++i];
            }
        }
    }
    
    return result;
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
    const args = process.argv.slice(2);
    const command = args[0] || 'help';
    const subArgs = args.slice(1);
    
    switch (command) {
        case 'plan':
        case 'p':
            await handlePlan(subArgs);
            break;
            
        case 'exec':
        case 'e':
        case 'run':
            await handleExec(subArgs);
            break;
            
        case 'workflow':
        case 'wf':
            await handleWorkflow(subArgs);
            break;
            
        case 'task':
        case 't':
            await handleTask(subArgs);
            break;
            
        case 'task-agent':
        case 'ta':
            await handleTaskAgent(subArgs);
            break;
            
        case 'pool':
            await handlePool(subArgs);
            break;
            
        case 'agent':
        case 'a':
            await handleAgent(subArgs);
            break;
            
        case 'unity':
        case 'u':
            await handleUnity(subArgs);
            break;
            
        case 'user':
            await handleUser(subArgs);
            break;
            
        case 'session':
        case 'sess':
            await handleSession(subArgs);
            break;
            
        case 'config':
        case 'cfg':
            await handleConfig(subArgs);
            break;
            
        case 'daemon':
        case 'd':
            await handleDaemon(subArgs);
            break;
            
        case 'help':
        case '--help':
        case '-h':
        case 'h':
            printHelp();
            break;
            
        default:
            printError(`Unknown command: ${command}`);
            console.log('Use \'apc help\' for available commands.');
            process.exit(1);
    }
}

// Run
main().catch(err => {
    printError(err.message);
    process.exit(1);
});

