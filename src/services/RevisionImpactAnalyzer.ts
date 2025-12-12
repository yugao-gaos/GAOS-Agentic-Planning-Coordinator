// ============================================================================
// RevisionImpactAnalyzer - Intelligently detects which tasks are affected by a revision
// ============================================================================

import * as fs from 'fs';
import { PlanTask, PlanParser } from './PlanParser';
import { ServiceLocator } from './ServiceLocator';
import { TaskManager } from './TaskManager';

/**
 * Revision impact analysis result for a single task
 */
export interface TaskImpact {
    taskId: string;
    taskDescription: string;
    impactLevel: 'high' | 'medium' | 'low' | 'none';
    reasons: string[];
    matchedKeywords: string[];
    affectedByDependency: boolean;  // true if affected because a dependency is affected
}

/**
 * Overall revision impact analysis result
 */
export interface RevisionImpactResult {
    /** Tasks directly affected by the revision feedback */
    directlyAffected: TaskImpact[];
    
    /** Tasks affected because they depend on directly affected tasks */
    transitivelyAffected: TaskImpact[];
    
    /** Tasks that are definitely not affected */
    unaffected: TaskImpact[];
    
    /** Summary of analysis */
    summary: {
        totalTasks: number;
        affectedCount: number;
        unaffectedCount: number;
        primaryKeywords: string[];
        analysisConfidence: 'high' | 'medium' | 'low';
    };
}

/**
 * Options for impact analysis
 */
export interface AnalysisOptions {
    /** Minimum confidence to consider a task affected (0-1) */
    minConfidence?: number;
    
    /** Include transitive dependencies (tasks that depend on affected tasks) */
    includeTransitive?: boolean;
    
    /** Consider currently in-progress tasks as potentially affected */
    considerInProgress?: boolean;
}

/**
 * RevisionImpactAnalyzer
 * 
 * Analyzes revision feedback to determine which tasks are affected.
 * Uses multiple heuristics:
 * 1. Keyword matching (task description vs feedback)
 * 2. Entity extraction (file names, class names, feature names)
 * 3. Semantic similarity (key phrases)
 * 4. Dependency chain analysis
 */
export class RevisionImpactAnalyzer {
    
    // Common words to ignore in keyword matching
    private static readonly STOP_WORDS = new Set([
        'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
        'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
        'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
        'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can',
        'need', 'this', 'that', 'these', 'those', 'it', 'its', 'i', 'you',
        'we', 'they', 'my', 'your', 'our', 'their', 'what', 'which', 'who',
        'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few',
        'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
        'own', 'same', 'so', 'than', 'too', 'very', 'just', 'also', 'now',
        'task', 'implement', 'create', 'add', 'make', 'use', 'using'
    ]);
    
    // High-signal words that indicate specific changes
    private static readonly HIGH_SIGNAL_PATTERNS = [
        /remove|delete|drop/i,
        /rename|change\s+name/i,
        /replace|swap|switch/i,
        /refactor/i,
        /move|relocate/i,
        /split|separate|divide/i,
        /merge|combine|consolidate/i,
        /reorder|reorganize/i,
        /simplify|reduce/i,
        /expand|extend|enhance/i
    ];
    
    /**
     * Analyze revision feedback to determine affected tasks
     * 
     * @param feedback - The revision feedback text
     * @param sessionIdOrPlanPath - The session ID or full plan path (sessionId is extracted from path)
     * @param currentTaskStates - Optional current task states
     * @param options - Analysis options
     */
    static analyze(
        feedback: string,
        sessionIdOrPlanPath: string,
        currentTaskStates?: Map<string, { status: string; filesModified: string[] }>,
        options: AnalysisOptions = {}
    ): RevisionImpactResult {
        const {
            minConfidence = 0.3,
            includeTransitive = true,
            considerInProgress = true
        } = options;
        
        // Extract sessionId from planPath if needed
        // Supports both Unix (/) and Windows (\) paths
        // e.g., "/path/Plans/ps_000001/plan.md" or "D:\path\Plans\ps_000001\plan.md" -> "ps_000001"
        let sessionId = sessionIdOrPlanPath;
        let planPath: string | undefined;
        
        if (sessionIdOrPlanPath.includes('/') || sessionIdOrPlanPath.includes('\\')) {
            // This is a path, extract sessionId
            planPath = sessionIdOrPlanPath;
            const match = sessionIdOrPlanPath.match(/[/\\](ps_\d+)[/\\]/);
            if (match) {
                sessionId = match[1];
            }
        }
        
        // Get tasks from TaskManager first (authoritative source)
        const taskManager = ServiceLocator.resolve(TaskManager);
        let managedTasks = taskManager.getTasksForSession(sessionId);
        
        // If no tasks in TaskManager, fall back to parsing the existing plan file
        // This handles the revision case where tasks haven't been created yet
        if (managedTasks.length === 0 && planPath && fs.existsSync(planPath)) {
            console.warn(`[RevisionImpactAnalyzer] No tasks in TaskManager for session ${sessionId}, parsing plan file`);
            const parsedPlan = PlanParser.parsePlanFile(planPath);
            
            if (parsedPlan.tasks && parsedPlan.tasks.length > 0) {
                console.warn(`[RevisionImpactAnalyzer] Found ${parsedPlan.tasks.length} tasks from plan file`);
                // Use parsed tasks directly (they're already in PlanTask format)
                return this.analyzeWithTasks(feedback, parsedPlan.tasks, currentTaskStates, options);
            }
        }
        
        if (managedTasks.length === 0) {
            console.warn(`[RevisionImpactAnalyzer] No tasks found for session ${sessionId}`);
            return this.createEmptyResult();
        }
        
        // Convert ManagedTask[] to PlanTask[] format for compatibility with existing analysis logic
        const allTasks: PlanTask[] = managedTasks.map(task => this.convertToPlanTask(task));
        
        // Delegate to core analysis logic
        return this.analyzeWithTasks(feedback, allTasks, currentTaskStates, options);
    }
    
    /**
     * Core analysis logic - analyzes tasks against feedback
     * 
     * @param feedback - The revision feedback text
     * @param allTasks - Tasks to analyze (in PlanTask format)
     * @param currentTaskStates - Optional current task states
     * @param options - Analysis options
     */
    private static analyzeWithTasks(
        feedback: string,
        allTasks: PlanTask[],
        currentTaskStates?: Map<string, { status: string; filesModified: string[] }>,
        options: AnalysisOptions = {}
    ): RevisionImpactResult {
        const {
            minConfidence = 0.3,
            includeTransitive = true,
        } = options;
        
        // Extract keywords and entities from feedback
        const feedbackAnalysis = this.analyzeFeedback(feedback);
        
        // Score each task
        const taskImpacts: TaskImpact[] = allTasks.map(task => 
            this.scoreTask(task, feedbackAnalysis, currentTaskStates?.get(task.id))
        );
        
        // Build dependency graph for transitive analysis
        const dependencyGraph = this.buildDependencyGraph(allTasks);
        
        // Categorize tasks
        const directlyAffected: TaskImpact[] = [];
        const unaffected: TaskImpact[] = [];
        
        for (const impact of taskImpacts) {
            if (impact.impactLevel === 'high' || impact.impactLevel === 'medium') {
                directlyAffected.push(impact);
            } else if (impact.impactLevel === 'none') {
                unaffected.push(impact);
            } else {
                // 'low' impact - check confidence
                const confidence = this.calculateConfidence(impact);
                if (confidence >= minConfidence) {
                    directlyAffected.push(impact);
                } else {
                    unaffected.push(impact);
                }
            }
        }
        
        // Find transitively affected tasks
        const transitivelyAffected: TaskImpact[] = [];
        
        if (includeTransitive) {
            const directIds = new Set(directlyAffected.map(t => t.taskId));
            
            for (const impact of unaffected) {
                // Check if any dependency is affected
                const deps = dependencyGraph.get(impact.taskId) || [];
                const affectedDep = deps.find(d => directIds.has(d));
                
                if (affectedDep) {
                    transitivelyAffected.push({
                        ...impact,
                        impactLevel: 'low',
                        affectedByDependency: true,
                        reasons: [...impact.reasons, `Depends on affected task ${affectedDep}`]
                    });
                }
            }
            
            // Remove transitively affected from unaffected
            const transitiveIds = new Set(transitivelyAffected.map(t => t.taskId));
            const finalUnaffected = unaffected.filter(t => !transitiveIds.has(t.taskId));
            
            return {
                directlyAffected,
                transitivelyAffected,
                unaffected: finalUnaffected,
                summary: this.createSummary(
                    allTasks.length,
                    directlyAffected,
                    transitivelyAffected,
                    finalUnaffected,
                    feedbackAnalysis
                )
            };
        }
        
        return {
            directlyAffected,
            transitivelyAffected: [],
            unaffected,
            summary: this.createSummary(
                allTasks.length,
                directlyAffected,
                [],
                unaffected,
                feedbackAnalysis
            )
        };
    }
    
    /**
     * Convert ManagedTask to PlanTask format for compatibility with existing analysis logic
     */
    private static convertToPlanTask(task: any): PlanTask {
        // Use global task ID - no conversion to local/simple ID
        const globalId = task.id.toUpperCase();
        
        // Keep dependencies as global IDs
        const globalDeps = (task.dependencies || []).map((depId: string) => depId.toUpperCase());
        
        return {
            id: globalId,
            description: task.description,
            completed: task.status === 'succeeded',
            approved: task.status === 'succeeded', // Succeeded tasks are implicitly approved
            engineer: task.actualAgent || 'Unassigned',
            dependencies: globalDeps
        };
    }
    
    /**
     * Analyze feedback text to extract meaningful signals
     */
    private static analyzeFeedback(feedback: string): {
        keywords: string[];
        entities: string[];
        actions: string[];
        hasSpecificTarget: boolean;
    } {
        const lowerFeedback = feedback.toLowerCase();
        
        // Extract keywords (significant words)
        const words = lowerFeedback
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2 && !this.STOP_WORDS.has(w));
        
        // Count word frequency for importance
        const wordCounts = new Map<string, number>();
        for (const word of words) {
            wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
        }
        
        // Get top keywords
        const keywords = [...wordCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([word]) => word);
        
        // Extract entities (capitalized words, file names, class names)
        const entityPatterns = [
            /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g,  // PascalCase
            /\b([a-z]+_[a-z_]+)\b/g,                // snake_case
            /\b([A-Z]{2,})\b/g,                      // UPPER_CASE
            /\b(\w+\.(cs|unity|prefab|asset|json|md))\b/gi,  // File extensions
            /["']([^"']+)["']/g                      // Quoted strings
        ];
        
        const entities: string[] = [];
        for (const pattern of entityPatterns) {
            let match;
            while ((match = pattern.exec(feedback)) !== null) {
                entities.push(match[1].toLowerCase());
            }
        }
        
        // Extract action verbs
        const actions: string[] = [];
        for (const pattern of this.HIGH_SIGNAL_PATTERNS) {
            if (pattern.test(feedback)) {
                const match = feedback.match(pattern);
                if (match) actions.push(match[0].toLowerCase());
            }
        }
        
        // Check if feedback targets something specific
        const hasSpecificTarget = 
            entities.length > 0 ||
            /task\s*(t?\d+|#\d+)/i.test(feedback) ||
            /(specific|particular|only|just)\s/i.test(feedback);
        
        return { keywords, entities, actions, hasSpecificTarget };
    }
    
    /**
     * Score a task for impact based on feedback analysis
     */
    private static scoreTask(
        task: PlanTask,
        feedbackAnalysis: { keywords: string[]; entities: string[]; actions: string[]; hasSpecificTarget: boolean },
        taskState?: { status: string; filesModified: string[] }
    ): TaskImpact {
        const taskDescLower = task.description.toLowerCase();
        const taskIdLower = task.id.toLowerCase();
        const reasons: string[] = [];
        const matchedKeywords: string[] = [];
        let score = 0;
        
        // Check for direct task ID mention
        if (feedbackAnalysis.entities.includes(taskIdLower) ||
            feedbackAnalysis.keywords.includes(taskIdLower)) {
            score += 100;
            reasons.push(`Task ${task.id} directly mentioned`);
            matchedKeywords.push(task.id);
        }
        
        // Check keyword overlap
        for (const keyword of feedbackAnalysis.keywords) {
            if (taskDescLower.includes(keyword)) {
                score += 10;
                matchedKeywords.push(keyword);
            }
        }
        
        // Check entity overlap
        for (const entity of feedbackAnalysis.entities) {
            if (taskDescLower.includes(entity)) {
                score += 20;
                matchedKeywords.push(entity);
                reasons.push(`Entity "${entity}" mentioned`);
            }
        }
        
        // Check if task files are mentioned (if we have state)
        if (taskState?.filesModified) {
            for (const file of taskState.filesModified) {
                const fileName = file.split('/').pop()?.toLowerCase() || '';
                if (feedbackAnalysis.entities.some(e => 
                    fileName.includes(e) || e.includes(fileName.replace(/\.\w+$/, ''))
                )) {
                    score += 30;
                    reasons.push(`File ${file} likely affected`);
                }
            }
        }
        
        // If feedback has specific target but task doesn't match, reduce score
        if (feedbackAnalysis.hasSpecificTarget && matchedKeywords.length === 0) {
            score = Math.floor(score * 0.3);
            reasons.push('Feedback targets specific items, task does not match');
        }
        
        // Determine impact level
        let impactLevel: TaskImpact['impactLevel'];
        if (score >= 50) {
            impactLevel = 'high';
        } else if (score >= 20) {
            impactLevel = 'medium';
        } else if (score > 0) {
            impactLevel = 'low';
        } else {
            impactLevel = 'none';
        }
        
        if (matchedKeywords.length > 0 && reasons.length === 0) {
            reasons.push(`Matched keywords: ${[...new Set(matchedKeywords)].slice(0, 5).join(', ')}`);
        }
        
        return {
            taskId: task.id,
            taskDescription: task.description,
            impactLevel,
            reasons,
            matchedKeywords: [...new Set(matchedKeywords)],
            affectedByDependency: false
        };
    }
    
    /**
     * Build dependency graph from tasks
     */
    private static buildDependencyGraph(tasks: PlanTask[]): Map<string, string[]> {
        const graph = new Map<string, string[]>();
        
        for (const task of tasks) {
            graph.set(task.id, task.dependencies || []);
        }
        
        return graph;
    }
    
    /**
     * Calculate confidence score for a task impact
     */
    private static calculateConfidence(impact: TaskImpact): number {
        if (impact.impactLevel === 'high') return 1.0;
        if (impact.impactLevel === 'medium') return 0.7;
        if (impact.impactLevel === 'low') {
            // Base confidence on reasons
            const reasonScore = Math.min(impact.reasons.length * 0.2, 0.5);
            const keywordScore = Math.min(impact.matchedKeywords.length * 0.1, 0.3);
            return reasonScore + keywordScore;
        }
        return 0;
    }
    
    /**
     * Create summary of analysis
     */
    private static createSummary(
        totalTasks: number,
        directly: TaskImpact[],
        transitively: TaskImpact[],
        unaffected: TaskImpact[],
        feedbackAnalysis: { keywords: string[]; entities: string[]; actions: string[]; hasSpecificTarget: boolean }
    ): RevisionImpactResult['summary'] {
        const affectedCount = directly.length + transitively.length;
        
        // Determine analysis confidence
        let analysisConfidence: 'high' | 'medium' | 'low';
        if (feedbackAnalysis.hasSpecificTarget && feedbackAnalysis.entities.length > 0) {
            analysisConfidence = 'high';
        } else if (feedbackAnalysis.keywords.length > 5) {
            analysisConfidence = 'medium';
        } else {
            analysisConfidence = 'low';
        }
        
        // Get primary keywords (most significant)
        const primaryKeywords = [
            ...feedbackAnalysis.entities.slice(0, 3),
            ...feedbackAnalysis.keywords.slice(0, 3)
        ].slice(0, 5);
        
        return {
            totalTasks,
            affectedCount,
            unaffectedCount: unaffected.length,
            primaryKeywords,
            analysisConfidence
        };
    }
    
    /**
     * Create empty result when no tasks found
     */
    private static createEmptyResult(): RevisionImpactResult {
        return {
            directlyAffected: [],
            transitivelyAffected: [],
            unaffected: [],
            summary: {
                totalTasks: 0,
                affectedCount: 0,
                unaffectedCount: 0,
                primaryKeywords: [],
                analysisConfidence: 'low'
            }
        };
    }
    
    /**
     * Quick check if feedback likely affects all tasks (global change)
     */
    static isGlobalRevision(feedback: string): boolean {
        const globalPatterns = [
            /all\s+tasks?/i,
            /entire\s+(plan|project|implementation)/i,
            /everything/i,
            /complete\s+restructure/i,
            /start\s+over/i,
            /from\s+scratch/i,
            /whole\s+(thing|plan|approach)/i
        ];
        
        return globalPatterns.some(p => p.test(feedback));
    }
    
    /**
     * Get human-readable summary of impact
     */
    static formatImpactSummary(result: RevisionImpactResult): string {
        const lines: string[] = [];
        
        lines.push(`📊 Revision Impact Analysis`);
        lines.push(`   Confidence: ${result.summary.analysisConfidence.toUpperCase()}`);
        lines.push(`   Keywords: ${result.summary.primaryKeywords.join(', ') || 'none detected'}`);
        lines.push(``);
        
        if (result.directlyAffected.length > 0) {
            lines.push(`🎯 Directly Affected (${result.directlyAffected.length}):`);
            for (const task of result.directlyAffected) {
                const icon = task.impactLevel === 'high' ? '🔴' : '🟡';
                lines.push(`   ${icon} ${task.taskId}: ${task.taskDescription.substring(0, 50)}...`);
                if (task.reasons.length > 0) {
                    lines.push(`      Reason: ${task.reasons[0]}`);
                }
            }
        }
        
        if (result.transitivelyAffected.length > 0) {
            lines.push(``);
            lines.push(`🔗 Transitively Affected (${result.transitivelyAffected.length}):`);
            for (const task of result.transitivelyAffected) {
                lines.push(`   🟠 ${task.taskId}: ${task.taskDescription.substring(0, 50)}...`);
            }
        }
        
        if (result.unaffected.length > 0) {
            lines.push(``);
            lines.push(`✅ Unaffected (${result.unaffected.length}): ${result.unaffected.map(t => t.taskId).join(', ')}`);
        }
        
        return lines.join('\n');
    }
}

