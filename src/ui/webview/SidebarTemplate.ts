/**
 * Main template composer for sidebar webview.
 * Combines styles, components, and scripts into a complete HTML document.
 */
import { getSidebarStyles } from './styles';
import { getSidebarScript } from './scripts';
import { 
    renderStatusBar, 
    renderSystemContextBox,
    renderSessionsSection,
    renderAgentGrid,
    getAgentBadgeText,
    getUnityBadgeInfo
} from './components';
import { SidebarState } from './types';
import { ICONS } from './icons';

/**
 * Render state data for client-side updates.
 * This extracts pre-computed values that the client script needs.
 */
export interface ClientState extends SidebarState {
    agentBadgeText: string;
    unityBadgeText: string;
    unityBadgeBackground: string;
    unityBadgeClassName?: string;
    systemContextHtml: string;  // Pre-rendered context box HTML
    sessionsHtml?: string;      // Pre-rendered sessions HTML
    agentsHtml?: string;        // Pre-rendered agents HTML
}

/**
 * Build client state with pre-computed values.
 */
export function buildClientState(state: SidebarState): ClientState {
    const unityBadgeInfo = getUnityBadgeInfo(state.unity);
    
    return {
        ...state,
        agentBadgeText: getAgentBadgeText(state.agents),
        unityBadgeText: unityBadgeInfo.text,
        unityBadgeBackground: unityBadgeInfo.background,
        unityBadgeClassName: unityBadgeInfo.className,
        systemContextHtml: renderSystemContextBox(state)
        // Note: sessionsHtml and agentsHtml require expansion state, 
        // so they're not pre-rendered here - client handles them
    };
}

/**
 * Check if system is in a ready state for creating new sessions.
 */
function isSystemReady(systemStatus?: string): boolean {
    return systemStatus === 'ready';
}

/**
 * Generate the complete HTML for the sidebar webview.
 */
export function getSidebarHtml(initialState?: SidebarState, expandedSessionIds?: Set<string>): string {
    // Build initial content
    const sessionsHtml = initialState 
        ? renderSessionsSection(initialState.sessions, expandedSessionIds || new Set())
        : `
            <div class="empty-state">
                <div class="icon">📋</div>
                <div>No planning sessions</div>
                <div style="margin-top: 4px;">Click + to start a new session</div>
            </div>
        `;
    
    const agentsHtml = initialState
        ? renderAgentGrid(initialState.agents)
        : '<div class="agent-grid" id="agentGrid"></div>';
    
    const agentBadgeText = initialState 
        ? getAgentBadgeText(initialState.agents) 
        : '0/0';
    
    // Determine if new session button should be disabled
    const systemReady = isSystemReady(initialState?.systemStatus);
    const newSessionDisabled = !systemReady;
    const newSessionTitle = systemReady 
        ? 'New Session' 
        : 'System not ready - check dependencies';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
${getSidebarStyles()}
    </style>
</head>
<body>
    <!-- Status Bar with Unity Compact Box -->
    ${renderStatusBar(
        initialState?.unity, 
        initialState?.unityEnabled,
        initialState?.systemStatus
    )}

    <div class="main-content">
        <!-- Planning Sessions -->
        <div class="section scrollable" style="flex: 2;">
            <div class="section-header">
                <span>Planning Sessions</span>
                <button class="icon-btn${newSessionDisabled ? ' disabled' : ''}" id="newSessionBtn" title="${newSessionTitle}"${newSessionDisabled ? ' disabled' : ''}>
                    ${ICONS.add}
                </button>
            </div>
            <div class="section-content" id="sessionsContent">
                ${sessionsHtml}
            </div>
        </div>

        <!-- Agent Pool -->
        <div class="section scrollable" style="flex: 1; min-height: 100px;">
            <div class="section-header">
                <span class="section-header-left">
                    <span>Agent Pool</span>
                    <span class="badge" id="agentBadge">${agentBadgeText}</span>
                </span>
                <span class="section-header-right">
                    <button class="icon-btn" id="workflowSettingsBtn" title="Workflow Settings">
                        ${ICONS.workflow}
                    </button>
                    <button class="icon-btn" id="roleSettingsBtn" title="Configure Agent Roles">
                        ${ICONS.person}
                    </button>
                </span>
            </div>
            <div class="section-content" id="agentsContent">
                ${agentsHtml}
            </div>
        </div>
    </div>

    <script>
${getSidebarScript()}
    </script>
</body>
</html>`;
}

