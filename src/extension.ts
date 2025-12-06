import * as vscode from 'vscode';
import * as path from 'path';
import { TerminalManager } from './services/TerminalManager';
import { DependencyService } from './services/DependencyService';
import { getFolderStructureManager } from './services/FolderStructureManager';
import { RoleSettingsPanel } from './ui/RoleSettingsPanel';
import { WorkflowSettingsPanel } from './ui/WorkflowSettingsPanel';
import { DependencyMapPanel } from './ui/DependencyMapPanel';
import { HistoryViewPanel } from './ui/HistoryViewPanel';
import { SidebarViewProvider } from './ui/SidebarViewProvider';
import { NodeGraphEditorPanel } from './ui/NodeGraphEditorPanel';
import { DaemonManager } from './vscode/DaemonManager';
import { VsCodeClient } from './vscode/VsCodeClient';
import { DaemonStateProxy } from './services/DaemonStateProxy';
import { ServiceLocator } from './services/ServiceLocator';
import { Logger } from './utils/Logger';

const log = Logger.create('Client', 'Extension');

// Module-level references (kept minimal - only what must be local)
let terminalManager: TerminalManager;
let daemonManager: DaemonManager;
let vsCodeClient: VsCodeClient;
let daemonStateProxy: DaemonStateProxy;

// Track event subscriptions for cleanup (prevents duplicate handlers on hot reload)
let eventSubscriptions: Array<() => void> = [];

// Global daemon client singleton to prevent duplicate connections
let globalVsCodeClient: VsCodeClient | null = null;

function getOrCreateDaemonClient(port: number): VsCodeClient {
    if (globalVsCodeClient && globalVsCodeClient.isConnected()) {
        log.debug('Reusing existing daemon connection');
        return globalVsCodeClient;
    }
    
    log.debug('Creating new daemon connection');
    globalVsCodeClient = new VsCodeClient({ 
        clientId: `vscode-${process.pid}`, // Include process PID
        url: `ws://127.0.0.1:${port}`
    });
    
    return globalVsCodeClient;
}

/**
 * Open agent chat in Cursor/VS Code, paste clipboard content, and send.
 * Tries multiple approaches:
 * 1. Keyboard automation (most reliable for NEW chat window)
 * 2. Cursor-specific VS Code commands (as fallback)
 * 3. Shows manual instructions as final fallback
 * 
 * Note: We prioritize keyboard automation because it reliably opens a NEW chat,
 * whereas some VS Code commands might reuse existing chat windows.
 */
async function openAgentChat(): Promise<void> {
    const { exec } = require('child_process');
    const isMac = process.platform === 'darwin';
    const modifierKey = isMac ? 'Cmd' : 'Ctrl';
    
    log.info('Opening new agent chat window...');
    
    // FIRST: Try keyboard automation (most reliable for opening NEW chat)
    // The Ctrl+Shift+L (or Cmd+Shift+L) keyboard shortcut reliably opens a NEW agent chat
    let automationAttempted = false;
    
    if (process.platform === 'darwin') {
        // macOS: Use AppleScript to send keyboard shortcut with proper timing
        automationAttempted = true;
        const script = `
            tell application "Cursor" to activate
            delay 0.3
            tell application "System Events" to keystroke "l" using {command down, shift down}
            delay 1.2
            tell application "System Events" to keystroke "v" using command down
            delay 0.5
            tell application "System Events" to key code 36
        `;
        exec(`osascript -e '${script}'`, (error: Error | null) => {
            if (error) {
                log.warn('AppleScript automation failed:', error);
                vscode.window.showInformationMessage(
                    `Planning prompt copied to clipboard!\n\nPress ${modifierKey}+Shift+L to open NEW Agent chat, then ${modifierKey}+V to paste and Enter to submit.`,
                    'OK'
                );
            } else {
                log.info('AppleScript automation succeeded - new chat opened and submitted');
            }
        });
    } else if (process.platform === 'win32') {
        // Windows: Use PowerShell to send keyboard shortcut with proper timing
        automationAttempted = true;
        const timestamp = Date.now();
        const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait("^+l")
Start-Sleep -Milliseconds 1200
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 500
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
`;
        // Write script to temp file
        const fs = require('fs');
        const path = require('path');
        const tempFile = path.join(require('os').tmpdir(), `apc_chat_${timestamp}.ps1`);
        
        try {
            fs.writeFileSync(tempFile, psScript, 'utf8');
            exec(`powershell -ExecutionPolicy Bypass -File "${tempFile}"`, (error: Error | null) => {
                // Clean up temp file
                try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
                
                if (error) {
                    log.warn('PowerShell automation failed:', error);
                    vscode.window.showInformationMessage(
                        `Planning prompt copied to clipboard!\n\nPress ${modifierKey}+Shift+L to open NEW Agent chat, then ${modifierKey}+V to paste and Enter to submit.\n\nTip: "cursor agent" CLI available for terminal interaction.`,
                        'OK'
                    );
                } else {
                    log.info('PowerShell automation succeeded - new chat opened and submitted');
                }
            });
        } catch (writeError) {
            log.error('Failed to write PowerShell script:', writeError);
            vscode.window.showInformationMessage(
                `Planning prompt copied to clipboard!\n\nPress ${modifierKey}+Shift+L to open NEW Agent chat, then ${modifierKey}+V to paste and Enter to submit.\n\nTip: "cursor agent" CLI available for terminal interaction.`,
                'OK'
            );
        }
    } else {
        // Linux: Use xdotool if available with proper timing
        exec('which xdotool', (err: Error | null) => {
            if (!err) {
                automationAttempted = true;
                exec('sleep 0.4 && xdotool key ctrl+shift+l && sleep 1.2 && xdotool key ctrl+v && sleep 0.5 && xdotool key Return', (error: Error | null) => {
                    if (error) {
                        log.warn('xdotool automation failed:', error);
                        vscode.window.showInformationMessage(
                            `Planning prompt copied to clipboard! Press ${modifierKey}+Shift+L to open NEW Agent chat, then ${modifierKey}+V to paste and Enter to submit.`
                        );
                    } else {
                        log.info('xdotool automation succeeded - new chat opened and submitted');
                    }
                });
            } else {
                log.warn('xdotool not found, showing manual instructions');
                vscode.window.showInformationMessage(
                    `Planning prompt copied to clipboard! Press ${modifierKey}+Shift+L to open NEW Agent chat, then ${modifierKey}+V to paste and Enter to submit.`
                );
            }
        });
    }
    
    // If no automation attempted, try VS Code commands as fallback
    if (!automationAttempted) {
        log.info('No platform automation available, trying VS Code commands...');
        try {
            const commands = await vscode.commands.getCommands(true);
            
            // Try known Cursor command patterns that explicitly create NEW chats
            const knownCommands = [
                'aichat.newchataction',
                'aichat.newAgentChat',
                'aichat.newChat',
                'composer.newComposerSession',
                'composer.new'
            ];
            
            for (const cmdName of knownCommands) {
                if (commands.includes(cmdName)) {
                    log.info(`Found and executing command: ${cmdName}`);
                    try {
                        await vscode.commands.executeCommand(cmdName);
                        // If command succeeded, paste clipboard content
                        setTimeout(async () => {
                            try {
                                await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
                                log.info('Successfully opened chat and pasted content via command');
                            } catch (pasteError) {
                                log.warn('Failed to paste content:', pasteError);
                            }
                        }, 500);
                        return;
                    } catch (cmdError) {
                        log.warn(`Command ${cmdName} failed:`, cmdError);
                    }
                }
            }
            
            // Log available commands for debugging
            const chatCommands = commands.filter(cmd => 
                cmd.toLowerCase().includes('aichat') ||
                cmd.toLowerCase().includes('composer') ||
                cmd.toLowerCase().includes('chat')
            );
            
            if (chatCommands.length > 0) {
                log.info('Available chat commands:', chatCommands.slice(0, 20).join(', '));
            }
        } catch (e) {
            log.debug('Could not discover/execute Cursor commands:', e);
        }
    }
}

export async function activate(context: vscode.ExtensionContext) {
    log.info('===== ACTIVATION START =====');

    // Get workspace root
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showWarningMessage('Agentic Planning: No workspace folder open');
        return;
    }
    log.info(`Step 1: Workspace root = ${workspaceRoot}`);
    
    // Initialize FolderStructureManager early (needed by settings panels)
    // Uses standard _AiDevLog directory
    getFolderStructureManager(workspaceRoot);
    log.info(`Step 1a: FolderStructureManager initialized with workingDir = ${path.join(workspaceRoot, '_AiDevLog')}`);
    
    // Register extension-local services only (NO daemon services!)
    // Extension is a pure GUI client - all state comes from daemon
    // Note: Process management (including orphan cleanup) is handled by daemon
    log.debug('Step 2: Registering extension-local services...');
    ServiceLocator.register(DependencyService, () => new DependencyService());
    ServiceLocator.markInitialized();
    log.debug('Step 2: Extension-local services registered (no AgentRunner - connectivity tests run in daemon)');
    
    // ========================================================================
    // ARCHITECTURE GUARD: Verify extension hasn't registered daemon services
    // ========================================================================
    log.debug('Step 3: Verifying architecture guards...');
    
    // List of services that should ONLY exist in daemon, NEVER in extension
    const daemonOnlyServices = [
        'StateManager',
        'TaskManager', 
        'AgentPoolService',
        'AgentRoleRegistry',
        'UnifiedCoordinatorService',
        'AgentRunner',
        'CursorAgentRunner',
        'UnityControlManager',
        'WorkflowPauseManager',
        'EventBroadcaster',
        'OutputChannelManager',
        'PlanCache',
        'ErrorClassifier'
    ];
    
    const registeredServices = ServiceLocator.getRegisteredServices();
    const violations = daemonOnlyServices.filter(service => registeredServices.includes(service));
    
    if (violations.length > 0) {
        const errorMsg = `FATAL ARCHITECTURE VIOLATION: Extension registered daemon-only services: ${violations.join(', ')}`;
        log.error(errorMsg);
        vscode.window.showErrorMessage(errorMsg);
        throw new Error(errorMsg);
    }
    
    log.debug('Step 2a: Architecture guards passed');
    log.debug(`Extension services: ${registeredServices.join(', ')}`);
    log.debug('(All core business logic runs in daemon)');

    // Initialize local-only services
    terminalManager = new TerminalManager();
    
    // Initialize DependencyService (local utility)
    const dependencyService = ServiceLocator.resolve(DependencyService);
    dependencyService.setWorkspaceRoot(workspaceRoot);
    const config = vscode.workspace.getConfiguration('agenticPlanning');
    const unityFeaturesEnabled = config.get<boolean>('enableUnityFeatures', true);
    dependencyService.setUnityEnabled(unityFeaturesEnabled);
    
    // Note: NO periodic checks in extension
    // - Extension queries daemon API (daemon checks on startup)
    // - User can manually refresh via UI button
    // - Daemon re-checks after install/uninstall operations
    // - Extension DependencyService can't run connectivity tests (no AgentRunner)
    // - Only daemon can run real MCP connectivity tests via cursor-agent CLI

    // Create UI providers
    log.debug('Step 3: Creating sidebar provider...');
    const sidebarProvider = new SidebarViewProvider(context.extensionUri);
    sidebarProvider.setUnityEnabled(unityFeaturesEnabled);
    log.debug('Step 3: Sidebar provider created');
    
    // ========================================================================
    // EARLY UI Registration - Show UI before daemon connection
    // This allows users to see connection status, dependency checks, etc.
    // ========================================================================
    log.debug('Step 4: Registering webview provider early...');
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarViewProvider.viewType, sidebarProvider)
    );
    log.debug('Step 4: Webview provider registered (UI now visible with "connecting" status)');
    
    // ========================================================================
    // Daemon Connection - Runs in background so UI is responsive
    // ========================================================================
    log.debug('Step 5: Starting daemon connection in background...');
    
    // Initialize daemon manager
    daemonManager = new DaemonManager(workspaceRoot, context.extensionPath);
    
    // Helper function to set up event subscriptions after connection
    const setupEventSubscriptions = () => {
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
                log.debug(`agent.allocated event received:`, JSON.stringify(data));
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
            vsCodeClient.subscribe('workflow.completed', (data: unknown) => {
                log.debug('Workflow completed, refreshing UI');
                const completionData = data as { workflowId: string };
                // Remove from tracked workflows to prevent stale queries
                if (completionData.workflowId && sidebarProvider) {
                    sidebarProvider.clearWorkflowTracking(completionData.workflowId);
                }
                // Clear workflow from client cache to prevent memory leaks
                if (completionData.workflowId) {
                    vsCodeClient.clearWorkflowCache(completionData.workflowId);
                }
                sidebarProvider?.refresh();
            })
        );
        
        // Subscribe to workflow cleanup events
        eventSubscriptions.push(
            vsCodeClient.subscribe('workflows.cleaned', () => {
                log.debug('Workflows cleaned up, refreshing UI');
                sidebarProvider?.refresh();
            })
        );
        
        // Subscribe to disconnection events to update UI
        eventSubscriptions.push(
            vsCodeClient.subscribe('disconnected', () => {
                log.warn('Daemon disconnected, refreshing UI');
                sidebarProvider?.refresh();
            })
        );
        
        // Subscribe to Unity status changes to update Unity GUI
        if (unityFeaturesEnabled) {
            eventSubscriptions.push(
                vsCodeClient.subscribe('unity.statusChanged', () => {
                    log.debug('Unity status changed, refreshing UI');
                    sidebarProvider?.refresh();
                })
            );
            
            eventSubscriptions.push(
                vsCodeClient.subscribe('unity.pipelineStarted', () => {
                    log.debug('Unity pipeline started, refreshing UI');
                    sidebarProvider?.refresh();
                })
            );
            
            eventSubscriptions.push(
                vsCodeClient.subscribe('unity.pipelineCompleted', () => {
                    log.debug('Unity pipeline completed, refreshing UI');
                    sidebarProvider?.refresh();
                })
            );
        }
        
        // Listen for task.failedFinal events from daemon via WebSocket
        eventSubscriptions.push(
            vsCodeClient.subscribe('task.failedFinal', async (data: unknown) => {
                const failedData = data as { 
                    errorType?: string; 
                    taskId?: string; 
                    clarityQuestion?: string; 
                    lastError?: string; 
                    sessionId?: string; 
                    attempts?: number; 
                    canRetry?: boolean 
                };
                const isNeedsClarity = failedData.errorType === 'needs_clarity';
                
                const prompt = isNeedsClarity 
                    ? `Engineer needs clarity on task "${failedData.taskId}":
${failedData.clarityQuestion || failedData.lastError}

Session: ${failedData.sessionId}
Please help clarify, then use:
  apc plan revise ${failedData.sessionId} "<your clarification>"

IMPORTANT - Status Polling Timing:
After running "apc plan revise", the revision process takes about 80 seconds to complete.
- Wait 80 seconds before checking status the first time
- Then poll every 30 seconds: sleep 30 && apc plan status ${failedData.sessionId}
- Do NOT poll more frequently - the multi-agent debate takes time!`
                    : `Task "${failedData.taskId}" failed after ${failedData.attempts} attempt(s).

Error: ${failedData.lastError}
Session: ${failedData.sessionId}
${failedData.canRetry ? 'Can retry.' : 'Cannot retry (permanent error).'}

Options:
1. Revise plan: apc plan revise ${failedData.sessionId} "<feedback>"
2. ${failedData.canRetry ? `Retry: apc task retry ${failedData.sessionId} ${failedData.taskId}` : 'Skip task via revision'}

IMPORTANT - Status Polling Timing:
If you revise the plan, the revision process takes about 80 seconds to complete.
- Wait 80 seconds before checking status the first time
- Then poll every 30 seconds: sleep 30 && apc plan status ${failedData.sessionId}
- Do NOT poll more frequently - the multi-agent debate takes time!`;

                // Copy prompt to clipboard and open agent chat
                await vscode.env.clipboard.writeText(prompt);
                await openAgentChat();
                
                // Also show a notification
                const action = isNeedsClarity ? 'Needs Clarity' : 'Task Failed';
                vscode.window.showWarningMessage(
                    `${action}: ${failedData.taskId} - ${failedData.lastError?.substring(0, 50)}...`,
                    'View in Chat'
                ).then(selection => {
                    if (selection === 'View in Chat') {
                        // Chat was already opened, just show info
                        vscode.window.showInformationMessage('Check the agent chat for details and next steps.');
                    }
                });
            })
        );
        
        // Listen for daemon.ready event - daemon broadcasts this after all services (including dependency checks) are initialized
        // Flow:
        // 1. Daemon starts (standalone.ts::initializeServices)
        // 2. Checks dependencies (DependencyService::checkAllDependencies)
        // 3. Initializes all services (AgentPoolService, UnifiedCoordinatorService, etc.)
        // 4. Calls daemon.setServicesReady() which broadcasts 'daemon.ready'
        // 5. Extension receives event and shows "Coordinator ready!" message
        // This ensures we don't show "ready" before dependency checks complete
        eventSubscriptions.push(
            vsCodeClient.subscribe('daemon.ready', (data: unknown) => {
                log.info('Daemon is fully ready - all services initialized and dependencies checked');
                
                // NOW start connection health monitoring - daemon is fully initialized
                // Starting it earlier causes health changes that trigger refreshes
                // which wipe out initialization progress messages
                if (daemonStateProxy && !daemonStateProxy['healthCheckTimer']) {
                    log.info('Starting connection health monitoring now that daemon is ready');
                    daemonStateProxy.startConnectionMonitor(15000);
                }
                
                vscode.window.showInformationMessage('Agentic Planning Coordinator ready!');
                sidebarProvider?.refresh();
            })
        );
    };
    
    // Connect to daemon in background - don't block UI
    // Use immediately-invoked async function to handle the connection
    (async () => {
        try {
            const connectionStartTime = Date.now();
            log.debug('Step 5a: Calling ensureDaemonRunning...');
            const daemonResult = await daemonManager.ensureDaemonRunning();
            log.info(`Step 5b: Daemon on port ${daemonResult.port} (wasStarted: ${daemonResult.wasStarted}, isExternal: ${daemonResult.isExternal}, took ${Date.now() - connectionStartTime}ms)`);
            
            // Create and connect VS Code client using singleton
            const connectStartTime = Date.now();
            vsCodeClient = getOrCreateDaemonClient(daemonResult.port);
            
            // Set up notification callbacks
            vsCodeClient.setNotificationCallbacks({
                showInfo: (msg) => vscode.window.showInformationMessage(msg),
                showWarning: (msg) => vscode.window.showWarningMessage(msg),
                showError: (msg) => vscode.window.showErrorMessage(msg)
            });
            
            // Connect to daemon with retry (daemon may still be starting up)
            log.debug('Step 5c: Connecting to daemon...');
            const maxRetries = 5;
            let lastError: Error | undefined;
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    await vsCodeClient.connect();
                    log.info(`Step 5d: Connected to daemon (took ${Date.now() - connectStartTime}ms, ${attempt} attempt(s))`);
                    break;
                } catch (err) {
                    lastError = err as Error;
                    log.warn(`Connection attempt ${attempt}/${maxRetries} failed: ${lastError.message}`);
                    if (attempt < maxRetries) {
                        // Wait before retry (100ms, 200ms, 400ms, 800ms)
                        await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt - 1)));
                    }
                    // Refresh UI to show retry count
                    sidebarProvider.refresh();
                }
            }
            if (!vsCodeClient.isConnected()) {
                throw lastError || new Error('Failed to connect to daemon');
            }
            log.info(`Total connection time: ${Date.now() - connectionStartTime}ms (daemon start + connection)`);
            
            // Set up config provider for TerminalManager to use daemon config
            terminalManager.setConfigProvider(async () => {
                const config = await vsCodeClient.getConfig() as { autoOpenTerminals?: boolean };
                return { autoOpenTerminals: config?.autoOpenTerminals };
            });
            
            // If daemon was external (started by CLI), show info
            if (daemonResult.isExternal) {
                vscode.window.showInformationMessage(
                    'Connected to existing APC daemon (started externally). State is shared with CLI.'
                );
            }
            
            // Create DaemonStateProxy - all state reads go through this
            daemonStateProxy = new DaemonStateProxy({
                vsCodeClient,
                unityEnabled: unityFeaturesEnabled,
                workspaceRoot
            });
            log.debug('DaemonStateProxy created (daemon-only mode)');
            
            // DON'T start connection health monitoring yet - wait for daemon.ready
            // Starting it immediately causes health changes during initialization
            // which triggers UI refreshes that wipe out progress messages
            // The health monitor will be started when daemon.ready fires
            
            // Pass proxy to providers - this transitions UI from "connecting" to real state
            sidebarProvider.setStateProxy(daemonStateProxy);
            
            // Set up event subscriptions
            setupEventSubscriptions();
            
        } catch (daemonError) {
            log.error('Failed to connect to daemon:', daemonError);
            vscode.window.showWarningMessage(
                'Could not connect to APC daemon. Run "apc daemon run --headless" or restart Cursor.'
            );
            
            // Create proxy with unconnected client - UI will show "daemon missing"
            // Auto-reconnect will attempt to connect once daemon port file appears
            vsCodeClient = new VsCodeClient({ clientId: 'vscode-extension' });
            daemonStateProxy = new DaemonStateProxy({
                vsCodeClient,
                unityEnabled: unityFeaturesEnabled,
                workspaceRoot
            });
            // DON'T start health monitoring yet - will start when daemon.ready fires
            sidebarProvider.setStateProxy(daemonStateProxy);
            
            // Set up event subscriptions (will activate when connection is established)
            setupEventSubscriptions();
        }
    })();
    
    // Note: Agent temp file cleanup is now handled by daemon
    // (AgentRunner lives in daemon where agents are actually spawned)
    
    log.debug('Step 6: Daemon connection initiated in background');

    // Note: Dependency checking is now daemon-only
    // Extension queries daemon via API instead of running local checks
    // This avoids duplicate work and ensures single source of truth

    // ========================================================================
    // Auto-update APC CLI if needed (dev → installed transition)
    // ========================================================================
    (async () => {
        try {
            const apcStatus = await dependencyService['checkApcCli']();
            if (!apcStatus.installed && apcStatus.description?.includes('needs update')) {
                log.info('APC CLI needs update - auto-updating to current extension path...');
                const result = await dependencyService.installApcCli(context.extensionPath);
                if (result.success) {
                    log.info('✅ APC CLI auto-updated successfully');
                } else {
                    log.warn(`Failed to auto-update APC CLI: ${result.message}`);
                }
            }
        } catch (err) {
            log.warn('Failed to check/update APC CLI:', err);
        }
    })();

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

IMPORTANT - Status Polling Timing:
After running "apc plan new", the planning process takes about 200 seconds to complete.
- Wait 200 seconds before checking status the first time
- Then poll every 60 seconds: sleep 60 && apc plan status <id>
- Do NOT poll more frequently - the multi-agent debate takes time!

Let's get started!`;

            // Copy prompt to clipboard and open agent chat
            await vscode.env.clipboard.writeText(planningPrompt);
            await openAgentChat();
        }),

        // Execution commands - all go through daemon
        vscode.commands.registerCommand('agenticPlanning.startExecution', async (item?: { session?: { id: string } }) => {
            if (!vsCodeClient?.isConnected()) {
                vscode.window.showErrorMessage('Not connected to daemon. Please wait for connection...');
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

        vscode.commands.registerCommand('agenticPlanning.pauseExecution', async (item?: { session?: { id: string } }) => {
            if (!vsCodeClient?.isConnected()) {
                vscode.window.showErrorMessage('Not connected to daemon. Please wait for connection...');
                return;
            }
            
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

        vscode.commands.registerCommand('agenticPlanning.resumeExecution', async (item?: { session?: { id: string } }) => {
            if (!vsCodeClient?.isConnected()) {
                vscode.window.showErrorMessage('Not connected to daemon. Please wait for connection...');
                return;
            }
            
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

        vscode.commands.registerCommand('agenticPlanning.stopExecution', async (item?: { session?: { id: string } }) => {
            if (!vsCodeClient?.isConnected()) {
                vscode.window.showErrorMessage('Not connected to daemon. Please wait for connection...');
                return;
            }
            
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
            if (!vsCodeClient?.isConnected()) {
                vscode.window.showErrorMessage('Not connected to daemon. Please wait for connection...');
                return;
            }
            
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
        
        // Role settings command - uses daemon API when available, falls back to defaults
        vscode.commands.registerCommand('apc.openRoleSettings', async () => {
            if (vsCodeClient.isConnected()) {
                // Use daemon-based role management
                RoleSettingsPanel.showWithClient(vsCodeClient, context.extensionUri);
            } else {
                // Use local registry mode (will fallback to defaults if no registry available)
                RoleSettingsPanel.showWithRegistry(undefined, context.extensionUri);
            }
        }),
        
        // Daemon settings command - manage daemon configuration (works offline)
        vscode.commands.registerCommand('apc.openDaemonSettings', async () => {
            const { SystemSettingsPanel } = await import('./ui/SystemSettingsPanel');
            SystemSettingsPanel.show(context.extensionUri, vsCodeClient, workspaceRoot);
        }),
        
        // Workflow settings command (works offline)
        vscode.commands.registerCommand('apc.openWorkflowSettings', async () => {
            WorkflowSettingsPanel.show(context.extensionUri, vsCodeClient, workspaceRoot);
        }),
        
        // Node Graph Editor command for custom workflows
        vscode.commands.registerCommand('apc.openNodeGraphEditor', async (uri?: vscode.Uri) => {
            NodeGraphEditorPanel.createOrShow(context.extensionUri, workspaceRoot, uri?.fsPath);
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
        
        // History view command - shows all workflow history for a session
        vscode.commands.registerCommand('agenticPlanning.openHistoryView', async (args?: { sessionId?: string }) => {
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
                    { placeHolder: 'Select a session to view workflow history' }
                );
                if (!selected) return;
                sessionId = selected.session.id;
            }
            
            HistoryViewPanel.show(sessionId, context.extensionUri, vsCodeClient);
        }),

        // Refresh commands for tree views
        vscode.commands.registerCommand('agenticPlanning.refreshPlanningSessions', () => {
            sidebarProvider.refresh();
        }),

        // Planning session management commands
        vscode.commands.registerCommand('agenticPlanning.stopPlanningSession', async (item?: { session?: { id: string } }) => {
            if (!vsCodeClient?.isConnected()) {
                vscode.window.showErrorMessage('Not connected to daemon. Please wait for connection...');
                return;
            }
            
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
            if (!vsCodeClient?.isConnected()) {
                vscode.window.showErrorMessage('Not connected to daemon. Please wait for connection...');
                return;
            }
            
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
            if (!vsCodeClient?.isConnected()) {
                vscode.window.showErrorMessage('Not connected to daemon. Please wait for connection...');
                return;
            }
            
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
            if (!vsCodeClient?.isConnected()) {
                vscode.window.showErrorMessage('Not connected to daemon. Please wait for connection...');
                return;
            }
            
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

This will trigger the multi-agent debate to revise the plan.

IMPORTANT - Status Polling Timing:
After running "apc plan revise", the revision process takes about 80 seconds to complete.
- Wait 80 seconds before checking status the first time
- Then poll every 30 seconds: sleep 30 && apc plan status ${sessionId}
- Do NOT poll more frequently - the multi-agent debate takes time!`;

            // Copy to clipboard and open agent chat
            await vscode.env.clipboard.writeText(revisionPrompt);
            await openAgentChat();
        }),
        
        // Approve plan and auto-start execution
        vscode.commands.registerCommand('agenticPlanning.approvePlan', async (item?: { session?: { id: string } }) => {
            if (!vsCodeClient?.isConnected()) {
                vscode.window.showErrorMessage('Not connected to daemon. Please wait for connection...');
                return;
            }
            
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

        // Kill stuck/orphan processes command (delegates to daemon)
        vscode.commands.registerCommand('agenticPlanning.killStuckProcesses', async () => {
            // Process management is handled by daemon - trigger via API if connected
            if (vsCodeClient?.isConnected()) {
                try {
                    const result = await vsCodeClient.killOrphanProcesses();
                    if (result.killed > 0) {
                        vscode.window.showInformationMessage(
                            `Killed ${result.killed} orphan cursor-agent processes`
                        );
                    } else {
                        vscode.window.showInformationMessage('No orphan processes found');
                    }
                    sidebarProvider.refresh();
                } catch (err) {
                    vscode.window.showWarningMessage(`Failed to kill processes: ${err}`);
                }
            } else {
                vscode.window.showWarningMessage('Not connected to daemon. Process cleanup happens automatically on daemon startup.');
            }
        }),

        // Show running processes command (process tracking is in daemon)
        vscode.commands.registerCommand('agenticPlanning.showRunningProcesses', async () => {
            // Process tracking is managed by the daemon
            vscode.window.showInformationMessage(
                'Process tracking is managed by the daemon. Check daemon logs for running process details.'
            );
        }),

        // Dependency commands
        vscode.commands.registerCommand('agenticPlanning.refreshDependencies', async () => {
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Checking dependencies...',
                cancellable: false
            }, async () => {
                // Trigger daemon to refresh dependencies (authoritative check)
                if (vsCodeClient.isConnected()) {
                    try {
                        await vsCodeClient.send('deps.refresh');
                        log.info('Daemon refreshed dependencies');
                    } catch (err) {
                        log.warn('Failed to refresh via daemon:', err);
                        vscode.window.showWarningMessage('Failed to refresh dependencies from daemon');
                    }
                } else {
                    vscode.window.showWarningMessage('Daemon not connected - cannot refresh dependencies');
                }
                sidebarProvider.refresh();
            });
        }),
        vscode.commands.registerCommand('agenticPlanning.stopDaemon', async () => {
            log.info('[stopDaemon] Stop daemon command invoked');
            
            // Check if daemon is running first
            if (!vsCodeClient.isConnected()) {
                log.warn('[stopDaemon] Daemon is not connected/running');
                vscode.window.showWarningMessage('Daemon is not running');
                return;
            }
            
            const action = await vscode.window.showWarningMessage(
                'Stop the daemon? This will pause all running workflows and disconnect all clients. The daemon will auto-restart when needed.',
                { modal: true },
                'Stop Daemon',
                'Cancel'
            );
            
            log.info(`[stopDaemon] User choice: ${action}`);
            
            if (action === 'Stop Daemon') {
                try {
                    log.info('[stopDaemon] Starting daemon shutdown...');
                    
                    await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: 'Stopping daemon...',
                        cancellable: false
                    }, async (progress) => {
                        progress.report({ message: 'Sending shutdown signal...' });
                        
                        await daemonManager.stopDaemon();
                        
                        progress.report({ message: 'Daemon stopped' });
                        log.info('[stopDaemon] Daemon stopped successfully');
                    });
                    
                    vscode.window.showInformationMessage('✓ Daemon stopped successfully');
                    
                    // Refresh UI to show disconnected state
                    sidebarProvider.refresh();
                } catch (err) {
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    log.error('[stopDaemon] Failed to stop daemon:', errorMsg);
                    vscode.window.showErrorMessage(`Failed to stop daemon: ${errorMsg}`);
                }
            } else {
                log.info('[stopDaemon] User cancelled stop operation');
            }
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
            
            // Refresh via daemon (authoritative dependency check)
            if (vsCodeClient.isConnected()) {
                try {
                    // Enable cache for fast post-install verification
                    await vsCodeClient.send('system.enableCacheForNextCheck', {});
                    
                    await vsCodeClient.send('deps.refresh');
                    log.info('Daemon dependency check completed after APC CLI installation');
                    sidebarProvider.refresh();
                } catch (err) {
                    log.warn('Failed to refresh dependencies on daemon:', err);
                    vscode.window.showWarningMessage('Installed but failed to refresh status');
                }
            } else {
                vscode.window.showWarningMessage('CLI installed but daemon not connected - restart extension to update status');
            }
            
            if (result.success) {
                // Check if PATH setup is needed (Windows or Unix)
                if (result.message.includes('Add to PATH') || result.message.includes('~/bin')) {
                    const isWindows = process.platform === 'win32';
                    if (isWindows) {
                        const action = await vscode.window.showInformationMessage(
                            'APC CLI installed! Add ~/bin to your PATH to use it from any terminal.',
                            'Copy PATH Instructions'
                        );
                        if (action === 'Copy PATH Instructions') {
                            await vscode.env.clipboard.writeText(
                                'Add %USERPROFILE%\\bin to your PATH:\n' +
                                '1. Search "Environment Variables" in Windows\n' +
                                '2. Edit PATH under User variables\n' +
                                '3. Add: %USERPROFILE%\\bin\n' +
                                '4. Restart your terminal'
                            );
                            vscode.window.showInformationMessage('Instructions copied! Follow the steps to add to PATH.');
                        }
                    } else {
                        const action = await vscode.window.showInformationMessage(
                            'APC CLI installed! Add ~/.local/bin to PATH to use it.',
                            'Copy PATH Command'
                        );
                        if (action === 'Copy PATH Command') {
                            const shellConfig = process.platform === 'darwin' ? '~/.zshrc' : '~/.bashrc';
                            await vscode.env.clipboard.writeText(`echo 'export PATH="$HOME/.local/bin:$PATH"' >> ${shellConfig} && source ${shellConfig}`);
                            vscode.window.showInformationMessage('Copied! Paste in terminal, then restart terminal.');
                        }
                    }
                } else {
                    vscode.window.showInformationMessage('APC CLI installed successfully! Try: apc help');
                }
            } else {
                vscode.window.showErrorMessage(result.message);
            }
            
            // Return result so callers can check success
            return result;
        }),
        vscode.commands.registerCommand('agenticPlanning.uninstallCli', async () => {
            const result = await dependencyService.uninstallApcCli();
            if (result.success) {
                vscode.window.showInformationMessage(result.message);
                
                // Refresh via daemon (authoritative dependency check)
                if (vsCodeClient.isConnected()) {
                    try {
                        await vsCodeClient.send('deps.refresh');
                        log.info('Daemon dependency check completed after APC CLI uninstallation');
                        sidebarProvider.refresh();
                    } catch (err) {
                        log.warn('Failed to refresh dependencies on daemon:', err);
                        vscode.window.showWarningMessage('Uninstalled but failed to refresh status');
                    }
                } else {
                    vscode.window.showWarningMessage('CLI uninstalled but daemon not connected - restart extension to update status');
                }
            } else {
                vscode.window.showErrorMessage(result.message);
            }
        }),

        // Daemon connection commands
        vscode.commands.registerCommand('agenticPlanning.startDaemon', async () => {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Starting daemon...',
                cancellable: false
            }, async (progress) => {
                try {
                    progress.report({ message: 'Checking if daemon is running...' });
                    
                    // First check if already connected
                    if (vsCodeClient.isConnected()) {
                        vscode.window.showInformationMessage('Already connected to daemon.');
                        return;
                    }
                    
                    // Try to start/ensure daemon is running
                    progress.report({ message: 'Starting daemon process...' });
                    const daemonResult = await daemonManager.ensureDaemonRunning();
                    
                    // Now connect the client
                    progress.report({ message: 'Connecting to daemon...' });
                    
                    // Create new client if needed (getOrCreateDaemonClient is in this file)
                    vsCodeClient = getOrCreateDaemonClient(daemonResult.port);
                    
                    // Set up notification callbacks
                    vsCodeClient.setNotificationCallbacks({
                        showInfo: (msg) => vscode.window.showInformationMessage(msg),
                        showWarning: (msg) => vscode.window.showWarningMessage(msg),
                        showError: (msg) => vscode.window.showErrorMessage(msg)
                    });
                    
                    // Connect with retry
                    const maxRetries = 5;
                    let connected = false;
                    for (let attempt = 1; attempt <= maxRetries; attempt++) {
                        try {
                            await vsCodeClient.connect();
                            connected = true;
                            break;
                        } catch (err) {
                            if (attempt < maxRetries) {
                                progress.report({ message: `Connecting... (attempt ${attempt}/${maxRetries})` });
                                await new Promise(r => setTimeout(r, 500));
                            }
                        }
                    }
                    
                    if (!connected) {
                        throw new Error('Failed to connect after multiple attempts');
                    }
                    
                    // Update state proxy with new client
                    if (daemonStateProxy) {
                        daemonStateProxy.dispose();
                    }
                    // DaemonStateProxy is already imported at top of file
                    daemonStateProxy = new DaemonStateProxy({
                        vsCodeClient,
                        unityEnabled: unityFeaturesEnabled,
                        workspaceRoot
                    });
                    // DON'T start health monitoring yet - will start when daemon.ready fires
                    sidebarProvider.setStateProxy(daemonStateProxy);
                    
                    // Set up event subscriptions
                    setupEventSubscriptions();
                    
                    sidebarProvider.refresh();
                    vscode.window.showInformationMessage(
                        daemonResult.wasStarted 
                            ? 'Daemon started and connected!' 
                            : 'Connected to existing daemon.'
                    );
                    
                } catch (err) {
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    log.error('Failed to start daemon:', errorMsg);
                    vscode.window.showErrorMessage(`Failed to start daemon: ${errorMsg}`);
                    sidebarProvider.refresh();
                }
            });
        }),
        
        vscode.commands.registerCommand('agenticPlanning.retryDaemonConnection', async () => {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Reconnecting to daemon...',
                cancellable: false
            }, async (progress) => {
                try {
                    // First try manual reconnect through state proxy
                    if (daemonStateProxy) {
                        progress.report({ message: 'Attempting reconnection...' });
                        const result = await daemonStateProxy.manualReconnect();
                        
                        if (result.success) {
                            sidebarProvider.refresh();
                            vscode.window.showInformationMessage('Reconnected to daemon!');
                            return;
                        }
                        
                        // If reconnect failed because daemon not running, suggest starting it
                        if (result.error?.includes('not running')) {
                            const action = await vscode.window.showWarningMessage(
                                result.error,
                                'Start Daemon'
                            );
                            if (action === 'Start Daemon') {
                                vscode.commands.executeCommand('agenticPlanning.startDaemon');
                            }
                            return;
                        }
                        
                        // Other failure
                        vscode.window.showWarningMessage(result.error || 'Reconnection failed');
                    } else {
                        // No state proxy, try starting daemon
                        vscode.commands.executeCommand('agenticPlanning.startDaemon');
                    }
                    
                    sidebarProvider.refresh();
                } catch (err) {
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    log.error('Reconnection failed:', errorMsg);
                    vscode.window.showErrorMessage(`Reconnection failed: ${errorMsg}`);
                    sidebarProvider.refresh();
                }
            });
        }),

        // Open APC System Settings panel (our own settings, not VS Code settings)
        vscode.commands.registerCommand('agenticPlanning.openSettings', async () => {
            if (!vsCodeClient.isConnected()) {
                vscode.window.showErrorMessage('Not connected to daemon. System settings require a running daemon.');
                return;
            }
            const { SystemSettingsPanel} = await import('./ui/SystemSettingsPanel');
            SystemSettingsPanel.show(context.extensionUri, vsCodeClient, workspaceRoot);
        }),

        // Auto-configure MCP for Unity (CoplayDev/unity-mcp)
        // Now performs BOTH steps: MCP config + Unity package installation
        // Returns: { configured: boolean } to indicate if configuration was written
        vscode.commands.registerCommand('agenticPlanning.autoConfigureMcp', async (): Promise<{ configured: boolean }> => {
            try {
                // Install directly without confirmation (user already clicked "Install" button)
                if (!vsCodeClient.isConnected()) {
                    vscode.window.showErrorMessage('Daemon not connected. Please start the daemon first.');
                    return { configured: false };
                }
                
                vscode.window.showInformationMessage('Installing Unity MCP (this may take a moment)...');
                
                log.info('Sending system.installUnityMcp request to daemon...');
                const response = await vsCodeClient.send('system.installUnityMcp', {});
                log.info('Received response from daemon:', response);
                const installResult = response as any;  // Response IS the result, no .data wrapper
                log.info('Install result:', installResult);
                
                if (installResult?.success) {
                    // Show success message with next steps
                    const selection = await vscode.window.showInformationMessage(
                        `✅ Unity MCP Installation Complete!\n\n${installResult.message}\n\nNext steps:\n1. In Unity: Window → MCP for Unity → Start Local HTTP Server\n2. Agents will use the MCP immediately`,
                        'OK',
                        'Open Documentation'
                    );
                    
                    if (selection === 'Open Documentation') {
                        vscode.env.openExternal(vscode.Uri.parse('https://github.com/CoplayDev/unity-mcp'));
                    }
                    
                    // Refresh dependencies via daemon (authoritative check)
                    if (vsCodeClient.isConnected()) {
                        try {
                            await vsCodeClient.send('deps.refresh');
                            sidebarProvider.refresh();
                        } catch (err) {
                            log.warn('Failed to refresh daemon dependencies:', err);
                        }
                    }
                    
                    return { configured: true };
                } else {
                    const errorDetail = installResult?.message || 'No error message provided';
                    log.error('Installation failed with result:', installResult);
                    vscode.window.showErrorMessage(`Installation failed:\n${errorDetail}`);
                    return { configured: false };
                }
            } catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                const errorStack = err instanceof Error ? err.stack : 'No stack trace';
                log.error('Failed to install Unity MCP - Exception caught:', { message: errorMsg, stack: errorStack, err });
                vscode.window.showErrorMessage(`Installation error: ${errorMsg}`);
                return { configured: false };
            }
        })
    );

    // Register CLI terminal profile (cross-platform)
    context.subscriptions.push(
        vscode.window.registerTerminalProfileProvider('agenticPlanning.cli', {
            provideTerminalProfile(): vscode.TerminalProfile {
                const isWindows = process.platform === 'win32';
                return new vscode.TerminalProfile({
                    name: 'Agentic CLI',
                    shellPath: isWindows ? 'powershell.exe' : '/bin/bash',
                    shellArgs: isWindows 
                        ? ['-NoProfile', '-Command', 'Write-Host "Agentic Planning CLI ready. Use: apc <command>"']
                        : ['-c', 'echo "Agentic Planning CLI ready. Use: apc <command>"']
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

    log.info('Agentic Planning Coordinator activated successfully');
    // Note: "Coordinator ready!" message is now shown when daemon.ready event is received
    // This ensures the message only appears after all services (including dependency checks) are initialized
}

export async function deactivate() {
    log.info('Agentic Planning Coordinator deactivating...');
    
    // Stop periodic dependency checks
    try {
        const dependencyService = ServiceLocator.resolve(DependencyService);
        dependencyService.stopPeriodicCheck();
        log.debug('Dependency periodic check stopped');
    } catch (e) {
        // Ignore if service not available
    }
    
    // Stop connection health monitoring
    if (daemonStateProxy) {
        try {
            daemonStateProxy.dispose();
            log.debug('DaemonStateProxy disposed');
        } catch (e) {
            // Ignore cleanup errors
        }
    }
    
    // Clean up event subscriptions first (prevents memory leaks and duplicate handlers)
    log.debug(`Cleaning up ${eventSubscriptions.length} event subscriptions`);
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
            log.debug('VsCodeClient disconnected');
        } catch (e) {
            log.error('Error disconnecting VsCodeClient:', e);
        }
    }
    
    // Dispose daemon manager (health checks, etc.)
    if (daemonManager) {
        try {
            await daemonManager.dispose();
            log.debug('DaemonManager disposed');
        } catch (e) {
            log.error('Error disposing DaemonManager:', e);
        }
    }
    
    // Dispose TerminalManager (closes all terminals)
    if (terminalManager) {
        try {
            terminalManager.dispose();
            log.debug('TerminalManager disposed');
        } catch (e) {
            log.error('Error disposing TerminalManager:', e);
        }
    }
    
    // Note: Orphan process cleanup is handled by daemon, not extension
    
    // Dispose all ServiceLocator-managed services in reverse registration order
    try {
        await ServiceLocator.dispose();
        log.debug('ServiceLocator disposed all services');
    } catch (e) {
        log.error('Error disposing ServiceLocator:', e);
    }
    
    log.info('Agentic Planning Coordinator deactivated');
}
