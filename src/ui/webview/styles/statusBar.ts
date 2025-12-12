/**
 * Status bar component styles.
 */
export const statusBarStyles = `
/* Status Bar */
.status-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border);
    border-radius: 6px;
    flex-shrink: 0;
    gap: 12px;
}

.status-info, .coordinator-info {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
}

.status-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
}

.status-value {
    display: flex;
    align-items: center;
    gap: 6px;
}

.status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
}

.status-dot.ready {
    background: var(--vscode-testing-iconPassed, #73c991);
}

.status-dot.missing {
    background: var(--vscode-list-warningForeground, #cca700);
}

.status-dot.daemon_missing {
    background: var(--vscode-testing-iconFailed, #f14c4c);
    animation: pulse 2s infinite;
}

.status-dot.checking {
    background: var(--vscode-foreground);
    animation: pulse 1s infinite;
}

.status-dot.initializing {
    background: var(--vscode-charts-blue, #4d9de0);
    animation: pulse 1.5s infinite;
}

.status-text {
    font-weight: 500;
}

/* Coordinator status dot */
.coordinator-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
}

.coordinator-dot.idle {
    background: var(--vscode-descriptionForeground, #6b7280);
}

.coordinator-dot.queuing {
    background: var(--vscode-list-warningForeground, #cca700);
    animation: coordinator-pulse-subtle 2s infinite;
    box-shadow: 0 0 4px rgba(204, 167, 0, 0.4);
}

.coordinator-dot.evaluating {
    background: var(--vscode-charts-purple, #a855f7);
    animation: coordinator-pulse-active 1s infinite;
    box-shadow: 0 0 6px rgba(168, 85, 247, 0.6);
}

.coordinator-dot.cooldown {
    background: var(--vscode-charts-orange, #f97316);
    animation: coordinator-pulse-slow 3s infinite;
    box-shadow: 0 0 4px rgba(249, 115, 22, 0.4);
}

.coordinator-text {
    font-weight: 500;
    font-size: 12px;
}

/* Unity status dot - matches coordinator style */
.unity-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
}

.unity-dot.idle {
    background: var(--vscode-descriptionForeground, #6b7280);
}

.unity-dot.offline {
    background: var(--vscode-testing-iconFailed, #f14c4c);
}

.unity-dot.compiling {
    background: var(--vscode-charts-blue, #4d9de0);
    animation: unity-pulse-compiling 1s infinite;
    box-shadow: 0 0 6px rgba(77, 157, 224, 0.6);
}

.unity-dot.testing {
    background: var(--vscode-list-warningForeground, #cca700);
    animation: unity-pulse-testing 1.5s infinite;
    box-shadow: 0 0 4px rgba(204, 167, 0, 0.4);
}

.unity-dot.playing {
    background: var(--vscode-testing-iconPassed, #73c991);
    animation: unity-pulse-playing 2s infinite;
    box-shadow: 0 0 4px rgba(115, 201, 145, 0.4);
}

.unity-dot.running {
    background: var(--vscode-charts-purple, #a855f7);
    animation: unity-pulse-running 1s infinite;
    box-shadow: 0 0 6px rgba(168, 85, 247, 0.6);
}

.unity-text {
    font-weight: 500;
    font-size: 12px;
}

/* Unity actions container */
.unity-actions {
    display: flex;
    gap: 4px;
    margin-left: auto;
    padding-left: 8px;
}

/* Unity pulse animations */
@keyframes unity-pulse-compiling {
    0%, 100% {
        opacity: 1;
        transform: scale(1);
        box-shadow: 0 0 6px rgba(77, 157, 224, 0.6);
    }
    50% {
        opacity: 0.8;
        transform: scale(1.15);
        box-shadow: 0 0 12px rgba(77, 157, 224, 0.8);
    }
}

@keyframes unity-pulse-testing {
    0%, 100% {
        opacity: 1;
        transform: scale(1);
        box-shadow: 0 0 4px rgba(204, 167, 0, 0.4);
    }
    50% {
        opacity: 0.7;
        transform: scale(1.1);
        box-shadow: 0 0 8px rgba(204, 167, 0, 0.6);
    }
}

@keyframes unity-pulse-playing {
    0%, 100% {
        opacity: 1;
        transform: scale(1);
        box-shadow: 0 0 4px rgba(115, 201, 145, 0.4);
    }
    50% {
        opacity: 0.8;
        transform: scale(1.05);
        box-shadow: 0 0 6px rgba(115, 201, 145, 0.5);
    }
}

@keyframes unity-pulse-running {
    0%, 100% {
        opacity: 1;
        transform: scale(1);
        box-shadow: 0 0 6px rgba(168, 85, 247, 0.6);
    }
    50% {
        opacity: 0.8;
        transform: scale(1.15);
        box-shadow: 0 0 12px rgba(168, 85, 247, 0.8);
    }
}

/* Disabled state for coord-icon-btn */
.coord-icon-btn.disabled {
    opacity: 0.4;
    cursor: not-allowed;
}

.coord-icon-btn.disabled:hover {
    background: transparent;
    border-color: var(--vscode-widget-border);
    opacity: 0.4;
}

/* Coordinator pulse animations */
@keyframes coordinator-pulse-subtle {
    0%, 100% {
        opacity: 1;
        transform: scale(1);
        box-shadow: 0 0 4px rgba(204, 167, 0, 0.4);
    }
    50% {
        opacity: 0.7;
        transform: scale(1.1);
        box-shadow: 0 0 8px rgba(204, 167, 0, 0.6);
    }
}

@keyframes coordinator-pulse-active {
    0%, 100% {
        opacity: 1;
        transform: scale(1);
        box-shadow: 0 0 6px rgba(168, 85, 247, 0.6);
    }
    50% {
        opacity: 0.8;
        transform: scale(1.15);
        box-shadow: 0 0 12px rgba(168, 85, 247, 0.8);
    }
}

@keyframes coordinator-pulse-slow {
    0%, 100% {
        opacity: 1;
        transform: scale(1);
        box-shadow: 0 0 4px rgba(249, 115, 22, 0.4);
    }
    50% {
        opacity: 0.8;
        transform: scale(1.05);
        box-shadow: 0 0 6px rgba(249, 115, 22, 0.5);
    }
}

.actions {
    display: flex;
    gap: 4px;
    margin-left: auto;
}

.icon-btn.danger {
    color: var(--vscode-testing-iconFailed, #f14c4c);
}

.icon-btn.danger:hover {
    background: rgba(239, 68, 68, 0.15);
    color: var(--vscode-testing-iconFailed, #f14c4c);
}

/* Status bar wrapper for health warning and Unity compact box */
.status-bar-wrapper {
    display: flex;
    flex-direction: column;
    gap: 0;
}

/* Unity Compact Box */
.unity-compact-box {
    padding: 6px 12px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border);
    border-top: none;
    border-radius: 0 0 6px 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
}

.unity-compact-status {
    display: flex;
    align-items: center;
    gap: 8px;
}

.unity-compact-badge {
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 500;
    color: var(--vscode-badge-foreground);
}

.unity-compact-queue {
    font-weight: 500;
    color: var(--vscode-foreground);
}

.unity-compact-task {
    display: flex;
    align-items: center;
}

.unity-compact-current {
    color: var(--vscode-charts-blue, #3b82f6);
    font-weight: 600;
    font-size: 11px;
}

/* Health warning banner - base styles */
.health-warning {
    padding: 4px 12px;
    border-top: none;
    border-radius: 0 0 6px 6px;
    font-size: 11px;
    font-weight: 500;
    text-align: center;
    animation: fadeIn 0.3s ease-in;
}

/* Connection unstable - warning state (trying to reconnect) */
.health-warning.connection-unstable {
    background: rgba(239, 68, 68, 0.15);
    border: 1px solid var(--vscode-testing-iconFailed, #f14c4c);
    color: var(--vscode-testing-iconFailed, #f14c4c);
}

/* Daemon stopped - informational state (not an error, just needs restart) */
.health-warning.daemon-stopped {
    background: rgba(100, 116, 139, 0.15);
    border: 1px solid var(--vscode-descriptionForeground, #717780);
    color: var(--vscode-descriptionForeground, #717780);
}

@keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
}

/* ============================================
   System Context Box - Dynamic content area
   ============================================ */

.system-context-box {
    border: 1px solid var(--vscode-widget-border);
    border-top: none;
    border-radius: 0 0 6px 6px;
    overflow: hidden;
}

.context-box {
    padding: 10px 12px;
    background: var(--vscode-editor-background);
}

.context-box-warning {
    background: rgba(204, 167, 0, 0.05);
}

.context-box-info {
    background: rgba(0, 122, 204, 0.05);
}

.context-box-ready {
    background: var(--vscode-editor-background);
    padding: 8px 10px;
}

.context-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
}

.context-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    color: var(--vscode-list-warningForeground, #cca700);
}

.context-icon-spin {
    animation: spin 1s linear infinite;
}

@keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}

.context-title {
    font-weight: 600;
    font-size: 12px;
    color: var(--vscode-foreground);
}

.context-body {
    padding-left: 24px;
}

.context-text {
    margin: 0 0 10px 0;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    line-height: 1.4;
}

.context-actions {
    display: flex;
    gap: 8px;
}

.context-btn {
    padding: 4px 10px;
    border: 1px solid var(--vscode-widget-border);
    border-radius: 4px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    font-size: 11px;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
}

.context-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
}

.context-btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background);
}

.context-btn-primary:hover {
    background: var(--vscode-button-hoverBackground);
}

/* Dependencies List */
.deps-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.dep-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border);
    border-radius: 4px;
}

.dep-info {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
}

.dep-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    color: var(--vscode-list-warningForeground, #cca700);
    flex-shrink: 0;
}

.dep-name {
    font-weight: 600;
    font-size: 12px;
    color: var(--vscode-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.dep-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
}

.dep-btn {
    padding: 5px 12px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    border: 1px solid transparent;
    white-space: nowrap;
}

.dep-btn-secondary {
    background: transparent;
    color: var(--vscode-foreground);
    border-color: var(--vscode-widget-border);
}

.dep-btn-secondary:hover {
    background: var(--vscode-list-hoverBackground);
    border-color: var(--vscode-focusBorder);
}

.dep-btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background);
}

.dep-btn-primary:hover {
    background: var(--vscode-button-hoverBackground);
    border-color: var(--vscode-button-hoverBackground);
}

/* Ready State Info - Horizontal Layout */
.status-boxes-row {
    display: flex;
    gap: 8px;
}

.status-box {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border: 1px solid var(--vscode-widget-border);
    border-radius: 4px;
    background: var(--vscode-editor-background);
    min-width: 0;
}

.status-box.clickable {
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
}

.status-box.clickable:hover {
    background: var(--vscode-list-hoverBackground);
    border-color: var(--vscode-focusBorder);
}

.status-box-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
}

/* Coordinator actions container */
.coordinator-actions {
    display: flex;
    gap: 4px;
    margin-left: auto;
    padding-left: 8px;
}

/* Coordinator icon buttons */
.coord-icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    font-size: 12px;
    background: transparent;
    border: 1px solid var(--vscode-widget-border);
    border-radius: 3px;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
    opacity: 0.7;
}

.coord-icon-btn:hover {
    background: var(--vscode-list-hoverBackground);
    border-color: var(--vscode-focusBorder);
    opacity: 1;
}

/* Legacy ready-info styles for compatibility */
.ready-info {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.ready-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 0;
}

.ready-item.clickable {
    cursor: pointer;
    padding: 4px 8px;
    margin: 0 -8px;
    border-radius: 4px;
    transition: background 0.15s;
}

.ready-item.clickable:hover {
    background: var(--vscode-list-hoverBackground);
}

.ready-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
}

.ready-value {
    display: flex;
    align-items: center;
    gap: 6px;
}

.unity-badge {
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 500;
    color: var(--vscode-badge-foreground);
}

.unity-queue {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
}
`;

