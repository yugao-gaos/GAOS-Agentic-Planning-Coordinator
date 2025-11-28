import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Plan Parser Types
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

// ============================================================================
// Plan Parser Service
// ============================================================================

// Known engineer names (for mapping from Engineer-1, Engineer-2, etc.)
const ENGINEERS = ['Alex', 'Betty', 'Cleo', 'Dany', 'Echo', 'Finn', 'Gwen', 'Hugo', 'Iris', 'Jake', 'Kate', 'Liam'];

export class PlanParser {
    /**
     * Parse a plan markdown file
     * Supports two formats:
     * 1. Legacy: ## Engineer's Checklist with - [ ] tasks
     * 2. Modern: ### Section with #### Task X.Y and **Engineer**: Engineer-N
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

        // Use whichever format found more tasks
        const tasks = modernTasks.length > legacyTasks.length ? modernTasks : legacyTasks;
        
        if (tasks.length === 0) {
            console.warn(`[PlanParser] No tasks found in plan: ${planPath}`);
        }

        // Assign actual engineer names to tasks
        const engineerMapping = this.createEngineerMapping(tasks, engineerCount);
        
        for (const task of tasks) {
            // Map Engineer-N to actual name
            const mappedName = engineerMapping[task.engineer] || task.engineer;
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
     */
    private static parseModernFormat(content: string): PlanTask[] {
        const tasks: PlanTask[] = [];
        
        // Find all task sections: #### Task X.Y: Title
        const taskPattern = /####\s*Task\s+(\d+(?:\.\d+)?)[:\s]+([^\n]+)\n([\s\S]*?)(?=####\s*Task|\n###\s|$)/gi;
        
        let match;
        while ((match = taskPattern.exec(content)) !== null) {
            const taskId = `T${match[1].replace('.', '-')}`;
            const title = match[2].trim();
            const taskContent = match[3];
            
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
            
            tasks.push({
                id: taskId,
                description: description,
                engineer: engineer,
                completed: isComplete,
                approved: true,
                dependencies: [],
                section: section
            });
        }
        
        return tasks;
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
        // Also capture task ID if present: - [ ] **Task 1.1**: Description
        const taskPattern = /(?:^|\n)\s*(?:(\d+)\.\s*)?[\-\*]\s*\[([ xX])\]\s*(?:\*\*(?:Task\s+)?(\d+(?:\.\d+)?)\*\*[:\s]*)?\s*(.+?)(?=\n|$)/g;

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
            const taskId = explicitId || `${engineer.charAt(0)}${taskIndex}`;

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
     * Get uncompleted tasks grouped by engineer
     */
    static getUncompletedTasks(plan: ParsedPlan): Record<string, PlanTask[]> {
        const uncompleted: Record<string, PlanTask[]> = {};

        for (const [engineer, tasks] of Object.entries(plan.engineerChecklists)) {
            const engineerTasks = tasks.filter(t => !t.completed && t.approved);
            if (engineerTasks.length > 0) {
                uncompleted[engineer] = engineerTasks;
            }
        }

        return uncompleted;
    }

    /**
     * Get the next task for an engineer
     */
    static getNextTask(plan: ParsedPlan, engineer: string): PlanTask | undefined {
        const tasks = plan.engineerChecklists[engineer];
        if (!tasks) return undefined;

        return tasks.find(t => !t.completed && t.approved);
    }

    /**
     * Mark tasks as affected by revision (unapproved)
     * Returns list of affected task IDs
     */
    static markTasksAffectedByRevision(
        plan: ParsedPlan,
        affectedTaskIds: string[]
    ): string[] {
        const marked: string[] = [];

        for (const tasks of Object.values(plan.engineerChecklists)) {
            for (const task of tasks) {
                if (affectedTaskIds.includes(task.id)) {
                    task.approved = false;
                    marked.push(task.id);
                }
            }
        }

        // Also update flat task list
        for (const task of plan.tasks) {
            if (affectedTaskIds.includes(task.id)) {
                task.approved = false;
            }
        }

        return marked;
    }

    /**
     * Re-approve tasks after revision is approved
     */
    static approveAllTasks(plan: ParsedPlan): void {
        for (const tasks of Object.values(plan.engineerChecklists)) {
            for (const task of tasks) {
                task.approved = true;
            }
        }

        for (const task of plan.tasks) {
            task.approved = true;
        }
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
     */
    static getPlanPath(workspaceRoot: string, sessionId: string): string {
        return path.join(workspaceRoot, '_AiDevLog', 'Plans', `Plan_${sessionId}.md`);
    }

    /**
     * Check if plan file exists
     */
    static planExists(planPath: string): boolean {
        return fs.existsSync(planPath);
    }
}

