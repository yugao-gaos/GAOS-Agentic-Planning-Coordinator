import * as fs from 'fs';
import * as path from 'path';
import { getFolderStructureManager } from './FolderStructureManager';
import { TaskIdValidator } from './TaskIdValidator';

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
// ONLY global format (PS_XXXXXX_TN) is supported. Example: PS_000001_T1
// Simple IDs like "T1" are NOT supported - plans must use full global IDs.
//
// **Plan Formats Supported:**
// 1. Table: | ID | Task | Dependencies | Files | Tests |
// 2. Inline Checkbox: - [ ] **PS_000001_T1**: Description | Deps: PS_000001_T2 | Engineer: TBD
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
    unity?: string;  // Unity pipeline config: none, prep, prep_editmode, prep_playmode, prep_playtest, full
}

// ============================================================================
// Regex Patterns for Task EXTRACTION (validation via TaskIdValidator)
// ============================================================================
//
// NOTE: These patterns are PERMISSIVE for extraction. All captured task IDs
// are validated through TaskIdValidator which enforces strict format:
// - PS_XXXXXX_T1 (simple numbered)
// - PS_XXXXXX_T7A (sub-task with letter)
// - PS_XXXXXX_T24_EVENTS (task with underscore suffix)
// - PS_XXXXXX_CTX1 (context task)
//
// INVALID formats rejected by TaskIdValidator:
// - PS_XXXXXX_T24EVENTS (missing underscore before suffix)
// - T1 (missing session prefix)
// ============================================================================

/**
 * Pattern for inline checkbox format tasks (FLEXIBLE - handles AI variations):
 * Standard: - [ ] **PS_000001_T1**: Description | Deps: None | Engineer: TBD | Unity: none
 * No bold:  - [ ] PS_000001_T1: Description | Deps: None | Engineer: TBD
 * Asterisk: * [ ] **PS_000001_T1**: Description | Deps: None
 * Lettered: - [ ] **PS_000001_T7A**: Description (supports T0A, T7B, T24B, etc.)
 * Suffixed: - [ ] **PS_000001_T9_EVENTS**: Description (requires underscore: T9_EVENTS, not T9EVENTS)
 * No pipes: - [ ] **PS_000001_T1**: Full description without metadata fields
 * 
 * Capture groups:
 * 1. Checkbox state (x, X, or space)
 * 2. Raw task ID - validated via TaskIdValidator after capture
 * 3. Description (everything before first | or end of line)
 * 4. Dependencies string (optional)
 * 5. Engineer name (optional)
 * 6. Unity pipeline config (optional) - e.g., "none", "prep", "prep_editmode", "prep_playmode", "full"
 * 
 * NOTE: This pattern is intentionally permissive for extraction.
 * TaskIdValidator enforces strict format validation after capture.
 */
const INLINE_CHECKBOX_PATTERN = /^[-*]\s*\[([xX ])\]\s*\*{0,2}((?:ps_\d+_)?T[\dA-Z_]+)\*{0,2}:\s*([^|]+)(?:\s*\|\s*Deps?:\s*([^|]+))?(?:\s*\|\s*Engineer:\s*([^|]+))?(?:\s*\|\s*Unity:\s*([^|\n]+))?.*$/gim;

/**
 * Pattern for dependency references in deps string (extraction only)
 * Validation happens via TaskIdValidator.extractGlobalTaskId()
 */
const DEPENDENCY_PATTERN = /(?:ps_\d+_)?T[\dA-Z_]+/gi;

/**
 * Pattern for detecting table format tasks (counting only)
 */
const TABLE_TASK_PATTERN = /\|\s*(?:ps_\d+_)?T[\dA-Z_]+\s*\|/gi;

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
     * Only accepts global format (PS_XXXXXX_TN).
     * Returns the ID in uppercase if valid, or null if invalid.
     * 
     * Delegates to TaskIdValidator as the single source of truth.
     */
    private static normalizeTaskId(taskId: string): string | null {
        return TaskIdValidator.normalizeTaskId(taskId);
    }

    /**
     * Parse dependencies string into array of task IDs.
     * Only accepts global format (PS_XXXXXX_TN).
     * 
     * Uses TaskIdValidator for ID extraction and normalization.
     */
    private static parseDependencies(depsStr: string): string[] {
        const dependencies: string[] = [];
        
        if (!depsStr || depsStr.toLowerCase() === 'none' || depsStr === '-' || depsStr === '') {
            return dependencies;
        }
        
        // Split by comma, "and", or space
        const depParts = depsStr.split(/[,\s]+(?:and\s+)?/).map(d => d.trim()).filter(d => d);
        
        for (const dep of depParts) {
            // Only global format supported - extract using TaskIdValidator
            const globalId = TaskIdValidator.extractGlobalTaskId(dep);
            if (globalId) {
                dependencies.push(globalId);
            }
            // Invalid/simple IDs are silently skipped - plans must use global format
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
        // - [ ] **T1**: Description (local format - NOT supported, must be global)
        // - [ ] **ps_000001_T1**: Description (global format - REQUIRED)
        // - [ ] **Task 1.1**: Description (legacy format - NOT supported)
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
            
            // Task must have explicit ID - no auto-generation
            if (!explicitId) {
                // Skip tasks without explicit IDs - they must use global format
                continue;
            }
            
            // UNIFIED VALIDATION: Use TaskIdValidator as single source of truth
            const taskId = TaskIdValidator.normalizeGlobalTaskId(explicitId);
            if (!taskId) {
                // Not a valid global ID - skip
                console.warn(`[PlanParser] Skipping task with invalid ID "${explicitId}" in checklist: Must be global format PS_XXXXXX_TN`);
                continue;
            }

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
        // IMPORTANT: Include 'i' flag for case-insensitive matching (PS_000002_ or ps_000002_)
        const pattern = new RegExp(INLINE_CHECKBOX_PATTERN.source, 'gim');
        
        let match: RegExpExecArray | null;
        let tasksWithDeps = 0;
        let skippedInvalidIds = 0;
        
        while ((match = pattern.exec(content)) !== null) {
            const completed = match[1].toLowerCase() === 'x';
            const rawTaskId = match[2];
            const description = match[3].trim();
            const depsStr = match[4]?.trim() || 'None';
            const engineer = match[5]?.trim() || 'TBD';
            const unity = match[6]?.trim() || 'none';  // Default to 'none' if not specified
            
            // UNIFIED VALIDATION: Use TaskIdValidator as single source of truth
            // Try global format first (ps_XXXXXX_TN)
            let taskId = TaskIdValidator.normalizeGlobalTaskId(rawTaskId);
            
            if (!taskId) {
                // Not a valid global ID - log warning and skip
                console.warn(`[PlanParser] Skipping task with invalid ID "${rawTaskId}": Must be global format PS_XXXXXX_TN (e.g., PS_000001_T1, PS_000001_T24_EVENTS). Suffixes require underscore.`);
                skippedInvalidIds++;
                continue;
            }
            
            // Parse dependencies using the robust method
            const dependencies = this.parseDependenciesFromString(depsStr);
            
            if (dependencies.length > 0) {
                tasksWithDeps++;
            }
            
            tasks.push({
                id: taskId,
                description,
                completed,
                dependencies,
                engineer,
                unity
            });
        }
        
        // Log summary of skipped invalid IDs
        if (skippedInvalidIds > 0) {
            console.warn(`[PlanParser] Skipped ${skippedInvalidIds} tasks with invalid IDs. Valid formats: PS_000001_T1, PS_000001_T7A, PS_000001_T24_EVENTS`);
        }
        
        // Log warning if tasks found but none have dependencies (suspicious)
        if (tasks.length > 1 && tasksWithDeps === 0) {
            console.warn(`[PlanParser] WARNING: Found ${tasks.length} tasks but NONE have dependencies. Plan format may be missing pipe-separated metadata.`);
            console.warn(`[PlanParser] Expected format: - [ ] **PS_000001_T1**: Description | Deps: PS_000001_T2 | Engineer: TBD`);
            // Show sample of what was parsed
            if (tasks.length > 0) {
                const sample = tasks[0];
                console.warn(`[PlanParser] Sample parsed task: id=${sample.id}, desc="${sample.description.substring(0, 50)}...", deps=[${sample.dependencies.join(',')}]`);
            }
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
    
    // ========================================================================
    // FORMAT VALIDATION (for workflow format validation loops)
    // ========================================================================
    
    /**
     * Result of format validation
     */
    static validatePlanFormat(content: string, sessionId: string): PlanFormatValidationResult {
        const errors: PlanFormatError[] = [];
        const warnings: string[] = [];
        let validTaskCount = 0;
        
        // Reset regex state
        const pattern = new RegExp(INLINE_CHECKBOX_PATTERN.source, 'gim');
        
        let match: RegExpExecArray | null;
        let taskLikeCount = 0;  // Count of things that look like tasks
        let tasksWithDeps = 0;
        
        while ((match = pattern.exec(content)) !== null) {
            taskLikeCount++;
            const rawTaskId = match[2];
            const lineNumber = this.getLineNumber(content, match.index);
            
            // Validate task ID through TaskIdValidator
            const normalizedId = TaskIdValidator.normalizeGlobalTaskId(rawTaskId);
            
            if (!normalizedId) {
                // Determine the specific error
                let errorMessage: string;
                let suggestion: string;
                
                if (!rawTaskId.toLowerCase().startsWith('ps_')) {
                    errorMessage = `Task ID "${rawTaskId}" missing session prefix`;
                    suggestion = `Change to "${sessionId}_${rawTaskId}"`;
                } else if (/T\d+[A-Z]{2,}/.test(rawTaskId.toUpperCase()) && !rawTaskId.includes('_')) {
                    // Matches things like T24EVENTS (multiple letters after number, no underscore)
                    const parts = rawTaskId.toUpperCase().match(/^(.*?)(T\d+)([A-Z]{2,})$/i);
                    if (parts) {
                        errorMessage = `Task ID "${rawTaskId}" has suffix without underscore separator`;
                        suggestion = `Change to "${parts[1]}${parts[2]}_${parts[3]}"`;
                    } else {
                        errorMessage = `Task ID "${rawTaskId}" has invalid format`;
                        suggestion = `Use format: ${sessionId}_T1, ${sessionId}_T7A, or ${sessionId}_T24_EVENTS`;
                    }
                } else {
                    errorMessage = `Task ID "${rawTaskId}" has invalid format`;
                    suggestion = `Use format: ${sessionId}_T1, ${sessionId}_T7A, or ${sessionId}_T24_EVENTS`;
                }
                
                errors.push({
                    line: lineNumber,
                    rawId: rawTaskId,
                    message: errorMessage,
                    suggestion
                });
            } else {
                validTaskCount++;
                
                // Check dependencies
                const depsStr = match[4]?.trim() || '';
                if (depsStr && depsStr.toLowerCase() !== 'none') {
                    const deps = this.parseDependenciesFromString(depsStr);
                    if (deps.length > 0) {
                        tasksWithDeps++;
                    }
                }
            }
        }
        
        // Check for tasks without pipe-separated metadata
        if (validTaskCount > 1 && tasksWithDeps === 0) {
            warnings.push(
                `Found ${validTaskCount} tasks but NONE have dependencies. ` +
                `Plan may be missing pipe-separated metadata. ` +
                `Expected format: - [ ] **${sessionId}_T1**: Description | Deps: ${sessionId}_T2 | Engineer: TBD`
            );
        }
        
        // Check if no tasks found at all
        if (taskLikeCount === 0) {
            warnings.push(
                `No tasks found in plan. Expected checkbox format: ` +
                `- [ ] **${sessionId}_T1**: Description | Deps: None | Engineer: TBD`
            );
        }
        
        return {
            valid: errors.length === 0,
            errors,
            warnings,
            validTaskCount,
            totalTaskLikeCount: taskLikeCount
        };
    }
    
    /**
     * Validate plan format from file path
     */
    static validatePlanFormatFromFile(planPath: string, sessionId: string): PlanFormatValidationResult {
        if (!fs.existsSync(planPath)) {
            return {
                valid: false,
                errors: [{
                    line: 0,
                    rawId: '',
                    message: `Plan file not found: ${planPath}`,
                    suggestion: 'Ensure the plan file exists'
                }],
                warnings: [],
                validTaskCount: 0,
                totalTaskLikeCount: 0
            };
        }
        
        const content = fs.readFileSync(planPath, 'utf-8');
        return this.validatePlanFormat(content, sessionId);
    }
    
    /**
     * Format validation errors for display in prompts
     */
    static formatValidationErrorsForPrompt(result: PlanFormatValidationResult): string {
        if (result.valid && result.warnings.length === 0) {
            return '';
        }
        
        const lines: string[] = [];
        
        if (result.errors.length > 0) {
            lines.push(`## ❌ FORMAT ERRORS (${result.errors.length} found - MUST FIX)`);
            lines.push('');
            for (const error of result.errors) {
                lines.push(`- **Line ${error.line}**: ${error.message}`);
                lines.push(`  - Raw ID: \`${error.rawId}\``);
                lines.push(`  - Fix: ${error.suggestion}`);
            }
            lines.push('');
        }
        
        if (result.warnings.length > 0) {
            lines.push(`## ⚠️ WARNINGS`);
            lines.push('');
            for (const warning of result.warnings) {
                lines.push(`- ${warning}`);
            }
            lines.push('');
        }
        
        return lines.join('\n');
    }
    
    /**
     * Get line number from content index
     */
    private static getLineNumber(content: string, index: number): number {
        return content.substring(0, index).split('\n').length;
    }
}

/**
 * Result of plan format validation
 */
export interface PlanFormatValidationResult {
    /** Whether the plan format is valid (no errors) */
    valid: boolean;
    /** List of format errors found */
    errors: PlanFormatError[];
    /** List of warnings (non-blocking) */
    warnings: string[];
    /** Number of valid tasks found */
    validTaskCount: number;
    /** Total number of task-like patterns found (including invalid) */
    totalTaskLikeCount: number;
}

/**
 * Individual format error
 */
export interface PlanFormatError {
    /** Line number in the file */
    line: number;
    /** Raw task ID that failed validation */
    rawId: string;
    /** Error message */
    message: string;
    /** Suggested fix */
    suggestion: string;
}

