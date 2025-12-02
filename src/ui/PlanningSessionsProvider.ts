import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PlanningSession, PlanStatus, ExecutionState } from '../types';
import { ServiceLocator } from '../services/ServiceLocator';

/**
 * Async file existence check (replaces fs.existsSync)
 */
async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.promises.access(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Sync file existence check (for constructor use where async isn't possible)
 * Falls back to sync check but logs a warning if it blocks
 */
function fileExistsSync(filePath: string): boolean {
    try {
        fs.accessSync(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Agent display state for UI (subset of TaskManager's AgentAssignment)
 */
interface AgentDisplayState {
    name: string;
    status: 'idle' | 'working' | 'starting' | 'paused' | 'completed' | 'error';
    sessionId: string;
    currentTask?: string;
    logFile: string;
    startTime: string;
    lastActivity?: string;
}

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

    private async getSessionDetails(session: PlanningSession): Promise<PlanningSessionItem[]> {
        const details: PlanningSessionItem[] = [];
        
        // === Status categorization ===
        // Planning statuses (plan creation phase)
        const isPlanningOngoing = ['planning', 'revising'].includes(session.status);
        const isPlanningComplete = session.status === 'reviewing'; // Plan exists, awaiting approval
        const isPlanApproved = session.status === 'approved';
        const isExecutionComplete = session.status === 'completed';
        
        // In execution phase = approved with execution state, or completed
        // (workflow states are tracked separately - this just tracks if execution was ever started)
        const isInExecutionPhase = (isPlanApproved && !!session.execution) || isExecutionComplete;
        
        // No plan yet - either never created or planning failed
        const hasNoPlan = session.status === 'no_plan';
        
        // Does a plan file exist? (for showing Revise/Approve on stopped sessions)
        const hasPlanFile = !!session.currentPlanPath;
        
        // Is plan approved? (approved explicitly, or has started execution)
        const isApproved = isPlanApproved || isInExecutionPhase;

        // Plan file sub-item with approval flag and context-aware buttons
        if (session.currentPlanPath) {
            details.push(new PlanningSessionItem(
                session,
                'plan',
                `Plan: ${session.currentPlanPath.split('/').pop()}`,
                this.stateManager,
                undefined,
                undefined,
                { 
                    isPlanningOngoing, 
                    isApproved,
                    hasPlanFile,
                    isPlanningStoppedOrCancelled: false,  // No longer tracked at session level
                    isInExecutionPhase
                }
            ));
        }

        // NOTE: Progress log item removed - progress.log is no longer generated
        // Workflow logs are available in logs/ folder under each session

        // Version
        details.push(new PlanningSessionItem(
            session,
            'version',
            `Version: ${session.planHistory.length}`,
            this.stateManager
        ));

        // ====== EXECUTION STATUS ======
        // Show execution controls when plan is approved OR in execution phase
        // Note: Workflow states (running/paused) are shown on individual workflows, not here
        
        if (isPlanApproved || isInExecutionPhase) {
            let executionLabel: string;
            let executionContextValue: string;
            
            if (isExecutionComplete) {
                const progress = session.execution?.progress;
                const progressText = progress 
                    ? `${progress.completed}/${progress.total} (100%)`
                    : 'Complete';
                executionLabel = `✅ Execution: ${progressText}`;
                executionContextValue = 'executionItem_completed';
            } else if (session.execution) {
                // Execution started - show progress
                const progress = session.execution.progress;
                const progressText = progress?.total 
                    ? `${progress.completed}/${progress.total} (${progress.percentage.toFixed(0)}%)`
                    : 'In progress...';
                executionLabel = `🔄 Execution: ${progressText}`;
                executionContextValue = 'executionItem';
            } else {
                // Approved but not yet started
                executionLabel = `▶️ Execution: Ready to start`;
                executionContextValue = 'executionItem_ready';
            }
            
            details.push(new PlanningSessionItem(
                session,
                'execution',
                executionLabel,
                this.stateManager,
                undefined,
                undefined,
                undefined,
                executionContextValue
            ));
            
            // TODO: Agents working on this session - will be restored when DaemonStateProxy is extended
            // Currently commented out to remove TaskManager dependency
            /*
            if (session.execution && isInExecutionPhase) {
                // Get agents from daemon via proxy
                const sessionAgents = []; // TODO: Get from daemon
                
                if (sessionAgents.length > 0) {
                    details.push(new PlanningSessionItem(
                        session,
                        'engineers_header',
                        `👷 Agents (${sessionAgents.length})`,
                        this.stateManager
                    ));
                    
                    // Individual agent status - clicking opens their log
                    for (const agent of sessionAgents) {
                        const displayStatus = agent.status === 'error_fixing' ? 'working' 
                            : agent.status === 'waiting' ? 'idle' 
                            : agent.status;
                        const statusIcon = this.getEngineerStatusIcon(displayStatus);
                        const taskText = agent.currentTaskId 
                            ? `: ${agent.currentTaskId.substring(0, 25)}...`
                            : '';
                        
                        details.push(new PlanningSessionItem(
                            session,
                            'engineer',
                            `  ${statusIcon} ${agent.name}${taskText}`,
                            this.stateManager,
                            agent.logFile,
                            { 
                                name: agent.name,
                                status: displayStatus as 'idle' | 'working', 
                                sessionId: agent.sessionId,
                                currentTask: agent.currentTaskId, 
                                logFile: agent.logFile,
                                startTime: agent.assignedAt,
                                lastActivity: agent.lastActivityAt
                            }
                        ));
                    }
                }
            }
            */
            
            // Show execution summary when completed (if available)
            // Note: Execution summary path would need to be stored on the session if desired
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

interface PlanItemState {
    isPlanningOngoing: boolean;
    isApproved: boolean;
    hasPlanFile?: boolean;
    isPlanningStoppedOrCancelled?: boolean;
    isInExecutionPhase?: boolean;
}

export class PlanningSessionItem extends vscode.TreeItem {
    constructor(
        public readonly session: PlanningSession,
        public readonly detailType?: string,
        label?: string,
        stateManager?: StateManager,
        extraPath?: string,
        public readonly engineerState?: AgentDisplayState,
        planItemState?: PlanItemState,
        customContextValue?: string  // For explicit context value override
    ) {
        super(
            label || `${session.id}: ${session.requirement.substring(0, 30)}...`,
            detailType ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed
        );

        if (!detailType) {
            // Main session item - only shows delete button
            this.contextValue = `planningSession`;
            this.iconPath = this.getStatusIcon(session.status);
            this.description = session.status;
            this.tooltip = new vscode.MarkdownString(this.getTooltip(session));

            // Click opens plan file
            if (session.currentPlanPath) {
                this.command = {
                    command: 'vscode.open',
                    title: 'Open Plan',
                    arguments: [vscode.Uri.file(session.currentPlanPath)]
                };
            }
        } else {
            // Detail item - use custom context value if provided
            this.contextValue = customContextValue || this.getDetailContextValue(detailType, session, planItemState);
            
            // Set icon and command based on detail type
            switch (detailType) {
                case 'plan':
                    // Plan item shows approval status + context-aware buttons
                    const approved = planItemState?.isApproved ?? false;
                    const isPlanningOngoing = planItemState?.isPlanningOngoing ?? false;
                    const hasNoPlan = session.status === 'no_plan';
                    
                    if (approved) {
                        this.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
                        this.description = '✓ approved';
                    } else if (hasNoPlan) {
                        // No plan created yet
                        this.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.gray'));
                        this.description = '⏳ no plan yet';
                    } else if (isPlanningOngoing) {
                        // Planning still in progress
                        this.iconPath = new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.yellow'));
                        this.description = '⏳ planning...';
                    } else {
                        // Planning complete, awaiting approval (reviewing status)
                        this.iconPath = new vscode.ThemeIcon('checklist', new vscode.ThemeColor('charts.blue'));
                        this.description = '📋 ready for approval';
                    }
                    
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
                        this.tooltip = `Click to view progress log`;
                        this.description = '(click to view)';
                    }
                    break;
                    
                case 'version':
                    this.iconPath = new vscode.ThemeIcon('history');
                    break;
                    
                case 'execution':
                    // Execution item with pause/resume/stop buttons
                    this.iconPath = new vscode.ThemeIcon('graph', new vscode.ThemeColor('charts.blue'));
                    if (session.execution) {
                        this.tooltip = `Session: ${session.id}\n${session.execution.progress.completed} of ${session.execution.progress.total} tasks complete`;
                    }
                    break;
                    
                case 'engineers_header':
                    this.iconPath = new vscode.ThemeIcon('organization', new vscode.ThemeColor('charts.green'));
                    break;
                    
                case 'engineer':
                    // Engineer item - clicking opens their log file
                    this.iconPath = new vscode.ThemeIcon('account');
                    if (extraPath && fileExistsSync(extraPath)) {
                        this.command = {
                            command: 'vscode.open',
                            title: 'Open Engineer Log',
                            arguments: [vscode.Uri.file(extraPath)]
                        };
                        this.description = '(click to view log)';
                        this.tooltip = `Log: ${extraPath}\nClick to view engineer output`;
                    } else if (extraPath) {
                        this.tooltip = `Log file not yet created: ${extraPath}`;
                        this.description = '(no log yet)';
                    }
                    break;
                
                case 'execution_summary':
                    // Execution summary - clicking opens the summary file
                    this.iconPath = new vscode.ThemeIcon('file-text', new vscode.ThemeColor('charts.green'));
                    if (extraPath && fileExistsSync(extraPath)) {
                        this.command = {
                            command: 'vscode.open',
                            title: 'Open Execution Summary',
                            arguments: [vscode.Uri.file(extraPath)]
                        };
                        this.description = '(click to view)';
                        this.tooltip = `Click to view execution summary`;
                    } else if (extraPath) {
                        this.tooltip = `Summary file not found: ${extraPath}`;
                        this.description = '(file missing)';
                    }
                    break;
                    
                default:
                    this.iconPath = new vscode.ThemeIcon('circle-small-filled');
            }
        }
    }

    /**
     * Get context value for detail items to control button visibility
     * 
     * Plan sub-item buttons (based on PLANNING phase):
     * - Planning ongoing (debating/revising) → Stop button only
     * - Planning stopped WITH plan file → Revise + Approve buttons (can approve the existing plan)
     * - Planning stopped WITHOUT plan file → Resume button only
     * - Reviewing (plan complete) → Revise + Approve buttons
     * - Approved (not yet executing) → Start + Revise buttons
     * 
     * During EXECUTION phase:
     * - Executing/Paused/Completed → Revise button only (on plan item)
     * 
     * Execution sub-item buttons (separate from plan):
     * - Executing → Pause + Stop buttons
     * - Paused → Resume + Stop buttons
     * - Completed → (no buttons)
     */
    private getDetailContextValue(detailType: string, session: PlanningSession, planItemState?: PlanItemState): string {
        const status = session.status;
        
        switch (detailType) {
            case 'plan':
                // Use passed state or derive from session
                const isPlanningOngoing = planItemState?.isPlanningOngoing ?? ['planning', 'revising'].includes(status);
                const isApproved = planItemState?.isApproved ?? (status === 'approved');
                const hasPlanFile = planItemState?.hasPlanFile ?? !!session.currentPlanPath;
                const isInExecutionPhase = planItemState?.isInExecutionPhase ?? ((status === 'approved' && !!session.execution) || status === 'completed');
                const isReviewing = status === 'reviewing';
                const hasNoPlan = status === 'no_plan';
                
                if (isPlanningOngoing) {
                    // Planning actively in progress (planning/revising) - only stop button
                    return 'planItem_planning';
                } else if (isInExecutionPhase) {
                    // In execution phase - plan is locked, only allow revision
                    return 'planItem_executing';
                } else if (hasNoPlan) {
                    // No plan yet - show restart option
                    return 'planItem_no_plan';
                } else if (isReviewing) {
                    // Plan complete, ready for approval - show Revise + Approve
                    return 'planItem_pending';
                } else if (isApproved) {
                    // Approved but not yet executing - show Start + Revise
                    return 'planItem_approved';
                } else {
                    // Fallback - show Revise + Approve
                    return 'planItem_pending';
                }
                
            case 'execution':
                // Execution context - workflow controls are shown on individual workflows now
                return 'executionItem';
                
            case 'engineer':
                // Individual engineer controls
                if (this.engineerState) {
                    return `engineer_${this.engineerState.status}`;
                }
                return 'engineer';
                
            default:
                return `planningSession.${detailType}`;
        }
    }

    private getStatusIcon(status: PlanStatus): vscode.ThemeIcon {
        switch (status) {
            case 'no_plan':
                return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('charts.gray'));
            case 'planning':
                return new vscode.ThemeIcon('comment-discussion', new vscode.ThemeColor('charts.yellow'));
            case 'reviewing':
                return new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.blue'));
            case 'revising':
                return new vscode.ThemeIcon('edit', new vscode.ThemeColor('charts.orange'));
            case 'approved':
                return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
            case 'completed':
                return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
            default:
                return new vscode.ThemeIcon('circle-outline');
        }
    }

    private getTooltip(session: PlanningSession): string {
        let tooltip = `**${session.id}**\n\n`;
        tooltip += `**Status:** ${session.status}\n\n`;
        tooltip += `**Requirement:**\n${session.requirement}\n\n`;
        tooltip += `**Created:** ${new Date(session.createdAt).toLocaleString()}\n`;
        tooltip += `**Updated:** ${new Date(session.updatedAt).toLocaleString()}\n\n`;
        tooltip += `**Versions:** ${session.planHistory.length}`;
        
        if (session.execution) {
            tooltip += `\n\n**Execution:**\n`;
            tooltip += `Progress: ${session.execution.progress.percentage.toFixed(0)}%`;
        }
        
        return tooltip;
    }
}
