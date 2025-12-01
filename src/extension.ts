import * as vscode from 'vscode';
import { StateManager } from './services/StateManager';
import { AgentPoolService } from './services/AgentPoolService';
import { AgentRoleRegistry } from './services/AgentRoleRegistry';
import { TerminalManager } from './services/TerminalManager';
import { UnifiedCoordinatorService } from './services/UnifiedCoordinatorService';
import { PlanningService } from './services/PlanningService';
import { DependencyService } from './services/DependencyService';
import { CliHandler } from './cli/CliHandler';
import { PlanningSessionsProvider, PlanningSessionItem } from './ui/PlanningSessionsProvider';
import { AgentPoolProvider } from './ui/AgentPoolProvider';
import { RoleSettingsPanel } from './ui/RoleSettingsPanel';
import { SidebarViewProvider } from './ui/SidebarViewProvider';
import { UnityControlManager } from './services/UnityControlManager';
import { AgentRunner, AgentBackendType } from './services/AgentBackend';
import { EventBroadcaster } from './daemon/EventBroadcaster';
import { TaskFailedFinalEventData } from './client/ClientEvents';
import { DaemonManager } from './vscode/DaemonManager';
import { VsCodeClient } from './vscode/VsCodeClient';
import { DaemonStateProxy } from './services/DaemonStateProxy';
import { bootstrapServices, ServiceLocator } from './services/Bootstrap';
import { WorkflowPauseManager } from './services/workflows/WorkflowPauseManager';
import { ProcessManager } from './services/ProcessManager';

let stateManager: StateManager;
let agentPoolService: AgentPoolService;
let agentRoleRegistry: AgentRoleRegistry;
let terminalManager: TerminalManager;
let unifiedCoordinatorService: UnifiedCoordinatorService;
let planningService: PlanningService;
let cliHandler: CliHandler;
let daemonManager: DaemonManager;
let vsCodeClient: VsCodeClient;
let daemonStateProxy: DaemonStateProxy;

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
    console.log('Agentic Planning Coordinator is activating...');

    // Get workspace root
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showWarningMessage('Agentic Planning: No workspace folder open');
        return;
    }
    console.log(`Agentic Planning: Workspace root = ${workspaceRoot}`);
    
    // Bootstrap all services with ServiceLocator
    bootstrapServices();
    console.log('Agentic Planning: Services bootstrapped');
    
    // Initialize AgentRunner with configured backend
    const config = vscode.workspace.getConfiguration('agenticPlanning');
    const backendType = config.get<string>('defaultBackend', 'cursor') as AgentBackendType;
    const agentRunner = ServiceLocator.resolve(AgentRunner);
    agentRunner.setBackend(backendType);
    console.log(`Agentic Planning: Agent backend = ${backendType}`);

    // Create placeholder providers first so TreeViews are always registered
    // This prevents "no data provider" errors even if initialization fails
    const dependencyService = ServiceLocator.resolve(DependencyService);
    const sidebarProvider = new SidebarViewProvider(context.extensionUri);
    let planningSessionsProvider: PlanningSessionsProvider;
    let agentPoolProvider: AgentPoolProvider;
    
    try {
    // Initialize services with config from VS Code settings
    const vsConfig = vscode.workspace.getConfiguration('agenticPlanning');
    stateManager = new StateManager({
        workspaceRoot,
        workingDirectory: vsConfig.get('workingDirectory', '_AiDevLog'),
        agentPoolSize: vsConfig.get('agentPoolSize', 5),
        defaultBackend: vsConfig.get('defaultBackend', 'cursor') as 'cursor' | 'claude-code' | 'codex'
    });
    await stateManager.initialize();
        
        // Debug: Log what we loaded
        const sessions = stateManager.getAllPlanningSessions();
        console.log(`Agentic Planning: Loaded ${sessions.length} planning sessions`);
        sessions.forEach(s => console.log(`  - Session: ${s.id}, status: ${s.status}`));

    agentRoleRegistry = new AgentRoleRegistry(stateManager);
    agentPoolService = new AgentPoolService(stateManager, agentRoleRegistry);
    terminalManager = new TerminalManager();
    
    // Check if Unity features are enabled
    const unityFeaturesEnabled = vsConfig.get<boolean>('enableUnityFeatures', true);
    console.log(`Agentic Planning: Unity features ${unityFeaturesEnabled ? 'enabled' : 'disabled'}`);
    
    // Configure services for Unity mode
    agentRoleRegistry.setUnityEnabled(unityFeaturesEnabled);
    
    // Register and initialize unified coordinator service
    ServiceLocator.register(UnifiedCoordinatorService, () => 
        new UnifiedCoordinatorService(stateManager, agentPoolService, agentRoleRegistry)
    );
    unifiedCoordinatorService = ServiceLocator.resolve(UnifiedCoordinatorService);
    
    // Create PlanningService with coordinator (now required)
    planningService = new PlanningService(stateManager, unifiedCoordinatorService);
        
        // Create providers with initialized services
        planningSessionsProvider = new PlanningSessionsProvider(stateManager);
        agentPoolProvider = new AgentPoolProvider(agentPoolService);
        
        // Set services on sidebar provider
        sidebarProvider.setServices(stateManager, agentPoolService);
    
    cliHandler = new CliHandler(stateManager, agentPoolService, unifiedCoordinatorService, planningService, terminalManager);
    
    // Initialize WorkflowPauseManager with StateManager for persistence
    const pauseManager = ServiceLocator.resolve(WorkflowPauseManager);
    pauseManager.setStateManager(stateManager);
    
    // Recover any sessions that were paused when extension was deactivated
    unifiedCoordinatorService.recoverAllSessions().then((count) => {
        if (count > 0) {
            console.log(`Agentic Planning: Recovered ${count} paused workflow(s)`);
            vscode.window.showInformationMessage(
                `Recovered ${count} paused workflow(s). Check the sidebar to resume.`
            );
        }
    }).catch((e) => {
        console.error('Agentic Planning: Failed to recover sessions:', e);
    });
    
    // Clean up old temp files from previous sessions
    const tempAgentRunner = ServiceLocator.resolve(AgentRunner);
    const cleaned = (tempAgentRunner as any).cleanupTempFiles?.();
    if (cleaned > 0) {
        console.log(`Agentic Planning: Cleaned up ${cleaned} old temp files`);
    }
    
    // ========================================================================
    // Daemon Connection
    // ========================================================================
    
    // Initialize daemon manager and ensure daemon is running
    daemonManager = new DaemonManager(workspaceRoot, context.extensionPath);
    
    try {
        const daemonResult = await daemonManager.ensureDaemonRunning();
        console.log(`Agentic Planning: Daemon on port ${daemonResult.port} (wasStarted: ${daemonResult.wasStarted}, isExternal: ${daemonResult.isExternal})`);
        
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
        
        // Connect to daemon
        await vsCodeClient.connect();
        console.log('Agentic Planning: Connected to daemon');
        
        // If daemon was external (started by CLI), show info
        if (daemonResult.isExternal) {
            vscode.window.showInformationMessage(
                'Connected to existing APC daemon (started externally). State is shared with CLI.'
            );
        }
        
        // Create DaemonStateProxy
        const unityFeaturesEnabled = vscode.workspace.getConfiguration('agenticPlanning').get<boolean>('enableUnityFeatures', true);
        daemonStateProxy = new DaemonStateProxy({
            isExternal: daemonResult.isExternal,
            vsCodeClient: daemonResult.isExternal ? vsCodeClient : undefined,
            stateManager: daemonResult.isExternal ? undefined : stateManager,
            agentPoolService: daemonResult.isExternal ? undefined : agentPoolService,
            unityEnabled: unityFeaturesEnabled
        });
        console.log(`Agentic Planning: DaemonStateProxy created (isExternal: ${daemonResult.isExternal})`);
        
        // Pass proxy to providers
        sidebarProvider.setStateProxy(daemonStateProxy);
        
        // Subscribe to events for UI updates
        vsCodeClient.subscribe('session.updated', () => {
            // Refresh state from files when daemon reports changes
            daemonStateProxy?.reloadFromFiles();
            planningSessionsProvider?.refresh();
            sidebarProvider?.refresh();
        });
        
        vsCodeClient.subscribe('pool.changed', () => {
            daemonStateProxy?.reloadFromFiles();
            agentPoolProvider?.refresh();
            sidebarProvider?.refresh();
        });
        
    } catch (daemonError) {
        console.error('Agentic Planning: Failed to connect to daemon:', daemonError);
        vscode.window.showWarningMessage(
            'Could not connect to APC daemon. Some features may not work. Try running: apc system run --headless'
        );
        
        // Create local-only proxy as fallback
        const unityFeaturesEnabled = vscode.workspace.getConfiguration('agenticPlanning').get<boolean>('enableUnityFeatures', true);
        daemonStateProxy = new DaemonStateProxy({
            isExternal: false,
            stateManager,
            agentPoolService,
            unityEnabled: unityFeaturesEnabled
        });
        sidebarProvider.setStateProxy(daemonStateProxy);
    }
    
    } catch (error) {
        console.error('Agentic Planning: Failed to initialize services:', error);
        vscode.window.showErrorMessage(`Agentic Planning failed to initialize: ${error}`);
    
        // Create dummy state manager for error state providers
        const fallbackConfig = vscode.workspace.getConfiguration('agenticPlanning');
        stateManager = new StateManager({
            workspaceRoot,
            workingDirectory: fallbackConfig.get('workingDirectory', '_AiDevLog'),
            agentPoolSize: fallbackConfig.get('agentPoolSize', 5),
            defaultBackend: fallbackConfig.get('defaultBackend', 'cursor') as 'cursor' | 'claude-code' | 'codex'
        });
        agentRoleRegistry = new AgentRoleRegistry(stateManager);
        // Set Unity enabled state even in fallback path
        const unityEnabledFallback = fallbackConfig.get<boolean>('enableUnityFeatures', true);
        agentRoleRegistry.setUnityEnabled(unityEnabledFallback);
        
        agentPoolService = new AgentPoolService(stateManager, agentRoleRegistry);
        planningSessionsProvider = new PlanningSessionsProvider(stateManager);
        agentPoolProvider = new AgentPoolProvider(agentPoolService);
    }
    
    // Initialize Unity Control Manager only if Unity features are enabled AND services initialized
    const unityFeaturesEnabledForUI = vscode.workspace.getConfiguration('agenticPlanning').get<boolean>('enableUnityFeatures', true);
    let unityControlManager: UnityControlManager | undefined;
    
    if (unityFeaturesEnabledForUI && unifiedCoordinatorService) {
        unityControlManager = ServiceLocator.resolve(UnityControlManager);
        unityControlManager.setAgentRoleRegistry(agentRoleRegistry);
        if (workspaceRoot) {
            unityControlManager.initialize(workspaceRoot);
        }
        
        // Connect Unity Control Manager events to UI
        unityControlManager.onStatusChanged(() => {
            sidebarProvider.refresh();
        });
        
        // Connect coordinator service to Unity manager
        unifiedCoordinatorService.setUnityEnabled(true, unityControlManager);
        
        console.log('Agentic Planning: Unity Control Manager initialized');
    } else if (unifiedCoordinatorService) {
        // Unity features disabled - notify coordinator service
        unifiedCoordinatorService.setUnityEnabled(false);
        console.log('Agentic Planning: Unity features disabled, skipping Unity Control Manager');
    }
    
    // Pass Unity enabled state to sidebar provider
    sidebarProvider.setUnityEnabled(unityFeaturesEnabledForUI);
    
    // Listen for task.failedFinal events to open agent chat for user intervention
    const broadcaster = ServiceLocator.resolve(EventBroadcaster);
    broadcaster.on('task.failedFinal', async (data: TaskFailedFinalEventData) => {
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
    });

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarViewProvider.viewType, sidebarProvider)
    );

    // Watch for state file changes to auto-refresh UI (CLI updates files directly)
    // Structure: _AiDevLog/.cache/ for runtime state, _AiDevLog/Plans/{sessionId}/ for session state
    const configWatch = vscode.workspace.getConfiguration('agenticPlanning');
    const workingDirectory = configWatch.get<string>('workingDirectory', '_AiDevLog');
    const stateFilesPattern = new vscode.RelativePattern(
        vscode.Uri.file(workspaceRoot), 
        `${workingDirectory}/{.cache/*.json,Plans/*/session.json,Plans/*/tasks.json}`
    );
    
    const stateFileWatcher = vscode.workspace.createFileSystemWatcher(stateFilesPattern);
    
    // Debounce refresh to avoid rapid-fire updates
    let refreshTimeout: NodeJS.Timeout | undefined;
    const debouncedRefresh = () => {
        if (refreshTimeout) {
            clearTimeout(refreshTimeout);
        }
        refreshTimeout = setTimeout(async () => {
            // Reload state from files (async with locking)
            await stateManager.reloadFromFiles();
            // Refresh all UI providers
            sidebarProvider.refresh();
        }, 500); // 500ms debounce
    };
    
    stateFileWatcher.onDidChange(debouncedRefresh);
    stateFileWatcher.onDidCreate(debouncedRefresh);
    stateFileWatcher.onDidDelete(debouncedRefresh);
    
    context.subscriptions.push(stateFileWatcher);
    
    console.log('State file watcher initialized for auto-refresh');

    // Connect planning service events to UI refresh
    planningService.onSessionsChanged(() => {
        sidebarProvider.refresh();
    });

    // Configure DependencyService for Unity mode and check dependencies on startup
    const unityEnabledForDeps = vscode.workspace.getConfiguration('agenticPlanning').get<boolean>('enableUnityFeatures', true);
    dependencyService.setUnityEnabled(unityEnabledForDeps);
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

    // Register commands
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

        // Execution commands (facade to CoordinatorService via PlanningService)
        vscode.commands.registerCommand('agenticPlanning.startExecution', async (item?: PlanningSessionItem) => {
            const sessionId = item?.session?.id;
            if (!sessionId) {
                // No item selected - show picker
                const sessions = planningService.listPlanningSessions()
                    .filter(s => s.status === 'approved');
                if (sessions.length === 0) {
                    vscode.window.showWarningMessage('No approved plans available to execute.');
                    return;
                }
                const selected = await vscode.window.showQuickPick(
                    sessions.map(s => ({ 
                        label: s.id, 
                        description: s.requirement.substring(0, 50) + '...',
                        session: s 
                    })),
                    { placeHolder: 'Select a plan to execute' }
                );
                if (!selected) {return;}
                
                const result = await planningService.startExecution(selected.session.id);
                if (result.success) {
                    vscode.window.showInformationMessage(`Execution started with ${result.engineerCount} engineers!`);
                } else {
                    vscode.window.showErrorMessage(`Failed to start: ${result.error}`);
                }
            } else {
                const result = await planningService.startExecution(sessionId);
                if (result.success) {
                    vscode.window.showInformationMessage(`Execution started with ${result.engineerCount} engineers!`);
                } else {
                    vscode.window.showErrorMessage(`Failed to start: ${result.error}`);
                }
            }
            sidebarProvider.refresh();
        }),

        vscode.commands.registerCommand('agenticPlanning.pauseExecution', async (item?: PlanningSessionItem) => {
            const sessionId = item?.session?.id;
            if (!sessionId) {
                vscode.window.showWarningMessage('No session selected');
                return;
            }
            const result = await planningService.pauseExecution(sessionId);
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
            const result = await planningService.resumeExecution(sessionId);
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
                const result = await planningService.stopExecution(sessionId);
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
            
            if (!unifiedCoordinatorService) {
                vscode.window.showWarningMessage('Coordinator service not available');
                return;
            }
            
            const workflowId = await unifiedCoordinatorService.retryFailedTask(sessionId, taskId);
            if (workflowId) {
                sidebarProvider.refresh();
            }
        }),

        vscode.commands.registerCommand('agenticPlanning.showAgentTerminal', async (agentName?: string) => {
            if (!agentName) {
                const busyAgents = agentPoolService.getBusyAgents();
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
                terminalManager.showAgentTerminal(agentName);
            }
        }),

        vscode.commands.registerCommand('agenticPlanning.poolStatus', () => {
            const status = agentPoolService.getPoolStatus();
            vscode.window.showInformationMessage(
                `Agent Pool: ${status.available.length} available, ${status.busy.length} busy (Total: ${status.total})`
            );
        }),
        
        // Role settings command
        vscode.commands.registerCommand('apc.openRoleSettings', () => {
            RoleSettingsPanel.show(agentRoleRegistry, context.extensionUri);
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
                const result = await planningService.stopSession(sessionId);
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
                const result = await planningService.removeSession(sessionId);
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
                const result = await planningService.resumeSession(sessionId);
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
            
            const session = planningService.getPlanningStatus(sessionId);
            if (!session) {
                vscode.window.showErrorMessage(`Session ${sessionId} not found`);
                return;
            }
            
            // Pre-filled prompt for revision
            const revisionPrompt = `I want to revise the plan for session ${sessionId}.

Current plan: ${session.currentPlanPath}
Original requirement: ${session.requirement.substring(0, 200)}...

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
                // Approve plan with autoStart=true (handles execution internally)
                await planningService.approvePlan(sessionId, true);
                // Note: approvePlan with autoStart=true already starts execution and shows messages
                sidebarProvider.refresh();
            }
        }),
        
        vscode.commands.registerCommand('agenticPlanning.refreshAgentPool', () => {
            // Also sync with settings when manually refreshed
            const configSize = vscode.workspace.getConfiguration('agenticPlanning').get<number>('agentPoolSize', 5);
            const currentSize = agentPoolService.getPoolStatus().total;
            if (configSize !== currentSize) {
                const result = agentPoolService.resizePool(configSize);
                if (result.added.length > 0) {
                    vscode.window.showInformationMessage(`Added agents: ${result.added.join(', ')}`);
                }
                if (result.removed.length > 0) {
                    vscode.window.showInformationMessage(`Removed agents: ${result.removed.join(', ')}`);
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
                agentPoolService.releaseAgents([agentName]);
                sidebarProvider.refresh();
                vscode.window.showInformationMessage(`${agentName} released back to pool`);
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
                    shellArgs: ['-c', 'echo "Agentic Planning CLI ready. Use: agentic <command>"']
                });
            }
        })
    );

    // Start state update interval
    const updateInterval = vscode.workspace.getConfiguration('agenticPlanning').get<number>('stateUpdateInterval', 5000);
    const intervalId = setInterval(() => {
        stateManager.updateStateFiles();
    }, updateInterval);

    context.subscriptions.push({
        dispose: () => clearInterval(intervalId)
    });

    // Listen for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('agenticPlanning.agentPoolSize')) {
                const newSize = vscode.workspace.getConfiguration('agenticPlanning').get<number>('agentPoolSize', 5);
                const result = agentPoolService.resizePool(newSize);
                if (result.added.length > 0) {
                    vscode.window.showInformationMessage(`Added agents: ${result.added.join(', ')}`);
                }
                if (result.removed.length > 0) {
                    vscode.window.showInformationMessage(`Removed agents: ${result.removed.join(', ')}`);
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
    
    // Disconnect from daemon (but don't stop it - CLI may still need it)
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
    
    // Dispose UnifiedCoordinatorService (stops all workflows and sessions)
    if (unifiedCoordinatorService) {
        try {
            await unifiedCoordinatorService.dispose();
            console.log('UnifiedCoordinatorService disposed');
        } catch (e) {
            console.error('Error disposing UnifiedCoordinatorService:', e);
        }
    }
    
    // Dispose PlanningService (stops agent runner, clears intervals)
    if (planningService) {
        try {
            planningService.dispose();
            console.log('PlanningService disposed');
        } catch (e) {
            console.error('Error disposing PlanningService:', e);
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
    
    // Dispose StateManager (releases file lock)
    if (stateManager) {
        try {
            stateManager.dispose();
            console.log('StateManager disposed');
        } catch (e) {
            console.error('Error disposing StateManager:', e);
        }
    }
    
    console.log('Agentic Planning Coordinator deactivated');
}

