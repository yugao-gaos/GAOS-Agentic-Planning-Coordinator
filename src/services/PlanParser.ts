import * as fs from 'fs';
import * as path from 'path';
import { getFolderStructureManager } from './FolderStructureManager';

// ============================================================================
// Plan Parser - Single Source of Truth for Plan/Task Parsing
// ============================================================================
//
// **Supported use cases:**
// - Auto-creating tasks on plan approval (PlanningService.approvePlan)
// - Extracting metadata (title, version, recommendedEngineerCount)
// - Calculating progress for display purposes (calculateProgressFromFile)
// - Parsing inline checkbox tasks for UI (PlanViewerPanel)
//
// **Task ID Format:**
// Supports both global format (ps_XXXXXX_TN) and simple format (T1, T2).
// Global format is preferred and used everywhere for consistency.
//
// **Plan Formats Supported:**
// 1. Legacy: ## Engineer's Checklist with - [ ] tasks
// 2. Modern: ### Section with #### Task X.Y and **Engineer**: Engineer-N
// 3. Table: | ID | Task | Dependencies | Files | Tests |
// 4. Inline Checkbox: - [ ] **ps_000001_T1**: Description | Deps: X | Engineer: TBD
// ============================================================================

/**
 * Parsed plan data structure
 */
export interface ParsedPlan {
    title: string;
    version: number;
    description: string;
    engineersNeeded: string[];
    recommendedEngineerCount: number;  // From plan's "Recommended: X engineers"
    engineerChecklists: Record<string, PlanTask[]>;
    tasks: PlanTask[];  // Flat list of all tasks
    metadata: PlanMetadata;
}

/**
 * Individual task from the plan
 */
export interface PlanTask {
    id: string;
    description: string;
    engineer: string;
    completed: boolean;
    approved: boolean;  // For revision-based approval
    dependencies: string[];
    section?: string;  // Which section the task belongs to
}

/**
 * Plan metadata
 */
export interface PlanMetadata {
    filePath: string;
    lastModified: Date;
    totalTasks: number;
    completedTasks: number;
    progress: number;  // Percentage
}

/**
 * Progress calculation result
 */
export interface PlanProgress {
    completed: number;
    total: number;
    percentage: number;
    byEngineer: Record<string, { completed: number; total: number }>;
}

/**
 * Basic parsed task (for inline checkbox format)
 * Used by UI components for lightweight task display
 */
export interface ParsedTaskBasic {
    id: string;
    description: string;
    completed: boolean;
    dependencies: string[];
    engineer: string;
}

// ============================================================================
// Regex Patterns for Task Parsing
// ============================================================================

/**
 * Pattern for inline checkbox format tasks:
 * - [ ] **T1**: Description | Deps: None | Engineer: TBD (local)
 * - [ ] **ps_000001_T1**: Description | Deps: ps_000001_T2 | Engineer: TBD (global)
 * 
 * Capture groups:
 * 1. Checkbox state (x, X, or space)
 * 2. Full task ID (e.g., "ps_000001_T1" or "T1")
 * 3. Description (everything before first |)
 * 4. Dependencies string (optional)
 * 5. Engineer name (optional)
 */
const INLINE_CHECKBOX_PATTERN = /^-\s*\[([xX ])\]\s*\*\*((?:ps_\d+_)?T[\d.]+)\*\*:\s*(.+?)(?:\s*\|\s*Deps?:\s*([^|]+))?(?:\s*\|\s*Engineer:\s*(\w+))?$/gm;

/**
 * Pattern for dependency references in deps string
 * Matches both: T1, T2.1, ps_000001_T1, ps_000001_T2.1
 */
const DEPENDENCY_PATTERN = /(?:ps_\d+_)?T[\d.]+/gi;

/**
 * Pattern for detecting table format tasks
 * Matches: | T1 | or | ps_000001_T1 |
 */
const TABLE_TASK_PATTERN = /\|\s*(?:ps_\d+_)?T\d+\s*\|/gi;

// ============================================================================
// Plan Parser Service
// ============================================================================

// Known engineer names (for mapping from Engineer-1, Engineer-2, etc.)
const ENGINEERS = ['Alex', 'Betty', 'Cleo', 'Dany', 'Echo', 'Finn', 'Gwen', 'Hugo', 'Iris', 'Jake', 'Kate', 'Liam'];

export class PlanParser {
    /**
     * Parse a plan markdown file
     * 
     * ⚠️ **DEPRECATED - DO NOT USE FOR TASK MANAGEMENT** ⚠️
     * 
     * This method is DEPRECATED for task extraction. The current architecture uses
     * TaskManager to manage tasks created via CLI commands (apc task create).
     * 
     * **Why deprecated:**
     * - Tasks are now created dynamically via CLI by the AI coordinator
     * - TaskManager is the authoritative source for task data
     * - Plan files may not contain task checklists in the current workflow
     * 
     * **Supported use cases (backward compatibility):**
     * - Legacy plan files with task checklists
     * - Progress calculation for display
     * 
     * **For new code, use instead:**
     * - TaskManager.getTasksForSession(sessionId) - to get tasks
     * - CoordinatorContext - for building coordinator input
     * - RevisionImpactAnalyzer - for revision impact (now uses TaskManager)
     * 
     * **Metadata extraction:**
     * If you only need metadata (title, recommendedEngineerCount), use
     * lightweight regex extraction instead of full parsing (see CoordinatorContext).
     * 
     * Supports three formats:
     * 1. Legacy: ## Engineer's Checklist with - [ ] tasks
     * 2. Modern: ### Section with #### Task X.Y and **Engineer**: Engineer-N
     * 3. Table: | ID | Task | Dependencies | Files | Tests |
     * 
     * @deprecated Use TaskManager for task management
     */
    static parsePlanFile(planPath: string): ParsedPlan {
        if (!fs.existsSync(planPath)) {
            throw new Error(`Plan file not found: ${planPath}`);
        }

        const content = fs.readFileSync(planPath, 'utf-8');
        const stats = fs.statSync(planPath);

        const plan: ParsedPlan = {
            title: '',
            version: 1,
            description: '',
            engineersNeeded: [],
            recommendedEngineerCount: 5,  // Default, will be overwritten if found
            engineerChecklists: {},
            tasks: [],
            metadata: {
                filePath: planPath,
                lastModified: stats.mtime,
                totalTasks: 0,
                completedTasks: 0,
                progress: 0
            }
        };

        // Extract title (first # heading)
        const titleMatch = content.match(/^#\s+(.+)$/m);
        if (titleMatch) {
            plan.title = titleMatch[1].trim();
        }

        // Extract version from title or content
        const versionMatch = content.match(/(?:version|v|revision)\s*(\d+)/i);
        if (versionMatch) {
            plan.version = parseInt(versionMatch[1], 10);
        }

        // Try to find recommended engineer count from plan
        // Matches: "**Recommended:** 5 engineers" or "Use 5 engineers"
        const recommendedMatch = content.match(/\*\*Recommended:\*\*\s*(\d+)\s*engineers/i) ||
                                 content.match(/use\s+(\d+)\s+engineers/i);
        if (recommendedMatch) {
            plan.recommendedEngineerCount = parseInt(recommendedMatch[1], 10);
        }
        const engineerCount = plan.recommendedEngineerCount;

        // Try legacy format first: ## Engineer's Checklist
        const legacyTasks = this.parseLegacyFormat(content);
        
        // Try modern format: ### Section with #### Task X.Y
        const modernTasks = this.parseModernFormat(content);

        // Try table format: | ID | Task | Dependencies | Files | Tests |
        const tableTasks = this.parseTableFormat(content);
        
        // Try inline checkbox format: - [ ] **ps_000001_T1**: Description | Deps: X | Engineer: TBD
        const inlineCheckboxParsed = this.parseInlineCheckboxTasks(content);
        const inlineCheckboxTasks: PlanTask[] = inlineCheckboxParsed.map((t) => ({
            id: t.id,
            description: t.description,
            engineer: t.engineer,
            completed: t.completed,
            approved: true,
            dependencies: t.dependencies,
            section: 'Task Breakdown'
        }));

        // Use whichever format found more tasks
        let tasks = legacyTasks;
        let formatName = 'legacy';
        if (modernTasks.length > tasks.length) { tasks = modernTasks; formatName = 'modern'; }
        if (tableTasks.length > tasks.length) { tasks = tableTasks; formatName = 'table'; }
        if (inlineCheckboxTasks.length > tasks.length) { tasks = inlineCheckboxTasks; formatName = 'inline-checkbox'; }
        
        if (tasks.length === 0) {
            console.warn(`[PlanParser] No tasks found in plan: ${planPath}`);
        } else {
            console.log(`[PlanParser] Found ${tasks.length} tasks using ${formatName} format`);
        }

        // Assign actual engineer names to tasks
        const engineerMapping = this.createEngineerMapping(tasks, engineerCount);
        
        // Check if all tasks have the same generic engineer (table format)
        // In that case, distribute tasks round-robin among available engineers
        const uniqueEngineers = new Set(tasks.map(t => t.engineer));
        const isTableFormat = uniqueEngineers.size === 1 && tasks[0]?.engineer.match(/Engineer-?\d+/i);
        
        let taskIndex = 0;
        for (const task of tasks) {
            let mappedName: string;
            
            if (isTableFormat) {
                // Table format: distribute tasks round-robin among engineers
                // This allows dynamic dispatch based on dependencies
                mappedName = ENGINEERS[taskIndex % engineerCount];
                taskIndex++;
            } else {
            // Map Engineer-N to actual name
                mappedName = engineerMapping[task.engineer] || task.engineer;
            }
            task.engineer = mappedName;
            
            // Add to engineer checklists
            if (!plan.engineerChecklists[mappedName]) {
                plan.engineerChecklists[mappedName] = [];
            }
            plan.engineerChecklists[mappedName].push(task);
            
            // Track engineers needed
            if (!plan.engineersNeeded.includes(mappedName)) {
                plan.engineersNeeded.push(mappedName);
            }
        }

        plan.tasks = tasks;

        // Calculate progress
        const progress = this.calculateProgress(plan);
        plan.metadata.totalTasks = progress.total;
        plan.metadata.completedTasks = progress.completed;
        plan.metadata.progress = progress.percentage;

        console.log(`[PlanParser] Parsed ${plan.tasks.length} tasks for ${plan.engineersNeeded.length} engineers: ${plan.engineersNeeded.join(', ')}`);

        return plan;
    }

    /**
     * Parse legacy format: ## Engineer's Checklist with - [ ] tasks
     */
    private static parseLegacyFormat(content: string): PlanTask[] {
        const tasks: PlanTask[] = [];
        
        // Pattern: ## Engineer's checklist or ## Engineer checklist
        const checklistPattern = /##\s*(\w+)['']?s?\s+checklist\s*([\s\S]*?)(?=(?:##\s*\w+['']?s?\s+checklist)|$)/gi;

        let match;
        while ((match = checklistPattern.exec(content)) !== null) {
            let engineerName = match[1].trim();
            const checklistContent = match[2].trim();

            // Normalize engineer name
            for (const eng of ENGINEERS) {
                if (eng.toLowerCase() === engineerName.toLowerCase()) {
                    engineerName = eng;
                    break;
                }
            }

            const engineerTasks = this.parseChecklist(checklistContent, engineerName);
            tasks.push(...engineerTasks);
        }

        return tasks;
    }

    /**
     * Parse modern format: #### Task X.Y and **Engineer**: Engineer-N
     * Tasks are dispatched dynamically by coordinator based on dependencies (no waves)
     * Supports both global format (ps_XXXXXX_TN) and simple format (T1, T2)
     */
    private static parseModernFormat(content: string): PlanTask[] {
        const tasks: PlanTask[] = [];
        
        // Find all task sections: #### Task X.Y: Title or #### Task ps_XXXXXX_T1: Title
        // Supports: "Task 1.1:", "Task T1:", "Task ps_000001_T1:"
        const taskPattern = /####\s*Task\s+((?:ps_\d+_)?T?\d+(?:\.\d+)?)[:\s]+([^\n]+)\n([\s\S]*?)(?=####\s*Task|\n###\s|$)/gi;
        
        let match;
        while ((match = taskPattern.exec(content)) !== null) {
            const rawTaskId = match[1];
            const title = match[2].trim();
            const taskContent = match[3];
            
            // Normalize the task ID
            const taskId = this.normalizeTaskId(rawTaskId);
            if (!taskId) continue;
            
            // Extract engineer assignment
            const engineerMatch = taskContent.match(/\*\*Engineer\*\*[:\s]+(\S+)/i);
            const engineer = engineerMatch ? engineerMatch[1].trim() : 'Engineer-1';
            
            // Check for completion markers (- [x] or ✓ or ✅ or COMPLETED status)
            const isComplete = /\[x\]/i.test(taskContent) || 
                               /✓/i.test(taskContent) || 
                               /✅/.test(taskContent) ||
                               /Status[:\s]*COMPLETED/i.test(taskContent);
            
            // Extract section header from context (e.g., ### Core Foundation, ### UI System)
            const sectionMatch = content.substring(0, match.index).match(/###\s+([^\n]+)/gi);
            const section = sectionMatch 
                ? sectionMatch[sectionMatch.length - 1].replace(/^###\s*/, '').trim()
                : 'Tasks';
            
            // Extract files to create for description
            const filesMatch = taskContent.match(/\*\*Files to create\*\*:\s*([\s\S]*?)(?=\*\*|$)/i);
            let description = title;
            if (filesMatch) {
                const files = filesMatch[1].match(/`[^`]+`/g) || [];
                if (files.length > 0) {
                    description = `${title} (${files.slice(0, 3).join(', ')}${files.length > 3 ? '...' : ''})`;
                }
            }
            
            // Extract dependencies from task content
            const depsMatch = taskContent.match(/\*\*Dep(?:endenc(?:y|ies))?\*\*[:\s]+([^\n]+)/i);
            const dependencies = depsMatch ? this.parseDependencies(depsMatch[1]) : [];
            
            tasks.push({
                id: taskId,
                description: description,
                engineer: engineer,
                completed: isComplete,
                approved: true,
                dependencies: dependencies,
                section: section
            });
        }
        
        return tasks;
    }

    /**
     * Parse table format: | ID | Task | Dependencies | Files | Tests |
     * This format is used in plans with Task Breakdown tables
     */
    private static parseTableFormat(content: string): PlanTask[] {
        const tasks: PlanTask[] = [];
        
        // Find task breakdown table section
        // Look for tables with ID/Task/Dependencies columns
        const lines = content.split('\n');
        let inTaskTable = false;
        let headerFound = false;
        let idCol = -1;
        let taskCol = -1;
        let depsCol = -1;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Skip empty lines
            if (!line) continue;
            
            // Check if this is a table row
            if (!line.startsWith('|')) {
                inTaskTable = false;
                headerFound = false;
                continue;
            }
            
            // Parse table cells
            const cells = line.split('|')
                .map(c => c.trim())
                .filter((c, idx, arr) => idx > 0 && idx < arr.length - 1); // Remove first/last empty cells
            
            // Check for header row with ID, Task, Dependencies
            if (!headerFound) {
                const headerLower = cells.map(c => c.toLowerCase());
                idCol = headerLower.findIndex(c => c === 'id');
                taskCol = headerLower.findIndex(c => c === 'task' || c === 'task name' || c === 'description');
                depsCol = headerLower.findIndex(c => c === 'dependencies' || c === 'deps' || c === 'depends on');
                
                if (idCol >= 0 && taskCol >= 0) {
                    headerFound = true;
                    inTaskTable = true;
                    continue;
                }
            }
            
            // Skip separator row (|---|---|---|)
            if (line.match(/^\|[\s\-:]+\|/)) {
                continue;
            }
            
            // Parse task row
            if (inTaskTable && headerFound && cells.length > Math.max(idCol, taskCol)) {
                const taskId = cells[idCol]?.trim();
                const taskDesc = cells[taskCol]?.trim();
                const depsStr = depsCol >= 0 ? cells[depsCol]?.trim() : '';
                
                // Skip if no valid task ID
                // Supports both global format (ps_XXXXXX_TN) and simple format (T1, T2)
                if (!taskId) continue;
                
                const normalizedId = this.normalizeTaskId(taskId);
                if (!normalizedId) continue;
                
                // Parse dependencies (supports both global and simple format)
                const dependencies = this.parseDependencies(depsStr);
                
                // Check for completion markers in task description
                const isComplete = /✅|✓|\[x\]/i.test(taskDesc) || /COMPLETED|DONE/i.test(taskDesc);
                
                tasks.push({
                    id: normalizedId,
                    description: taskDesc.replace(/✅|✓|\[x\]/gi, '').trim(),
                    engineer: 'Engineer-1',  // Will be assigned dynamically
                    completed: isComplete,
                    approved: true,
                    dependencies: dependencies,
                    section: 'Task Breakdown'
                });
            }
        }
        
        return tasks;
    }

    /**
     * Normalize a task ID to the standard format (UPPERCASE).
     * Supports both global format (ps_XXXXXX_XX) and simple format (T1, CTX1, etc.).
     * Returns the ID in uppercase if valid, or null if invalid.
     */
    private static normalizeTaskId(taskId: string): string | null {
        if (!taskId) return null;
        
        const trimmed = taskId.trim();
        
        // Global format: ps_XXXXXX_XX (e.g., ps_000001_T1, ps_000001_CTX1 -> uppercase)
        // Match any task ID after the session prefix, not just T\d+
        const globalMatch = trimmed.match(/^(ps_\d{6})_(\S+)$/i);
        if (globalMatch) {
            // Normalize to uppercase
            return `${globalMatch[1].toUpperCase()}_${globalMatch[2].toUpperCase()}`;
        }
        
        // Simple format: T1, T2, T3.1, CTX1, etc. (or just numbers: 1, 2, 3)
        // Accept any alphanumeric task ID pattern
        const simpleMatch = trimmed.match(/^([A-Za-z]*\d+(?:\.\d+)?)$/i);
        if (simpleMatch) {
            const id = simpleMatch[1].toUpperCase();
            // If no letter prefix, add 'T'
            return /^[A-Za-z]/.test(id) ? id : `T${id}`;
        }
        
        return null;
    }

    /**
     * Parse dependencies string into array of task IDs.
     * Supports both global format (ps_XXXXXX_XX) and simple format (T1, CTX1, etc.).
     */
    private static parseDependencies(depsStr: string): string[] {
        const dependencies: string[] = [];
        
        if (!depsStr || depsStr.toLowerCase() === 'none' || depsStr === '-' || depsStr === '') {
            return dependencies;
        }
        
        // Split by comma, "and", or space
        const depParts = depsStr.split(/[,\s]+(?:and\s+)?/).map(d => d.trim()).filter(d => d);
        
        for (const dep of depParts) {
            // Try global format first: ps_XXXXXX_XX (any task ID after session prefix)
            const globalMatch = dep.match(/(ps_\d{6})_(\S+)/i);
            if (globalMatch) {
                // Normalize to uppercase: PS_000001_T1
                dependencies.push(`${globalMatch[1].toUpperCase()}_${globalMatch[2].toUpperCase()}`);
                continue;
            }
            
            // Try simple format: T1, CTX1 or just numbers
            const simpleMatch = dep.match(/([A-Za-z]*\d+(?:\.\d+)?)/i);
            if (simpleMatch) {
                const id = simpleMatch[1].toUpperCase();
                // If no letter prefix, add 'T'
                dependencies.push(/^[A-Za-z]/.test(id) ? id : `T${id}`);
            }
        }
        
        return dependencies;
    }

    /**
     * Create mapping from Engineer-N to actual engineer names
     */
    private static createEngineerMapping(tasks: PlanTask[], engineerCount: number): Record<string, string> {
        const mapping: Record<string, string> = {};
        
        // Find all unique engineer references in tasks
        const engineerRefs = new Set<string>();
        for (const task of tasks) {
            engineerRefs.add(task.engineer);
        }
        
        // Map Engineer-N to actual names
        let engineerIndex = 0;
        for (const ref of engineerRefs) {
            if (ref.match(/Engineer-?\d+/i)) {
                const num = parseInt(ref.match(/\d+/)![0], 10);
                mapping[ref] = ENGINEERS[num - 1] || ENGINEERS[engineerIndex % ENGINEERS.length];
            } else if (ENGINEERS.includes(ref)) {
                mapping[ref] = ref; // Already a real name
            } else {
                mapping[ref] = ENGINEERS[engineerIndex % ENGINEERS.length];
            }
            engineerIndex++;
        }
        
        return mapping;
    }

    /**
     * Parse a checklist section for tasks
     */
    private static parseChecklist(content: string, engineer: string): PlanTask[] {
        const tasks: PlanTask[] = [];

        // Pattern: - [ ] or - [x] or N. [ ] or N. [x]
        // Also capture task ID if present:
        // - [ ] **T1**: Description (local format)
        // - [ ] **ps_000001_T1**: Description (global format)
        // - [ ] **Task 1.1**: Description (legacy format)
        const taskPattern = /(?:^|\n)\s*(?:(\d+)\.\s*)?[\-\*]\s*\[([ xX])\]\s*(?:\*\*(?:Task\s+)?((?:ps_\d+_)?T?[\d.]+)\*\*[:\s]*)?\s*(.+?)(?=\n|$)/g;

        let taskMatch;
        let taskIndex = 0;

        while ((taskMatch = taskPattern.exec(content)) !== null) {
            const lineNumber = taskMatch[1];
            const checkboxComplete = taskMatch[2].toLowerCase() === 'x';
            const explicitId = taskMatch[3];
            const description = taskMatch[4].trim();
            
            // Check for completion: [x] checkbox OR ✅ emoji in description
            const isComplete = checkboxComplete || /✅/.test(description);

            taskIndex++;
            const taskId = explicitId ? explicitId.toUpperCase() : `${engineer.charAt(0)}${taskIndex}`;

            tasks.push({
                id: taskId,
                description: description,
                engineer: engineer,
                completed: isComplete,
                approved: true,  // Default to approved, revision will mark affected as false
                dependencies: [],
                section: `${engineer}'s Checklist`
            });
        }

        return tasks;
    }

    /**
     * Calculate progress from parsed plan
     */
    static calculateProgress(plan: ParsedPlan): PlanProgress {
        let total = 0;
        let completed = 0;
        const byEngineer: Record<string, { completed: number; total: number }> = {};

        for (const [engineer, tasks] of Object.entries(plan.engineerChecklists)) {
            const engineerCompleted = tasks.filter(t => t.completed).length;
            const engineerTotal = tasks.length;

            total += engineerTotal;
            completed += engineerCompleted;

            byEngineer[engineer] = {
                completed: engineerCompleted,
                total: engineerTotal
            };
        }

        const percentage = total > 0 ? (completed / total) * 100 : 0;

        return {
            completed,
            total,
            percentage,
            byEngineer
        };
    }

    /**
     * Update task completion status in the plan file
     * This is what engineers call when they complete a task
     */
    static updateTaskCompletion(
        planPath: string,
        taskId: string,
        completed: boolean
    ): boolean {
        try {
            let content = fs.readFileSync(planPath, 'utf-8');

            // Find the task by ID and update its checkbox
            // Pattern: - [ ] **Task ID**: or just the task description that matches
            const checkboxBefore = completed ? '[ ]' : '[x]';
            const checkboxAfter = completed ? '[x]' : '[ ]';

            // Try to find task with explicit ID first
            const explicitPattern = new RegExp(
                `(\\[${checkboxBefore.replace('[', '\\[').replace(']', '\\]')}\\]\\s*\\*\\*(?:Task\\s+)?${taskId}\\*\\*)`,
                'i'
            );

            if (explicitPattern.test(content)) {
                content = content.replace(explicitPattern, (match) => {
                    return match.replace(checkboxBefore, checkboxAfter);
                });
                fs.writeFileSync(planPath, content, 'utf-8');
                return true;
            }

            // If no explicit ID, we can't safely update
            console.warn(`Could not find task ${taskId} in plan file`);
            return false;
        } catch (error) {
            console.error(`Failed to update task completion: ${error}`);
            return false;
        }
    }

    /**
     * Get plan file path from session ID
     * Uses FolderStructureManager for customizable path
     */
    static getPlanPath(workspaceRoot: string, sessionId: string): string {
        try {
            const folderStructure = getFolderStructureManager();
            return path.join(folderStructure.getFolderPath('plans'), `Plan_${sessionId}.md`);
        } catch {
            // Fallback if FolderStructureManager not initialized
            return path.join(workspaceRoot, '_AiDevLog', 'Plans', `Plan_${sessionId}.md`);
        }
    }

    /**
     * Check if plan file exists
     */
    static planExists(planPath: string): boolean {
        return fs.existsSync(planPath);
    }
    
    // ========================================================================
    // SIMPLIFIED PROGRESS TRACKING (New Architecture)
    // ========================================================================
    // In the new coordinator-driven architecture, tasks are created via CLI
    // commands, not parsed from the plan. These methods provide simple progress
    // tracking by counting checkboxes in the markdown file.
    
    /**
     * Calculate progress directly from a plan file by counting checkboxes
     * This is simpler than parsing the full plan structure
     */
    static calculateProgressFromFile(planPath: string): PlanProgress {
        if (!fs.existsSync(planPath)) {
            return {
                completed: 0,
                total: 0,
                percentage: 0,
                byEngineer: {}
            };
        }
        
        const content = fs.readFileSync(planPath, 'utf-8');
        return this.calculateProgressFromContent(content);
    }
    
    /**
     * Calculate progress from plan content by counting checkboxes
     */
    static calculateProgressFromContent(content: string): PlanProgress {
        // Count completed checkboxes: [x] or [X]
        const completedMatches = content.match(/\[x\]/gi) || [];
        const completed = completedMatches.length;
        
        // Count uncompleted checkboxes: [ ]
        const uncompletedMatches = content.match(/\[ \]/g) || [];
        const uncompleted = uncompletedMatches.length;
        
        const total = completed + uncompleted;
        const percentage = total > 0 ? (completed / total) * 100 : 0;
        
        return {
            completed,
            total,
            percentage,
            byEngineer: {} // Simplified - no engineer breakdown
        };
    }
    
    // ========================================================================
    // INLINE CHECKBOX PARSING (Used by UI and other components)
    // ========================================================================
    
    /**
     * Parse inline checkbox format tasks from content
     * 
     * Format: - [ ] **{taskId}**: Description | Deps: X | Engineer: Y
     * 
     * This is the preferred format for new plans as it's:
     * - Human readable in markdown
     * - Machine parseable
     * - Supports global task IDs (ps_XXXXXX_TN)
     * 
     * @param content The markdown content to parse
     * @returns Array of parsed tasks
     */
    static parseInlineCheckboxTasks(content: string): ParsedTaskBasic[] {
        const tasks: ParsedTaskBasic[] = [];
        
        // Reset regex state (important for global patterns)
        const pattern = new RegExp(INLINE_CHECKBOX_PATTERN.source, 'gm');
        
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
            const completed = match[1].toLowerCase() === 'x';
            const taskId = match[2].toUpperCase();
            const description = match[3].trim();
            const depsStr = match[4]?.trim() || 'None';
            const engineer = match[5]?.trim() || 'TBD';
            
            // Parse dependencies using the robust method
            const dependencies = this.parseDependenciesFromString(depsStr);
            
            tasks.push({
                id: taskId,
                description,
                completed,
                dependencies,
                engineer
            });
        }
        
        return tasks;
    }
    
    /**
     * Parse dependencies string into array of task IDs (public version)
     * 
     * Supports both local (T1, T2) and global (ps_000001_T1) formats.
     * Handles various separators: comma, "and", spaces.
     * 
     * @param depsStr The dependencies string (e.g., "T1, T2" or "ps_000001_T1 and ps_000001_T2")
     * @returns Array of normalized task IDs
     */
    static parseDependenciesFromString(depsStr: string): string[] {
        return this.parseDependencies(depsStr);
    }
    
    /**
     * Normalize a task ID to standard format (public version)
     * 
     * @param taskId Raw task ID string
     * @returns Normalized task ID or null if invalid
     */
    static normalizeTaskIdString(taskId: string): string | null {
        return this.normalizeTaskId(taskId);
    }
    
    /**
     * Check if content contains table format tasks
     * 
     * @param content The content to check
     * @returns Number of table format tasks found
     */
    static countTableFormatTasks(content: string): number {
        const matches = content.match(TABLE_TASK_PATTERN);
        return matches ? matches.length : 0;
    }
}

