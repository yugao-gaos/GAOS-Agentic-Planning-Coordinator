import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { StateManager } from '../services/StateManager';
import { PlanningSession, PlanningStatus, ExecutionState, EngineerExecutionState } from '../types';

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
            `Requirement: ${session.requirement.substring(0, 40)}...`,
            this.stateManager
        ));

        // Current plan
        if (session.currentPlanPath) {
            details.push(new PlanningSessionItem(
                session,
                'plan',
                `Plan: ${session.currentPlanPath.split('/').pop()}`,
                this.stateManager
            ));
        }

        // Progress log (useful for seeing debate progress)
        const progressLogPath = path.join(
            this.stateManager.getWorkingDir(),
            'planning_sessions',
            `${session.id}_progress.log`
        );
        if (fs.existsSync(progressLogPath)) {
            details.push(new PlanningSessionItem(
                session,
                'progress',
                `Progress Log`,
                this.stateManager,
                progressLogPath
            ));
        }

        // Version
        details.push(new PlanningSessionItem(
            session,
            'version',
            `Version: ${session.planHistory.length}`,
            this.stateManager
        ));

        // ====== EXECUTION STATUS (if executing, paused, or completed) ======
        if (session.execution && (session.status === 'executing' || session.status === 'paused' || session.status === 'completed')) {
            // Execution progress
            const progress = session.execution.progress;
            const progressText = progress.total > 0 
                ? `${progress.completed}/${progress.total} tasks (${progress.percentage.toFixed(0)}%)`
                : 'Starting...';
            
            details.push(new PlanningSessionItem(
                session,
                'execution_progress',
                `📊 Progress: ${progressText}`,
                this.stateManager
            ));
            
            // Current wave
            details.push(new PlanningSessionItem(
                session,
                'execution_wave',
                `🌊 Wave: ${session.execution.currentWave}`,
                this.stateManager
            ));
            
            // Engineers working on this session
            const engineers = session.execution.engineers;
            if (Object.keys(engineers).length > 0) {
                details.push(new PlanningSessionItem(
                    session,
                    'execution_engineers_header',
                    `👷 Engineers (${Object.keys(engineers).length})`,
                    this.stateManager
                ));
                
                // Individual engineer status
                for (const [name, engState] of Object.entries(engineers)) {
                    const statusIcon = this.getEngineerStatusIcon(engState.status);
                    const taskText = engState.currentTask 
                        ? `: ${engState.currentTask.substring(0, 25)}...`
                        : '';
                    
                    details.push(new PlanningSessionItem(
                        session,
                        'engineer',
                        `  ${statusIcon} ${name}${taskText}`,
                        this.stateManager,
                        engState.logFile,
                        engState
                    ));
                }
            }
        } else if (session.recommendedEngineers) {
            // Not executing yet - show recommendation
            details.push(new PlanningSessionItem(
                session,
                'engineers',
                `Engineers: ${session.recommendedEngineers.count} recommended`,
                this.stateManager
            ));
        }

        return details;
    }
    
    private getEngineerStatusIcon(status: string): string {
        switch (status) {
            case 'working': return '🔧';
            case 'starting': return '⏳';
            case 'completed': return '✅';
            case 'paused': return '⏸️';
            case 'error': return '❌';
            case 'idle': return '💤';
            default: return '❓';
        }
    }
}

export class PlanningSessionItem extends vscode.TreeItem {
    constructor(
        public readonly session: PlanningSession,
        public readonly detailType?: string,
        label?: string,
        stateManager?: StateManager,
        extraPath?: string,
        public readonly engineerState?: EngineerExecutionState
    ) {
        super(
            label || `${session.id}: ${session.requirement.substring(0, 30)}...`,
            detailType ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed
        );

        if (!detailType) {
            // Main session item - include status for context menu filtering
            this.contextValue = `planningSession_${session.status}`;
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
            
            // Set icon and command based on detail type
            switch (detailType) {
                case 'plan':
                    this.iconPath = new vscode.ThemeIcon('file-text');
                    if (session.currentPlanPath) {
                        this.command = {
                            command: 'vscode.open',
                            title: 'Open Plan',
                            arguments: [vscode.Uri.file(session.currentPlanPath)]
                        };
                        this.tooltip = `Click to open: ${session.currentPlanPath}`;
                    }
                    break;
                case 'progress':
                    this.iconPath = new vscode.ThemeIcon('output');
                    if (extraPath) {
                        this.command = {
                            command: 'vscode.open',
                            title: 'Open Progress Log',
                            arguments: [vscode.Uri.file(extraPath)]
                        };
                        this.tooltip = `Click to view debate progress`;
                        this.description = '(click to view)';
                    }
                    break;
                case 'requirement':
                    this.iconPath = new vscode.ThemeIcon('note');
                    this.tooltip = session.requirement;
                    break;
                case 'version':
                    this.iconPath = new vscode.ThemeIcon('history');
                    break;
                case 'engineers':
                    this.iconPath = new vscode.ThemeIcon('person');
                    if (session.recommendedEngineers?.justification) {
                        this.tooltip = session.recommendedEngineers.justification;
                    }
                    break;
                    
                // Execution-related items
                case 'execution_progress':
                    this.iconPath = new vscode.ThemeIcon('graph', new vscode.ThemeColor('charts.blue'));
                    if (session.execution) {
                        this.tooltip = `${session.execution.progress.completed} of ${session.execution.progress.total} tasks complete`;
                    }
                    break;
                case 'execution_wave':
                    this.iconPath = new vscode.ThemeIcon('layers', new vscode.ThemeColor('charts.purple'));
                    this.tooltip = 'Current execution wave (tasks executed in parallel within a wave)';
                    break;
                case 'execution_engineers_header':
                    this.iconPath = new vscode.ThemeIcon('organization', new vscode.ThemeColor('charts.green'));
                    break;
                case 'engineer':
                    // Engineer item - clicking opens their log file
                    this.iconPath = new vscode.ThemeIcon('account');
                    if (extraPath && fs.existsSync(extraPath)) {
                        this.command = {
                            command: 'vscode.open',
                            title: 'Open Engineer Log',
                            arguments: [vscode.Uri.file(extraPath)]
                        };
                        this.description = '(click to view log)';
                        this.tooltip = `Log: ${extraPath}\nClick to view engineer output`;
                    }
                    if (this.engineerState) {
                        this.contextValue = `engineer_${this.engineerState.status}`;
                    }
                    break;
                    
                default:
                    this.iconPath = new vscode.ThemeIcon('circle-small-filled');
            }
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
            case 'stopped':
                return new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('charts.purple'));
            // Execution statuses
            case 'executing':
                return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.green'));
            case 'paused':
                return new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('charts.orange'));
            case 'completed':
                return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
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










