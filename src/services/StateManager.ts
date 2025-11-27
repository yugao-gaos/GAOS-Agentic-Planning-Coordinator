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

    async initialize(): Promise<void> {
        // Ensure directories exist
        await this.ensureDirectories();
        
        // Load existing state from files
        await this.loadStateFromFiles();
        
        console.log('StateManager initialized');
    }

    private async ensureDirectories(): Promise<void> {
        const dirs = [
            this.workingDir,
            path.join(this.workingDir, 'Plans'),
            path.join(this.workingDir, 'Logs'),
            path.join(this.workingDir, 'Logs', 'engineers'),
            path.join(this.workingDir, 'planning_sessions'),
            path.join(this.workingDir, 'coordinators')
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

    private async loadStateFromFiles(): Promise<void> {
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

        // Load planning sessions
        const sessionsDir = path.join(this.workingDir, 'planning_sessions');
        if (fs.existsSync(sessionsDir)) {
            const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
            for (const file of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf-8'));
                    this.planningSessions.set(data.id, data);
                } catch (e) {
                    console.error(`Failed to load planning session ${file}:`, e);
                }
            }
        }

        // Load coordinators
        const coordinatorsDir = path.join(this.workingDir, 'coordinators');
        if (fs.existsSync(coordinatorsDir)) {
            const files = fs.readdirSync(coordinatorsDir).filter(f => f.endsWith('.json'));
            for (const file of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(coordinatorsDir, file), 'utf-8'));
                    this.coordinators.set(data.id, data);
                } catch (e) {
                    console.error(`Failed to load coordinator ${file}:`, e);
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

        // Update individual planning sessions
        for (const [id, session] of this.planningSessions) {
            const sessionPath = path.join(this.workingDir, 'planning_sessions', `${id}.json`);
            fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
        }

        // Update individual coordinators
        for (const [id, coordinator] of this.coordinators) {
            const coordPath = path.join(this.workingDir, 'coordinators', `${id}.json`);
            fs.writeFileSync(coordPath, JSON.stringify(coordinator, null, 2));
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
    }

    saveCoordinator(coordinator: CoordinatorState): void {
        this.coordinators.set(coordinator.id, coordinator);
    }

    deletePlanningSession(id: string): void {
        this.planningSessions.delete(id);
        const sessionPath = path.join(this.workingDir, 'planning_sessions', `${id}.json`);
        if (fs.existsSync(sessionPath)) {
            fs.unlinkSync(sessionPath);
        }
    }

    deleteCoordinator(id: string): void {
        this.coordinators.delete(id);
        const coordPath = path.join(this.workingDir, 'coordinators', `${id}.json`);
        if (fs.existsSync(coordPath)) {
            fs.unlinkSync(coordPath);
        }
    }

    // ========================================================================
    // ID Generation
    // ========================================================================

    generatePlanningSessionId(): string {
        const count = this.planningSessions.size + 1;
        return `ps_${count.toString().padStart(3, '0')}`;
    }

    generateCoordinatorId(): string {
        const count = this.coordinators.size + 1;
        return `coord_${count.toString().padStart(3, '0')}`;
    }

    generateSessionId(engineerName: string): string {
        const timestamp = Date.now().toString(36);
        const random = Math.random().toString(36).substring(2, 6);
        return `${engineerName.toLowerCase()}_${timestamp}_${random}`;
    }
}

