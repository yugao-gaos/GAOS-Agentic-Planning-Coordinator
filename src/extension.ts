import * as vscode from 'vscode';
import { StateManager } from './services/StateManager';
import { EngineerPoolService } from './services/EngineerPoolService';
import { TerminalManager } from './services/TerminalManager';
import { CoordinatorService } from './services/CoordinatorService';
import { PlanningService } from './services/PlanningService';
import { CliHandler } from './cli/CliHandler';
import { PlanningSessionsProvider } from './ui/PlanningSessionsProvider';
import { CoordinatorsProvider } from './ui/CoordinatorsProvider';
import { EngineerPoolProvider } from './ui/EngineerPoolProvider';

let stateManager: StateManager;
let engineerPoolService: EngineerPoolService;
let terminalManager: TerminalManager;
let coordinatorService: CoordinatorService;
let planningService: PlanningService;
let cliHandler: CliHandler;

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
    cliHandler = new CliHandler(stateManager, engineerPoolService, coordinatorService, planningService, terminalManager);

    // Register TreeView providers
    const planningSessionsProvider = new PlanningSessionsProvider(stateManager);
    const coordinatorsProvider = new CoordinatorsProvider(stateManager);
    const engineerPoolProvider = new EngineerPoolProvider(engineerPoolService);

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('agenticPlanning.planningSessionsView', planningSessionsProvider),
        vscode.window.registerTreeDataProvider('agenticPlanning.coordinatorsView', coordinatorsProvider),
        vscode.window.registerTreeDataProvider('agenticPlanning.engineerPoolView', engineerPoolProvider)
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('agenticPlanning.showDashboard', () => {
            vscode.window.showInformationMessage('Dashboard coming soon!');
        }),

        vscode.commands.registerCommand('agenticPlanning.startPlanning', async () => {
            const prompt = await vscode.window.showInputBox({
                prompt: 'Enter your requirement or feature description',
                placeHolder: 'e.g., Implement a combo system for match-3 game'
            });
            if (prompt) {
                const result = await planningService.startPlanning(prompt);
                vscode.window.showInformationMessage(`Planning session ${result.sessionId} started`);
                planningSessionsProvider.refresh();
            }
        }),

        vscode.commands.registerCommand('agenticPlanning.startCoordinator', async () => {
            const plans = await stateManager.getApprovedPlans();
            if (plans.length === 0) {
                vscode.window.showWarningMessage('No approved plans available. Create and approve a plan first.');
                return;
            }
            const selected = await vscode.window.showQuickPick(
                plans.map(p => ({ label: p.title, description: p.path, plan: p })),
                { placeHolder: 'Select a plan to execute' }
            );
            if (selected) {
                const result = await coordinatorService.startCoordinator(selected.plan.path);
                vscode.window.showInformationMessage(`Coordinator ${result.coordinatorId} started with ${result.engineersAllocated.length} engineers`);
                coordinatorsProvider.refresh();
                engineerPoolProvider.refresh();
            }
        }),

        vscode.commands.registerCommand('agenticPlanning.stopCoordinator', async (coordinatorId?: string) => {
            if (!coordinatorId) {
                const coordinators = await stateManager.getActiveCoordinators();
                if (coordinators.length === 0) {
                    vscode.window.showWarningMessage('No active coordinators');
                    return;
                }
                const selected = await vscode.window.showQuickPick(
                    coordinators.map(c => ({ label: c.id, description: c.status, coordinator: c })),
                    { placeHolder: 'Select coordinator to stop' }
                );
                if (selected) {
                    coordinatorId = selected.coordinator.id;
                }
            }
            if (coordinatorId) {
                await coordinatorService.stopCoordinator(coordinatorId);
                vscode.window.showInformationMessage(`Coordinator ${coordinatorId} stopped`);
                coordinatorsProvider.refresh();
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
        vscode.commands.registerCommand('agenticPlanning.refreshPlanningsessions', () => {
            planningSessionsProvider.refresh();
        }),
        vscode.commands.registerCommand('agenticPlanning.refreshCoordinators', () => {
            coordinatorsProvider.refresh();
        }),
        vscode.commands.registerCommand('agenticPlanning.refreshEngineerPool', () => {
            engineerPoolProvider.refresh();
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

    console.log('Agentic Planning Coordinator activated successfully');
    vscode.window.showInformationMessage('Agentic Planning Coordinator ready!');
}

export function deactivate() {
    console.log('Agentic Planning Coordinator deactivating...');
    // Cleanup will be handled by disposal of subscriptions
}

