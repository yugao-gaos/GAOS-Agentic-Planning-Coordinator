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
    if (status === 'planning') {
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
 * Note: Workflow states (running/paused) are now shown on individual workflows, not here.
 */
function getExecutionInfo(status: string, hasExecution: boolean): { buttons: string; status: string; badgeClass: string } {
    switch (status) {
        case 'approved':
            if (hasExecution) {
                // Execution started - controls are on individual workflows
                return {
                    buttons: '',
                    status: '',  // No status badge needed - workflows show their status
                    badgeClass: ''
                };
            }
            // Ready to start
            return {
                buttons: `<button class="sub-item-btn primary" data-action="startExecution">Start</button>`,
                status: '',  // No badge - plan status already shows "APPROVED"
                badgeClass: ''
            };
        case 'completed':
            return {
                buttons: '',
                status: '',  // No badge - plan status already shows "COMPLETED"
                badgeClass: ''
            };
        case 'no_plan':
            return {
                buttons: '',
                status: '',
                badgeClass: ''
            };
        default:
            // Planning phase (planning, revising, reviewing) - no execution controls
            return {
                buttons: '',
                status: '',
                badgeClass: ''
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
 * Render a single workflow item with multiple agents and animated progress background.
 */
function renderWorkflowItem(wf: WorkflowInfo, agents: AgentInfo[]): string {
    const typeInfo = WORKFLOW_TYPE_INFO[wf.type] || {
        icon: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>',
        class: '',
        label: wf.type
    };
    
    // Use taskId as label for task workflows
    const label = wf.type === 'task_implementation' && wf.taskId 
        ? wf.taskId 
        : typeInfo.label;
    
    // Build agent badges for all agents working on this workflow
    const agentBadges = agents.length > 0 
        ? `<div class="workflow-agents">${agents.map(a => 
            `<span class="workflow-agent" style="--agent-color: ${a.roleColor || '#f97316'};">${a.name}</span>`
          ).join('')}</div>`
        : '';
    
    const percentage = Math.round(wf.percentage);
    const isActive = wf.status === 'running';
    
    return `
        <div class="workflow-item ${wf.status}${isActive ? ' active' : ''}" 
             data-action="openWorkflowLog" 
             data-workflow-log="${wf.logPath || ''}" 
             title="Click to view workflow log" 
             style="--progress: ${percentage}%; cursor: pointer;">
            <div class="workflow-progress-bg"></div>
            <div class="workflow-content">
                <div class="workflow-type-icon ${typeInfo.class}">
                    ${typeInfo.icon}
                </div>
                <div class="workflow-info">
                    <span class="workflow-type-label">${label}</span>
                    <span class="workflow-phase">${wf.phase} (${wf.phaseIndex + 1}/${wf.totalPhases})</span>
                </div>
                ${agentBadges}
            </div>
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
        <div class="nested-item level-3 history-item ${wf.status}">
            <div class="nested-icon ${typeInfo.class}" style="opacity: 0.6;">
                ${typeInfo.icon}
            </div>
            <span class="nested-label" style="opacity: 0.7;">${label}</span>
            <span class="workflow-phase" style="font-size: 10px; opacity: 0.7;">${statusIcon} ${wf.phase}</span>
        </div>
    `;
}

/**
 * Find all agents assigned to a specific workflow.
 * Multiple agents can work on a single workflow (e.g., planner + reviewer in revision).
 */
function findAgentsForWorkflow(wf: WorkflowInfo, agents: AgentInfo[]): AgentInfo[] {
    if (!agents || agents.length === 0) return [];
    
    // Map workflow types to roles that could be working on them
    const rolesForType: Record<string, string[]> = {
        'planning_new': ['planner', 'analyst_architect', 'analyst_quality'],
        'planning_revision': ['planner', 'analyst_architect', 'analyst_quality', 'analyst_reviewer'],
        'task_implementation': ['engineer', 'context', 'code_reviewer'],
        'error_resolution': ['engineer']
    };
    
    const matchingRoles = rolesForType[wf.type] || [];
    return agents.filter(a => matchingRoles.includes(a.roleId || ''));
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
            <div class="nested-item level-3 nested-failed">
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
    const hasExecution = !!(session.executionStatus || (session.activeWorkflows && session.activeWorkflows.length > 0));
    const execInfo = getExecutionInfo(session.status, hasExecution);
    const planBadgeClass = getPlanBadgeClass(session.planStatus);
    
    // Determine if session is active (has running workflows)
    const hasRunningWorkflow = session.activeWorkflows?.some(w => w.status === 'running') || false;
    const isRevising = session.status === 'revising' || session.isRevising;
    const activityClass = isRevising ? 'revising' : (hasRunningWorkflow ? 'active' : '');
    
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
            <div class="session-body ${isExpanded ? 'expanded' : ''}">
                
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
                
                <!-- Coordinator sub-item (expandable) -->
                <div class="sub-item expandable coordinator-header" data-coord-toggle="${session.id}">
                    <div class="sub-item-expand">
                        ${ICONS.chevronRight}
                    </div>
                    <div class="sub-item-icon">${ICONS.workflow}</div>
                    <span class="sub-item-label">Execution</span>
                    ${execInfo.status ? `<span class="sub-item-badge ${execInfo.badgeClass}">${execInfo.status}</span>` : ''}
                    <div class="sub-item-spacer"></div>
                    ${getExecutionProgressText(session) ? `<span class="execution-progress-text">${getExecutionProgressText(session)}</span>` : ''}
                    <button class="sub-item-btn deps-btn" data-action="openDependencyMap" title="View task dependency map">
                        ${ICONS.deps}
                    </button>
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
                        ${session.activeWorkflows.map(wf => renderWorkflowItem(wf, findAgentsForWorkflow(wf, session.sessionAgents || []))).join('')}
                    ` : ''}
                    
                    <!-- Workflow History (completed, newest first) - collapsible -->
                    ${session.workflowHistory && session.workflowHistory.length > 0 ? `
                        <div class="nested-item history-header" data-history-toggle="${session.id}">
                            <div class="history-expand">
                                ${ICONS.chevronRight}
                            </div>
                            <div class="nested-icon" style="color: #6b7280;">
                                ${ICONS.list}
                            </div>
                            <span class="nested-label" style="opacity: 0.7;">History (${session.workflowHistory.length})</span>
                        </div>
                        <div class="history-children" data-history-children="${session.id}">
                            ${session.workflowHistory.slice(0, 5).map(wf => renderHistoryItem(wf)).join('')}
                            ${session.workflowHistory.length > 5 ? `<div class="nested-item level-3" style="opacity: 0.5; font-size: 10px;">+ ${session.workflowHistory.length - 5} more</div>` : ''}
                        </div>
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

