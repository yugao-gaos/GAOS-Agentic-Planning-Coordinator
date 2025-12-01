/**
 * Base CSS styles - resets, variables, and common utilities.
 */
export const baseStyles = `
/* Reset & Base */
* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: var(--vscode-font-family);
    font-size: 12px;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    overflow: hidden;
    height: 100vh;
    display: flex;
    flex-direction: column;
    padding: 8px;
    gap: 8px;
}

/* Common Animations */
@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
}

@keyframes progressPulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.7; }
}

@keyframes workingGlow {
    0%, 100% { opacity: 0.03; }
    50% { opacity: 0.08; }
}

@keyframes borderPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(249, 115, 22, 0); }
    50% { box-shadow: 0 0 8px 0 var(--role-color-glow, rgba(249, 115, 22, 0.3)); }
}

/* Icon Button */
.icon-btn {
    background: transparent;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    opacity: 0.7;
    display: flex;
    align-items: center;
    justify-content: center;
}

.icon-btn:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
}

.icon-btn svg {
    width: 14px;
    height: 14px;
    fill: currentColor;
}

/* Badge */
.badge {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: normal;
}

/* Section Container */
.section {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border);
    border-radius: 6px;
    overflow: hidden;
}

.section.scrollable {
    flex: 1;
}

.section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: var(--vscode-sideBarSectionHeader-background);
    border-bottom: 1px solid var(--vscode-widget-border);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-sideBarSectionHeader-foreground);
    flex-shrink: 0;
}

.section-header-left {
    display: flex;
    align-items: center;
    gap: 8px;
}

.section-header-right {
    display: flex;
    align-items: center;
    gap: 4px;
}

.section-content {
    overflow-y: auto;
    padding: 8px;
    flex: 1;
}

.section-content::-webkit-scrollbar {
    width: 6px;
}

.section-content::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background);
    border-radius: 3px;
}

.section-content::-webkit-scrollbar-thumb:hover {
    background: var(--vscode-scrollbarSlider-hoverBackground);
}

/* Main Content Layout */
.main-content {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

/* Empty State */
.empty-state {
    text-align: center;
    padding: 20px;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
}

.empty-state .icon {
    font-size: 24px;
    margin-bottom: 8px;
    opacity: 0.5;
}

/* Progress Components */
.progress-container {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
}

.progress-bar {
    height: 4px;
    background: var(--vscode-widget-border);
    border-radius: 2px;
    overflow: hidden;
    width: 50px;
    flex-shrink: 0;
}

.progress-fill {
    height: 100%;
    background: #007acc;
    transition: width 0.3s ease;
    border-radius: 2px;
}

.progress-fill.running {
    animation: progressPulse 1.5s ease-in-out infinite;
}

.progress-label {
    font-size: 9px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
}

.progress-percentage {
    font-size: 9px;
    color: var(--vscode-descriptionForeground);
    min-width: 24px;
}
`;

