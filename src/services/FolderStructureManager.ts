/**
 * FolderStructureManager - Manages customizable folder structure
 * 
 * This module allows users to customize the names of subdirectories within
 * the working directory (_AiDevLog by default).
 * 
 * Configuration is stored in <working_dir>/.config/folders.json
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Folder Structure Types
// ============================================================================

/**
 * Folder keys that can be customized
 */
export type FolderKey = 
    | 'plans'
    | 'tasks'
    | 'logs'
    | 'context'
    | 'docs'
    | 'errors'
    | 'scripts'
    | 'history'
    | 'notifications'
    | 'config'
    | 'cache';

/**
 * Folder structure configuration
 */
export interface FolderStructure {
    plans: string;
    tasks: string;
    logs: string;
    context: string;
    docs: string;
    errors: string;
    scripts: string;
    history: string;
    notifications: string;
    config: string;  // Always '.config' but included for completeness
    cache: string;   // Always '.cache' but included for completeness
}

/**
 * Default folder structure
 */
export const DEFAULT_FOLDER_STRUCTURE: FolderStructure = {
    plans: 'Plans',
    tasks: 'Tasks',
    logs: 'Logs',
    context: 'Context',
    docs: 'Docs',
    errors: 'Errors',
    scripts: 'Scripts',
    history: 'History',
    notifications: 'Notifications',
    config: '.config',
    cache: '.cache'
};

// ============================================================================
// Folder Structure Manager
// ============================================================================

/**
 * Manages folder structure configuration
 */
export class FolderStructureManager {
    private workingDir: string;
    private configPath: string;
    private folders: FolderStructure;
    private changeCallbacks: Array<(folders: FolderStructure) => void> = [];
    
    constructor(workingDir: string) {
        this.workingDir = workingDir;
        this.configPath = path.join(workingDir, '.config', 'folders.json');
        this.folders = this.loadFolders();
    }
    
    /**
     * Get the full folder structure
     */
    getFolders(): FolderStructure {
        return { ...this.folders };
    }
    
    /**
     * Get a specific folder name
     */
    getFolder(key: FolderKey): string {
        return this.folders[key];
    }
    
    /**
     * Get the full path for a folder
     */
    getFolderPath(key: FolderKey): string {
        return path.join(this.workingDir, this.folders[key]);
    }
    
    /**
     * Set a folder name (with validation)
     */
    setFolder(key: FolderKey, name: string): boolean {
        // Don't allow changing .config or .cache
        if (key === 'config' || key === 'cache') {
            console.warn(`FolderStructureManager: Cannot customize '${key}' folder`);
            return false;
        }
        
        // Validate folder name
        if (!this.validateFolderName(name)) {
            console.error(`FolderStructureManager: Invalid folder name: ${name}`);
            return false;
        }
        
        // Update and save
        this.folders[key] = name;
        this.saveFolders();
        this.notifyChange();
        
        return true;
    }
    
    /**
     * Reset all folders to defaults
     */
    resetFolders(): void {
        this.folders = { ...DEFAULT_FOLDER_STRUCTURE };
        this.saveFolders();
        this.notifyChange();
    }
    
    /**
     * Reset a specific folder to default
     */
    resetFolder(key: FolderKey): void {
        this.folders[key] = DEFAULT_FOLDER_STRUCTURE[key];
        this.saveFolders();
        this.notifyChange();
    }
    
    /**
     * Reload folders from disk
     */
    reload(): void {
        this.folders = this.loadFolders();
        this.notifyChange();
    }
    
    /**
     * Register a callback for folder changes
     */
    onChange(callback: (folders: FolderStructure) => void): () => void {
        this.changeCallbacks.push(callback);
        // Return unsubscribe function
        return () => {
            const index = this.changeCallbacks.indexOf(callback);
            if (index >= 0) {
                this.changeCallbacks.splice(index, 1);
            }
        };
    }
    
    /**
     * Ensure all folders exist
     */
    ensureAllFolders(): void {
        for (const key of Object.keys(this.folders) as FolderKey[]) {
            const folderPath = this.getFolderPath(key);
            if (!fs.existsSync(folderPath)) {
                fs.mkdirSync(folderPath, { recursive: true });
            }
        }
    }
    
    // ========================================================================
    // Private Methods
    // ========================================================================
    
    /**
     * Load folders from config file
     */
    private loadFolders(): FolderStructure {
        // Start with defaults
        const folders: FolderStructure = { ...DEFAULT_FOLDER_STRUCTURE };
        
        // Load from config file if exists
        if (fs.existsSync(this.configPath)) {
            try {
                const content = fs.readFileSync(this.configPath, 'utf-8');
                const loaded = JSON.parse(content);
                
                // Merge with defaults (only override valid keys)
                for (const key of Object.keys(DEFAULT_FOLDER_STRUCTURE) as FolderKey[]) {
                    if (loaded[key] && typeof loaded[key] === 'string') {
                        // Don't allow customizing .config or .cache
                        if (key === 'config' || key === 'cache') {
                            continue;
                        }
                        
                        if (this.validateFolderName(loaded[key])) {
                            folders[key] = loaded[key];
                        }
                    }
                }
            } catch (err) {
                console.warn(`FolderStructureManager: Failed to load folders from ${this.configPath}:`, err);
            }
        }
        
        return folders;
    }
    
    /**
     * Save folders to config file
     */
    private saveFolders(): void {
        try {
            // Ensure .config directory exists
            const configDir = path.dirname(this.configPath);
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }
            
            // Only save non-default values (except .config and .cache)
            const toSave: Partial<FolderStructure> = {};
            for (const key of Object.keys(this.folders) as FolderKey[]) {
                // Skip .config and .cache (always use defaults)
                if (key === 'config' || key === 'cache') {
                    continue;
                }
                
                // Only save if different from default
                if (this.folders[key] !== DEFAULT_FOLDER_STRUCTURE[key]) {
                    toSave[key] = this.folders[key];
                }
            }
            
            fs.writeFileSync(this.configPath, JSON.stringify(toSave, null, 2));
        } catch (err) {
            console.error(`FolderStructureManager: Failed to save folders to ${this.configPath}:`, err);
        }
    }
    
    /**
     * Validate folder name
     */
    private validateFolderName(name: string): boolean {
        // Must not be empty
        if (!name || name.trim().length === 0) {
            return false;
        }
        
        // Must not contain path separators
        if (name.includes('/') || name.includes('\\')) {
            return false;
        }
        
        // Must not be . or ..
        if (name === '.' || name === '..') {
            return false;
        }
        
        // Must not contain invalid characters (basic check)
        const invalidChars = /[<>:"|?*\x00-\x1f]/;
        if (invalidChars.test(name)) {
            return false;
        }
        
        return true;
    }
    
    /**
     * Notify all callbacks of folder structure change
     */
    private notifyChange(): void {
        for (const callback of this.changeCallbacks) {
            try {
                callback(this.getFolders());
            } catch (err) {
                console.error('FolderStructureManager: Error in change callback:', err);
            }
        }
    }
}

// ============================================================================
// Singleton Helper
// ============================================================================

let globalInstance: FolderStructureManager | null = null;
let globalWorkingDir: string | null = null;

/**
 * Get or create the global folder structure manager instance
 */
export function getFolderStructureManager(workingDir?: string): FolderStructureManager {
    // If workingDir is provided and different from current, reinitialize
    if (workingDir && globalWorkingDir !== workingDir) {
        console.log(`[FolderStructureManager] Initializing with workingDir: ${workingDir}`);
        if (globalInstance && globalWorkingDir) {
            console.log(`[FolderStructureManager] Replacing existing instance (was: ${globalWorkingDir})`);
        }
        globalInstance = new FolderStructureManager(workingDir);
        globalWorkingDir = workingDir;
    }
    
    if (!globalInstance) {
        throw new Error('FolderStructureManager: Not initialized. Call with workingDir first.');
    }
    
    return globalInstance;
}

/**
 * Reset the global instance (for testing or workspace changes)
 */
export function resetFolderStructureManager(): void {
    globalInstance = null;
    globalWorkingDir = null;
}

