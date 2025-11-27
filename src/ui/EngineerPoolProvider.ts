import * as vscode from 'vscode';
import { EngineerPoolService } from '../services/EngineerPoolService';
import { EngineerStatus } from '../types';

export class EngineerPoolProvider implements vscode.TreeDataProvider<EngineerPoolItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<EngineerPoolItem | undefined | null | void> = 
        new vscode.EventEmitter<EngineerPoolItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<EngineerPoolItem | undefined | null | void> = 
        this._onDidChangeTreeData.event;

    constructor(private engineerPoolService: EngineerPoolService) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: EngineerPoolItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: EngineerPoolItem): Promise<EngineerPoolItem[]> {
        if (element) {
            return [];
        }

        const poolStatus = this.engineerPoolService.getPoolStatus();
        const items: EngineerPoolItem[] = [];

        // Add summary item
        items.push(new EngineerPoolItem(
            'summary',
            `Pool: ${poolStatus.available.length} available / ${poolStatus.total} total`,
            undefined
        ));

        // Add available engineers
        for (const name of poolStatus.available) {
            const status = this.engineerPoolService.getEngineerStatus(name);
            items.push(new EngineerPoolItem('available', name, status));
        }

        // Add busy engineers
        for (const name of poolStatus.busy) {
            const status = this.engineerPoolService.getEngineerStatus(name);
            items.push(new EngineerPoolItem('busy', name, status));
        }

        return items;
    }
}

export class EngineerPoolItem extends vscode.TreeItem {
    constructor(
        public readonly itemType: 'summary' | 'available' | 'busy',
        label: string,
        public readonly engineerStatus?: EngineerStatus
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);

        if (itemType === 'summary') {
            this.contextValue = 'poolSummary';
            this.iconPath = new vscode.ThemeIcon('organization');
        } else if (itemType === 'available') {
            this.contextValue = 'availableEngineer';
            this.iconPath = new vscode.ThemeIcon('person', new vscode.ThemeColor('charts.green'));
            this.description = 'available';
            this.tooltip = `${label} - Ready to work`;
        } else if (itemType === 'busy' && engineerStatus) {
            this.contextValue = 'busyEngineer';
            this.iconPath = new vscode.ThemeIcon('person', new vscode.ThemeColor('charts.yellow'));
            this.description = `working (${engineerStatus.coordinatorId})`;
            this.tooltip = this.getBusyTooltip(label, engineerStatus);
            
            // Command to show terminal
            this.command = {
                command: 'agenticPlanning.showEngineerTerminal',
                title: 'Show Terminal',
                arguments: [label]
            };
        }
    }

    private getBusyTooltip(name: string, status: EngineerStatus): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${name}**\n\n`);
        md.appendMarkdown(`**Status:** ${status.status}\n\n`);
        if (status.coordinatorId) {
            md.appendMarkdown(`**Coordinator:** ${status.coordinatorId}\n\n`);
        }
        if (status.sessionId) {
            md.appendMarkdown(`**Session:** ${status.sessionId}\n\n`);
        }
        if (status.task) {
            md.appendMarkdown(`**Task:** ${status.task}\n\n`);
        }
        md.appendMarkdown(`\n*Click to open terminal*`);
        return md;
    }
}










