import * as vscode from 'vscode';
import { DependencyService, DependencyStatus } from '../services/DependencyService';

export class DependencyStatusProvider implements vscode.TreeDataProvider<DependencyItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<DependencyItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private dependencyService: DependencyService;
    private hasMissingDependencies: boolean = false;

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
        const statuses = this.dependencyService.getCachedStatus();
        const platform = process.platform;

        // Filter to show only current platform dependencies
        const relevantStatuses = statuses.filter(
            s => s.platform === platform || s.platform === 'all'
        );

        // If this is a child request - no children needed
        if (element) {
            return [];
        }

        // Root level
        if (relevantStatuses.length === 0) {
            // Show "checking..." item
            return [new DependencyItem(
                'Checking dependencies...',
                '',
                vscode.TreeItemCollapsibleState.None,
                'sync~spin'
            )];
        }

        const requiredStatuses = relevantStatuses.filter(s => s.required);
        const optionalStatuses = relevantStatuses.filter(s => !s.required);
        const allRequiredMet = requiredStatuses.every(s => s.installed);
        this.hasMissingDependencies = !allRequiredMet;

        const items: DependencyItem[] = [];

        if (allRequiredMet) {
            // ✅ All required deps met - just show green checkmark with "Ready"
            items.push(new DependencyItem(
                '✓ Ready',
                '',
                vscode.TreeItemCollapsibleState.None,
                'circle-filled',  // Solid circle icon
                undefined,
                'ready'
            ));
            // No sub-items when ready!
        } else {
            // ⚠️ Missing dependencies - show each missing one as a flat list (clickable to install)
            const missingDeps = requiredStatuses.filter(s => !s.installed);
            
            // Header showing count
            items.push(new DependencyItem(
                `⚠ ${missingDeps.length} Missing`,
                'Click items below to install',
                vscode.TreeItemCollapsibleState.None,
                'warning',
                undefined,
                'missing-header'
            ));
            
            // Show each missing dependency (clickable)
            for (const status of missingDeps) {
                items.push(new DependencyItem(
                    `  ✗ ${status.name}`,
                    'Click to install',
                    vscode.TreeItemCollapsibleState.None,
                    'close',
                    status,
                    'missing'
                ));
            }
        }

        return items;
    }

    /**
     * Check if there are missing dependencies (for auto-expand)
     */
    hasMissing(): boolean {
        return this.hasMissingDependencies;
    }
}

class DependencyItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly description: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        iconId?: string,
        public readonly dependency?: DependencyStatus,
        contextValue?: string,
        isChild: boolean = false
    ) {
        super(label, collapsibleState);
        this.description = description;
        this.contextValue = contextValue;
        
        if (iconId) {
            // Use colored icons based on status
            if (contextValue === 'missing' || contextValue === 'missing-parent' || contextValue === 'missing-header') {
                this.iconPath = new vscode.ThemeIcon(iconId, new vscode.ThemeColor('errorForeground'));
            } else if (contextValue === 'ready' || contextValue === 'installed') {
                // Use bright green for ready status
                this.iconPath = new vscode.ThemeIcon(iconId, new vscode.ThemeColor('testing.iconPassed'));
            } else if (contextValue === 'info') {
                this.iconPath = new vscode.ThemeIcon(iconId, new vscode.ThemeColor('charts.blue'));
            } else {
                this.iconPath = new vscode.ThemeIcon(iconId);
            }
        }

        if (dependency) {
            this.tooltip = this.buildTooltip(dependency);
            
            // If not installed, make it clickable
            if (!dependency.installed) {
                if (dependency.name.includes('APC CLI')) {
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

        // For missing parent, clicking should just expand (default behavior)
        if (contextValue === 'missing-parent') {
            this.tooltip = 'Click to see missing dependencies and install them';
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
