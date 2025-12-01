/**
 * Sidebar webview client-side JavaScript.
 * This is embedded in the HTML as a script block.
 */

/**
 * Get the sidebar client script.
 * This handles all interactive behavior in the webview.
 */
export function getSidebarScript(): string {
    return `
        const vscode = acquireVsCodeApi();
        let expandedSessions = new Set();

        // Element references
        const statusDot = document.getElementById('statusDot');
        const statusText = document.getElementById('statusText');
        const statusInfo = document.getElementById('statusInfo');
        const sessionsContent = document.getElementById('sessionsContent');
        const agentGrid = document.getElementById('agentGrid');
        const agentBadge = document.getElementById('agentBadge');
        const unityBadge = document.getElementById('unityBadge');
        const unityQueue = document.getElementById('unityQueue');
        const unitySection = document.getElementById('unitySection');

        // Button handlers
        document.getElementById('refreshBtn').onclick = () => vscode.postMessage({ type: 'refresh' });
        document.getElementById('settingsBtn').onclick = () => vscode.postMessage({ type: 'settings' });
        document.getElementById('newSessionBtn').onclick = () => vscode.postMessage({ type: 'newSession' });
        
        const roleSettingsBtn = document.getElementById('roleSettingsBtn');
        if (roleSettingsBtn) {
            roleSettingsBtn.onclick = () => vscode.postMessage({ type: 'openRoleSettings' });
        }
        
        const workflowSettingsBtn = document.getElementById('workflowSettingsBtn');
        if (workflowSettingsBtn) {
            workflowSettingsBtn.onclick = () => vscode.postMessage({ type: 'openWorkflowSettings' });
        }
        
        statusInfo.onclick = () => {
            if (statusDot.classList.contains('missing')) {
                vscode.postMessage({ type: 'showMissing' });
            }
        };

        /**
         * Escape HTML special characters.
         */
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        /**
         * Format elapsed time from ISO date string.
         */
        function formatElapsedTime(startedAt) {
            if (!startedAt) return '';
            const start = new Date(startedAt).getTime();
            const now = Date.now();
            const elapsed = Math.floor((now - start) / 1000);
            
            if (elapsed < 60) {
                return elapsed + 's';
            } else if (elapsed < 3600) {
                const mins = Math.floor(elapsed / 60);
                const secs = elapsed % 60;
                return mins + 'm ' + secs + 's';
            } else {
                const hours = Math.floor(elapsed / 3600);
                const mins = Math.floor((elapsed % 3600) / 60);
                return hours + 'h ' + mins + 'm';
            }
        }

        /**
         * Convert hex color to RGB string.
         */
        function hexToRgb(hex) {
            const result = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
            return result 
                ? parseInt(result[1], 16) + ', ' + parseInt(result[2], 16) + ', ' + parseInt(result[3], 16)
                : '249, 115, 22';
        }

        /**
         * Attach event handlers to session items.
         */
        function attachSessionHandlers() {
            // Session expand/collapse handlers
            sessionsContent.querySelectorAll('.session-header[data-toggle]').forEach(header => {
                header.onclick = (e) => {
                    // Don't toggle if clicking the remove button
                    if (e.target.closest('.session-remove-btn')) return;
                    
                    const sessionId = header.dataset.toggle;
                    const item = header.closest('.session-item');
                    const body = item.querySelector('.session-body');
                    const expand = item.querySelector('.session-expand');
                    
                    if (expandedSessions.has(sessionId)) {
                        expandedSessions.delete(sessionId);
                        item.classList.remove('expanded');
                        body.classList.remove('expanded');
                        expand.classList.remove('expanded');
                    } else {
                        expandedSessions.add(sessionId);
                        item.classList.add('expanded');
                        body.classList.add('expanded');
                        expand.classList.add('expanded');
                    }
                };
            });

            // Action button handlers
            sessionsContent.querySelectorAll('[data-action]').forEach(el => {
                el.onclick = (e) => {
                    e.stopPropagation();
                    const action = el.dataset.action;
                    const item = el.closest('.session-item');
                    const sessionId = item.dataset.sessionId;
                    
                    if (action === 'openPlan') {
                        const planPath = item.dataset.planPath;
                        if (planPath) {
                            vscode.postMessage({ type: 'openPlan', planPath });
                        }
                    } else if (action === 'openProgressLog') {
                        // Check for progressPath on element first, then fall back to session's progress log
                        const progressPath = el.dataset.progressPath || item.querySelector('.session-body')?.dataset.progressLog;
                        if (progressPath) {
                            vscode.postMessage({ type: 'openProgressLog', progressLogPath: progressPath });
                        }
                    } else if (action === 'showWorkflowAgent') {
                        const agentName = el.dataset.agentName;
                        if (agentName) {
                            vscode.postMessage({ type: 'showAgentTerminal', agentName });
                        }
                    } else if (action === 'retryTask') {
                        const taskId = el.dataset.taskId;
                        if (taskId) {
                            vscode.postMessage({ type: 'retryTask', sessionId, taskId });
                        }
                    } else {
                        vscode.postMessage({ type: action, sessionId });
                    }
                };
            });
            
            // Coordinator expand/collapse handlers
            sessionsContent.querySelectorAll('.coordinator-header[data-coord-toggle]').forEach(header => {
                header.onclick = (e) => {
                    // Don't toggle if clicking action buttons
                    if (e.target.closest('.sub-item-btn')) return;
                    
                    const coordId = header.dataset.coordToggle;
                    const children = document.querySelector('[data-coord-children="' + coordId + '"]');
                    
                    if (header.classList.contains('expanded')) {
                        header.classList.remove('expanded');
                        if (children) children.classList.remove('expanded');
                    } else {
                        header.classList.add('expanded');
                        if (children) children.classList.add('expanded');
                    }
                };
            });
        }

        /**
         * Attach event handlers to agent cards.
         */
        function attachAgentHandlers() {
            const grid = document.getElementById('agentGrid');
            if (!grid) return;
            
            // Click on busy agent card to open terminal
            grid.querySelectorAll('.agent-card.busy').forEach(card => {
                card.style.cursor = 'pointer';
                card.onclick = (e) => {
                    // Don't open terminal if clicking stop button
                    if (e.target.closest('.agent-stop-btn')) return;
                    vscode.postMessage({ type: 'showAgentTerminal', agentName: card.dataset.agent });
                };
            });
            
            // Stop button handler
            grid.querySelectorAll('.agent-stop-btn').forEach(btn => {
                btn.onclick = (e) => {
                    e.stopPropagation();
                    vscode.postMessage({ type: 'releaseAgent', agentName: btn.dataset.agent });
                };
            });
        }

        /**
         * Update the UI with new state.
         */
        function updateState(state) {
            // Status bar
            statusDot.className = 'status-dot ' + state.systemStatus;
            if (state.systemStatus === 'ready') {
                statusText.textContent = 'Ready';
                statusInfo.style.cursor = 'default';
            } else if (state.systemStatus === 'daemon_missing') {
                statusText.textContent = 'Daemon Missing';
                statusInfo.style.cursor = 'pointer';
            } else if (state.systemStatus === 'missing') {
                statusText.textContent = state.missingCount + ' Missing';
                statusInfo.style.cursor = 'pointer';
            } else {
                statusText.textContent = 'Checking...';
                statusInfo.style.cursor = 'default';
            }

            // Sessions - use pre-rendered HTML from server
            if (state.sessionsHtml) {
                sessionsContent.innerHTML = state.sessionsHtml;
                attachSessionHandlers();
            }

            // Agents - use pre-rendered HTML from server
            if (state.agentsHtml) {
                const agentsContent = document.getElementById('agentsContent');
                if (agentsContent) {
                    agentsContent.innerHTML = state.agentsHtml;
                }
            }
            agentBadge.textContent = state.agentBadgeText || '0/0';
            attachAgentHandlers();

            // Unity section
            if (!state.unityEnabled) {
                unitySection.style.display = 'none';
            } else {
                unitySection.style.display = 'block';
                
                if (state.unity) {
                    unityBadge.textContent = state.unityBadgeText || 'Not Running';
                    unityBadge.style.background = state.unityBadgeBackground || 'rgba(107, 114, 128, 0.3)';
                    
                    if (unityQueue) {
                        unityQueue.textContent = state.unity.queueLength + ' task' + (state.unity.queueLength !== 1 ? 's' : '');
                        unityQueue.className = 'unity-value' + (state.unity.queueLength > 0 ? ' warning' : '');
                    }
                }
            }
        }

        // Listen for state updates from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'updateState') {
                updateState(message.state);
            }
        });
    `;
}

