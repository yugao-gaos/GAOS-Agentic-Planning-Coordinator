// ============================================================================
// ContextGatheringWorkflow - Multi-phase context gathering with preset support
// Phases: Prescan → Gather (parallel) → Aggregate → Persist
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import { BaseWorkflow } from './BaseWorkflow';
import { WorkflowServices } from './IWorkflow';
import { 
    WorkflowConfig,
    ContextGatheringInput,
    ContextGatheringPresetConfig
} from '../../types/workflow';
import { AgentRunner, AgentRunOptions } from '../AgentBackend';
import { AgentRole } from '../../types';
import { ServiceLocator } from '../ServiceLocator';
import { getFolderStructureManager } from '../FolderStructureManager';
import {
    getAllPresets,
    getExtensionMap,
    detectAssetTypes,
    scanDirectories
} from './ContextGatheringPresets';

/**
 * Result of a single gather task
 */
interface GatherResult {
    presetId: string;
    success: boolean;
    output: string;
    fileCount: number;
    error?: string;
}

/**
 * Context gathering workflow - gathers and persists project context
 * 
 * This workflow uses a preset system to specialize context gathering
 * for different asset/code types. It auto-detects asset types from
 * file extensions and runs parallel gather tasks.
 * 
 * Phases:
 * 1. prescan - Scan target directories, categorize files by extension (no AI)
 * 2. gather - Run parallel AI agents for each detected asset type
 * 3. aggregate - Check completion, loop back if needed
 * 4. persist - Write combined output to _AiDevLog/Context/
 * 
 * Use cases:
 * - Before starting execution: gather context on unfamiliar codebase areas
 * - After errors: gather context on problematic files
 * - Proactively: keep context updated as codebase evolves
 */
export class ContextGatheringWorkflow extends BaseWorkflow {
    private static readonly PHASES = ['prescan', 'gather', 'aggregate', 'summarize', 'persist'];
    private static readonly MAX_GATHER_ITERATIONS = 3;
    private static readonly SUMMARIZE_THRESHOLD = 5000; // Chars threshold for summarization
    
    // Input
    private targets: string[];
    private focusAreas: string[];
    private taskId?: string;
    private outputName: string;
    private manualPreset?: string;
    private depth: 'shallow' | 'deep';
    private autoDetect: boolean;
    
    // Preset configuration (loaded from built-ins + user config)
    private presets: Record<string, ContextGatheringPresetConfig>;
    private extensionMap: Record<string, string>;
    
    // State
    private detectedTypes: Map<string, string[]> = new Map(); // presetId → file paths
    private gatherResults: Map<string, GatherResult> = new Map();
    private gatherIterations: number = 0;
    private combinedOutput: string = '';
    private summarizedOutput: string = '';  // Final output after summarization
    private contextPath: string = '';
    
    private agentRunner: AgentRunner;
    
    constructor(config: WorkflowConfig, services: WorkflowServices) {
        super(config, services);
        this.agentRunner = ServiceLocator.resolve(AgentRunner);
        
        // Extract input
        const input = config.input as ContextGatheringInput;
        this.targets = input.targets || [];
        this.focusAreas = input.focusAreas || [];
        this.taskId = input.taskId;
        this.outputName = input.outputName || 'context';
        this.manualPreset = input.preset;
        this.depth = input.depth || 'deep';
        this.autoDetect = input.autoDetect !== false; // Default true
        
        // Load presets from built-ins + user config
        const workspaceRoot = this.stateManager.getWorkspaceRoot();
        this.presets = getAllPresets(workspaceRoot);
        this.extensionMap = getExtensionMap(workspaceRoot);
    }
    
    getPhases(): string[] {
        return ContextGatheringWorkflow.PHASES;
    }
    
    async executePhase(phaseIndex: number): Promise<void> {
        const phase = this.getPhases()[phaseIndex];
        
        switch (phase) {
            case 'prescan':
                await this.executePrescanPhase();
                break;
                
            case 'gather':
                await this.executeGatherPhase();
                break;
                
            case 'aggregate':
                await this.executeAggregatePhase();
                break;
                
            case 'summarize':
                await this.executeSummarizePhase();
                break;
                
            case 'persist':
                await this.executePersistPhase();
                break;
        }
    }
    
    getState(): object {
        return {
            targets: this.targets,
            focusAreas: this.focusAreas,
            taskId: this.taskId,
            outputName: this.outputName,
            manualPreset: this.manualPreset,
            depth: this.depth,
            detectedTypesCount: this.detectedTypes.size,
            gatherResultsCount: this.gatherResults.size,
            gatherIterations: this.gatherIterations,
            combinedOutputLength: this.combinedOutput.length,
            summarizedOutputLength: this.summarizedOutput.length,
            contextPath: this.contextPath
        };
    }
    
    protected getProgressMessage(): string {
        const phase = this.getPhases()[this.phaseIndex] || 'unknown';
        switch (phase) {
            case 'prescan':
                return `Scanning ${this.targets.length} target(s) for asset types...`;
            case 'gather':
                return `Gathering context for ${this.detectedTypes.size} asset type(s) (iteration ${this.gatherIterations})...`;
            case 'aggregate':
                return `Aggregating ${this.gatherResults.size} gather result(s)...`;
            case 'summarize':
                return `Summarizing ${this.combinedOutput.length} chars of context...`;
            case 'persist':
                return `Persisting context to file...`;
            default:
                return `Processing context...`;
        }
    }
    
    protected getOutput(): any {
        return {
            contextPath: this.contextPath,
            targets: this.targets,
            detectedTypes: Array.from(this.detectedTypes.keys()),
            gatherResults: Array.from(this.gatherResults.entries()).map(([id, r]) => ({
                presetId: id,
                success: r.success,
                fileCount: r.fileCount
            })),
            combinedOutputLength: this.combinedOutput.length,
            summarizedOutputLength: this.summarizedOutput.length,
            success: this.summarizedOutput.length > 0 || this.combinedOutput.length > 0
        };
    }
    
    // =========================================================================
    // PHASE 1: PRESCAN - No AI, just file scanning
    // =========================================================================
    
    private async executePrescanPhase(): Promise<void> {
        this.log(`📂 PHASE: PRESCAN - Scanning targets for asset types`);
        
        const workspaceRoot = this.stateManager.getWorkspaceRoot();
        
        // If manual preset specified, skip auto-detection
        if (this.manualPreset && !this.autoDetect) {
            this.log(`Using manual preset: ${this.manualPreset}`);
            const files = scanDirectories(this.targets, workspaceRoot);
            this.detectedTypes.set(this.manualPreset, files);
            this.log(`✓ Assigned ${files.length} files to preset '${this.manualPreset}'`);
            return;
        }
        
        // Scan directories for files
        const files = scanDirectories(this.targets, workspaceRoot);
        this.log(`Found ${files.length} files in ${this.targets.length} target(s)`);
        
        // Detect asset types based on file extensions
        this.detectedTypes = detectAssetTypes(
            files,
            this.extensionMap,
            this.unityEnabled,
            this.presets
        );
        
        // Log detected types
        if (this.detectedTypes.size === 0) {
            this.log(`⚠️ No recognized asset types found in targets`);
            // Fall back to manual preset if provided
            if (this.manualPreset) {
                this.detectedTypes.set(this.manualPreset, files);
                this.log(`Using fallback preset: ${this.manualPreset}`);
            }
        } else {
            this.log(`Detected ${this.detectedTypes.size} asset type(s):`);
            for (const [presetId, presetFiles] of this.detectedTypes) {
                const preset = this.presets[presetId];
                this.log(`  - ${preset?.name || presetId}: ${presetFiles.length} files`);
            }
        }
    }
    
    // =========================================================================
    // PHASE 2: GATHER - Parallel AI agents per asset type
    // =========================================================================
    
    private async executeGatherPhase(): Promise<void> {
        this.gatherIterations++;
        this.log(`🔍 PHASE: GATHER - Running parallel context gathering (iteration ${this.gatherIterations})`);
        
        // Get types that need gathering (not yet gathered or previously failed)
        const typesToGather = this.getTypesNeedingGather();
        
        if (typesToGather.length === 0) {
            this.log(`All asset types already gathered successfully`);
            return;
        }
        
        this.log(`Gathering context for ${typesToGather.length} asset type(s) in parallel...`);
        
        // Run gather tasks in parallel
        const gatherPromises = typesToGather.map(([presetId, files]) => 
            this.runGatherTask(presetId, files)
        );
        
        const results = await Promise.all(gatherPromises);
        
        // Store results
        for (const result of results) {
            this.gatherResults.set(result.presetId, result);
            const status = result.success ? '✓' : '✗';
            this.log(`  ${status} ${result.presetId}: ${result.output.length} chars`);
        }
    }
    
    /**
     * Get asset types that need gathering (not yet gathered or previously failed)
     */
    private getTypesNeedingGather(): [string, string[]][] {
        const typesToGather: [string, string[]][] = [];
        
        for (const [presetId, files] of this.detectedTypes) {
            const existingResult = this.gatherResults.get(presetId);
            
            // Need to gather if no result yet or previous attempt failed
            if (!existingResult || !existingResult.success) {
                typesToGather.push([presetId, files]);
            }
        }
        
        return typesToGather;
    }
    
    /**
     * Run a single gather task for a preset
     */
    private async runGatherTask(presetId: string, files: string[]): Promise<GatherResult> {
        const preset = this.presets[presetId];
        if (!preset) {
            return {
                presetId,
                success: false,
                output: '',
                fileCount: files.length,
                error: `Preset '${presetId}' not found`
            };
        }
        
        // Request an agent from the pool
        const agentName = await this.requestAgent('context_gatherer');
        
        const role = this.getRole('context_gatherer');
        const prompt = this.buildGatherPrompt(preset, files, role);
        
        const workspaceRoot = this.stateManager.getWorkspaceRoot();
        const logDir = path.join(this.stateManager.getPlanFolder(this.sessionId), 'logs', 'agents');
        
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        
        // Use workflow ID + agent name for unique temp log file
        const logFile = path.join(logDir, `${this.id}_${agentName}.log`);
        
        try {
            const options: AgentRunOptions = {
                id: `context_${this.sessionId}_${presetId}`,
                prompt,
                cwd: workspaceRoot,
                model: role?.defaultModel || 'gemini-3-pro',
                logFile,
                timeoutMs: role?.timeoutMs || 300000,
                onProgress: (msg) => this.log(`  [${presetId}] ${msg}`)
            };
            
            const result = await this.agentRunner.run(options);
            
            return {
                presetId,
                success: result.success,
                output: result.output,
                fileCount: files.length,
                error: result.success ? undefined : 'Agent task failed'
            };
        } catch (error) {
            return {
                presetId,
                success: false,
                output: '',
                fileCount: files.length,
                error: error instanceof Error ? error.message : String(error)
            };
        } finally {
            // Always release the agent back to the pool
            this.releaseAgent(agentName);
            
            // Clean up temp log file (streaming was for real-time terminal viewing)
            try {
                if (fs.existsSync(logFile)) {
                    fs.unlinkSync(logFile);
                }
            } catch { /* ignore cleanup errors */ }
        }
    }
    
    // =========================================================================
    // PHASE 3: AGGREGATE - Check completion, maybe loop back
    // =========================================================================
    
    private async executeAggregatePhase(): Promise<void> {
        this.log(`📊 PHASE: AGGREGATE - Checking gather results`);
        
        // Check for incomplete gathers
        const incomplete = this.getTypesNeedingGather();
        
        if (incomplete.length > 0 && this.gatherIterations < ContextGatheringWorkflow.MAX_GATHER_ITERATIONS) {
            this.log(`⚠️ ${incomplete.length} asset type(s) incomplete - retrying (iteration ${this.gatherIterations + 1})`);
            // Loop back to gather phase
            // phaseIndex will be incremented by runPhases, so set to 0 to land on index 1 (gather)
            this.phaseIndex = 0;
            return;
        }
        
        if (incomplete.length > 0) {
            this.log(`⚠️ ${incomplete.length} asset type(s) still incomplete after ${this.gatherIterations} iterations`);
            for (const [presetId] of incomplete) {
                this.log(`  - ${presetId}: Failed to gather`);
            }
        }
        
        // Combine all successful gather results
        this.combinedOutput = this.combineGatherResults();
        this.log(`✓ Combined ${this.gatherResults.size} gather result(s) into ${this.combinedOutput.length} chars`);
    }
    
    /**
     * Combine all successful gather results into a single output
     */
    private combineGatherResults(): string {
        const sections: string[] = [];
        
        for (const [presetId, result] of this.gatherResults) {
            if (!result.success || !result.output) {
                continue;
            }
            
            const preset = this.presets[presetId];
            const sectionTitle = preset?.name || presetId;
            
            sections.push(`## ${sectionTitle}

${result.output}
`);
        }
        
        return sections.join('\n---\n\n');
    }
    
    // =========================================================================
    // PHASE 4: SUMMARIZE - Condense combined results if too long
    // =========================================================================
    
    private async executeSummarizePhase(): Promise<void> {
        this.log(`📝 PHASE: SUMMARIZE - Condensing gathered context`);
        
        // If combined output is small enough, skip summarization
        if (this.combinedOutput.length < ContextGatheringWorkflow.SUMMARIZE_THRESHOLD) {
            this.summarizedOutput = this.combinedOutput;
            this.log(`✓ Content under threshold (${this.combinedOutput.length} chars), skipping summarization`);
            return;
        }
        
        // If no content, nothing to summarize
        if (!this.combinedOutput || this.combinedOutput.length === 0) {
            this.summarizedOutput = '';
            this.log(`⚠️ No content to summarize`);
            return;
        }
        
        this.log(`Summarizing ${this.combinedOutput.length} chars of context...`);
        
        // Request an agent for summarization
        const agentName = await this.requestAgent('context_gatherer');
        
        const role = this.getRole('context_gatherer');
        const prompt = this.buildSummarizePrompt(role);
        
        const workspaceRoot = this.stateManager.getWorkspaceRoot();
        const logDir = path.join(this.stateManager.getPlanFolder(this.sessionId), 'logs', 'agents');
        
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        
        // Use workflow ID + agent name for unique temp log file
        const logFile = path.join(logDir, `${this.id}_${agentName}.log`);
        
        try {
            const options: AgentRunOptions = {
                id: `context_${this.sessionId}_summarize`,
                prompt,
                cwd: workspaceRoot,
                model: role?.defaultModel || 'gemini-3-pro',
                logFile,
                timeoutMs: role?.timeoutMs || 300000,
                onProgress: (msg) => this.log(`  [summarize] ${msg}`)
            };
            
            const result = await this.agentRunner.run(options);
            
            if (result.success && result.output) {
                this.summarizedOutput = result.output;
                this.log(`✓ Summarized to ${this.summarizedOutput.length} chars (${Math.round((1 - this.summarizedOutput.length / this.combinedOutput.length) * 100)}% reduction)`);
            } else {
                // Fall back to combined output on failure
                this.summarizedOutput = this.combinedOutput;
                this.log(`⚠️ Summarization failed, using combined output directly`);
            }
        } catch (error) {
            // Fall back to combined output on error
            this.summarizedOutput = this.combinedOutput;
            this.log(`⚠️ Summarization error, using combined output directly`);
        } finally {
            this.releaseAgent(agentName);
            
            // Clean up temp log file (streaming was for real-time terminal viewing)
            try {
                if (fs.existsSync(logFile)) {
                    fs.unlinkSync(logFile);
                }
            } catch { /* ignore cleanup errors */ }
        }
    }
    
    /**
     * Build the summarize prompt
     */
    private buildSummarizePrompt(role: AgentRole | undefined): string {
        const basePrompt = role?.promptTemplate || `You are a context summarization assistant.
Your job is to create concise, useful summaries of gathered context.`;
        
        return `${basePrompt}

## Task
Summarize the following gathered context into a concise, actionable reference document.
The content was gathered from ${this.detectedTypes.size} different asset/code types.

### Gathered Context (${this.combinedOutput.length} characters)
${this.combinedOutput}

## Instructions
1. Create a well-structured summary that preserves essential information
2. Highlight the most important patterns, APIs, and conventions
3. Remove redundancy while keeping key details
4. Organize by logical sections (architecture, patterns, dependencies, etc.)
5. Include specific file paths and code snippets only if essential
6. Target output should be 30-50% of the original length

## Output Format
Provide a markdown document with:
- Executive summary (3-5 sentences covering the most important points)
- Key components and their purposes
- Important patterns/conventions found
- Dependencies and integration points
- Actionable notes for developers

Focus on information that would help a developer quickly understand and work with this codebase.`;
    }
    
    // =========================================================================
    // PHASE 5: PERSIST - Write summarized output to file
    // =========================================================================
    
    private async executePersistPhase(): Promise<void> {
        this.log(`💾 PHASE: PERSIST - Writing context to configured context folder`);
        
        // Ensure context directory exists - use FolderStructureManager
        const workspaceRoot = this.stateManager.getWorkspaceRoot();
        let contextDir: string;
        try {
            const folderStructure = getFolderStructureManager();
            contextDir = folderStructure.getFolderPath('context');
        } catch {
            // Fallback if FolderStructureManager not initialized
            contextDir = path.join(workspaceRoot, '_AiDevLog', 'Context');
        }
        
        if (!fs.existsSync(contextDir)) {
            fs.mkdirSync(contextDir, { recursive: true });
        }
        
        // Build filename
        let filename = this.outputName;
        if (this.taskId) {
            filename = `task_${this.taskId}_context`;
        } else if (this.targets.length === 1) {
            // Use target name for single target
            const target = this.targets[0];
            filename = path.basename(target).replace(/\.[^/.]+$/, '') + '_context';
        }
        
        this.contextPath = path.join(contextDir, `${filename}.md`);
        
        // Build metadata section
        const detectedTypesList = Array.from(this.detectedTypes.keys())
            .map(id => this.presets[id]?.name || id)
            .join(', ');
        
        const successfulGathers = Array.from(this.gatherResults.values())
            .filter(r => r.success).length;
        
        // Use summarized output if available, otherwise combined
        const outputContent = this.summarizedOutput || this.combinedOutput || '_No context gathered_';
        const wasSummarized = this.summarizedOutput && this.summarizedOutput !== this.combinedOutput;
        
        // Build content with metadata header
        const content = `# Context: ${filename}

## Metadata
- Generated: ${new Date().toISOString()}
- Targets: ${this.targets.join(', ')}
- Focus Areas: ${this.focusAreas.length > 0 ? this.focusAreas.join(', ') : 'General'}
- Detected Asset Types: ${detectedTypesList || 'None'}
- Gather Results: ${successfulGathers}/${this.detectedTypes.size} successful
- Depth: ${this.depth}
${wasSummarized ? `- Summarized: ${this.combinedOutput.length} → ${this.summarizedOutput.length} chars` : ''}
${this.taskId ? `- Task: ${this.taskId}` : ''}

---

${outputContent}
`;
        
        fs.writeFileSync(this.contextPath, content);
        this.log(`✓ Context saved to ${path.relative(workspaceRoot, this.contextPath)}`);
    }
    
    // =========================================================================
    // PROMPT BUILDERS
    // =========================================================================
    
    /**
     * Build the gather prompt for a specific preset
     */
    private buildGatherPrompt(
        preset: ContextGatheringPresetConfig,
        files: string[],
        role: AgentRole | undefined
    ): string {
        const basePrompt = role?.promptTemplate || `You are a context gathering assistant.
Your job is to read and understand code/assets, identifying patterns, dependencies, and key concepts.`;
        
        const workspaceRoot = this.stateManager.getWorkspaceRoot();
        
        // Build file list (relative paths)
        const fileList = files
            .slice(0, 100) // Limit to first 100 files to avoid prompt explosion
            .map(f => `- ${path.relative(workspaceRoot, f)}`)
            .join('\n');
        
        const fileCountNote = files.length > 100 
            ? `\n\n_Note: Showing first 100 of ${files.length} files_` 
            : '';
        
        // Build focus areas if provided
        const focusStr = this.focusAreas.length > 0 
            ? `\n### Additional Focus Areas\n${this.focusAreas.map(f => `- ${f}`).join('\n')}`
            : '';
        
        // Depth instruction
        const depthInstruction = this.depth === 'shallow' 
            ? '\n\n**Analysis Depth**: Perform a QUICK scan - prioritize breadth over depth. Focus on high-level patterns and structure.'
            : '\n\n**Analysis Depth**: Perform a THOROUGH analysis - be comprehensive. Include detailed patterns, dependencies, and specific examples.';
        
        return `${basePrompt}

## Context Gathering Task: ${preset.name}

${preset.description}

### Target Files
${fileList}${fileCountNote}

${preset.gatherPrompt}
${focusStr}
${depthInstruction}

## Output
Provide a detailed context report in markdown format. Focus on information that would be useful for developers working in this area.
${this.taskId ? `\nThis context is being gathered for task: ${this.taskId}` : ''}`;
    }
}
