/**
 * Session item component - renders a single planning session with its sub-items.
 */
import { SessionInfo, WorkflowInfo, AgentInfo, FailedTaskInfo } from '../types';
import { ICONS } from '../icons';
import { escapeHtml } from '../helpers';

/**
 * Workflow type configuration for icons and labels.
 */
const WORKFLOW_TYPE_INFO: Record<string, { icon: string; class: string; label: string }> = {
    'planning_new': {
        icon: ICONS.planning,
        class: 'planning',
        label: 'Planning'
    },
    'planning_revision': {
        icon: ICONS.revision,
        class: 'planning',
        label: 'Revision'
    },
    'task_implementation': {
        icon: ICONS.task,
        class: 'task',
        label: 'Task'  // Will be overridden with taskId if available
    },
    'error_resolution': {
        icon: ICONS.error,
        class: 'error',
        label: 'Error Fix'
    }
};

/**
 * Get plan action buttons based on session status.
 */
function getPlanButtons(status: string): string {
    // Only show Revise/Approve when plan is ready for review
    if (status === 'reviewing') {
        return `
            <button class="sub-item-btn" data-action="revisePlan">Revise</button>
            <button class="sub-item-btn primary" data-action="approvePlan">Approve</button>
        `;
    }
    // Planning in progress - show stop button
    if (status === 'debating') {
        return `<button class="sub-item-btn danger" data-action="stopExecution">Stop</button>`;
    }
    if (status === 'revising') {
        return `<button class="sub-item-btn danger" data-action="stopRevision">Stop</button>`;
    }
    if (status === 'approved') {
        return `<button class="sub-item-btn" data-action="revisePlan">Revise</button>`;
    }
    return '';
}

/**
 * Get execution status and buttons based on session status.
 */
function getExecutionInfo(status: string): { buttons: string; status: string; badgeClass: string } {
    switch (status) {
        case 'executing':
            return {
                buttons: `
                    <button class="sub-item-btn" data-action="pauseExecution">Pause</button>
                    <button class="sub-item-btn danger" data-action="stopExecution">Stop</button>
                `,
                status: 'Running',
                badgeClass: 'running'
            };
        case 'paused':
            return {
                buttons: `
                    <button class="sub-item-btn primary" data-action="resumeExecution">Resume</button>
                    <button class="sub-item-btn danger" data-action="stopExecution">Stop</button>
                `,
                status: 'Paused',
                badgeClass: 'paused'
            };
        case 'approved':
            return {
                buttons: `<button class="sub-item-btn primary" data-action="startExecution">Start</button>`,
                status: 'Ready',
                badgeClass: 'approved'
            };
        case 'completed':
            return {
                buttons: '',
                status: 'Completed',
                badgeClass: 'completed'
            };
        case 'failed':
            return {
                buttons: '',
                status: 'Failed',
                badgeClass: 'draft'
            };
        case 'stopped':
            // Stopped during execution - can resume
            return {
                buttons: `<button class="sub-item-btn primary" data-action="resumeExecution">Resume</button>`,
                status: 'Stopped',
                badgeClass: 'draft'
            };
        case 'cancelled':
            // Cancelled during planning - can restart (will resume revision if cancelled during revision)
            return {
                buttons: `<button class="sub-item-btn" data-action="restartPlanning">Restart</button>`,
                status: 'Cancelled',
                badgeClass: 'draft'
            };
        default:
            return {
                buttons: '',
                status: 'Pending Plan Approval',
                badgeClass: 'pending'
            };
    }
}

/**
 * Get plan status badge class.
 */
function getPlanBadgeClass(planStatus?: string): string {
    switch (planStatus) {
        case 'Approved': return 'approved';
        case 'Pending Review': return 'pending';
        case 'Planning...': return 'running';
        case 'Revising': return 'running';
        default: return 'draft';
    }
}

/**
 * Render a single workflow item with optional agent info.
 */
function renderWorkflowItem(wf: WorkflowInfo, agent?: AgentInfo): string {
    const typeInfo = WORKFLOW_TYPE_INFO[wf.type] || {
        icon: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>',
        class: '',
        label: wf.type
    };
    
    // Use taskId as label for task workflows
    const label = wf.type === 'task_implementation' && wf.taskId 
        ? wf.taskId 
        : typeInfo.label;
    
    // Build agent badge if agent is assigned to this workflow
    const agentBadge = agent ? `<span class="workflow-agent" style="color: ${agent.roleColor || '#f97316'};">${agent.name}</span>` : '';
    
    return `
        <div class="workflow-item ${wf.status}" data-action="openProgressLog" title="Click to view progress log" style="cursor: pointer;">
            <div class="workflow-type-icon ${typeInfo.class}">
                ${typeInfo.icon}
            </div>
            <div class="workflow-info">
                <span class="workflow-type-label">${label}</span>
                <span class="workflow-phase">${wf.phase} (${wf.phaseIndex + 1}/${wf.totalPhases})</span>
            </div>
            <div class="workflow-progress">
                <div class="workflow-progress-bar">
                    <div class="workflow-progress-fill ${wf.status}" style="width: ${Math.round(wf.percentage)}%;"></div>
                </div>
                <span class="workflow-percentage">${Math.round(wf.percentage)}%</span>
            </div>
            ${agentBadge}
        </div>
    `;
}

/**
 * Render a completed workflow history item (simplified view).
 */
function renderHistoryItem(wf: WorkflowInfo): string {
    const typeInfo = WORKFLOW_TYPE_INFO[wf.type] || {
        icon: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>',
        class: '',
        label: wf.type
    };
    
    // Use taskId as label for task workflows
    const label = wf.type === 'task_implementation' && wf.taskId 
        ? wf.taskId 
        : typeInfo.label;
    
    const statusIcon = wf.status === 'completed' 
        ? '<span style="color: #10b981;">✓</span>' 
        : '<span style="color: #f14c4c;">✗</span>';
    
    return `
        <div class="workflow-item history ${wf.status}" style="opacity: 0.7;">
            <div class="workflow-type-icon ${typeInfo.class}" style="opacity: 0.6;">
                ${typeInfo.icon}
            </div>
            <div class="workflow-info">
                <span class="workflow-type-label">${label}</span>
                <span class="workflow-phase">${statusIcon} ${wf.phase}</span>
            </div>
        </div>
    `;
}

/**
 * Find the agent assigned to a specific workflow.
 */
function findAgentForWorkflow(wf: WorkflowInfo, agents: AgentInfo[]): AgentInfo | undefined {
    if (!agents || agents.length === 0) return undefined;
    
    // Match by workflow type to role
    const roleForType: Record<string, string[]> = {
        'planning_new': ['planner'],
        'planning_revision': ['planner'],
        'task_implementation': ['engineer'],
        'error_resolution': ['engineer']
    };
    
    const matchingRoles = roleForType[wf.type] || [];
    return agents.find(a => matchingRoles.includes(a.roleId || ''));
}

/**
 * Render failed tasks section.
 */
function renderFailedTasks(failedTasks: FailedTaskInfo[]): string {
    if (!failedTasks || failedTasks.length === 0) {
        return '';
    }
    
    return `
        <div class="nested-item failed-header">
            <div class="nested-icon" style="color: #f14c4c;">
                ${ICONS.error}
            </div>
            <span class="nested-label" style="color: #f14c4c;">Failed Tasks (${failedTasks.length})</span>
        </div>
        ${failedTasks.map(ft => `
            <div class="nested-item nested-failed" style="padding-left: 48px;">
                <span class="nested-label" title="${escapeHtml(ft.lastError)}">
                    ${ft.taskId}: ${escapeHtml(ft.description.substring(0, 30))}...
                </span>
                <span class="nested-badge" style="color: #f14c4c;">${ft.attempts} attempts</span>
                ${ft.canRetry ? `<button class="retry-btn" data-action="retryTask" data-task-id="${ft.taskId}">Retry</button>` : ''}
            </div>
        `).join('')}
    `;
}

/**
 * Get execution progress summary for the header badge.
 */
function getExecutionProgressText(session: SessionInfo): string {
    const runningWf = session.activeWorkflows?.find(w => w.status === 'running');
    
    if (runningWf) {
        return `${Math.round(runningWf.percentage)}%`;
    }
    
    if (session.taskCount > 0) {
        return `${session.completedTasks}/${session.taskCount}`;
    }
    
    return '';
}

/**
 * Render a complete session item.
 */
export function renderSessionItem(session: SessionInfo, isExpanded: boolean): string {
    const truncatedReq = session.requirement.length > 40 
        ? session.requirement.substring(0, 40) + '...' 
        : session.requirement;
    
    const planButtons = getPlanButtons(session.status);
    const execInfo = getExecutionInfo(session.status);
    const planBadgeClass = getPlanBadgeClass(session.planStatus);
    
    // Determine if session is active (has running workflows)
    const hasRunningWorkflow = session.activeWorkflows?.some(w => w.status === 'running') || false;
    const isRevising = session.status === 'revising' || session.isRevising;
    const activityClass = isRevising ? 'revising' : (hasRunningWorkflow || session.status === 'executing' ? 'active' : '');
    
    return `
        <div class="session-item ${isExpanded ? 'expanded' : ''} ${activityClass}" 
             data-session-id="${session.id}" 
             data-plan-path="${session.planPath || ''}">
            <!-- Session Header -->
            <div class="session-header" data-toggle="${session.id}">
                <div class="session-expand ${isExpanded ? 'expanded' : ''}">
                    ${ICONS.chevronRight}
                </div>
                <div class="session-status-dot ${session.status}"></div>
                <span class="session-title" title="${escapeHtml(session.requirement)}">
                    ${escapeHtml(truncatedReq)}
                </span>
                <button class="session-remove-btn" data-action="removeSession" title="Remove">
                    ${ICONS.remove}
                </button>
            </div>
            
            <!-- Session Body -->
            <div class="session-body ${isExpanded ? 'expanded' : ''}" 
                 data-progress-log="${session.progressLogPath || ''}">
                
                <!-- Plan sub-item -->
                <div class="sub-item" data-action="openPlan">
                    <div class="sub-item-icon">${ICONS.document}</div>
                    <span class="sub-item-label">
                        Plan V${session.planVersion} 
                        <span style="opacity: 0.6; font-size: 10px;">(${session.id})</span>
                    </span>
                    <span class="sub-item-badge ${planBadgeClass}">${session.planStatus || 'Draft'}</span>
                    <div class="sub-item-spacer"></div>
                    <div class="sub-item-actions">${planButtons}</div>
                </div>
                
                <!-- Progress Log sub-item -->
                ${session.progressLogPath ? `
                    <div class="sub-item" data-action="openProgressLog" data-progress-path="${session.progressLogPath}">
                        <div class="sub-item-icon">${ICONS.list}</div>
                        <span class="sub-item-label">Progress Log</span>
                        <div class="sub-item-spacer"></div>
                        <span style="font-size: 10px; opacity: 0.6;">(click to view)</span>
                    </div>
                ` : ''}
                
                <!-- Coordinator sub-item (expandable) -->
                <div class="sub-item coordinator-header" data-coord-toggle="${session.id}">
                    <div class="sub-item-expand">
                        ${ICONS.chevronRight}
                    </div>
                    <div class="sub-item-icon">${ICONS.workflow}</div>
                    <span class="sub-item-label">Execution</span>
                    <span class="sub-item-badge ${execInfo.badgeClass}">${execInfo.status}</span>
                    <div class="sub-item-spacer"></div>
                    ${getExecutionProgressText(session) ? `<span class="execution-progress-text">${getExecutionProgressText(session)}</span>` : ''}
                    <div class="sub-item-actions">${execInfo.buttons}</div>
                </div>
                
                <!-- Coordinator children (Workflows + History + Failed Tasks) -->
                <div class="coordinator-children" data-coord-children="${session.id}">
                    <!-- Active Workflows (running first) -->
                    ${session.activeWorkflows && session.activeWorkflows.length > 0 ? `
                        <div class="nested-item">
                            <div class="nested-icon" style="color: #007acc;">
                                ${ICONS.workflow}
                            </div>
                            <span class="nested-label">Active (${session.activeWorkflows.length})</span>
                        </div>
                        ${session.activeWorkflows.map(wf => renderWorkflowItem(wf, findAgentForWorkflow(wf, session.sessionAgents || []))).join('')}
                    ` : ''}
                    
                    <!-- Workflow History (completed, newest first) -->
                    ${session.workflowHistory && session.workflowHistory.length > 0 ? `
                        <div class="nested-item" style="margin-top: 8px;">
                            <div class="nested-icon" style="color: #6b7280;">
                                ${ICONS.list}
                            </div>
                            <span class="nested-label" style="opacity: 0.7;">History (${session.workflowHistory.length})</span>
                        </div>
                        ${session.workflowHistory.slice(0, 5).map(wf => renderHistoryItem(wf)).join('')}
                        ${session.workflowHistory.length > 5 ? `<div class="nested-item" style="opacity: 0.5; font-size: 10px; padding-left: 32px;">+ ${session.workflowHistory.length - 5} more</div>` : ''}
                    ` : ''}
                    
                    <!-- Failed Tasks -->
                    ${renderFailedTasks(session.failedTasks)}
                </div>
            </div>
        </div>
    `;
}

/**
 * Render the sessions section.
 */
export function renderSessionsSection(sessions: SessionInfo[], expandedSessionIds: Set<string>): string {
    if (sessions.length === 0) {
        return `
            <div class="empty-state">
                <div class="icon">📋</div>
                <div>No planning sessions</div>
                <div style="margin-top: 4px;">Click + to start a new session</div>
            </div>
        `;
    }
    
    return sessions
        .map(s => renderSessionItem(s, expandedSessionIds.has(s.id)))
        .join('');
}

