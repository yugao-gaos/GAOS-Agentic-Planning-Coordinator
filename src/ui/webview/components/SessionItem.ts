/**
 * Session item component - renders a single planning session with its sub-items.
 */
import { SessionInfo, WorkflowInfo, AgentInfo } from '../types';
import { ICONS } from '../icons';
import { escapeHtml } from '../helpers';
import { Logger } from '../../../utils/Logger';

const log = Logger.create('Client', 'SessionItem');

/**
 * Workflow type configuration for icons and labels.
 */
const WORKFLOW_TYPE_INFO: Record<string, { icon: string; class: string; label: string; shortLabel: string }> = {
    'planning_new': {
        icon: ICONS.planning,
        class: 'planning',
        label: 'Planning',
        shortLabel: 'planning'
    },
    'planning_revision': {
        icon: ICONS.revision,
        class: 'planning',
        label: 'Revision',
        shortLabel: 'revision'
    },
    'task_implementation': {
        icon: ICONS.task,
        class: 'task',
        label: 'Task',
        shortLabel: 'impl'
    },
    'error_resolution': {
        icon: ICONS.error,
        class: 'error',
        label: 'Error Fix',
        shortLabel: 'error_fix'
    },
    'context_gathering': {
        icon: ICONS.document,
        class: 'context',
        label: 'Context',
        shortLabel: 'context'
    }
};

/**
 * Get plan action buttons based on session status.
 * Note: Revise/Approve buttons are now in the Plan Viewer panel.
 * Sidebar only shows Open button + status-specific actions (Stop, Restart).
 */
function getPlanButtons(status: string, hasPartialPlan?: boolean): string {
    // Planning in progress - show stop button
    if (status === 'planning') {
        return `
            <button class="sub-item-btn" data-action="openPlan" title="Open Plan Viewer">Open</button>
            <button class="sub-item-btn danger" data-action="stopExecution">Stop</button>
        `;
    }
    // Revising in progress - show stop button
    if (status === 'revising') {
        return `
            <button class="sub-item-btn" data-action="openPlan" title="Open Plan Viewer">Open</button>
            <button class="sub-item-btn danger" data-action="stopRevision">Stop</button>
        `;
    }
    // Plan ready for review - show Open button (Revise/Approve are in Plan Viewer)
    if (status === 'reviewing') {
        if (hasPartialPlan) {
            return `
                <button class="sub-item-btn" data-action="openPlan" title="Open Plan Viewer">Open</button>
                <button class="sub-item-btn" data-action="restartPlanning" title="Restart planning from beginning">Restart</button>
            `;
        }
        return `<button class="sub-item-btn primary" data-action="openPlan" title="Open Plan Viewer">Open</button>`;
    }
    // Approved - show Open button (Revise is in Plan Viewer)
    if (status === 'approved') {
        return `<button class="sub-item-btn" data-action="openPlan" title="Open Plan Viewer">Open</button>`;
    }
    // Completed
    if (status === 'completed') {
        return `<button class="sub-item-btn" data-action="openPlan" title="Open Plan Viewer">Open</button>`;
    }
    // Executing
    if (status === 'executing') {
        return `<button class="sub-item-btn" data-action="openPlan" title="Open Plan Viewer">Open</button>`;
    }
    // No plan - show restart button
    if (status === 'no_plan') {
        return `<button class="sub-item-btn primary" data-action="restartPlanning">Restart Planning</button>`;
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
        label: wf.type,
        shortLabel: wf.type
    };
    
    // Build label: "taskId workflow_type" for task workflows, just "workflow_type" otherwise
    // e.g., "T1 impl" or "T2 error_fix" or "Planning"
    const label = wf.taskId 
        ? `${wf.taskId} ${typeInfo.shortLabel}`
        : typeInfo.label;
    
    // Separate busy and benched agents
    const busyAgents = agents.filter(a => a.status === 'busy');
    const benchedAgents = agents.filter(a => a.status === 'allocated');
    
    // Build agent badges for busy agents (colored, actively working)
    const busyBadges = busyAgents.length > 0 
        ? busyAgents.map(a => 
            `<span class="workflow-agent busy" style="--agent-color: ${a.roleColor || '#f97316'};">${a.name}</span>`
          ).join('')
        : '';
    
    // Build agent badges for benched agents (grey, waiting)
    const benchBadges = benchedAgents.length > 0
        ? benchedAgents.map(a =>
            `<span class="workflow-agent benched" title="${a.name} on bench (${a.roleId})">${a.name}</span>`
          ).join('')
        : '';
    
    const agentBadges = (busyBadges || benchBadges)
        ? `<div class="workflow-agents">${busyBadges}${benchBadges}</div>`
        : '';
    
    const percentage = Math.round(wf.percentage);
    const isActive = wf.status === 'running' || wf.status === 'pending';
    
    // Build phase display with waiting indicator if applicable
    let phaseDisplay = `${wf.phase} (${wf.phaseIndex + 1}/${wf.totalPhases})`;
    if (wf.waitingForAgent) {
        const roleLabel = wf.waitingForAgentRole || 'agent';
        phaseDisplay = `⏳ Waiting for ${roleLabel}...`;
    }
    
    // Build workflow control buttons based on status
    const workflowActions = (() => {
        if (wf.status === 'running') {
            return `<button class="workflow-action-btn" data-action="pauseWorkflow" data-workflow-id="${escapeHtml(wf.id)}" title="Pause workflow">⏸</button>`;
        } else if (wf.status === 'paused') {
            return `<button class="workflow-action-btn" data-action="resumeWorkflow" data-workflow-id="${escapeHtml(wf.id)}" title="Resume workflow">▶</button>`;
        } else if (wf.status === 'pending' || wf.status === 'blocked') {
            return `<button class="workflow-action-btn danger" data-action="cancelWorkflow" data-workflow-id="${escapeHtml(wf.id)}" title="Cancel workflow">✕</button>`;
        }
        return '';
    })();
    
    return `
        <div class="workflow-item ${wf.status}${isActive ? ' active' : ''}${wf.waitingForAgent ? ' waiting' : ''}" 
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
                    <span class="workflow-phase">${phaseDisplay}</span>
                </div>
                ${agentBadges}
                ${workflowActions ? `<div class="workflow-actions">${workflowActions}</div>` : ''}
            </div>
        </div>
    `;
}

/**
 * Render a completed workflow history item (simplified view).
 * Note: Summaries are excluded from the preview and only shown in the full history page.
 */
function renderHistoryItem(wf: WorkflowInfo): string {
    const typeInfo = WORKFLOW_TYPE_INFO[wf.type] || {
        icon: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>',
        class: '',
        label: wf.type,
        shortLabel: wf.type
    };
    
    // Build label: "taskId workflow_type" for task workflows, just "workflow_type" otherwise
    const label = wf.taskId 
        ? `${wf.taskId} ${typeInfo.shortLabel}`
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
 * Only matches by explicit workflowId - no fallback to prevent showing same agents on multiple workflows.
 */
function findAgentsForWorkflow(wf: WorkflowInfo, agents: AgentInfo[]): AgentInfo[] {
    if (!agents || agents.length === 0) return [];
    
    // Match only by workflowId - agents must be explicitly assigned to this workflow
    const matches = agents.filter(a => a.workflowId && a.workflowId === wf.id);
    
    // Log warning if workflow is running but no agents matched
    // Skip warning if workflow is waitingForAgent - that's an expected state where
    // the workflow is legitimately running but waiting for an agent to be allocated
    if (matches.length === 0 && wf.status === 'running' && !wf.waitingForAgent) {
        log.warn(`No agents matched for running workflow ${wf.id} (${wf.type}). Available agents:`, 
            agents.map(a => ({ name: a.name, workflowId: a.workflowId, roleId: a.roleId }))
        );
    }
    
    return matches;
}

/**
 * Get execution progress summary for the header badge.
 */
function getExecutionProgressText(session: SessionInfo): string {
    const runningWf = session.activeWorkflows?.find(w => w.status === 'running' || w.status === 'pending');
    
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
    
    const planButtons = getPlanButtons(session.status, session.hasPartialPlan);
    const hasExecution = !!(session.executionStatus || (session.activeWorkflows && session.activeWorkflows.length > 0));
    const execInfo = getExecutionInfo(session.status, hasExecution);
    const planBadgeClass = getPlanBadgeClass(session.planStatus);
    
    // Determine if session is active (has running workflows)
    const hasRunningWorkflow = session.activeWorkflows?.some(w => w.status === 'running' || w.status === 'pending') || false;
    const isRevising = session.status === 'revising' || session.isRevising;
    const activityClass = isRevising ? 'revising' : (hasRunningWorkflow ? 'active' : '');
    
    return `
        <div class="session-item ${isExpanded ? 'expanded' : ''} ${activityClass}" 
             data-session-id="${session.id}" 
             data-plan-path="${session.planPath || ''}"
             data-session-status="${session.status || ''}">
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
                <div class="sub-item" data-action="openPlan"${session.hasPartialPlan && session.interruptReason ? ` title="Plan interrupted: ${escapeHtml(session.interruptReason)}"` : ''}>
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
                
                <!-- Coordinator children (Workflows + Bench + History + Failed Tasks) -->
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
                            <div class="nested-item level-3 history-more-container">
                                <button class="history-more-btn" data-action="openFullHistory" data-session-id="${session.id}" title="View full workflow history">
                                    ${session.workflowHistory.length > 5 
                                        ? `${session.workflowHistory.length - 5} more - View Details` 
                                        : 'View Details'}
                                </button>
                            </div>
                        </div>
                    ` : ''}
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

