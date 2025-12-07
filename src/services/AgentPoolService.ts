import { StateManager } from './StateManager';
import { AgentRoleRegistry } from './AgentRoleRegistry';
import { AgentPoolState, BusyAgentInfo, AllocatedAgentInfo, RestingAgentInfo, AgentStatus, AgentRole } from '../types';
import { Logger } from '../utils/Logger';

const log = Logger.create('Daemon', 'AgentPool');

/**
 * AgentPoolService - Manages agent lifecycle with bench + resting state
 * 
 * ARCHITECTURE:
 * 1. Allocation ALWAYS goes to bench (allocated state) - NO auto-promotion
 * 2. Workflows manually promote agents to busy when work starts
 * 3. Release auto-demotes busy agents to bench, then to resting (5s cooldown)
 * 4. Resting agents auto-transition to available after cooldown
 * 
 * States:
 * - available: Ready to be allocated
 * - resting: Cooldown after release (5 seconds) - cannot be allocated
 * - allocated: On bench, waiting for workflow to promote to busy
 * - busy: Actively working on a workflow
 */
/**
 * Async mutex for critical section protection
 */
class AsyncMutex {
    private locked: boolean = false;
    private queue: Array<() => void> = [];

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

    private release(): void {
        this.locked = false;
        const next = this.queue.shift();
        if (next) {
            next();
        }
    }
}

export class AgentPoolService {
    private stateManager: StateManager;
    private roleRegistry: AgentRoleRegistry;
    
    // Cooldown duration after agent release (milliseconds)
    private readonly REST_COOLDOWN_MS = 5000;  // 5 seconds
    
    // Timer IDs for resting agents (agentName -> timeoutId)
    private restingTimers: Map<string, NodeJS.Timeout> = new Map();
    
    // Mutex to prevent concurrent allocation race conditions
    private allocationMutex: AsyncMutex = new AsyncMutex();

    constructor(stateManager: StateManager, roleRegistry: AgentRoleRegistry) {
        this.stateManager = stateManager;
        this.roleRegistry = roleRegistry;
        
        // Check for expired resting agents on startup
        this.processRestingAgents();
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

    getPoolStatus(): { total: number; available: string[]; allocated: string[]; busy: string[] } {
        const state = this.stateManager.getAgentPoolState();
        return {
            total: state.totalAgents,
            available: [...state.available],
            allocated: Object.keys(state.allocated || {}),
            busy: Object.keys(state.busy)
        };
    }

    getAvailableAgents(): string[] {
        return [...this.stateManager.getAgentPoolState().available];
    }

    getBusyAgents(): Array<{ name: string; roleId?: string; sessionId: string; workflowId: string; task?: string }> {
        const state = this.stateManager.getAgentPoolState();
        return Object.entries(state.busy).map(([name, info]) => ({
            name,
            roleId: info.roleId,
            sessionId: info.sessionId,
            workflowId: info.workflowId,
            task: info.task
        }));
    }

    /**
     * Get agents in resting state (cooldown after release)
     */
    getRestingAgents(): string[] {
        const state = this.stateManager.getAgentPoolState();
        return state.resting ? Object.keys(state.resting) : [];
    }

    /**
     * Get allocated agents (on bench, waiting for work)
     */
    getAllocatedAgents(): Array<{ name: string; roleId: string; sessionId: string; workflowId: string }> {
        const state = this.stateManager.getAgentPoolState();
        if (!state.allocated) {
            return [];
        }
        return Object.entries(state.allocated).map(([name, info]) => ({
            name,
            roleId: info.roleId,
            sessionId: info.sessionId,
            workflowId: info.workflowId
        }));
    }

    /**
     * Get agents by their assigned role
     */
    getAgentsByRole(roleId: string): Array<{ name: string; sessionId: string; task?: string }> {
        const state = this.stateManager.getAgentPoolState();
        return Object.entries(state.busy)
            .filter(([_, info]) => info.roleId === roleId)
            .map(([name, info]) => ({
                name,
                sessionId: info.sessionId,
                task: info.task
            }));
    }

    getAgentStatus(name: string): AgentStatus | undefined {
        const state = this.stateManager.getAgentPoolState();
        
        if (state.available.includes(name)) {
            return { name, status: 'available' };
        }
        
        const restingInfo = state.resting?.[name];
        if (restingInfo) {
            return {
                name,
                status: 'resting',
                restUntil: restingInfo.restUntil
            };
        }
        
        const allocatedInfo = state.allocated?.[name];
        if (allocatedInfo) {
            return {
                name,
                roleId: allocatedInfo.roleId,
                status: 'allocated',
                sessionId: allocatedInfo.sessionId
            };
        }
        
        const busyInfo = state.busy[name];
        if (busyInfo) {
            return {
                name,
                roleId: busyInfo.roleId,
                status: 'busy',
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
     * Allocate agents to workflow bench (ALWAYS to bench, never auto-promotes to busy)
     * Workflows must explicitly call promoteAgentToBusy() when work starts
     * 
     * ARCHITECTURE: Bench is WORKFLOW-SCOPED
     * - Each workflow has its own private bench
     * - Agents on bench are owned by that specific workflow
     * - Only the owning workflow can promote/use agents from its bench
     * 
     * THREAD SAFETY: Uses mutex to prevent race conditions when multiple workflows
     * request agents simultaneously. The entire allocation operation is atomic.
     * 
     * @param sessionId The session (for capacity tracking)
     * @param workflowId The workflow that owns these agents
     * @param count Number of agents to allocate
     * @param roleId Role to assign
     * @returns Array of allocated agent names
     */
    async allocateAgents(
        sessionId: string,
        workflowId: string,
        count: number, 
        roleId: string = 'engineer'
    ): Promise<string[]> {
        // CRITICAL: Acquire mutex to prevent concurrent allocation
        const release = await this.allocationMutex.acquire();
        
        try {
            // Validate role exists in registry
            if (!this.roleRegistry.getRole(roleId)) {
                const availableRoles = this.roleRegistry.getAllRoles().map(r => r.id).join(', ');
                throw new Error(
                    `Role '${roleId}' not found in registry. Available roles: ${availableRoles || 'none'}. ` +
                    `Please register the role or use an existing one.`
                );
            }
            
            // Get fresh state inside critical section
            const state = this.stateManager.getAgentPoolState();
            
            // Process resting agents first (check if any can transition to available)
            this.processRestingAgents();
            
            // Re-fetch state after processing resting agents
            const updatedState = this.stateManager.getAgentPoolState();
            const toAllocate = Math.min(count, updatedState.available.length);
            const allocated: string[] = [];

            for (let i = 0; i < toAllocate; i++) {
                const agent = updatedState.available.shift();
                if (agent) {
                    allocated.push(agent);
                    // CRITICAL: Allocate to WORKFLOW's bench (not session's)
                    updatedState.allocated[agent] = {
                        sessionId,
                        workflowId,  // This workflow owns this agent
                        roleId,
                        allocatedAt: new Date().toISOString()
                    };
                    // Enhanced logging for debugging agent allocation
                    log.info(`🎯 ALLOCATED: ${agent} -> workflow=${workflowId.substring(0, 8)}... role=${roleId} session=${sessionId}`);
                }
            }

            // Update state before releasing mutex
            this.stateManager.updateAgentPool(updatedState);
            
            log.info(`🔒 Allocated ${allocated.length}/${count} agents to workflow ${workflowId} (mutex protected)`);
            return allocated;
        } finally {
            // CRITICAL: Always release mutex, even on error
            release();
        }
    }

    /**
     * Promote agent from bench to busy (start working on workflow)
     * This is explicitly called by workflows when they start using an agent
     * 
     * @param agentName Agent to promote
     * @param workflowId Workflow ID
     * @param task Optional task description
     * @returns true if successful
     */
    promoteAgentToBusy(agentName: string, workflowId: string, task?: string): boolean {
        const state = this.stateManager.getAgentPoolState();
        
        const allocatedInfo = state.allocated?.[agentName];
        if (!allocatedInfo) {
            log.warn(`Cannot promote ${agentName}: not on bench`);
            return false;
        }
        
        // Move from allocated to busy
        delete state.allocated[agentName];
        state.busy[agentName] = {
            sessionId: allocatedInfo.sessionId,
            roleId: allocatedInfo.roleId,
            workflowId,
            task,
            startTime: new Date().toISOString()
        };
        
        // Enhanced logging for debugging
        log.info(`⬆️ PROMOTED: ${agentName} -> BUSY | workflow=${workflowId.substring(0, 8)}... role=${allocatedInfo.roleId}`);
        this.stateManager.updateAgentPool(state);
        return true;
    }

    /**
     * Demote agent from busy back to bench (workflow paused/waiting)
     */
    demoteAgentToBench(agentName: string): boolean {
        const state = this.stateManager.getAgentPoolState();
        
        const busyInfo = state.busy[agentName];
        if (!busyInfo) {
            log.warn(`Cannot demote ${agentName}: not busy`);
            return false;
        }
        
        // Move from busy back to allocated
        delete state.busy[agentName];
        state.allocated[agentName] = {
            sessionId: busyInfo.sessionId,
            roleId: busyInfo.roleId,
            allocatedAt: new Date().toISOString(),
            workflowId: busyInfo.workflowId  // Keep workflow association
        };
        
        // Enhanced logging for debugging
        log.info(`⬇️ DEMOTED: ${agentName} -> BENCH | workflow=${busyInfo.workflowId?.substring(0, 8) || 'none'}... role=${busyInfo.roleId}`);
        this.stateManager.updateAgentPool(state);
        return true;
    }

    /**
     * Release agents back to the pool
     * - If busy: demote to bench first, then to resting (5s cooldown)
     * - If allocated: move directly to resting (5s cooldown)
     * - After cooldown: auto-transition to available
     * 
     * @param agentNames Names of agents to release
     */
    releaseAgents(agentNames: string[]): void {
        const state = this.stateManager.getAgentPoolState();

        for (const name of agentNames) {
            // Clear any existing resting timer
            const existingTimer = this.restingTimers.get(name);
            if (existingTimer) {
                clearTimeout(existingTimer);
                this.restingTimers.delete(name);
            }
            
            // Check both busy and allocated
            const wasBusy = !!state.busy[name];
            const wasAllocated = !!state.allocated?.[name];
            
            if (wasBusy) {
                log.debug(`Releasing BUSY agent ${name} -> resting (5s cooldown)`);
                delete state.busy[name];
            } else if (wasAllocated) {
                log.debug(`Releasing ALLOCATED agent ${name} -> resting (5s cooldown)`);
                delete state.allocated[name];
            } else if (state.resting?.[name]) {
                log.debug(`Agent ${name} already resting, resetting cooldown`);
                delete state.resting[name];
            } else {
                // Already available or unknown
                continue;
            }
            
            // Put agent in resting state with cooldown
            const now = Date.now();
            const restUntil = new Date(now + this.REST_COOLDOWN_MS).toISOString();
            
            if (!state.resting) {
                state.resting = {};
            }
            state.resting[name] = {
                releasedAt: new Date(now).toISOString(),
                restUntil
            };
            
            // Set timer to auto-transition to available after cooldown
            const timerId = setTimeout(() => {
                this.transitionRestingToAvailable(name);
                this.restingTimers.delete(name);
            }, this.REST_COOLDOWN_MS);
            
            this.restingTimers.set(name, timerId);
        }

        this.stateManager.updateAgentPool(state);
    }

    /**
     * Release all agents belonging to a session
     * Moves them to resting state with cooldown before returning to available
     * 
     * @param sessionId The session ID
     */
    releaseSessionAgents(sessionId: string): string[] {
        const state = this.stateManager.getAgentPoolState();
        const toRelease: string[] = [];

        // Collect agents to release
        for (const [name, info] of Object.entries(state.busy)) {
            if (info.sessionId === sessionId) {
                toRelease.push(name);
            }
        }

        // Also check allocated agents
        if (state.allocated) {
            for (const [name, info] of Object.entries(state.allocated)) {
                if (info.sessionId === sessionId) {
                    toRelease.push(name);
                }
            }
        }

        // Release all collected agents (will go through resting cooldown)
        if (toRelease.length > 0) {
            this.releaseAgents(toRelease);
        }

        return toRelease;
    }

    // ========================================================================
    // Orphan Agent Cleanup (for daemon restart recovery)
    // ========================================================================
    
    /**
     * Validate agent allocations against active workflows and release orphans
     * 
     * Called during daemon startup after workflows are restored.
     * Agents allocated to workflows that couldn't be restored are released.
     * 
     * @param validWorkflowIds Set of workflow IDs that are currently active/restored
     * @returns List of released agent names
     */
    releaseOrphanAllocatedAgents(validWorkflowIds: Set<string>): string[] {
        const state = this.stateManager.getAgentPoolState();
        const orphans: string[] = [];
        
        // Check allocated (bench) agents
        if (state.allocated) {
            for (const [name, info] of Object.entries(state.allocated)) {
                if (!validWorkflowIds.has(info.workflowId)) {
                    orphans.push(name);
                    log.info(`Found orphan allocated agent: ${name} (workflow ${info.workflowId} not found)`);
                }
            }
        }
        
        // Check busy agents
        for (const [name, info] of Object.entries(state.busy)) {
            if (!validWorkflowIds.has(info.workflowId)) {
                orphans.push(name);
                log.info(`Found orphan busy agent: ${name} (workflow ${info.workflowId} not found)`);
            }
        }
        
        // Release all orphans
        if (orphans.length > 0) {
            this.releaseAgents(orphans);
            log.info(`Released ${orphans.length} orphan agent(s): ${orphans.join(', ')}`);
        }
        
        return orphans;
    }
    
    /**
     * Get all workflow IDs that have allocated or busy agents
     */
    getActiveWorkflowIds(): Set<string> {
        const state = this.stateManager.getAgentPoolState();
        const workflowIds = new Set<string>();
        
        if (state.allocated) {
            for (const info of Object.values(state.allocated)) {
                workflowIds.add(info.workflowId);
            }
        }
        
        for (const info of Object.values(state.busy)) {
            workflowIds.add(info.workflowId);
        }
        
        return workflowIds;
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
    async allocateAgentForRole(sessionId: string, roleId: string, requestingWorkflowId?: string): Promise<string | undefined> {
        const allocated = await this.allocateAgents(sessionId, requestingWorkflowId || 'unknown', 1, roleId);
        return allocated.length > 0 ? allocated[0] : undefined;
    }

    /**
     * Get agents on bench (allocated but not yet working)
     * 
     * WORKFLOW-SCOPED: Returns only agents owned by the specified workflow
     * If no workflowId provided, returns all bench agents (for monitoring/debugging)
     */
    getAgentsOnBench(workflowId?: string): Array<{ 
        name: string; 
        roleId: string; 
        sessionId: string;
        workflowId: string;
    }> {
        const state = this.stateManager.getAgentPoolState();
        if (!state.allocated) {
            return [];
        }
        return Object.entries(state.allocated)
            .filter(([_, info]) => !workflowId || info.workflowId === workflowId)
            .map(([name, info]) => ({
                name,
                roleId: info.roleId,
                sessionId: info.sessionId,
                workflowId: info.workflowId
            }));
    }

    /**
     * Get count of agents on bench
     */
    getBenchCount(sessionId?: string): number {
        return this.getAgentsOnBench(sessionId).length;
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
        resting: number;
        allocated: number;
        busy: number;
        byRole: Record<string, number>;
    } {
        const state = this.stateManager.getAgentPoolState();
        const byRole = this.countAgentsByRole();
        
        return {
            total: state.totalAgents,
            available: state.available.length,
            resting: state.resting ? Object.keys(state.resting).length : 0,
            allocated: state.allocated ? Object.keys(state.allocated).length : 0,
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
        
        // Remove from allocated if present
        if (state.allocated?.[agentName]) {
            delete state.allocated[agentName];
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
    
    // ========================================================================
    // Resting State Management (Cooldown)
    // ========================================================================
    
    /**
     * Process resting agents - transition expired cooldowns to available
     * Called automatically during allocation and on timer expiry
     */
    private processRestingAgents(): void {
        const state = this.stateManager.getAgentPoolState();
        if (!state.resting) {
            state.resting = {};
            return;
        }
        
        const now = Date.now();
        const toTransition: string[] = [];
        
        for (const [name, info] of Object.entries(state.resting)) {
            const restUntilMs = new Date(info.restUntil).getTime();
            if (now >= restUntilMs) {
                toTransition.push(name);
            }
        }
        
        if (toTransition.length > 0) {
            for (const name of toTransition) {
                delete state.resting[name];
                if (!state.available.includes(name)) {
                    state.available.push(name);
                }
                log.debug(`${name} cooldown expired -> available`);
            }
            
            state.available.sort();
            this.stateManager.updateAgentPool(state);
        }
    }
    
    /**
     * Transition a specific agent from resting to available
     * Called by timer callback after cooldown expires
     */
    private transitionRestingToAvailable(agentName: string): void {
        const state = this.stateManager.getAgentPoolState();
        
        if (state.resting?.[agentName]) {
            delete state.resting[agentName];
            
            if (!state.available.includes(agentName)) {
                state.available.push(agentName);
                state.available.sort();
            }
            
            log.debug(`${agentName} cooldown complete -> available`);
            this.stateManager.updateAgentPool(state);
        }
    }
    
    /**
     * Cleanup - cancel all resting timers
     * Call this on service shutdown to prevent memory leaks
     */
    dispose(): void {
        for (const timerId of this.restingTimers.values()) {
            clearTimeout(timerId);
        }
        this.restingTimers.clear();
        log.info('Disposed all resting timers');
    }

}

