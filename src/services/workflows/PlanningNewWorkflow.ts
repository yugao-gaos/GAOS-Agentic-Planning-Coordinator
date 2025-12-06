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
import { AgentRunner, AgentRunOptions } from '../AgentBackend';
import { AgentRole, getDefaultRole, AnalystVerdict } from '../../types';
import { ServiceLocator } from '../ServiceLocator';

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
    private analystUsedCallback: Set<string> = new Set(); // Track which analysts used CLI callback
    private criticalIssues: string[] = [];
    private minorSuggestions: string[] = [];
    private forcedFinalize: boolean = false;
    
    // Reserved planner agent - kept for the entire workflow (not released between phases)
    private plannerAgentName: string | undefined;
    
    private agentRunner: AgentRunner;
    
    constructor(config: WorkflowConfig, services: WorkflowServices) {
        super(config, services);
        this.agentRunner = ServiceLocator.resolve(AgentRunner);
        
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
        }
        
        this.iteration++;
        
        this.log('');
        this.log(`📝 PHASE: PLANNER (iteration ${this.iteration}/${PlanningNewWorkflow.MAX_ITERATIONS})`);
        
        const role = this.getRole('planner');
        const mode = this.iteration === 1 ? 'create' : 'update';
        const prompt = this.buildPlannerPrompt(mode, role);
        
        this.log(`Running planner - ${mode.toUpperCase()} mode (${role?.defaultModel || 'opus-4.5'})...`);
        
        // Stream plan content directly to plan file (commentary goes to log)
        const result = await this.runAgentTask('planner', prompt, role, true);
        
        if (result.success) {
            // Plan was streamed to file; verify it exists
            if (!fs.existsSync(this.planPath)) {
                throw new Error(
                    `Plan streaming failed: expected plan file at '${this.planPath}' not created. ` +
                    `This indicates the agent did not properly stream the plan to the file. ` +
                    `Check agent logs for streaming errors.`
                );
            }
            this.log(`✓ Plan ${mode === 'create' ? 'created' : 'updated'}`);
        } else {
            throw new Error(`Planner ${mode} task failed`);
        }
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
        
        // Parse results
        this.parseAnalystResults();
        
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
        
        const role = this.getRole('planner');
        const prompt = this.buildFinalizationPrompt(this.forcedFinalize, role);
        
        this.log('Running planner finalization...');
        
        // Stream finalized plan directly to plan file
        const result = await this.runAgentTask('planner_finalize', prompt, role, true);
        
        if (result.success) {
            // Plan was streamed to file; verify it exists
            if (!fs.existsSync(this.planPath)) {
                throw new Error(
                    `Plan finalization streaming failed: expected plan file at '${this.planPath}' not created. ` +
                    `This indicates the agent did not properly stream the plan to the file. ` +
                    `Check agent logs for streaming errors.`
                );
            }
            this.log('✓ Plan finalized');
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
    
    /**
     * @deprecated Context phase removed - coordinator provides context via task metadata.
     * Use ContextGatheringWorkflow for explicit context gathering.
     */
    private buildContextPrompt(role: AgentRole | undefined): string {
        if (!role?.promptTemplate) {
            throw new Error('Missing prompt template for context_gatherer role');
        }
        const basePrompt = role.promptTemplate;
        
        return `${basePrompt}

## Task
Gather context for the following planning requirement:

### Requirement
${this.requirement}

${this.docs.length > 0 ? `### Provided Documents
${this.docs.join('\n')}` : ''}

## Output
Provide a structured context summary including:
1. Relevant existing code and patterns
2. Unity project structure (if applicable)
3. Dependencies and integration points
4. Potential risks or constraints

Write your findings in markdown format.`;
    }
    
    private buildPlannerPrompt(mode: string, role: AgentRole | undefined): string {
        if (!role?.promptTemplate) {
            throw new Error('Missing prompt template for planner role');
        }
        const basePrompt = role.promptTemplate;
        
        // Load the plan template path
        const templatePath = path.join(this.stateManager.getWorkspaceRoot(), 'resources/templates/skeleton_plan.md');
        const hasTemplate = fs.existsSync(templatePath);

        let modeInstructions = '';
        
        if (mode === 'create') {
            modeInstructions = `## Mode: CREATE
You are creating the initial plan.

### Requirement
${this.requirement}

### Files to Read
- Context (if exists): ${this.contextPath}
${hasTemplate ? `- Plan Template: ${templatePath}` : ''}

### Instructions
1. Read the context file if it exists
${hasTemplate ? '2. Read and follow the plan template structure' : '2. Create a detailed task breakdown'}
3. Write the plan to: ${this.planPath}`;
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
Use checkbox format: - [ ] **T{N}**: Description | Deps: X | Engineer: TBD

Include sections: Overview, Task Breakdown, Dependencies, Risk Assessment`;
    }
    
    private buildFinalizationPrompt(forced: boolean, role: AgentRole | undefined): string {
        const warnings = forced 
            ? `\n\n## WARNINGS (Max iterations reached)
The following critical issues were not fully resolved:
${this.criticalIssues.map(i => `- ${i}`).join('\n') || '- None recorded'}` 
            : '';
        
        return `You are finalizing the execution plan.

## Plan File
Read and modify: ${this.planPath}

## Analyst Feedback Summary
${this.formatAnalystFeedback()}
${warnings}

## Instructions
1. Read the plan file
2. Ensure all tasks use checkbox format: - [ ] **T{N}**: Description | Deps: X | Engineer: TBD
3. Incorporate any minor suggestions
4. Update status to "READY FOR REVIEW"
${forced ? '5. Add a WARNINGS section noting unresolved critical issues' : ''}
5. Write the finalized plan back to the same file`;
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

## REQUIRED Output Format
You MUST output your review in this EXACT format:

\`\`\`
### Review Result: [PASS|CRITICAL|MINOR]

#### Critical Issues
- [List blocking issues that MUST be fixed, or "None"]

#### Minor Suggestions
- [List optional improvements, or "None"]

#### Analysis
[Your detailed analysis]
\`\`\`

## Verdict Guidelines
- **PASS**: Plan is solid, no significant issues
- **CRITICAL**: Blocking issues that must be fixed before proceeding
- **MINOR**: Suggestions only, plan can proceed without changes`;
    }
    
    // =========================================================================
    // HELPER METHODS
    // =========================================================================
    
    private async runAgentTask(
        taskId: string,
        prompt: string,
        role: AgentRole | undefined,
        streamToPlanFile: boolean = false
    ): Promise<{ success: boolean; output: string }> {
        const roleId = role?.id || 'planner';
        const isPlannerRole = roleId === 'planner';
        
        // For planner role, reuse the same agent across iterations (don't release between phases)
        let agentName: string;
        if (isPlannerRole && this.plannerAgentName) {
            // Reuse existing planner agent (already in allocatedAgents)
            agentName = this.plannerAgentName;
            this.log(`Reusing reserved planner agent: ${agentName}`);
        } else {
            // Request a new agent from the pool
            agentName = await this.requestAgent(roleId);
            
            // Remember the planner agent for reuse across iterations
            if (isPlannerRole) {
                this.plannerAgentName = agentName;
            }
        }
        
        const workspaceRoot = this.stateManager.getWorkspaceRoot();
        const logDir = path.join(this.stateManager.getPlanFolder(this.sessionId), 'logs', 'agents');
        
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        
        // Use workflow ID + agent name for unique temp log file
        const logFile = path.join(logDir, `${this.id}_${agentName}.log`);
        
        try {
            // Prepend continuation context if we were paused mid-task
            const continuationPrompt = this.getContinuationPrompt();
            const fullPrompt = continuationPrompt 
                ? `${continuationPrompt}\n\n---\n\n${prompt}`
                : prompt;
            
            // Clear continuation context after using it
            if (continuationPrompt) {
                this.clearContinuationContext();
            }
            
            const options: AgentRunOptions = {
                id: `planning_${this.sessionId}_${taskId}`,
                prompt: fullPrompt,
                cwd: workspaceRoot,
                model: role?.defaultModel || 'sonnet-4.5',
                logFile,
                planFile: streamToPlanFile ? this.planPath : undefined,
                timeoutMs: role?.timeoutMs || 600000,
                onProgress: (msg) => this.log(`  ${msg}`)
            };
            
            // Track agent run ID for pause handling
            this.currentAgentRunId = options.id;
            
            const agentRunId = options.id;
            const result = await this.agentRunner.run(options);
            
            this.currentAgentRunId = undefined;
            
            return {
                success: result.success,
                output: result.output
            };
        } finally {
            // Release analyst agents immediately - they're done
            // Demote planner agent to bench - it may be needed again in the next iteration
            if (!isPlannerRole) {
                this.releaseAgent(agentName);
            } else {
                this.demoteAgentToBench(agentName);
                this.log(`Planner agent ${agentName} moved to bench (idle, waiting for potential next iteration)`);
            }
            
            // Don't delete log file - terminal may still be tailing it
            // Log files are cleaned up when session ends
        }
    }
    
    private async runAnalystTask(roleId: string): Promise<void> {
        const role = this.getRole(roleId);
        
        if (!role) {
            this.log(`❌ ${roleId} - role not found in registry!`);
            this.analystResults[roleId] = 'critical';
            this.analystOutputs[roleId] = `### Review Result: CRITICAL\n\n#### Critical Issues\n- Role ${roleId} not found in registry\n`;
            this.criticalIssues.push(`[${roleId}] Role configuration missing from registry`);
            this.analystUsedCallback.add(roleId);
            return;
        }
        
        const prompt = this.buildAnalystPrompt(roleId, role);
        
        this.log(`🚀 Starting ${roleId} (model: ${role?.defaultModel || 'sonnet-4.5'})...`);
        
        // Use CLI callback for structured completion
        const result = await this.runAgentTaskWithCallback(
            `analyst_${roleId}`,
            prompt,
            roleId,
            {
                expectedStage: 'analysis',
                timeout: role?.timeoutMs || 300000,
                model: role?.defaultModel,
                cwd: this.stateManager.getWorkspaceRoot()
            }
        );
        
        if (result.fromCallback) {
            // Got structured data from CLI callback - preferred path
            // Directly populate results (no need to parse)
            const verdict = (result.result as AnalystVerdict) || 'pass';
            this.analystResults[roleId] = verdict;
            this.analystUsedCallback.add(roleId);
            
            // Extract issues/suggestions from callback payload
            const issues = result.payload?.issues || [];
            const suggestions = result.payload?.suggestions || [];
            
            if (verdict === 'critical' && issues.length > 0) {
                this.criticalIssues.push(...issues.map(i => `[${roleId}] ${i}`));
            }
            if (suggestions.length > 0) {
                this.minorSuggestions.push(...suggestions.map(s => `[${roleId}] ${s}`));
            }
            
            // Store raw output for feedback formatting (if available)
            this.analystOutputs[roleId] = result.rawOutput || `### Review Result: ${verdict.toUpperCase()}\n`;
            
            this.log(`✓ ${roleId} complete via CLI callback: ${verdict.toUpperCase()}`);
        } else {
            // No callback received - agent must use CLI callback
            throw new Error(
                `Analyst ${roleId} did not use CLI callback (\`apc agent complete\`). ` +
                'All agents must report results via CLI callback for structured data. ' +
                'Legacy output parsing is no longer supported.'
            );
        }
    }
    
    private parseAnalystResults(): void {
        // Only parse results for analysts that didn't use CLI callback
        for (const [roleId, output] of Object.entries(this.analystOutputs)) {
            // Skip if already processed via CLI callback
            if (this.analystUsedCallback.has(roleId)) {
                continue;
            }
            
            const verdictMatch = output.match(/###?\s*Review\s*Result:\s*(PASS|CRITICAL|MINOR)/i);
            const verdict: AnalystVerdict = verdictMatch 
                ? verdictMatch[1].toLowerCase() as AnalystVerdict 
                : 'pass';
            
            this.analystResults[roleId] = verdict;
            
            // Extract critical issues
            const criticalSection = output.match(/####?\s*Critical\s*Issues[\s\S]*?(?=####|$)/i);
            if (criticalSection && verdict === 'critical') {
                const issues = criticalSection[0].match(/^-\s+(?!None).+$/gm);
                if (issues) {
                    this.criticalIssues.push(
                        ...issues.map(i => `[${roleId}] ${i.replace(/^-\s+/, '')}`)
                    );
                }
            }
            
            // Extract minor suggestions
            const minorSection = output.match(/####?\s*Minor\s*Suggestions[\s\S]*?(?=####|$)/i);
            if (minorSection) {
                const suggestions = minorSection[0].match(/^-\s+(?!None).+$/gm);
                if (suggestions) {
                    this.minorSuggestions.push(
                        ...suggestions.map(s => `[${roleId}] ${s.replace(/^-\s+/, '')}`)
                    );
                }
            }
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
    
    /**
     * Extract the actual plan content from agent output.
     * Agents often include reasoning/commentary before the plan - this extracts just the plan.
     */
    private extractPlanFromOutput(output: string): string {
        // Look for the start of actual plan content using common patterns
        const planStartPatterns = [
            // Plan title headers
            /^(#\s+[^\n]*(?:Plan|Migration|Implementation|Execution)[^\n]*)/mi,
            // Metadata line at start of plan
            /^(\*\*Project:\*\*)/mi,
            // Horizontal rule followed by header (common wrapper)
            /^(---\s*\n+#)/m,
            // Overview section
            /^(##\s+Overview)/mi,
            // Document metadata block
            /^(>\s*\*\*[A-Z])/m,
        ];
        
        for (const pattern of planStartPatterns) {
            const match = output.match(pattern);
            if (match && match.index !== undefined) {
                const extracted = output.substring(match.index);
                // Verify we extracted something substantial (at least 100 chars)
                if (extracted.length > 100) {
                    return extracted;
                }
            }
        }
        
        // Fallback: If output starts with commentary (lowercase sentence), 
        // try to find where the plan actually starts
        if (/^[a-z]/.test(output.trim())) {
            // Look for first markdown header
            const headerMatch = output.match(/^(#+ .+)/m);
            if (headerMatch && headerMatch.index !== undefined && headerMatch.index > 0) {
                const extracted = output.substring(headerMatch.index);
                if (extracted.length > 100) {
                    return extracted;
                }
            }
        }
        
        // Last resort: return as-is
        return output;
    }
}

