// ============================================================================
// ImplementationReviewWorkflow - Manual code review using 3 analysts
// Phases: gather → analyze → summarize → interact → finalize
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import { BaseWorkflow } from './BaseWorkflow';
import { WorkflowServices } from './IWorkflow';
import { 
    WorkflowConfig, 
    WorkflowResult,
    ImplementationReviewInput
} from '../../types/workflow';
import { AgentRole, getDefaultRole } from '../../types';
import { TaskManager } from '../TaskManager';
import { ServiceLocator } from '../ServiceLocator';

/**
 * Review verdict from each analyst
 */
type ReviewVerdict = 'pass' | 'fix_needed' | 'minor';

/**
 * Result from a single reviewer
 */
interface ReviewerResult {
    roleId: string;
    verdict: ReviewVerdict;
    criticalIssues: string[];
    minorSuggestions: string[];
    rawOutput: string;
}

/**
 * Implementation review workflow - reviews completed task implementations
 * 
 * This workflow is manually triggered by the user to review code that has been
 * implemented by tasks. It runs 3 reviewer analysts in parallel to evaluate:
 * - Architecture quality (reviewer_architecture)
 * - Implementation quality (reviewer_implementation)
 * - Test coverage and quality (reviewer_quality)
 * 
 * After analysis, results are shown to the user via agent chat. If fixes are
 * needed, the user confirms and the tasks are reset to pending status.
 * 
 * Phases:
 * 1. gather - Collect FILES_MODIFIED from target task(s)
 * 2. analyze - Run 3 reviewer analysts in parallel
 * 3. summarize - Consolidate findings into user-friendly summary
 * 4. interact - Emit event to show user the review, wait for response
 * 5. finalize - Based on response, complete or trigger task reset
 */
export class ImplementationReviewWorkflow extends BaseWorkflow {
    private static readonly PHASES = [
        'gather',
        'analyze', 
        'summarize',
        'interact',
        'finalize'
    ];
    
    // Reviewer role IDs
    private static readonly REVIEWER_ROLES = [
        'reviewer_architecture',
        'reviewer_implementation', 
        'reviewer_quality'
    ];
    
    // Input
    private taskIds: string[];
    private planPath: string;
    private isSessionReview: boolean;
    
    // State
    private filesModified: string[] = [];
    private taskDescriptions: Map<string, string> = new Map();
    private reviewerResults: Map<string, ReviewerResult> = new Map();
    private summaryText: string = '';
    private userResponse: 'confirm_fix' | 'dismiss' | 'pending' = 'pending';
    private userFeedback: string = '';
    
    // Overall verdict
    private overallVerdict: ReviewVerdict = 'pass';
    private needsFix: boolean = false;
    
    constructor(config: WorkflowConfig, services: WorkflowServices) {
        super(config, services);
        
        // Extract input
        const input = config.input as ImplementationReviewInput;
        this.taskIds = input.taskIds;
        this.planPath = input.planPath;
        this.isSessionReview = input.isSessionReview || false;
    }
    
    getPhases(): string[] {
        return ImplementationReviewWorkflow.PHASES;
    }
    
    async executePhase(phaseIndex: number): Promise<void> {
        const phase = this.getPhases()[phaseIndex];
        
        switch (phase) {
            case 'gather':
                await this.executeGatherPhase();
                break;
                
            case 'analyze':
                await this.executeAnalyzePhase();
                break;
                
            case 'summarize':
                await this.executeSummarizePhase();
                break;
                
            case 'interact':
                await this.executeInteractPhase();
                break;
                
            case 'finalize':
                await this.executeFinalizePhase();
                break;
        }
    }
    
    getState(): object {
        return {
            taskIds: this.taskIds,
            planPath: this.planPath,
            isSessionReview: this.isSessionReview,
            filesModified: this.filesModified,
            reviewerResultsCount: this.reviewerResults.size,
            overallVerdict: this.overallVerdict,
            needsFix: this.needsFix,
            userResponse: this.userResponse
        };
    }
    
    protected getProgressMessage(): string {
        const phase = this.getPhases()[this.phaseIndex] || 'unknown';
        switch (phase) {
            case 'gather':
                return `Gathering files modified by ${this.taskIds.length} task(s)...`;
            case 'analyze':
                return `Running ${ImplementationReviewWorkflow.REVIEWER_ROLES.length} reviewers in parallel...`;
            case 'summarize':
                return 'Consolidating review findings...';
            case 'interact':
                return 'Waiting for user review...';
            case 'finalize':
                return this.needsFix ? 'Resetting tasks for fixes...' : 'Review complete';
            default:
                return phase;
        }
    }
    
    getOutput(): any {
        return {
            taskIds: this.taskIds,
            filesReviewed: this.filesModified,
            overallVerdict: this.overallVerdict,
            needsFix: this.needsFix,
            userResponse: this.userResponse,
            reviewerResults: Object.fromEntries(this.reviewerResults),
            summary: this.summaryText
        };
    }
    
    // =========================================================================
    // PHASE IMPLEMENTATIONS
    // =========================================================================
    
    /**
     * Phase 1: Gather files modified by target tasks
     */
    private async executeGatherPhase(): Promise<void> {
        this.log('=== GATHER PHASE ===');
        
        const taskManager = ServiceLocator.resolve(TaskManager);
        const allFiles = new Set<string>();
        
        for (const taskId of this.taskIds) {
            // Get task info from TaskManager
            const tasks = taskManager.getTasksForSession(this.sessionId);
            const task = tasks.find(t => t.id === taskId || t.id.toUpperCase() === taskId.toUpperCase());
            
            if (!task) {
                this.log(`Warning: Task ${taskId} not found, skipping`);
                continue;
            }
            
            // Store task description for context
            this.taskDescriptions.set(taskId, task.description);
            
            // Collect files modified
            if (task.filesModified && task.filesModified.length > 0) {
                for (const file of task.filesModified) {
                    allFiles.add(file);
                }
                this.log(`Task ${taskId}: ${task.filesModified.length} files`);
            } else {
                this.log(`Task ${taskId}: No files recorded`);
            }
        }
        
        this.filesModified = Array.from(allFiles);
        this.log(`Total files to review: ${this.filesModified.length}`);
        
        if (this.filesModified.length === 0) {
            this.log('No files to review - tasks have no recorded file modifications');
            // Skip to finalize with pass verdict
            this.overallVerdict = 'pass';
            this.summaryText = 'No files to review - the selected tasks have no recorded file modifications.';
        }
    }
    
    /**
     * Phase 2: Run 3 reviewer analysts in parallel
     */
    private async executeAnalyzePhase(): Promise<void> {
        this.log('=== ANALYZE PHASE ===');
        
        if (this.filesModified.length === 0) {
            this.log('Skipping analysis - no files to review');
            return;
        }
        
        // Run all reviewers in parallel
        const reviewerPromises = ImplementationReviewWorkflow.REVIEWER_ROLES.map(
            roleId => this.runReviewer(roleId)
        );
        
        await Promise.all(reviewerPromises);
        
        this.log(`All ${ImplementationReviewWorkflow.REVIEWER_ROLES.length} reviewers completed`);
    }
    
    /**
     * Run a single reviewer agent
     */
    private async runReviewer(roleId: string): Promise<void> {
        const role = this.getRole(roleId);
        
        if (!role) {
            this.log(`❌ ${roleId} - role not found in registry!`);
            this.reviewerResults.set(roleId, {
                roleId,
                verdict: 'fix_needed',
                criticalIssues: [`Role ${roleId} not found in registry`],
                minorSuggestions: [],
                rawOutput: ''
            });
            return;
        }
        
        const prompt = this.buildReviewerPrompt(roleId, role);
        this.log(`🚀 Starting ${roleId} (tier: ${role?.defaultModel || 'high'})...`);
        
        // Request agent
        const agentName = await this.requestAgent(roleId);
        
        try {
            const result = await this.runAgentTaskWithCallback(
                roleId,
                prompt,
                roleId,
                {
                    expectedStage: 'review',
                    timeout: role?.timeoutMs || 300000,
                    model: role?.defaultModel,
                    cwd: this.stateManager.getWorkspaceRoot(),
                    agentName
                }
            );
            
            // Parse verdict from result
            const verdict = this.parseVerdict(result.result as string);
            const issues = result.payload?.issues || [];
            const suggestions = result.payload?.suggestions || [];
            
            this.reviewerResults.set(roleId, {
                roleId,
                verdict,
                criticalIssues: issues,
                minorSuggestions: suggestions,
                rawOutput: JSON.stringify(result.payload || {})
            });
            
            this.log(`✓ ${roleId} complete: ${verdict.toUpperCase()}`);
            
        } finally {
            this.releaseAgent(agentName);
            this.log(`  Released reviewer agent ${agentName}`);
        }
    }
    
    /**
     * Build the prompt for a reviewer agent
     */
    private buildReviewerPrompt(roleId: string, role: AgentRole): string {
        const taskContext = Array.from(this.taskDescriptions.entries())
            .map(([id, desc]) => `- ${id}: ${desc}`)
            .join('\n');
        
        const filesContext = this.filesModified
            .map(f => `- ${f}`)
            .join('\n');
        
        let prompt = `${role.promptTemplate}

## Task Context
You are reviewing implementations from the following task(s):
${taskContext}

## Files to Review
The following files were modified by these tasks:
${filesContext}

## Instructions
1. Read each of the files listed above using read_file
2. Analyze the code according to your review focus
3. Write your review summary in the required format
4. Call \`apc agent complete\` with your verdict when done

## Important
- Focus only on the files listed - they represent the actual implementation
- Be specific about issues - include file names and line numbers where possible
- Distinguish between critical issues (must fix) and minor suggestions (nice to have)
`;

        // Add Unity-specific addendum if Unity features enabled
        if (this.unityEnabled && role.unityPromptAddendum) {
            prompt += `\n${role.unityPromptAddendum}`;
        }
        
        return prompt;
    }
    
    /**
     * Parse verdict string to enum
     */
    private parseVerdict(result: string): ReviewVerdict {
        const lower = (result || '').toLowerCase();
        if (lower.includes('fix_needed') || lower === 'failed' || lower === 'critical') {
            return 'fix_needed';
        }
        if (lower.includes('minor')) {
            return 'minor';
        }
        return 'pass';
    }
    
    /**
     * Phase 3: Consolidate findings into user-friendly summary
     */
    private async executeSummarizePhase(): Promise<void> {
        this.log('=== SUMMARIZE PHASE ===');
        
        if (this.filesModified.length === 0) {
            return; // Already handled in gather
        }
        
        // Determine overall verdict (worst of all reviewers)
        let hasFixNeeded = false;
        let hasMinor = false;
        
        const allCriticalIssues: string[] = [];
        const allMinorSuggestions: string[] = [];
        
        for (const result of this.reviewerResults.values()) {
            if (result.verdict === 'fix_needed') {
                hasFixNeeded = true;
            } else if (result.verdict === 'minor') {
                hasMinor = true;
            }
            
            allCriticalIssues.push(...result.criticalIssues.map(i => `[${result.roleId}] ${i}`));
            allMinorSuggestions.push(...result.minorSuggestions.map(s => `[${result.roleId}] ${s}`));
        }
        
        this.overallVerdict = hasFixNeeded ? 'fix_needed' : (hasMinor ? 'minor' : 'pass');
        this.needsFix = hasFixNeeded;
        
        // Build summary text
        let summary = `# Implementation Review Summary\n\n`;
        summary += `## Overview\n`;
        summary += `- **Tasks Reviewed**: ${this.taskIds.join(', ')}\n`;
        summary += `- **Files Reviewed**: ${this.filesModified.length}\n`;
        summary += `- **Overall Verdict**: ${this.overallVerdict.toUpperCase()}\n\n`;
        
        if (allCriticalIssues.length > 0) {
            summary += `## Critical Issues (${allCriticalIssues.length})\n`;
            summary += `These issues should be fixed before proceeding:\n\n`;
            for (const issue of allCriticalIssues) {
                summary += `- ${issue}\n`;
            }
            summary += '\n';
        }
        
        if (allMinorSuggestions.length > 0) {
            summary += `## Minor Suggestions (${allMinorSuggestions.length})\n`;
            summary += `Nice-to-have improvements:\n\n`;
            for (const suggestion of allMinorSuggestions) {
                summary += `- ${suggestion}\n`;
            }
            summary += '\n';
        }
        
        if (allCriticalIssues.length === 0 && allMinorSuggestions.length === 0) {
            summary += `## Result\n`;
            summary += `All reviewers passed. The implementation looks good!\n`;
        }
        
        // Add per-reviewer details
        summary += `\n## Reviewer Details\n\n`;
        for (const result of this.reviewerResults.values()) {
            summary += `### ${result.roleId} - ${result.verdict.toUpperCase()}\n`;
            if (result.criticalIssues.length > 0) {
                summary += `**Critical Issues:**\n`;
                for (const issue of result.criticalIssues) {
                    summary += `- ${issue}\n`;
                }
            }
            if (result.minorSuggestions.length > 0) {
                summary += `**Minor Suggestions:**\n`;
                for (const suggestion of result.minorSuggestions) {
                    summary += `- ${suggestion}\n`;
                }
            }
            if (result.criticalIssues.length === 0 && result.minorSuggestions.length === 0) {
                summary += `No issues found.\n`;
            }
            summary += '\n';
        }
        
        this.summaryText = summary;
        this.log(`Summary generated (${this.summaryText.length} chars)`);
    }
    
    /**
     * Phase 4: Show review to user and wait for response
     */
    private async executeInteractPhase(): Promise<void> {
        this.log('=== INTERACT PHASE ===');
        
        // Emit event to show review popup
        this.emitWorkflowEvent('implementation_review.request', {
            workflowId: this.id,
            sessionId: this.sessionId,
            taskIds: this.taskIds,
            overallVerdict: this.overallVerdict,
            needsFix: this.needsFix,
            summary: this.summaryText,
            filesReviewed: this.filesModified.length
        });
        
        this.log('Waiting for user response...');
        
        // Wait for user response event
        const response = await this.waitForWorkflowEvent('implementation_review.response', 
            30 * 60 * 1000  // 30 minute timeout
        );
        
        if (response) {
            this.userResponse = response.action || 'dismiss';
            this.userFeedback = response.feedback || '';
            this.log(`User response: ${this.userResponse}`);
        } else {
            // Timeout - treat as dismiss
            this.userResponse = 'dismiss';
            this.log('User response timeout - treating as dismiss');
        }
    }
    
    /**
     * Phase 5: Finalize based on user response
     */
    private async executeFinalizePhase(): Promise<void> {
        this.log('=== FINALIZE PHASE ===');
        
        if (this.userResponse === 'confirm_fix' && this.needsFix) {
            // User confirmed fixes are needed - reset tasks to pending
            const taskManager = ServiceLocator.resolve(TaskManager);
            let resetCount = 0;
            
            for (const taskId of this.taskIds) {
                // Get review findings for this task
                const reviewFindings = this.getReviewFindingsForTask(taskId);
                
                // Reset task with review notes
                const success = taskManager.resetTaskForReview(taskId, reviewFindings);
                if (success) {
                    resetCount++;
                    this.log(`Task ${taskId} reset to pending with review findings`);
                } else {
                    this.log(`Warning: Could not reset task ${taskId}`);
                }
            }
            
            this.log(`Reset ${resetCount}/${this.taskIds.length} task(s) for fixes`);
        } else {
            this.log('Review completed without task reset');
        }
        
        // Write review log to _AiDevLog folder
        await this.persistReviewLog();
    }
    
    /**
     * Get review findings formatted for a specific task
     */
    private getReviewFindingsForTask(taskId: string): string {
        const lines: string[] = [];
        lines.push(`Review Date: ${new Date().toISOString()}`);
        lines.push(`Overall Verdict: ${this.overallVerdict}`);
        lines.push('');
        
        for (const result of this.reviewerResults.values()) {
            if (result.criticalIssues.length > 0) {
                lines.push(`${result.roleId}:`);
                for (const issue of result.criticalIssues) {
                    lines.push(`  - ${issue}`);
                }
            }
        }
        
        return lines.join('\n');
    }
    
    /**
     * Persist review log to _AiDevLog
     */
    private async persistReviewLog(): Promise<void> {
        try {
            const workspaceRoot = this.stateManager.getWorkspaceRoot();
            const logsDir = path.join(workspaceRoot, '_AiDevLog', 'Reviews');
            
            if (!fs.existsSync(logsDir)) {
                fs.mkdirSync(logsDir, { recursive: true });
            }
            
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `review_${this.sessionId}_${timestamp}.md`;
            const filepath = path.join(logsDir, filename);
            
            let content = this.summaryText;
            content += `\n\n---\n## User Response\n`;
            content += `- Action: ${this.userResponse}\n`;
            if (this.userFeedback) {
                content += `- Feedback: ${this.userFeedback}\n`;
            }
            
            fs.writeFileSync(filepath, content, 'utf-8');
            this.log(`Review log saved to ${filepath}`);
            
        } catch (error) {
            this.log(`Warning: Failed to persist review log: ${error}`);
        }
    }
}

