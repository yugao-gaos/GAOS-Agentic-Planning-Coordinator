/**
 * Agent card component - renders a single agent in the pool grid.
 */
import { AgentInfo } from '../types';
import { ICONS } from '../icons';
import { hexToRgb } from '../helpers';

/**
 * Render an available agent card.
 */
function renderAvailableAgent(agent: AgentInfo): string {
    const initial = agent.name.charAt(0).toUpperCase();
    
    return `
        <div class="agent-card available" data-agent="${agent.name}">
            <div class="agent-header">
                <div class="agent-icon">${initial}</div>
                <span class="agent-name">${agent.name}</span>
            </div>
            <div class="agent-status-line available">Available</div>
        </div>
    `;
}

/**
 * Render a busy agent card with role and task info.
 * Note: Control buttons removed - use workflow-level controls instead.
 */
function renderBusyAgent(agent: AgentInfo): string {
    const initial = agent.name.charAt(0).toUpperCase();
    const roleColor = agent.roleColor || '#f97316';
    const roleColorRgb = hexToRgb(roleColor);
    
    // Build status line - role name
    const statusLine = agent.roleId || 'Working';
    
    // Build workflow/task line showing what the agent is working on
    let workflowLine = '';
    if (agent.workflowType && agent.taskId) {
        // Task workflow: show "T1 impl"
        workflowLine = `${agent.taskId} ${agent.workflowType}`;
    } else if (agent.workflowType) {
        // Non-task workflow: show type
        workflowLine = agent.workflowType;
    } else if (agent.currentPhase) {
        // Show phase if no workflow info (acceptable display fallback)
        workflowLine = agent.currentPhase;
    }
    
    // Session line with icon instead of "Session:" label
    const sessionLine = agent.sessionId 
        ? `<span class="session-icon">${ICONS.document}</span>${agent.sessionId}` 
        : '';
    
    return `
        <div class="agent-card busy" data-agent="${agent.name}" 
             title="Click to view terminal output"
             style="--role-color: ${roleColor}; --role-color-bg: rgba(${roleColorRgb}, 0.2); --role-color-glow: rgba(${roleColorRgb}, 0.3);">
            <div class="agent-header">
                <div class="agent-icon">${initial}</div>
                <span class="agent-name">${agent.name}</span>
            </div>
            <div class="agent-status-line" style="color: ${roleColor};">${statusLine}</div>
            ${workflowLine ? `<div class="agent-task-line">${workflowLine}</div>` : ''}
            ${sessionLine ? `<div class="agent-task-line agent-session-line">${sessionLine}</div>` : ''}
        </div>
    `;
}

/**
 * Render an allocated (bench) agent card.
 * These agents are assigned to a workflow but waiting for work.
 */
function renderAllocatedAgent(agent: AgentInfo): string {
    const initial = agent.name.charAt(0).toUpperCase();
    const roleColor = agent.roleColor || '#6366f1';  // Indigo for benched
    const roleColorRgb = hexToRgb(roleColor);
    
    // Build status line - role name with "Bench" suffix
    const statusLine = agent.roleId ? `${agent.roleId} (Bench)` : 'On Bench';
    
    // Session line with icon
    const sessionLine = agent.sessionId 
        ? `<span class="session-icon">${ICONS.document}</span>${agent.sessionId}` 
        : '';
    
    return `
        <div class="agent-card allocated" data-agent="${agent.name}" 
             title="Agent on bench - waiting for work"
             style="--role-color: ${roleColor}; --role-color-bg: rgba(${roleColorRgb}, 0.15); --role-color-glow: rgba(${roleColorRgb}, 0.2);">
            <div class="agent-header">
                <div class="agent-icon">${initial}</div>
                <span class="agent-name">${agent.name}</span>
            </div>
            <div class="agent-status-line" style="color: ${roleColor};">${statusLine}</div>
            ${sessionLine ? `<div class="agent-task-line agent-session-line">${sessionLine}</div>` : ''}
        </div>
    `;
}

/**
 * Render a resting agent card.
 * These agents are in cooldown after release (5 seconds).
 */
function renderRestingAgent(agent: AgentInfo): string {
    const initial = agent.name.charAt(0).toUpperCase();
    
    return `
        <div class="agent-card resting" data-agent="${agent.name}" 
             title="Agent resting - cooldown after release">
            <div class="agent-header">
                <div class="agent-icon">${initial}</div>
                <span class="agent-name">${agent.name}</span>
            </div>
            <div class="agent-status-line resting">Resting...</div>
        </div>
    `;
}

/**
 * Render a single agent card.
 */
export function renderAgentCard(agent: AgentInfo): string {
    switch (agent.status) {
        case 'available':
            return renderAvailableAgent(agent);
        case 'allocated':
            return renderAllocatedAgent(agent);
        case 'busy':
            return renderBusyAgent(agent);
        case 'resting':
            return renderRestingAgent(agent);
        default:
            return renderAvailableAgent(agent);
    }
}

/**
 * Render the agent grid.
 */
export function renderAgentGrid(agents: AgentInfo[]): string {
    if (agents.length === 0) {
        return '<div class="empty-state">No agents configured</div>';
    }
    
    return `
        <div class="agent-grid" id="agentGrid">
            ${agents.map(a => renderAgentCard(a)).join('')}
        </div>
    `;
}

/**
 * Get agent pool badge text (available/total).
 */
export function getAgentBadgeText(agents: AgentInfo[]): string {
    const availableCount = agents.filter(a => a.status === 'available').length;
    return `${availableCount}/${agents.length}`;
}

