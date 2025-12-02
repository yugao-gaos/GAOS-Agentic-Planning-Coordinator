import * as vscode from 'vscode';
import { TerminalManager } from './services/TerminalManager';
import { DependencyService } from './services/DependencyService';
import { PlanningSessionsProvider, PlanningSessionItem } from './ui/PlanningSessionsProvider';
import { AgentPoolProvider } from './ui/AgentPoolProvider';
import { RoleSettingsPanel } from './ui/RoleSettingsPanel';
import { WorkflowSettingsPanel } from './ui/WorkflowSettingsPanel';
import { DependencyMapPanel } from './ui/DependencyMapPanel';
import { SidebarViewProvider } from './ui/SidebarViewProvider';
import { AgentRunner, AgentBackendType } from './services/AgentBackend';
import { EventBroadcaster } from './daemon/EventBroadcaster';
import { TaskFailedFinalEventData } from './client/ClientEvents';
import { DaemonManager } from './vscode/DaemonManager';
import { VsCodeClient } from './vscode/VsCodeClient';
import { DaemonStateProxy } from './services/DaemonStateProxy';
import { bootstrapServices, ServiceLocator } from './services/Bootstrap';
import { ProcessManager } from './services/ProcessManager';

// Module-level references (kept minimal - only what must be local)
let terminalManager: TerminalManager;
let daemonManager: DaemonManager;
let vsCodeClient: VsCodeClient;
let daemonStateProxy: DaemonStateProxy;

// Track event subscriptions for cleanup (prevents duplicate handlers on hot reload)
let eventSubscriptions: Array<() => void> = [];

/**
 * Open agent chat in Cursor/VS Code, paste clipboard content, and send.
 * Uses platform-specific automation (AppleScript, PowerShell, xdotool).
 */
function openAgentChat(): void {
    const { exec } = require('child_process');
    
    if (process.platform === 'darwin') {
        // macOS: Use AppleScript - open chat, paste, and press Enter
        const script = `
            tell application "Cursor" to activate
            delay 0.2
            tell application "System Events" to key code 53
            delay 0.3
            tell application "System Events" to keystroke "l" using {command down, shift down}
            delay 0.5
            tell application "System Events" to keystroke "v" using command down
            delay 0.3
            tell application "System Events" to key code 36
        `;
        exec(`osascript -e '${script}'`, (error: Error | null) => {
            if (error) {
                vscode.window.showWarningMessage(
                    'Could not open chat automatically. Press Cmd+Shift+L and paste (Cmd+V).'
                );
            }
        });
    } else if (process.platform === 'win32') {
        // Windows: Use PowerShell with SendKeys - open chat, paste, and press Enter
        const psScript = `
            Add-Type -AssemblyName System.Windows.Forms
            Start-Sleep -Milliseconds 200
            [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
            Start-Sleep -Milliseconds 300
            [System.Windows.Forms.SendKeys]::SendWait('^+l')
            Start-Sleep -Milliseconds 500
            [System.Windows.Forms.SendKeys]::SendWait('^v')
            Start-Sleep -Milliseconds 300
            [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
        `;
        exec(`powershell -Command "${psScript.replace(/\n/g, ' ')}"`, (error: Error | null) => {
            if (error) {
                vscode.window.showWarningMessage(
                    'Could not open chat automatically. Press Ctrl+Shift+L and paste (Ctrl+V).'
                );
            }
        });
    } else {
        // Linux: Use xdotool if available - open chat, paste, and press Enter
        exec('which xdotool', (err: Error | null) => {
            if (!err) {
                exec('sleep 0.2 && xdotool key Escape && sleep 0.3 && xdotool key ctrl+shift+l && sleep 0.5 && xdotool key ctrl+v && sleep 0.3 && xdotool key Return');
            } else {
                vscode.window.showInformationMessage(
                    'Prompt copied! Press Ctrl+Shift+L to open chat, then Ctrl+V to paste.'
                );
            }
        });
    }
}

export async function activate(context: vscode.ExtensionContext) {
    console.log('[APC] ===== ACTIVATION START =====');

    // Get workspace root
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showWarningMessage('Agentic Planning: No workspace folder open');
        return;
    }
    console.log(`[APC] Step 1: Workspace root = ${workspaceRoot}`);
    
    // Bootstrap base services with ServiceLocator (for local-only services)
    console.log('[APC] Step 2: Bootstrapping base services...');
    bootstrapServices();
    console.log('[APC] Step 2: Base services bootstrapped');
    
    // Initialize AgentRunner with configured backend (needed for local agent spawning)
    console.log('[APC] Step 3: Setting up AgentRunner...');
    const config = vscode.workspace.getConfiguration('agenticPlanning');
    const backendType = config.get<string>('defaultBackend', 'cursor') as AgentBackendType;
    const agentRunner = ServiceLocator.resolve(AgentRunner);
    agentRunner.setBackend(backendType);
    console.log(`[APC] Step 3: Agent backend = ${backendType}`);

    // Initialize local-only services
    terminalManager = new TerminalManager();
    
    // Initialize DependencyService (local utility)
    const dependencyService = ServiceLocator.resolve(DependencyService);
    dependencyService.setWorkspaceRoot(workspaceRoot);
    const unityFeaturesEnabled = config.get<boolean>('enableUnityFeatures', true);
    dependencyService.setUnityEnabled(unityFeaturesEnabled);
    
    // Start periodic dependency checks (every 30 seconds)
    dependencyService.startPeriodicCheck(30000);

    // Create UI providers
    console.log('[APC] Step 4: Creating sidebar provider...');
    const sidebarProvider = new SidebarViewProvider(context.extensionUri);
    sidebarProvider.setUnityEnabled(unityFeaturesEnabled);
    console.log('[APC] Step 4: Sidebar provider created');
    
    // ========================================================================
    // Daemon Connection - This is the main state source
    // ========================================================================
    console.log('[APC] Step 5: Starting daemon connection...');
    
    // Initialize daemon manager and ensure daemon is running
    daemonManager = new DaemonManager(workspaceRoot, context.extensionPath);
    
    try {
        console.log('[APC] Step 5a: Calling ensureDaemonRunning...');
        const daemonResult = await daemonManager.ensureDaemonRunning();
        console.log(`[APC] Step 5b: Daemon on port ${daemonResult.port} (wasStarted: ${daemonResult.wasStarted}, isExternal: ${daemonResult.isExternal})`);
        
        // Create and connect VS Code client
        vsCodeClient = new VsCodeClient({
            url: `ws://127.0.0.1:${daemonResult.port}`,
            clientId: 'vscode-extension',
            autoReconnect: true
        });
        
        // Set up notification callbacks
        vsCodeClient.setNotificationCallbacks({
            showInfo: (msg) => vscode.window.showInformationMessage(msg),
            showWarning: (msg) => vscode.window.showWarningMessage(msg),
            showError: (msg) => vscode.window.showErrorMessage(msg)
        });
        
        // Connect to daemon with retry (daemon may still be starting up)
        console.log('[APC] Step 5c: Connecting to daemon...');
        const maxRetries = 5;
        let lastError: Error | undefined;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await vsCodeClient.connect();
                console.log(`[APC] Step 5d: Connected to daemon (attempt ${attempt})`);
                break;
            } catch (err) {
                lastError = err as Error;
                console.log(`[APC] Connection attempt ${attempt}/${maxRetries} failed: ${lastError.message}`);
                if (attempt < maxRetries) {
                    // Wait before retry (100ms, 200ms, 400ms, 800ms)
                    await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt - 1)));
                }
            }
        }
        if (!vsCodeClient.isConnected()) {
            throw lastError || new Error('Failed to connect to daemon');
        }
        console.log('Agentic Planning: Connected to daemon');
        
        // If daemon was external (started by CLI), show info
        if (daemonResult.isExternal) {
            vscode.window.showInformationMessage(
                'Connected to existing APC daemon (started externally). State is shared with CLI.'
            );
        }
        
        // Create DaemonStateProxy - all state reads go through this
        daemonStateProxy = new DaemonStateProxy({
            vsCodeClient,
            unityEnabled: unityFeaturesEnabled
        });
        console.log('[APC] DaemonStateProxy created (daemon-only mode)');
        
        // Start connection health monitoring (every 15 seconds)
        daemonStateProxy.startConnectionMonitor(15000);
        
        // Pass proxy to providers
        sidebarProvider.setStateProxy(daemonStateProxy);
        
        // Clean up any existing event subscriptions (prevents duplicates on hot reload)
        for (const unsubscribe of eventSubscriptions) {
            try {
                unsubscribe();
            } catch (e) {
                // Ignore cleanup errors
            }
        }
        eventSubscriptions = [];
        
        // Subscribe to events for UI updates (store unsubscribe functions for cleanup)
        eventSubscriptions.push(
            vsCodeClient.subscribe('session.created', () => {
                sidebarProvider?.refresh();
            })
        );
        
        eventSubscriptions.push(
            vsCodeClient.subscribe('session.updated', () => {
                sidebarProvider?.refresh();
            })
        );
        
        // Create agent terminal when an agent is allocated
        eventSubscriptions.push(
            vsCodeClient.subscribe('agent.allocated', (data: unknown) => {
                console.log(`[APC Extension] agent.allocated event received:`, JSON.stringify(data));
                const allocData = data as { agentName: string; sessionId: string; roleId: string; logFile?: string };
                if (allocData.agentName && allocData.sessionId) {
                    terminalManager.createAgentTerminal(
                        allocData.agentName,
                        allocData.sessionId,
                        allocData.logFile || '',
                        workspaceRoot
                    );
                }
            })
        );
        
        eventSubscriptions.push(
            vsCodeClient.subscribe('pool.changed', () => {
                sidebarProvider?.refresh();
            })
        );
        
        // Subscribe to coordinator status changes to update status indicator
        eventSubscriptions.push(
            vsCodeClient.subscribe('coordinator.statusChanged', () => {
                sidebarProvider?.refresh();
            })
        );
        
        // Subscribe to workflow completion events to update UI
        eventSubscriptions.push(
            vsCodeClient.subscribe('workflow.completed', () => {
                console.log('[APC] Workflow completed, refreshing UI');
                sidebarProvider?.refresh();
            })
        );
        
        // Subscribe to disconnection events to update UI
        eventSubscriptions.push(
            vsCodeClient.subscribe('disconnected', () => {
                console.log('[APC] Daemon disconnected, refreshing UI');
                sidebarProvider?.refresh();
            })
        );
        
    } catch (daemonError) {
        console.error('Agentic Planning: Failed to connect to daemon:', daemonError);
        vscode.window.showWarningMessage(
            'Could not connect to APC daemon. Run "apc system run --headless" or restart Cursor.'
        );
        
        // Create proxy with unconnected client - UI will show "daemon missing"
        vsCodeClient = new VsCodeClient({ clientId: 'vscode-extension' });
        daemonStateProxy = new DaemonStateProxy({
            vsCodeClient,
            unityEnabled: unityFeaturesEnabled
        });
        // Start connection health monitoring (even if disconnected - will check periodically)
        daemonStateProxy.startConnectionMonitor(15000);
        sidebarProvider.setStateProxy(daemonStateProxy);
    }
    
    // Clean up old temp files from previous sessions
    const cleaned = (agentRunner as any).cleanupTempFiles?.();
    if (cleaned > 0) {
        console.log(`Agentic Planning: Cleaned up ${cleaned} old temp files`);
    }
    
    // Listen for task.failedFinal events to open agent chat for user intervention
    const broadcaster = ServiceLocator.resolve(EventBroadcaster);
    const taskFailedHandler = async (data: TaskFailedFinalEventData) => {
        const isNeedsClarity = data.errorType === 'needs_clarity';
        
        const prompt = isNeedsClarity 
            ? `Engineer needs clarity on task "${data.taskId}":
${data.clarityQuestion || data.lastError}

Session: ${data.sessionId}
Please help clarify, then use:
  apc plan revise ${data.sessionId} "<your clarification>"`
            : `Task "${data.taskId}" failed after ${data.attempts} attempt(s).

Error: ${data.lastError}
Session: ${data.sessionId}
${data.canRetry ? 'Can retry.' : 'Cannot retry (permanent error).'}

Options:
1. Revise plan: apc plan revise ${data.sessionId} "<feedback>"
2. ${data.canRetry ? `Retry: apc task retry ${data.sessionId} ${data.taskId}` : 'Skip task via revision'}`;

        // Copy prompt to clipboard and open agent chat
        await vscode.env.clipboard.writeText(prompt);
        openAgentChat();
        
        // Also show a notification
        const action = isNeedsClarity ? 'Needs Clarity' : 'Task Failed';
        vscode.window.showWarningMessage(
            `${action}: ${data.taskId} - ${data.lastError.substring(0, 50)}...`,
            'View in Chat'
        ).then(selection => {
            if (selection === 'View in Chat') {
                // Chat was already opened, just show info
                vscode.window.showInformationMessage('Check the agent chat for details and next steps.');
            }
        });
    };
    broadcaster.on('task.failedFinal', taskFailedHandler);
    // Track for cleanup (EventEmitter style - need to store handler reference)
    eventSubscriptions.push(() => broadcaster.removeListener('task.failedFinal', taskFailedHandler));

    console.log('[APC] Step 6: Registering webview provider...');
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarViewProvider.viewType, sidebarProvider)
    );
    console.log('[APC] Step 6: Webview provider registered');

    // Check dependencies on startup
    dependencyService.checkAllDependencies().then(statuses => {
        const platform = process.platform;
        const relevantStatuses = statuses.filter(s => s.required && (s.platform === platform || s.platform === 'all'));
        const missingDeps = relevantStatuses.filter(s => !s.installed);
        
        // Refresh the system status view
        sidebarProvider.refresh();
        
        if (missingDeps.length > 0) {
            const names = missingDeps.map(d => d.name).join(', ');
            vscode.window.showWarningMessage(
                `Agentic Planning: Missing dependencies: ${names}. Check System Status panel.`,
                'Show System Status'
            ).then(selection => {
                if (selection === 'Show System Status') {
                    vscode.commands.executeCommand('agenticPlanning.systemStatusView.focus');
                }
            });
        }
    });

    // ========================================================================
    // Register Commands - All operations go through daemon via VsCodeClient
    // ========================================================================
    context.subscriptions.push(
        vscode.commands.registerCommand('agenticPlanning.showDashboard', () => {
            vscode.window.showInformationMessage('Dashboard coming soon!');
        }),

        vscode.commands.registerCommand('agenticPlanning.startPlanning', async () => {
            // Pre-filled prompt for the AI agent (no unicode/emojis for clipboard compatibility)
            const planningPrompt = `Help me gather requirements for a new feature. Please ask me questions to understand:
- What I want to build (feature/system requirements)
- Technical constraints and preferences
- Integration points with existing code
- Testing and quality requirements

IMPORTANT: This is REQUIREMENTS GATHERING, not planning.
- If I provide docs (GDD, TDD, specs), copy them to _AiDevLog/Docs/
- The APC extension creates the execution plan using multi-model analysts
- You do NOT create the plan - the extension does

When requirements are clear, SUMMARIZE this conversation and run:
  apc plan new "<requirement summary from conversation>" --docs <paths>

Workflow:
1. Gather requirements (this conversation)
2. Save any docs to _AiDevLog/Docs/
3. Summarize requirements and run: apc plan new "<summary>"
4. Review with user: apc plan status <id>
5. Approve: apc plan approve <id> (auto-starts execution)

Let's get started!`;

            // Copy prompt to clipboard and open agent chat
            await vscode.env.clipboard.writeText(planningPrompt);
            openAgentChat();
        }),

        // Execution commands - all go through daemon
        vscode.commands.registerCommand('agenticPlanning.startExecution', async (item?: PlanningSessionItem) => {
            if (!vsCodeClient.isConnected()) {
                vscode.window.showErrorMessage('Not connected to daemon. Run "apc system run --headless" first.');
                return;
            }
            
            let sessionId = item?.session?.id;
            if (!sessionId) {
                // No item selected - show picker
                const sessions = await daemonStateProxy.getPlanningSessions();
                const approvedSessions = sessions.filter(s => s.status === 'approved');
                if (approvedSessions.length === 0) {
                    vscode.window.showWarningMessage('No approved plans available to execute.');
                    return;
                }
                const selected = await vscode.window.showQuickPick(
                    approvedSessions.map(s => ({ 
                        label: s.id, 
                        description: s.requirement.substring(0, 50) + '...',
                        session: s 
                    })),
                    { placeHolder: 'Select a plan to execute' }
                );
                if (!selected) return;
                sessionId = selected.session.id;
            }
            
            const result = await vsCodeClient.startExecution(sessionId);
            if (result.success) {
                vscode.window.showInformationMessage(`Execution started with ${result.engineerCount} engineers!`);
            } else {
                vscode.window.showErrorMessage(`Failed to start: ${result.error}`);
            }
            sidebarProvider.refresh();
        }),

        vscode.commands.registerCommand('agenticPlanning.pauseExecution', async (item?: PlanningSessionItem) => {
            const sessionId = item?.session?.id;
            if (!sessionId) {
                vscode.window.showWarningMessage('No session selected');
                return;
            }
            const result = await vsCodeClient.pauseExecution(sessionId);
            if (result.success) {
                vscode.window.showInformationMessage(`Execution paused for ${sessionId}`);
            } else {
                vscode.window.showErrorMessage(result.error || 'Failed to pause');
            }
            sidebarProvider.refresh();
        }),

        vscode.commands.registerCommand('agenticPlanning.resumeExecution', async (item?: PlanningSessionItem) => {
            const sessionId = item?.session?.id;
            if (!sessionId) {
                vscode.window.showWarningMessage('No session selected');
                return;
            }
            const result = await vsCodeClient.resumeExecution(sessionId);
            if (result.success) {
                vscode.window.showInformationMessage(`Execution resumed for ${sessionId}`);
            } else {
                vscode.window.showErrorMessage(result.error || 'Failed to resume');
            }
            sidebarProvider.refresh();
        }),

        vscode.commands.registerCommand('agenticPlanning.stopExecution', async (item?: PlanningSessionItem) => {
            const sessionId = item?.session?.id;
            if (!sessionId) {
                vscode.window.showWarningMessage('No session selected');
                return;
            }
            
            const confirm = await vscode.window.showWarningMessage(
                `Stop execution for ${sessionId}? Engineers will be released.`,
                { modal: true },
                'Stop Execution'
            );
            
            if (confirm === 'Stop Execution') {
                const result = await vsCodeClient.stopExecution(sessionId);
                if (result.success) {
                    vscode.window.showInformationMessage(`Execution stopped for ${sessionId}`);
                } else {
                    vscode.window.showErrorMessage(result.error || 'Failed to stop');
                }
                sidebarProvider.refresh();
            }
        }),
        
        vscode.commands.registerCommand('agenticPlanning.retryFailedTask', async (args?: { sessionId?: string; taskId?: string }) => {
            const sessionId = args?.sessionId;
            const taskId = args?.taskId;
            
            if (!sessionId || !taskId) {
                vscode.window.showWarningMessage('Missing session or task ID for retry');
                return;
            }
            
            const result = await vsCodeClient.retryTask(sessionId, taskId);
            if (result.success) {
                vscode.window.showInformationMessage(`Retry started: ${result.workflowId}`);
                sidebarProvider.refresh();
            } else {
                vscode.window.showErrorMessage(result.error || 'Failed to retry task');
            }
        }),

        vscode.commands.registerCommand('agenticPlanning.showAgentTerminal', async (agentName?: string) => {
            if (!agentName) {
                const busyAgents = await daemonStateProxy.getBusyAgents();
                if (busyAgents.length === 0) {
                    vscode.window.showWarningMessage('No active agents');
                    return;
                }
                const selected = await vscode.window.showQuickPick(
                    busyAgents.map(e => ({ label: e.name, description: `${e.roleId || 'agent'} - ${e.coordinatorId}` })),
                    { placeHolder: 'Select agent to view' }
                );
                if (selected) {
                    agentName = selected.label;
                }
            }
            if (agentName) {
                const shown = terminalManager.showAgentTerminal(agentName);
                if (!shown) {
                    // Agent has no terminal yet - show informative message
                    vscode.window.showInformationMessage(
                        `Agent "${agentName}" has no terminal output yet. Terminal will open when the agent starts working.`
                    );
                }
            }
        }),

        vscode.commands.registerCommand('agenticPlanning.poolStatus', async () => {
            const status = await daemonStateProxy.getPoolStatus();
            vscode.window.showInformationMessage(
                `Agent Pool: ${status.available.length} available, ${status.busy.length} busy (Total: ${status.total})`
            );
        }),
        
        // Role settings command - uses daemon API for roles
        vscode.commands.registerCommand('apc.openRoleSettings', async () => {
            if (!vsCodeClient.isConnected()) {
                vscode.window.showErrorMessage('Not connected to daemon');
                return;
            }
            // Pass vsCodeClient to RoleSettingsPanel for daemon-based role management
            RoleSettingsPanel.showWithClient(vsCodeClient, context.extensionUri);
        }),
        
        // Workflow settings command
        vscode.commands.registerCommand('apc.openWorkflowSettings', () => {
            WorkflowSettingsPanel.show(context.extensionUri, workspaceRoot);
        }),
        
        // Dependency map command - shows task dependencies visualization
        vscode.commands.registerCommand('agenticPlanning.openDependencyMap', async (args?: { sessionId?: string }) => {
            let sessionId = args?.sessionId;
            
            if (!sessionId) {
                // No session specified - show picker
                const sessions = await daemonStateProxy.getPlanningSessions();
                if (sessions.length === 0) {
                    vscode.window.showWarningMessage('No planning sessions available.');
                    return;
                }
                const selected = await vscode.window.showQuickPick(
                    sessions.map(s => ({ 
                        label: s.id.substring(0, 8), 
                        description: s.requirement.substring(0, 50) + '...',
                        session: s 
                    })),
                    { placeHolder: 'Select a session to view dependency map' }
                );
                if (!selected) return;
                sessionId = selected.session.id;
            }
            
            DependencyMapPanel.show(sessionId, context.extensionUri, vsCodeClient);
        }),

        // Refresh commands for tree views
        vscode.commands.registerCommand('agenticPlanning.refreshPlanningSessions', () => {
            sidebarProvider.refresh();
        }),

        // Planning session management commands
        vscode.commands.registerCommand('agenticPlanning.stopPlanningSession', async (item?: { session?: { id: string } }) => {
            const sessionId = item?.session?.id;
            if (!sessionId) {
                vscode.window.showWarningMessage('No session selected');
                return;
            }
            
            const confirm = await vscode.window.showWarningMessage(
                `Stop planning session ${sessionId}?`,
                { modal: true },
                'Stop'
            );
            
            if (confirm === 'Stop') {
                const result = await vsCodeClient.stopSession(sessionId);
                if (result.success) {
                    vscode.window.showInformationMessage(`Session ${sessionId} stopped`);
                    sidebarProvider.refresh();
                } else {
                    vscode.window.showErrorMessage(result.error || 'Failed to stop session');
                }
            }
        }),
        
        vscode.commands.registerCommand('agenticPlanning.removePlanningSession', async (item?: { session?: { id: string } }) => {
            const sessionId = item?.session?.id;
            if (!sessionId) {
                vscode.window.showWarningMessage('No session selected');
                return;
            }
            
            const confirm = await vscode.window.showWarningMessage(
                `Remove planning session ${sessionId}? This will delete the session data.`,
                { modal: true },
                'Remove'
            );
            
            if (confirm === 'Remove') {
                const result = await vsCodeClient.removeSession(sessionId);
                if (result.success) {
                    vscode.window.showInformationMessage(`Session ${sessionId} removed`);
                    sidebarProvider.refresh();
                } else {
                    vscode.window.showErrorMessage(result.error || 'Failed to remove session');
                }
            }
        }),
        
        vscode.commands.registerCommand('agenticPlanning.resumePlanningSession', async (item?: { session?: { id: string } }) => {
            const sessionId = item?.session?.id;
            if (!sessionId) {
                vscode.window.showWarningMessage('No session selected');
                return;
            }
            
            const confirm = await vscode.window.showWarningMessage(
                `Resume planning session ${sessionId}? This will restart the planning process.`,
                { modal: true },
                'Resume'
            );
            
            if (confirm === 'Resume') {
                const result = await vsCodeClient.resumeSession(sessionId);
                if (result.success) {
                    vscode.window.showInformationMessage(`Session ${sessionId} resuming...`);
                    sidebarProvider.refresh();
                } else {
                    vscode.window.showErrorMessage(result.error || 'Failed to resume session');
                }
            }
        }),
        
        // Revise plan - opens AI chat for revision
        vscode.commands.registerCommand('agenticPlanning.revisePlan', async (item?: { session?: { id: string } }) => {
            const sessionId = item?.session?.id;
            if (!sessionId) {
                vscode.window.showWarningMessage('No session selected');
                return;
            }
            
            let session;
            try {
                const response = await vsCodeClient.getPlanStatus(sessionId);
                session = response;
            } catch {
                vscode.window.showErrorMessage(`Session ${sessionId} not found`);
                return;
            }
            
            // Pre-filled prompt for revision
            const revisionPrompt = `I want to revise the plan for session ${sessionId}.

Current plan: ${session.currentPlanPath || 'N/A'}
Original requirement: ${(session.requirement || '').substring(0, 200)}...

Please help me discuss what changes I want to make to this plan.

IMPORTANT: This is REVISION DISCUSSION, not direct editing.
- The APC extension will revise the plan using multi-model analysts
- You do NOT edit the plan directly - the extension does

When revision requirements are clear, SUMMARIZE this conversation and run:
  apc plan revise ${sessionId} "<revision summary from conversation>"

This will trigger the multi-agent debate to revise the plan.`;

            // Copy to clipboard and open agent chat
            await vscode.env.clipboard.writeText(revisionPrompt);
            openAgentChat();
        }),
        
        // Approve plan and auto-start execution
        vscode.commands.registerCommand('agenticPlanning.approvePlan', async (item?: { session?: { id: string } }) => {
            const sessionId = item?.session?.id;
            if (!sessionId) {
                vscode.window.showWarningMessage('No session selected');
                return;
            }
            
            const confirm = await vscode.window.showInformationMessage(
                `Approve plan for ${sessionId} and start execution?`,
                { modal: true },
                'Approve & Execute'
            );
            
            if (confirm === 'Approve & Execute') {
                try {
                    await vsCodeClient.approvePlan(sessionId, true);
                    vscode.window.showInformationMessage(`Plan approved and execution started for ${sessionId}`);
                    sidebarProvider.refresh();
                } catch (err) {
                    vscode.window.showErrorMessage(`Failed to approve: ${err}`);
                }
            }
        }),
        
        // Cancel/stop ongoing plan revision
        vscode.commands.registerCommand('agenticPlanning.cancelPlan', async (item?: { session?: { id: string } }) => {
            const sessionId = item?.session?.id;
            if (!sessionId) {
                vscode.window.showWarningMessage('No session selected');
                return;
            }
            
            const result = await vsCodeClient.cancelPlan(sessionId);
            if (result.success) {
                vscode.window.showInformationMessage(`Revision cancelled for ${sessionId}`);
                sidebarProvider.refresh();
            } else {
                vscode.window.showErrorMessage(`Failed to cancel: ${result.error}`);
            }
        }),
        
        // Restart planning for cancelled sessions
        vscode.commands.registerCommand('agenticPlanning.restartPlanning', async (item?: { session?: { id: string } }) => {
            const sessionId = item?.session?.id;
            if (!sessionId) {
                vscode.window.showWarningMessage('No session selected');
                return;
            }
            
            const result = await vsCodeClient.restartPlanning(sessionId);
            if (result.success) {
                vscode.window.showInformationMessage(`Planning restarted for ${sessionId}`);
                sidebarProvider.refresh();
            } else {
                vscode.window.showErrorMessage(`Failed to restart planning: ${result.error}`);
            }
        }),
        
        vscode.commands.registerCommand('agenticPlanning.refreshAgentPool', async () => {
            // Sync pool size with settings via daemon
            const configSize = vscode.workspace.getConfiguration('agenticPlanning').get<number>('agentPoolSize', 10);
            const poolStatus = await daemonStateProxy.getPoolStatus();
            
            if (configSize !== poolStatus.total) {
                const result = await vsCodeClient.resizePool(configSize);
                if (result.success) {
                    if (result.added && result.added.length > 0) {
                        vscode.window.showInformationMessage(`Added agents: ${result.added.join(', ')}`);
                    }
                    if (result.removed && result.removed.length > 0) {
                        vscode.window.showInformationMessage(`Removed agents: ${result.removed.join(', ')}`);
                    }
                }
            }
            sidebarProvider.refresh();
        }),

        // Release/stop a busy agent manually
        vscode.commands.registerCommand('agenticPlanning.releaseAgent', async (item?: { label?: string; agentStatus?: { name?: string } }) => {
            // Get agent name from the tree item
            const agentName = typeof item?.label === 'string' ? item.label : item?.agentStatus?.name;
            
            if (!agentName) {
                vscode.window.showErrorMessage('No agent selected');
                return;
            }
            
            const confirm = await vscode.window.showWarningMessage(
                `Release ${agentName} from their current coordinator?`,
                { modal: true },
                'Release'
            );
            
            if (confirm === 'Release') {
                const result = await vsCodeClient.releaseAgent(agentName);
                if (result.success) {
                    vscode.window.showInformationMessage(`${agentName} released back to pool`);
                } else {
                    vscode.window.showErrorMessage(result.error || 'Failed to release agent');
                }
                sidebarProvider.refresh();
            }
        }),

        // Kill stuck processes command
        vscode.commands.registerCommand('agenticPlanning.killStuckProcesses', async () => {
            const processManager = ServiceLocator.resolve(ProcessManager);
            
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Killing stuck processes...',
                cancellable: false
            }, async (progress) => {
                // Kill tracked stuck processes
                progress.report({ message: 'Checking tracked processes...' });
                const killedTracked = await processManager.killStuckProcesses();
                
                // Kill orphan cursor-agent processes
                progress.report({ message: 'Checking orphan processes...' });
                const killedOrphans = await processManager.killOrphanCursorAgents();
                
                const total = killedTracked.length + killedOrphans;
                if (total > 0) {
                    vscode.window.showInformationMessage(
                        `Killed ${total} stuck/orphan processes (${killedTracked.length} tracked, ${killedOrphans} orphans)`
                    );
                } else {
                    vscode.window.showInformationMessage('No stuck processes found');
                }
                
                sidebarProvider.refresh();
            });
        }),

        // Show running processes command
        vscode.commands.registerCommand('agenticPlanning.showRunningProcesses', async () => {
            const processManager = ServiceLocator.resolve(ProcessManager);
            
            const processes = processManager.getRunningProcessInfo();
            
            if (processes.length === 0) {
                vscode.window.showInformationMessage('No running processes tracked by ProcessManager');
                return;
            }
            
            const items = processes.map(p => ({
                label: `${p.isStuck ? '⚠️ ' : '✅ '}${p.id}`,
                description: `Runtime: ${Math.round(p.runtimeMs / 1000)}s, Last activity: ${Math.round(p.timeSinceActivityMs / 1000)}s ago`,
                detail: p.command,
                process: p
            }));
            
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a process to kill (or press Escape to cancel)',
                title: `Running Processes (${processes.length})`
            });
            
            if (selected) {
                const confirm = await vscode.window.showWarningMessage(
                    `Kill process ${selected.process.id}?`,
                    { modal: true },
                    'Kill'
                );
                
                if (confirm === 'Kill') {
                    await processManager.stopProcess(selected.process.id, true);
                    vscode.window.showInformationMessage(`Process ${selected.process.id} killed`);
                    sidebarProvider.refresh();
                }
            }
        }),

        // Dependency commands
        vscode.commands.registerCommand('agenticPlanning.refreshDependencies', async () => {
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Checking dependencies...',
                cancellable: false
            }, async () => {
                await dependencyService.checkAllDependencies();
                sidebarProvider.refresh();
            });
        }),
        vscode.commands.registerCommand('agenticPlanning.openDependencyInstall', async (dep?: { installUrl?: string; name: string }) => {
            if (dep?.installUrl) {
                await dependencyService.openInstallUrl(dep as any);
            } else if (dep) {
                vscode.window.showInformationMessage(`No install URL available for ${dep.name}`);
            }
        }),
        vscode.commands.registerCommand('agenticPlanning.copyDependencyCommand', async (dep?: { installCommand?: string; name: string }) => {
            if (dep?.installCommand) {
                await dependencyService.copyInstallCommand(dep as any);
            } else if (dep) {
                vscode.window.showInformationMessage(`No install command available for ${dep.name}`);
            }
        }),

        // Show missing dependencies quick pick
        vscode.commands.registerCommand('agenticPlanning.showMissingDependencies', async () => {
            const statuses = dependencyService.getCachedStatus();
            const platform = process.platform;
            const relevantStatuses = statuses.filter(s => s.required && (s.platform === platform || s.platform === 'all'));
            const missingDeps = relevantStatuses.filter(s => !s.installed);
            
            if (missingDeps.length === 0) {
                vscode.window.showInformationMessage('All dependencies are installed!');
                return;
            }

            const items = missingDeps.map(dep => ({
                label: `$(close) ${dep.name}`,
                description: dep.description,
                detail: dep.installCommand ? `Install: ${dep.installCommand}` : (dep.installUrl ? 'Click to open install page' : undefined),
                dep
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a dependency to install',
                title: `Missing Dependencies (${missingDeps.length})`
            });

            if (selected) {
                if (selected.dep.name.includes('APC CLI')) {
                    vscode.commands.executeCommand('agenticPlanning.installCli');
                } else if (selected.dep.installUrl) {
                    await dependencyService.openInstallUrl(selected.dep);
                } else if (selected.dep.installCommand) {
                    await dependencyService.copyInstallCommand(selected.dep);
                    vscode.window.showInformationMessage(`Install command copied: ${selected.dep.installCommand}`);
                }
            }
        }),

        // CLI installation commands
        vscode.commands.registerCommand('agenticPlanning.installCli', async () => {
            const result = await dependencyService.installApcCli(context.extensionPath);
            
            // Always refresh status after install attempt
            await dependencyService.checkAllDependencies();
            sidebarProvider.refresh();
            
            if (result.success) {
                // Check if PATH setup is needed
                if (result.message.includes('Add to PATH')) {
                    const action = await vscode.window.showInformationMessage(
                        'APC CLI installed! Add ~/.local/bin to PATH to use it.',
                        'Copy PATH Command'
                    );
                    if (action === 'Copy PATH Command') {
                        const shellConfig = process.platform === 'darwin' ? '~/.zshrc' : '~/.bashrc';
                        await vscode.env.clipboard.writeText(`echo 'export PATH="$HOME/.local/bin:$PATH"' >> ${shellConfig} && source ${shellConfig}`);
                        vscode.window.showInformationMessage('Copied! Paste in terminal, then restart terminal.');
                    }
                } else {
                    vscode.window.showInformationMessage('APC CLI installed successfully! Try: apc help');
                }
            } else {
                vscode.window.showErrorMessage(result.message);
            }
        }),
        vscode.commands.registerCommand('agenticPlanning.uninstallCli', async () => {
            const result = await dependencyService.uninstallApcCli();
            if (result.success) {
                vscode.window.showInformationMessage(result.message);
                await dependencyService.checkAllDependencies();
                sidebarProvider.refresh();
            } else {
                vscode.window.showErrorMessage(result.message);
            }
        }),

        // Open APC settings
        vscode.commands.registerCommand('agenticPlanning.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'agenticPlanning');
        })
    );

    // Register CLI terminal profile
    context.subscriptions.push(
        vscode.window.registerTerminalProfileProvider('agenticPlanning.cli', {
            provideTerminalProfile(): vscode.TerminalProfile {
                return new vscode.TerminalProfile({
                    name: 'Agentic CLI',
                    shellPath: '/bin/bash',
                    shellArgs: ['-c', 'echo "Agentic Planning CLI ready. Use: apc <command>"']
                });
            }
        })
    );

    // Listen for configuration changes - sync with daemon
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async e => {
            if (e.affectsConfiguration('agenticPlanning.agentPoolSize')) {
                const newSize = vscode.workspace.getConfiguration('agenticPlanning').get<number>('agentPoolSize', 10);
                const result = await vsCodeClient.resizePool(newSize);
                if (result.success) {
                    if (result.added && result.added.length > 0) {
                        vscode.window.showInformationMessage(`Added agents: ${result.added.join(', ')}`);
                    }
                    if (result.removed && result.removed.length > 0) {
                        vscode.window.showInformationMessage(`Removed agents: ${result.removed.join(', ')}`);
                    }
                }
                sidebarProvider.refresh();
            }
        })
    );

    console.log('Agentic Planning Coordinator activated successfully');
    vscode.window.showInformationMessage('Agentic Planning Coordinator ready!');
}

export async function deactivate() {
    console.log('Agentic Planning Coordinator deactivating...');
    
    // Stop periodic dependency checks
    try {
        const dependencyService = ServiceLocator.resolve(DependencyService);
        dependencyService.stopPeriodicCheck();
        console.log('Dependency periodic check stopped');
    } catch (e) {
        // Ignore if service not available
    }
    
    // Stop connection health monitoring
    if (daemonStateProxy) {
        try {
            daemonStateProxy.dispose();
            console.log('DaemonStateProxy disposed');
        } catch (e) {
            // Ignore cleanup errors
        }
    }
    
    // Clean up event subscriptions first (prevents memory leaks and duplicate handlers)
    console.log(`Cleaning up ${eventSubscriptions.length} event subscriptions`);
    for (const unsubscribe of eventSubscriptions) {
        try {
            unsubscribe();
        } catch (e) {
            // Ignore cleanup errors
        }
    }
    eventSubscriptions = [];
    
    // Disconnect from daemon (but don't stop it - other clients may still need it)
    // Daemon will auto-shutdown after 60s with no clients, which triggers graceful shutdown
    if (vsCodeClient) {
        try {
            vsCodeClient.dispose();
            console.log('VsCodeClient disconnected');
        } catch (e) {
            console.error('Error disconnecting VsCodeClient:', e);
        }
    }
    
    // Dispose daemon manager (health checks, etc.)
    if (daemonManager) {
        try {
            await daemonManager.dispose();
            console.log('DaemonManager disposed');
        } catch (e) {
            console.error('Error disposing DaemonManager:', e);
        }
    }
    
    // Dispose TerminalManager (closes all terminals)
    if (terminalManager) {
        try {
            terminalManager.dispose();
            console.log('TerminalManager disposed');
        } catch (e) {
            console.error('Error disposing TerminalManager:', e);
        }
    }
    
    // Kill any orphan cursor-agent processes before disposing
    try {
        if (ServiceLocator.isRegistered(ProcessManager)) {
            const processManager = ServiceLocator.resolve(ProcessManager);
            const killed = await processManager.killOrphanCursorAgents();
            if (killed > 0) {
                console.log(`Killed ${killed} orphan cursor-agent processes`);
            }
        }
    } catch (e) {
        // Ignore cleanup errors
    }
    
    // Dispose all ServiceLocator-managed services in reverse registration order
    try {
        await ServiceLocator.dispose();
        console.log('ServiceLocator disposed all services');
    } catch (e) {
        console.error('Error disposing ServiceLocator:', e);
    }
    
    console.log('Agentic Planning Coordinator deactivated');
}
