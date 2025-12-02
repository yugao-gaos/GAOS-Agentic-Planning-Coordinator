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
        // Fallback to phase if no workflow info
        workflowLine = agent.currentPhase;
    }
    
    // Session line
    const sessionLine = agent.sessionId ? `Session: ${agent.sessionId}` : '';
    
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
            ${sessionLine ? `<div class="agent-task-line" style="opacity: 0.6; font-size: 10px;">${sessionLine}</div>` : ''}
            <button class="agent-stop-btn" data-agent="${agent.name}">
                ${ICONS.stop}
                Stop
            </button>
        </div>
    `;
}

/**
 * Render a single agent card.
 */
export function renderAgentCard(agent: AgentInfo): string {
    return agent.status === 'available' 
        ? renderAvailableAgent(agent) 
        : renderBusyAgent(agent);
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

