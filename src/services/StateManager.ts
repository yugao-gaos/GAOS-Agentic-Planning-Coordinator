import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    ExtensionState,
    EngineerPoolState,
    PlanningSession,
    CoordinatorState,
    PlanInfo,
    GlobalSettings
} from '../types';

export class StateManager {
    private workspaceRoot: string;
    private context: vscode.ExtensionContext;
    private workingDir: string;
    private extensionState: ExtensionState;
    private engineerPoolState: EngineerPoolState;
    private planningSessions: Map<string, PlanningSession> = new Map();
    private coordinators: Map<string, CoordinatorState> = new Map();

    constructor(workspaceRoot: string, context: vscode.ExtensionContext) {
        this.workspaceRoot = workspaceRoot;
        this.context = context;
        
        const config = vscode.workspace.getConfiguration('agenticPlanning');
        this.workingDir = path.join(workspaceRoot, config.get<string>('workingDirectory', '_AiDevLog'));
        
        // Initialize with defaults
        this.extensionState = {
            globalSettings: {
                engineerPoolSize: config.get<number>('engineerPoolSize', 5),
                defaultBackend: config.get<'cursor' | 'claude-code' | 'codex'>('defaultBackend', 'cursor'),
                workingDirectory: this.workingDir
            },
            activePlanningSessions: [],
            activeCoordinators: []
        };

        this.engineerPoolState = this.createDefaultEngineerPool(this.extensionState.globalSettings.engineerPoolSize);
    }

    /**
     * Get the current engineer pool size from settings
     */
    getPoolSize(): number {
        return this.extensionState.globalSettings.engineerPoolSize;
    }

    // ========================================================================
    // Path Helpers - All paths relative to plan folder structure
    // ========================================================================

    /**
     * Get the base folder for a planning session
     * Structure: _AiDevLog/Plans/{sessionId}/
     */
    getPlanFolder(sessionId: string): string {
        return path.join(this.workingDir, 'Plans', sessionId);
    }

    /**
     * Get the plan file path for a session
     * Structure: _AiDevLog/Plans/{sessionId}/plan.md
     */
    getPlanFilePath(sessionId: string): string {
        return path.join(this.getPlanFolder(sessionId), 'plan.md');
    }

    /**
     * Get the session state file path
     * Structure: _AiDevLog/Plans/{sessionId}/session.json
     */
    getSessionFilePath(sessionId: string): string {
        return path.join(this.getPlanFolder(sessionId), 'session.json');
    }

    /**
     * Get the coordinator state file path for a session
     * Structure: _AiDevLog/Plans/{sessionId}/coordinator.json
     */
    getCoordinatorFilePath(sessionId: string): string {
        return path.join(this.getPlanFolder(sessionId), 'coordinator.json');
    }

    /**
     * Get the progress log file path
     * Structure: _AiDevLog/Plans/{sessionId}/progress.log
     */
    getProgressLogPath(sessionId: string): string {
        return path.join(this.getPlanFolder(sessionId), 'progress.log');
    }

    /**
     * Get the completions folder for a session
     * Structure: _AiDevLog/Plans/{sessionId}/completions/
     */
    getCompletionsFolder(sessionId: string): string {
        return path.join(this.getPlanFolder(sessionId), 'completions');
    }

    /**
     * Get the logs folder for a session
     * Structure: _AiDevLog/Plans/{sessionId}/logs/
     */
    getLogsFolder(sessionId: string): string {
        return path.join(this.getPlanFolder(sessionId), 'logs');
    }

    /**
     * Get the engineer logs folder for a session
     * Structure: _AiDevLog/Plans/{sessionId}/logs/engineers/
     */
    getEngineerLogsFolder(sessionId: string): string {
        return path.join(this.getLogsFolder(sessionId), 'engineers');
    }

    /**
     * Get the coordinator log file path
     * Structure: _AiDevLog/Plans/{sessionId}/logs/coordinator.log
     */
    getCoordinatorLogPath(sessionId: string): string {
        return path.join(this.getLogsFolder(sessionId), 'coordinator.log');
    }

    /**
     * Get the summaries folder for a session
     * Structure: _AiDevLog/Plans/{sessionId}/summaries/
     */
    getSummariesFolder(sessionId: string): string {
        return path.join(this.getPlanFolder(sessionId), 'summaries');
    }

    /**
     * Get the execution summary path
     * Structure: _AiDevLog/Plans/{sessionId}/summaries/execution_summary.md
     */
    getExecutionSummaryPath(sessionId: string): string {
        return path.join(this.getSummariesFolder(sessionId), 'execution_summary.md');
    }

    /**
     * Ensure all directories for a plan session exist
     */
    ensurePlanDirectories(sessionId: string): void {
        const dirs = [
            this.getPlanFolder(sessionId),
            this.getCompletionsFolder(sessionId),
            this.getLogsFolder(sessionId),
            this.getEngineerLogsFolder(sessionId),
            this.getSummariesFolder(sessionId)
        ];

        for (const dir of dirs) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }
    }

    async initialize(): Promise<void> {
        // Ensure directories exist
        await this.ensureDirectories();
        
        // Load existing state from files
        this.loadStateFromFilesSync();
        
        console.log(`StateManager initialized. Found ${this.planningSessions.size} sessions, ${this.coordinators.size} coordinators`);
    }

    private async ensureDirectories(): Promise<void> {
        // Only create base directories - plan-specific dirs created when sessions are created
        const dirs = [
            this.workingDir,
            path.join(this.workingDir, 'Plans'),
            path.join(this.workingDir, 'Docs'),
            path.join(this.workingDir, 'Context')
        ];

        for (const dir of dirs) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }
    }

    private createDefaultEngineerPool(size: number): EngineerPoolState {
        const names = ['Alex', 'Betty', 'Cleo', 'Dany', 'Echo', 'Finn', 'Gwen', 'Hugo', 'Iris', 'Jake',
                       'Kate', 'Liam', 'Mona', 'Noah', 'Olga', 'Pete', 'Quinn', 'Rose', 'Sam', 'Tina'];
        const engineerNames = names.slice(0, size);
        
        return {
            totalEngineers: size,
            engineerNames: engineerNames,
            available: [...engineerNames],
            busy: {}
        };
    }

    /**
     * Public method to reload state from files (used by file watcher)
     * This is called when external processes (CLI, bash scripts) modify state files
     */
    reloadFromFiles(): void {
        // Clear existing state before reloading
        this.planningSessions.clear();
        this.coordinators.clear();
        
        // Load fresh from files (synchronous operations inside)
        this.loadStateFromFilesSync();
        console.log(`StateManager: Reloaded state from files. Found ${this.planningSessions.size} sessions, ${this.coordinators.size} coordinators`);
    }
    
    /**
     * Synchronous version of loadStateFromFiles for reloading
     */
    private loadStateFromFilesSync(): void {
        // Load extension state
        const extensionStatePath = path.join(this.workingDir, '.extension_state.json');
        if (fs.existsSync(extensionStatePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(extensionStatePath, 'utf-8'));
                this.extensionState = { ...this.extensionState, ...data };
            } catch (e) {
                console.error('Failed to load extension state:', e);
            }
        }

        // Load engineer pool state
        const poolStatePath = path.join(this.workingDir, '.engineer_pool.json');
        if (fs.existsSync(poolStatePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(poolStatePath, 'utf-8'));
                this.engineerPoolState = data;
            } catch (e) {
                console.error('Failed to load engineer pool state:', e);
            }
        }

        // Load planning sessions and coordinators from plan folder structure
        const plansDir = path.join(this.workingDir, 'Plans');
        if (fs.existsSync(plansDir)) {
            const planFolders = fs.readdirSync(plansDir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);

            console.log(`StateManager: Found plan folders: ${planFolders.join(', ')}`);

            for (const sessionId of planFolders) {
                const planFolder = path.join(plansDir, sessionId);
                
                // Load session state
                const sessionFile = path.join(planFolder, 'session.json');
                if (fs.existsSync(sessionFile)) {
                try {
                        const data = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
                    this.planningSessions.set(data.id, data);
                        console.log(`StateManager: Loaded session ${data.id}`);
                } catch (e) {
                        console.error(`Failed to load planning session ${sessionId}:`, e);
            }
        }

                // Load coordinator state (if exists)
                const coordinatorFile = path.join(planFolder, 'coordinator.json');
                if (fs.existsSync(coordinatorFile)) {
                try {
                        const data = JSON.parse(fs.readFileSync(coordinatorFile, 'utf-8'));
                    this.coordinators.set(data.id, data);
                } catch (e) {
                        console.error(`Failed to load coordinator for ${sessionId}:`, e);
                    }
                }
            }
        }
    }

    async updateStateFiles(): Promise<void> {
        // Update extension state
        const extensionStatePath = path.join(this.workingDir, '.extension_state.json');
        this.extensionState.activePlanningSessions = Array.from(this.planningSessions.keys())
            .filter(id => {
                const session = this.planningSessions.get(id);
                return session && ['debating', 'reviewing', 'revising'].includes(session.status);
            });
        this.extensionState.activeCoordinators = Array.from(this.coordinators.keys())
            .filter(id => {
                const coord = this.coordinators.get(id);
                return coord && ['initializing', 'running', 'paused'].includes(coord.status);
            });
        fs.writeFileSync(extensionStatePath, JSON.stringify(this.extensionState, null, 2));

        // Update engineer pool state
        const poolStatePath = path.join(this.workingDir, '.engineer_pool.json');
        fs.writeFileSync(poolStatePath, JSON.stringify(this.engineerPoolState, null, 2));

        // Update individual planning sessions and coordinators (in plan folders)
        for (const [id, session] of this.planningSessions) {
            this.ensurePlanDirectories(id);
            const sessionPath = this.getSessionFilePath(id);
            fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
        }

        for (const [id, coordinator] of this.coordinators) {
            // Coordinators are stored in their session's folder
            if (coordinator.planSessionId) {
                this.ensurePlanDirectories(coordinator.planSessionId);
                const coordPath = this.getCoordinatorFilePath(coordinator.planSessionId);
            fs.writeFileSync(coordPath, JSON.stringify(coordinator, null, 2));
            }
        }
    }

    // ========================================================================
    // Getters
    // ========================================================================

    getWorkingDir(): string {
        return this.workingDir;
    }

    getWorkspaceRoot(): string {
        return this.workspaceRoot;
    }

    getGlobalSettings(): GlobalSettings {
        return this.extensionState.globalSettings;
    }

    getEngineerPoolState(): EngineerPoolState {
        return this.engineerPoolState;
    }

    getPlanningSession(id: string): PlanningSession | undefined {
        return this.planningSessions.get(id);
    }

    getAllPlanningSessions(): PlanningSession[] {
        return Array.from(this.planningSessions.values());
    }

    getCoordinator(id: string): CoordinatorState | undefined {
        return this.coordinators.get(id);
    }

    getAllCoordinators(): CoordinatorState[] {
        return Array.from(this.coordinators.values());
    }

    async getApprovedPlans(): Promise<PlanInfo[]> {
        const approvedSessions = Array.from(this.planningSessions.values())
            .filter(s => s.status === 'approved' && s.currentPlanPath);
        
        return approvedSessions.map(s => ({
            title: s.requirement.substring(0, 50) + (s.requirement.length > 50 ? '...' : ''),
            path: s.currentPlanPath!,
            sessionId: s.id,
            status: s.status
        }));
    }

    async getActiveCoordinators(): Promise<CoordinatorState[]> {
        return Array.from(this.coordinators.values())
            .filter(c => ['initializing', 'running', 'paused'].includes(c.status));
    }

    // ========================================================================
    // Setters / Mutators
    // ========================================================================

    updateEngineerPool(state: EngineerPoolState): void {
        this.engineerPoolState = state;
    }

    savePlanningSession(session: PlanningSession): void {
        this.planningSessions.set(session.id, session);
        // Ensure plan directories exist and persist to disk
        this.ensurePlanDirectories(session.id);
        const sessionPath = this.getSessionFilePath(session.id);
        fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
    }

    saveCoordinator(coordinator: CoordinatorState): void {
        this.coordinators.set(coordinator.id, coordinator);
        // Save coordinator in its session's folder
        if (coordinator.planSessionId) {
            this.ensurePlanDirectories(coordinator.planSessionId);
            const coordPath = this.getCoordinatorFilePath(coordinator.planSessionId);
            fs.writeFileSync(coordPath, JSON.stringify(coordinator, null, 2));
        }
    }

    deletePlanningSession(id: string): void {
        this.planningSessions.delete(id);
        // Note: Plan folder deletion is handled by PlanningService.removeSession()
        // This just removes from in-memory state
    }

    deleteCoordinator(id: string): void {
        const coordinator = this.coordinators.get(id);
        this.coordinators.delete(id);
        // Coordinator file is in session folder - don't delete the whole folder
        if (coordinator?.planSessionId) {
            const coordPath = this.getCoordinatorFilePath(coordinator.planSessionId);
        if (fs.existsSync(coordPath)) {
            fs.unlinkSync(coordPath);
            }
        }
    }

    // ========================================================================
    // ID Generation
    // ========================================================================

    /**
     * Generate coordinator ID with hash-style format
     * Format: coord_XXXXXXXX (8 random alphanumeric characters)
     * Each new coordinator gets a unique hash ID
     */
    generateCoordinatorId(_planSessionId?: string): string {
        // Generate random 8-character alphanumeric hash
        const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
        let hash = '';
        for (let i = 0; i < 8; i++) {
            hash += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return `coord_${hash}`;
            }

    /**
     * Generate incremental session ID for an engineer
     * Format: engineername_000001, engineername_000002, etc.
     * Looks across all plan folders for existing sessions
     */
    generateSessionId(engineerName: string): string {
        let count = 1;
        
        // Scan all plan folders for engineer logs
        const plansDir = path.join(this.workingDir, 'Plans');
        if (fs.existsSync(plansDir)) {
            const pattern = new RegExp(`^${engineerName}_\\d{6}\\.log$`, 'i');
            
            const planFolders = fs.readdirSync(plansDir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);
            
            for (const sessionId of planFolders) {
                const logsDir = this.getEngineerLogsFolder(sessionId);
        if (fs.existsSync(logsDir)) {
            const existingLogs = fs.readdirSync(logsDir).filter(f => pattern.test(f));
            
            for (const log of existingLogs) {
                        const match = log.match(/_(\d{6})\.log$/);
                if (match) {
                    const num = parseInt(match[1], 10);
                    if (num >= count) {
                        count = num + 1;
                    }
                        }
                    }
                }
            }
        }
        
        return `${engineerName.toLowerCase()}_${count.toString().padStart(6, '0')}`;
    }

    /**
     * Generate planning session ID
     * Format: ps_000001, ps_000002, etc.
     */
    generatePlanningSessionId(): string {
        // Find the highest existing session number
        let count = 0;
        
        const plansDir = path.join(this.workingDir, 'Plans');
        if (fs.existsSync(plansDir)) {
            const planFolders = fs.readdirSync(plansDir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);
            
            for (const folder of planFolders) {
                const match = folder.match(/^ps_(\d{6})$/);
                if (match) {
                    const num = parseInt(match[1], 10);
                    if (num > count) {
                        count = num;
                    }
                }
            }
        }
        
        return `ps_${(count + 1).toString().padStart(6, '0')}`;
    }
}










