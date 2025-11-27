import { StateManager } from './StateManager';
import { EngineerPoolState, BusyEngineerInfo, EngineerStatus } from '../types';

export class EngineerPoolService {
    private stateManager: StateManager;

    constructor(stateManager: StateManager) {
        this.stateManager = stateManager;
    }

    // ========================================================================
    // Pool Status
    // ========================================================================

    getPoolStatus(): { total: number; available: string[]; busy: string[] } {
        const state = this.stateManager.getEngineerPoolState();
        return {
            total: state.totalEngineers,
            available: [...state.available],
            busy: Object.keys(state.busy)
        };
    }

    getAvailableEngineers(): string[] {
        return [...this.stateManager.getEngineerPoolState().available];
    }

    getBusyEngineers(): Array<{ name: string; coordinatorId: string; sessionId: string; task?: string }> {
        const state = this.stateManager.getEngineerPoolState();
        return Object.entries(state.busy).map(([name, info]) => ({
            name,
            coordinatorId: info.coordinatorId,
            sessionId: info.sessionId,
            task: info.task
        }));
    }

    getEngineerStatus(name: string): EngineerStatus | undefined {
        const state = this.stateManager.getEngineerPoolState();
        
        if (state.available.includes(name)) {
            return { name, status: 'available' };
        }
        
        const busyInfo = state.busy[name];
        if (busyInfo) {
            return {
                name,
                status: 'busy',
                coordinatorId: busyInfo.coordinatorId,
                sessionId: busyInfo.sessionId,
                task: busyInfo.task,
                logFile: busyInfo.logFile,
                processId: busyInfo.processId
            };
        }
        
        return undefined;
    }

    // ========================================================================
    // Allocation
    // ========================================================================

    /**
     * Allocate engineers from the pool for a coordinator
     * @param coordinatorId The coordinator requesting engineers
     * @param count Number of engineers to allocate
     * @returns Array of allocated engineer names
     */
    allocateEngineers(coordinatorId: string, count: number): string[] {
        const state = this.stateManager.getEngineerPoolState();
        const toAllocate = Math.min(count, state.available.length);
        const allocated: string[] = [];

        for (let i = 0; i < toAllocate; i++) {
            const engineer = state.available.shift();
            if (engineer) {
                allocated.push(engineer);
                state.busy[engineer] = {
                    coordinatorId,
                    sessionId: '', // Will be set when session starts
                    startTime: new Date().toISOString()
                };
            }
        }

        this.stateManager.updateEngineerPool(state);
        return allocated;
    }

    /**
     * Release engineers back to the pool
     * @param engineerNames Names of engineers to release
     */
    releaseEngineers(engineerNames: string[]): void {
        const state = this.stateManager.getEngineerPoolState();

        for (const name of engineerNames) {
            if (state.busy[name]) {
                delete state.busy[name];
                if (!state.available.includes(name)) {
                    state.available.push(name);
                }
            }
        }

        // Sort available list for consistency
        state.available.sort();
        this.stateManager.updateEngineerPool(state);
    }

    /**
     * Release all engineers belonging to a coordinator
     * @param coordinatorId The coordinator ID
     */
    releaseCoordinatorEngineers(coordinatorId: string): string[] {
        const state = this.stateManager.getEngineerPoolState();
        const released: string[] = [];

        for (const [name, info] of Object.entries(state.busy)) {
            if (info.coordinatorId === coordinatorId) {
                delete state.busy[name];
                if (!state.available.includes(name)) {
                    state.available.push(name);
                }
                released.push(name);
            }
        }

        state.available.sort();
        this.stateManager.updateEngineerPool(state);
        return released;
    }

    // ========================================================================
    // Update Engineer Info
    // ========================================================================

    updateEngineerSession(engineerName: string, updates: Partial<BusyEngineerInfo>): void {
        const state = this.stateManager.getEngineerPoolState();
        
        if (state.busy[engineerName]) {
            state.busy[engineerName] = {
                ...state.busy[engineerName],
                ...updates
            };
            this.stateManager.updateEngineerPool(state);
        }
    }

    // ========================================================================
    // Pool Configuration
    // ========================================================================

    /**
     * Resize the engineer pool
     * @param newSize New pool size
     */
    resizePool(newSize: number): { added: string[]; removed: string[] } {
        const state = this.stateManager.getEngineerPoolState();
        const currentSize = state.totalEngineers;
        const added: string[] = [];
        const removed: string[] = [];

        const allNames = ['Alex', 'Betty', 'Cleo', 'Dany', 'Echo', 'Finn', 'Gwen', 'Hugo', 'Iris', 'Jake',
                         'Kate', 'Liam', 'Mona', 'Noah', 'Olga', 'Pete', 'Quinn', 'Rose', 'Sam', 'Tina'];

        if (newSize > currentSize) {
            // Add more engineers
            for (let i = currentSize; i < newSize && i < allNames.length; i++) {
                const name = allNames[i];
                if (!state.engineerNames.includes(name)) {
                    state.engineerNames.push(name);
                    state.available.push(name);
                    added.push(name);
                }
            }
        } else if (newSize < currentSize) {
            // Remove engineers (only available ones)
            const toRemove = currentSize - newSize;
            let removedCount = 0;
            
            for (let i = state.available.length - 1; i >= 0 && removedCount < toRemove; i--) {
                const name = state.available[i];
                state.available.splice(i, 1);
                state.engineerNames = state.engineerNames.filter(n => n !== name);
                removed.push(name);
                removedCount++;
            }
        }

        state.totalEngineers = newSize;
        this.stateManager.updateEngineerPool(state);
        
        return { added, removed };
    }
}










