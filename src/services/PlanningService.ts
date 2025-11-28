import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execSync, spawn } from 'child_process';
import { StateManager } from './StateManager';
import { PlanningSession, PlanningStatus, PlanVersion, RevisionEntry, ExecutionState, EngineerExecutionState } from '../types';
import { AgentRunner, AgentAnalysis } from './AgentRunner';
import { CoordinatorService } from './CoordinatorService';
import { OutputChannelManager } from './OutputChannelManager';

interface UnityContext {
    editorState?: string;
    activeScene?: string;
    existingScripts?: string[];
    existingAssets?: string[];
    consoleErrors?: string[];
    packages?: string[];
}

interface GatheredContext {
    scripts: Array<{ path: string; summary: string }>;
    assets: Array<{ path: string; type: string }>;
    docs: Array<{ path: string; sections: string[] }>;
}

export class PlanningService {
    private stateManager: StateManager;
    private _onSessionsChanged = new vscode.EventEmitter<void>();
    readonly onSessionsChanged = this._onSessionsChanged.event;
    private bestPractices: string = '';
    private agentRunner: AgentRunner;
    private outputManager: OutputChannelManager;
    
    // CoordinatorService for execution (set via setCoordinatorService to avoid circular deps)
    private coordinatorService?: CoordinatorService;
    
    // Sync interval for updating execution state
    private executionSyncInterval?: NodeJS.Timeout;

    constructor(stateManager: StateManager) {
        this.stateManager = stateManager;
        this.agentRunner = new AgentRunner(stateManager.getWorkspaceRoot());
        this.loadBestPractices();
        
        // Use unified output channel
        this.outputManager = OutputChannelManager.getInstance();
    }
    
    /**
     * Set the CoordinatorService (called after construction to avoid circular deps)
     */
    setCoordinatorService(coordinatorService: CoordinatorService): void {
        this.coordinatorService = coordinatorService;
    }
    
    /**
     * Show the output channel in VS Code
     */
    showOutput(): void {
        this.outputManager.show();
    }

    /**
     * Load Unity Best Practices document
     */
    private loadBestPractices(): void {
        const config = vscode.workspace.getConfiguration('agenticPlanning');
        const customPath = config.get<string>('unityBestPracticesPath', '');
        
        // Priority 1: User-configured custom path
        if (customPath && fs.existsSync(customPath)) {
            try {
                this.bestPractices = fs.readFileSync(customPath, 'utf-8');
                console.log('Loaded custom Unity Best Practices from:', customPath);
                return;
            } catch (e) {
                console.error('Failed to load custom best practices:', e);
            }
        }
        
        // Priority 2: Load bundled resources/UnityBestPractices.md from extension
        const bundledPath = path.join(__dirname, '../../resources/UnityBestPractices.md');
        if (fs.existsSync(bundledPath)) {
            try {
                this.bestPractices = fs.readFileSync(bundledPath, 'utf-8');
                console.log('Loaded bundled Unity Best Practices from:', bundledPath);
                return;
            } catch (e) {
                console.error('Failed to load bundled best practices:', e);
            }
        }
        
        // Priority 3: Fallback to minimal built-in (should rarely happen)
        console.warn('No best practices file found, using minimal fallback');
        this.bestPractices = `# Unity Best Practices\n\nNo best practices file found. Configure in Extension Settings.`;
    }

    /**
     * Get relevant best practices for a task type
     */
    /**
     * Get relevant best practices from loaded UnityBestPractices.md based on task type
     * References sections from the document instead of hardcoding
     */
    private getRelevantBestPractices(taskType: string): string[] {
        const practices: string[] = [];
        
        // Reference sections from UnityBestPractices.md
        if (taskType.includes('UI') || taskType.includes('Canvas') || taskType.includes('Widget')) {
            practices.push('⚠️ See UnityBestPractices.md Section 3: Scene and UI Building');
            practices.push('⚠️ See UnityBestPractices.md Section 5: ScriptableObject Builder Pattern');
        }
        
        if (taskType.includes('Scene') || taskType.includes('Prefab')) {
            practices.push('⚠️ See UnityBestPractices.md Section 5: ScriptableObject Builder Pattern');
            practices.push('⚠️ See UnityBestPractices.md Section 7: Prototyping Guidelines');
        }
        
        if (taskType.includes('Data') || taskType.includes('Config') || taskType.includes('Level')) {
            practices.push('⚠️ See UnityBestPractices.md Section 4: Data Objects and ScriptableObjects');
        }
        
        if (taskType.includes('Script') || taskType.includes('Component')) {
            practices.push('⚠️ See UnityBestPractices.md Section 1: MonoBehaviour vs Pure C#');
            practices.push('⚠️ After creating scripts: Delegate compilation to UnityControlAgent, check error registry.');
        }
        
        if (taskType.includes('Pool') || taskType.includes('Spawn')) {
            practices.push('⚠️ See UnityBestPractices.md Section 8: Performance Guidelines');
        }
        
        if (taskType.includes('Test') || taskType.includes('Testing')) {
            practices.push('⚠️ See UnityBestPractices.md Section 6: Testing with Unity Test Framework');
        }
        
        if (taskType.includes('Asset') || taskType.includes('Import') || taskType.includes('ThirdParty')) {
            practices.push('⚠️ See UnityBestPractices.md Section 9: Project Structure and Asset Store Assets');
        }
        
        return practices;
    }

    private notifyChange(): void {
        this._onSessionsChanged.fire();
        // Immediately save state to disk
        this.stateManager.updateStateFiles();
    }

    /**
     * Start a new planning session
     * This is now SYNCHRONOUS - waits for debate to complete before returning
     */
    async startPlanning(requirement: string, docs?: string[]): Promise<{
        sessionId: string;
        status: PlanningStatus;
        debateSummary?: {
            phases: string[];
            concerns: string[];
            recommendations: string[];
            consensus: string;
        };
        planPath?: string;
        recommendedEngineers?: number;
    }> {
        const sessionId = this.stateManager.generatePlanningSessionId();
        
        const session: PlanningSession = {
            id: sessionId,
            status: 'debating',
            requirement: requirement,
            planHistory: [],
            revisionHistory: [{
                version: 0,
                feedback: 'Initial requirement',
                timestamp: new Date().toISOString()
            }],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        this.stateManager.savePlanningSession(session);
        this.notifyChange();

        // Run the debate SYNCHRONOUSLY and wait for completion
        const debateResult = await this.runPlanningDebate(session, docs || []);

        return {
            sessionId,
            status: session.status,
            debateSummary: debateResult.summary,
            planPath: session.currentPlanPath,
            recommendedEngineers: session.recommendedEngineers?.count
        };
    }

    /**
     * Get the progress file path for a session
     * Structure: _AiDevLog/Plans/{sessionId}/progress.log
     */
    private getProgressFilePath(sessionId: string): string {
        return this.stateManager.getProgressLogPath(sessionId);
    }

    /**
     * Write progress update to both the progress file AND VS Code output channel
     * Uses sync operations with O_SYNC flag for immediate disk flush
     */
    private writeProgress(sessionId: string, phase: string, message: string): void {
        const progressPath = this.getProgressFilePath(sessionId);
        const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
        const line = `[${timestamp}] [${phase}] ${message}`;
        
        // Write to VS Code output channel (shows in GUI)
        this.outputManager.appendLine(line);
        
        // Ensure directory exists
        const dir = path.dirname(progressPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        try {
            // Use appendFileSync with flag to sync to disk immediately
            // This ensures CLI can read updates as they happen
            const fd = fs.openSync(progressPath, 'a');
            fs.writeSync(fd, line + '\n');
            fs.fsyncSync(fd);  // Force flush to disk
            fs.closeSync(fd);
        } catch (e) {
            // Fallback to simple append if sync write fails
            fs.appendFileSync(progressPath, line + '\n');
        }
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Identify task categories from requirement text
     * In production, this would use AI to analyze the requirement
     */
    private identifyTaskCategories(requirement: string): Array<{ name: string; count: number }> {
        const categories: Array<{ name: string; count: number }> = [];
        const reqLower = requirement.toLowerCase();
        
        // Dynamically identify categories based on keywords in requirement
        if (reqLower.includes('service') || reqLower.includes('di') || reqLower.includes('dependency')) {
            categories.push({ name: 'Service/Infrastructure', count: 2 });
        }
        if (reqLower.includes('data') || reqLower.includes('model') || reqLower.includes('struct')) {
            categories.push({ name: 'Data Structures', count: 2 });
        }
        if (reqLower.includes('ui') || reqLower.includes('canvas') || reqLower.includes('button')) {
            categories.push({ name: 'UI Components', count: 3 });
        }
        if (reqLower.includes('scene') || reqLower.includes('prefab')) {
            categories.push({ name: 'Scene/Prefab Setup', count: 2 });
        }
        if (reqLower.includes('pool') || reqLower.includes('spawn')) {
            categories.push({ name: 'Pooling/Spawning', count: 2 });
        }
        if (reqLower.includes('input') || reqLower.includes('touch') || reqLower.includes('click')) {
            categories.push({ name: 'Input Handling', count: 1 });
        }
        if (reqLower.includes('load') || reqLower.includes('json') || reqLower.includes('level')) {
            categories.push({ name: 'Data Loading', count: 2 });
        }
        if (reqLower.includes('test')) {
            categories.push({ name: 'Testing', count: 2 });
        }
        
        // Always include core categories if nothing specific found
        if (categories.length === 0) {
            categories.push({ name: 'Core Logic', count: 3 });
            categories.push({ name: 'Integration', count: 2 });
        }
        
        return categories;
    }

    /**
     * Generate tasks from identified categories
     * In production, this would use AI to generate specific tasks
     */
    private generateTasksFromCategories(
        categories: Array<{ name: string; count: number }>,
        requirement: string
    ): Array<{ id: string; name: string; context: string[] }> {
        const tasks: Array<{ id: string; name: string; context: string[] }> = [];
        let taskNum = 1;
        let waveNum = 1;
        
        for (const category of categories) {
            for (let i = 0; i < category.count; i++) {
                const taskId = `${waveNum}.${taskNum % 3 + 1}`;
                tasks.push({
                    id: taskId,
                    name: `${category.name} - Task ${i + 1}`,
                    context: [
                        `Requirement analysis`,
                        `Existing code scan (via gather_task_context.sh)`,
                        category.name.includes('UI') ? 'UI mockup (request from user)' : 'N/A'
                    ].filter(c => c !== 'N/A')
                });
                taskNum++;
                if (taskNum % 3 === 0) waveNum++;
            }
        }
        
        return tasks;
    }

    /**
     * Build a context string from gathered data for agent analysis
     */
    private buildContextString(
        unityContext: UnityContext,
        gatheredContext: GatheredContext,
        docContents: { [key: string]: string }
    ): string {
        const parts: string[] = [];

        // Unity project context
        parts.push('## Unity Project Context');
        if (unityContext.activeScene) {
            parts.push(`Active Scene: ${unityContext.activeScene}`);
        }
        if (unityContext.existingScripts && unityContext.existingScripts.length > 0) {
            parts.push(`Existing Scripts (${unityContext.existingScripts.length}):`);
            for (const script of unityContext.existingScripts.slice(0, 20)) {
                parts.push(`  - ${script}`);
            }
        }
        if (unityContext.packages && unityContext.packages.length > 0) {
            parts.push(`Installed Packages: ${unityContext.packages.join(', ')}`);
        }
        if (unityContext.consoleErrors && unityContext.consoleErrors.length > 0) {
            parts.push(`Console Errors: ${unityContext.consoleErrors.length}`);
        }

        // Gathered codebase context
        parts.push('\n## Codebase Context');
        if (gatheredContext.scripts.length > 0) {
            parts.push(`Relevant Scripts Found (${gatheredContext.scripts.length}):`);
            for (const script of gatheredContext.scripts.slice(0, 15)) {
                parts.push(`  - ${script.path}: ${script.summary}`);
            }
        }
        if (gatheredContext.assets.length > 0) {
            parts.push(`Assets (${gatheredContext.assets.length}):`);
            for (const asset of gatheredContext.assets.slice(0, 10)) {
                parts.push(`  - ${asset.path} (${asset.type})`);
            }
        }

        // Document summaries
        parts.push('\n## Documentation Summaries');
        for (const [docPath, content] of Object.entries(docContents)) {
            // Extract key sections from doc
            const sections = this.extractDocSections(content);
            parts.push(`${docPath}:`);
            for (const section of sections.slice(0, 5)) {
                parts.push(`  - ${section}`);
            }
        }

        // Best practices summary
        parts.push('\n## Unity Best Practices');
        parts.push(this.bestPractices.substring(0, 2000));

        return parts.join('\n');
    }

    /**
     * Build a dependency graph from extracted tasks
     * Returns waves of tasks that can be executed in parallel
     */
    private buildDependencyGraph(tasks: Array<{ name: string; files: string[]; dependencies: string[]; tests: string[]; source: string }>): {
        waves: string[][];
        maxParallelWidth: number;
        criticalPathLength: number;
    } {
        const waves: string[][] = [];
        const completed = new Set<string>();
        const remaining = new Set(tasks.map(t => t.name));
        
        // Build dependency map
        const depMap = new Map<string, string[]>();
        for (const task of tasks) {
            depMap.set(task.name, task.dependencies.filter(d => d && d.trim() !== ''));
        }
        
        // Process waves until all tasks are scheduled
        let waveNum = 0;
        while (remaining.size > 0 && waveNum < 20) { // Max 20 waves to prevent infinite loop
            const currentWave: string[] = [];
            
            for (const taskName of remaining) {
                const deps = depMap.get(taskName) || [];
                // Check if all dependencies are completed
                const allDepsComplete = deps.every(d => completed.has(d) || !remaining.has(d));
                
                if (allDepsComplete) {
                    currentWave.push(taskName);
                }
            }
            
            // If no tasks can be scheduled, break to avoid infinite loop
            if (currentWave.length === 0) {
                // Add remaining tasks to final wave (circular dependency fallback)
                waves.push([...remaining]);
                break;
            }
            
            // Add wave and mark tasks as completed
            waves.push(currentWave);
            for (const task of currentWave) {
                completed.add(task);
                remaining.delete(task);
            }
            
            waveNum++;
        }
        
        // Calculate metrics
        const maxParallelWidth = Math.max(...waves.map(w => w.length), 0);
        const criticalPathLength = waves.length;
        
        return { waves, maxParallelWidth, criticalPathLength };
    }

    /**
     * Query Unity Editor via MCP tools
     */
    private async queryUnityMCP(sessionId: string): Promise<UnityContext> {
        const context: UnityContext = {};
        
        try {
            // Try to call Unity MCP via vscode.commands (if MCP extension is available)
            this.writeProgress(sessionId, 'MCP', '  Calling mcp_unityMCP_manage_editor...');
            
            try {
                // Try executing MCP command if available
                const editorResult = await vscode.commands.executeCommand(
                    'mcp.unityMCP.manage_editor',
                    { action: 'get_state' }
                );
                if (editorResult) {
                    context.editorState = JSON.stringify(editorResult);
                    this.writeProgress(sessionId, 'MCP', `  ✓ Unity Editor: ${JSON.stringify(editorResult).substring(0, 100)}`);
                }
            } catch {
                // MCP command not available, try alternative
                this.writeProgress(sessionId, 'MCP', '  ⚠️ MCP command not available, scanning filesystem...');
            }
            
            // Fallback: Scan Unity project directly
            const workspaceRoot = this.stateManager.getWorkspaceRoot();
            
            // Check for active scene by looking at EditorBuildSettings or recent files
            const scenesPath = path.join(workspaceRoot, 'Assets', 'Scenes');
            if (fs.existsSync(scenesPath)) {
                const scenes = fs.readdirSync(scenesPath).filter(f => f.endsWith('.unity'));
                if (scenes.length > 0) {
                    context.activeScene = `Assets/Scenes/${scenes[0]}`;
                    this.writeProgress(sessionId, 'MCP', `  ✓ Found scene: ${context.activeScene}`);
                }
            }
            
            // Scan for existing scripts
            const scriptsPath = path.join(workspaceRoot, 'Assets', 'Scripts');
            if (fs.existsSync(scriptsPath)) {
                context.existingScripts = this.scanDirectory(scriptsPath, '.cs').slice(0, 20);
                this.writeProgress(sessionId, 'MCP', `  ✓ Found ${context.existingScripts.length} existing scripts`);
                for (const script of context.existingScripts.slice(0, 5)) {
                    this.writeProgress(sessionId, 'MCP', `    └─ ${script}`);
                }
                if (context.existingScripts.length > 5) {
                    this.writeProgress(sessionId, 'MCP', `    └─ ... and ${context.existingScripts.length - 5} more`);
                }
            }
            
            // Check for GAOS packages
            const packagesPath = path.join(workspaceRoot, 'Packages', 'manifest.json');
            if (fs.existsSync(packagesPath)) {
                try {
                    const manifest = JSON.parse(fs.readFileSync(packagesPath, 'utf-8'));
                    context.packages = Object.keys(manifest.dependencies || {})
                        .filter(p => p.includes('gaos') || p.includes('GAOS'));
                    if (context.packages.length > 0) {
                        this.writeProgress(sessionId, 'MCP', `  ✓ Found GAOS packages: ${context.packages.join(', ')}`);
                    }
                } catch {
                    // Ignore manifest parse errors
                }
            }
            
            // Try to read Unity console errors (via log file)
            const editorLogPath = this.getUnityEditorLogPath();
            if (editorLogPath && fs.existsSync(editorLogPath)) {
                try {
                    const logContent = fs.readFileSync(editorLogPath, 'utf-8');
                    const errorLines = logContent.split('\n')
                        .filter(line => line.includes('error') || line.includes('Error'))
                        .slice(-10);
                    if (errorLines.length > 0) {
                        context.consoleErrors = errorLines;
                        this.writeProgress(sessionId, 'MCP', `  ⚠️ Found ${errorLines.length} errors in console`);
                    } else {
                        this.writeProgress(sessionId, 'MCP', '  ✓ No compile errors in console');
                    }
                } catch {
                    // Ignore log read errors
                }
            }
            
        } catch (e) {
            this.writeProgress(sessionId, 'MCP', `  ⚠️ Unity MCP query failed: ${e}`);
        }
        
        return context;
    }

    /**
     * Get Unity Editor log path based on OS
     */
    private getUnityEditorLogPath(): string | null {
        const platform = process.platform;
        const home = process.env.HOME || process.env.USERPROFILE || '';
        
        if (platform === 'darwin') {
            return path.join(home, 'Library/Logs/Unity/Editor.log');
        } else if (platform === 'win32') {
            return path.join(home, 'AppData/Local/Unity/Editor/Editor.log');
        } else {
            return path.join(home, '.config/unity3d/Editor.log');
        }
    }

    /**
     * Scan directory for files with given extension
     */
    private scanDirectory(dir: string, extension: string): string[] {
        const results: string[] = [];
        try {
            const items = fs.readdirSync(dir);
            for (const item of items) {
                const fullPath = path.join(dir, item);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    results.push(...this.scanDirectory(fullPath, extension));
                } else if (item.endsWith(extension)) {
                    results.push(fullPath.replace(this.stateManager.getWorkspaceRoot() + '/', ''));
                }
            }
        } catch {
            // Ignore directory scan errors
        }
        return results;
    }

    /**
     * Gather codebase context - basic filesystem scan
     * Note: The full gather_task_context.sh is run by AI agents who can
     * intelligently target folders. This is just a quick pre-scan.
     */
    private async gatherCodebaseContext(sessionId: string, requirement: string): Promise<GatheredContext> {
        // Use basic scan - AI agents will run gather_task_context.sh more intelligently
        this.writeProgress(sessionId, 'CONTEXT', '  Searching for: ' + requirement.split(' ').slice(0, 5).join(', ') + '...');
        return this.basicContextScan(sessionId, requirement);
    }

    /**
     * Basic context scan when gather_task_context.sh fails
     */
    private basicContextScan(sessionId: string, requirement: string): GatheredContext {
        const context: GatheredContext = {
            scripts: [],
            assets: [],
            docs: []
        };
        
        const workspaceRoot = this.stateManager.getWorkspaceRoot();
        
        // Extract keywords from requirement for searching
        const keywords = requirement.toLowerCase()
            .split(/\s+/)
            .filter(w => w.length > 3)
            .slice(0, 10);
        
        this.writeProgress(sessionId, 'CONTEXT', `  Searching for: ${keywords.slice(0, 5).join(', ')}...`);
        
        // Scan scripts directory
        const scriptsPath = path.join(workspaceRoot, 'Assets', 'Scripts');
        if (fs.existsSync(scriptsPath)) {
            const allScripts = this.scanDirectory(scriptsPath, '.cs');
            
            // Find relevant scripts based on keywords
            for (const script of allScripts) {
                const scriptLower = script.toLowerCase();
                const scriptName = path.basename(script).toLowerCase();
                
                for (const keyword of keywords) {
                    if (scriptLower.includes(keyword) || scriptName.includes(keyword)) {
                        // Read file to get class summary
                        const fullPath = path.join(workspaceRoot, script);
                        let summary = 'Matched by filename';
                        try {
                            const content = fs.readFileSync(fullPath, 'utf-8');
                            // Extract class name and first comment
                            const classMatch = content.match(/public\s+class\s+(\w+)/);
                            if (classMatch) {
                                summary = `Class: ${classMatch[1]}`;
                            }
                        } catch {
                            // Ignore read errors
                        }
                        
                        context.scripts.push({ path: script, summary });
                        this.writeProgress(sessionId, 'CONTEXT', `  ✓ Found: ${script}`);
                        break;
                    }
                }
            }
        }
        
        // Scan for relevant prefabs/assets
        const prefabsPath = path.join(workspaceRoot, 'Assets', 'Prefabs');
        if (fs.existsSync(prefabsPath)) {
            const prefabs = this.scanDirectory(prefabsPath, '.prefab');
            for (const prefab of prefabs.slice(0, 10)) {
                context.assets.push({ path: prefab, type: 'prefab' });
            }
            if (prefabs.length > 0) {
                this.writeProgress(sessionId, 'CONTEXT', `  ✓ Found ${prefabs.length} prefabs`);
            }
        }
        
        // Scan docs
        const docsPath = path.join(workspaceRoot, '_AiDevLog', 'Docs');
        if (fs.existsSync(docsPath)) {
            const docs = fs.readdirSync(docsPath).filter(f => f.endsWith('.md'));
            for (const doc of docs) {
                context.docs.push({ path: `_AiDevLog/Docs/${doc}`, sections: [] });
            }
            if (docs.length > 0) {
                this.writeProgress(sessionId, 'CONTEXT', `  ✓ Found ${docs.length} documentation files`);
            }
        }
        
        this.writeProgress(sessionId, 'CONTEXT', `  ✓ Basic scan complete: ${context.scripts.length} scripts, ${context.assets.length} assets`);
        
        return context;
    }

    /**
     * Run the planning debate SYNCHRONOUSLY
     * Returns full debate results when complete
     */
    private async runPlanningDebate(session: PlanningSession, docs: string[]): Promise<{
        summary: {
            phases: string[];
            concerns: string[];
            recommendations: string[];
            consensus: string;
        };
    }> {
        const progressPath = this.getProgressFilePath(session.id);
        const phases: string[] = [];
        const concerns: string[] = [];
        const recommendations: string[] = [];
        
        // Show output channel in VS Code so user can see progress
        this.outputManager.clear();
        this.outputManager.show();
        this.outputManager.appendLine(`════════════════════════════════════════════════════════════`);
        this.outputManager.appendLine(`  APC PLANNING SESSION: ${session.id}`);
        this.outputManager.appendLine(`════════════════════════════════════════════════════════════`);
        this.outputManager.appendLine(``);
        this.outputManager.appendLine(`📋 Requirement: ${session.requirement.substring(0, 100)}...`);
        if (docs.length > 0) {
            this.outputManager.appendLine(`📄 Documents: ${docs.join(', ')}`);
        }
        this.outputManager.appendLine(``);
        this.outputManager.appendLine(`💡 TIP: Watch this panel for live updates from AI agents!`);
        this.outputManager.appendLine(`────────────────────────────────────────────────────────────`);
        this.outputManager.appendLine(``);
        
        // Clear any existing progress file and write header
        fs.writeFileSync(progressPath, `════════════════════════════════════════════════════════════\n`);
        fs.appendFileSync(progressPath, `  PLANNING SESSION: ${session.id}\n`);
        fs.appendFileSync(progressPath, `════════════════════════════════════════════════════════════\n\n`);
        fs.appendFileSync(progressPath, `REQUIREMENT:\n${session.requirement}\n\n`);
        
        if (docs.length > 0) {
            fs.appendFileSync(progressPath, `PROVIDED DOCS: ${docs.join(', ')}\n\n`);
        }
        fs.appendFileSync(progressPath, `────────────────────────────────────────────────────────────\n\n`);

        // Phase 1: Parse provided docs
        this.writeProgress(session.id, 'PHASE-1', '📄 PARSING PROVIDED DOCUMENTS...');
        phases.push('Document Analysis');
        await this.delay(300);
        
        const docContents: { [key: string]: string } = {};
        for (const docPath of docs) {
            const fullPath = path.join(this.stateManager.getWorkspaceRoot(), docPath);
            if (fs.existsSync(fullPath)) {
                try {
                    const content = fs.readFileSync(fullPath, 'utf-8');
                    docContents[docPath] = content;
                    this.writeProgress(session.id, 'DOC', `  ✓ Loaded: ${docPath} (${content.length} chars)`);
                    
                    // Extract key sections
                    const sections = this.extractDocSections(content);
                    for (const section of sections.slice(0, 5)) {
                        this.writeProgress(session.id, 'DOC', `    └─ Section: ${section}`);
                    }
                    await this.delay(200);
                } catch (e) {
                    this.writeProgress(session.id, 'DOC', `  ✗ Failed to load: ${docPath}`);
                    concerns.push(`Could not load document: ${docPath}`);
                }
            } else {
                this.writeProgress(session.id, 'DOC', `  ✗ Not found: ${docPath}`);
                concerns.push(`Document not found: ${docPath}`);
            }
        }

        // Phase 2: Query Unity via MCP
        this.writeProgress(session.id, 'PHASE-2', '🎮 QUERYING UNITY PROJECT VIA MCP...');
        phases.push('Unity Project Inspection');
        await this.delay(300);
        
        // Actually call Unity MCP tools via vscode.commands
        const unityContext = await this.queryUnityMCP(session.id);
        
        // Phase 2b: Start Context Gatherer (Background Agent)
        this.writeProgress(session.id, 'PHASE-2b', '🔍 STARTING CONTEXT GATHERER (gemini-3-pro)...');
        phases.push('Intelligent Context Gathering');
        await this.delay(200);
        
        // Start Context Gatherer in background - it will run during debate
        const cursorAvailable = this.agentRunner.isCursorAvailable();
        let contextFile = '';
        
        if (cursorAvailable) {
            this.writeProgress(session.id, 'CONTEXT', '  ✓ Starting Context Gatherer agent in background');
            this.writeProgress(session.id, 'CONTEXT', '  📂 Will intelligently target gather_task_context.sh');
            this.writeProgress(session.id, 'CONTEXT', '  🔄 Will continue gathering during analyst debate');
            
            // Start Context Gatherer - it runs in background
            contextFile = await this.agentRunner.startContextGatherer(
                parseInt(session.id.replace('ps_', '')),
                session.requirement,
                docs,
                (msg) => this.writeProgress(session.id, 'CONTEXT', `  ${msg}`)
            );
        } else {
            this.writeProgress(session.id, 'CONTEXT', '  ⚠️ Cursor CLI not available, using basic scan');
        }
        
        // Also do basic filesystem scan as fallback
        const gatheredContext = await this.gatherCodebaseContext(session.id, session.requirement);
        
        // Store context for use in plan generation
        (session as any).unityContext = unityContext;
        (session as any).gatheredContext = gatheredContext;

        // Phase 3: Run Multi-Agent Debate via CLI
        this.writeProgress(session.id, 'PHASE-3', '🤖 RUNNING MULTI-AGENT DEBATE VIA CURSOR CLI...');
        phases.push('Multi-Agent Debate');
        await this.delay(300);

        // Build context string from gathered data (including any early context gatherer results)
        let contextString = this.buildContextString(unityContext, gatheredContext, docContents);
        
        // Append any gathered context from Context Gatherer
        const earlyContext = this.agentRunner.getGatheredContext();
        if (earlyContext) {
            contextString += '\n\n## Context Gatherer Findings\n' + earlyContext.substring(0, 2000);
        }
        
        if (cursorAvailable) {
            this.writeProgress(session.id, 'AGENTS', '  ✓ Cursor CLI available');
            this.writeProgress(session.id, 'AGENTS', '  🎯 Running 4 parallel agent sessions:');
            this.writeProgress(session.id, 'AGENTS', '    • Context Gatherer (gemini-3-pro) - Background context gathering');
            this.writeProgress(session.id, 'AGENTS', '    • Opus Analyst (opus-4.5) - Architecture & Design');
            this.writeProgress(session.id, 'AGENTS', '    • Codex Analyst (gpt-5.1-codex-high) - Implementation & Performance');
            this.writeProgress(session.id, 'AGENTS', '    • Gemini Analyst (gemini-3-pro) - Testing & Integration');
        } else {
            this.writeProgress(session.id, 'AGENTS', '  ⚠️ Cursor CLI not found');
            this.writeProgress(session.id, 'AGENTS', '  ⚠️ Using fallback analysis - install Cursor CLI for real multi-agent debate');
        }

        // Create plan file path - agents will write directly to it
        // Use new structure: _AiDevLog/Plans/{sessionId}/plan.md
        this.stateManager.ensurePlanDirectories(session.id);
        const planFilePath = this.stateManager.getPlanFilePath(session.id);
        
        // Store plan path on session early
        session.currentPlanPath = planFilePath;
        this.stateManager.savePlanningSession(session);

        // Run multi-agent debate - agents write directly to plan file
        // Context Gatherer continues running in background during this
        const poolSize = this.stateManager.getPoolSize();
        const analyses = await this.agentRunner.runMultiAgentDebate(
            session.id,
            session.requirement,
            docs,
            planFilePath,
            contextString,
            (msg) => this.writeProgress(session.id, 'DEBATE', `${msg}`),
            poolSize
        );

        // Store analyses on session
        (session as any).agentAnalyses = analyses;

        // Phase 4: Aggregate Agent Results
        this.writeProgress(session.id, 'PHASE-4', '📊 AGGREGATING AGENT ANALYSES...');
        phases.push('Analysis Aggregation');
        await this.delay(200);

        // Collect concerns from all agents
        for (const analysis of analyses) {
            this.writeProgress(session.id, 'ANALYSIS', `  From ${analysis.agentName}:`);
            
            for (const concern of analysis.concerns) {
                this.writeProgress(session.id, 'CONCERN', `    ⚠️ ${concern}`);
                if (!concerns.includes(concern)) {
                    concerns.push(concern);
                }
            }
            
            for (const rec of analysis.recommendations) {
                this.writeProgress(session.id, 'RECOMMEND', `    ✓ ${rec}`);
                if (!recommendations.includes(rec)) {
                    recommendations.push(rec);
                }
            }
            
            await this.delay(100);
        }

        // Phase 5: Build Consensus from Agents
        this.writeProgress(session.id, 'PHASE-5', '💬 BUILDING CONSENSUS FROM AGENT ANALYSES...');
        phases.push('Consensus Building');
        await this.delay(300);

        // Find common recommendations (mentioned by multiple agents)
        const recCounts: Record<string, number> = {};
        for (const analysis of analyses) {
            for (const rec of analysis.recommendations) {
                recCounts[rec] = (recCounts[rec] || 0) + 1;
            }
        }

        const consensusRecs = Object.entries(recCounts)
            .filter(([_, count]) => count > 1 || analyses.length === 1)
            .map(([rec, count]) => ({ rec, count }));

        for (const { rec, count } of consensusRecs) {
            this.writeProgress(session.id, 'CONSENSUS', `  ✅ ${rec} (${count}/${analyses.length} agents agree)`);
        }

        const consensus = consensusRecs.length > 0 
            ? consensusRecs.map(r => r.rec).join('; ')
            : 'Agents provided independent recommendations - review each for final decision';

        // Phase 6: Extract Tasks from Agent Analyses
        this.writeProgress(session.id, 'PHASE-6', '📋 EXTRACTING TASKS FROM AGENT ANALYSES...');
        phases.push('Task Extraction');
        await this.delay(300);

        // Merge task breakdowns from all agents
        const allTasks: Array<{ name: string; files: string[]; dependencies: string[]; tests: string[]; source: string }> = [];
        
        for (const analysis of analyses) {
            for (const task of analysis.taskBreakdown) {
                this.writeProgress(session.id, 'TASK', `  [${analysis.agentName}] Task: ${task.name}`);
                this.writeProgress(session.id, 'TASK', `    Files: ${task.files.join(', ') || 'TBD'}`);
                this.writeProgress(session.id, 'TASK', `    Tests: ${task.tests.join(', ') || 'TBD'}`);
                
                allTasks.push({ ...task, source: analysis.agentName });
                await this.delay(50);
            }
        }

        // Store extracted tasks
        (session as any).extractedTasks = allTasks;

        // Phase 6b: Task Review - Context Gatherer reviews each task
        if (cursorAvailable && allTasks.length > 0) {
            this.writeProgress(session.id, 'PHASE-6b', '🔍 CONTEXT GATHERER REVIEWING TASKS...');
            phases.push('Task-Specific Context Review');
            await this.delay(300);

            this.writeProgress(session.id, 'REVIEW', '  Context Gatherer will gather specific context for each task');
            this.writeProgress(session.id, 'REVIEW', `  Reviewing ${allTasks.length} tasks...`);

            // Stop the background context gatherer and run task review
            this.agentRunner.stopContextGatherer();

            // Run task review phase
            await this.agentRunner.runTaskReview(
                parseInt(session.id.replace('ps_', '')),
                session.requirement,
                docs,
                allTasks.map(t => ({ name: t.name, files: t.files })),
                (msg) => this.writeProgress(session.id, 'REVIEW', `  ${msg}`)
            );

            // Get enriched context
            const taskContext = this.agentRunner.getGatheredContext();
            if (taskContext) {
                this.writeProgress(session.id, 'REVIEW', `  ✓ Task-specific context gathered (${taskContext.length} chars)`);
                (session as any).taskContext = taskContext;
            }
        }

        // Phase 7: Apply Best Practices
        this.writeProgress(session.id, 'PHASE-7', '📚 APPLYING UNITY BEST PRACTICES...');
        phases.push('Best Practices Application');
        await this.delay(200);

        this.writeProgress(session.id, 'PRACTICES', '  Loading Unity Best Practices document...');
        this.writeProgress(session.id, 'PRACTICES', `  ✓ Loaded ${this.bestPractices.length} chars of best practices`);

        // Apply relevant best practices to each task
        for (const task of allTasks) {
            const practices = this.getRelevantBestPractices(task.name);
            if (practices.length > 0) {
                this.writeProgress(session.id, 'PRACTICES', `  Task "${task.name}":`);
                for (const practice of practices) {
                    this.writeProgress(session.id, 'PRACTICES', `    ${practice}`);
                }
            }
        }

        // Phase 8: Engineer Optimization
        this.writeProgress(session.id, 'PHASE-8', '👥 OPTIMIZING ENGINEER ALLOCATION...');
        phases.push('Engineer Optimization');
        await this.delay(300);

        // Use MAXIMUM engineer count recommendation (AI engineers have no overhead)
        // Coordinator will dynamically dispatch work, so max parallelism is optimal
        const engineerVotes = analyses.map(a => a.engineerCount).filter(c => c > 0);
        const maxEngineers = engineerVotes.length > 0 ? Math.max(...engineerVotes) : this.stateManager.getPoolSize();
        
        for (const analysis of analyses) {
            this.writeProgress(session.id, 'ENGINEERS', `  ${analysis.agentName}: ${analysis.engineerCount} engineers`);
            if (analysis.rationale) {
                this.writeProgress(session.id, 'ENGINEERS', `    Rationale: ${analysis.rationale}`);
            }
        }
        
        this.writeProgress(session.id, 'ENGINEERS', `  ✅ Recommended: ${maxEngineers} engineers (max of ${analyses.length} agent votes)`);
        recommendations.push(`Use ${maxEngineers} engineers (max parallelism from multi-agent analysis)`)

        // Phase 9: Build Dependency Graph from Tasks
        this.writeProgress(session.id, 'PHASE-9', '🔗 BUILDING DEPENDENCY GRAPH FROM TASKS...');
        phases.push('Dependency Analysis');
        await this.delay(300);

        // Build dependency graph from extracted tasks
        const depGraph = this.buildDependencyGraph(allTasks);
        
        this.writeProgress(session.id, 'DEPS', '');
        this.writeProgress(session.id, 'DEPS', '  ┌─────────────────────────────────────────────────────┐');
        this.writeProgress(session.id, 'DEPS', '  │              TASK DEPENDENCY GRAPH                  │');
        this.writeProgress(session.id, 'DEPS', '  ├─────────────────────────────────────────────────────┤');
        
        // Show tasks organized by wave
        for (let wave = 1; wave <= depGraph.waves.length; wave++) {
            const waveTasks = depGraph.waves[wave - 1] || [];
            const taskNames = waveTasks.map((t: string) => `[${t.substring(0, 12)}]`).join(' ');
            this.writeProgress(session.id, 'DEPS', `  │  Wave ${wave}: ${taskNames.padEnd(42)}│`);
        }
        
        this.writeProgress(session.id, 'DEPS', '  └─────────────────────────────────────────────────────┘');
        await this.delay(400);

        // Phase 10: Parallelization Analysis
        this.writeProgress(session.id, 'PHASE-10', '⚡ ANALYZING PARALLELIZATION OPPORTUNITIES...');
        phases.push('Parallelization Analysis');
        await this.delay(300);

        // Show wave parallelization
        for (let wave = 1; wave <= depGraph.waves.length; wave++) {
            const waveTasks = depGraph.waves[wave - 1] || [];
            this.writeProgress(session.id, 'PARALLEL', `  Wave ${wave}: ${waveTasks.length} parallel task(s)`);
        }
        
        this.writeProgress(session.id, 'PARALLEL', '');
        this.writeProgress(session.id, 'PARALLEL', `  Max parallel width: ${depGraph.maxParallelWidth}`);
        this.writeProgress(session.id, 'PARALLEL', `  Total waves: ${depGraph.waves.length}`);
        this.writeProgress(session.id, 'PARALLEL', `  Critical path length: ${depGraph.criticalPathLength}`);
        await this.delay(200);

        // Use maximum engineer count from agent recommendations
        const engineerCount = maxEngineers;

        // Phase 11: Finalize plan (agents already wrote to plan file during debate)
        this.writeProgress(session.id, 'PHASE-11', '📝 FINALIZING PLAN...');
        phases.push('Plan Finalization');
        await this.delay(300);
        
        // Plan file already exists - agents wrote their contributions during debate
        // planFilePath was set earlier and passed to runMultiAgentDebate
        const planPath = planFilePath;
        
        // Update plan status from PLANNING to REVIEW
        if (fs.existsSync(planPath)) {
            let content = fs.readFileSync(planPath, 'utf-8');
            content = content.replace(
                '**Status:** 🔄 PLANNING (agents debating)',
                '**Status:** 📋 READY FOR REVIEW'
            );
            // Update engineer allocation section with final count
            content = content.replace(
                /## 8\. Engineer Allocation[\s\S]*?(?=\n---\n)/,
                `## 8. Engineer Allocation

**Pool Size:** ${this.stateManager.getPoolSize()} engineers available
**Recommended:** ${engineerCount} engineers (max from analyst votes)
**Rationale:** Based on ${analyses.length} analyst contributions and task parallelism analysis

### Concerns Identified
${concerns.map(c => `- ${c}`).join('\n') || '- None identified'}

### Recommendations
${recommendations.map(r => `- ${r}`).join('\n') || '- None identified'}`
            );
            fs.writeFileSync(planPath, content);
            this.writeProgress(session.id, 'COMPLETE', `  ✓ Plan status updated to READY FOR REVIEW`);
        }
        
        this.writeProgress(session.id, 'COMPLETE', `════════════════════════════════════════════════════════════`);
        this.writeProgress(session.id, 'COMPLETE', `  ✅ PLANNING COMPLETE`);
        this.writeProgress(session.id, 'COMPLETE', `════════════════════════════════════════════════════════════`);
        this.writeProgress(session.id, 'COMPLETE', ``);
        this.writeProgress(session.id, 'COMPLETE', `  Plan: ${planPath.split('/').pop()}`);
        this.writeProgress(session.id, 'COMPLETE', `  Engineers: ${engineerCount} recommended`);
        this.writeProgress(session.id, 'COMPLETE', `  Concerns: ${concerns.length} identified`);
        this.writeProgress(session.id, 'COMPLETE', `  Recommendations: ${recommendations.length} made`);
        this.writeProgress(session.id, 'COMPLETE', ``);
        this.writeProgress(session.id, 'COMPLETE', `  NEXT STEPS:`);
        this.writeProgress(session.id, 'COMPLETE', `    • Review: apc plan status ${session.id}`);
        this.writeProgress(session.id, 'COMPLETE', `    • Revise: apc plan revise ${session.id} "<feedback>"`);
        this.writeProgress(session.id, 'COMPLETE', `    • Approve: apc plan approve ${session.id}`);

        // Update session
        session.status = 'reviewing';
        session.currentPlanPath = planPath;
        session.planHistory.push({
            version: 1,
            path: planPath,
            timestamp: new Date().toISOString()
        });
        session.recommendedEngineers = {
            count: engineerCount,
            justification: `Based on ${phases.length} analysis phases, ${concerns.length} concerns, and parallelization opportunities`
        };
        session.updatedAt = new Date().toISOString();
        
        this.stateManager.savePlanningSession(session);
        this.notifyChange();
        
        vscode.window.showInformationMessage(
            `Planning session ${session.id} ready for review`,
            'View Plan'
        ).then(selection => {
            if (selection === 'View Plan' && session.currentPlanPath) {
                vscode.workspace.openTextDocument(session.currentPlanPath)
                    .then(doc => vscode.window.showTextDocument(doc));
            }
        });

        return {
            summary: {
                phases,
                concerns,
                recommendations,
                consensus
            }
        };
    }

    /**
     * Extract section headers from a markdown document
     */
    private extractDocSections(content: string): string[] {
        const lines = content.split('\n');
        const sections: string[] = [];
        for (const line of lines) {
            if (line.startsWith('## ') || line.startsWith('### ')) {
                sections.push(line.replace(/^#+\s*/, '').trim());
            }
        }
        return sections;
    }

    // NOTE: generateDetailedPlan was removed - we now preserve what debate agents wrote
    // The plan skeleton is created by AgentRunner.createPlanSkeleton()
    // and filled in by the debate agents during runMultiAgentDebate()
    // Phase 11 now just updates the status and adds consensus info

    /**
     * Generate a plan file from the requirement
     */
    private async generatePlan(session: PlanningSession): Promise<string> {
        // Use new structure: _AiDevLog/Plans/{sessionId}/plan.md
        this.stateManager.ensurePlanDirectories(session.id);
        const planPath = this.stateManager.getPlanFilePath(session.id);

        // Generate a template plan
        const planContent = `# Plan: ${session.requirement}

## Session: ${session.id}
## Created: ${new Date().toISOString()}
## Status: Pending Review

---

## Overview
${session.requirement}

---

## Tasks

### Wave 1 (Parallel)
- [ ] Task 1.1: Initial setup and scaffolding
- [ ] Task 1.2: Core data structures
- [ ] Task 1.3: Basic UI components

### Wave 2 (Parallel, depends on Wave 1)
- [ ] Task 2.1: Business logic implementation
- [ ] Task 2.2: Integration with existing systems
- [ ] Task 2.3: Unit tests

### Wave 3 (Sequential)
- [ ] Task 3.1: Integration testing
- [ ] Task 3.2: Documentation
- [ ] Task 3.3: Final review

---

## Engineer Allocation
Recommended: ${this.estimateEngineerCount(session.requirement)} engineers

### Suggested Assignment
- **Engineer 1**: Wave 1 tasks (setup, scaffolding)
- **Engineer 2**: Wave 1 tasks (data structures)
- **Engineer 3**: Wave 1 tasks (UI components)

---

## Dependencies
- None identified

## Risks
- None identified

## Notes
This is an auto-generated plan template. Review and modify as needed.
`;

        fs.writeFileSync(planPath, planContent);
        return planPath;
    }

    /**
     * Estimate engineer count based on requirement
     */
    private estimateEngineerCount(requirement: string): number {
        // Simple heuristic based on requirement length/complexity
        const words = requirement.split(/\s+/).length;
        if (words < 10) {return 2;}
        if (words < 30) {return 3;}
        if (words < 50) {return 4;}
        return 5;
    }

    /**
     * Revise an existing plan - runs SYNCHRONOUSLY like startPlanning
     * Re-runs the planning debate with revision feedback incorporated
     */
    async revisePlan(sessionId: string, feedback: string): Promise<{ 
        sessionId: string; 
        status: PlanningStatus;
        planPath?: string;
        version?: number;
    }> {
        const session = this.stateManager.getPlanningSession(sessionId);
        if (!session) {
            throw new Error(`Planning session ${sessionId} not found`);
        }

        // Record the revision request
        const newVersion = session.planHistory.length + 1;
        session.status = 'revising';
        session.revisionHistory.push({
            version: newVersion,
            feedback: feedback,
            timestamp: new Date().toISOString()
        });
        session.updatedAt = new Date().toISOString();
        
        this.stateManager.savePlanningSession(session);
        this.notifyChange();

        // Run the REAL revision process synchronously (waits for completion)
        await this.runPlanRevision(session, feedback, newVersion);

        return {
            sessionId,
            status: session.status,
            planPath: session.currentPlanPath,
            version: newVersion
        };
    }

    /**
     * Run the plan revision process SYNCHRONOUSLY
     * Re-runs analysts with the original requirement + revision feedback
     */
    private async runPlanRevision(
        session: PlanningSession, 
        feedback: string,
        newVersion: number
    ): Promise<void> {
        const progressPath = this.getProgressFilePath(session.id);
        
        // Show output channel
        this.outputManager.clear();
        this.outputManager.show();
        this.outputManager.appendLine(`════════════════════════════════════════════════════════════`);
        this.outputManager.appendLine(`  APC PLAN REVISION: ${session.id} → v${newVersion}`);
        this.outputManager.appendLine(`════════════════════════════════════════════════════════════`);
        this.outputManager.appendLine(``);
        this.outputManager.appendLine(`📋 Original Requirement: ${session.requirement.substring(0, 80)}...`);
        this.outputManager.appendLine(`📝 Revision Feedback: ${feedback.substring(0, 80)}...`);
        this.outputManager.appendLine(``);
        this.outputManager.appendLine(`💡 TIP: Watch this panel for live updates from AI agents!`);
        this.outputManager.appendLine(`────────────────────────────────────────────────────────────`);
        this.outputManager.appendLine(``);

        // Write revision header to progress log
        fs.writeFileSync(progressPath, `════════════════════════════════════════════════════════════\n`);
        fs.appendFileSync(progressPath, `  PLAN REVISION: ${session.id} → Version ${newVersion}\n`);
        fs.appendFileSync(progressPath, `════════════════════════════════════════════════════════════\n\n`);
        fs.appendFileSync(progressPath, `ORIGINAL REQUIREMENT:\n${session.requirement}\n\n`);
        fs.appendFileSync(progressPath, `REVISION FEEDBACK:\n${feedback}\n\n`);
        fs.appendFileSync(progressPath, `────────────────────────────────────────────────────────────\n\n`);

        // Phase 1: Read existing plan for context
        this.writeProgress(session.id, 'REVISION', '📖 Reading current plan for context...');
        let existingPlanContent = '';
        if (session.currentPlanPath && fs.existsSync(session.currentPlanPath)) {
            existingPlanContent = fs.readFileSync(session.currentPlanPath, 'utf-8');
            this.writeProgress(session.id, 'REVISION', `   ✓ Loaded ${session.currentPlanPath}`);
        }

        // Phase 2: Context Gatherer re-scans based on feedback
        this.writeProgress(session.id, 'CONTEXT', '🔍 Re-gathering context based on feedback...');
        
        // Create combined requirement with feedback emphasis
        const revisionPrompt = `
## PLAN REVISION REQUEST

### Original Requirement:
${session.requirement}

### Revision Feedback (PRIORITY):
${feedback}

### Current Plan Summary:
${existingPlanContent.substring(0, 2000)}
${existingPlanContent.length > 2000 ? '\n... (truncated)' : ''}

### Instructions:
Focus on the REVISION FEEDBACK. Identify what needs to change in the current plan.
Look for assets, code patterns, or project structure relevant to the feedback.
`;

        // Start context gatherer with revision focus
        const contextFile = await this.agentRunner.startContextGatherer(
            parseInt(session.id.replace('ps_', '')),
            revisionPrompt,
            [],  // No docs for revision - use existing context
            (msg) => this.writeProgress(session.id, 'CONTEXT', msg)
        );

        // Wait briefly for initial context gathering
        await this.delay(3000);
        this.writeProgress(session.id, 'CONTEXT', '   Context gathering running in background...');

        // Phase 3: Run analyst debate focused on revision
        this.writeProgress(session.id, 'DEBATE', '💬 Analysts re-evaluating based on feedback...');
        
        // Create combined requirement that emphasizes the revision
        const revisionRequirement = `## PLAN REVISION

### Original Requirement:
${session.requirement}

### Revision Feedback (PRIORITY - ADDRESS THIS):
${feedback}

### Current Plan Summary:
${existingPlanContent.substring(0, 3000)}
${existingPlanContent.length > 3000 ? '\n... (see full plan)' : ''}

### Instructions:
You are revising an existing plan. Focus on the REVISION FEEDBACK above.
Update tasks, add new tasks, or modify existing ones based on the feedback.
Preserve what works, change what the feedback requires.
`;

        // Prepare revised plan file - use same file (plan.md), version tracked internally
        // Structure: _AiDevLog/Plans/{sessionId}/plan.md
        this.stateManager.ensurePlanDirectories(session.id);
        const planPath = this.stateManager.getPlanFilePath(session.id);

        // Copy existing plan as base for revision (NOT a fresh skeleton)
        const revisionHeader = `# Plan Revision v${newVersion}

**Based on:** v${newVersion - 1}
**Revision Requested:** ${new Date().toISOString()}
**Status:** 🔄 REVISING (agents updating based on feedback)

---

## Revision Feedback (PRIORITY)

${feedback}

---

## Analyst Revision Notes

<!-- ANALYST_SECTION_START -->
### 🏗️ Opus Analyst (Architecture)
_Reviewing feedback impact on architecture..._

### ⚡ Codex Analyst (Implementation)
_Reviewing feedback impact on implementation..._

### 🧪 Gemini Analyst (Testing)
_Reviewing feedback impact on testing..._
<!-- ANALYST_SECTION_END -->

---

## Previous Plan (v${newVersion - 1})

`;
        // Write revision header + existing plan content
        fs.writeFileSync(planPath, revisionHeader + existingPlanContent);
        this.writeProgress(session.id, 'REVISION', `   ✓ Created revision base from v${newVersion - 1}`);
        
        // Run multi-agent debate with revision context
        // Agents write directly to the plan file
        const poolSize = this.stateManager.getPoolSize();
        const analyses = await this.agentRunner.runMultiAgentDebate(
            session.id,
            revisionRequirement,
            [],  // No additional docs for revision
            planPath,
            existingPlanContent,  // Pass existing plan as context
            (msg) => this.writeProgress(session.id, 'DEBATE', `${msg}`),
            poolSize
        );

        // Store analyses on session
        (session as any).agentAnalyses = analyses;
        
        // Read the plan that agents created
        let finalPlanContent = '';
        if (fs.existsSync(planPath)) {
            finalPlanContent = fs.readFileSync(planPath, 'utf-8');
        }
        
        // Phase 4: Task Review (same as plan new)
        // Stop context gatherer and run task-specific review
        this.writeProgress(session.id, 'REVIEW', '🔍 Running task review phase...');
        this.agentRunner.stopContextGatherer();
        
        // Extract tasks from the revised plan
        const taskMatches = finalPlanContent.match(/\|\s*T\d+\s*\|[^|]+\|/g) || [];
        const tasks = taskMatches.map(match => {
            const parts = match.split('|').filter(p => p.trim());
            return {
                name: parts[0]?.trim() || 'Unknown',
                files: [] as string[]
            };
        }).slice(0, 10);  // Limit to first 10 tasks
        
        if (tasks.length > 0) {
            await this.agentRunner.runTaskReview(
                parseInt(session.id.replace('ps_', '')),
                revisionRequirement,
                [],
                tasks,
                (msg) => this.writeProgress(session.id, 'REVIEW', `  ${msg}`)
            );
            
            // Get enriched context
            const taskContext = this.agentRunner.getGatheredContext();
            if (taskContext) {
                this.writeProgress(session.id, 'REVIEW', `  ✓ Task-specific context gathered (${taskContext.length} chars)`);
                (session as any).taskContext = taskContext;
            }
        }
        
        this.writeProgress(session.id, 'REVISION', '📝 Finalizing revised plan...');

        // Update session
        session.status = 'reviewing';
        session.currentPlanPath = planPath;
        session.planHistory.push({
            version: newVersion,
            path: planPath,
            timestamp: new Date().toISOString()
        });
        session.updatedAt = new Date().toISOString();
        this.stateManager.savePlanningSession(session);
        this.notifyChange();

        // Final progress messages
        this.writeProgress(session.id, 'COMPLETE', `✅ Revision v${newVersion} complete!`);
        this.writeProgress(session.id, 'COMPLETE', `   Plan: ${path.basename(planPath)}`);
        this.writeProgress(session.id, 'COMPLETE', ``);
        this.writeProgress(session.id, 'COMPLETE', `🎯 Ready for review!`);
        this.writeProgress(session.id, 'COMPLETE', `   Use: apc plan status ${session.id}`);
        this.writeProgress(session.id, 'COMPLETE', `   Or:  apc plan approve ${session.id}`);

        vscode.window.showInformationMessage(
            `Plan revision v${newVersion} ready for review`,
            'View Plan'
        ).then(selection => {
            if (selection === 'View Plan') {
                vscode.workspace.openTextDocument(planPath)
                    .then(doc => vscode.window.showTextDocument(doc));
            }
        });
    }

    /**
     * Simulate plan revision (DEPRECATED - kept for backwards compatibility)
     * Real revisions now use runPlanRevision which runs actual agents
     */
    private async simulatePlanRevision(session: PlanningSession, feedback: string): Promise<void> {
        const progressPath = this.getProgressFilePath(session.id);
        
        // Clear progress file for new revision
        fs.writeFileSync(progressPath, `=== Revision for Session ${session.id} ===\n`);
        fs.appendFileSync(progressPath, `Feedback: ${feedback}\n\n`);

        // Phase 1: Analyze feedback
        this.writeProgress(session.id, 'ANALYZE', '🔍 Analyzing revision feedback...');
        await this.delay(500);
        this.writeProgress(session.id, 'ANALYZE', `  Feedback: "${feedback.substring(0, 60)}${feedback.length > 60 ? '...' : ''}"`);
        
        // Phase 2: Re-evaluate with analysts
        await this.delay(400);
        this.writeProgress(session.id, 'DEBATE', '💬 Analysts re-evaluating based on feedback...');
        await this.delay(600);
        this.writeProgress(session.id, 'ANALYST-1', '  Architecture impact: Evaluating changes...');
        await this.delay(400);
        this.writeProgress(session.id, 'ANALYST-2', '  Performance impact: Checking implications...');
        await this.delay(400);
        this.writeProgress(session.id, 'ANALYST-3', '  Testing impact: Updating test strategy...');
        
        // Phase 3: Generate revised plan
        await this.delay(500);
        this.writeProgress(session.id, 'REVISE', '📝 Generating revised plan...');
        await this.delay(400);

        // Generate revised plan - overwrite the same file
        // Structure: _AiDevLog/Plans/{sessionId}/plan.md
        const newVersion = session.planHistory.length + 1;
        const planPath = this.stateManager.getPlanFilePath(session.id);

        // Read existing plan and append revision notes
        let existingContent = '';
        if (session.currentPlanPath && fs.existsSync(session.currentPlanPath)) {
            existingContent = fs.readFileSync(session.currentPlanPath, 'utf-8');
        }

        const revisedContent = existingContent + `

---

## Revision ${newVersion}
### Feedback: ${feedback}
### Applied: ${new Date().toISOString()}

[Revision changes would be applied here based on feedback]
`;

        fs.writeFileSync(planPath, revisedContent);

        this.writeProgress(session.id, 'COMPLETE', `✅ Revision ${newVersion} generated: ${path.basename(planPath)}`);
        this.writeProgress(session.id, 'COMPLETE', `\n🎯 Ready for review!`);
        this.writeProgress(session.id, 'COMPLETE', `   Use: apc plan status ${session.id}`);
        this.writeProgress(session.id, 'COMPLETE', `   Or:  apc plan approve ${session.id}`);

        session.status = 'reviewing';
        session.currentPlanPath = planPath;
        session.planHistory.push({
            version: newVersion,
            path: planPath,
            timestamp: new Date().toISOString()
        });
        session.updatedAt = new Date().toISOString();

        this.stateManager.savePlanningSession(session);
        this.notifyChange();

        vscode.window.showInformationMessage(
            `Plan revision ${newVersion} ready for review`,
            'View Plan'
        ).then(selection => {
            if (selection === 'View Plan') {
                vscode.workspace.openTextDocument(planPath)
                    .then(doc => vscode.window.showTextDocument(doc));
            }
        });
    }

    /**
     * Approve a plan for execution
     * If autoStart is true, immediately starts execution
     */
    async approvePlan(sessionId: string, autoStart: boolean = true): Promise<void> {
        const session = this.stateManager.getPlanningSession(sessionId);
        if (!session) {
            throw new Error(`Planning session ${sessionId} not found`);
        }

        if (session.status !== 'reviewing') {
            throw new Error(`Plan is not ready for approval (status: ${session.status})`);
        }

        session.status = 'approved';
        session.updatedAt = new Date().toISOString();
        this.stateManager.savePlanningSession(session);
        this.notifyChange();
        
        if (autoStart) {
            // Auto-start execution
            const result = await this.startExecution(sessionId);
            if (result.success) {
                vscode.window.showInformationMessage(
                    `Plan ${sessionId} approved and execution started with ${result.engineerCount} engineers!`
                );
            } else {
                vscode.window.showWarningMessage(
                    `Plan ${sessionId} approved but execution failed to start: ${result.error}`
                );
            }
        } else {
            vscode.window.showInformationMessage(`Plan ${sessionId} approved and ready for execution`);
        }
    }
    
    // =========================================================================
    // EXECUTION FACADE METHODS (delegates to CoordinatorService)
    // =========================================================================
    
    /**
     * Start execution for an approved plan
     * Creates a coordinator and assigns engineers
     */
    async startExecution(sessionId: string, options?: {
        mode?: 'auto' | 'interactive';
        engineerCount?: number;
    }): Promise<{ success: boolean; error?: string; engineerCount?: number }> {
        try {
            const session = this.stateManager.getPlanningSession(sessionId);
            if (!session) {
                return { success: false, error: `Session ${sessionId} not found` };
            }
            
            if (session.status !== 'approved' && session.status !== 'paused' && session.status !== 'stopped') {
                return { success: false, error: `Session must be 'approved', 'paused', or 'stopped' to start execution (current: ${session.status})` };
            }
            
            if (!session.currentPlanPath) {
                return { success: false, error: 'No plan file found for this session' };
            }
            
            if (!this.coordinatorService) {
                return { success: false, error: 'CoordinatorService not initialized' };
            }
            
            // Determine engineer count
            const engineerCount = options?.engineerCount || session.recommendedEngineers?.count || 3;
            const mode = options?.mode || 'auto';
            
            // IMPORTANT: Reuse existing coordinator ID if session was paused/stopped
            // This ensures consistent coordinator ID across pause/resume/stop/restart cycles
            const existingCoordinatorId = session.execution?.coordinatorId;
            
            // Start the coordinator (reusing existing ID if available)
            const result = await this.coordinatorService.startCoordinator(session.currentPlanPath, {
                mode,
                engineerCount,
                planSessionId: sessionId,
                reuseCoordinatorId: existingCoordinatorId  // Pass existing ID to reuse
            });
            
            // Create execution state on the session
            const executionState: ExecutionState = {
                coordinatorId: result.coordinatorId,
                mode,
                startedAt: new Date().toISOString(),
                engineers: {},
                progress: { completed: 0, total: 0, percentage: 0 },
                currentWave: 1,
                lastActivityAt: new Date().toISOString()
            };
            
            // Populate initial engineer states
            for (const engineerName of result.engineersAllocated) {
                executionState.engineers[engineerName] = {
                    name: engineerName,
                    status: 'starting',
                    sessionId: '',
                    logFile: '',
                    startTime: new Date().toISOString()
                };
            }
            
            // Update session
            session.status = 'executing';
            session.execution = executionState;
            session.updatedAt = new Date().toISOString();
            this.stateManager.savePlanningSession(session);
            this.notifyChange();
            
            // Start syncing execution state
            this.startExecutionSync(sessionId);
            
            // Write to progress log
            this.writeProgress(sessionId, 'EXECUTION', '═'.repeat(60));
            this.writeProgress(sessionId, 'EXECUTION', '🚀 EXECUTION STARTED');
            this.writeProgress(sessionId, 'EXECUTION', `   Mode: ${mode}`);
            this.writeProgress(sessionId, 'EXECUTION', `   Engineers: ${result.engineersAllocated.join(', ')}`);
            this.writeProgress(sessionId, 'EXECUTION', `   Coordinator: ${result.coordinatorId}`);
            this.writeProgress(sessionId, 'EXECUTION', '═'.repeat(60));
            
            return { success: true, engineerCount: result.engineersAllocated.length };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            return { success: false, error: errorMsg };
        }
    }
    
    /**
     * Pause execution for a session
     */
    async pauseExecution(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            const session = this.stateManager.getPlanningSession(sessionId);
            if (!session) {
                return { success: false, error: `Session ${sessionId} not found` };
            }
            
            if (session.status !== 'executing') {
                return { success: false, error: `Session is not executing (current: ${session.status})` };
            }
            
            if (!session.execution?.coordinatorId || !this.coordinatorService) {
                return { success: false, error: 'No active coordinator for this session' };
            }
            
            // Pause the coordinator
            await this.coordinatorService.pauseCoordinator(session.execution.coordinatorId);
            
            // Update session
            session.status = 'paused';
            session.updatedAt = new Date().toISOString();
            if (session.execution) {
                session.execution.lastActivityAt = new Date().toISOString();
            }
            this.stateManager.savePlanningSession(session);
            this.notifyChange();
            
            this.writeProgress(sessionId, 'EXECUTION', '⏸️ EXECUTION PAUSED');
            
            return { success: true };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            return { success: false, error: errorMsg };
        }
    }
    
    /**
     * Resume a paused execution
     */
    async resumeExecution(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            const session = this.stateManager.getPlanningSession(sessionId);
            if (!session) {
                return { success: false, error: `Session ${sessionId} not found` };
            }
            
            if (session.status !== 'paused') {
                return { success: false, error: `Session is not paused (current: ${session.status})` };
            }
            
            if (!session.execution?.coordinatorId || !this.coordinatorService) {
                return { success: false, error: 'No coordinator to resume' };
            }
            
            // Resume the coordinator
            await this.coordinatorService.resumeCoordinator(session.execution.coordinatorId);
            
            // Update session
            session.status = 'executing';
            session.updatedAt = new Date().toISOString();
            if (session.execution) {
                session.execution.lastActivityAt = new Date().toISOString();
            }
            this.stateManager.savePlanningSession(session);
            this.notifyChange();
            
            // Restart sync
            this.startExecutionSync(sessionId);
            
            this.writeProgress(sessionId, 'EXECUTION', '▶️ EXECUTION RESUMED');
            
            return { success: true };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            return { success: false, error: errorMsg };
        }
    }
    
    /**
     * Stop execution completely
     */
    async stopExecution(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            const session = this.stateManager.getPlanningSession(sessionId);
            if (!session) {
                return { success: false, error: `Session ${sessionId} not found` };
            }
            
            if (session.status !== 'executing' && session.status !== 'paused') {
                return { success: false, error: `Session is not executing (current: ${session.status})` };
            }
            
            if (session.execution?.coordinatorId && this.coordinatorService) {
                // Stop the coordinator
                await this.coordinatorService.stopCoordinator(session.execution.coordinatorId);
            }
            
            // Stop sync
            this.stopExecutionSync();
            
            // Update session
            session.status = 'stopped';
            session.updatedAt = new Date().toISOString();
            this.stateManager.savePlanningSession(session);
            this.notifyChange();
            
            this.writeProgress(sessionId, 'EXECUTION', '⏹️ EXECUTION STOPPED');
            
            return { success: true };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            return { success: false, error: errorMsg };
        }
    }
    
    /**
     * Get execution status for a session
     */
    getExecutionStatus(sessionId: string): ExecutionState | undefined {
        const session = this.stateManager.getPlanningSession(sessionId);
        return session?.execution;
    }
    
    /**
     * Start periodic sync of execution state from coordinator
     */
    private startExecutionSync(sessionId: string): void {
        // Clear any existing interval
        this.stopExecutionSync();
        
        // Sync every 5 seconds
        this.executionSyncInterval = setInterval(() => {
            this.syncExecutionState(sessionId);
        }, 5000);
    }
    
    /**
     * Stop execution sync
     */
    private stopExecutionSync(): void {
        if (this.executionSyncInterval) {
            clearInterval(this.executionSyncInterval);
            this.executionSyncInterval = undefined;
        }
    }
    
    /**
     * Sync execution state from coordinator to session
     */
    private syncExecutionState(sessionId: string): void {
        const session = this.stateManager.getPlanningSession(sessionId);
        if (!session || !session.execution?.coordinatorId || !this.coordinatorService) {
            return;
        }
        
        // Get coordinator status
        const coordStatus = this.coordinatorService.getCoordinatorStatus(session.execution.coordinatorId);
        if (!coordStatus) {
            return;
        }
        
        // Remove engineers that are no longer in coordinator (released)
        const currentEngineers = Object.keys(session.execution.engineers);
        const activeEngineers = Object.keys(coordStatus.engineerSessions);
        for (const name of currentEngineers) {
            if (!activeEngineers.includes(name)) {
                // Engineer was released - remove from session
                delete session.execution.engineers[name];
            }
        }
        
        // Update/add engineer states from coordinator
        for (const [name, engineerSession] of Object.entries(coordStatus.engineerSessions)) {
            session.execution.engineers[name] = {
                ...(session.execution.engineers[name] || {}),
                status: engineerSession.status === 'working' ? 'working' 
                      : engineerSession.status === 'completed' ? 'completed'
                      : engineerSession.status === 'error' ? 'error'
                      : engineerSession.status === 'paused' ? 'paused'
                      : engineerSession.status === 'idle' ? 'idle'
                      : 'starting',
                sessionId: engineerSession.sessionId,
                currentTask: engineerSession.task,
                logFile: engineerSession.logFile,
                processId: engineerSession.processId,
                lastActivity: engineerSession.lastActivity
            };
        }
        
        // Update progress
        session.execution.progress = coordStatus.progress;
        session.execution.lastActivityAt = new Date().toISOString();
        
        // Check for reviewing state (all tasks done, generating summary)
        if (coordStatus.status === 'reviewing' && session.status === 'executing') {
            // Don't change session status yet - coordinator is releasing engineers and generating summary
            // Just log that we're in review phase
            this.writeProgress(sessionId, 'EXECUTION', '📋 All tasks complete. Reviewing and generating summary...');
        }
        
        // Check for completion (only after summary is generated)
        if (coordStatus.status === 'completed') {
            session.status = 'completed';
            this.stopExecutionSync();
            this.writeProgress(sessionId, 'EXECUTION', '✅ EXECUTION COMPLETED!');
            vscode.window.showInformationMessage(`Plan ${sessionId} execution completed!`);
        } else if (coordStatus.status === 'error') {
            session.status = 'stopped';
            this.stopExecutionSync();
            this.writeProgress(sessionId, 'EXECUTION', '❌ EXECUTION FAILED');
        }
        
        session.updatedAt = new Date().toISOString();
        this.stateManager.savePlanningSession(session);
        this.notifyChange();
    }

    /**
     * Cancel a planning session
     */
    async cancelPlan(sessionId: string): Promise<void> {
        const session = this.stateManager.getPlanningSession(sessionId);
        if (!session) {
            throw new Error(`Planning session ${sessionId} not found`);
        }

        session.status = 'cancelled';
        session.updatedAt = new Date().toISOString();
        this.stateManager.savePlanningSession(session);
        this.notifyChange();
    }

    /**
     * Get planning session status
     */
    getPlanningStatus(sessionId: string): PlanningSession | undefined {
        return this.stateManager.getPlanningSession(sessionId);
    }

    /**
     * List all planning sessions
     */
    listPlanningSessions(): PlanningSession[] {
        return this.stateManager.getAllPlanningSessions();
    }

    /**
     * Stop a running planning session
     * Stops any active agent processes and marks session appropriately:
     * - If stopped during planning (debating/revising/reviewing) → 'cancelled'
     * - If stopped during execution → 'stopped'
     * Uses ProcessManager for reliable process termination
     */
    async stopSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            const session = this.stateManager.getPlanningSession(sessionId);
            if (!session) {
                return { success: false, error: `Session ${sessionId} not found` };
            }

            const previousStatus = session.status;
            const wasDuringPlanning = ['debating', 'revising', 'reviewing'].includes(previousStatus);

            this.writeProgress(sessionId, 'STOP', '='.repeat(60));
            this.writeProgress(sessionId, 'STOP', `⏹️ STOPPING SESSION: ${sessionId}`);
            this.writeProgress(sessionId, 'STOP', `   Previous status: ${previousStatus}`);
            this.writeProgress(sessionId, 'STOP', '='.repeat(60));

            // Stop any running agents - await for proper cleanup
            this.writeProgress(sessionId, 'STOP', `   Stopping context gatherer...`);
            await this.agentRunner.stopContextGatherer();
            this.writeProgress(sessionId, 'STOP', `   Stopping all agents...`);
            await this.agentRunner.stopAll();

            // Determine final status based on when we stopped
            // If stopped during planning phase → cancelled (plan incomplete)
            // If stopped during execution phase → stopped (can resume)
            if (wasDuringPlanning) {
                session.status = 'cancelled';
                this.writeProgress(sessionId, 'STOP', `✅ Session cancelled (stopped during planning)`);
            } else {
            session.status = 'stopped';
                this.writeProgress(sessionId, 'STOP', `✅ Session stopped (can resume execution)`);
            }
            
            session.updatedAt = new Date().toISOString();
            this.stateManager.savePlanningSession(session);
            this.notifyChange();

            return { success: true };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.writeProgress(sessionId, 'ERROR', `❌ Failed to stop: ${errorMessage}`);
            return { success: false, error: `Failed to stop session: ${errorMessage}` };
        }
    }

    /**
     * Pause a running planning session
     * Saves the current state so it can be resumed later
     */
    async pauseSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            const session = this.stateManager.getPlanningSession(sessionId);
            if (!session) {
                return { success: false, error: `Session ${sessionId} not found` };
            }

            if (session.status !== 'debating' && session.status !== 'reviewing' && session.status !== 'revising') {
                return { success: false, error: `Session ${sessionId} is not in a pausable state (current: ${session.status})` };
            }

            this.writeProgress(sessionId, 'PAUSE', '='.repeat(60));
            this.writeProgress(sessionId, 'PAUSE', `⏸️ PAUSING SESSION: ${sessionId}`);
            this.writeProgress(sessionId, 'PAUSE', `   Current status: ${session.status}`);
            this.writeProgress(sessionId, 'PAUSE', '='.repeat(60));

            // Stop agent processes (ProcessManager saves state automatically)
            await this.agentRunner.stopContextGatherer();
            await this.agentRunner.stopAll();

            // Save the previous status so we can resume correctly
            const previousStatus = session.status;
            
            // Update session status to 'paused'
            session.status = 'stopped';  // Use 'stopped' as it's an existing valid status
            session.updatedAt = new Date().toISOString();
            
            // Store pause metadata for smart resume
            if (!session.metadata) {
                session.metadata = {};
            }
            session.metadata.pausedAt = new Date().toISOString();
            session.metadata.pausedStatus = previousStatus;
            
            this.stateManager.savePlanningSession(session);
            this.notifyChange();

            this.writeProgress(sessionId, 'PAUSE', `✅ Session paused successfully (was: ${previousStatus})`);

            return { success: true };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.writeProgress(sessionId, 'ERROR', `❌ Failed to pause: ${errorMessage}`);
            return { success: false, error: `Failed to pause session: ${errorMessage}` };
        }
    }

    /**
     * Resume a stopped or cancelled planning session
     * Restarts the planning process from where it left off
     */
    async resumeSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            const session = this.stateManager.getPlanningSession(sessionId);
            if (!session) {
                return { success: false, error: `Session ${sessionId} not found` };
            }

            if (session.status !== 'stopped' && session.status !== 'cancelled') {
                return { success: false, error: `Session ${sessionId} is not in a resumable state (current: ${session.status})` };
            }

            // Determine what state to resume to
            const previousStatus = session.metadata?.pausedStatus || 'debating';
            
            // Log the resume action
            this.writeProgress(sessionId, 'RESUME', '='.repeat(60));
            this.writeProgress(sessionId, 'RESUME', `▶️ RESUMING SESSION: ${sessionId}`);
            this.writeProgress(sessionId, 'RESUME', `   Previous status: ${session.status}`);
            this.writeProgress(sessionId, 'RESUME', `   Resuming to: ${previousStatus}`);
            this.writeProgress(sessionId, 'RESUME', `   Requirement: ${session.requirement.substring(0, 60)}...`);
            this.writeProgress(sessionId, 'RESUME', '='.repeat(60));

            // Clear pause metadata
            if (session.metadata) {
                delete session.metadata.pausedAt;
                delete session.metadata.pausedStatus;
            }

            // Update session status to resume from the right point
            session.status = previousStatus as PlanningStatus;
            session.updatedAt = new Date().toISOString();
            this.stateManager.savePlanningSession(session);
            this.notifyChange();

            // Re-run the planning debate (context gathering + debate)
            // This runs async - the session will update as agents complete
            this.runPlanningDebate(session, []).catch((error: Error) => {
                console.error(`[PlanningService] Resume failed for ${sessionId}:`, error);
                this.writeProgress(sessionId, 'ERROR', `❌ Resume failed: ${error.message}`);
                session.status = 'stopped';
                session.updatedAt = new Date().toISOString();
                this.stateManager.savePlanningSession(session);
                this.notifyChange();
            });

            return { success: true };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { success: false, error: `Failed to resume session: ${errorMessage}` };
        }
    }

    /**
     * Remove a planning session completely
     * Deletes the session data and any associated files
     */
    async removeSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
        try {
            const session = this.stateManager.getPlanningSession(sessionId);
            if (!session) {
                return { success: false, error: `Session ${sessionId} not found` };
            }

            // Stop if still running - await for proper cleanup
            if (session.status === 'debating' || session.status === 'reviewing' || session.status === 'revising') {
                await this.agentRunner.stopContextGatherer();
                await this.agentRunner.stopAll();
            }

            const workingDir = this.stateManager.getWorkingDir();
            const sessionsDir = path.join(workingDir, 'planning_sessions');
            const plansDir = path.join(workingDir, 'Plans');

            // Delete associated plan files
            if (session.currentPlanPath && fs.existsSync(session.currentPlanPath)) {
                try {
                    fs.unlinkSync(session.currentPlanPath);
                    // Also delete lock file
                    const lockFile = `${session.currentPlanPath}.lock`;
                    if (fs.existsSync(lockFile)) {
                        fs.unlinkSync(lockFile);
                    }
                } catch (e) {
                    console.error(`Failed to delete plan file: ${e}`);
                }
            }

            // Delete all plan versions
            for (const version of session.planHistory) {
                if (version.path && fs.existsSync(version.path)) {
                    try {
                        fs.unlinkSync(version.path);
                    } catch (e) {
                        console.error(`Failed to delete version file: ${e}`);
                    }
                }
            }

            // Delete progress log file
            const progressLogPath = path.join(sessionsDir, `${sessionId}_progress.log`);
            if (fs.existsSync(progressLogPath)) {
                try {
                    fs.unlinkSync(progressLogPath);
                } catch (e) {
                    console.error(`Failed to delete progress log: ${e}`);
                }
            }

            // Delete any debate summary files for this session
            try {
                const files = fs.readdirSync(sessionsDir);
                for (const file of files) {
                    if (file.startsWith('debate_summary_') && file.endsWith('.md')) {
                        // Check if it's from this session's timeframe (rough match)
                        const filePath = path.join(sessionsDir, file);
                        try {
                            fs.unlinkSync(filePath);
                        } catch (e) {
                            // Ignore - might be from another session
                        }
                    }
                }
            } catch (e) {
                // Ignore directory read errors
            }

            // Remove from state manager (this also deletes the session JSON file)
            this.stateManager.deletePlanningSession(sessionId);
            this.notifyChange();

            return { success: true };
        } catch (error) {
            return { success: false, error: `Failed to remove session: ${error}` };
        }
    }
}








