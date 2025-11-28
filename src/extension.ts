import * as vscode from 'vscode';
import { StateManager } from './services/StateManager';
import { EngineerPoolService } from './services/EngineerPoolService';
import { TerminalManager } from './services/TerminalManager';
import { CoordinatorService } from './services/CoordinatorService';
import { PlanningService } from './services/PlanningService';
import { DependencyService } from './services/DependencyService';
import { CliIpcService } from './services/CliIpcService';
import { CliHandler } from './cli/CliHandler';
import { PlanningSessionsProvider, PlanningSessionItem } from './ui/PlanningSessionsProvider';
import { CoordinatorsProvider } from './ui/CoordinatorsProvider';
import { EngineerPoolProvider } from './ui/EngineerPoolProvider';
import { DependencyStatusProvider } from './ui/DependencyStatusProvider';
import { UnityControlStatusProvider } from './ui/UnityControlStatusProvider';
import { UnityControlAgent } from './services/UnityControlAgent';

let stateManager: StateManager;
let engineerPoolService: EngineerPoolService;
let terminalManager: TerminalManager;
let coordinatorService: CoordinatorService;
let planningService: PlanningService;
let cliHandler: CliHandler;
let cliIpcService: CliIpcService;

export async function activate(context: vscode.ExtensionContext) {
    console.log('Agentic Planning Coordinator is activating...');

    // Get workspace root
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showWarningMessage('Agentic Planning: No workspace folder open');
        return;
    }

    // Initialize services
    stateManager = new StateManager(workspaceRoot, context);
    await stateManager.initialize();

    engineerPoolService = new EngineerPoolService(stateManager);
    terminalManager = new TerminalManager();
    coordinatorService = new CoordinatorService(stateManager, engineerPoolService, terminalManager);
    planningService = new PlanningService(stateManager);
    
    // Wire up CoordinatorService to PlanningService (for execution facade)
    planningService.setCoordinatorService(coordinatorService);
    
    cliHandler = new CliHandler(stateManager, engineerPoolService, coordinatorService, planningService, terminalManager);

    // Initialize and start CLI IPC service (for apc command communication)
    cliIpcService = new CliIpcService(stateManager, cliHandler);
    cliIpcService.start();

    // Initialize dependency service and check dependencies
    const dependencyService = DependencyService.getInstance();
    
    // Register TreeView providers (no more separate Coordinators view - embedded in Sessions)
    const dependencyStatusProvider = new DependencyStatusProvider();
    const planningSessionsProvider = new PlanningSessionsProvider(stateManager);
    const engineerPoolProvider = new EngineerPoolProvider(engineerPoolService);
    const unityControlStatusProvider = new UnityControlStatusProvider();
    
    // Initialize Unity Control Agent and connect to UI
    const unityControlAgent = UnityControlAgent.getInstance();
    if (workspaceRoot) {
        unityControlAgent.initialize(workspaceRoot);
    }
    
    // Connect Unity Control Agent events to UI
    unityControlAgent.onStatusChanged((state) => {
        unityControlStatusProvider.updateStatus({
            isRunning: state.status !== 'idle' || unityControlAgent.getQueue().length > 0,
            currentTask: state.currentTask ? {
                id: state.currentTask.id,
                type: state.currentTask.type as 'prep_editor' | 'test_framework_editmode' | 'test_framework_playmode' | 'test_player_playmode',
                requestedBy: state.currentTask.requestedBy.map(r => r.engineerName),
                status: state.currentTask.status as 'queued' | 'executing' | 'completed' | 'failed',
                queuedAt: state.currentTask.createdAt,
                phase: state.currentTask.phase
            } : null,
            queueLength: state.queueLength,
            queue: unityControlAgent.getQueue().map(t => ({
                id: t.id,
                type: t.type as 'prep_editor' | 'test_framework_editmode' | 'test_framework_playmode' | 'test_player_playmode',
                requestedBy: t.requestedBy.map(r => r.engineerName),
                status: t.status as 'queued' | 'executing' | 'completed' | 'failed',
                queuedAt: t.createdAt
            })),
            estimatedWaitTime: Math.floor(unityControlAgent.getEstimatedWaitTime('prep_editor') / 1000),
            lastActivity: state.lastActivity
        });
    });

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('agenticPlanning.dependencyStatusView', dependencyStatusProvider),
        vscode.window.registerTreeDataProvider('agenticPlanning.planningSessionsView', planningSessionsProvider),
        vscode.window.registerTreeDataProvider('agenticPlanning.engineerPoolView', engineerPoolProvider),
        vscode.window.registerTreeDataProvider('agenticPlanning.unityControlView', unityControlStatusProvider)
    );

    // Watch for state file changes to auto-refresh UI (CLI updates files directly)
    // New structure: _AiDevLog/Plans/{sessionId}/session.json and coordinator.json
    const config = vscode.workspace.getConfiguration('agenticPlanning');
    const workingDirectory = config.get<string>('workingDirectory', '_AiDevLog');
    const stateFilesPattern = new vscode.RelativePattern(
        vscode.Uri.file(workspaceRoot), 
        `${workingDirectory}/{.engineer_pool.json,Plans/*/session.json,Plans/*/coordinator.json}`
    );
    
    const stateFileWatcher = vscode.workspace.createFileSystemWatcher(stateFilesPattern);
    
    // Debounce refresh to avoid rapid-fire updates
    let refreshTimeout: NodeJS.Timeout | undefined;
    const debouncedRefresh = () => {
        if (refreshTimeout) {
            clearTimeout(refreshTimeout);
        }
        refreshTimeout = setTimeout(() => {
            // Reload state from files
            stateManager.reloadFromFiles();
            // Refresh all UI providers
            engineerPoolProvider.refresh();
            planningSessionsProvider.refresh();
        }, 500); // 500ms debounce
    };
    
    stateFileWatcher.onDidChange(debouncedRefresh);
    stateFileWatcher.onDidCreate(debouncedRefresh);
    stateFileWatcher.onDidDelete(debouncedRefresh);
    
    context.subscriptions.push(stateFileWatcher);
    
    console.log('State file watcher initialized for auto-refresh');

    // Connect planning service events to UI refresh
    planningService.onSessionsChanged(() => {
        planningSessionsProvider.refresh();
    });

    // Check dependencies on startup
    dependencyService.checkAllDependencies().then(statuses => {
        const platform = process.platform;
        const relevantStatuses = statuses.filter(s => s.required && (s.platform === platform || s.platform === 'all'));
        const missingDeps = relevantStatuses.filter(s => !s.installed);
        
        if (missingDeps.length > 0) {
            const names = missingDeps.map(d => d.name).join(', ');
            vscode.window.showWarningMessage(
                `Agentic Planning: Missing dependencies: ${names}. Check System Status panel.`,
                'Show System Status'
            ).then(selection => {
                if (selection === 'Show System Status') {
                    vscode.commands.executeCommand('agenticPlanning.dependencyStatusView.focus');
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

IMPORTANT: Our conversation is REQUIREMENTS GATHERING, not planning.
- If I provide docs (GDD, TDD, specs), copy them to _AiDevLog/Docs/
- Once requirements are clear, call: apc plan new "<summary>" --docs <paths>
- The APC extension creates the execution plan using multi-model analysts
- You do NOT create the plan - the extension does

Workflow:
1. Gather requirements (this conversation)
2. Save any docs to _AiDevLog/Docs/
3. Run: apc plan new "..." to trigger plan creation
4. Review with user: apc plan status <id>
5. Approve: apc plan approve <id> (auto-starts execution)

Let's get started!`;

            // Copy prompt to clipboard
            await vscode.env.clipboard.writeText(planningPrompt);
            
            const { exec } = require('child_process');
            
            if (process.platform === 'darwin') {
                // macOS: Use AppleScript
                const script = `
                    tell application "Cursor" to activate
                    delay 0.2
                    tell application "System Events" to key code 53
                    delay 0.3
                    tell application "System Events" to keystroke "l" using {command down, shift down}
                    delay 0.5
                    tell application "System Events" to keystroke "v" using command down
                `;
                exec(`osascript -e '${script}'`, (error: Error | null) => {
                    if (error) {
                        vscode.window.showWarningMessage(
                            'Could not open chat automatically. Press Cmd+Shift+L and paste (Cmd+V).'
                        );
                    }
                });
            } else if (process.platform === 'win32') {
                // Windows: Use PowerShell with SendKeys
                const psScript = `
                    Add-Type -AssemblyName System.Windows.Forms
                    Start-Sleep -Milliseconds 200
                    [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
                    Start-Sleep -Milliseconds 300
                    [System.Windows.Forms.SendKeys]::SendWait('^+l')
                    Start-Sleep -Milliseconds 500
                    [System.Windows.Forms.SendKeys]::SendWait('^v')
                `;
                exec(`powershell -Command "${psScript.replace(/\n/g, ' ')}"`, (error: Error | null) => {
                    if (error) {
                        vscode.window.showWarningMessage(
                            'Could not open chat automatically. Press Ctrl+Shift+L and paste (Ctrl+V).'
                        );
                    }
                });
            } else {
                // Linux: Use xdotool if available
                exec('which xdotool', (err: Error | null) => {
                    if (!err) {
                        exec('sleep 0.2 && xdotool key Escape && sleep 0.3 && xdotool key ctrl+shift+l && sleep 0.5 && xdotool key ctrl+v');
                    } else {
                        vscode.window.showInformationMessage(
                            'Planning prompt copied! Press Ctrl+Shift+L to open chat, then Ctrl+V to paste.'
                        );
                    }
                });
            }
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
            planningSessionsProvider.refresh();
            engineerPoolProvider.refresh();
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
            planningSessionsProvider.refresh();
            engineerPoolProvider.refresh();
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
            planningSessionsProvider.refresh();
            engineerPoolProvider.refresh();
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
                planningSessionsProvider.refresh();
                engineerPoolProvider.refresh();
            }
        }),

        vscode.commands.registerCommand('agenticPlanning.showEngineerTerminal', async (engineerName?: string) => {
            if (!engineerName) {
                const busyEngineers = engineerPoolService.getBusyEngineers();
                if (busyEngineers.length === 0) {
                    vscode.window.showWarningMessage('No active engineers');
                    return;
                }
                const selected = await vscode.window.showQuickPick(
                    busyEngineers.map(e => ({ label: e.name, description: e.coordinatorId })),
                    { placeHolder: 'Select engineer to view' }
                );
                if (selected) {
                    engineerName = selected.label;
                }
            }
            if (engineerName) {
                terminalManager.showEngineerTerminal(engineerName);
            }
        }),

        vscode.commands.registerCommand('agenticPlanning.poolStatus', () => {
            const status = engineerPoolService.getPoolStatus();
            vscode.window.showInformationMessage(
                `Engineer Pool: ${status.available.length} available, ${status.busy.length} busy (Total: ${status.total})`
            );
        }),

        // Refresh commands for tree views
        vscode.commands.registerCommand('agenticPlanning.refreshPlanningSessions', () => {
            planningSessionsProvider.refresh();
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
                    planningSessionsProvider.refresh();
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
                    planningSessionsProvider.refresh();
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
                    planningSessionsProvider.refresh();
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
Requirement: ${session.requirement.substring(0, 200)}...

Please help me revise the plan. What changes would you like to make?

IMPORTANT: After discussing changes, run:
  apc plan revise ${sessionId} "<feedback summary>"

This will trigger the multi-agent debate to revise the plan.`;

            // Copy to clipboard and open chat
            await vscode.env.clipboard.writeText(revisionPrompt);
            
            const { exec } = require('child_process');
            if (process.platform === 'darwin') {
                const script = `
                    tell application "Cursor" to activate
                    delay 0.2
                    tell application "System Events" to key code 53
                    delay 0.3
                    tell application "System Events" to keystroke "l" using {command down, shift down}
                    delay 0.5
                    tell application "System Events" to keystroke "v" using command down
                `;
                exec(`osascript -e '${script}'`, (error: Error | null) => {
                    if (error) {
                        vscode.window.showInformationMessage(
                            'Revision prompt copied! Press Cmd+Shift+L to open chat, then Cmd+V to paste.'
                        );
                    }
                });
            } else {
                vscode.window.showInformationMessage(
                    'Revision prompt copied! Press Ctrl+Shift+L to open chat, then Ctrl+V to paste.'
                );
            }
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
                planningSessionsProvider.refresh();
                engineerPoolProvider.refresh();
            }
        }),
        
        vscode.commands.registerCommand('agenticPlanning.refreshEngineerPool', () => {
            // Also sync with settings when manually refreshed
            const configSize = vscode.workspace.getConfiguration('agenticPlanning').get<number>('engineerPoolSize', 5);
            const currentSize = engineerPoolService.getPoolStatus().total;
            if (configSize !== currentSize) {
                const result = engineerPoolService.resizePool(configSize);
                if (result.added.length > 0) {
                    vscode.window.showInformationMessage(`Added engineers: ${result.added.join(', ')}`);
                }
                if (result.removed.length > 0) {
                    vscode.window.showInformationMessage(`Removed engineers: ${result.removed.join(', ')}`);
                }
            }
            engineerPoolProvider.refresh();
        }),

        // Release/stop a busy engineer manually
        vscode.commands.registerCommand('agenticPlanning.releaseEngineer', async (item?: { label?: string; engineerStatus?: { name?: string } }) => {
            // Get engineer name from the tree item
            const engineerName = typeof item?.label === 'string' ? item.label : item?.engineerStatus?.name;
            
            if (!engineerName) {
                vscode.window.showErrorMessage('No engineer selected');
                return;
            }
            
            const confirm = await vscode.window.showWarningMessage(
                `Release ${engineerName} from their current coordinator?`,
                { modal: true },
                'Release'
            );
            
            if (confirm === 'Release') {
                engineerPoolService.releaseEngineers([engineerName]);
                engineerPoolProvider.refresh();
                planningSessionsProvider.refresh();
                vscode.window.showInformationMessage(`${engineerName} released back to pool`);
            }
        }),

        // Kill stuck processes command
        vscode.commands.registerCommand('agenticPlanning.killStuckProcesses', async () => {
            const { ProcessManager } = await import('./services/ProcessManager');
            const processManager = ProcessManager.getInstance();
            
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
                
                engineerPoolProvider.refresh();
                planningSessionsProvider.refresh();
            });
        }),

        // Show running processes command
        vscode.commands.registerCommand('agenticPlanning.showRunningProcesses', async () => {
            const { ProcessManager } = await import('./services/ProcessManager');
            const processManager = ProcessManager.getInstance();
            
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
                    engineerPoolProvider.refresh();
                    planningSessionsProvider.refresh();
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
                dependencyStatusProvider.refresh();
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

        // CLI installation commands
        vscode.commands.registerCommand('agenticPlanning.installCli', async () => {
            const result = await dependencyService.installApcCli(context.extensionPath);
            
            // Always refresh status after install attempt
            await dependencyService.checkAllDependencies();
            dependencyStatusProvider.refresh();
            
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
                dependencyStatusProvider.refresh();
            } else {
                vscode.window.showErrorMessage(result.message);
            }
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
            if (e.affectsConfiguration('agenticPlanning.engineerPoolSize')) {
                const newSize = vscode.workspace.getConfiguration('agenticPlanning').get<number>('engineerPoolSize', 5);
                const result = engineerPoolService.resizePool(newSize);
                if (result.added.length > 0) {
                    vscode.window.showInformationMessage(`Added engineers: ${result.added.join(', ')}`);
                }
                if (result.removed.length > 0) {
                    vscode.window.showInformationMessage(`Removed engineers: ${result.removed.join(', ')}`);
                }
                engineerPoolProvider.refresh();
            }
        })
    );

    console.log('Agentic Planning Coordinator activated successfully');
    vscode.window.showInformationMessage('Agentic Planning Coordinator ready!');
}

export function deactivate() {
    console.log('Agentic Planning Coordinator deactivating...');
    // Cleanup will be handled by disposal of subscriptions
}

