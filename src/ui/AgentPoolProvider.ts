import * as vscode from 'vscode';
import { AgentPoolService } from '../services/AgentPoolService';
import { AgentStatus } from '../types';

export class AgentPoolProvider implements vscode.TreeDataProvider<AgentPoolItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<AgentPoolItem | undefined | null | void> = 
        new vscode.EventEmitter<AgentPoolItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<AgentPoolItem | undefined | null | void> = 
        this._onDidChangeTreeData.event;

    constructor(private agentPoolService: AgentPoolService) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: AgentPoolItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: AgentPoolItem): Promise<AgentPoolItem[]> {
        if (element) {
            return [];
        }

        const poolStatus = this.agentPoolService.getPoolStatus();
        const items: AgentPoolItem[] = [];

        // Add summary item
        items.push(new AgentPoolItem(
            'summary',
            `Pool: ${poolStatus.available.length} available / ${poolStatus.total} total`,
            undefined
        ));

        // Add available agents
        for (const name of poolStatus.available) {
            const status = this.agentPoolService.getAgentStatus(name);
            items.push(new AgentPoolItem('available', name, status));
        }

        // Add allocated agents (on bench - not available but not yet working)
        for (const name of poolStatus.allocated) {
            const status = this.agentPoolService.getAgentStatus(name);
            items.push(new AgentPoolItem('allocated', name, status));
        }

        // Add busy agents
        for (const name of poolStatus.busy) {
            const status = this.agentPoolService.getAgentStatus(name);
            items.push(new AgentPoolItem('busy', name, status));
        }

        return items;
    }
}

export class AgentPoolItem extends vscode.TreeItem {
    constructor(
        public readonly itemType: 'summary' | 'available' | 'allocated' | 'busy',
        label: string,
        public readonly agentStatus?: AgentStatus
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);

        if (itemType === 'summary') {
            this.contextValue = 'poolSummary';
            this.iconPath = new vscode.ThemeIcon('organization');
        } else if (itemType === 'available') {
            this.contextValue = 'availableAgent';
            this.iconPath = new vscode.ThemeIcon('person', new vscode.ThemeColor('charts.green'));
            this.description = 'available';
            this.tooltip = `${label} - Ready to work`;
        } else if (itemType === 'allocated' && agentStatus) {
            this.contextValue = 'allocatedAgent';
            this.iconPath = new vscode.ThemeIcon('person', new vscode.ThemeColor('charts.purple'));
            
            // Show role name in description if available
            const roleLabel = agentStatus.roleId ? ` [${agentStatus.roleId}]` : '';
            this.description = `on bench${roleLabel}`;
            this.tooltip = this.getAllocatedTooltip(label, agentStatus);
        } else if (itemType === 'busy' && agentStatus) {
            this.contextValue = 'busyAgent';
            this.iconPath = new vscode.ThemeIcon('person', new vscode.ThemeColor('charts.yellow'));
            
            // Show role name in description if available
            const roleLabel = agentStatus.roleId ? ` [${agentStatus.roleId}]` : '';
            this.description = `working${roleLabel} (${agentStatus.workflowId})`;
            this.tooltip = this.getBusyTooltip(label, agentStatus);
            
            // Command to show terminal
            this.command = {
                command: 'agenticPlanning.showAgentTerminal',
                title: 'Show Terminal',
                arguments: [label]
            };
        }
    }

    private getAllocatedTooltip(name: string, status: AgentStatus): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${name}**\n\n`);
        md.appendMarkdown(`**Status:** Allocated (on bench)\n\n`);
        if (status.roleId) {
            md.appendMarkdown(`**Role:** ${status.roleId}\n\n`);
        }
        if (status.sessionId) {
            md.appendMarkdown(`**Session:** ${status.sessionId}\n\n`);
        }
        md.appendMarkdown(`\n*Waiting to be assigned to a workflow*`);
        return md;
    }

    private getBusyTooltip(name: string, status: AgentStatus): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${name}**\n\n`);
        md.appendMarkdown(`**Status:** ${status.status}\n\n`);
        if (status.roleId) {
            md.appendMarkdown(`**Role:** ${status.roleId}\n\n`);
        }
        if (status.workflowId) {
            md.appendMarkdown(`**Workflow:** ${status.workflowId}\n\n`);
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

