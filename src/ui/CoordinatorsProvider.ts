import * as vscode from 'vscode';
import { StateManager } from '../services/StateManager';
import { CoordinatorState, CoordinatorStatus, EngineerSessionInfo } from '../types';

export class CoordinatorsProvider implements vscode.TreeDataProvider<CoordinatorItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<CoordinatorItem | undefined | null | void> = 
        new vscode.EventEmitter<CoordinatorItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<CoordinatorItem | undefined | null | void> = 
        this._onDidChangeTreeData.event;

    constructor(private stateManager: StateManager) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: CoordinatorItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: CoordinatorItem): Promise<CoordinatorItem[]> {
        if (element) {
            if (element.itemType === 'coordinator') {
                // Return engineer sessions for this coordinator
                return this.getEngineerItems(element.coordinator!);
            }
            return [];
        }

        // Return all coordinators
        const coordinators = this.stateManager.getAllCoordinators();
        return coordinators.map(coord => new CoordinatorItem(coord, 'coordinator'));
    }

    private getEngineerItems(coordinator: CoordinatorState): CoordinatorItem[] {
        return Object.entries(coordinator.engineerSessions).map(([name, session]) => 
            new CoordinatorItem(coordinator, 'engineer', name, session)
        );
    }
}

export class CoordinatorItem extends vscode.TreeItem {
    constructor(
        public readonly coordinator: CoordinatorState | undefined,
        public readonly itemType: 'coordinator' | 'engineer',
        public readonly engineerName?: string,
        public readonly engineerSession?: EngineerSessionInfo
    ) {
        super(
            itemType === 'coordinator' 
                ? `${coordinator!.id}` 
                : `${engineerName}`,
            itemType === 'coordinator' 
                ? vscode.TreeItemCollapsibleState.Expanded 
                : vscode.TreeItemCollapsibleState.None
        );

        if (itemType === 'coordinator' && coordinator) {
            this.contextValue = 'coordinator';
            this.iconPath = this.getCoordinatorIcon(coordinator.status);
            this.description = `${coordinator.status} - ${coordinator.progress.percentage}%`;
            this.tooltip = this.getCoordinatorTooltip(coordinator);
        } else if (itemType === 'engineer' && engineerSession) {
            this.contextValue = 'coordinatorEngineer';
            this.iconPath = this.getEngineerIcon(engineerSession.status);
            this.description = engineerSession.status;
            this.tooltip = this.getEngineerTooltip(engineerName!, engineerSession);
            
            // Command to show engineer terminal
            this.command = {
                command: 'agenticPlanning.showEngineerTerminal',
                title: 'Show Terminal',
                arguments: [engineerName]
            };
        }
    }

    private getCoordinatorIcon(status: CoordinatorStatus): vscode.ThemeIcon {
        switch (status) {
            case 'initializing':
                return new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.yellow'));
            case 'running':
                return new vscode.ThemeIcon('play', new vscode.ThemeColor('charts.green'));
            case 'paused':
                return new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('charts.orange'));
            case 'stopped':
                return new vscode.ThemeIcon('debug-stop', new vscode.ThemeColor('charts.red'));
            case 'completed':
                return new vscode.ThemeIcon('check-all', new vscode.ThemeColor('charts.green'));
            case 'error':
                return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
            default:
                return new vscode.ThemeIcon('circle-outline');
        }
    }

    private getEngineerIcon(status: string): vscode.ThemeIcon {
        switch (status) {
            case 'starting':
                return new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.yellow'));
            case 'working':
                return new vscode.ThemeIcon('person', new vscode.ThemeColor('charts.green'));
            case 'paused':
                return new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('charts.orange'));
            case 'completed':
                return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
            case 'error':
                return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
            case 'stopped':
                return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.red'));
            default:
                return new vscode.ThemeIcon('circle-outline');
        }
    }

    private getCoordinatorTooltip(coordinator: CoordinatorState): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${coordinator.id}**\n\n`);
        md.appendMarkdown(`**Status:** ${coordinator.status}\n\n`);
        md.appendMarkdown(`**Mode:** ${coordinator.mode}\n\n`);
        md.appendMarkdown(`**Plan:** ${coordinator.planPath}\n\n`);
        md.appendMarkdown(`**Progress:** ${coordinator.progress.completed}/${coordinator.progress.total} (${coordinator.progress.percentage}%)\n\n`);
        md.appendMarkdown(`**Engineers:** ${Object.keys(coordinator.engineerSessions).length}\n\n`);
        md.appendMarkdown(`**Created:** ${new Date(coordinator.createdAt).toLocaleString()}\n`);
        return md;
    }

    private getEngineerTooltip(name: string, session: EngineerSessionInfo): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${name}**\n\n`);
        md.appendMarkdown(`**Session:** ${session.sessionId}\n\n`);
        md.appendMarkdown(`**Status:** ${session.status}\n\n`);
        if (session.task) {
            md.appendMarkdown(`**Task:** ${session.task}\n\n`);
        }
        md.appendMarkdown(`**Log:** ${session.logFile}\n\n`);
        md.appendMarkdown(`**Started:** ${new Date(session.startTime).toLocaleString()}\n`);
        if (session.processId) {
            md.appendMarkdown(`**PID:** ${session.processId}\n`);
        }
        return md;
    }
}










