import { StateManager } from './StateManager';
import { AgentRoleRegistry } from './AgentRoleRegistry';
import { AgentPoolState, BusyAgentInfo, AgentStatus, AgentRole } from '../types';

export class AgentPoolService {
    private stateManager: StateManager;
    private roleRegistry: AgentRoleRegistry;

    constructor(stateManager: StateManager, roleRegistry: AgentRoleRegistry) {
        this.stateManager = stateManager;
        this.roleRegistry = roleRegistry;
    }

    // ========================================================================
    // Role Access
    // ========================================================================

    /**
     * Get a role by ID
     */
    getRole(roleId: string): AgentRole | undefined {
        return this.roleRegistry.getRole(roleId);
    }

    /**
     * Get all available roles
     */
    getAllRoles(): AgentRole[] {
        return this.roleRegistry.getAllRoles();
    }

    // ========================================================================
    // Pool Status
    // ========================================================================

    getPoolStatus(): { total: number; available: string[]; busy: string[] } {
        const state = this.stateManager.getAgentPoolState();
        return {
            total: state.totalAgents,
            available: [...state.available],
            busy: Object.keys(state.busy)
        };
    }

    getAvailableAgents(): string[] {
        return [...this.stateManager.getAgentPoolState().available];
    }

    getBusyAgents(): Array<{ name: string; roleId?: string; coordinatorId: string; sessionId: string; workflowId?: string; task?: string }> {
        const state = this.stateManager.getAgentPoolState();
        return Object.entries(state.busy).map(([name, info]) => ({
            name,
            roleId: info.roleId,
            coordinatorId: info.coordinatorId,
            sessionId: info.sessionId,
            workflowId: info.workflowId,
            task: info.task
        }));
    }

    /**
     * Get agents by their assigned role
     */
    getAgentsByRole(roleId: string): Array<{ name: string; coordinatorId: string; sessionId: string; task?: string }> {
        const state = this.stateManager.getAgentPoolState();
        return Object.entries(state.busy)
            .filter(([_, info]) => info.roleId === roleId)
            .map(([name, info]) => ({
                name,
                coordinatorId: info.coordinatorId,
                sessionId: info.sessionId,
                task: info.task
            }));
    }

    getAgentStatus(name: string): AgentStatus | undefined {
        const state = this.stateManager.getAgentPoolState();
        
        if (state.available.includes(name)) {
            return { name, status: 'available' };
        }
        
        const busyInfo = state.busy[name];
        if (busyInfo) {
            return {
                name,
                roleId: busyInfo.roleId,
                status: 'busy',
                coordinatorId: busyInfo.coordinatorId,
                sessionId: busyInfo.sessionId,
                workflowId: busyInfo.workflowId,
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
     * Allocate agents from the pool for a coordinator
     * @param coordinatorId The coordinator requesting agents
     * @param count Number of agents to allocate
     * @param roleId Optional role ID to assign to the agents (default: 'engineer')
     * @returns Array of allocated agent names
     */
    allocateAgents(coordinatorId: string, count: number, roleId: string = 'engineer'): string[] {
        // Validate role exists in registry
        if (!this.roleRegistry.getRole(roleId)) {
            console.warn(`[AgentPoolService] Unknown role: ${roleId}, defaulting to 'engineer'`);
            roleId = 'engineer';
            
            // Double-check 'engineer' exists, fallback to first available role
            if (!this.roleRegistry.getRole('engineer')) {
                const allRoles = this.roleRegistry.getAllRoles();
                if (allRoles.length > 0) {
                    roleId = allRoles[0].id;
                    console.warn(`[AgentPoolService] 'engineer' role not found, using '${roleId}'`);
                }
            }
        }
        
        const state = this.stateManager.getAgentPoolState();
        const toAllocate = Math.min(count, state.available.length);
        const allocated: string[] = [];

        for (let i = 0; i < toAllocate; i++) {
            const agent = state.available.shift();
            if (agent) {
                allocated.push(agent);
                state.busy[agent] = {
                    coordinatorId,
                    sessionId: '', // Will be set when session starts
                    roleId,
                    startTime: new Date().toISOString()
                };
            }
        }

        this.stateManager.updateAgentPool(state);
        return allocated;
    }

    /**
     * Release agents back to the pool
     * @param agentNames Names of agents to release
     */
    releaseAgents(agentNames: string[]): void {
        const state = this.stateManager.getAgentPoolState();

        for (const name of agentNames) {
            if (state.busy[name]) {
                delete state.busy[name];
                if (!state.available.includes(name)) {
                    state.available.push(name);
                }
            }
        }

        // Sort available list for consistency
        state.available.sort();
        this.stateManager.updateAgentPool(state);
    }

    /**
     * Release all agents belonging to a coordinator
     * @param coordinatorId The coordinator ID
     */
    releaseCoordinatorAgents(coordinatorId: string): string[] {
        const state = this.stateManager.getAgentPoolState();
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
        this.stateManager.updateAgentPool(state);
        return released;
    }

    // ========================================================================
    // Update Agent Info
    // ========================================================================

    updateAgentSession(agentName: string, updates: Partial<BusyAgentInfo>): void {
        const state = this.stateManager.getAgentPoolState();
        
        if (state.busy[agentName]) {
            state.busy[agentName] = {
                ...state.busy[agentName],
                ...updates
            };
            this.stateManager.updateAgentPool(state);
        }
    }

    /**
     * Update the role assignment for an agent
     */
    updateAgentRole(agentName: string, roleId: string): void {
        this.updateAgentSession(agentName, { roleId });
    }

    // ========================================================================
    // Execution Pipeline Helpers
    // ========================================================================

    /**
     * Allocate a single agent for a specific role
     * Returns the agent name or undefined if none available
     */
    allocateAgentForRole(coordinatorId: string, roleId: string): string | undefined {
        const allocated = this.allocateAgents(coordinatorId, 1, roleId);
        return allocated.length > 0 ? allocated[0] : undefined;
    }

    /**
     * Get count of agents by role
     */
    countAgentsByRole(): Record<string, number> {
        const state = this.stateManager.getAgentPoolState();
        const counts: Record<string, number> = {};
        
        for (const info of Object.values(state.busy)) {
            const role = info.roleId || 'unknown';
            counts[role] = (counts[role] || 0) + 1;
        }
        
        return counts;
    }

    /**
     * Get agents working on a specific task
     */
    getAgentsWorkingOnTask(taskDescription: string): Array<{ name: string; roleId: string }> {
        const state = this.stateManager.getAgentPoolState();
        const agents: Array<{ name: string; roleId: string }> = [];
        
        for (const [name, info] of Object.entries(state.busy)) {
            if (info.task && info.task.includes(taskDescription)) {
                agents.push({ name, roleId: info.roleId });
            }
        }
        
        return agents;
    }

    /**
     * Check if there are available agents for a specific coordinator
     */
    hasAvailableAgents(): boolean {
        return this.getAvailableAgents().length > 0;
    }

    /**
     * Get summary of pool state for logging/display
     */
    getPoolSummary(): {
        total: number;
        available: number;
        busy: number;
        byRole: Record<string, number>;
    } {
        const state = this.stateManager.getAgentPoolState();
        const byRole = this.countAgentsByRole();
        
        return {
            total: state.totalAgents,
            available: state.available.length,
            busy: Object.keys(state.busy).length,
            byRole
        };
    }

    /**
     * Force release an agent (for cleanup on errors/timeouts)
     * Unlike releaseAgents, this doesn't check if the agent is busy
     */
    forceReleaseAgent(agentName: string): boolean {
        const state = this.stateManager.getAgentPoolState();
        
        // Remove from busy if present
        if (state.busy[agentName]) {
            delete state.busy[agentName];
        }
        
        // Add to available if not already there
        if (!state.available.includes(agentName)) {
            // Only add if it's a known agent
            if (state.agentNames.includes(agentName)) {
                state.available.push(agentName);
                state.available.sort();
                this.stateManager.updateAgentPool(state);
                return true;
            }
        }
        
        this.stateManager.updateAgentPool(state);
        return false;
    }

    // ========================================================================
    // Pool Configuration
    // ========================================================================

    /**
     * Resize the agent pool
     * @param newSize New pool size
     */
    resizePool(newSize: number): { added: string[]; removed: string[] } {
        const state = this.stateManager.getAgentPoolState();
        const currentSize = state.totalAgents;
        const added: string[] = [];
        const removed: string[] = [];

        const allNames = ['Alex', 'Betty', 'Cleo', 'Dany', 'Echo', 'Finn', 'Gwen', 'Hugo', 'Iris', 'Jake',
                         'Kate', 'Liam', 'Mona', 'Noah', 'Olga', 'Pete', 'Quinn', 'Rose', 'Sam', 'Tina'];

        if (newSize > currentSize) {
            // Add more agents
            for (let i = currentSize; i < newSize && i < allNames.length; i++) {
                const name = allNames[i];
                if (!state.agentNames.includes(name)) {
                    state.agentNames.push(name);
                    state.available.push(name);
                    added.push(name);
                }
            }
        } else if (newSize < currentSize) {
            // Remove agents (only available ones)
            const toRemove = currentSize - newSize;
            let removedCount = 0;
            
            for (let i = state.available.length - 1; i >= 0 && removedCount < toRemove; i--) {
                const name = state.available[i];
                state.available.splice(i, 1);
                state.agentNames = state.agentNames.filter(n => n !== name);
                removed.push(name);
                removedCount++;
            }
        }

        state.totalAgents = newSize;
        this.stateManager.updateAgentPool(state);
        
        return { added, removed };
    }

}

