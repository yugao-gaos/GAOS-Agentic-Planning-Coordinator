/**
 * Status bar component - shows system dependency status.
 */
import { ICONS } from '../icons';

/**
 * Render the status bar HTML.
 */
export function renderStatusBar(): string {
    return `
        <div class="status-bar">
            <div class="status-info" id="statusInfo">
                <span class="status-label">System</span>
                <div class="status-value">
                    <div class="status-dot" id="statusDot"></div>
                    <span class="status-text" id="statusText">Checking...</span>
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
    `;
}

