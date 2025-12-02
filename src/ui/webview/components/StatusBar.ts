/**
 * Status bar component - shows system dependency status and coordinator activity.
 */
import { ICONS } from '../icons';
import { UnityInfo } from '../types';

/**
 * Render the status bar HTML.
 */
export function renderStatusBar(unityInfo?: UnityInfo, unityEnabled?: boolean): string {
    // Generate Unity compact box HTML
    let unityCompactHtml = '';
    if (unityEnabled && unityInfo) {
        const unityBadgeStyle = getUnityBadgeStyle(unityInfo);
        const currentTaskHtml = unityInfo.currentTask 
            ? `<span class="unity-compact-current">${formatTaskType(unityInfo.currentTask.type)}${unityInfo.currentTask.phase ? ` (${unityInfo.currentTask.phase})` : ''}</span>`
            : '';
        
        unityCompactHtml = `
            <div class="unity-compact-box" id="unityCompactBox">
                <div class="unity-compact-status">
                    <span class="unity-compact-badge" id="unityBadge" style="background: ${unityBadgeStyle.background};">
                        ${unityBadgeStyle.text}
                    </span>
                    <span class="unity-compact-queue" id="unityQueue">
                        ${unityInfo.queueLength} task${unityInfo.queueLength !== 1 ? 's' : ''}
                    </span>
                </div>
                ${currentTaskHtml ? `<div class="unity-compact-task" id="unityCurrentTask">${currentTaskHtml}</div>` : ''}
            </div>
        `;
    }

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
                <div class="coordinator-info" id="coordinatorInfo" title="Click to open latest coordinator log">
                    <span class="status-label">Coordinator</span>
                    <div class="status-value">
                        <div class="coordinator-dot idle" id="coordinatorDot"></div>
                        <span class="coordinator-text" id="coordinatorText">Idle</span>
                    </div>
                </div>
                <div class="actions">
                    <button class="icon-btn" id="refreshBtn" title="Refresh">
                        ${ICONS.refresh}
                    </button>
                    <button class="icon-btn" id="settingsBtn" title="Settings">
                        ${ICONS.settings}
                    </button>
                </div>
            </div>
            ${unityCompactHtml}
            <div class="health-warning" id="healthWarning" style="display: none;"></div>
        </div>
    `;
}

/**
 * Get Unity badge style based on state.
 */
function getUnityBadgeStyle(unity: UnityInfo): { text: string; background: string } {
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
 * Format task type for display.
 */
function formatTaskType(type: string): string {
    const typeMap: Record<string, string> = {
        'prep_editor': 'Compile',
        'test_editmode': 'Test (Edit)',
        'test_playmode': 'Test (Play)',
        'exec_editmode': 'Execute'
    };
    return typeMap[type] || type;
}

