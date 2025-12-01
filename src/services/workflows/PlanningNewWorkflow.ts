// ============================================================================
// PlanningNewWorkflow - Full planning loop: Context → (Planner → Analysts)* → Finalize
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
 * 1. context - Gather project context
 * 2. planner - Initial plan creation
 * 3. analysts - Parallel analyst reviews
 * 4. (iteration) - Repeat planner → analysts if critical issues
 * 5. finalize - Finalize the plan
 * 
 * Max iterations: 3
 */
export class PlanningNewWorkflow extends BaseWorkflow {
    private static readonly PHASES = [
        'context',
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
            case 'context':
                await this.executeContextPhase();
                break;
                
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
    
    private async executeContextPhase(): Promise<void> {
        // Initialize paths
        this.stateManager.ensurePlanDirectories(this.sessionId);
        this.planPath = this.stateManager.getPlanFilePath(this.sessionId);
        this.contextPath = path.join(
            this.stateManager.getPlanFolder(this.sessionId), 
            'context.md'
        );
        
        this.log('📂 PHASE: CONTEXT PREPARATION');
        
        const role = this.getRole('context_gatherer');
        const prompt = this.buildContextPrompt(role);
        
        this.log(`Running context gatherer (${role?.defaultModel || 'gemini-3-pro'})...`);
        
        const result = await this.runAgentTask('context_gatherer', prompt, role);
        
        if (result.success && result.output) {
            fs.writeFileSync(this.contextPath, result.output);
            this.log(`✓ Context saved to ${path.basename(this.contextPath)}`);
        } else {
            this.log(`⚠️ Context gathering failed, using minimal context`);
            fs.writeFileSync(this.contextPath, `# Project Context\n\nRequirement: ${this.requirement}\n`);
        }
    }
    
    private async executePlannerPhase(): Promise<void> {
        this.iteration++;
        
        this.log('');
        this.log(`📝 PHASE: PLANNER (iteration ${this.iteration}/${PlanningNewWorkflow.MAX_ITERATIONS})`);
        
        const role = this.getRole('planner');
        const mode = this.iteration === 1 ? 'create' : 'update';
        const prompt = this.buildPlannerPrompt(mode, role);
        
        this.log(`Running planner - ${mode.toUpperCase()} mode (${role?.defaultModel || 'opus-4.5'})...`);
        
        const result = await this.runAgentTask('planner', prompt, role);
        
        if (result.success && result.output) {
            fs.writeFileSync(this.planPath, result.output);
            this.log(`✓ Plan ${mode === 'create' ? 'created' : 'updated'}`);
        } else {
            throw new Error(`Planner ${mode} task failed`);
        }
    }
    
    private async executeAnalystsPhase(): Promise<void> {
        this.log('');
        this.log('🔍 PHASE: ANALYST REVIEWS (parallel)');
        
        this.analystOutputs = {};
        
        const analystRoles = ['analyst_codex', 'analyst_gemini', 'analyst_reviewer'];
        
        // Run all analysts in parallel
        await Promise.all(
            analystRoles.map(roleId => this.runAnalystTask(roleId))
        );
        
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
            // Move phase index back to planner phase (index 1)
            this.phaseIndex = 0; // Will be incremented to 1 (planner) by runPhases
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
        
        const result = await this.runAgentTask('planner_finalize', prompt, role);
        
        if (result.success && result.output) {
            fs.writeFileSync(this.planPath, result.output);
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

        let modeInstructions = '';
        let existingContent = '';
        
        if (fs.existsSync(this.planPath)) {
            existingContent = fs.readFileSync(this.planPath, 'utf-8');
        }
        
        const contextContent = fs.existsSync(this.contextPath) 
            ? fs.readFileSync(this.contextPath, 'utf-8') 
            : '';
        
        if (mode === 'create') {
            modeInstructions = `## Mode: CREATE
You are creating the initial plan.

### Requirement
${this.requirement}

### Project Context
${contextContent}

Create a detailed task breakdown with:
- [ ] **T{N}**: Task description | Deps: dependencies | Engineer: TBD

Include sections for:
1. Overview
2. Task Breakdown (with checkboxes)
3. Dependencies
4. Risk Assessment
5. Engineer Allocation`;
        } else {
            modeInstructions = `## Mode: UPDATE
You are updating the plan based on analyst feedback.

### Current Plan
${existingContent}

### Analyst Feedback
${this.formatAnalystFeedback()}

### Instructions
1. Address ALL Critical Issues raised by analysts
2. Consider Minor Suggestions
3. Preserve working parts of the plan
4. Update task breakdown if needed`;
        }
        
        return `${basePrompt}

${modeInstructions}

## Output
Provide the COMPLETE plan in markdown format with proper task checkbox format.`;
    }
    
    private buildFinalizationPrompt(forced: boolean, role: AgentRole | undefined): string {
        const existingContent = fs.existsSync(this.planPath) 
            ? fs.readFileSync(this.planPath, 'utf-8') 
            : '';
        
        const warnings = forced 
            ? `\n\n## WARNINGS (Max iterations reached)
The following critical issues were not fully resolved:
${this.criticalIssues.map(i => `- ${i}`).join('\n') || '- None recorded'}` 
            : '';
        
        return `You are finalizing the execution plan.

## Current Plan
${existingContent}

## Analyst Feedback Summary
${this.formatAnalystFeedback()}
${warnings}

## Instructions
1. Ensure all tasks use checkbox format: - [ ] **T{N}**: Description | Deps: X | Engineer: TBD
2. Incorporate any minor suggestions that improve the plan
3. Update the status to "READY FOR REVIEW"
4. Clean up any formatting issues
${forced ? '5. Add a WARNINGS section noting unresolved critical issues' : ''}

## Output
Provide the FINAL plan in markdown format.`;
    }
    
    private buildAnalystPrompt(roleId: string, role: AgentRole | undefined): string {
        if (!role?.promptTemplate) {
            throw new Error(`Missing prompt template for ${roleId} role`);
        }
        const basePrompt = role.promptTemplate;
        
        const planContent = fs.existsSync(this.planPath) 
            ? fs.readFileSync(this.planPath, 'utf-8') 
            : '';
        
        const contextContent = fs.existsSync(this.contextPath) 
            ? fs.readFileSync(this.contextPath, 'utf-8') 
            : '';
        
        return `${basePrompt}

## Plan to Review
${planContent}

## Project Context
${contextContent}

## Your Task
Review the plan and provide feedback.

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
        role: AgentRole | undefined
    ): Promise<{ success: boolean; output: string }> {
        // Request an agent from the pool for planning role
        const roleId = role?.id || 'planner';
        const agentName = await this.requestAgent(roleId);
        
        try {
            const workspaceRoot = this.stateManager.getWorkspaceRoot();
            const logDir = path.join(this.stateManager.getPlanFolder(this.sessionId), 'logs');
            
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
            
            const logFile = path.join(logDir, `${taskId}_${Date.now()}.log`);
            
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
                timeoutMs: role?.timeoutMs || 600000,
                onProgress: (msg) => this.log(`  ${msg}`)
            };
            
            // Track agent run ID for pause handling
            this.currentAgentRunId = options.id;
            
            const result = await this.agentRunner.run(options);
            
            this.currentAgentRunId = undefined;
            
            return {
                success: result.success,
                output: result.output
            };
        } finally {
            // Always release the agent back to the pool
            this.releaseAgent(agentName);
        }
    }
    
    private async runAnalystTask(roleId: string): Promise<void> {
        const role = this.getRole(roleId);
        const prompt = this.buildAnalystPrompt(roleId, role);
        
        this.log(`Running ${roleId} (${role?.defaultModel || 'sonnet-4.5'})...`);
        
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
            // Legacy fallback: use raw output for parsing
            if (result.success && result.rawOutput) {
                this.analystOutputs[roleId] = result.rawOutput;
                this.log(`✓ ${roleId} complete via output (will parse)`);
            } else {
                this.log(`⚠️ ${roleId} failed`);
                this.analystOutputs[roleId] = '### Review Result: PASS\n\n#### Critical Issues\n- None\n';
                this.analystResults[roleId] = 'pass';
                this.analystUsedCallback.add(roleId); // Mark as handled so we don't parse
            }
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
}

