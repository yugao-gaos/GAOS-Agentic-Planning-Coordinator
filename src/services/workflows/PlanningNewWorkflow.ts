// ============================================================================
// PlanningNewWorkflow - Full planning loop: (Planner → Analysts)* → Finalize
// Note: Context phase removed - coordinator provides context via task metadata
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import { BaseWorkflow } from './BaseWorkflow';
import { WorkflowServices } from './IWorkflow';
import { 
    WorkflowConfig, 
    WorkflowResult, 
    PlanningWorkflowInput 
} from '../../types/workflow';
import { AgentRole, getDefaultRole, AnalystVerdict } from '../../types';
import { ServiceLocator } from '../ServiceLocator';
import { TaskManager } from '../TaskManager';

/**
 * Planning workflow for creating new plans
 * 
 * Phases:
 * 1. planner - Initial plan creation
 * 2. analysts - Parallel analyst reviews
 * 3. (iteration) - Repeat planner → analysts if critical issues
 * 4. finalize - Finalize the plan
 * 
 * Note: Context phase removed - coordinator provides context via task metadata.
 * 
 * Max iterations: 3
 */
export class PlanningNewWorkflow extends BaseWorkflow {
    private static readonly PHASES = [
        'planner',
        'analysts',
        'finalize'
    ];
    
    private static readonly MAX_ITERATIONS = 3;
    
    // Planning state
    private planPath: string = '';
    private contextPath: string = '';
    private requirement: string = '';
    private docs: string[] = [];
    private iteration: number = 0;
    private analystOutputs: Record<string, string> = {};
    private analystResults: Record<string, AnalystVerdict> = {};
    private criticalIssues: string[] = [];
    private minorSuggestions: string[] = [];
    private forcedFinalize: boolean = false;
    
    // Reserved planner agent - kept for the entire workflow (not released between phases)
    private plannerAgentName: string | undefined;
    
    constructor(config: WorkflowConfig, services: WorkflowServices) {
        super(config, services);
        
        // Extract input
        const input = config.input as PlanningWorkflowInput;
        this.requirement = input.requirement;
        this.docs = input.docs || [];
    }
    
    getPhases(): string[] {
        return PlanningNewWorkflow.PHASES;
    }
    
    async executePhase(phaseIndex: number): Promise<void> {
        const phase = this.getPhases()[phaseIndex];
        
        switch (phase) {
            case 'planner':
                await this.executePlannerPhase();
                break;
                
            case 'analysts':
                await this.executeAnalystsPhase();
                break;
                
            case 'finalize':
                await this.executeFinalizePhase();
                break;
        }
    }
    
    getState(): object {
        return {
            planPath: this.planPath,
            contextPath: this.contextPath,
            requirement: this.requirement,
            docs: this.docs,
            iteration: this.iteration,
            analystResults: this.analystResults,
            criticalIssues: this.criticalIssues,
            forcedFinalize: this.forcedFinalize
        };
    }
    
    protected getProgressMessage(): string {
        const phase = this.getPhases()[this.phaseIndex] || 'unknown';
        switch (phase) {
            case 'context':
                return 'Gathering project context...';
            case 'planner':
                return this.iteration === 0 
                    ? 'Creating initial plan...'
                    : `Updating plan (iteration ${this.iteration})...`;
            case 'analysts':
                return `Analyst reviews (iteration ${this.iteration})...`;
            case 'finalize':
                return this.forcedFinalize 
                    ? 'Finalizing plan (with warnings)...'
                    : 'Finalizing plan...';
            default:
                return 'Processing...';
        }
    }
    
    protected getOutput(): any {
        return {
            planPath: this.planPath,
            contextPath: this.contextPath,
            iterations: this.iteration,
            forcedFinalize: this.forcedFinalize,
            warnings: this.forcedFinalize ? this.criticalIssues : undefined
        };
    }
    
    // =========================================================================
    // PHASE IMPLEMENTATIONS
    // =========================================================================
    
    // Note: Context phase removed - coordinator provides context via task metadata
    // Context is now gathered separately via ContextGatheringWorkflow if needed
    
    private async executePlannerPhase(): Promise<void> {
        // Initialize paths on first iteration
        if (this.iteration === 0) {
            this.stateManager.ensurePlanDirectories(this.sessionId);
            this.planPath = this.stateManager.getPlanFilePath(this.sessionId);
            this.contextPath = path.join(
                this.stateManager.getPlanFolder(this.sessionId), 
                'context.md'
            );
            
            // Create initial plan file with header so users can see progressive output
            const initialContent = `# Execution Plan

**Status:** 🔄 Planning in progress...

**Requirement:** ${this.requirement.substring(0, 200)}${this.requirement.length > 200 ? '...' : ''}

---

*Plan content will appear below as the planner works...*

`;
            fs.writeFileSync(this.planPath, initialContent);
            
            // Update session's currentPlanPath immediately so GUI can show the file
            const session = this.stateManager.getPlanningSession(this.sessionId);
            if (session) {
                session.currentPlanPath = this.planPath;
                session.updatedAt = new Date().toISOString();
                this.stateManager.savePlanningSession(session);
            }
            
            this.log(`📄 Plan file created: ${this.planPath}`);
        }
        
        this.iteration++;
        
        this.log('');
        this.log(`📝 PHASE: PLANNER (iteration ${this.iteration}/${PlanningNewWorkflow.MAX_ITERATIONS})`);
        
        const role = this.getRole('planner');
        const mode = this.iteration === 1 ? 'create' : 'update';
        const prompt = this.buildPlannerPrompt(mode, role);
        
        this.log(`Running planner - ${mode.toUpperCase()} mode (${role?.defaultModel || 'opus-4.5'})...`);
        
        // Reuse planner agent across iterations, or request new one
        if (!this.plannerAgentName) {
            this.plannerAgentName = await this.requestAgent('planner');
        }
        
        // Stream plan content directly to plan file (commentary goes to log)
        // Use CLI callback for structured completion
        const result = await this.runAgentTaskWithCallback(
            `planner_${mode}`,
            prompt,
            'planner',
            {
                expectedStage: 'planning',
                timeout: role?.timeoutMs || 900000,
                model: role?.defaultModel,
                cwd: this.stateManager.getWorkspaceRoot(),
                agentName: this.plannerAgentName,
                planFile: this.planPath
            }
        );
        
        if (result.fromCallback && this.isAgentSuccess(result)) {
            // Plan was streamed to file; verify it exists
            if (!fs.existsSync(this.planPath)) {
                throw new Error(
                    `Plan streaming failed: expected plan file at '${this.planPath}' not created. ` +
                    `This indicates the agent did not properly stream the plan to the file. ` +
                    `Check agent logs for streaming errors.`
                );
            }
            this.log(`✓ Plan ${mode === 'create' ? 'created' : 'updated'} via CLI callback`);
        } else if (!result.fromCallback) {
            throw new Error(
                `Planner did not use CLI callback (\`apc agent complete\`). ` +
                'All agents must report results via CLI callback.'
            );
        } else {
            const error = result.payload?.error || result.payload?.message || 'Unknown error';
            throw new Error(`Planner ${mode} task failed: ${error}`);
        }
        
        // Demote planner to bench (may be needed for next iteration)
        this.demoteAgentToBench(this.plannerAgentName);
    }
    
    private async executeAnalystsPhase(): Promise<void> {
        this.log('');
        this.log('🔍 PHASE: ANALYST REVIEWS (parallel)');
        this.log(`Starting ${3} analysts: analyst_implementation, analyst_quality, analyst_architecture`);
        
        this.analystOutputs = {};
        
        const analystRoles = ['analyst_implementation', 'analyst_quality', 'analyst_architecture'];
        
        // Run all analysts in parallel
        const startTime = Date.now();
        await Promise.all(
            analystRoles.map(roleId => this.runAnalystTask(roleId))
        );
        this.log(`All analysts completed in ${Date.now() - startTime}ms`);
        
        // Log summary
        this.log('Review Summary:');
        for (const [roleId, verdict] of Object.entries(this.analystResults)) {
            const icon = verdict === 'pass' ? '✅' : verdict === 'critical' ? '❌' : '⚠️';
            this.log(`  ${icon} ${roleId}: ${verdict.toUpperCase()}`);
        }
        
        // Check if we need to loop back to planner
        if (this.hasCriticalIssues() && this.iteration < PlanningNewWorkflow.MAX_ITERATIONS) {
            this.log('');
            this.log(`⚠️ Critical issues found - looping back to planner (iteration ${this.iteration + 1})`);
            // Move phase index back so it becomes 0 (planner) after runPhases increments
            this.phaseIndex = -1; // Will be incremented to 0 (planner) by runPhases
        } else if (this.hasCriticalIssues()) {
            this.log('');
            this.log('⚠️ Max iterations reached with unresolved critical issues');
            this.forcedFinalize = true;
        } else {
            this.log('');
            this.log('✅ No critical issues - proceeding to finalization');
        }
    }
    
    private async executeFinalizePhase(): Promise<void> {
        this.log('');
        this.log(`📋 PHASE: FINALIZATION${this.forcedFinalize ? ' (FORCED)' : ''}`);
        
        const role = this.getRole('text_clerk');
        const prompt = this.buildFinalizationPrompt(this.forcedFinalize, role);
        
        this.log(`Running text_clerk finalization (${role?.defaultModel || 'auto'})...`);
        
        // Use runAgentTaskWithCallback for proper completion signaling
        const result = await this.runAgentTaskWithCallback(
            'plan_finalize',
            prompt,
            'text_clerk',
            {
                expectedStage: 'finalization',
                timeout: role?.timeoutMs || 120000,  // 2 minutes
                model: role?.defaultModel,
                cwd: this.stateManager.getWorkspaceRoot()
            }
        );
        
        if (!result.fromCallback) {
            // Agent failed to use CLI callback - this is an error
            throw new Error(
                `Text clerk did not use CLI callback (\`apc agent complete\`). ` +
                `Result: ${result.result}, Error: ${result.payload?.error || 'unknown'}`
            );
        }
        
        this.log(`✓ Finalization completed via CLI callback: ${result.result}`);
        
        // Verify plan file exists
        if (!fs.existsSync(this.planPath)) {
            throw new Error(
                `Plan finalization failed: expected plan file at '${this.planPath}' not found. ` +
                `Check agent logs for errors.`
            );
        }
        
        // Update plan status
        this.updatePlanStatus(this.forcedFinalize);
        
        // Update session state
        const session = this.stateManager.getPlanningSession(this.sessionId);
        if (session) {
            session.status = 'reviewing';
            session.currentPlanPath = this.planPath;
            session.updatedAt = new Date().toISOString();
            this.stateManager.savePlanningSession(session);
        }
    }
    
    // =========================================================================
    // PROMPT BUILDERS
    // =========================================================================
    
    private buildPlannerPrompt(mode: string, role: AgentRole | undefined): string {
        if (!role?.promptTemplate) {
            throw new Error('Missing prompt template for planner role');
        }
        const basePrompt = role.promptTemplate;
        
        // Load the plan template path
        const templatePath = path.join(this.stateManager.getWorkspaceRoot(), 'resources/templates/skeleton_plan.md');
        const hasTemplate = fs.existsSync(templatePath);
        
        // Get existing plans context for cross-plan awareness
        const existingPlansContext = this.getExistingPlansContext();

        let modeInstructions = '';
        
        if (mode === 'create') {
            modeInstructions = `## Mode: CREATE
You are creating the initial plan.

### Requirement
${this.requirement}

### Files to Read
- Context (if exists): ${this.contextPath}
${hasTemplate ? `- Plan Template: ${templatePath}` : ''}

${existingPlansContext}

### Instructions
1. Read the context file if it exists
${hasTemplate ? '2. Read and follow the plan template structure' : '2. Create a detailed task breakdown'}
3. **CROSS-PLAN AWARENESS**: Check the existing plans above. If your tasks will modify files that existing tasks are also modifying, add cross-plan dependencies using the format: \`Deps: ps_XXXXXX_TN\`
4. Write the plan to: ${this.planPath}`;
        } else {
            modeInstructions = `## Mode: UPDATE
You are updating the plan based on analyst feedback.

### Files
- Current Plan: ${this.planPath}

### Analyst Feedback
${this.formatAnalystFeedback()}

### Instructions
1. Read the current plan
2. Address ALL Critical Issues raised by analysts
3. Consider Minor Suggestions  
4. Write the updated plan back to the same file`;
        }
        
        return `${basePrompt}

${modeInstructions}

## Plan Format
**Session ID:** ${this.sessionId}

Use checkbox format with GLOBAL task IDs:
- [ ] **${this.sessionId}_T1**: Description | Deps: None | Engineer: TBD
- [ ] **${this.sessionId}_T2**: Description | Deps: ${this.sessionId}_T1 | Engineer: TBD

Task ID format: ${this.sessionId}_T{N} (e.g., ${this.sessionId}_T1, ${this.sessionId}_T2, ${this.sessionId}_T3)

Include sections: Overview, Task Breakdown, Dependencies, Risk Assessment`;
    }
    
    private buildFinalizationPrompt(forced: boolean, role: AgentRole | undefined): string {
        const basePrompt = role?.promptTemplate || 'You are a Text Clerk agent for document formatting.';
        
        const warnings = forced 
            ? `\n\n## WARNINGS (Max iterations reached)
The following critical issues were not fully resolved:
${this.criticalIssues.map(i => `- ${i}`).join('\n') || '- None recorded'}` 
            : '';
        
        return `${basePrompt}

## Plan File
Read and modify: ${this.planPath}

## Analyst Feedback Summary
${this.formatAnalystFeedback()}
${warnings}

## Instructions
1. Read the plan file using read_file
2. Ensure all tasks use checkbox format with GLOBAL IDs: - [ ] **${this.sessionId}_T{N}**: Description | Deps: ${this.sessionId}_TX | Engineer: TBD
3. Address any MINOR suggestions (ignore CRITICAL - those need human review)
4. Update status to "📋 READY FOR REVIEW"
${forced ? '5. Add a WARNINGS section noting unresolved critical issues' : ''}
5. Write the finalized plan back using write tool

## Important
- Do NOT change the plan content or strategy
- Only fix formatting and apply minor suggestions
- Be fast and efficient

Note: CLI completion instructions with real session/workflow IDs are injected at runtime.`;
    }
    
    private buildAnalystPrompt(roleId: string, role: AgentRole | undefined): string {
        if (!role?.promptTemplate) {
            throw new Error(`Missing prompt template for ${roleId} role`);
        }
        const basePrompt = role.promptTemplate;
        
        return `${basePrompt}

## Files to Review
- Plan: ${this.planPath}
- Context: ${this.contextPath}

Read these files using read_file tool, then provide your review.

## How to Complete This Review
After analyzing, signal your verdict via CLI callback (see end of prompt):
- \`--result pass\` - Plan is solid, no significant issues
- \`--result critical\` - Blocking issues that must be fixed before proceeding
- \`--result minor\` - Has suggestions, but plan can proceed

Include your analysis, issues, and suggestions in the callback payload.`;
    }
    
    /**
     * Format analyst output from callback payload for human-readable display
     */
    private formatAnalystOutput(roleId: string, verdict: string, issues: string[], suggestions: string[]): string {
        let output = `### Review Result: ${verdict.toUpperCase()}\n\n`;
        
        if (issues.length > 0) {
            output += '#### Issues\n';
            output += issues.map(i => `- ${i}`).join('\n') + '\n\n';
        }
        
        if (suggestions.length > 0) {
            output += '#### Suggestions\n';
            output += suggestions.map(s => `- ${s}`).join('\n') + '\n';
        }
        
        return output;
    }
    
    /**
     * Get context about existing plans and their tasks for cross-plan awareness
     * This helps the planner understand what other work is in progress and avoid conflicts
     */
    private getExistingPlansContext(): string {
        try {
            // Get all approved sessions
            const sessions = this.stateManager.getAllPlanningSessions()
                .filter(s => s.status === 'approved' && s.id !== this.sessionId);
            
            if (sessions.length === 0) {
                return '### Existing Plans\nNo other approved plans currently active.';
            }
            
            // Get TaskManager for task details
            const taskManager = ServiceLocator.resolve(TaskManager);
            
            let context = '### Existing Plans (CROSS-PLAN AWARENESS)\n\n';
            context += '**IMPORTANT**: If your tasks will modify files that existing tasks are also modifying,\n';
            context += 'you SHOULD add cross-plan dependencies using format: `Deps: ps_XXXXXX_TN`\n\n';
            
            for (const session of sessions) {
                context += `#### ${session.id}: ${session.requirement.substring(0, 100)}...\n`;
                
                // Get tasks for this session
                const tasks = taskManager.getTasksForSession(session.id);
                
                if (tasks.length === 0) {
                    context += '- No tasks created yet\n';
                } else {
                    // Show task summary with target files
                    const incompleteTasks = tasks.filter(t => 
                        t.status !== 'completed' && t.status !== 'failed'
                    );
                    
                    for (const task of incompleteTasks.slice(0, 10)) {  // Limit to first 10
                        const files = task.targetFiles?.length 
                            ? `Files: ${task.targetFiles.join(', ')}`
                            : '';
                        context += `- **${task.id}** [${task.status}]: ${task.description.substring(0, 60)}... ${files}\n`;
                    }
                    
                    if (incompleteTasks.length > 10) {
                        context += `  ... and ${incompleteTasks.length - 10} more tasks\n`;
                    }
                }
                context += '\n';
            }
            
            return context;
        } catch (e) {
            // Don't fail planning if we can't get existing plans
            this.log(`Warning: Could not get existing plans context: ${e}`);
            return '### Existing Plans\nCould not retrieve existing plans context.';
        }
    }
    
    // =========================================================================
    // HELPER METHODS
    // =========================================================================
    
    private async runAnalystTask(roleId: string): Promise<void> {
        const role = this.getRole(roleId);
        
        if (!role) {
            this.log(`❌ ${roleId} - role not found in registry!`);
            this.analystResults[roleId] = 'critical';
            this.analystOutputs[roleId] = `### Review Result: CRITICAL\n\n#### Critical Issues\n- Role ${roleId} not found in registry\n`;
            this.criticalIssues.push(`[${roleId}] Role configuration missing from registry`);
            return;
        }
        
        const prompt = this.buildAnalystPrompt(roleId, role);
        
        this.log(`🚀 Starting ${roleId} (model: ${role?.defaultModel || 'sonnet-4.5'})...`);
        
        // Request agent BEFORE running task so we can release it after
        const agentName = await this.requestAgent(roleId);
        
        try {
            // Use CLI callback for structured completion
            // Note: roleId is already unique (e.g., 'analyst_implementation'), no need to add prefix
            const result = await this.runAgentTaskWithCallback(
                roleId,
                prompt,
                roleId,
                {
                    expectedStage: 'analysis',
                    timeout: role?.timeoutMs || 300000,
                    model: role?.defaultModel,
                    cwd: this.stateManager.getWorkspaceRoot(),
                    agentName  // Pass pre-allocated agent
                }
            );
            
            if (result.fromCallback) {
                // Got structured data from CLI callback - required path
                const verdict = (result.result as AnalystVerdict) || 'pass';
                this.analystResults[roleId] = verdict;
                
                // Extract issues/suggestions from callback payload
                const issues = result.payload?.issues || [];
                const suggestions = result.payload?.suggestions || [];
                
                if (verdict === 'critical' && issues.length > 0) {
                    this.criticalIssues.push(...issues.map(i => `[${roleId}] ${i}`));
                }
                if (suggestions.length > 0) {
                    this.minorSuggestions.push(...suggestions.map(s => `[${roleId}] ${s}`));
                }
                
                // Build formatted output from callback payload
                const formattedOutput = this.formatAnalystOutput(roleId, verdict, issues, suggestions);
                this.analystOutputs[roleId] = formattedOutput;
                
                this.log(`✓ ${roleId} complete via CLI callback: ${verdict.toUpperCase()}`);
            } else {
                // No callback received - agent must use CLI callback
                throw new Error(
                    `Analyst ${roleId} did not use CLI callback (\`apc agent complete\`). ` +
                    'All agents must report results via CLI callback for structured data. ' +
                    'Legacy output parsing is no longer supported.'
                );
            }
        } finally {
            // Release analyst agent immediately - analysts are one-shot tasks
            this.releaseAgent(agentName);
            this.log(`  Released analyst agent ${agentName}`);
        }
    }
    
    private hasCriticalIssues(): boolean {
        return Object.values(this.analystResults).includes('critical');
    }
    
    private formatAnalystFeedback(): string {
        const lines: string[] = [];
        
        for (const [roleId, output] of Object.entries(this.analystOutputs)) {
            const verdict = this.analystResults[roleId] || 'unknown';
            lines.push(`### ${roleId} (${verdict.toUpperCase()})`);
            lines.push(output.substring(0, 2000));
            lines.push('');
        }
        
        return lines.join('\n');
    }
    
    private updatePlanStatus(forced: boolean): void {
        if (!fs.existsSync(this.planPath)) return;
        
        let content = fs.readFileSync(this.planPath, 'utf-8');
        
        content = content.replace(
            /\*\*Status:\*\*\s*.+/i,
            `**Status:** ${forced ? '⚠️ READY FOR REVIEW (with warnings)' : '📋 READY FOR REVIEW'}`
        );
        
        fs.writeFileSync(this.planPath, content);
    }
}

