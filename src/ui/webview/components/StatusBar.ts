/**
 * Status bar component - shows system dependency status and coordinator activity.
 */
import { ICONS } from '../icons';

/**
 * Render the status bar HTML.
 */
export function renderStatusBar(): string {
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
                <div class="coordinator-info" id="coordinatorInfo">
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
            <div class="health-warning" id="healthWarning" style="display: none;"></div>
        </div>
    `;
}

