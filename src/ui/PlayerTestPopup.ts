/**
 * PlayerTestPopup - Eye-catching popup for manual player testing workflow.
 * 
 * Two states:
 * 1. Ready: "Start Testing" button - user clicks to begin playtest
 * 2. Testing: "Finished Testing" button - user clicks when done playing
 * 
 * This popup is shown during the test_player_playmode pipeline step.
 */
import * as vscode from 'vscode';

export type PlayerTestState = 'ready' | 'testing' | 'closing';

export interface PlayerTestCallbacks {
    onStartTest: () => void;
    onFinishTest: () => void;
    onCancel: () => void;
}

/**
 * PlayerTestPopup manages the webview panel for interactive player testing.
 */
export class PlayerTestPopup {
    private static instance: PlayerTestPopup | undefined;
    private panel: vscode.WebviewPanel | undefined;
    private state: PlayerTestState = 'ready';
    private callbacks: PlayerTestCallbacks | undefined;
    private startTime: number = 0;
    private timerInterval: NodeJS.Timeout | undefined;

    private constructor() {}

    /**
     * Get or create the singleton instance
     */
    static getInstance(): PlayerTestPopup {
        if (!PlayerTestPopup.instance) {
            PlayerTestPopup.instance = new PlayerTestPopup();
        }
        return PlayerTestPopup.instance;
    }

    /**
     * Show the popup in "Ready" state
     */
    show(extensionUri: vscode.Uri, callbacks: PlayerTestCallbacks): void {
        this.callbacks = callbacks;
        this.state = 'ready';

        if (this.panel) {
            // Panel already exists, just update content and reveal
            this.updateContent();
            this.panel.reveal(vscode.ViewColumn.Two);
            return;
        }

        // Create new panel
        this.panel = vscode.window.createWebviewPanel(
            'playerTestPopup',
            '🎮 Player Test',
            {
                viewColumn: vscode.ViewColumn.Two,
                preserveFocus: false
            },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        // Handle messages from webview
        this.panel.webview.onDidReceiveMessage(message => {
            switch (message.command) {
                case 'startTest':
                    this.handleStartTest();
                    break;
                case 'finishTest':
                    this.handleFinishTest();
                    break;
                case 'cancel':
                    this.handleCancel();
                    break;
            }
        });

        // Handle panel disposal
        this.panel.onDidDispose(() => {
            this.cleanup();
            this.panel = undefined;
            // If testing was in progress, treat as cancel
            if (this.state === 'testing') {
                this.callbacks?.onCancel();
            }
        });

        this.updateContent();
    }

    /**
     * Transition to testing state
     */
    private handleStartTest(): void {
        this.state = 'testing';
        this.startTime = Date.now();
        this.startTimer();
        this.updateContent();
        this.callbacks?.onStartTest();
    }

    /**
     * User finished testing
     */
    private handleFinishTest(): void {
        this.state = 'closing';
        this.stopTimer();
        this.callbacks?.onFinishTest();
        this.close();
    }

    /**
     * User cancelled
     */
    private handleCancel(): void {
        this.state = 'closing';
        this.stopTimer();
        this.callbacks?.onCancel();
        this.close();
    }

    /**
     * Close the popup
     */
    close(): void {
        this.stopTimer();
        if (this.panel) {
            this.panel.dispose();
            this.panel = undefined;
        }
    }

    /**
     * Start elapsed time timer
     */
    private startTimer(): void {
        this.timerInterval = setInterval(() => {
            if (this.panel && this.state === 'testing') {
                this.panel.webview.postMessage({ 
                    command: 'updateTimer', 
                    elapsed: Date.now() - this.startTime 
                });
            }
        }, 1000);
    }

    /**
     * Stop elapsed time timer
     */
    private stopTimer(): void {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = undefined;
        }
    }

    /**
     * Cleanup resources
     */
    private cleanup(): void {
        this.stopTimer();
        this.callbacks = undefined;
    }

    /**
     * Update webview content based on state
     */
    private updateContent(): void {
        if (!this.panel) return;
        this.panel.webview.html = this.getHtml();
    }

    /**
     * Generate HTML content for the webview
     */
    private getHtml(): string {
        const isReady = this.state === 'ready';
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Player Test</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
            background: var(--vscode-editor-background, #1e1e1e);
            color: var(--vscode-foreground, #cccccc);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        
        .container {
            text-align: center;
            max-width: 500px;
            width: 100%;
        }
        
        .icon {
            font-size: 80px;
            margin-bottom: 24px;
            animation: ${isReady ? 'pulse 2s infinite' : 'spin 3s linear infinite'};
        }
        
        @keyframes pulse {
            0%, 100% { transform: scale(1); opacity: 1; }
            50% { transform: scale(1.1); opacity: 0.8; }
        }
        
        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        
        .title {
            font-size: 28px;
            font-weight: 700;
            margin-bottom: 16px;
            color: ${isReady ? 'var(--vscode-charts-green, #73c991)' : 'var(--vscode-charts-blue, #4d9de0)'};
        }
        
        .subtitle {
            font-size: 16px;
            color: var(--vscode-descriptionForeground, #888888);
            margin-bottom: 32px;
            line-height: 1.5;
        }
        
        .timer {
            font-size: 24px;
            font-weight: 600;
            color: var(--vscode-foreground);
            margin-bottom: 32px;
            font-variant-numeric: tabular-nums;
        }
        
        .btn {
            display: inline-block;
            padding: 16px 48px;
            font-size: 18px;
            font-weight: 600;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s ease;
            margin: 8px;
        }
        
        .btn-primary {
            background: ${isReady ? 'var(--vscode-charts-green, #73c991)' : 'var(--vscode-charts-blue, #4d9de0)'};
            color: #000000;
        }
        
        .btn-primary:hover {
            transform: scale(1.05);
            box-shadow: 0 4px 20px ${isReady ? 'rgba(115, 201, 145, 0.4)' : 'rgba(77, 157, 224, 0.4)'};
        }
        
        .btn-secondary {
            background: transparent;
            color: var(--vscode-foreground);
            border: 2px solid var(--vscode-widget-border, #454545);
        }
        
        .btn-secondary:hover {
            background: var(--vscode-list-hoverBackground, #2a2d2e);
        }
        
        .instructions {
            margin-top: 40px;
            padding: 20px;
            background: var(--vscode-editor-inactiveSelectionBackground, #2a2d2e);
            border-radius: 8px;
            text-align: left;
        }
        
        .instructions h3 {
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 12px;
            color: var(--vscode-foreground);
        }
        
        .instructions ol {
            padding-left: 20px;
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
            line-height: 1.8;
        }
        
        .highlight {
            color: var(--vscode-charts-yellow, #cca700);
            font-weight: 600;
        }
    </style>
</head>
<body>
    <div class="container">
        ${isReady ? this.getReadyContent() : this.getTestingContent()}
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        
        function startTest() {
            vscode.postMessage({ command: 'startTest' });
        }
        
        function finishTest() {
            vscode.postMessage({ command: 'finishTest' });
        }
        
        function cancel() {
            vscode.postMessage({ command: 'cancel' });
        }
        
        // Handle timer updates
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'updateTimer') {
                const timerEl = document.getElementById('timer');
                if (timerEl) {
                    timerEl.textContent = formatTime(message.elapsed);
                }
            }
        });
        
        function formatTime(ms) {
            const seconds = Math.floor(ms / 1000);
            const mins = Math.floor(seconds / 60);
            const secs = seconds % 60;
            return mins.toString().padStart(2, '0') + ':' + secs.toString().padStart(2, '0');
        }
    </script>
</body>
</html>`;
    }

    /**
     * Get HTML content for "Ready" state
     */
    private getReadyContent(): string {
        return `
            <div class="icon">🎮</div>
            <h1 class="title">Ready for Player Test</h1>
            <p class="subtitle">
                Click the button below to start playing.<br>
                Unity will enter Play Mode automatically.
            </p>
            <button class="btn btn-primary" onclick="startTest()">
                ▶ Start Testing
            </button>
            <br>
            <button class="btn btn-secondary" onclick="cancel()">
                Cancel
            </button>
            
            <div class="instructions">
                <h3>📋 Instructions</h3>
                <ol>
                    <li>Click <span class="highlight">Start Testing</span> to begin</li>
                    <li>Unity will focus and enter Play Mode</li>
                    <li>Play the game and test functionality</li>
                    <li>When done, return here and click <span class="highlight">Finished Testing</span></li>
                </ol>
            </div>
        `;
    }

    /**
     * Get HTML content for "Testing" state
     */
    private getTestingContent(): string {
        return `
            <div class="icon">🔄</div>
            <h1 class="title">Testing in Progress...</h1>
            <p class="subtitle">
                Play the game and test the functionality.<br>
                Errors are being monitored in the background.
            </p>
            <div class="timer" id="timer">00:00</div>
            <button class="btn btn-primary" onclick="finishTest()">
                ✓ Finished Testing
            </button>
            <br>
            <button class="btn btn-secondary" onclick="cancel()">
                Cancel
            </button>
            
            <div class="instructions">
                <h3>📋 What's happening</h3>
                <ol>
                    <li>Unity is in Play Mode</li>
                    <li>Console errors are being captured</li>
                    <li>Click <span class="highlight">Finished Testing</span> when you're done</li>
                    <li>Play Mode will be stopped automatically</li>
                </ol>
            </div>
        `;
    }
}

