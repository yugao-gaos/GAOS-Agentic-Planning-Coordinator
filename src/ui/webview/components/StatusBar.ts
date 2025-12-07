/**
 * Status bar component - shows system dependency status and coordinator activity.
 * 
 * Two-stage design:
 * 1. Status Title Bar - Always visible with system status and actions
 * 2. Dynamic Context Box - Changes based on state:
 *    - Daemon missing: Reconnect retry status
 *    - Missing deps: Dependency list with install buttons
 *    - Ready: Coordinator + Unity status
 */
import { ICONS } from '../icons';
import { SidebarState, UnityInfo, MissingDependencyInfo, CoordinatorStatusInfo } from '../types';

/**
 * Render the status title bar (always visible).
 * Buttons adapt based on system state.
 */
export function renderStatusBar(unityInfo?: UnityInfo, unityEnabled?: boolean, systemStatus?: string): string {
    // Button visibility logic:
    // - Refresh: Only when daemon is READY to handle requests (not during startup/checking)
    // - Stop: Only when daemon is actually RUNNING
    const canRefresh = systemStatus === 'ready' || systemStatus === 'missing';
    const canStopDaemon = systemStatus === 'ready' || systemStatus === 'missing';
    
    return `
        <div class="status-bar-wrapper">
            <div class="status-bar">
                <div class="status-info" id="statusInfo">
                    <span class="status-label">System</span>
                    <div class="status-value">
                        <div class="status-dot" id="statusDot"></div>
                        <span class="status-text" id="statusText">Checking...</span>
                    </div>
                </div>
                <div class="actions">
                    <button class="icon-btn" id="refreshBtn" title="Refresh Dependencies" ${!canRefresh ? 'style="display: none;"' : ''}>
                        ${ICONS.refresh}
                    </button>
                    <button class="icon-btn danger" id="stopDaemonBtn" title="Stop Daemon" ${!canStopDaemon ? 'style="display: none;"' : ''}>
                        ${ICONS.stop}
                    </button>
                    <button class="icon-btn" id="settingsBtn" title="Settings">
                        ${ICONS.settings}
                    </button>
                </div>
            </div>
            <div class="system-context-box" id="systemContextBox">
                <!-- Dynamic content rendered by JavaScript -->
            </div>
            <div class="health-warning" id="healthWarning" style="display: none;"></div>
        </div>
    `;
}

/**
 * Render the dynamic context box content based on system state.
 * Called from client-side JavaScript after state update.
 */
export function renderSystemContextBox(state: SidebarState): string {
    switch (state.systemStatus) {
        case 'initializing':
            return renderInitializingBox(state.initializationStep);
        case 'connecting':
            return renderConnectingBox();
        case 'checking':
            return renderCheckingBox(state.initializationStep);
        case 'daemon_missing':
            return renderDaemonMissingBox(state.connectionRetries);
        case 'missing':
            return renderMissingDepsBox(state.missingDependencies);
        case 'ready':
            return renderSystemReadyBox(state.coordinatorStatus, state.unity, state.unityEnabled);
        default:
            throw new Error(`Unknown system status: ${state.systemStatus}`);
    }
}

/**
 * Render initializing state (daemon process starting).
 */
function renderInitializingBox(progressStep?: string): string {
    const message = progressStep || 'Starting daemon process...';
    return `
        <div class="context-box context-box-info">
            <div class="context-header">
                <span class="context-icon context-icon-spin">${ICONS.refresh}</span>
                <span class="context-title">Initializing</span>
            </div>
            <div class="context-body">
                <p class="context-text" id="initialization-progress">${escapeHtml(message)}</p>
            </div>
        </div>
    `;
}

/**
 * Render connecting state (client attempting connection).
 */
function renderConnectingBox(): string {
    return `
        <div class="context-box context-box-info">
            <div class="context-header">
                <span class="context-icon context-icon-spin">${ICONS.refresh}</span>
                <span class="context-title">Connecting to Daemon</span>
            </div>
            <div class="context-body">
                <p class="context-text">Establishing connection...</p>
            </div>
        </div>
    `;
}

/**
 * Render checking state (daemon checking dependencies).
 */
function renderCheckingBox(progressStep?: string): string {
    const message = progressStep || 'Waiting for daemon status...';
    return `
        <div class="context-box context-box-info">
            <div class="context-header">
                <span class="context-icon context-icon-spin">${ICONS.refresh}</span>
                <span class="context-title">Checking Dependencies</span>
            </div>
            <div class="context-body">
                <p class="context-text" id="initialization-progress">${escapeHtml(message)}</p>
                <!-- Dependency progress list will be injected here by client-side JS -->
            </div>
        </div>
    `;
}

/**
 * Render daemon missing / disconnected state.
 */
function renderDaemonMissingBox(retryCount: number): string {
    return `
        <div class="context-box context-box-warning">
            <div class="context-header">
                <span class="context-icon">${ICONS.warning}</span>
                <span class="context-title">Daemon Not Connected</span>
            </div>
            <div class="context-body">
                <p class="context-text">
                    ${retryCount > 0 
                        ? `Attempting to reconnect... (${retryCount} ${retryCount === 1 ? 'failure' : 'failures'})`
                        : 'Connection to daemon lost'}
                </p>
                <div class="context-actions">
                    <button class="context-btn" id="retryConnectionBtn">Retry Now</button>
                    <button class="context-btn context-btn-primary" id="startDaemonBtn">Start Daemon</button>
                </div>
            </div>
        </div>
    `;
}

/**
 * Render missing dependencies list with install/login buttons.
 */
function renderMissingDepsBox(missingDeps: MissingDependencyInfo[]): string {
    const depItems = missingDeps.map(dep => {
        // Determine button label based on dependency type and description
        const isAuthIssue = dep.description && 
            (dep.description.includes('Authentication required') || 
             dep.description.includes('Login required') ||
             dep.description.includes('cursor-agent login'));
        
        // Dynamic action button label
        let actionLabel = 'Install';
        if (isAuthIssue) {
            actionLabel = 'Login';
        } else if (dep.installType === 'url') {
            actionLabel = 'Open URL';
        } else if (dep.installType === 'vscode-command') {
            actionLabel = 'Setup';
        } else if (dep.installType === 'retry') {
            actionLabel = 'Retry';
        }
        
        return `
        <div class="dep-item">
            <div class="dep-info">
                <span class="dep-icon">${ICONS.warning}</span>
                <span class="dep-name">${escapeHtml(dep.name)}</span>
            </div>
            <div class="dep-actions">
                <button class="dep-btn dep-btn-secondary" 
                        data-action="details"
                        data-dep-name="${escapeHtml(dep.name)}"
                        data-dep-desc="${escapeHtml(dep.description)}"
                        title="View detailed information">
                    Details
                </button>
                <button class="dep-btn dep-btn-primary" 
                        data-action="install"
                        data-dep-name="${escapeHtml(dep.name)}"
                        data-install-type="${dep.installType || 'url'}"
                        data-install-url="${escapeHtml(dep.installUrl || '')}"
                        data-install-command="${escapeHtml(dep.installCommand || '')}"
                        title="${actionLabel} ${escapeHtml(dep.name)}">
                    ${actionLabel}
                </button>
            </div>
        </div>
    `;
    }).join('');
    
    return `
        <div class="context-box context-box-warning">
            <div class="context-header">
                <span class="context-icon">${ICONS.warning}</span>
                <span class="context-title">Missing Dependencies (${missingDeps.length})</span>
            </div>
            <div class="context-body">
                <div class="deps-list">
                    ${depItems}
                </div>
            </div>
        </div>
    `;
}

/**
 * Render system ready state with coordinator and Unity info.
 */
function renderSystemReadyBox(
    coordinator: CoordinatorStatusInfo, 
    unity: UnityInfo, 
    unityEnabled?: boolean
): string {
    const coordText = getCoordinatorDisplayText(coordinator);
    const coordClass = getCoordinatorStateClass(coordinator.state);
    
    let unityHtml = '';
    if (unityEnabled) {
        const unityBadge = getUnityBadgeStyle(unity);
        unityHtml = `
            <div class="status-boxes-row" style="margin-top: 6px;">
                <div class="status-box">
                    <span class="status-box-label">Unity</span>
                    <span class="unity-badge" style="background: ${unityBadge.background};">${unityBadge.text}</span>
                    ${unity.queueLength > 0 ? `<span class="unity-queue">(${unity.queueLength})</span>` : ''}
                </div>
            </div>
        `;
    }
    
    return `
        <div class="context-box context-box-ready">
            <div class="status-boxes-row">
                <div class="status-box" id="coordinatorInfo">
                    <span class="status-box-label">Coordinator</span>
                    <div class="coordinator-dot ${coordClass}" id="coordinatorDot"></div>
                    <span class="coordinator-text" id="coordinatorText">${coordText}</span>
                    <div class="coordinator-actions">
                        <button class="coord-icon-btn" id="globalDepsBtn" title="Global Task Dependencies">🌐</button>
                        <button class="coord-icon-btn" id="coordLogBtn" title="View Coordinator Log">📋</button>
                    </div>
                </div>
            </div>
            ${unityHtml}
        </div>
    `;
}

/**
 * Get coordinator status display text.
 */
function getCoordinatorDisplayText(status: CoordinatorStatusInfo): string {
    switch (status.state) {
        case 'idle':
            return 'Idle';
        case 'queuing':
            return `Queuing (${status.pendingEvents})`;
        case 'evaluating':
            return 'Evaluating...';
        case 'cooldown':
            return 'Cooldown';
        default:
            return 'Idle';
    }
}

/**
 * Get CSS class for coordinator state.
 */
function getCoordinatorStateClass(state: string): string {
    switch (state) {
        case 'idle':
            return 'idle';
        case 'queuing':
            return 'queuing';
        case 'evaluating':
            return 'evaluating';
        case 'cooldown':
            return 'cooldown';
        default:
            return 'idle';
    }
}

/**
 * Get Unity badge style based on state.
 */
function getUnityBadgeStyle(unity: UnityInfo): { text: string; background: string } {
    if (!unity.connected) {
        return { text: 'Offline', background: 'rgba(107, 114, 128, 0.3)' };
    }
    if (unity.isCompiling) {
        return { text: 'Compiling', background: 'rgba(0, 122, 204, 0.3)' };
    }
    if (unity.currentTask) {
        const taskType = unity.currentTask.type;
        if (taskType === 'test_editmode' || taskType === 'test_playmode') {
            return { text: 'Testing', background: 'rgba(234, 179, 8, 0.3)' };
        }
        if (taskType === 'prep_editor') {
            return { text: 'Compiling', background: 'rgba(0, 122, 204, 0.3)' };
        }
        return { text: 'Running', background: 'rgba(115, 201, 145, 0.3)' };
    }
    if (unity.isPlaying) {
        return { text: 'Playing', background: 'rgba(115, 201, 145, 0.3)' };
    }
    return { text: 'Idle', background: 'rgba(107, 114, 128, 0.3)' };
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
