import * as vscode from 'vscode';
import { StateManager } from '../services/StateManager';
import { PlanningSession, PlanningStatus } from '../types';

export class PlanningSessionsProvider implements vscode.TreeDataProvider<PlanningSessionItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<PlanningSessionItem | undefined | null | void> = 
        new vscode.EventEmitter<PlanningSessionItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<PlanningSessionItem | undefined | null | void> = 
        this._onDidChangeTreeData.event;

    constructor(private stateManager: StateManager) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: PlanningSessionItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: PlanningSessionItem): Promise<PlanningSessionItem[]> {
        if (element) {
            // Return details for a specific session
            return this.getSessionDetails(element.session);
        }

        // Return all planning sessions
        const sessions = this.stateManager.getAllPlanningSessions();
        return sessions.map(session => new PlanningSessionItem(session));
    }

    private getSessionDetails(session: PlanningSession): PlanningSessionItem[] {
        const details: PlanningSessionItem[] = [];

        // Requirement
        details.push(new PlanningSessionItem(
            session,
            'requirement',
            `Requirement: ${session.requirement.substring(0, 40)}...`
        ));

        // Current plan
        if (session.currentPlanPath) {
            details.push(new PlanningSessionItem(
                session,
                'plan',
                `Plan: ${session.currentPlanPath.split('/').pop()}`
            ));
        }

        // Version
        details.push(new PlanningSessionItem(
            session,
            'version',
            `Version: ${session.planHistory.length}`
        ));

        // Recommended engineers
        if (session.recommendedEngineers) {
            details.push(new PlanningSessionItem(
                session,
                'engineers',
                `Engineers: ${session.recommendedEngineers.count} recommended`
            ));
        }

        return details;
    }
}

export class PlanningSessionItem extends vscode.TreeItem {
    constructor(
        public readonly session: PlanningSession,
        public readonly detailType?: string,
        label?: string
    ) {
        super(
            label || `${session.id}: ${session.requirement.substring(0, 30)}...`,
            detailType ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed
        );

        if (!detailType) {
            // Main session item
            this.contextValue = 'planningSession';
            this.iconPath = this.getStatusIcon(session.status);
            this.description = session.status;
            this.tooltip = new vscode.MarkdownString(this.getTooltip(session));

            // Add command to open plan
            if (session.currentPlanPath) {
                this.command = {
                    command: 'vscode.open',
                    title: 'Open Plan',
                    arguments: [vscode.Uri.file(session.currentPlanPath)]
                };
            }
        } else {
            // Detail item
            this.contextValue = `planningSession.${detailType}`;
            this.iconPath = new vscode.ThemeIcon('circle-small-filled');
        }
    }

    private getStatusIcon(status: PlanningStatus): vscode.ThemeIcon {
        switch (status) {
            case 'debating':
                return new vscode.ThemeIcon('comment-discussion', new vscode.ThemeColor('charts.yellow'));
            case 'reviewing':
                return new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.blue'));
            case 'revising':
                return new vscode.ThemeIcon('edit', new vscode.ThemeColor('charts.orange'));
            case 'approved':
                return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
            case 'cancelled':
                return new vscode.ThemeIcon('x', new vscode.ThemeColor('charts.red'));
            default:
                return new vscode.ThemeIcon('circle-outline');
        }
    }

    private getTooltip(session: PlanningSession): string {
        return `**${session.id}**

**Status:** ${session.status}

**Requirement:**
${session.requirement}

**Created:** ${new Date(session.createdAt).toLocaleString()}
**Updated:** ${new Date(session.updatedAt).toLocaleString()}

**Versions:** ${session.planHistory.length}
${session.recommendedEngineers ? `**Recommended Engineers:** ${session.recommendedEngineers.count}` : ''}
`;
    }
}

