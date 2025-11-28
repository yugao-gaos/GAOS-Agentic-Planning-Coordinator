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
        
        // === Status categorization ===
        // Planning statuses (plan creation phase)
        const isPlanningOngoing = ['debating', 'revising'].includes(session.status);
        const isPlanningComplete = session.status === 'reviewing'; // Plan exists, awaiting approval
        const isPlanApproved = session.status === 'approved';
        
        // Execution statuses (plan execution phase)
        const isExecuting = session.status === 'executing';
        const isExecutionPaused = session.status === 'paused';
        const isExecutionComplete = session.status === 'completed';
        
        // Stopped can mean planning stopped OR execution stopped
        // If session.execution exists, it means execution was started (so it's execution stopped)
        const isExecutionStopped = session.status === 'stopped' && !!session.execution;
        const isPlanningStoppedOrCancelled = ['stopped', 'cancelled'].includes(session.status) && !session.execution;
        
        // In execution phase = currently executing, paused, completed, OR execution was stopped
        const isInExecutionPhase = isExecuting || isExecutionPaused || isExecutionComplete || isExecutionStopped;
        
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
                    isPlanningStoppedOrCancelled,
                    isInExecutionPhase
                }
            ));
        }

        // Progress log (in plan folder: _AiDevLog/Plans/{sessionId}/progress.log)
        const progressLogPath = this.stateManager.getProgressLogPath(session.id);
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

        // ====== EXECUTION STATUS ======
        // Show execution controls when plan is approved OR in execution phase
        // Check for reviewing status from coordinator
        const coordinator = session.execution?.coordinatorId 
            ? this.stateManager.getCoordinator(session.execution.coordinatorId) 
            : null;
        const isReviewing = coordinator?.status === 'reviewing';
        
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
            } else if (isReviewing) {
                const progress = session.execution?.progress;
                const progressText = progress 
                    ? `${progress.completed}/${progress.total} (100%)`
                    : 'Reviewing';
                executionLabel = `📋 Execution: ${progressText} - Reviewing...`;
                executionContextValue = 'executionItem_reviewing';
            } else if (isExecutionStopped) {
                const progress = session.execution?.progress;
                const progressText = progress 
                    ? `${progress.completed}/${progress.total} (${progress.percentage.toFixed(0)}%)`
                    : 'Stopped';
                executionLabel = `⏹️ Execution: ${progressText} - Stopped`;
                executionContextValue = 'executionItem_stopped';
            } else if (isExecutionPaused) {
                const progress = session.execution?.progress;
                const progressText = progress 
                    ? `${progress.completed}/${progress.total} (${progress.percentage.toFixed(0)}%)`
                    : 'Paused';
                executionLabel = `⏸️ Execution: ${progressText} - Paused`;
                executionContextValue = 'executionItem_paused';
            } else if (isExecuting) {
                const progress = session.execution?.progress;
                const progressText = progress?.total 
                    ? `${progress.completed}/${progress.total} (${progress.percentage.toFixed(0)}%)`
                    : 'Starting...';
                executionLabel = `🔄 Execution: ${progressText}`;
                executionContextValue = 'executionItem_running';
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
            
            // Engineers working on this session (only if in execution phase)
            if (session.execution && isInExecutionPhase) {
                const engineers = session.execution.engineers;
                if (Object.keys(engineers).length > 0) {
                    details.push(new PlanningSessionItem(
                        session,
                        'engineers_header',
                        `👷 Engineers (${Object.keys(engineers).length})`,
                        this.stateManager
                    ));
                    
                    // Individual engineer status - clicking opens their log
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
            }
            
            // Show execution summary when completed
            if (isExecutionComplete && coordinator?.executionSummaryPath) {
                details.push(new PlanningSessionItem(
                    session,
                    'execution_summary',
                    `📄 Execution Summary`,
                    this.stateManager,
                    coordinator.executionSummaryPath
                ));
            }
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
        public readonly engineerState?: EngineerExecutionState,
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
                    const planningDone = !planItemState?.isPlanningOngoing;
                    
                    if (approved) {
                        this.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
                        this.description = '✓ approved';
                    } else if (planningDone) {
                        // Planning complete, awaiting approval
                        this.iconPath = new vscode.ThemeIcon('checklist', new vscode.ThemeColor('charts.blue'));
                        this.description = '📋 ready for approval';
                    } else {
                        // Planning still in progress
                        this.iconPath = new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.yellow'));
                        this.description = '⏳ planning...';
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
                        this.tooltip = `Coordinator: ${session.execution.coordinatorId}\n${session.execution.progress.completed} of ${session.execution.progress.total} tasks complete`;
                    }
                    break;
                    
                case 'engineers_header':
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
                    } else if (extraPath) {
                        this.tooltip = `Log file not yet created: ${extraPath}`;
                        this.description = '(no log yet)';
                    }
                    break;
                
                case 'execution_summary':
                    // Execution summary - clicking opens the summary file
                    this.iconPath = new vscode.ThemeIcon('file-text', new vscode.ThemeColor('charts.green'));
                    if (extraPath && fs.existsSync(extraPath)) {
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
                const isPlanningOngoing = planItemState?.isPlanningOngoing ?? ['debating', 'revising'].includes(status);
                const isApproved = planItemState?.isApproved ?? (status === 'approved');
                const hasPlanFile = planItemState?.hasPlanFile ?? !!session.currentPlanPath;
                const isPlanningStoppedOrCancelled = planItemState?.isPlanningStoppedOrCancelled ?? ['stopped', 'cancelled'].includes(status);
                const isInExecutionPhase = planItemState?.isInExecutionPhase ?? ['executing', 'paused', 'completed'].includes(status);
                const isReviewing = status === 'reviewing';
                
                if (isPlanningOngoing) {
                    // Planning actively in progress (debating/revising) - only stop button
                    return 'planItem_planning';
                } else if (isInExecutionPhase) {
                    // In execution phase - plan is locked, only allow revision
                    return 'planItem_executing';
                } else if (isPlanningStoppedOrCancelled && hasPlanFile) {
                    // Planning was stopped but we have a plan file - show Revise + Approve
                    return 'planItem_pending';
                } else if (isPlanningStoppedOrCancelled && !hasPlanFile) {
                    // Planning was stopped before plan was created - show Resume
                    return 'planItem_stopped';
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
                // Execution item shows pause/resume/stop
                if (status === 'executing') {
                    return 'executionItem_running';
                } else if (status === 'paused') {
                    return 'executionItem_paused';
                }
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
        let tooltip = `**${session.id}**\n\n`;
        tooltip += `**Status:** ${session.status}\n\n`;
        tooltip += `**Requirement:**\n${session.requirement}\n\n`;
        tooltip += `**Created:** ${new Date(session.createdAt).toLocaleString()}\n`;
        tooltip += `**Updated:** ${new Date(session.updatedAt).toLocaleString()}\n\n`;
        tooltip += `**Versions:** ${session.planHistory.length}`;
        
        if (session.execution) {
            tooltip += `\n\n**Execution:**\n`;
            tooltip += `Coordinator: ${session.execution.coordinatorId}\n`;
            tooltip += `Progress: ${session.execution.progress.percentage.toFixed(0)}%`;
        }
        
        return tooltip;
    }
}
