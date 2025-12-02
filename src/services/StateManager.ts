import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
    ExtensionState,
    AgentPoolState,
    PlanningSession,
    PlanInfo,
    GlobalSettings
} from '../types';
import { getMemoryMonitor } from './MemoryMonitor';
import { FolderStructureManager, getFolderStructureManager } from './FolderStructureManager';

/**
 * Configuration interface for StateManager initialization.
 * This replaces vscode.ExtensionContext and vscode.workspace.getConfiguration().
 * 
 * When running in VS Code, the extension creates this from vscode settings.
 * When running in daemon mode, this comes from DaemonConfig.
 */
export interface StateManagerConfig {
    /** Workspace root path */
    workspaceRoot: string;
    /** Working directory relative to workspace (default: '_AiDevLog') */
    workingDirectory?: string;
    /** Agent pool size (default: 10) */
    agentPoolSize?: number;
    /** Default AI backend (default: 'cursor') */
    defaultBackend?: 'cursor' | 'claude-code' | 'codex';
}

/**
 * Async Mutex - proper in-process mutex with queuing
 * This prevents race conditions between concurrent async operations
 */
class AsyncMutex {
    private locked: boolean = false;
    private queue: Array<() => void> = [];

    /**
     * Acquire the mutex. Returns a release function.
     * If mutex is already held, waits in queue until available.
     */
    async acquire(): Promise<() => void> {
        return new Promise((resolve) => {
            const tryAcquire = () => {
                if (!this.locked) {
                    this.locked = true;
                    resolve(() => this.release());
                } else {
                    this.queue.push(tryAcquire);
                }
            };
            tryAcquire();
        });
    }

    /**
     * Release the mutex and wake next waiter
     */
    private release(): void {
        this.locked = false;
        const next = this.queue.shift();
        if (next) {
            next();
        }
    }

    /**
     * Check if mutex is currently held
     */
    isLocked(): boolean {
        return this.locked;
    }
}

/**
 * File-based lock for cross-process synchronization
 * Used in combination with AsyncMutex for full protection
 */
class FileLock {
    private lockPath: string;
    private lockHeld: boolean = false;
    private readonly LOCK_TIMEOUT_MS = 5000;  // 5 second timeout
    private readonly RETRY_INTERVAL_MS = 50;   // 50ms between retries

    constructor(basePath: string) {
        this.lockPath = `${basePath}.lock`;
    }

    /**
     * Acquire lock with timeout
     * Returns true if lock acquired, false if timed out
     */
    async acquire(): Promise<boolean> {
        const startTime = Date.now();
        
        while (Date.now() - startTime < this.LOCK_TIMEOUT_MS) {
            try {
                // Try to create lock file exclusively
                const fd = fs.openSync(this.lockPath, 'wx');
                fs.writeSync(fd, `${process.pid}\n${Date.now()}`);
                fs.closeSync(fd);
                this.lockHeld = true;
                return true;
            } catch (e: any) {
                if (e.code === 'EEXIST') {
                    // Lock exists - check if stale (older than timeout)
                    try {
                        const stat = fs.statSync(this.lockPath);
                        const lockAge = Date.now() - stat.mtimeMs;
                        if (lockAge > this.LOCK_TIMEOUT_MS) {
                            // Stale lock - remove and retry
                            fs.unlinkSync(this.lockPath);
                            continue;
                        }
                    } catch (e) {
                        // Stat failed, file may have been deleted - continue to retry
                        console.debug('[FileLock] Stat failed during lock check:', e);
                        continue;
                    }
                    // Wait before retry
                    await new Promise(resolve => setTimeout(resolve, this.RETRY_INTERVAL_MS));
                } else {
                    // Other error - give up
                    console.error('Lock acquire error:', e);
                    return false;
                }
            }
        }
        
        console.warn(`Lock acquisition timed out for ${this.lockPath}`);
        return false;
    }

    /**
     * Release the lock
     */
    release(): void {
        if (this.lockHeld) {
            try {
                fs.unlinkSync(this.lockPath);
            } catch (e) {
                // Ignore - lock may have been force-removed
            }
            this.lockHeld = false;
        }
    }
}

/**
 * Atomic file write - writes to temp file then renames (sync version)
 * This prevents partial writes from corrupting state
 */
export function atomicWriteFileSync(filePath: string, data: string): void {
    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    try {
        fs.writeFileSync(tempPath, data, { encoding: 'utf-8' });
        // Rename is atomic on most filesystems
        fs.renameSync(tempPath, filePath);
    } catch (e) {
        // Clean up temp file on error
        try {
            fs.unlinkSync(tempPath);
        } catch (cleanupError) {
            console.debug('[StateManager] Cleanup error (non-fatal):', cleanupError);
        }
        throw e;
    }
}

/**
 * Atomic file write - async version with promises
 * Uses temp file + rename for atomicity
 */
async function atomicWriteFile(filePath: string, data: string): Promise<void> {
    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    try {
        await fs.promises.writeFile(tempPath, data, { encoding: 'utf-8' });
        await fs.promises.rename(tempPath, filePath);
    } catch (e) {
        // Clean up temp file on error
        try {
            await fs.promises.unlink(tempPath);
        } catch (cleanupError) {
            console.debug('[StateManager] Async cleanup error (non-fatal):', cleanupError);
        }
        throw e;
    }
}

/** 
 * Debounce interval for batched writes (ms)
 */
const WRITE_DEBOUNCE_MS = 100;

export class StateManager {
    private workspaceRoot: string;
    private workingDir: string;
    private folderStructure: FolderStructureManager;
    private extensionState: ExtensionState;
    private agentPoolState: AgentPoolState;
    private planningSessions: Map<string, PlanningSession> = new Map();
    
    // Async mutex for in-process synchronization (prevents race conditions)
    private asyncMutex: AsyncMutex = new AsyncMutex();
    // File lock for cross-process synchronization (CLI, external tools)
    private fileLock: FileLock | null = null;
    // Counter to track active write operations (for reload skip logic)
    private writeOperationId: number = 0;
    
    // Debounced write queue for batching multiple writes
    private pendingWrites: Map<string, { data: string; resolvers: Array<{ resolve: () => void; reject: (e: Error) => void }> }> = new Map();
    private writeDebounceTimer: NodeJS.Timeout | null = null;
    private isFlushingWrites: boolean = false;

    /**
     * Create a StateManager with configuration.
     * 
     * @param config Configuration object (replaces vscode.ExtensionContext)
     * 
     * For VS Code mode, create config from vscode settings:
     * ```typescript
     * const vsConfig = vscode.workspace.getConfiguration('agenticPlanning');
     * const stateManager = new StateManager({
     *     workspaceRoot: vscode.workspace.workspaceFolders[0].uri.fsPath,
     *     workingDirectory: vsConfig.get('workingDirectory', '_AiDevLog'),
     *     agentPoolSize: vsConfig.get('agentPoolSize', 5),
     *     defaultBackend: vsConfig.get('defaultBackend', 'cursor')
     * });
     * ```
     * 
     * For daemon mode, use CoreConfig directly.
     */
    constructor(config: StateManagerConfig) {
        this.workspaceRoot = config.workspaceRoot;
        
        // Use provided values or defaults
        const workingDirectory = config.workingDirectory || '_AiDevLog';
        const agentPoolSize = config.agentPoolSize ?? 10;
        const defaultBackend = config.defaultBackend || 'cursor';
        
        this.workingDir = path.join(this.workspaceRoot, workingDirectory);
        
        // Initialize folder structure manager
        this.folderStructure = getFolderStructureManager(this.workingDir);
        
        // Initialize file lock for cross-process state operations
        // Use temp directory to avoid polluting workspace
        const lockDir = path.join(os.tmpdir(), 'apc_locks');
        if (!fs.existsSync(lockDir)) {
            fs.mkdirSync(lockDir, { recursive: true });
        }
        // Hash workspace root for unique lock per project
        const workspaceHash = crypto.createHash('md5').update(this.workspaceRoot).digest('hex').substring(0, 16);
        this.fileLock = new FileLock(path.join(lockDir, `state_${workspaceHash}`));
        
        // Initialize with defaults
        this.extensionState = {
            globalSettings: {
                agentPoolSize: agentPoolSize,
                defaultBackend: defaultBackend,
                workingDirectory: this.workingDir
            },
            activePlanningSessions: []
        };

        this.agentPoolState = this.createDefaultAgentPool(this.extensionState.globalSettings.agentPoolSize);
        
        // Register with memory monitor
        const memMonitor = getMemoryMonitor();
        memMonitor.registerService('StateManager', () => ({
            sessionCount: this.planningSessions.size,
            pendingWrites: this.pendingWrites.size,
            agentPoolSize: this.agentPoolState.totalAgents
        }));
    }

    /**
     * Get the current agent pool size from settings
     */
    getPoolSize(): number {
        return this.extensionState.globalSettings.agentPoolSize;
    }

    // ========================================================================
    // Path Helpers - All paths relative to plan folder structure
    // ========================================================================

    /**
     * Get the base folder for a planning session
     * Structure: {workingDir}/{plans}/{sessionId}/
     * Uses FolderStructureManager for customizable folder names
     */
    getPlanFolder(sessionId: string): string {
        return path.join(this.workingDir, this.folderStructure.getFolder('plans'), sessionId);
    }

    /**
     * Get the plan file path for a session
     * Structure: {workingDir}/{plans}/{sessionId}/plan.md
     */
    getPlanFilePath(sessionId: string): string {
        return path.join(this.getPlanFolder(sessionId), 'plan.md');
    }

    /**
     * Get the session state file path
     * Structure: {workingDir}/{plans}/{sessionId}/session.json
     */
    getSessionFilePath(sessionId: string): string {
        return path.join(this.getPlanFolder(sessionId), 'session.json');
    }

    /**
     * Get the backups folder for a session
     * Structure: {workingDir}/{plans}/{sessionId}/backups/
     * 
     * Used for plan revision backups to keep plan folder clean.
     */
    getBackupsFolder(sessionId: string): string {
        return path.join(this.getPlanFolder(sessionId), 'backups');
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
     * Structure: _AiDevLog/Plans/{sessionId}/logs/agents/
     */
    getAgentLogsFolder(sessionId: string): string {
        return path.join(this.getLogsFolder(sessionId), 'agents');
    }
    
    /**
     * Get the coordinator log file path (per-session workflow log)
     * Structure: _AiDevLog/Plans/{sessionId}/logs/coordinator.log
     */
    getCoordinatorLogPath(sessionId: string): string {
        return path.join(this.getLogsFolder(sessionId), 'coordinator.log');
    }
    
    /**
     * Get the global coordinator logs folder
     * Structure: _AiDevLog/Logs/Coordinator/
     * 
     * Coordinator evaluation logs are global (not session-specific) because:
     * - The coordinator manages tasks across ALL sessions
     * - Evaluation logs should be easily accessible for debugging
     * - Keeps per-session folders focused on session-specific data
     */
    getGlobalCoordinatorLogsFolder(): string {
        return path.join(this.folderStructure.getFolderPath('logs'), 'Coordinator');
    }
    
    // ========================================================================
    // Per-Plan Tasks Paths
    // ========================================================================
    
    /**
     * Get the session tasks folder
     * Structure: {workingDir}/{plans}/{sessionId}/
     */
    getSessionTasksFolder(sessionId: string): string {
        return this.getPlanFolder(sessionId);
    }
    
    /**
     * Get the session tasks file path
     * Structure: {workingDir}/{plans}/{sessionId}/tasks.json
     */
    getSessionTasksFilePath(sessionId: string): string {
        return path.join(this.getPlanFolder(sessionId), 'tasks.json');
    }

    /**
     * Ensure all directories for a plan session exist
     * 
     * Structure:
     * - {plans}/{sessionId}/           - Root plan folder
     * - {plans}/{sessionId}/logs/      - Workflow and agent logs
     * - {plans}/{sessionId}/logs/agents/ - Individual agent logs
     * - {plans}/{sessionId}/backups/   - Plan revision backups
     */
    ensurePlanDirectories(sessionId: string): void {
        const dirs = [
            this.getPlanFolder(sessionId),
            this.getLogsFolder(sessionId),
            this.getAgentLogsFolder(sessionId),
            this.getBackupsFolder(sessionId)
        ];

        for (const dir of dirs) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }
    }

    async initialize(): Promise<void> {
        // Ensure directories exist (includes migration of old files)
        await this.ensureDirectories();
        
        // Load existing state from files
        this.loadStateFromFilesSync();
        
        console.log(`StateManager initialized. Found ${this.planningSessions.size} sessions`);
    }

    private async ensureDirectories(): Promise<void> {
        // Use folder structure manager to create all required directories
        this.folderStructure.ensureAllFolders();
        
        // Also ensure .config subdirectories
        const configDir = this.folderStructure.getFolderPath('config');
        const configSubDirs = [
            path.join(configDir, 'roles'),
            path.join(configDir, 'system_prompts')
        ];
        
        for (const dir of configSubDirs) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }
        
        // Migrate old files to new locations if they exist
        this.migrateOldFiles();
    }
    
    /**
     * Migrate files from old locations to new structure
     */
    private migrateOldFiles(): void {
        const migrations: Array<{ old: string; new: string }> = [
            { old: '.extension_state.json', new: '.cache/extension_state.json' },
            { old: '.agent_pool.json', new: '.cache/agent_pool.json' },
            { old: '.apc_config.json', new: '.cache/apc_config.json' },
        ];
        
        for (const { old: oldRel, new: newRel } of migrations) {
            const oldPath = path.join(this.workingDir, oldRel);
            const newPath = path.join(this.workingDir, newRel);
            
            if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
                try {
                    fs.renameSync(oldPath, newPath);
                    console.log(`StateManager: Migrated ${oldRel} → ${newRel}`);
                } catch (e) {
                    console.warn(`StateManager: Failed to migrate ${oldRel}:`, e);
                }
            }
        }
        
        // Migrate Roles/ → .config/roles/
        const oldRolesDir = path.join(this.workingDir, 'Roles');
        const newRolesDir = path.join(this.workingDir, '.config', 'roles');
        if (fs.existsSync(oldRolesDir) && fs.readdirSync(oldRolesDir).length > 0) {
            try {
                const files = fs.readdirSync(oldRolesDir);
                for (const file of files) {
                    const oldFile = path.join(oldRolesDir, file);
                    const newFile = path.join(newRolesDir, file);
                    if (!fs.existsSync(newFile)) {
                        fs.renameSync(oldFile, newFile);
                    }
                }
                console.log(`StateManager: Migrated Roles/ → .config/roles/`);
            } catch (e) {
                console.warn('StateManager: Failed to migrate Roles/:', e);
            }
        }
        
        // Migrate SystemPrompts/ → .config/prompts/
        const oldPromptsDir = path.join(this.workingDir, 'SystemPrompts');
        const newPromptsDir = path.join(this.workingDir, '.config', 'prompts');
        if (fs.existsSync(oldPromptsDir) && fs.readdirSync(oldPromptsDir).length > 0) {
            try {
                const files = fs.readdirSync(oldPromptsDir);
                for (const file of files) {
                    const oldFile = path.join(oldPromptsDir, file);
                    const newFile = path.join(newPromptsDir, file);
                    if (!fs.existsSync(newFile)) {
                        fs.renameSync(oldFile, newFile);
                    }
                }
                console.log(`StateManager: Migrated SystemPrompts/ → .config/prompts/`);
            } catch (e) {
                console.warn('StateManager: Failed to migrate SystemPrompts/:', e);
            }
        }
    }

    private createDefaultAgentPool(size: number): AgentPoolState {
        const names = ['Alex', 'Betty', 'Cleo', 'Dany', 'Echo', 'Finn', 'Gwen', 'Hugo', 'Iris', 'Jake',
                       'Kate', 'Liam', 'Mona', 'Noah', 'Olga', 'Pete', 'Quinn', 'Rose', 'Sam', 'Tina'];
        const agentNames = names.slice(0, size);
        
        return {
            totalAgents: size,
            agentNames: agentNames,
            available: [...agentNames],
            allocated: {},  // NEW: Agent bench
            busy: {}
        };
    }

    /**
     * Migrate agent pool state from old format to new 3-state format
     */
    private migrateAgentPoolState(state: any): AgentPoolState {
        // Add allocated field if missing
        if (!state.allocated) {
            state.allocated = {};
        }
        
        // Remove coordinatorId from busy agents (legacy field)
        if (state.busy) {
            for (const agentInfo of Object.values(state.busy)) {
                const agentInfoAny = agentInfo as any;
                if ('coordinatorId' in agentInfoAny) {
                    delete agentInfoAny.coordinatorId;
                }
                // Ensure workflowId is present (required field now)
                if (!agentInfoAny.workflowId) {
                    console.warn('[StateManager] Migrating busy agent without workflowId - setting to "unknown"');
                    (agentInfo as any).workflowId = 'unknown';
                }
            }
        }
        
        return state as AgentPoolState;
    }

    /**
     * Public method to reload state from files (used by file watcher)
     * This is called when external processes (CLI, bash scripts) modify state files
     * 
     * IMPORTANT: This method is protected against race conditions:
     * - Uses AsyncMutex to prevent concurrent in-process access
     * - Uses FileLock to prevent concurrent cross-process access
     * - Tracks write operations to skip unnecessary reloads
     */
    async reloadFromFiles(): Promise<void> {
        // Capture current write operation ID before acquiring mutex
        const currentWriteId = this.writeOperationId;
        
        // Acquire in-process mutex first (queues if another operation is in progress)
        const releaseMutex = await this.asyncMutex.acquire();
        
        try {
            // Check if a write operation started while we were waiting
            // If so, skip reload as the write will have fresher data
            if (this.writeOperationId !== currentWriteId) {
                console.log('StateManager: Skipping reload - write operation occurred while waiting');
                return;
            }
            
            // Try to acquire cross-process file lock
            if (this.fileLock && !(await this.fileLock.acquire())) {
                console.warn('StateManager: Skipping reload - could not acquire file lock');
                return;
            }
            
            try {
                // Clear existing state before reloading
                this.planningSessions.clear();
                
                // Load fresh from files
                this.loadStateFromFilesSync();
                console.log(`StateManager: Reloaded state from files. Found ${this.planningSessions.size} sessions`);
            } finally {
                this.fileLock?.release();
            }
        } finally {
            releaseMutex();
        }
    }
    
    // ========================================================================
    // Cache File Paths (runtime state)
    // ========================================================================
    
    private getCachePath(filename: string): string {
        return path.join(this.workingDir, '.cache', filename);
    }
    
    private getConfigPath(...parts: string[]): string {
        return path.join(this.workingDir, '.config', ...parts);
    }
    
    /**
     * Synchronous version of loadStateFromFiles for reloading
     */
    private loadStateFromFilesSync(): void {
        // Load extension state from .cache/
        const extensionStatePath = this.getCachePath('extension_state.json');
        if (fs.existsSync(extensionStatePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(extensionStatePath, 'utf-8'));
                this.extensionState = { ...this.extensionState, ...data };
            } catch (e) {
                console.error('Failed to load extension state:', e);
            }
        }

        // Load agent pool state from .cache/
        const poolStatePath = this.getCachePath('agent_pool.json');
        if (fs.existsSync(poolStatePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(poolStatePath, 'utf-8'));
                this.agentPoolState = this.migrateAgentPoolState(data);
            } catch (e) {
                console.error('Failed to load agent pool state:', e);
            }
        }

        // Load planning sessions from plan folder structure
        // Only load non-completed sessions into memory to reduce memory footprint
        const plansDir = this.folderStructure.getFolderPath('plans');
        if (fs.existsSync(plansDir)) {
            const planFolders = fs.readdirSync(plansDir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);

            console.log(`StateManager: Found plan folders: ${planFolders.join(', ')}`);

            let loadedCount = 0;
            let skippedCount = 0;
            for (const sessionId of planFolders) {
                const planFolder = path.join(plansDir, sessionId);
                
                // Load session state
                const sessionFile = path.join(planFolder, 'session.json');
                if (fs.existsSync(sessionFile)) {
                try {
                        const data = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
                        
                        // Only load non-completed sessions into memory
                        if (data.status !== 'completed') {
                            this.planningSessions.set(data.id, data);
                            loadedCount++;
                            console.log(`StateManager: Loaded session ${data.id} (${data.status})`);
                        } else {
                            skippedCount++;
                            console.log(`StateManager: Skipped completed session ${data.id} (stays on disk)`);
                        }
                } catch (e) {
                        console.error(`Failed to load planning session ${sessionId}:`, e);
            }
        }
            }
            console.log(`StateManager: Loaded ${loadedCount} active sessions, skipped ${skippedCount} completed sessions`);
        }
    }

    async updateStateFiles(): Promise<void> {
        // Acquire in-process mutex first (queues if another operation is in progress)
        const releaseMutex = await this.asyncMutex.acquire();
        
        // Increment write operation ID to signal pending reloads to skip
        this.writeOperationId++;
        
        try {
            // Acquire cross-process file lock
            if (this.fileLock && !(await this.fileLock.acquire())) {
                console.warn('StateManager: Could not acquire file lock for state update');
                return;
            }
            
            try {
                // Update extension state in .cache/
                const extensionStatePath = this.getCachePath('extension_state.json');
                this.extensionState.activePlanningSessions = Array.from(this.planningSessions.keys())
                    .filter(id => {
                        const session = this.planningSessions.get(id);
                        // Active sessions are those in planning or approved (execution active) states
                        return session && ['planning', 'reviewing', 'revising', 'approved'].includes(session.status);
                    });
                atomicWriteFileSync(extensionStatePath, JSON.stringify(this.extensionState, null, 2));

                // Update agent pool state in .cache/
                const poolStatePath = this.getCachePath('agent_pool.json');
                atomicWriteFileSync(poolStatePath, JSON.stringify(this.agentPoolState, null, 2));

                // Update individual planning sessions (execution state is now embedded)
                for (const [id, session] of this.planningSessions) {
                    this.ensurePlanDirectories(id);
                    const sessionPath = this.getSessionFilePath(id);
                    atomicWriteFileSync(sessionPath, JSON.stringify(session, null, 2));
                }
            } finally {
                this.fileLock?.release();
            }
        } finally {
            releaseMutex();
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

    getAgentPoolState(): AgentPoolState {
        return this.agentPoolState;
    }

    getPlanningSession(id: string): PlanningSession | undefined {
        // Check memory first
        const inMemory = this.planningSessions.get(id);
        if (inMemory) {
            return inMemory;
        }
        
        // If not in memory, try loading from disk (for completed sessions)
        return this.loadSessionFromDisk(id);
    }
    
    /**
     * Load a specific session from disk without adding to memory
     * Used for completed sessions that aren't kept in memory
     */
    loadSessionFromDisk(sessionId: string): PlanningSession | undefined {
        try {
            const sessionFile = path.join(this.getPlanFolder(sessionId), 'session.json');
            if (fs.existsSync(sessionFile)) {
                const data = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
                return data as PlanningSession;
            }
        } catch (e) {
            console.error(`Failed to load session ${sessionId} from disk:`, e);
        }
        return undefined;
    }
    
    /**
     * Get list of completed session IDs from disk
     * Used by UI to show history without loading all sessions into memory
     */
    getCompletedSessionIds(): string[] {
        const completedIds: string[] = [];
        try {
            const plansDir = this.folderStructure.getFolderPath('plans');
            if (fs.existsSync(plansDir)) {
                const planFolders = fs.readdirSync(plansDir, { withFileTypes: true })
                    .filter(d => d.isDirectory())
                    .map(d => d.name);
                
                for (const sessionId of planFolders) {
                    const sessionFile = path.join(plansDir, sessionId, 'session.json');
                    if (fs.existsSync(sessionFile)) {
                        try {
                            const data = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
                            if (data.status === 'completed') {
                                completedIds.push(sessionId);
                            }
                        } catch (e) {
                            // Skip invalid session files
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Failed to get completed session IDs:', e);
        }
        return completedIds;
    }

    getAllPlanningSessions(): PlanningSession[] {
        return Array.from(this.planningSessions.values());
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

    /**
     * Get sessions that are currently executing
     */
    /**
     * Get sessions that are approved and have active execution
     * (sessions where task workflows may be running)
     */
    getExecutingSessions(): PlanningSession[] {
        return Array.from(this.planningSessions.values())
            .filter(s => s.status === 'approved' && s.execution);
    }

    // ========================================================================
    // Setters / Mutators
    // ========================================================================

    updateAgentPool(state: AgentPoolState): void {
        this.agentPoolState = state;
    }

    /**
     * Save a planning session to disk (sync version)
     * Note: This queues an async write for actual persistence.
     * The in-memory state is updated immediately for consistency.
     */
    savePlanningSession(session: PlanningSession): void {
        this.planningSessions.set(session.id, session);
        // Signal that a write is happening
        this.writeOperationId++;
        // Ensure plan directories exist
        this.ensurePlanDirectories(session.id);
        // Queue async write (non-blocking)
        this.queueWrite(
            this.getSessionFilePath(session.id),
            JSON.stringify(session, null, 2)
        ).catch(e => console.error(`Failed to save session ${session.id}:`, e));
    }
    
    /**
     * Save a planning session to disk (async version)
     * Returns a promise that resolves when the write is complete.
     */
    async savePlanningSessionAsync(session: PlanningSession): Promise<void> {
        this.planningSessions.set(session.id, session);
        this.writeOperationId++;
        this.ensurePlanDirectories(session.id);
        await this.queueWrite(
            this.getSessionFilePath(session.id),
            JSON.stringify(session, null, 2)
        );
    }
    
    /**
     * Queue a write for debounced execution
     * Multiple writes to the same file within WRITE_DEBOUNCE_MS are batched.
     */
    private queueWrite(filePath: string, data: string): Promise<void> {
        return new Promise((resolve, reject) => {
            // Get or create pending write entry
            let entry = this.pendingWrites.get(filePath);
            if (entry) {
                // Update data to latest, add resolver
                entry.data = data;
                entry.resolvers.push({ resolve, reject });
            } else {
                this.pendingWrites.set(filePath, {
                    data,
                    resolvers: [{ resolve, reject }]
                });
            }
            
            // Reset debounce timer
            if (this.writeDebounceTimer) {
                clearTimeout(this.writeDebounceTimer);
            }
            
            this.writeDebounceTimer = setTimeout(() => {
                this.flushWrites();
            }, WRITE_DEBOUNCE_MS);
        });
    }
    
    /**
     * Flush all pending writes
     */
    private async flushWrites(): Promise<void> {
        if (this.isFlushingWrites) return;
        this.isFlushingWrites = true;
        
        try {
            // Copy and clear pending writes
            const writes = new Map(this.pendingWrites);
            this.pendingWrites.clear();
            
            // Execute all writes in parallel
            const writePromises = Array.from(writes.entries()).map(async ([filePath, entry]) => {
                try {
                    await atomicWriteFile(filePath, entry.data);
                    // Resolve all waiting promises
                    for (const { resolve } of entry.resolvers) {
                        resolve();
                    }
                } catch (e) {
                    // Reject all waiting promises
                    for (const { reject } of entry.resolvers) {
                        reject(e as Error);
                    }
                }
            });
            
            await Promise.all(writePromises);
        } finally {
            this.isFlushingWrites = false;
            
            // If more writes were queued during flush, schedule another
            if (this.pendingWrites.size > 0) {
                this.writeDebounceTimer = setTimeout(() => {
                    this.flushWrites();
                }, WRITE_DEBOUNCE_MS);
            }
        }
    }

    deletePlanningSession(id: string): void {
        this.planningSessions.delete(id);
        // Note: Plan folder deletion is handled by PlanningService.removeSession()
        // This just removes from in-memory state
    }

    // ========================================================================
    // Paused Workflow Persistence Methods
    // ========================================================================
    
    /**
     * Get the paused workflows folder for a session
     * Structure: _AiDevLog/Plans/{sessionId}/paused_workflows/
     */
    getPausedWorkflowsFolder(sessionId: string): string {
        return path.join(this.getPlanFolder(sessionId), 'paused_workflows');
    }
    
    /**
     * Ensure paused workflows folder exists
     */
    private ensurePausedWorkflowsFolder(sessionId: string): void {
        const folder = this.getPausedWorkflowsFolder(sessionId);
        if (!fs.existsSync(folder)) {
            fs.mkdirSync(folder, { recursive: true });
        }
    }
    
    /**
     * Save a paused workflow state to disk
     */
    savePausedWorkflow(sessionId: string, workflowId: string, state: object): void {
        this.ensurePausedWorkflowsFolder(sessionId);
        const filePath = path.join(this.getPausedWorkflowsFolder(sessionId), `${workflowId}.json`);
        atomicWriteFileSync(filePath, JSON.stringify(state, null, 2));
    }
    
    /**
     * Load a paused workflow state from disk
     */
    loadPausedWorkflow(sessionId: string, workflowId: string): object | null {
        const filePath = path.join(this.getPausedWorkflowsFolder(sessionId), `${workflowId}.json`);
        if (fs.existsSync(filePath)) {
            try {
                return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            } catch (e) {
                console.error(`Failed to load paused workflow ${workflowId}:`, e);
            }
        }
        return null;
    }
    
    /**
     * Load all paused workflow states for a session
     */
    loadAllPausedWorkflows(sessionId: string): Map<string, object> {
        const result = new Map<string, object>();
        const folder = this.getPausedWorkflowsFolder(sessionId);
        
        if (!fs.existsSync(folder)) {
            return result;
        }
        
        try {
            const files = fs.readdirSync(folder).filter(f => f.endsWith('.json'));
            for (const file of files) {
                const workflowId = file.replace('.json', '');
                const state = this.loadPausedWorkflow(sessionId, workflowId);
                if (state) {
                    result.set(workflowId, state);
                }
            }
        } catch (e) {
            console.error(`Failed to load paused workflows for session ${sessionId}:`, e);
        }
        
        return result;
    }
    
    /**
     * Delete a paused workflow state from disk
     */
    deletePausedWorkflow(sessionId: string, workflowId: string): void {
        const filePath = path.join(this.getPausedWorkflowsFolder(sessionId), `${workflowId}.json`);
        if (fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
            } catch (e) {
                console.error(`Failed to delete paused workflow ${workflowId}:`, e);
            }
        }
    }
    
    /**
     * Delete all paused workflow states for a session
     */
    deleteAllPausedWorkflows(sessionId: string): void {
        const folder = this.getPausedWorkflowsFolder(sessionId);
        if (fs.existsSync(folder)) {
            try {
                const files = fs.readdirSync(folder);
                for (const file of files) {
                    fs.unlinkSync(path.join(folder, file));
                }
            } catch (e) {
                console.error(`Failed to delete paused workflows for session ${sessionId}:`, e);
            }
        }
    }

    // ========================================================================
    // Coordinator History Persistence (Plans/{sessionId}/coordinator_history.json)
    // ========================================================================
    
    /**
     * Get the path to coordinator history file for a session
     */
    getCoordinatorHistoryPath(sessionId: string): string {
        return path.join(this.getPlanFolder(sessionId), 'coordinator_history.json');
    }
    
    /**
     * Save coordinator history to disk (async, non-blocking)
     * Called after each coordinator decision to persist the history
     * Uses queued writes to avoid blocking the event loop.
     * 
     * @param sessionId Session ID
     * @param history Array of coordinator history entries
     */
    saveCoordinatorHistory(sessionId: string, history: any[]): void {
        this.ensurePlanDirectories(sessionId);
        const filePath = this.getCoordinatorHistoryPath(sessionId);
        
        const data = {
            sessionId,
            lastUpdated: new Date().toISOString(),
            entryCount: history.length,
            history
        };
        
        // Use queued async write to avoid blocking the event loop
        this.queueWrite(filePath, JSON.stringify(data, null, 2))
            .catch(e => console.error(`Failed to save coordinator history for ${sessionId}:`, e));
    }
    
    /**
     * Load coordinator history from disk
     * Called during session initialization to restore decision history
     * 
     * @param sessionId Session ID
     * @returns Array of coordinator history entries, or empty array if not found
     */
    loadCoordinatorHistory(sessionId: string): any[] {
        const filePath = this.getCoordinatorHistoryPath(sessionId);
        
        if (!fs.existsSync(filePath)) {
            return [];
        }
        
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            return data.history || [];
        } catch (e) {
            console.error(`Failed to load coordinator history for session ${sessionId}:`, e);
            return [];
        }
    }
    
    /**
     * Delete coordinator history for a session
     */
    deleteCoordinatorHistory(sessionId: string): void {
        const filePath = this.getCoordinatorHistoryPath(sessionId);
        if (fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
            } catch (e) {
                console.error(`Failed to delete coordinator history for session ${sessionId}:`, e);
            }
        }
    }

    // ========================================================================
    // Workflow History Persistence (Plans/{sessionId}/workflow_history.json)
    // ========================================================================
    
    /**
     * Get the path to workflow history file for a session
     */
    getWorkflowHistoryPath(sessionId: string): string {
        return path.join(this.getPlanFolder(sessionId), 'workflow_history.json');
    }
    
    /**
     * Save workflow history to disk (async, non-blocking)
     * Called after each workflow completion to persist the history
     * Uses queued writes to avoid blocking the event loop.
     * 
     * @param sessionId Session ID
     * @param history Array of completed workflow summaries
     */
    saveWorkflowHistory(sessionId: string, history: any[]): void {
        this.ensurePlanDirectories(sessionId);
        const filePath = this.getWorkflowHistoryPath(sessionId);
        
        const data = {
            sessionId,
            lastUpdated: new Date().toISOString(),
            entryCount: history.length,
            history
        };
        
        // Use queued async write to avoid blocking the event loop
        this.queueWrite(filePath, JSON.stringify(data, null, 2))
            .catch(e => console.error(`Failed to save workflow history for ${sessionId}:`, e));
    }
    
    /**
     * Load workflow history from disk
     * Called during session initialization to restore completed workflow history
     * 
     * @param sessionId Session ID
     * @returns Array of completed workflow summaries, or empty array if not found
     */
    loadWorkflowHistory(sessionId: string): any[] {
        const filePath = this.getWorkflowHistoryPath(sessionId);
        
        if (!fs.existsSync(filePath)) {
            return [];
        }
        
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            return data.history || [];
        } catch (e) {
            console.error(`Failed to load workflow history for session ${sessionId}:`, e);
            return [];
        }
    }
    
    /**
     * Delete workflow history for a session
     */
    deleteWorkflowHistory(sessionId: string): void {
        const filePath = this.getWorkflowHistoryPath(sessionId);
        if (fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
            } catch (e) {
                console.error(`Failed to delete workflow history for session ${sessionId}:`, e);
            }
        }
    }

    // ========================================================================
    // Role Persistence Methods (.config/roles/)
    // ========================================================================

    /**
     * Get the roles directory path
     * New location: .config/roles/
     */
    private getRolesDir(): string {
        return this.getConfigPath('roles');
    }

    /**
     * Ensure roles directory exists
     */
    private ensureRolesDir(): void {
        const rolesDir = this.getRolesDir();
        if (!fs.existsSync(rolesDir)) {
            fs.mkdirSync(rolesDir, { recursive: true });
        }
    }

    /**
     * Get the path for a role config file
     */
    private getRoleConfigPath(roleId: string): string {
        return path.join(this.getRolesDir(), `${roleId}.json`);
    }

    /**
     * Get saved configuration for a role (built-in role modifications)
     * @returns The saved config object, or undefined if no modifications saved
     */
    getRoleConfig(roleId: string): object | undefined {
        const configPath = this.getRoleConfigPath(roleId);
        if (fs.existsSync(configPath)) {
            try {
                return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            } catch (e) {
                console.error(`Failed to load role config for ${roleId}:`, e);
            }
        }
        return undefined;
    }

    /**
     * Save configuration for a role (built-in role modifications or custom role)
     */
    saveRoleConfig(roleId: string, data: object): void {
        this.ensureRolesDir();
        const configPath = this.getRoleConfigPath(roleId);
        atomicWriteFileSync(configPath, JSON.stringify(data, null, 2));
    }

    /**
     * Clear saved configuration for a built-in role (reset to defaults)
     */
    clearRoleConfig(roleId: string): void {
        const configPath = this.getRoleConfigPath(roleId);
        if (fs.existsSync(configPath)) {
            try {
                fs.unlinkSync(configPath);
            } catch (e) {
                console.error(`Failed to clear role config for ${roleId}:`, e);
            }
        }
    }

    /**
     * Delete role configuration file
     */
    deleteRoleConfig(roleId: string): void {
        this.clearRoleConfig(roleId);
    }

    /**
     * Get all custom roles (non-built-in roles)
     * @returns Array of role data objects
     */
    getCustomRoles(): object[] {
        const customRoles: object[] = [];
        const customRolesPath = path.join(this.getRolesDir(), '_custom_roles.json');
        
        if (fs.existsSync(customRolesPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(customRolesPath, 'utf-8'));
                if (Array.isArray(data)) {
                    return data;
                }
            } catch (e) {
                console.error('Failed to load custom roles:', e);
            }
        }
        
        return customRoles;
    }

    /**
     * Save a custom role
     */
    saveCustomRole(roleData: object): void {
        this.ensureRolesDir();
        const customRolesPath = path.join(this.getRolesDir(), '_custom_roles.json');
        
        // Load existing custom roles
        let customRoles = this.getCustomRoles();
        
        // Find and update or add the role
        const roleId = (roleData as any).id;
        const existingIndex = customRoles.findIndex((r: any) => r.id === roleId);
        
        if (existingIndex >= 0) {
            customRoles[existingIndex] = roleData;
        } else {
            customRoles.push(roleData);
        }
        
        atomicWriteFileSync(customRolesPath, JSON.stringify(customRoles, null, 2));
    }

    // ========================================================================
    // System Prompt Persistence Methods (.config/prompts/)
    // ========================================================================

    /**
     * Get the system prompts directory path
     * New location: .config/prompts/
     */
    private getSystemPromptsDir(): string {
        return this.getConfigPath('prompts');
    }

    /**
     * Ensure system prompts directory exists
     */
    private ensureSystemPromptsDir(): void {
        const dir = this.getSystemPromptsDir();
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    /**
     * Get the path for a system prompt config file
     */
    private getSystemPromptConfigPath(promptId: string): string {
        return path.join(this.getSystemPromptsDir(), `${promptId}.json`);
    }

    /**
     * Get saved configuration for a system prompt
     * @returns The saved config object, or undefined if no modifications saved
     */
    getSystemPromptConfig(promptId: string): object | undefined {
        const configPath = this.getSystemPromptConfigPath(promptId);
        if (fs.existsSync(configPath)) {
            try {
                return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            } catch (e) {
                console.error(`Failed to read system prompt config: ${promptId}`, e);
            }
        }
        return undefined;
    }

    /**
     * Save configuration for a system prompt
     */
    saveSystemPromptConfig(promptId: string, data: object): void {
        this.ensureSystemPromptsDir();
        const configPath = this.getSystemPromptConfigPath(promptId);
        atomicWriteFileSync(configPath, JSON.stringify(data, null, 2));
    }

    /**
     * Clear saved configuration for a system prompt (reset to defaults)
     */
    clearSystemPromptConfig(promptId: string): void {
        const configPath = this.getSystemPromptConfigPath(promptId);
        if (fs.existsSync(configPath)) {
            try {
                fs.unlinkSync(configPath);
            } catch (e) {
                console.error(`Failed to delete system prompt config: ${promptId}`, e);
            }
        }
    }

    // ========================================================================
    // Coordinator Prompt Config
    // ========================================================================

    /**
     * Get the coordinator config directory path
     * Location: .config/coordinator/
     */
    private getCoordinatorConfigDir(): string {
        return this.getConfigPath('coordinator');
    }

    /**
     * Ensure coordinator config directory exists
     */
    private ensureCoordinatorConfigDir(): void {
        const dir = this.getCoordinatorConfigDir();
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    private getCoordinatorPromptConfigPath(): string {
        return path.join(this.getCoordinatorConfigDir(), 'prompt_config.json');
    }

    /**
     * Get saved coordinator prompt configuration
     */
    getCoordinatorPromptConfig(): object | null {
        const configPath = this.getCoordinatorPromptConfigPath();
        if (fs.existsSync(configPath)) {
            try {
                const content = fs.readFileSync(configPath, 'utf-8');
                return JSON.parse(content);
            } catch (e) {
                console.error('Failed to load coordinator prompt config', e);
            }
        }
        return null;
    }

    /**
     * Save coordinator prompt configuration
     */
    saveCoordinatorPromptConfig(config: object): void {
        this.ensureCoordinatorConfigDir();
        const configPath = this.getCoordinatorPromptConfigPath();
        atomicWriteFileSync(configPath, JSON.stringify(config, null, 2));
    }

    /**
     * Clear saved coordinator prompt configuration (reset to defaults)
     */
    clearCoordinatorPromptConfig(): void {
        const configPath = this.getCoordinatorPromptConfigPath();
        if (fs.existsSync(configPath)) {
            try {
                fs.unlinkSync(configPath);
            } catch (e) {
                console.error('Failed to delete coordinator prompt config', e);
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
        const plansDir = this.folderStructure.getFolderPath('plans');
        if (fs.existsSync(plansDir)) {
            const pattern = new RegExp(`^${engineerName}_\\d{6}\\.log$`, 'i');
            
            const planFolders = fs.readdirSync(plansDir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);
            
            for (const sessionId of planFolders) {
                const logsDir = this.getAgentLogsFolder(sessionId);
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
        
        const plansDir = this.folderStructure.getFolderPath('plans');
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
    
    /**
     * Dispose resources
     * Call this on extension deactivation
     */
    dispose(): void {
        console.log('StateManager: Disposing...');
        
        // Cancel debounce timer
        if (this.writeDebounceTimer) {
            clearTimeout(this.writeDebounceTimer);
            this.writeDebounceTimer = null;
        }
        
        // Synchronously flush any pending writes before disposing
        // Use sync version to ensure writes complete before extension deactivates
        for (const [filePath, entry] of this.pendingWrites) {
            try {
                atomicWriteFileSync(filePath, entry.data);
                for (const { resolve } of entry.resolvers) {
                    resolve();
                }
            } catch (e) {
                console.error(`Failed to flush write to ${filePath}:`, e);
                for (const { reject } of entry.resolvers) {
                    reject(e as Error);
                }
            }
        }
        this.pendingWrites.clear();
        
        // Release file lock if held
        if (this.fileLock) {
            this.fileLock.release();
        }
        
        // Clear in-memory state
        this.planningSessions.clear();
        
        console.log('StateManager: Disposed');
    }
}










