/**
 * Session list and session item styles.
 */
export const sessionStyles = `
/* Session Items (Tree-like) */
.session-item {
    border: 1px solid var(--vscode-widget-border);
    border-radius: 4px;
    margin-bottom: 8px;
    overflow: hidden;
    background: transparent;
    position: relative;
}

.session-item:last-child {
    margin-bottom: 0;
}

.session-item.expanded {
    background: var(--vscode-list-hoverBackground);
}

/* Radio dial spinner for active sessions */
.session-item.active::after {
    content: '';
    position: absolute;
    top: 8px;
    right: 32px;
    width: 12px;
    height: 12px;
    border: 2px solid transparent;
    border-top-color: #007acc;
    border-radius: 50%;
    animation: spin 1s linear infinite;
}

.session-item.revising::after {
    border-top-color: #a855f7;
}

.session-header {
    display: flex;
    align-items: center;
    padding: 6px 8px;
    background: var(--vscode-list-hoverBackground);
    cursor: pointer;
    gap: 6px;
}

.session-item.expanded .session-header {
    background: transparent;
}

.session-header:hover {
    background: var(--vscode-list-activeSelectionBackground);
}

.session-item.expanded .session-header:hover {
    background: rgba(255, 255, 255, 0.05);
}

.session-expand {
    width: 14px;
    height: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.15s;
    flex-shrink: 0;
}

.session-expand.expanded {
    transform: rotate(90deg);
}

.session-expand svg {
    width: 10px;
    height: 10px;
    fill: currentColor;
    opacity: 0.7;
}

.session-status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
}

.session-status-dot.planning { background: #007acc; }
.session-status-dot.pending { background: #cca700; }
.session-status-dot.approved { background: #73c991; }
.session-status-dot.executing { background: #007acc; animation: pulse 1s infinite; }
.session-status-dot.paused { background: #f97316; }
.session-status-dot.completed { background: #73c991; }
.session-status-dot.reviewing { background: #a855f7; }
.session-status-dot.failed { background: #f14c4c; }
.session-status-dot.stopped { background: #6b7280; }
.session-status-dot.cancelled { background: #6b7280; }

.session-title {
    flex: 1;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.session-remove-btn {
    opacity: 0;
    background: transparent;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 2px;
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
}

.session-header:hover .session-remove-btn {
    opacity: 0.5;
}

.session-remove-btn:hover {
    opacity: 1 !important;
    background: rgba(241, 76, 76, 0.2);
    color: #f14c4c;
}

.session-remove-btn svg {
    width: 12px;
    height: 12px;
    fill: currentColor;
}

.session-body {
    display: none;
    border-top: 1px solid var(--vscode-widget-border);
}

.session-body.expanded {
    display: block;
}

/* Sub-items within session */
.sub-item {
    display: flex;
    align-items: center;
    padding: 6px 8px 6px 28px;
    font-size: 11px;
    border-bottom: 1px solid var(--vscode-widget-border);
    gap: 8px;
    cursor: pointer;
}

.sub-item:hover {
    background: var(--vscode-list-hoverBackground);
}

.sub-item:last-child {
    border-bottom: none;
}

.sub-item-icon {
    width: 14px;
    height: 14px;
    opacity: 0.7;
    flex-shrink: 0;
}

.sub-item-icon svg {
    width: 14px;
    height: 14px;
    fill: currentColor;
}

.sub-item-label {
    flex-shrink: 0;
}

.sub-item-badge {
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 3px;
    text-transform: uppercase;
    font-weight: 500;
    flex-shrink: 0;
}

.sub-item-spacer {
    flex: 1;
}

.sub-item-badge.pending { background: rgba(204, 167, 0, 0.2); color: #cca700; }
.sub-item-badge.approved { background: rgba(115, 201, 145, 0.2); color: #73c991; }
.sub-item-badge.draft { background: rgba(107, 114, 128, 0.2); color: #9ca3af; }
.sub-item-badge.running { background: rgba(0, 122, 204, 0.2); color: #007acc; }
.sub-item-badge.paused { background: rgba(249, 115, 22, 0.2); color: #f97316; }
.sub-item-badge.completed { background: rgba(115, 201, 145, 0.2); color: #73c991; }
.sub-item-badge.reviewing { background: rgba(168, 85, 247, 0.2); color: #a855f7; }
.sub-item-badge.revising { 
    background: rgba(168, 85, 247, 0.2); 
    color: #a855f7; 
    animation: badgePulse 1.5s ease-in-out infinite;
}

@keyframes badgePulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.7; transform: scale(1.05); }
}

/* Coordinator expand/collapse */
.sub-item-expand {
    width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.15s ease;
    flex-shrink: 0;
    margin-right: 4px;
}

.sub-item-expand svg {
    width: 10px;
    height: 10px;
    fill: currentColor;
}

.coordinator-header.expanded .sub-item-expand {
    transform: rotate(90deg);
}

.coordinator-children {
    display: none;
    padding-left: 12px;
}

.coordinator-children.expanded {
    display: block;
}

/* Nested items under coordinator */
.nested-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px 6px 32px;
    font-size: 11px;
}

.nested-icon {
    width: 14px;
    height: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
}

.nested-icon svg {
    width: 12px;
    height: 12px;
    fill: currentColor;
    opacity: 0.7;
}

.nested-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.nested-badge {
    font-size: 9px;
    padding: 1px 6px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.05);
}

.nested-agent {
    border-left: 2px solid rgba(255, 255, 255, 0.05);
}

.agent-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
}

.retry-btn {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 4px;
    background: rgba(249, 115, 22, 0.2);
    color: #f97316;
    border: none;
    cursor: pointer;
}

.retry-btn:hover {
    background: rgba(249, 115, 22, 0.3);
}

.nested-failed {
    border-left: 2px solid rgba(241, 76, 76, 0.3);
}

.failed-header {
    margin-top: 4px;
}

/* Sub-item action buttons */
.sub-item-actions {
    display: flex;
    gap: 2px;
    flex-shrink: 0;
}

.sub-item-btn {
    padding: 2px 6px;
    border: 1px solid var(--vscode-widget-border);
    border-radius: 3px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    font-size: 10px;
    cursor: pointer;
}

.sub-item-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
}

.sub-item-btn.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: transparent;
}

.sub-item-btn.primary:hover {
    background: var(--vscode-button-hoverBackground);
}

.sub-item-btn.danger {
    color: #f14c4c;
    border-color: rgba(241, 76, 76, 0.3);
}

.sub-item-btn.danger:hover {
    background: rgba(241, 76, 76, 0.2);
}

/* Spin animation for session activity */
@keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}

/* Responsive improvements for narrow sidebars */
@media (max-width: 280px) {
    .session-header {
        flex-wrap: wrap;
        gap: 4px;
    }
    
    .session-title {
        min-width: 100px;
        font-size: 10px;
    }
    
    .sub-item {
        flex-wrap: wrap;
        gap: 4px;
        padding: 6px 8px 6px 20px;
    }
    
    .sub-item-label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
    }
    
    .sub-item-badge {
        font-size: 8px;
        padding: 1px 4px;
    }
    
    .sub-item-actions {
        width: 100%;
        justify-content: flex-end;
        margin-top: 2px;
    }
    
    .sub-item-btn {
        font-size: 9px;
        padding: 2px 4px;
    }
    
    .workflow-item {
        flex-wrap: wrap;
        gap: 4px;
        padding: 5px 8px 5px 36px;
        margin-left: 24px;
    }
    
    .workflow-info {
        flex-wrap: wrap;
        gap: 2px;
    }
    
    .workflow-phase {
        font-size: 9px;
    }
    
    .workflow-progress {
        width: 100%;
        justify-content: flex-end;
    }
    
    .workflow-progress-bar {
        flex: 1;
        max-width: 80px;
    }
}
`;

