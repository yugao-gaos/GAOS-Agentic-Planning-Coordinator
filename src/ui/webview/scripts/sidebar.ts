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
        
        // Cooldown state for buttons (prevents double-clicks)
        let lastNewSessionClick = 0;
        const COOLDOWN_MS = 500; // 500ms cooldown after click

        // Element references
        const statusDot = document.getElementById('statusDot');
        const statusText = document.getElementById('statusText');
        const statusInfo = document.getElementById('statusInfo');
        const systemContextBox = document.getElementById('systemContextBox');
        const sessionsContent = document.getElementById('sessionsContent');
        const agentGrid = document.getElementById('agentGrid');
        const agentBadge = document.getElementById('agentBadge');

        // Button handlers
        document.getElementById('refreshBtn').onclick = () => vscode.postMessage({ type: 'refresh' });
        document.getElementById('stopDaemonBtn').onclick = () => {
            vscode.postMessage({ type: 'stopDaemon' });
        };
        document.getElementById('settingsBtn').onclick = () => vscode.postMessage({ type: 'settings' });
        
        const newSessionBtn = document.getElementById('newSessionBtn');
        newSessionBtn.onclick = () => {
            // Only trigger if not disabled
            if (!newSessionBtn.disabled && !newSessionBtn.classList.contains('disabled')) {
                // Cooldown: First click executes immediately, subsequent clicks ignored
                const now = Date.now();
                if (now - lastNewSessionClick < COOLDOWN_MS) {
                    console.log('Button on cooldown, ignoring rapid click');
                    return;
                }
                lastNewSessionClick = now; // Record first click time
                
                console.log('New session button clicked - opening agent chat');
                
                // Visual feedback - temporarily disable button during cooldown
                newSessionBtn.disabled = true;
                newSessionBtn.style.opacity = '0.5';
                setTimeout(() => {
                    newSessionBtn.disabled = false;
                    newSessionBtn.style.opacity = '';
                }, COOLDOWN_MS);
                
                // Execute immediately (not delayed)
                vscode.postMessage({ type: 'newSession' });
            }
        };
        
        const roleSettingsBtn = document.getElementById('roleSettingsBtn');
        if (roleSettingsBtn) {
            roleSettingsBtn.onclick = () => vscode.postMessage({ type: 'openRoleSettings' });
        }
        
        const workflowSettingsBtn = document.getElementById('workflowSettingsBtn');
        if (workflowSettingsBtn) {
            workflowSettingsBtn.onclick = () => vscode.postMessage({ type: 'openWorkflowSettings' });
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
         * Render missing dependencies box (legacy, not used - rendered server-side now)
         */
        function renderMissingDepsBox(missingDeps) {
            const warningIcon = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M7.56 1h.88l6.54 12.26-.44.74H1.44L1 13.26 7.56 1zM8 2.28L2.28 13H13.7L8 2.28zM8.625 12v-1h-1.25v1h1.25zm-1.25-2V6h1.25v4h-1.25z"/></svg>';
            let depItems = '';
            for (let i = 0; i < missingDeps.length; i++) {
                const dep = missingDeps[i];
                
                // Determine button label based on dependency type and description
                const isAuthIssue = dep.description && 
                    (dep.description.includes('Authentication required') || 
                     dep.description.includes('Login required') ||
                     dep.description.includes('cursor-agent login'));
                
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
                
                depItems += '<div class="dep-item">' +
                    '<div class="dep-info">' +
                    '<span class="dep-icon">' + warningIcon + '</span>' +
                    '<span class="dep-name">' + escapeHtml(dep.name) + '</span>' +
                    '</div>' +
                    '<div class="dep-actions">' +
                    '<button class="dep-btn dep-btn-secondary" ' +
                    'data-action="details" ' +
                    'data-dep-name="' + escapeHtml(dep.name) + '" ' +
                    'data-dep-desc="' + escapeHtml(dep.description) + '" ' +
                    'title="View detailed information">' +
                    'Details</button>' +
                    '<button class="dep-btn dep-btn-primary" ' +
                    'data-action="install" ' +
                    'data-dep-name="' + escapeHtml(dep.name) + '" ' +
                    'data-install-type="' + (dep.installType || 'url') + '" ' +
                    'data-install-url="' + escapeHtml(dep.installUrl || '') + '" ' +
                    'data-install-command="' + escapeHtml(dep.installCommand || '') + '" ' +
                    'title="' + actionLabel + ' ' + escapeHtml(dep.name) + '">' +
                    actionLabel + '</button>' +
                    '</div></div>';
            }
            
            return '<div class="context-box context-box-warning">' +
                '<div class="context-header">' +
                '<span class="context-icon">' + warningIcon + '</span>' +
                '<span class="context-title">Missing Dependencies (' + missingDeps.length + ')</span>' +
                '</div>' +
                '<div class="context-body">' +
                '<div class="deps-list">' + depItems + '</div>' +
                '</div></div>';
        }
        
        function renderSystemReadyBox(coordinator, unity, unityEnabled) {
            const coordStatus = coordinator || { state: 'idle', pendingEvents: 0 };
            const coordText = getCoordinatorDisplayText(coordStatus);
            const coordClass = coordStatus.state;
            
            let unityHtml = '';
            if (unityEnabled && unity) {
                const unityBadge = getUnityBadgeStyle(unity);
                const queueText = unity.queueLength > 0 ? '(' + unity.queueLength + ')' : '';
                unityHtml = '<div class="status-boxes-row" style="margin-top: 6px;">' +
                    '<div class="status-box">' +
                    '<span class="status-box-label">Unity</span>' +
                    '<span class="unity-badge" style="background: ' + unityBadge.background + ';">' + unityBadge.text + '</span>' +
                    (queueText ? '<span class="unity-queue">' + queueText + '</span>' : '') +
                    '</div></div>';
            }
            
            return '<div class="context-box context-box-ready">' +
                '<div class="status-boxes-row">' +
                '<div class="status-box" id="coordinatorInfo">' +
                '<span class="status-box-label">Coordinator</span>' +
                '<div class="coordinator-dot ' + coordClass + '" id="coordinatorDot"></div>' +
                '<span class="coordinator-text" id="coordinatorText">' + coordText + '</span>' +
                '<div class="coordinator-actions">' +
                '<button class="coord-icon-btn" id="globalDepsBtn" title="Global Task Dependencies">🌐</button>' +
                '<button class="coord-icon-btn" id="coordLogBtn" title="View Coordinator Log">📋</button>' +
                '</div></div></div>' +
                unityHtml +
                '</div>';
        }
        
        function getUnityBadgeStyle(unity) {
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
         * Attach handlers to context box buttons.
         */
        function attachContextBoxHandlers() {
            // Retry connection button
            const retryBtn = document.getElementById('retryConnectionBtn');
            if (retryBtn) {
                retryBtn.onclick = () => vscode.postMessage({ type: 'retryDaemonConnection' });
            }
            
            // Start daemon button
            const startBtn = document.getElementById('startDaemonBtn');
            if (startBtn) {
                startBtn.onclick = () => vscode.postMessage({ type: 'startDaemon' });
            }
            
            // Coordinator Log button
            const coordLogBtn = document.getElementById('coordLogBtn');
            if (coordLogBtn) {
                coordLogBtn.onclick = () => vscode.postMessage({ type: 'openCoordinatorLog' });
            }
            
            // Global Dependencies button
            const globalDepsBtn = document.getElementById('globalDepsBtn');
            if (globalDepsBtn) {
                globalDepsBtn.onclick = () => vscode.postMessage({ type: 'openGlobalDependencyMap' });
            }
            
            // Install buttons
            // Handle dependency action buttons (Details and Install/Login/etc)
            document.querySelectorAll('.dep-btn').forEach(function(btn) {
                btn.onclick = function() {
                    const action = btn.getAttribute('data-action');
                    const depName = btn.getAttribute('data-dep-name');
                    
                    if (action === 'details') {
                        // Show details popup
                        const depDesc = btn.getAttribute('data-dep-desc');
                        vscode.postMessage({ 
                            type: 'showDepDetails', 
                            depName: depName,
                            depDesc: depDesc
                        });
                    } else if (action === 'install') {
                        // Install/Login action
                        const installType = btn.getAttribute('data-install-type');
                        const installUrl = btn.getAttribute('data-install-url');
                        const installCommand = btn.getAttribute('data-install-command');
                        vscode.postMessage({ 
                            type: 'installDep', 
                            depName: depName,
                            installType: installType,
                            installUrl: installUrl,
                            installCommand: installCommand
                        });
                    }
                };
            });
        }

        /**
         * Check if system is ready for creating new sessions.
         */
        function isSystemReady(systemStatus) {
            return systemStatus === 'ready';
        }

        /**
         * Update the UI with new state.
         */
        function updateState(state) {
            // Status bar title
            statusDot.className = 'status-dot ' + state.systemStatus;
            if (state.systemStatus === 'ready') {
                statusText.textContent = 'Ready';
            } else if (state.systemStatus === 'daemon_missing') {
                statusText.textContent = 'Disconnected';
            } else if (state.systemStatus === 'initializing') {
                statusText.textContent = 'Initializing...';
            } else if (state.systemStatus === 'missing') {
                statusText.textContent = state.missingCount + ' Missing';
            } else {
                statusText.textContent = 'Checking...';
            }
            
            // Update button visibility based on daemon readiness
            // Refresh: Only when daemon is fully ready to handle requests
            // Stop: Only when daemon is actually running
            const refreshBtn = document.getElementById('refreshBtn');
            const stopDaemonBtn = document.getElementById('stopDaemonBtn');
            const canRefresh = state.systemStatus === 'ready' || state.systemStatus === 'missing';
            const canStopDaemon = state.systemStatus === 'ready' || state.systemStatus === 'missing';
            
            if (refreshBtn) {
                refreshBtn.style.display = canRefresh ? '' : 'none';
            }
            if (stopDaemonBtn) {
                stopDaemonBtn.style.display = canStopDaemon ? '' : 'none';
            }
            
            // Update new session button disabled state based on system status
            const newSessionBtn = document.getElementById('newSessionBtn');
            if (newSessionBtn) {
                const systemReady = isSystemReady(state.systemStatus);
                newSessionBtn.disabled = !systemReady;
                if (systemReady) {
                    newSessionBtn.classList.remove('disabled');
                    newSessionBtn.title = 'New Session';
                } else {
                    newSessionBtn.classList.add('disabled');
                    newSessionBtn.title = 'System not ready - check dependencies';
                }
            }
            
            // Render dynamic context box - use pre-rendered HTML from server
            if (systemContextBox && state.systemContextHtml) {
                systemContextBox.innerHTML = state.systemContextHtml;
                attachContextBoxHandlers();
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
        }

        // Listen for state updates from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'updateState') {
                updateState(message.state);
            } else if (message.type === 'dependencyList') {
                // Received full list of dependencies that will be checked
                initializeDependencyList(message.dependencies);
            } else if (message.type === 'dependencyProgress') {
                // Real-time dependency check progress update
                updateDependencyProgress(message.name, message.status);
            } else if (message.type === 'initializationProgress') {
                // Real-time daemon initialization progress
                updateInitializationProgress(message.step, message.phase);
            }
        });
        
        /**
         * Initialize the dependency list with all items in "pending" state.
         * Called when deps.list event is received from daemon.
         */
        function initializeDependencyList(dependencies) {
            const contextBox = document.getElementById('systemContextBox');
            if (!contextBox) return;
            
            // Only show list if we're in checking or initializing state
            const isChecking = statusText.textContent === 'Checking...' || 
                              statusText.textContent === 'Initializing...';
            if (!isChecking) return;
            
            // Find or create context body
            let contextBody = contextBox.querySelector('.context-body');
            if (!contextBody) return;
            
            // Create progress list container
            let progressList = contextBox.querySelector('.progress-list');
            if (!progressList) {
                progressList = document.createElement('div');
                progressList.className = 'progress-list';
                progressList.style.cssText = 'margin-top: 8px; font-size: 12px; color: var(--vscode-descriptionForeground);';
                contextBody.appendChild(progressList);
            }
            
            // Clear existing items
            progressList.innerHTML = '';
            
            // Add all dependencies with "pending" icon
            for (let i = 0; i < dependencies.length; i++) {
                const depName = dependencies[i];
                const progressItem = document.createElement('div');
                progressItem.style.cssText = 'padding: 2px 0; display: flex; align-items: center;';
                progressItem.dataset.depName = depName;
                progressItem.innerHTML = 
                    '<span style="color: var(--vscode-descriptionForeground); margin-right: 6px; font-weight: bold;">○</span>' +
                    '<span>' + escapeHtml(depName) + '</span>';
                progressList.appendChild(progressItem);
            }
        }
        
        /**
         * Update initialization progress in real-time.
         * Shows daemon initialization steps during startup.
         */
        function updateInitializationProgress(step, phase) {
            // Update the progress text in the initialization box
            const progressEl = document.getElementById('initialization-progress');
            if (progressEl) {
                progressEl.textContent = step;
            }
        }
        
        /**
         * Update dependency progress in real-time.
         * Shows individual dependency check results during daemon startup.
         */
        function updateDependencyProgress(name, status) {
            // Update the context box to show progress
            const contextBox = document.getElementById('systemContextBox');
            if (!contextBox) return;
            
            // Find progress list
            let progressList = contextBox.querySelector('.progress-list');
            if (!progressList) return; // Should have been created by initializeDependencyList
            
            // Find existing item by data-dep-name attribute
            const existingItem = progressList.querySelector('[data-dep-name="' + name + '"]');
            
            if (existingItem) {
                // Update existing item
                const icon = status.installed ? '✓' : '✗';
                const color = status.installed ? 'var(--vscode-testing-iconPassed)' : 'var(--vscode-testing-iconFailed)';
                const version = status.version ? ' ' + status.version : '';
                
                existingItem.innerHTML = 
                    '<span style="color: ' + color + '; margin-right: 6px; font-weight: bold;">' + icon + '</span>' +
                    '<span>' + escapeHtml(name) + version + '</span>';
            } else {
                // Fallback: add new item if not found (shouldn't happen if deps.list was sent first)
                const icon = status.installed ? '✓' : '✗';
                const color = status.installed ? 'var(--vscode-testing-iconPassed)' : 'var(--vscode-testing-iconFailed)';
                const version = status.version ? ' ' + status.version : '';
                
                const progressItem = document.createElement('div');
                progressItem.style.cssText = 'padding: 2px 0; display: flex; align-items: center;';
                progressItem.dataset.depName = name;
                progressItem.innerHTML = 
                    '<span style="color: ' + color + '; margin-right: 6px; font-weight: bold;">' + icon + '</span>' +
                    '<span>' + escapeHtml(name) + version + '</span>';
                progressList.appendChild(progressItem);
            }
        }
    `;
}

