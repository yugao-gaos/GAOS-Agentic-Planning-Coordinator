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
        let expandedCoordinators = new Set();
        let expandedHistories = new Set();

        // Element references
        const statusDot = document.getElementById('statusDot');
        const statusText = document.getElementById('statusText');
        const statusInfo = document.getElementById('statusInfo');
        const coordinatorDot = document.getElementById('coordinatorDot');
        const coordinatorText = document.getElementById('coordinatorText');
        const sessionsContent = document.getElementById('sessionsContent');
        const agentGrid = document.getElementById('agentGrid');
        const agentBadge = document.getElementById('agentBadge');
        const unityBadge = document.getElementById('unityBadge');
        const unityQueue = document.getElementById('unityQueue');
        const unityCompactBox = document.getElementById('unityCompactBox');
        const unityCurrentTask = document.getElementById('unityCurrentTask');

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
        
        // Coordinator info click handler - open latest log
        const coordinatorInfo = document.getElementById('coordinatorInfo');
        if (coordinatorInfo) {
            coordinatorInfo.onclick = () => {
                vscode.postMessage({ type: 'openCoordinatorLog' });
            };
        }

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
         * Reapply expanded state to session items after HTML update.
         * This preserves the user's expand/collapse choices across refreshes.
         */
        function reapplyExpandedState() {
            expandedSessions.forEach(sessionId => {
                const header = sessionsContent.querySelector('.session-header[data-toggle="' + sessionId + '"]');
                if (header) {
                    const item = header.closest('.session-item');
                    const body = item.querySelector('.session-body');
                    const expand = item.querySelector('.session-expand');
                    
                    if (item) item.classList.add('expanded');
                    if (body) body.classList.add('expanded');
                    if (expand) expand.classList.add('expanded');
                }
            });
        }

        /**
         * Reapply expanded state to coordinator/execution foldouts after HTML update.
         * This preserves the user's expand/collapse choices for execution sections.
         */
        function reapplyCoordinatorExpandedState() {
            expandedCoordinators.forEach(coordId => {
                const header = sessionsContent.querySelector('.coordinator-header[data-coord-toggle="' + coordId + '"]');
                if (header) {
                    const children = document.querySelector('[data-coord-children="' + coordId + '"]');
                    header.classList.add('expanded');
                    if (children) children.classList.add('expanded');
                }
            });
        }

        /**
         * Reapply expanded state to history foldouts after HTML update.
         * This preserves the user's expand/collapse choices for history sections.
         */
        function reapplyHistoryExpandedState() {
            expandedHistories.forEach(historyId => {
                const header = sessionsContent.querySelector('.history-header[data-history-toggle="' + historyId + '"]');
                if (header) {
                    const children = document.querySelector('[data-history-children="' + historyId + '"]');
                    header.classList.add('expanded');
                    if (children) children.classList.add('expanded');
                }
            });
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
                        // Always send the message with sessionId so extension can look up plan path if needed
                        vscode.postMessage({ type: 'openPlan', planPath, sessionId });
                    } else if (action === 'openWorkflowLog') {
                        const workflowLog = el.dataset.workflowLog;
                        if (workflowLog) {
                            vscode.postMessage({ type: 'openWorkflowLog', logPath: workflowLog });
                        }
                    } else if (action === 'retryTask') {
                        const taskId = el.dataset.taskId;
                        if (taskId) {
                            vscode.postMessage({ type: 'retryTask', sessionId, taskId });
                        }
                    } else if (action === 'openFullHistory') {
                        const historySessionId = el.dataset.sessionId;
                        if (historySessionId) {
                            vscode.postMessage({ type: 'openFullHistory', sessionId: historySessionId });
                        }
                    } else {
                        vscode.postMessage({ type: action, sessionId });
                    }
                };
            });
            
            // Workflow action button handlers (pause/resume/cancel)
            sessionsContent.querySelectorAll('.workflow-action-btn').forEach(btn => {
                btn.onclick = (e) => {
                    e.stopPropagation();
                    const action = btn.dataset.action;
                    const workflowId = btn.dataset.workflowId;
                    const sessionItem = btn.closest('.session-item');
                    const sessionId = sessionItem ? sessionItem.dataset.sessionId : null;
                    
                    if (action && workflowId && sessionId) {
                        vscode.postMessage({ 
                            type: action, 
                            sessionId: sessionId, 
                            workflowId: workflowId 
                        });
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
                    
                    if (expandedCoordinators.has(coordId)) {
                        expandedCoordinators.delete(coordId);
                        header.classList.remove('expanded');
                        if (children) children.classList.remove('expanded');
                    } else {
                        expandedCoordinators.add(coordId);
                        header.classList.add('expanded');
                        if (children) children.classList.add('expanded');
                    }
                };
            });
            
            // History expand/collapse handlers
            sessionsContent.querySelectorAll('.history-header[data-history-toggle]').forEach(header => {
                header.onclick = (e) => {
                    e.stopPropagation();
                    
                    const historyId = header.dataset.historyToggle;
                    const children = document.querySelector('[data-history-children="' + historyId + '"]');
                    
                    if (expandedHistories.has(historyId)) {
                        expandedHistories.delete(historyId);
                        header.classList.remove('expanded');
                        if (children) children.classList.remove('expanded');
                    } else {
                        expandedHistories.add(historyId);
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
                    vscode.postMessage({ type: 'showAgentTerminal', agentName: card.dataset.agent });
                };
            });
        }

        /**
         * Get coordinator status display text
         */
        function getCoordinatorDisplayText(status) {
            if (!status) return 'Idle';
            
            switch (status.state) {
                case 'idle':
                    return 'Idle';
                case 'queuing':
                    return 'Queuing (' + status.pendingEvents + ')';
                case 'evaluating':
                    return 'Evaluating...';
                case 'cooldown':
                    return 'Cooldown';
                default:
                    return 'Idle';
            }
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
            
            // Coordinator status
            if (coordinatorDot && coordinatorText) {
                const coordStatus = state.coordinatorStatus || { state: 'idle', pendingEvents: 0 };
                coordinatorDot.className = 'coordinator-dot ' + coordStatus.state;
                coordinatorText.textContent = getCoordinatorDisplayText(coordStatus);
            }
            
            // Connection health warning
            const healthWarning = document.getElementById('healthWarning');
            if (healthWarning && state.connectionHealth) {
                if (state.connectionHealth.state === 'unhealthy') {
                    healthWarning.style.display = 'block';
                    healthWarning.textContent = '⚠ Connection unstable (' + state.connectionHealth.consecutiveFailures + ' failures)';
                } else {
                    healthWarning.style.display = 'none';
                }
            }

            // Sessions - use pre-rendered HTML from server
            if (state.sessionsHtml) {
                sessionsContent.innerHTML = state.sessionsHtml;
                // Reapply expanded state to sessions, coordinators, and histories
                reapplyExpandedState();
                reapplyCoordinatorExpandedState();
                reapplyHistoryExpandedState();
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

            // Unity compact box
            if (!state.unityEnabled || !state.unity) {
                if (unityCompactBox) {
                    unityCompactBox.style.display = 'none';
                }
            } else {
                if (unityCompactBox) {
                    unityCompactBox.style.display = 'flex';
                }
                
                if (state.unity && unityBadge) {
                    unityBadge.textContent = state.unityBadgeText || 'Idle';
                    unityBadge.style.background = state.unityBadgeBackground || 'rgba(107, 114, 128, 0.3)';
                    
                    // Apply animation className
                    if (state.unityBadgeClassName) {
                        unityBadge.className = 'unity-compact-badge ' + state.unityBadgeClassName;
                    } else {
                        unityBadge.className = 'unity-compact-badge';
                    }
                }
                
                if (state.unity && unityQueue) {
                    unityQueue.textContent = state.unity.queueLength + ' task' + (state.unity.queueLength !== 1 ? 's' : '');
                    unityQueue.className = 'unity-compact-queue' + (state.unity.queueLength > 0 ? ' warning' : '');
                }
                
                // Update current task if element exists
                if (state.unity && state.unity.currentTask && unityCurrentTask) {
                    const taskType = formatTaskType(state.unity.currentTask.type);
                    const phase = state.unity.currentTask.phase ? ' (' + state.unity.currentTask.phase + ')' : '';
                    unityCurrentTask.innerHTML = '<span class="unity-compact-current">' + taskType + phase + '</span>';
                    unityCurrentTask.style.display = 'flex';
                } else if (unityCurrentTask) {
                    unityCurrentTask.style.display = 'none';
                }
            }
            
            /**
             * Format task type for display.
             */
            function formatTaskType(type) {
                const typeMap = {
                    'prep_editor': 'Compile',
                    'test_editmode': 'Test (Edit)',
                    'test_playmode': 'Test (Play)',
                    'exec_editmode': 'Execute'
                };
                return typeMap[type] || type;
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

