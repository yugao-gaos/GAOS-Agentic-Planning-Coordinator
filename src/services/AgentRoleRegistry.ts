import { AgentRole, DefaultRoleConfigs, getDefaultRole, SystemPromptConfig, DefaultSystemPrompts, getDefaultSystemPrompt } from '../types';
import { StateManager } from './StateManager';
import { Logger } from '../utils/Logger';

const log = Logger.create('Daemon', 'AgentRoleRegistry');

/**
 * Manages all agent roles (built-in + custom), system prompts, and coordinator config.
 * Persists user modifications to workspace state.
 */
export class AgentRoleRegistry {
    private roles: Map<string, AgentRole> = new Map();
    private systemPrompts: Map<string, SystemPromptConfig> = new Map();
    private stateManager: StateManager;
    private _onRolesChanged: (() => void)[] = [];
    private _onSystemPromptsChanged: (() => void)[] = [];
    
    /** Whether Unity features are enabled (affects role prompts and tools) */
    private _unityEnabled: boolean = true;

    constructor(stateManager: StateManager) {
        this.stateManager = stateManager;
        this.loadRoles();
        this.loadSystemPrompts();
    }
    
    /**
     * Set whether Unity features are enabled
     * When enabled, role prompts and tools include Unity-specific additions
     */
    setUnityEnabled(enabled: boolean): void {
        this._unityEnabled = enabled;
        log.info(`Unity features ${enabled ? 'enabled' : 'disabled'}`);
    }
    
    /**
     * Check if Unity features are enabled
     */
    isUnityEnabled(): boolean {
        return this._unityEnabled;
    }

    /**
     * Register a callback to be notified when roles change
     */
    onRolesChanged(callback: () => void): void {
        this._onRolesChanged.push(callback);
    }

    /**
     * Register a callback to be notified when system prompts change
     */
    onSystemPromptsChanged(callback: () => void): void {
        this._onSystemPromptsChanged.push(callback);
    }

    /**
     * Notify all listeners that roles have changed
     */
    private notifyRolesChanged(): void {
        for (const callback of this._onRolesChanged) {
            try {
                callback();
            } catch (e) {
                log.error('Error in roles changed callback:', e);
            }
        }
    }

    /**
     * Notify all listeners that system prompts have changed
     */
    private notifySystemPromptsChanged(): void {
        for (const callback of this._onSystemPromptsChanged) {
            try {
                callback();
            } catch (e) {
                log.error('Error in system prompts changed callback:', e);
            }
        }
    }

    /**
     * Load roles from persisted state, falling back to defaults
     */
    private loadRoles(): void {
        // Load built-in roles (may have user modifications)
        for (const [id, defaults] of Object.entries(DefaultRoleConfigs)) {
            const saved = this.stateManager.getRoleConfig(id);
            if (saved) {
                // Merge saved config with defaults (saved takes precedence)
                const role = AgentRole.fromJSON({ ...defaults, ...saved });
                this.roles.set(id, role);
            } else {
                // Use defaults
                const role = new AgentRole(defaults);
                this.roles.set(id, role);
            }
        }

        // Load custom roles
        const customRoles = this.stateManager.getCustomRoles() as Array<{ id: string; [key: string]: any }>;
        for (const roleData of customRoles) {
            this.roles.set(roleData.id, AgentRole.fromJSON(roleData));
        }

        log.info(`Loaded ${this.roles.size} roles (${Object.keys(DefaultRoleConfigs).length} built-in, ${customRoles.length} custom)`);
    }

    /**
     * Load system prompts from persisted state, falling back to defaults
     */
    private loadSystemPrompts(): void {
        for (const [id, defaults] of Object.entries(DefaultSystemPrompts)) {
            const saved = this.stateManager.getSystemPromptConfig(id);
            if (saved) {
                // Merge saved config with defaults (saved takes precedence)
                const config = SystemPromptConfig.fromJSON({ ...defaults, ...saved });
                this.systemPrompts.set(id, config);
            } else {
                // Use defaults
                const config = new SystemPromptConfig(defaults);
                this.systemPrompts.set(id, config);
            }
        }

        log.info(`Loaded ${this.systemPrompts.size} system prompts`);
    }

    // ========================================================================
    // Role Methods
    // ========================================================================

    /**
     * Get a role by ID
     */
    getRole(id: string): AgentRole | undefined {
        return this.roles.get(id);
    }

    /**
     * Get all roles (built-in + custom)
     */
    getAllRoles(): AgentRole[] {
        return Array.from(this.roles.values());
    }

    /**
     * Get only built-in roles
     */
    getBuiltInRoles(): AgentRole[] {
        return this.getAllRoles().filter(r => r.isBuiltIn);
    }

    /**
     * Get only custom roles
     */
    getCustomRoles(): AgentRole[] {
        return this.getAllRoles().filter(r => !r.isBuiltIn);
    }

    /**
     * Check if a role exists
     */
    hasRole(id: string): boolean {
        return this.roles.has(id);
    }

    /**
     * Update a role configuration
     */
    updateRole(role: AgentRole): void {
        this.roles.set(role.id, role);
        this.persistRole(role);
        this.reload();
        this.notifyRolesChanged();
    }

    /**
     * Reset a built-in role to its defaults
     * @returns The reset role, or undefined if not a built-in role
     */
    resetToDefault(roleId: string): AgentRole | undefined {
        const defaults = DefaultRoleConfigs[roleId];
        if (!defaults) {
            log.warn(`Cannot reset non-built-in role: ${roleId}`);
            return undefined;
        }
        
        const role = new AgentRole(defaults);
        this.roles.set(roleId, role);
        this.stateManager.clearRoleConfig(roleId);
        this.reload();
        this.notifyRolesChanged();
        
        log.info(`Reset role to default: ${roleId}`);
        return role;
    }

    /**
     * Create a new custom role
     * @throws Error if role ID already exists
     */
    createCustomRole(data: Partial<AgentRole> & { id: string; name: string }): AgentRole {
        if (this.roles.has(data.id)) {
            throw new Error(`Role with id '${data.id}' already exists`);
        }

        // Ensure it's marked as not built-in
        const role = new AgentRole({ ...data, isBuiltIn: false });
        this.roles.set(role.id, role);
        this.persistRole(role);
        this.reload();
        this.notifyRolesChanged();

        log.info(`Created custom role: ${role.id}`);
        return role;
    }

    /**
     * Delete a custom role
     * @returns true if deleted, false if role doesn't exist or is built-in
     */
    deleteCustomRole(roleId: string): boolean {
        const role = this.roles.get(roleId);
        if (!role) {
            log.warn(`Cannot delete non-existent role: ${roleId}`);
            return false;
        }
        if (role.isBuiltIn) {
            log.warn(`Cannot delete built-in role: ${roleId}`);
            return false;
        }

        this.roles.delete(roleId);
        this.stateManager.deleteRoleConfig(roleId);
        this.reload();
        this.notifyRolesChanged();

        log.info(`Deleted custom role: ${roleId}`);
        return true;
    }

    /**
     * Persist a role to storage
     */
    private persistRole(role: AgentRole): void {
        if (role.isBuiltIn) {
            // Save modifications to built-in role
            this.stateManager.saveRoleConfig(role.id, role.toJSON());
        } else {
            // Save custom role
            this.stateManager.saveCustomRole(role.toJSON());
        }
    }

    /**
     * Reload all roles from storage
     */
    reload(): void {
        this.roles.clear();
        this.systemPrompts.clear();
        this.loadRoles();
        this.loadSystemPrompts();
        this.notifyRolesChanged();
        this.notifySystemPromptsChanged();
    }

    /**
     * Get role IDs sorted by display order (built-in first, then custom alphabetically)
     */
    getRoleIdsSorted(): string[] {
        // Define display order for built-in roles (grouped by category)
        const builtInOrder = [
            // Core execution roles
            'engineer',
            'code_reviewer',
            // Context roles (gathering + delta updates)
            'context_gatherer',
            // Planning roles  
            'planner',
            'analyst_implementation',
            'analyst_quality',
            'analyst_architecture'
            // Note: error_analyst removed - ErrorResolutionWorkflow uses engineer role
        ];
        
        const builtIn = this.getBuiltInRoles()
            .sort((a, b) => {
                const aIndex = builtInOrder.indexOf(a.id);
                const bIndex = builtInOrder.indexOf(b.id);
                // Put unknown roles at the end (alphabetically)
                if (aIndex === -1 && bIndex === -1) return a.name.localeCompare(b.name);
                if (aIndex === -1) return 1;
                if (bIndex === -1) return -1;
                return aIndex - bIndex;
            })
            .map(r => r.id);
        
        const custom = this.getCustomRoles()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(r => r.id);
        
        return [...builtIn, ...custom];
    }

    /**
     * Validate a role configuration
     * @returns Array of validation errors, empty if valid
     */
    validateRole(data: Partial<AgentRole>): string[] {
        const errors: string[] = [];

        if (!data.id || typeof data.id !== 'string' || data.id.trim() === '') {
            errors.push('Role ID is required');
        } else if (!/^[a-z0-9_-]+$/i.test(data.id)) {
            errors.push('Role ID can only contain letters, numbers, underscores, and hyphens');
        }

        if (!data.name || typeof data.name !== 'string' || data.name.trim() === '') {
            errors.push('Role name is required');
        }

        if (data.timeoutMs !== undefined && (typeof data.timeoutMs !== 'number' || data.timeoutMs < 0)) {
            errors.push('Timeout must be a positive number');
        }

        if (data.allowedMcpTools !== null && data.allowedMcpTools !== undefined && !Array.isArray(data.allowedMcpTools)) {
            errors.push('Allowed MCP tools must be an array or null');
        }

        if (data.allowedCliCommands !== null && data.allowedCliCommands !== undefined && !Array.isArray(data.allowedCliCommands)) {
            errors.push('Allowed CLI commands must be an array or null');
        }

        if (data.documents !== undefined && !Array.isArray(data.documents)) {
            errors.push('Documents must be an array');
        }

        return errors;
    }
    
    // ========================================================================
    // Unity-Aware Role Methods
    // ========================================================================
    
    /**
     * Get the effective prompt for a role, with Unity additions if enabled
     * @param roleId The role ID
     * @returns The complete prompt template (base + Unity addendum if enabled)
     */
    getEffectivePrompt(roleId: string): string {
        const role = this.roles.get(roleId);
        if (!role) {
            return '';
        }
        
        let prompt = role.promptTemplate;
        
        // Append Unity addendum if Unity is enabled and role has one
        if (this._unityEnabled && role.unityPromptAddendum) {
            prompt += '\n' + role.unityPromptAddendum;
        }
        
        return prompt;
    }
    
    /**
     * Get the effective MCP tools for a role, with Unity tools if enabled
     * @param roleId The role ID
     * @returns Array of allowed MCP tools, or null if all allowed
     */
    getEffectiveMcpTools(roleId: string): string[] | null {
        const role = this.roles.get(roleId);
        if (!role) {
            return null;
        }
        
        // If base allows all tools (null), return null (all allowed)
        if (role.allowedMcpTools === null) {
            return null;
        }
        
        // Start with base tools
        const tools = [...role.allowedMcpTools];
        
        // Add Unity tools if enabled
        if (this._unityEnabled && role.unityMcpTools && role.unityMcpTools.length > 0) {
            for (const tool of role.unityMcpTools) {
                if (!tools.includes(tool)) {
                    tools.push(tool);
                }
            }
        }
        
        return tools;
    }
    
    /**
     * Get a role with all effective fields resolved (Unity additions applied if enabled)
     * This creates a new AgentRole object with merged values - does NOT modify the stored role
     * @param roleId The role ID
     * @returns A new AgentRole with effective values, or undefined if role not found
     */
    getEffectiveRole(roleId: string): AgentRole | undefined {
        const role = this.roles.get(roleId);
        if (!role) {
            return undefined;
        }
        
        // Create a new role with effective values
        return new AgentRole({
            ...role,
            promptTemplate: this.getEffectivePrompt(roleId),
            allowedMcpTools: this.getEffectiveMcpTools(roleId)
        });
    }

    // ========================================================================
    // System Prompt Methods
    // ========================================================================

    /**
     * Get a system prompt by ID
     */
    getSystemPrompt(id: string): SystemPromptConfig | undefined {
        return this.systemPrompts.get(id);
    }

    /**
     * Get all system prompts
     */
    getAllSystemPrompts(): SystemPromptConfig[] {
        return Array.from(this.systemPrompts.values());
    }

    /**
     * Get system prompts by category
     */
    getSystemPromptsByCategory(category: 'execution' | 'planning' | 'utility'): SystemPromptConfig[] {
        return this.getAllSystemPrompts().filter(p => p.category === category);
    }

    /**
     * Update a system prompt configuration
     */
    updateSystemPrompt(config: SystemPromptConfig): void {
        this.systemPrompts.set(config.id, config);
        this.stateManager.saveSystemPromptConfig(config.id, config.toJSON());
        this.reloadSystemPrompts();
        this.notifySystemPromptsChanged();
        
        log.info(`Updated system prompt: ${config.id}`);
    }

    /**
     * Reset a system prompt to its defaults
     * @returns The reset config, or undefined if not a known system prompt
     */
    resetSystemPromptToDefault(promptId: string): SystemPromptConfig | undefined {
        const defaults = DefaultSystemPrompts[promptId];
        if (!defaults) {
            log.warn(`Cannot reset unknown system prompt: ${promptId}`);
            return undefined;
        }
        
        const config = new SystemPromptConfig(defaults);
        this.systemPrompts.set(promptId, config);
        this.stateManager.clearSystemPromptConfig(promptId);
        this.reloadSystemPrompts();
        this.notifySystemPromptsChanged();
        
        log.info(`Reset system prompt to default: ${promptId}`);
        return config;
    }

    /**
     * Get system prompt IDs sorted by display order (by category then alphabetically)
     */
    getSystemPromptIdsSorted(): string[] {
        const categoryOrder = ['execution', 'planning', 'utility'];
        
        return this.getAllSystemPrompts()
            .sort((a, b) => {
                const catDiff = categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category);
                if (catDiff !== 0) return catDiff;
                return a.name.localeCompare(b.name);
            })
            .map(p => p.id);
    }

    /**
     * Reload all system prompts from storage
     */
    reloadSystemPrompts(): void {
        this.systemPrompts.clear();
        this.loadSystemPrompts();
        this.notifySystemPromptsChanged();
    }

    /**
     * Get the effective prompt text for a system agent
     * This is the customized prompt if saved, otherwise the default
     */
    getEffectiveSystemPrompt(promptId: string): string {
        const config = this.systemPrompts.get(promptId);
        if (!config) {
            const defaults = DefaultSystemPrompts[promptId];
            return defaults?.promptTemplate || '';
        }
        return config.promptTemplate;
    }

    // ========================================================================
    // Bulk Reset Methods
    // ========================================================================

    /**
     * Reset all settings to defaults:
     * - Delete all custom roles
     * - Reset all built-in roles to defaults
     * - Reset all system prompts to defaults (includes coordinator)
     */
    resetAllToDefaults(): void {
        // Delete all custom roles
        const customRoles = this.getCustomRoles();
        for (const role of customRoles) {
            this.roles.delete(role.id);
            this.stateManager.deleteRoleConfig(role.id);
        }

        // Reset all built-in roles to defaults
        for (const [id, defaults] of Object.entries(DefaultRoleConfigs)) {
            const role = new AgentRole(defaults);
            this.roles.set(id, role);
            this.stateManager.clearRoleConfig(id);
        }

        // Reset all system prompts to defaults (includes coordinator)
        for (const [id, defaults] of Object.entries(DefaultSystemPrompts)) {
            const config = new SystemPromptConfig(defaults);
            this.systemPrompts.set(id, config);
            this.stateManager.clearSystemPromptConfig(id);
        }

        // Notify all listeners
        this.notifyRolesChanged();
        this.notifySystemPromptsChanged();

        log.info('Reset all settings to defaults');
    }
}

