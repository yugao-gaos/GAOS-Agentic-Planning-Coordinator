import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CliHandler } from '../cli/CliHandler';
import { StateManager } from './StateManager';

interface CliRequest {
    id: string;
    command: string;
    args: any;
    timestamp: string;
}

interface CliResponse {
    requestId: string;
    success: boolean;
    message?: string;
    data?: any;
    error?: string;
    timestamp: string;
}

export class CliIpcService {
    private stateManager: StateManager;
    private cliHandler: CliHandler;
    private ipcDir: string;
    private requestFile: string;
    private responseFile: string;
    private watcher: fs.FSWatcher | null = null;
    private lastProcessedRequestId: string = '';

    constructor(stateManager: StateManager, cliHandler: CliHandler) {
        this.stateManager = stateManager;
        this.cliHandler = cliHandler;
        
        // Use /tmp for IPC files to keep project clean
        // Hash workspace root to avoid conflicts between projects
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const hash = crypto.createHash('md5').update(workspaceRoot).digest('hex').substring(0, 8);
        this.ipcDir = `/tmp/apc_ipc_${hash}`;
        
        // Ensure IPC directory exists
        if (!fs.existsSync(this.ipcDir)) {
            fs.mkdirSync(this.ipcDir, { recursive: true });
        }
        
        this.requestFile = path.join(this.ipcDir, 'request.json');
        this.responseFile = path.join(this.ipcDir, 'response.json');
    }

    start(): void {
        const vscode = require('vscode');
        console.log('CliIpcService: Starting file watcher');
        
        console.log(`CliIpcService: IPC directory: ${this.ipcDir}`);
        console.log(`CliIpcService: Request file: ${this.requestFile}`);
        console.log(`CliIpcService: Response file: ${this.responseFile}`);

        // Process any existing request on startup
        this.checkForRequest();

        // Watch for changes to the request file in /tmp
        try {
            this.watcher = fs.watch(this.ipcDir, { persistent: true }, (eventType, filename) => {
                if (filename === 'request.json') {
                    // Small delay to ensure file is fully written
                    setTimeout(() => this.checkForRequest(), 100);
                }
            });

            // Also poll periodically in case fs.watch misses events (every 500ms)
            this.pollInterval = setInterval(() => this.checkForRequest(), 500);

            console.log('CliIpcService: File watcher started successfully');
            vscode.window.showInformationMessage('APC ready! Use: apc plan new "requirement"');
        } catch (error) {
            console.error('CliIpcService: Failed to start file watcher:', error);
            vscode.window.showErrorMessage(`APC IPC Service failed: ${error}`);
        }
    }

    private pollInterval: NodeJS.Timeout | null = null;

    stop(): void {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }

    private async checkForRequest(): Promise<void> {
        try {
            if (!fs.existsSync(this.requestFile)) {
                return;
            }

            const content = fs.readFileSync(this.requestFile, 'utf-8');
            let request: CliRequest;
            try {
                request = JSON.parse(content);
            } catch (parseError) {
                console.error('CliIpcService: Failed to parse request JSON:', parseError);
                return;
            }

            // Skip if already processed
            if (request.id === this.lastProcessedRequestId) {
                return;
            }

            const vscode = require('vscode');
            console.log(`CliIpcService: Processing request ${request.id}: ${request.command}`);
            vscode.window.showInformationMessage(`APC: Processing ${request.command}...`);
            
            this.lastProcessedRequestId = request.id;

            // Process the request
            const response = await this.processRequest(request);

            // Write response
            this.writeResponse(response);
            
            // Clean up request file after processing
            try {
                fs.unlinkSync(this.requestFile);
            } catch (e) {
                // Ignore cleanup errors
            }
            
            console.log(`CliIpcService: Completed request ${request.id}`);

        } catch (error) {
            console.error('CliIpcService: Error processing request:', error);
            const vscode = require('vscode');
            vscode.window.showErrorMessage(`APC Error: ${error}`);
        }
    }

    private async processRequest(request: CliRequest): Promise<CliResponse> {
        try {
            const [category, action] = request.command.split('.');
            
            let result: any;

            switch (category) {
                case 'status':
                    result = await this.handleStatus();
                    break;
                case 'plan':
                    result = await this.handlePlan(action, request.args);
                    break;
                case 'coordinator':
                    result = await this.handleCoordinator(action, request.args);
                    break;
                case 'pool':
                    result = await this.handlePool(action, request.args);
                    break;
                case 'engineer':
                    result = await this.handleEngineer(action, request.args);
                    break;
                case 'unity':
                    result = await this.handleUnity(action, request.args);
                    break;
                default:
                    return {
                        requestId: request.id,
                        success: false,
                        error: `Unknown command category: ${category}`,
                        timestamp: new Date().toISOString()
                    };
            }

            return {
                requestId: request.id,
                success: result.success !== false,
                message: result.message,
                data: result.data,
                error: result.error,
                timestamp: new Date().toISOString()
            };

        } catch (error) {
            return {
                requestId: request.id,
                success: false,
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString()
            };
        }
    }

    private async handleStatus(): Promise<any> {
        const args = ['status'];
        return this.cliHandler.handleCommand(args);
    }

    private async handlePlan(action: string, args: any): Promise<any> {
        switch (action) {
            case 'list':
                return this.cliHandler.handleCommand(['plan', 'list']);
            case 'new':
                const newArgs = ['plan', 'start', '--prompt', args.prompt || ''];
                // Pass docs if provided
                if (args.docs && Array.isArray(args.docs) && args.docs.length > 0) {
                    newArgs.push('--docs', args.docs.join(','));
                }
                return this.cliHandler.handleCommand(newArgs);
            case 'status':
                return this.cliHandler.handleCommand(['plan', 'status', '--id', args.id || '']);
            case 'revise':
                return this.cliHandler.handleCommand(['plan', 'revise', '--id', args.id || '', '--feedback', args.feedback || '']);
            case 'approve':
                return this.cliHandler.handleCommand(['plan', 'approve', '--id', args.id || '']);
            case 'cancel':
                return this.cliHandler.handleCommand(['plan', 'cancel', '--id', args.id || '']);
            default:
                return { success: false, error: `Unknown plan action: ${action}` };
        }
    }

    private async handleCoordinator(action: string, args: any): Promise<any> {
        switch (action) {
            case 'list':
                return this.cliHandler.handleCommand(['coordinator', 'list']);
            case 'start':
                const startArgs = ['coordinator', 'start'];
                if (args.plan) {
                    // Check if it's a session ID or a path
                    if (args.plan.startsWith('ps_')) {
                        startArgs.push('--plan-session', args.plan);
                    } else {
                        startArgs.push('--plan', args.plan);
                    }
                }
                return this.cliHandler.handleCommand(startArgs);
            case 'status':
                return this.cliHandler.handleCommand(['coordinator', 'status', '--id', args.id || '']);
            case 'pause':
                return this.cliHandler.handleCommand(['coordinator', 'pause', '--id', args.id || '']);
            case 'resume':
                return this.cliHandler.handleCommand(['coordinator', 'resume', '--id', args.id || '']);
            case 'stop':
                return this.cliHandler.handleCommand(['coordinator', 'stop', '--id', args.id || '']);
            default:
                return { success: false, error: `Unknown coordinator action: ${action}` };
        }
    }

    private async handlePool(action: string, args: any): Promise<any> {
        switch (action) {
            case 'status':
                return this.cliHandler.handleCommand(['pool', 'status']);
            case 'resize':
                return this.cliHandler.handleCommand(['pool', 'resize', '--size', String(args.size || 5)]);
            default:
                return { success: false, error: `Unknown pool action: ${action}` };
        }
    }

    private async handleEngineer(action: string, args: any): Promise<any> {
        switch (action) {
            case 'list':
                return this.cliHandler.handleCommand(['engineer', 'list']);
            case 'status':
                return this.cliHandler.handleCommand(['engineer', 'status', '--name', args.name || '']);
            case 'log':
                return this.cliHandler.handleCommand(['engineer', 'log', '--name', args.name || '', '--lines', String(args.lines || 50)]);
            case 'terminal':
                return this.cliHandler.handleCommand(['engineer', 'terminal', '--name', args.name || '']);
            case 'stop':
                return this.cliHandler.handleCommand(['engineer', 'stop', '--name', args.name || '']);
            default:
                return { success: false, error: `Unknown engineer action: ${action}` };
        }
    }

    private async handleUnity(action: string, args: any): Promise<any> {
        switch (action) {
            case 'compile':
                return this.cliHandler.handleCommand(['unity', 'compile']);
            case 'test':
                return this.cliHandler.handleCommand(['unity', 'test']);
            case 'console':
                return this.cliHandler.handleCommand(['unity', 'console']);
            default:
                return { success: false, error: `Unknown unity action: ${action}` };
        }
    }

    private writeResponse(response: CliResponse): void {
        try {
            fs.writeFileSync(this.responseFile, JSON.stringify(response, null, 2));
            console.log(`CliIpcService: Wrote response for ${response.requestId}`);
        } catch (error) {
            console.error('CliIpcService: Failed to write response:', error);
        }
    }
}

