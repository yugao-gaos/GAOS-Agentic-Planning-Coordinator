import * as vscode from 'vscode';
import { DependencyService, DependencyStatus } from '../services/DependencyService';

export class DependencyStatusProvider implements vscode.TreeDataProvider<DependencyItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<DependencyItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private dependencyService: DependencyService;

    constructor() {
        this.dependencyService = DependencyService.getInstance();
        this.dependencyService.onStatusChanged(() => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: DependencyItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: DependencyItem): Promise<DependencyItem[]> {
        if (element) {
            return [];
        }

        const statuses = this.dependencyService.getCachedStatus();
        const platform = process.platform;

        // Filter to show only current platform dependencies
        const relevantStatuses = statuses.filter(
            s => s.platform === platform || s.platform === 'all'
        );

        if (relevantStatuses.length === 0) {
            // Show "checking..." item
            return [new DependencyItem(
                'Checking dependencies...',
                '',
                vscode.TreeItemCollapsibleState.None,
                'sync~spin'
            )];
        }

        const allMet = relevantStatuses.filter(s => s.required).every(s => s.installed);

        const items: DependencyItem[] = [];

        // Add summary item
        items.push(new DependencyItem(
            allMet ? '✓ All dependencies met' : '⚠ Missing dependencies',
            '',
            vscode.TreeItemCollapsibleState.None,
            allMet ? 'check' : 'warning',
            undefined,
            allMet ? 'ready' : 'missing'
        ));

        // Add individual dependency items
        for (const status of relevantStatuses) {
            const item = new DependencyItem(
                status.name,
                status.installed 
                    ? (status.version ? `v${status.version}` : 'Installed')
                    : 'Not installed',
                vscode.TreeItemCollapsibleState.None,
                status.installed ? 'check' : 'close',
                status,
                status.installed ? 'installed' : 'missing'
            );
            items.push(item);
        }

        return items;
    }
}

class DependencyItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly description: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        iconId?: string,
        public readonly dependency?: DependencyStatus,
        contextValue?: string
    ) {
        super(label, collapsibleState);
        this.description = description;
        this.contextValue = contextValue;
        
        if (iconId) {
            this.iconPath = new vscode.ThemeIcon(iconId);
        }

        if (dependency) {
            this.tooltip = this.buildTooltip(dependency);
            
            // If not installed, make it clickable
            if (!dependency.installed) {
                if (dependency.name === 'APC CLI') {
                    // Special case: APC CLI uses our install command
                    this.command = {
                        command: 'agenticPlanning.installCli',
                        title: 'Install APC CLI'
                    };
                } else if (dependency.installUrl) {
                    this.command = {
                        command: 'agenticPlanning.openDependencyInstall',
                        title: 'Install',
                        arguments: [dependency]
                    };
                }
            }
        }
    }

    private buildTooltip(dep: DependencyStatus): string {
        let tooltip = `${dep.name}\n${dep.description}`;
        if (dep.version) {
            tooltip += `\nVersion: ${dep.version}`;
        }
        if (!dep.installed) {
            if (dep.name.includes('APC CLI')) {
                tooltip += `\n\n→ Click to install`;
            } else if (dep.installCommand) {
                tooltip += `\n\nInstall: ${dep.installCommand}`;
            }
            if (dep.installUrl) {
                tooltip += `\n\nClick to open install page`;
            }
        }
        return tooltip;
    }
}

