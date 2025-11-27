import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, execSync, ChildProcess } from 'child_process';

/**
 * Analyst agent configuration
 * Each analyst runs as a separate Cursor agent session with a different model
 */
export interface AnalystConfig {
    id: string;
    name: string;
    model: string;
    role: string;  // e.g., "Architecture", "Performance", "Testing"
}

/**
 * The three analyst agents for multi-model debate
 * Each runs as a separate Cursor CLI session
 */
const ANALYST_CONFIGS: AnalystConfig[] = [
    {
        id: 'opus',
        name: 'Opus Analyst',
        model: 'opus-4.5',
        role: 'Architecture & Design'
    },
    {
        id: 'codex',
        name: 'Codex Analyst', 
        model: 'gpt-5.1-codex-high',
        role: 'Implementation & Performance'
    },
    {
        id: 'gemini',
        name: 'Gemini Analyst',
        model: 'gemini-3-pro',
        role: 'Testing & Integration'
    }
];

/**
 * Agent response from analysis
 */
export interface AgentAnalysis {
    agentName: string;
    model: string;
    role: string;
    concerns: string[];
    recommendations: string[];
    contextGathered?: string[];  // Files/assets discovered
    taskBreakdown: Array<{
        name: string;
        files: string[];
        dependencies: string[];
        tests: string[];
    }>;
    engineerCount: number;
    rationale: string;
    rawOutput: string;
}

/**
 * Context Gatherer configuration
 * Runs in background with Gemini to intelligently gather context
 */
interface ContextGathererState {
    processId: string;
    contextFile: string;
    status: 'running' | 'completed' | 'failed';
    gatheredFolders: string[];
    taskContexts: Map<string, string[]>;
}

/**
 * AgentRunner - Runs multiple Cursor agent CLI sessions for multi-model debate
 * 
 * Architecture:
 * - 1 Context Gatherer agent (gemini-3-pro) runs in background for intelligent context gathering
 * - 3 Analyst agents run in parallel (opus-4.5, gpt-5.1-codex-high, gemini-3-pro)
 * - Context Gatherer continues during debate, providing broader understanding
 * - After debate, Context Gatherer reviews tasks and gathers specific context
 */
/**
 * Persistent context index entry
 */
interface ContextEntry {
    path: string;
    type: 'script' | 'asset' | 'prefab' | 'scene' | 'data' | 'doc' | 'session';
    summary: string;
    lastScanned?: string;
    hash?: string;
    dependencies?: string[];
    publicMembers?: string[];
    keywords?: string[];
}

/**
 * Context index structure stored in _AiDevLog/Context/
 */
interface ContextIndex {
    version: number;
    lastUpdated: string;
    projectName: string;
    entries: Record<string, ContextEntry>;
    folders: Record<string, { scanned: string; fileCount: number }>;
}

export class AgentRunner {
    private workspaceRoot: string;
    private debateDir: string;
    private contextDir: string;  // Temporary session context
    private persistentContextDir: string;  // Persistent indexed context
    private activeProcesses: Map<string, ChildProcess> = new Map();
    private contextGatherer: ContextGathererState | null = null;
    private contextIndex: ContextIndex | null = null;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
        this.debateDir = path.join(workspaceRoot, '_AiDevLog', '.debate');
        this.contextDir = path.join(workspaceRoot, '_AiDevLog', '.context_gatherer');
        this.persistentContextDir = path.join(workspaceRoot, '_AiDevLog', 'Context');
        
        // Ensure directories exist
        if (!fs.existsSync(this.debateDir)) {
            fs.mkdirSync(this.debateDir, { recursive: true });
        }
        if (!fs.existsSync(this.contextDir)) {
            fs.mkdirSync(this.contextDir, { recursive: true });
        }
        if (!fs.existsSync(this.persistentContextDir)) {
            fs.mkdirSync(this.persistentContextDir, { recursive: true });
        }
        
        // Load existing context index
        this.loadContextIndex();
    }
    
    /**
     * Load the persistent context index from disk
     */
    private loadContextIndex(): void {
        const indexPath = path.join(this.persistentContextDir, 'context_index.json');
        if (fs.existsSync(indexPath)) {
            try {
                this.contextIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
            } catch (e) {
                console.error('Failed to load context index:', e);
                this.contextIndex = null;
            }
        }
        
        // Initialize if not exists
        if (!this.contextIndex) {
            this.contextIndex = {
                version: 1,
                lastUpdated: new Date().toISOString(),
                projectName: path.basename(this.workspaceRoot),
                entries: {},
                folders: {}
            };
        }
    }
    
    /**
     * Save the persistent context index to disk
     */
    private saveContextIndex(): void {
        if (!this.contextIndex) return;
        
        this.contextIndex.lastUpdated = new Date().toISOString();
        const indexPath = path.join(this.persistentContextDir, 'context_index.json');
        fs.writeFileSync(indexPath, JSON.stringify(this.contextIndex, null, 2));
    }
    
    /**
     * Get existing context summary for a requirement
     * Reads from persistent storage before doing new scans
     */
    getExistingContext(keywords: string[]): string {
        if (!this.contextIndex || Object.keys(this.contextIndex.entries).length === 0) {
            return '';
        }
        
        const relevantEntries: ContextEntry[] = [];
        const keywordsLower = keywords.map(k => k.toLowerCase());
        
        // Find entries matching keywords
        for (const [entryPath, entry] of Object.entries(this.contextIndex.entries)) {
            const pathLower = entryPath.toLowerCase();
            const summaryLower = entry.summary.toLowerCase();
            
            for (const kw of keywordsLower) {
                if (pathLower.includes(kw) || summaryLower.includes(kw)) {
                    relevantEntries.push(entry);
                    break;
                }
            }
        }
        
        if (relevantEntries.length === 0) {
            return '';
        }
        
        // Build context summary
        const lines: string[] = [
            '## Existing Project Context (from previous scans)',
            `*Last indexed: ${this.contextIndex.lastUpdated}*`,
            ''
        ];
        
        // Group by type
        const byType: Record<string, ContextEntry[]> = {};
        for (const entry of relevantEntries) {
            if (!byType[entry.type]) byType[entry.type] = [];
            byType[entry.type].push(entry);
        }
        
        for (const [type, entries] of Object.entries(byType)) {
            lines.push(`### ${type.charAt(0).toUpperCase() + type.slice(1)}s`);
            for (const entry of entries.slice(0, 10)) {
                lines.push(`- **${entry.path}**: ${entry.summary}`);
                if (entry.publicMembers && entry.publicMembers.length > 0) {
                    lines.push(`  - Members: ${entry.publicMembers.slice(0, 5).join(', ')}`);
                }
            }
            lines.push('');
        }
        
        return lines.join('\n');
    }
    
    /**
     * Update context index with new entry
     */
    updateContextEntry(entry: ContextEntry): void {
        if (!this.contextIndex) {
            this.loadContextIndex();
        }
        
        this.contextIndex!.entries[entry.path] = {
            ...entry,
            lastScanned: new Date().toISOString()
        };
        
        this.saveContextIndex();
    }
    
    /**
     * Update context index for a scanned folder
     */
    updateFolderContext(folderPath: string, fileCount: number): void {
        if (!this.contextIndex) {
            this.loadContextIndex();
        }
        
        this.contextIndex!.folders[folderPath] = {
            scanned: new Date().toISOString(),
            fileCount
        };
        
        this.saveContextIndex();
    }
    
    /**
     * Check if a folder needs rescanning
     * Returns true if folder was never scanned or scanned more than 1 hour ago
     */
    folderNeedsRescan(folderPath: string): boolean {
        if (!this.contextIndex || !this.contextIndex.folders[folderPath]) {
            return true;
        }
        
        const lastScanned = new Date(this.contextIndex.folders[folderPath].scanned);
        const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
        
        return lastScanned < hourAgo;
    }
    
    /**
     * Write context to persistent storage (for context gatherer results)
     */
    persistContextFile(sessionId: number, content: string): string {
        const persistPath = path.join(
            this.persistentContextDir, 
            `session_${sessionId}_context.md`
        );
        fs.writeFileSync(persistPath, content);
        return persistPath;
    }

    /**
     * Create the initial plan file skeleton with TBD sections
     * Agents will debate directly in this file using file locking
     */
    createPlanSkeleton(
        sessionId: string,
        requirement: string,
        docs: string[],
        planPath: string
    ): void {
        const timestamp = new Date().toISOString();
        const analysts = ANALYST_CONFIGS.map(a => `- ${a.name} (${a.role})`).join('\n');
        
        const skeleton = `# Execution Plan: Session ${sessionId}

**Status:** 🔄 PLANNING (agents debating)
**Created:** ${timestamp}
**Plan File:** This file is the single source of truth. Agents write directly here.

---

## 1. Requirement

${requirement}

---

## 2. Provided Documentation

${docs.map(d => `- ${d}`).join('\n')}

---

## 3. Unity Project Context

**Status:** ⏳ Context Gatherer agent analyzing...

### Scenes
_TBD - Context Gatherer will populate_

### Scripts  
_TBD - Context Gatherer will populate_

### Assets
_TBD - Context Gatherer will populate_

---

## 4. Analyst Contributions

The following analysts are debating this plan:
${analysts}

Each analyst will append their findings below using file locking.
They can see and respond to each other's contributions.

---

<!-- ANALYST_SECTION_START -->

### 🏗️ Opus Analyst (Architecture & Design)
**Status:** ⏳ Analyzing...

_Analysis pending..._

---

### ⚡ Codex Analyst (Implementation & Performance)  
**Status:** ⏳ Analyzing...

_Analysis pending..._

---

### 🧪 Gemini Analyst (Testing & Integration)
**Status:** ⏳ Analyzing...

_Analysis pending..._

<!-- ANALYST_SECTION_END -->

---

## 5. Task Breakdown

Tasks will be added by analysts during their analysis.
Each task includes: name, files, dependencies, tests, best practices.

| ID | Task | Dependencies | Files | Tests |
|----|------|--------------|-------|-------|
| _TBD_ | _Analysts identifying tasks..._ | _TBD_ | _TBD_ | _TBD_ |

---

## 6. Consensus & Recommendations

**Status:** ⏳ Pending analyst completion

### Shared Concerns
_Will be populated after analysts complete their analysis_

### Agreed Recommendations  
_Will be populated after analysts complete their analysis_

---

## 7. Dependency Graph

_Will be generated from task dependencies_

---

## 8. Engineer Allocation

**Recommended:** TBD
**Rationale:** TBD

_Each analyst will vote on engineer count_

---

## 9. Execution Phases

_Will be organized into parallel execution waves after task analysis_

---

<!-- PLAN_METADATA
session_id: ${sessionId}
created: ${timestamp}
status: planning
analysts: opus,codex,gemini
-->
`;

        // Ensure directory exists
        const planDir = path.dirname(planPath);
        if (!fs.existsSync(planDir)) {
            fs.mkdirSync(planDir, { recursive: true });
        }

        fs.writeFileSync(planPath, skeleton, 'utf-8');
    }

    /**
     * Check if Cursor CLI is available
     */
    isCursorAvailable(): boolean {
        try {
            execSync('which cursor', { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONTEXT GATHERER AGENT
    // Runs in background with Gemini 3 Pro for intelligent context gathering
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Start the Context Gatherer agent in background
     * Phase 1: Intelligent prescan based on requirement
     * NOW WITH PERSISTENT CONTEXT: Reads existing context before scanning
     */
    async startContextGatherer(
        sessionId: number,
        requirement: string,
        docs: string[],
        onProgress?: (message: string) => void
    ): Promise<string> {
        if (!this.isCursorAvailable()) {
            onProgress?.('⚠️ Cursor CLI not available for Context Gatherer');
            return '';
        }

        // Extract keywords from requirement for context lookup
        const keywords = requirement.toLowerCase()
            .split(/\s+/)
            .filter(w => w.length > 3)
            .slice(0, 15);
        
        // Check for existing context first
        const existingContext = this.getExistingContext(keywords);
        const hasExistingContext = existingContext.length > 0;
        
        if (hasExistingContext) {
            onProgress?.(`📚 Found existing context index with ${Object.keys(this.contextIndex?.entries || {}).length} entries`);
        } else {
            onProgress?.(`📝 No existing context found, will build fresh index`);
        }

        const contextFile = path.join(this.contextDir, `context_${sessionId}.md`);
        const processId = `context_gatherer_${sessionId}`;

        // Initialize context file WITH existing context if available
        const existingSection = hasExistingContext ? `
## EXISTING PROJECT CONTEXT
*Loaded from persistent context index*

${existingContext}

---
` : '';

        fs.writeFileSync(contextFile, `# Context Gatherer Session
Session: ${sessionId}
Started: ${new Date().toISOString()}
Model: gemini-3-pro
Persistent Index: ${this.persistentContextDir}

## Requirement
${requirement}

## Provided Docs
${docs.join(', ')}
${existingSection}
---
# NEW CONTEXT GATHERED
(Context Gatherer will scan for updates and new files)

`);

        this.contextGatherer = {
            processId,
            contextFile,
            status: 'running',
            gatheredFolders: [],
            taskContexts: new Map()
        };

        onProgress?.(`🔍 Starting Context Gatherer (gemini-3-pro) in background...`);
        if (hasExistingContext) {
            onProgress?.(`📚 Existing context loaded - will scan for changes only`);
        }

        // Build the context gatherer prompt (now includes existing context info)
        const prompt = this.buildContextGathererPrompt(requirement, docs, contextFile, 'prescan', existingContext);

        // Start the agent in background
        this.runContextGathererAgent(processId, prompt, contextFile, onProgress);

        return contextFile;
    }

    /**
     * Build prompt for Context Gatherer agent
     */
    private buildContextGathererPrompt(
        requirement: string,
        docs: string[],
        contextFile: string,
        phase: 'prescan' | 'during_debate' | 'task_review',
        existingContext: string = ''
    ): string {
        const docsParam = docs.map(d => d.replace('_AiDevLog/Docs/', '')).join(',');
        const hasExistingContext = existingContext.length > 0;
        const persistentDir = this.persistentContextDir;

        if (phase === 'prescan') {
            const existingContextSection = hasExistingContext ? `
## EXISTING PROJECT CONTEXT (Already Indexed)
You already have context from previous scans. Focus on CHANGES and NEW files only.
DO NOT re-scan files that haven't changed.

${existingContext.substring(0, 3000)}
${existingContext.length > 3000 ? '\n... (truncated, full context in index)' : ''}

**Strategy for this session:**
1. Read the existing context above
2. Only scan folders that might have NEW or CHANGED files
3. Update the context index with any new findings
4. Skip folders/files already documented unless they appear modified
` : `
## NO EXISTING CONTEXT
This is a fresh project scan. Build a comprehensive context index.
`;

            return `# Context Gatherer Agent - Phase 1: Intelligent Prescan
Model: gemini-3-pro
Role: Gather relevant context for planning analysts
Persistent Context Dir: ${persistentDir}

You are the Context Gatherer. Your job is to intelligently scan the codebase and Unity project to find relevant context for the planning analysts who will create an execution plan.

**IMPORTANT**: This project may have existing indexed context. Check the existing context section below before scanning.
${existingContextSection}
## Requirement to Analyze
${requirement}

## Provided Documentation
${docs.map(d => `- ${d}`).join('\n')}

---

# YOUR TASK

## Step 1: Check Existing Context (if available)
If existing context is provided above:
- Read it carefully first
- Identify what's already documented
- Focus your scanning on NEW or CHANGED areas

## Step 2: Analyze the Requirement
Read the requirement carefully. Identify:
- Key features mentioned (UI, services, data, gameplay, etc.)
- Technical domains involved (networking, input, audio, etc.)
- Likely folder locations in a Unity project
- What's MISSING from existing context that you need to gather

## Step 3: Use Unity MCP to Understand Project Structure
\`\`\`
mcp_unityMCP_manage_asset({ action: 'search', path: 'Assets', search_pattern: '*' })
mcp_unityMCP_manage_scene({ action: 'get_hierarchy' })
mcp_unityMCP_manage_editor({ action: 'get_state' })
\`\`\`

## Step 3: Intelligently Target gather_task_context.sh (PARALLEL)
Based on requirement keywords, run gather_task_context.sh on RELEVANT folders.
**IMPORTANT**: Run these in PARALLEL using & to speed up context gathering!

\`\`\`bash
# Identify 3-5 most relevant folders based on requirement, then run ALL AT ONCE:

# Example - run multiple in parallel (use & for background):
bash _AiDevLog/Scripts/gather_task_context.sh Assets/Scripts/Services cs "Service layer" --docs ${docsParam} &
bash _AiDevLog/Scripts/gather_task_context.sh Assets/Scripts/UI cs "UI scripts" --docs ${docsParam} &
bash _AiDevLog/Scripts/gather_task_context.sh Assets/Scripts/Core cs "Core gameplay" --docs ${docsParam} &
bash _AiDevLog/Scripts/gather_task_context.sh Assets/Prefabs prefab "Game prefabs" --docs ${docsParam} &
bash _AiDevLog/Scripts/gather_task_context.sh Assets/Data asset "ScriptableObjects" --docs ${docsParam} &

# Wait for all parallel jobs to complete
wait
echo "Context gathering complete!"
\`\`\`

The script handles:
- **Incremental updates**: Only analyzes new files, skips already documented
- **Parallel file analysis**: Analyzes up to 5 files simultaneously within each call
- **Safe concurrent access**: Uses file locks, so multiple script instances can run safely

## Step 5: Write Findings to Context File AND Persistent Index
Append your findings to BOTH the session file AND the persistent index:

\`\`\`bash
# Write to session context file
cat >> ${contextFile} << 'CONTEXT_EOF'

## PRESCAN RESULTS

### Folders Scanned
- [List folders you scanned]

### Key Existing Code Found
- [List relevant classes/scripts found]
- [Note patterns, conventions, namespaces]

### Existing Assets
- [Prefabs, ScriptableObjects, Scenes found]

### Recommendations for Analysts
- [Suggest areas analysts should focus on]
- [Note potential conflicts or considerations]

CONTEXT_EOF

# IMPORTANT: Also save structured context to persistent directory
cat > "${persistentDir}/project_structure.md" << 'STRUCTURE_EOF'
# Project Structure Index
Updated: $(date -u +%Y-%m-%dT%H:%M:%SZ)

## Scripts
[List all scripts you found with their purposes]

## Prefabs
[List all prefabs with their purposes]

## ScriptableObjects
[List all SOs with their purposes]

## Scenes
[List all scenes]

## Key Patterns & Conventions
[Document naming conventions, folder structure, code patterns]

STRUCTURE_EOF
\`\`\`

## Step 6: Discover and Catalog Assets
**CRITICAL**: When the requirement mentions required assets (sprites, textures, UI elements, sounds), you MUST discover and catalog ALL suitable assets.

### 6a. Search for assets matching the requirement
\`\`\`bash
# Search for common asset types
find Assets -name "*.png" -o -name "*.jpg" -o -name "*.psd" -o -name "*.tga" 2>/dev/null | head -100
find Assets -name "*.wav" -o -name "*.mp3" -o -name "*.ogg" 2>/dev/null | head -50
find Assets -name "*.mat" -o -name "*.shader" 2>/dev/null | head -30
\`\`\`

### 6b. Use Unity MCP to get detailed asset info
For each relevant asset found, get its metadata:
\`\`\`
mcp_unityMCP_manage_asset({ action: 'get_info', path: 'Assets/Path/To/Asset.png', generate_preview: false })
\`\`\`

### 6c. Create/Update the Assets Catalog
Write detailed asset information to the persistent assets catalog:
\`\`\`bash
cat > "${persistentDir}/assets_catalog.md" << 'ASSETS_EOF'
# Assets Catalog
Updated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
This catalog contains detailed information about project assets for task reference.

## Sprites & Textures

### [Asset Name]
- **Path**: \`Assets/Path/To/Asset.png\`
- **Type**: Sprite / Texture2D / Sprite Sheet
- **Dimensions**: [width] x [height] px
- **Import Settings**:
  - Texture Type: Sprite (2D and UI) / Default / etc.
  - Sprite Mode: Single / Multiple (sheet)
  - Pixels Per Unit: [value]
  - Filter Mode: Point / Bilinear / Trilinear
  - Compression: None / Normal / High
- **Nine-Slice**: [Yes/No - if yes, include borders: L, R, T, B]
- **Sprite Sheet Info** (if applicable):
  - Grid Size: [cell width] x [cell height]
  - Sprite Count: [number of sprites]
  - Named Sprites: [list sprite names]
- **Usage Notes**: [What this asset is suitable for]
- **Color/Style**: [Brief description of visual style]

### [Next Asset...]
...

## UI Elements

### [UI Asset Name]
- **Path**: \`Assets/UI/Element.png\`
- **Type**: UI Sprite
- **Dimensions**: [width] x [height] px
- **Nine-Slice**: [borders if applicable]
- **Suitable For**: [buttons, panels, frames, etc.]

## Audio

### [Sound Name]
- **Path**: \`Assets/Audio/Sound.wav\`
- **Type**: SFX / Music / Ambient
- **Duration**: [seconds]
- **Format**: WAV / MP3 / OGG
- **Sample Rate**: [Hz]
- **Channels**: Mono / Stereo

## 3D Models & Prefabs

### [Model/Prefab Name]
- **Path**: \`Assets/Models/Thing.fbx\` or \`Assets/Prefabs/Thing.prefab\`
- **Type**: Static Mesh / Animated / Prefab
- **Poly Count**: [approximate]
- **Materials**: [list materials used]
- **Suitable For**: [gems, obstacles, decorations, etc.]

## Asset Pack Summary

### [Pack Name] (e.g., "PolygonStarter")
- **Location**: \`Assets/PackName/\`
- **Contents**: [Brief description]
- **Suitable Assets for Current Requirement**:
  - \`SubPath/Asset1\` - Could be used for [purpose]
  - \`SubPath/Asset2\` - Could be used for [purpose]

## Placeholder Recommendations

If suitable assets are not found, recommend placeholders:
- **Gem Sprites**: Use Unity primitives (Sphere/Cube) with colored materials, or generate placeholder sprites
- **UI Elements**: Use Unity UI default sprites, or simple shapes
- **Sound Effects**: Note that placeholder sounds are needed

ASSETS_EOF
\`\`\`

### 6d. Link assets to requirements
When the plan mentions specific assets needed (e.g., "Gem sprites (5 colors)"), explicitly:
1. Search for matching assets
2. Document what was found vs what's missing
3. Suggest alternatives or placeholders
4. Update the catalog with "Recommended For: [Task ID]" tags

## Step 7: Continue Running
After prescan, keep running. Read the debate file periodically and gather more context as needed.

BEGIN PRESCAN NOW. Analyze the requirement and start gathering context.
${hasExistingContext ? '\n**REMEMBER**: Focus on CHANGES and NEW files. Skip already-documented items.' : ''}
`;
        } else if (phase === 'task_review') {
            return `# Context Gatherer Agent - Phase 3: Task Review
Model: gemini-3-pro
Role: Gather specific context for each identified task

The analysts have finished debating. Now review each task and gather specific context.

## Requirement
${requirement}

---

# YOUR TASK

## Step 1: Read the Debate Results
\`\`\`bash
cat ${path.join(this.debateDir, 'debate_*.md')} 2>/dev/null | tail -500
\`\`\`

## Step 2: Gather Context for ALL Tasks (PARALLEL)
Run gather_task_context.sh for ALL tasks at once using parallel execution:

\`\`\`bash
# Run all task-specific context gathering in parallel:
# (Adjust folders based on tasks you found in debate)

# Task 1 context:
bash _AiDevLog/Scripts/gather_task_context.sh [TASK1_FOLDER] [TYPE] "[TASK1_DESC]" --docs ${docsParam} &

# Task 2 context:
bash _AiDevLog/Scripts/gather_task_context.sh [TASK2_FOLDER] [TYPE] "[TASK2_DESC]" --docs ${docsParam} &

# Task 3 context:
bash _AiDevLog/Scripts/gather_task_context.sh [TASK3_FOLDER] [TYPE] "[TASK3_DESC]" --docs ${docsParam} &

# Wait for all
wait
\`\`\`

Then use Unity MCP for specific assets mentioned in tasks:
\`\`\`
mcp_unityMCP_manage_asset({ action: 'get_info', path: '[SPECIFIC_ASSET_PATH]' })
mcp_unityMCP_manage_asset({ action: 'get_components', path: '[PREFAB_PATH]' })
\`\`\`

## Step 3: Check and Update Assets Catalog
For tasks that require assets (sprites, sounds, UI elements, etc.):

### 3a. Read existing assets catalog
\`\`\`bash
cat "${persistentDir}/assets_catalog.md" 2>/dev/null || echo "No assets catalog found - will create one"
\`\`\`

### 3b. Search for task-specific assets
For each task that mentions assets, search and catalog them:
\`\`\`
mcp_unityMCP_manage_asset({ action: 'search', path: 'Assets', search_pattern: '[RELEVANT_PATTERN]' })
mcp_unityMCP_manage_asset({ action: 'get_info', path: '[FOUND_ASSET_PATH]', generate_preview: false })
\`\`\`

### 3c. Update assets catalog with task references
\`\`\`bash
# Append new assets and task references to catalog
cat >> "${persistentDir}/assets_catalog.md" << 'TASK_ASSETS_EOF'

## Task-Specific Asset Mappings

### Task: [Task Name/ID]
**Required Assets:**
- [What the task needs]

**Matched Assets:**
- \`Assets/Path/To/Asset1.png\` - [Why it's suitable]
  - Dimensions: [WxH], Type: [Sprite/Texture]
- \`Assets/Path/To/Asset2.wav\` - [Why it's suitable]
  - Duration: [Xs], Format: [WAV/MP3]

**Missing Assets (Need Placeholders):**
- [Asset type needed] - Suggest: [placeholder approach]

TASK_ASSETS_EOF
\`\`\`

## Step 4: Write Task-Specific Context
\`\`\`bash
cat >> ${contextFile} << 'TASK_CONTEXT_EOF'

## TASK-SPECIFIC CONTEXT

### Task: [Task Name]
**Relevant Code Found:**
- [List specific files that relate to this task]

**Existing Patterns to Follow:**
- [Patterns from existing code]

**Dependencies Identified:**
- [What this task depends on]

**Required Assets:**
- See: \`_AiDevLog/Context/assets_catalog.md\` → [Section Reference]
- [List specific assets this task should use]

**Suggested Implementation Approach:**
- [Based on existing code patterns]

### Task: [Next Task]
...

TASK_CONTEXT_EOF
\`\`\`

BEGIN TASK REVIEW NOW.
`;
        } else {
            // during_debate
            return `# Context Gatherer Agent - Phase 2: Continuous Gathering
Model: gemini-3-pro
Role: Continue gathering context while analysts debate

The analysts are debating. Continue gathering broader context.

## Step 1: Check What Analysts Are Discussing
\`\`\`bash
cat ${path.join(this.debateDir, 'debate_*.md')} 2>/dev/null | tail -200
\`\`\`

## Step 2: Gather Context for Topics They Mention
If analysts mention a topic you haven't covered, gather context for it.

## Step 3: Append New Findings
\`\`\`bash
cat >> ${contextFile} << 'ADDITIONAL_EOF'

## ADDITIONAL CONTEXT (gathered during debate)

[Your new findings]

ADDITIONAL_EOF
\`\`\`

Keep running until the debate completes.
`;
        }
    }

    /**
     * Run Context Gatherer agent in background
     */
    private runContextGathererAgent(
        processId: string,
        prompt: string,
        contextFile: string,
        onProgress?: (message: string) => void
    ): void {
        // Write prompt to /tmp to avoid command line length issues (and keep project clean)
        const promptFile = `/tmp/apc_context_gatherer_${Date.now()}.txt`;
        fs.writeFileSync(promptFile, prompt);
        
        // Run via shell, piping prompt from file (same pattern as run_engineer.sh)
        const shellCmd = `cat "${promptFile}" | cursor agent --model "gemini-3-pro" -p --force --approve-mcps --output-format stream-json --stream-partial-output; rm -f "${promptFile}"`;
        
        onProgress?.(`[Context Gatherer] 📄 Prompt saved (${prompt.length} chars), starting agent...`);
        
        const proc = spawn('bash', ['-c', shellCmd], {
            cwd: this.workspaceRoot,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env }
        });

        this.activeProcesses.set(processId, proc);

        let chunkCount = 0;
        let lastProgressTime = Date.now();

        proc.stdout?.on('data', (data) => {
            const text = data.toString();
            chunkCount++;
            const lines = text.split('\n').filter((l: string) => l.trim());
            
            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line);
                    const msgType = parsed?.type;
                    
                    // type="thinking" with text at top level
                    if (msgType === 'thinking' && parsed?.text) {
                        const now = Date.now();
                        if (now - lastProgressTime > 5000) {
                            onProgress?.(`[Context Gatherer] 💭 ${parsed.text.substring(0, 80).replace(/\n/g, ' ')}...`);
                            lastProgressTime = now;
                        }
                    }
                    
                    // type="assistant" with message.content
                    else if (msgType === 'assistant' && parsed?.message?.content) {
                        for (const item of parsed.message.content) {
                            if (item?.type === 'text' && item?.text) {
                                const now = Date.now();
                                if (now - lastProgressTime > 3000 ||
                                    item.text.includes('gather_task_context') ||
                                    item.text.includes('Found')) {
                                    onProgress?.(`[Context Gatherer] 📂 ${item.text.substring(0, 80).replace(/\n/g, ' ')}`);
                                    lastProgressTime = now;
                                }
                            } else if (item?.type === 'tool_use') {
                                onProgress?.(`[Context Gatherer] 🔧 Tool: ${item.name || 'unknown'}`);
                            }
                        }
                    }
                    
                    // type="tool_use" at top level
                    else if (msgType === 'tool_use' && parsed?.name) {
                        onProgress?.(`[Context Gatherer] 🔧 Tool: ${parsed.name}`);
                    }
                    
                    // type="result" - final
                    else if (msgType === 'result' && parsed?.result) {
                        onProgress?.(`[Context Gatherer] 📋 Result (${parsed.result.length} chars)`);
                    }
                    
                } catch {
                    // Not JSON - check for interesting raw output
                    if (line.includes('Analyzing') || line.includes('Reading') || line.includes('Found')) {
                        onProgress?.(`[Context Gatherer] 📄 ${line.substring(0, 80)}`);
                    }
                }
            }
        });

        // Heartbeat for context gatherer - every 15 seconds
        let elapsedSeconds = 0;
        const heartbeat = setInterval(() => {
            if (this.activeProcesses.has(processId)) {
                elapsedSeconds += 15;
                const mins = Math.floor(elapsedSeconds / 60);
                const secs = elapsedSeconds % 60;
                const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
                onProgress?.(`[Context Gatherer] 💓 Scanning... (${timeStr}, ${chunkCount} chunks received)`);
            } else {
                clearInterval(heartbeat);
            }
        }, 15000);

        proc.on('close', (code) => {
            clearInterval(heartbeat);
            this.activeProcesses.delete(processId);
            if (this.contextGatherer) {
                this.contextGatherer.status = code === 0 ? 'completed' : 'failed';
            }
            
            // CONSOLIDATE: Copy context from temp to persistent folder
            this.consolidateContextToPersistent(contextFile, onProgress);
            
            onProgress?.(`[Context Gatherer] ${code === 0 ? '✅ Completed' : '⚠️ Exited'} (${chunkCount} chunks)`);
        });

        proc.on('error', (err) => {
            this.activeProcesses.delete(processId);
            if (this.contextGatherer) {
                this.contextGatherer.status = 'failed';
            }
            onProgress?.(`[Context Gatherer] ❌ Error: ${err.message}`);
        });

        // Timeout after 15 minutes for prescan (large projects need time)
        // Don't kill - just log. Context gathering continues during debate.
        setTimeout(() => {
            if (this.activeProcesses.has(processId)) {
                onProgress?.(`[Context Gatherer] ⏰ 15min prescan checkpoint - still running in background`);
            }
        }, 900000); // 15 minutes
    }

    /**
     * Consolidate context from temp folder to persistent Context folder
     * This extracts task-specific context and updates the master files
     */
    private consolidateContextToPersistent(
        contextFile: string, 
        onProgress?: (message: string) => void
    ): void {
        try {
            if (!fs.existsSync(contextFile)) {
                onProgress?.(`[Context] ⚠️ No context file to consolidate`);
                return;
            }

            const content = fs.readFileSync(contextFile, 'utf-8');
            onProgress?.(`[Context] 📦 Consolidating ${content.length} chars to persistent storage...`);

            // Extract task-specific context sections
            const taskSections = content.match(/### Task:[\s\S]*?(?=### Task:|---\n|$)/g) || [];
            
            if (taskSections.length > 0) {
                // Write consolidated task context to persistent folder
                const taskContextPath = path.join(this.persistentContextDir, 'task_context.md');
                const header = `# Task-Specific Context Index
Updated: ${new Date().toISOString()}
Consolidated from context gathering sessions.

---

`;
                // Append to existing or create new
                if (fs.existsSync(taskContextPath)) {
                    // Read existing and merge (avoid duplicates)
                    const existing = fs.readFileSync(taskContextPath, 'utf-8');
                    const newTasks = taskSections.filter(section => {
                        const taskName = section.match(/### Task: ([^\n]+)/)?.[1] || '';
                        return taskName && !existing.includes(`### Task: ${taskName}`);
                    });
                    
                    if (newTasks.length > 0) {
                        fs.appendFileSync(taskContextPath, '\n' + newTasks.join('\n'));
                        onProgress?.(`[Context] ✅ Added ${newTasks.length} new task sections to task_context.md`);
                    } else {
                        onProgress?.(`[Context] ℹ️ No new task sections (${taskSections.length} already exist)`);
                    }
                } else {
                    fs.writeFileSync(taskContextPath, header + taskSections.join('\n'));
                    onProgress?.(`[Context] ✅ Created task_context.md with ${taskSections.length} tasks`);
                }
            }

            // Extract and update project structure if mentioned
            const structureMatch = content.match(/## Project Structure[\s\S]*?(?=##|$)/);
            if (structureMatch) {
                const structurePath = path.join(this.persistentContextDir, 'project_structure.md');
                const existingStructure = fs.existsSync(structurePath) ? 
                    fs.readFileSync(structurePath, 'utf-8') : '';
                
                // Only update if content is more substantial
                if (structureMatch[0].length > existingStructure.length + 100) {
                    fs.writeFileSync(structurePath, `# Project Structure Index
Updated: ${new Date().toISOString()}

${structureMatch[0]}
`);
                    onProgress?.(`[Context] ✅ Updated project_structure.md`);
                }
            }

            // Extract and consolidate asset information
            const assetMatch = content.match(/## Assets?[\s\S]*?(?=##|$)/gi);
            if (assetMatch && assetMatch.length > 0) {
                const assetsPath = path.join(this.persistentContextDir, 'assets_catalog.md');
                const assetContent = assetMatch.join('\n\n');
                
                if (!fs.existsSync(assetsPath)) {
                    fs.writeFileSync(assetsPath, `# Assets Catalog
Updated: ${new Date().toISOString()}

${assetContent}
`);
                    onProgress?.(`[Context] ✅ Created assets_catalog.md`);
                } else {
                    // Append new asset info
                    fs.appendFileSync(assetsPath, `\n\n## Session Update (${new Date().toISOString()})\n${assetContent}`);
                    onProgress?.(`[Context] ✅ Updated assets_catalog.md`);
                }
            }

            // Update the context index with a session entry
            const sessionId = contextFile.match(/context_(\d+)\.md/)?.[1] || 'unknown';
            this.updateContextEntry({
                path: `session_${sessionId}`,
                type: 'session',
                summary: content.substring(0, 200).replace(/\n/g, ' '),
                keywords: content.match(/Task:\s*([^\n]+)/g)?.slice(0, 10) || []
            });
            
            onProgress?.(`[Context] ✅ Consolidation complete - see _AiDevLog/Context/`);

        } catch (error) {
            onProgress?.(`[Context] ❌ Consolidation failed: ${error}`);
        }
    }

    /**
     * Run task review phase after debate completes
     */
    async runTaskReview(
        sessionId: number,
        requirement: string,
        docs: string[],
        tasks: Array<{ name: string; files: string[] }>,
        onProgress?: (message: string) => void
    ): Promise<string> {
        if (!this.isCursorAvailable()) {
            onProgress?.('⚠️ Cursor CLI not available for task review');
            return '';
        }

        const contextFile = this.contextGatherer?.contextFile || 
            path.join(this.contextDir, `context_${sessionId}.md`);

        onProgress?.(`\n🔍 Starting Task Review Phase...`);
        onProgress?.(`   Reviewing ${tasks.length} tasks for specific context...`);

        // Append task list to context file
        fs.appendFileSync(contextFile, `
---
# TASK REVIEW PHASE
Started: ${new Date().toISOString()}

## Tasks to Review
${tasks.map((t, i) => `${i + 1}. ${t.name}\n   Files: ${t.files.join(', ')}`).join('\n')}

`);

        const prompt = this.buildContextGathererPrompt(requirement, docs, contextFile, 'task_review');
        const processId = `task_review_${sessionId}`;

        return new Promise((resolve) => {
            // Write prompt to /tmp to avoid command line length issues (and keep project clean)
            const promptFile = `/tmp/apc_task_review_${Date.now()}.txt`;
            fs.writeFileSync(promptFile, prompt);
            
            // Run via shell, piping prompt from file
            const shellCmd = `cat "${promptFile}" | cursor agent --model "gemini-3-pro" -p --force --approve-mcps --output-format stream-json --stream-partial-output; rm -f "${promptFile}"`;
            
            onProgress?.(`[Task Review] 📄 Prompt saved (${prompt.length} chars), starting agent...`);
            
            const proc = spawn('bash', ['-c', shellCmd], {
                cwd: this.workspaceRoot,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env }
            });

            this.activeProcesses.set(processId, proc);

            let chunkCount = 0;
            let lastProgressTime = Date.now();

            proc.stdout?.on('data', (data) => {
                const text = data.toString();
                chunkCount++;
                const lines = text.split('\n').filter((l: string) => l.trim());
                
                for (const line of lines) {
                    try {
                        const parsed = JSON.parse(line);
                        const msgType = parsed?.type;
                        const content = parsed?.message?.content?.[0];
                        
                        // Handle thinking type
                        if (msgType === 'thinking' && parsed?.text) {
                            const now = Date.now();
                            if (now - lastProgressTime > 5000) {
                                onProgress?.(`[Task Review] 💭 ${parsed.text.substring(0, 60).replace(/\n/g, ' ')}...`);
                                lastProgressTime = now;
                            }
                        }
                        // Handle tool use
                        else if (msgType === 'tool_use' && parsed?.name) {
                            onProgress?.(`[Task Review] 🔧 Tool: ${parsed.name}`);
                            lastProgressTime = Date.now();
                        }
                        // Handle assistant content
                        else if (content?.type === 'text' && content?.text) {
                            if (content.text.includes('Task:') || content.text.includes('gather_task_context') ||
                                content.text.includes('Found') || content.text.includes('Analyzing')) {
                                onProgress?.(`[Task Review] 📋 ${content.text.substring(0, 60).replace(/\n/g, ' ')}...`);
                                lastProgressTime = Date.now();
                            }
                        } else if (content?.type === 'tool_use' && content?.name) {
                            onProgress?.(`[Task Review] 🔧 ${content.name}`);
                            lastProgressTime = Date.now();
                        }
                    } catch {
                        // Not JSON - check for raw output
                        if (line.includes('Task') || line.includes('Analyzing') || line.includes('Found')) {
                            onProgress?.(`[Task Review] 📄 ${line.substring(0, 60)}`);
                        }
                    }
                }
            });

            // Heartbeat for task review - every 15 seconds
            let elapsedSeconds = 0;
            const heartbeat = setInterval(() => {
                if (this.activeProcesses.has(processId)) {
                    elapsedSeconds += 15;
                    const mins = Math.floor(elapsedSeconds / 60);
                    const secs = elapsedSeconds % 60;
                    const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
                    onProgress?.(`[Task Review] 💓 Reviewing tasks... (${timeStr}, ${chunkCount} chunks)`);
                } else {
                    clearInterval(heartbeat);
                }
            }, 15000);

            proc.on('close', (code) => {
                clearInterval(heartbeat);
                this.activeProcesses.delete(processId);
                
                // Consolidate task review context to persistent folder
                this.consolidateContextToPersistent(contextFile, onProgress);
                
                onProgress?.(`[Task Review] ${code === 0 ? '✅ Complete' : '⚠️ Finished'} (${chunkCount} chunks)`);
                resolve(contextFile);
            });

            proc.on('error', (err) => {
                clearInterval(heartbeat);
                this.activeProcesses.delete(processId);
                onProgress?.(`[Task Review] ❌ Error: ${err.message}`);
                resolve(contextFile);
            });

            // Timeout after 10 minutes for task review (needs time for each task)
            setTimeout(() => {
                if (this.activeProcesses.has(processId)) {
                    proc.kill();
                    this.activeProcesses.delete(processId);
                    onProgress?.(`[Task Review] ⏰ 10min timeout reached`);
                    resolve(contextFile);
                }
            }, 600000); // 10 minutes
        });
    }

    /**
     * Get gathered context from Context Gatherer
     */
    getGatheredContext(): string {
        if (this.contextGatherer?.contextFile && fs.existsSync(this.contextGatherer.contextFile)) {
            return fs.readFileSync(this.contextGatherer.contextFile, 'utf-8');
        }
        return '';
    }

    /**
     * Stop Context Gatherer
     */
    stopContextGatherer(): void {
        if (this.contextGatherer?.processId) {
            const proc = this.activeProcesses.get(this.contextGatherer.processId);
            if (proc) {
                proc.kill();
                this.activeProcesses.delete(this.contextGatherer.processId);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ANALYST AGENTS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Build the analyst prompt for a Cursor agent session
     * This prompt enables the agent to:
     * - Call Unity MCP tools for project inspection
     * - Run gather_task_context.sh for codebase analysis
     * - Read the PLAN FILE to see other analysts' contributions
     * - Write their analysis directly to the PLAN FILE using file locking
     */
    buildAnalystPrompt(
        analyst: AnalystConfig,
        requirement: string,
        docs: string[],
        planFile: string,  // Changed from debateFile to planFile
        contextSummary: string
    ): string {
        const docsParam = docs.map(d => d.replace('_AiDevLog/Docs/', '')).join(',');
        
        // Determine the section marker for this analyst
        const sectionMarker = analyst.id === 'opus' ? '🏗️ Opus Analyst' :
                             analyst.id === 'codex' ? '⚡ Codex Analyst' :
                             '🧪 Gemini Analyst';
        
        return `# Planning Analyst Session: ${analyst.name}
Role: ${analyst.role}
Model: ${analyst.model}

You are one of THREE analysts working together to create an execution plan for a Unity game development project.
Your specialty is: **${analyst.role}**

## IMPORTANT: Direct Plan Editing
You will write your analysis DIRECTLY into the plan file: \`${planFile}\`
Use file locking to avoid conflicts with other analysts editing simultaneously.

---

## Your Task
Analyze the requirement and contribute your expertise directly to the plan.

## Requirement
${requirement}

## Provided Documentation
${docs.map(d => `- ${d}`).join('\n')}

## Initial Context Summary
${contextSummary}

---

# WORKFLOW - Follow These Steps

## Step 1: Gather Additional Context (REQUIRED)
You MUST use Unity MCP tools and context gathering scripts to understand the project.

### Unity MCP Tools - Call These:
\`\`\`
mcp_unityMCP_manage_editor({ action: 'get_state' })     // Get Unity Editor state
mcp_unityMCP_manage_scene({ action: 'get_hierarchy' })  // Get active scene structure
mcp_unityMCP_manage_asset({ action: 'search', path: 'Assets/Scripts', search_pattern: '*.cs' })  // Find scripts
mcp_unityMCP_read_console({ types: ['error', 'warning'], count: '20' })  // Check console
\`\`\`

### Context Gathering Script - Run MULTIPLE in PARALLEL:
\`\`\`bash
# Run all relevant context gathering at once (use & for parallel):
bash _AiDevLog/Scripts/gather_task_context.sh Assets/Scripts cs "Core scripts" --docs ${docsParam} &
bash _AiDevLog/Scripts/gather_task_context.sh Assets/Prefabs prefab "Game prefabs" --docs ${docsParam} &
bash _AiDevLog/Scripts/gather_task_context.sh Assets/ScriptableObjects asset "Data files" --docs ${docsParam} &

# Wait for all parallel jobs
wait
echo "Context gathering complete"
\`\`\`

### Assets Catalog - Check for required assets:
\`\`\`bash
# Read the persistent assets catalog for sprites, sounds, UI elements:
cat _AiDevLog/Context/assets_catalog.md 2>/dev/null || echo "Assets catalog not yet created"
\`\`\`

**IMPORTANT for Asset-Related Tasks:**
When a task requires sprites, textures, sounds, or UI elements:
1. Check \`_AiDevLog/Context/assets_catalog.md\` for existing suitable assets
2. Reference specific asset paths in your task definitions
3. If assets are missing, note this and suggest placeholders
4. Include asset dimensions, types, and import settings in your analysis

**Call these NOW. Wait for all to complete before proceeding.**

## Step 2: Read the Current Plan
Read the plan file to see the requirement and other analysts' contributions:
\`\`\`bash
cat "${planFile}"
\`\`\`

## Step 3: Write Your Analysis to the Plan

First, create your analysis content in a temp file:
\`\`\`bash
cat > /tmp/${analyst.id}_analysis.md << 'ANALYSIS_EOF'
**Status:** ✅ Complete

#### Context Gathered
- [What you discovered from Unity MCP and gather_task_context.sh]
- [Reference specific files, classes, or assets found]

#### Concerns (${analyst.role} perspective)
- [Your concerns from your specialty viewpoint]
- [Reference actual code/assets you found]

#### Recommendations  
- [Actionable recommendations with specifics]
- [File paths, class names, method signatures]

#### Tasks I Identify

**Task: [Task Name 1]**
- Files: \`Assets/Scripts/Path/File.cs\`, \`Assets/Prefabs/Thing.prefab\`
- Dependencies: [None | Task names this depends on]
- Required Assets: [None | Reference from \`_AiDevLog/Context/assets_catalog.md\`]
  - Example: \`Assets/Sprites/Gems/Gem_Red.png\` (64x64 sprite, PNG)
- Tests: \`TestClassName.cs\`: TestMethod1, TestMethod2
- Best Practice: [Specific Unity best practice to follow]

**Task: [Task Name 2]**
- Files: ...
- Dependencies: ...
- Required Assets: ...
- Tests: ...
- Best Practice: ...

#### Engineer Vote
- Count: [number]
- Rationale: [Why this number based on task parallelism]

#### Response to Other Analysts
- [If you read other analysts' findings, respond here]
- [Agree/disagree with specific points]

ANALYSIS_EOF
\`\`\`

Then, use file locking to safely update the plan file:
\`\`\`bash
(
  flock -x 200
  
  # Read current plan
  PLAN_CONTENT=$(cat "${planFile}")
  
  # Find and replace your section (between your header and the next ---)
  # Your section is marked with "${sectionMarker}"
  
  # Read your analysis
  MY_ANALYSIS=$(cat /tmp/${analyst.id}_analysis.md)
  
  # Use sed to replace your section
  # The section starts after "### ${sectionMarker}" and ends before the next "---"
  python3 << PYEOF
import re

plan_path = "${planFile}"
with open(plan_path, 'r') as f:
    content = f.read()

# Pattern to find this analyst's section
pattern = r'(### ${sectionMarker}.*?\\n\\*\\*Status:\\*\\* ⏳ Analyzing\\.\\.\\.\\n\\n)_Analysis pending\\.\\.\\._'

# Read the analysis file
with open('/tmp/${analyst.id}_analysis.md', 'r') as f:
    analysis = f.read()

# Replace the placeholder with actual analysis
replacement = r'\\1' + analysis.replace('\\\\', '\\\\\\\\').replace('\\n', '\\\\n')
new_content = re.sub(pattern, replacement, content, flags=re.DOTALL)

if new_content == content:
    # Fallback: append to the end of analyst section if pattern didn't match
    section_pattern = r'(### ${sectionMarker}.*?)(\\n---\\n### |\\n<!-- ANALYST_SECTION_END -->)'
    new_content = re.sub(section_pattern, r'\\1\\n' + analysis + r'\\2', content, flags=re.DOTALL)

with open(plan_path, 'w') as f:
    f.write(new_content)

print("Plan updated successfully")
PYEOF

) 200>"${planFile}.lock"
\`\`\`

## Step 4: Add Tasks to Task Table
Also add your identified tasks to the Task Breakdown table:
\`\`\`bash
(
  flock -x 200
  
  python3 << 'PYEOF'
import re

plan_path = "${planFile}"
with open(plan_path, 'r') as f:
    content = f.read()

# Your tasks to add (replace with actual tasks you identified)
new_tasks = """| T1 | [Your Task 1 Name] | [Dependencies] | [Files] | [Tests] |
| T2 | [Your Task 2 Name] | [Dependencies] | [Files] | [Tests] |"""

# Find the task table and add rows
# Pattern matches the TBD row
pattern = r'(\\| _TBD_ \\| _Analysts identifying tasks\\.\\.\\._ \\| _TBD_ \\| _TBD_ \\| _TBD_ \\|)'

# Add new tasks before or replace the TBD row
if '| _TBD_ |' in content:
    new_content = content.replace(
        '| _TBD_ | _Analysts identifying tasks..._ | _TBD_ | _TBD_ | _TBD_ |',
        new_tasks
    )
else:
    # Append to existing tasks
    table_end = content.find('\\n---\\n\\n## 6. Consensus')
    if table_end > 0:
        new_content = content[:table_end] + '\\n' + new_tasks + content[table_end:]
    else:
        new_content = content

with open(plan_path, 'w') as f:
    f.write(new_content)
PYEOF

) 200>"${planFile}.lock"
\`\`\`

## Step 5: Read Updated Plan & Respond
After writing, read the full plan again to see other analysts' contributions:
\`\`\`bash
cat "${planFile}"
\`\`\`

If you have responses to other analysts, append to your section using the same locking pattern.

---

# IMPORTANT GUIDELINES

1. **Call real tools**: You MUST invoke Unity MCP and gather_task_context.sh - don't skip this
2. **Use file locking**: ALWAYS use flock when writing to the plan file
3. **Focus on ${analyst.role}**: That's your specialty
4. **Be specific**: Reference actual files, classes, methods you found
5. **Unity best practices to consider**:
   - MonoBehaviour vs pure C# (attach to GO vs logic-only)
   - NEVER create .meta files manually
   - UI Canvas in prefabs, reusable widgets  
   - ScriptableObject builders for scene/UI generation
   - Use Unity Test Framework (EditMode + PlayMode tests)
6. **Debate constructively**: Respond to other analysts by name

BEGIN YOUR ANALYSIS NOW. Start by calling Unity MCP and gather_task_context.sh.
`;
    }

    /**
     * Run the multi-agent debate with 3 Cursor CLI sessions
     * Agents write directly to the plan file using file locking
     * 
     * @param sessionId The planning session ID (e.g., "ps_001")
     * @param requirement The requirement text
     * @param docs Array of documentation paths
     * @param planFile Path to the plan file (agents write directly to this)
     * @param contextSummary Initial context summary
     * @param onProgress Progress callback
     */
    async runMultiAgentDebate(
        sessionId: string,
        requirement: string,
        docs: string[],
        planFile: string,
        contextSummary: string,
        onProgress?: (message: string) => void
    ): Promise<AgentAnalysis[]> {
        if (!this.isCursorAvailable()) {
            onProgress?.('⚠️ Cursor CLI not available. Using fallback analysis.');
            return [this.getMockAnalysis(requirement)];
        }

        // Create plan skeleton if it doesn't exist
        if (!fs.existsSync(planFile)) {
            onProgress?.(`📄 Creating plan skeleton: ${planFile}`);
            this.createPlanSkeleton(sessionId, requirement, docs, planFile);
        }

        onProgress?.(`🎯 Starting multi-agent debate`);
        onProgress?.(`📁 Plan file: ${planFile}`);
        onProgress?.(`📝 Agents will write directly to the plan using file locking`);

        // Phase 1: Run all 3 analysts in parallel - they write to plan file
        onProgress?.(`\n═══════════════════════════════════════════`);
        onProgress?.(`  PHASE 1: PARALLEL ANALYSIS (3 agents)`);
        onProgress?.(`═══════════════════════════════════════════`);

        const analystPromises = ANALYST_CONFIGS.map(analyst => 
            this.runAnalystSession(analyst, requirement, docs, planFile, contextSummary, onProgress)
        );

        // Wait for all analysts to complete
        await Promise.all(analystPromises);

        // Phase 2: Read plan file and extract analyses
        onProgress?.(`\n═══════════════════════════════════════════`);
        onProgress?.(`  PHASE 2: READING PLAN FILE RESULTS`);
        onProgress?.(`═══════════════════════════════════════════`);

        const planContent = fs.readFileSync(planFile, 'utf-8');
        onProgress?.(`📄 Plan file size: ${planContent.length} chars`);

        // Parse the plan file sections into individual analyses
        const analyses = this.parsePlanFileAnalyses(planContent);
        
        onProgress?.(`📊 Parsed ${analyses.length} analyst contributions`);

        // Phase 3: Build consensus and update plan
        onProgress?.(`\n═══════════════════════════════════════════`);
        onProgress?.(`  PHASE 3: BUILDING CONSENSUS`);
        onProgress?.(`═══════════════════════════════════════════`);

        const consensus = this.buildConsensus(analyses, onProgress);

        // Update the plan file with consensus
        this.updatePlanWithConsensus(planFile, analyses, consensus, onProgress);
        onProgress?.(`📝 Plan updated with consensus`);

        // Phase 5: Cleanup - delete shared debate file
        onProgress?.(`\n═══════════════════════════════════════════`);
        onProgress?.(`  PHASE 4: UPDATING PLAN STATUS`);
        onProgress?.(`═══════════════════════════════════════════`);

        // Update plan status from PLANNING to REVIEW
        try {
            let content = fs.readFileSync(planFile, 'utf-8');
            content = content.replace(
                '**Status:** 🔄 PLANNING (agents debating)',
                '**Status:** 📋 REVIEW (debate complete, awaiting approval)'
            );
            fs.writeFileSync(planFile, content);
            onProgress?.(`✅ Plan status updated to REVIEW`);
        } catch (e) {
            onProgress?.(`⚠️ Could not update plan status: ${e}`);
        }

        // Delete lock file if exists
        const lockFile = `${planFile}.lock`;
        if (fs.existsSync(lockFile)) {
            try {
                fs.unlinkSync(lockFile);
            } catch { /* ignore */ }
        }

        onProgress?.(`\n✅ Multi-agent debate complete!`);
        onProgress?.(`📄 Plan file ready for review: ${planFile}`);

        return analyses;
    }

    /**
     * Parse analyst contributions from the plan file
     * Each analyst's section is between their header and the next ---
     */
    private parsePlanFileAnalyses(planContent: string): AgentAnalysis[] {
        const analyses: AgentAnalysis[] = [];

        for (const analyst of ANALYST_CONFIGS) {
            const sectionMarker = analyst.id === 'opus' ? '🏗️ Opus Analyst' :
                                  analyst.id === 'codex' ? '⚡ Codex Analyst' :
                                  '🧪 Gemini Analyst';
            
            // Find section for this analyst
            const sectionPattern = new RegExp(
                `### ${sectionMarker}.*?\\n([\\s\\S]*?)(?=\\n---\\n|$)`,
                'i'
            );
            
            const match = planContent.match(sectionPattern);
            if (match && match[1]) {
                const sectionContent = match[1];
                
                // Check if analysis was completed (not just "Analysis pending...")
                if (sectionContent.includes('_Analysis pending..._')) {
                    continue;
                }

                // Parse the section content
                const analysis: AgentAnalysis = {
                    agentName: analyst.name,
                    model: analyst.model,
                    role: analyst.role,
                    concerns: this.extractListItems(sectionContent, 'Concerns'),
                    recommendations: this.extractListItems(sectionContent, 'Recommendations'),
                    taskBreakdown: this.extractTasksFromSection(sectionContent),
                    engineerCount: this.extractEngineerCount(sectionContent),
                    rationale: this.extractEngineerRationale(sectionContent),
                    contextGathered: this.extractListItems(sectionContent, 'Context Gathered'),
                    rawOutput: sectionContent
                };

                analyses.push(analysis);
            }
        }

        // If no real analyses found, return a combined analysis placeholder
        if (analyses.length === 0) {
            analyses.push(this.getMockAnalysis(''));
        }

        return analyses;
    }

    /**
     * Extract list items from a section by heading
     */
    private extractListItems(content: string, heading: string): string[] {
        const pattern = new RegExp(`#### ${heading}[^\\n]*\\n([\\s\\S]*?)(?=####|$)`, 'i');
        const match = content.match(pattern);
        if (!match) return [];

        const items: string[] = [];
        const lines = match[1].split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
                items.push(trimmed.substring(1).trim());
            }
        }
        return items;
    }

    /**
     * Extract tasks from analyst section
     */
    private extractTasksFromSection(content: string): AgentAnalysis['taskBreakdown'] {
        const tasks: AgentAnalysis['taskBreakdown'] = [];
        
        // Pattern to find task blocks
        const taskPattern = /\*\*Task:\s*([^\*]+)\*\*\s*\n([\s\S]*?)(?=\*\*Task:|####|$)/gi;
        let match;
        
        while ((match = taskPattern.exec(content)) !== null) {
            const taskName = match[1].trim();
            const taskContent = match[2];
            
            const filesMatch = taskContent.match(/Files?:\s*(.+)/i);
            const depsMatch = taskContent.match(/Dependencies?:\s*(.+)/i);
            const testsMatch = taskContent.match(/Tests?:\s*(.+)/i);
            
            tasks.push({
                name: taskName,
                files: filesMatch ? filesMatch[1].split(',').map(f => f.trim()) : [],
                dependencies: depsMatch ? depsMatch[1].split(',').map(d => d.trim()) : [],
                tests: testsMatch ? testsMatch[1].split(',').map(t => t.trim()) : []
            });
        }
        
        return tasks;
    }

    /**
     * Extract engineer count from analyst section
     */
    private extractEngineerCount(content: string): number {
        const countMatch = content.match(/Count:\s*(\d+)/i);
        return countMatch ? parseInt(countMatch[1], 10) : 3;
    }

    /**
     * Extract engineer rationale from analyst section
     */
    private extractEngineerRationale(content: string): string {
        const rationaleMatch = content.match(/Rationale:\s*(.+)/i);
        return rationaleMatch ? rationaleMatch[1].trim() : 'Default based on task complexity';
    }

    /**
     * Update the plan file with consensus results
     */
    private updatePlanWithConsensus(
        planFile: string,
        analyses: AgentAnalysis[],
        consensus: ReturnType<typeof this.buildConsensus>,
        onProgress?: (message: string) => void
    ): void {
        let content = fs.readFileSync(planFile, 'utf-8');

        // Update Consensus section
        const consensusSection = `## 6. Consensus & Recommendations

**Status:** ✅ Complete

### Shared Concerns
${consensus.agreedConcerns.length > 0 
    ? consensus.agreedConcerns.map(c => `- ${c}`).join('\n')
    : '_No shared concerns identified_'}

### Agreed Recommendations  
${consensus.agreedRecommendations.length > 0
    ? consensus.agreedRecommendations.map(r => `- ${r}`).join('\n')
    : '_No agreed recommendations_'}`;

        // Replace the consensus section
        content = content.replace(
            /## 6\. Consensus & Recommendations[\s\S]*?(?=\n---\n\n## 7\.)/,
            consensusSection + '\n'
        );

        // Update Engineer Allocation
        const engineerSection = `## 8. Engineer Allocation

**Recommended:** ${consensus.engineerCount} engineers
**Rationale:** Based on ${analyses.length} analyst votes and task parallelism analysis`;

        content = content.replace(
            /## 8\. Engineer Allocation[\s\S]*?(?=\n---\n\n## 9\.)/,
            engineerSection + '\n'
        );

        fs.writeFileSync(planFile, content);
        onProgress?.(`  ✓ Updated consensus section`);
        onProgress?.(`  ✓ Updated engineer allocation: ${consensus.engineerCount} engineers`);
    }

    /**
     * Build consensus from analyst analyses
     */
    private buildConsensus(
        analyses: AgentAnalysis[],
        onProgress?: (message: string) => void
    ): {
        agreedConcerns: string[];
        agreedRecommendations: string[];
        mergedTasks: AgentAnalysis['taskBreakdown'];
        engineerCount: number;
        summary: string;
    } {
        // Count concern occurrences
        const concernCounts: Record<string, number> = {};
        for (const a of analyses) {
            for (const c of a.concerns) {
                const key = c.toLowerCase().substring(0, 50);
                concernCounts[key] = (concernCounts[key] || 0) + 1;
            }
        }

        // Count recommendation occurrences
        const recCounts: Record<string, { text: string; count: number }> = {};
        for (const a of analyses) {
            for (const r of a.recommendations) {
                const key = r.toLowerCase().substring(0, 50);
                if (!recCounts[key]) {
                    recCounts[key] = { text: r, count: 0 };
                }
                recCounts[key].count++;
            }
        }

        // Find agreed items (mentioned by 2+ analysts or all if only 1)
        const threshold = analyses.length > 1 ? 2 : 1;
        
        const agreedConcerns = analyses.flatMap(a => a.concerns)
            .filter(c => concernCounts[c.toLowerCase().substring(0, 50)] >= threshold);
        
        const agreedRecommendations = Object.values(recCounts)
            .filter(r => r.count >= threshold)
            .map(r => r.text);

        onProgress?.(`  ✓ ${agreedConcerns.length} concerns agreed by ${threshold}+ analysts`);
        onProgress?.(`  ✓ ${agreedRecommendations.length} recommendations agreed by ${threshold}+ analysts`);

        // Merge tasks (deduplicate by name)
        const taskMap = new Map<string, AgentAnalysis['taskBreakdown'][0]>();
        for (const a of analyses) {
            for (const t of a.taskBreakdown) {
                const key = t.name.toLowerCase();
                if (!taskMap.has(key)) {
                    taskMap.set(key, t);
                } else {
                    // Merge files, deps, tests
                    const existing = taskMap.get(key)!;
                    existing.files = [...new Set([...existing.files, ...t.files])];
                    existing.dependencies = [...new Set([...existing.dependencies, ...t.dependencies])];
                    existing.tests = [...new Set([...existing.tests, ...t.tests])];
                }
            }
        }
        const mergedTasks = Array.from(taskMap.values());
        onProgress?.(`  ✓ ${mergedTasks.length} unique tasks identified`);

        // Average engineer count
        const counts = analyses.map(a => a.engineerCount).filter(c => c > 0);
        const engineerCount = counts.length > 0 
            ? Math.round(counts.reduce((a, b) => a + b, 0) / counts.length)
            : 3;
        onProgress?.(`  ✓ Engineer count consensus: ${engineerCount}`);

        // Build summary
        const summary = `Consensus from ${analyses.length} analysts:\n` +
            `- ${agreedConcerns.length} shared concerns\n` +
            `- ${agreedRecommendations.length} agreed recommendations\n` +
            `- ${mergedTasks.length} tasks identified\n` +
            `- Recommended ${engineerCount} engineers`;

        return { agreedConcerns, agreedRecommendations, mergedTasks, engineerCount, summary };
    }

    // Note: writeDebateSummary removed - agents now write directly to plan file

    /**
     * Run a single analyst session via Cursor CLI
     */
    private async runAnalystSession(
        analyst: AnalystConfig,
        requirement: string,
        docs: string[],
        debateFile: string,
        contextSummary: string,
        onProgress?: (message: string) => void
    ): Promise<void> {
        const prompt = this.buildAnalystPrompt(analyst, requirement, docs, debateFile, contextSummary);
        
        onProgress?.(`\n═══════════════════════════════════════════`);
        onProgress?.(`  [${analyst.name}] STARTING SESSION`);
        onProgress?.(`═══════════════════════════════════════════`);
        onProgress?.(`[${analyst.name}] 🚀 Model: ${analyst.model}`);
        onProgress?.(`[${analyst.name}] 📋 Role: ${analyst.role}`);
        onProgress?.(`[${analyst.name}] 📁 Debate file: ${debateFile}`);

        return new Promise((resolve, reject) => {
            // Write prompt to /tmp to avoid command line length issues (and keep project clean)
            const promptFile = `/tmp/apc_analyst_${analyst.id}_${Date.now()}.txt`;
            fs.writeFileSync(promptFile, prompt);
            
            // Debug log file for this agent
            const debugLogFile = path.join(this.debateDir, `agent_${analyst.id}_debug.log`);
            fs.writeFileSync(debugLogFile, `=== Agent ${analyst.name} Debug Log ===\nStarted: ${new Date().toISOString()}\n\n`);
            
            // Run cursor agent via shell, piping the prompt from file
            // This matches how run_engineer.sh works and avoids shell escaping issues
            const shellCmd = `cat "${promptFile}" | cursor agent --model "${analyst.model}" -p --force --approve-mcps --output-format stream-json --stream-partial-output 2>&1; rm -f "${promptFile}"`;
            
            onProgress?.(`[${analyst.name}] 📄 Prompt saved (${prompt.length} chars)`);
            onProgress?.(`[${analyst.name}] 🖥️ Command: cursor agent --model "${analyst.model}" ...`);
            onProgress?.(`[${analyst.name}] 📂 Debug log: ${debugLogFile}`);
            onProgress?.(`[${analyst.name}] ⏳ Launching agent...`);
            
            const proc = spawn('bash', ['-c', shellCmd], {
                cwd: this.workspaceRoot,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env }
            });

            const processId = `${analyst.id}_${Date.now()}`;
            this.activeProcesses.set(processId, proc);

            let collectedText = '';
            let lastProgressTime = Date.now();
            let chunkCount = 0;
            let totalBytes = 0;
            let jsonParseSuccess = 0;
            let jsonParseFail = 0;

            onProgress?.(`[${analyst.name}] 🔌 Agent process started (PID: ${proc.pid || 'unknown'})`);

            proc.stdout?.on('data', (data) => {
                const text = data.toString();
                chunkCount++;
                totalBytes += text.length;
                
                // Log raw data to debug file
                fs.appendFileSync(debugLogFile, `\n[CHUNK ${chunkCount}] (${text.length} bytes)\n${text}\n`);
                
                // Show that we're receiving data
                if (chunkCount === 1) {
                    onProgress?.(`[${analyst.name}] 📡 First data received!`);
                }
                if (chunkCount % 10 === 0) {
                    onProgress?.(`[${analyst.name}] 📊 Progress: ${chunkCount} chunks, ${totalBytes} bytes`);
                }
                
                // Parse streaming JSON - cursor agent format
                const lines = text.split('\n').filter((l: string) => l.trim());
                for (const line of lines) {
                    try {
                        const parsed = JSON.parse(line);
                        jsonParseSuccess++;
                        const msgType = parsed?.type;
                        
                        // Format 1: type="thinking" with text at top level
                        if (msgType === 'thinking' && parsed?.text) {
                            const thinkText = parsed.text.substring(0, 120).replace(/\n/g, ' ');
                            if (thinkText.length > 20) {
                                onProgress?.(`[${analyst.name}] 💭 ${thinkText}...`);
                            }
                        }
                        
                        // Format 2: type="assistant" with message.content[0].text
                        else if (msgType === 'assistant' && parsed?.message?.content) {
                            for (const item of parsed.message.content) {
                                if (item?.type === 'text' && item?.text) {
                                    collectedText += item.text;
                                    const now = Date.now();
                                    // Show progress for meaningful content (throttled to every 2 seconds)
                                    if (now - lastProgressTime > 2000 || 
                                        item.text.includes('##') || 
                                        item.text.includes('CONCERN') ||
                                        item.text.includes('RECOMMEND') ||
                                        item.text.includes('Task') ||
                                        item.text.includes('mcp_unity')) {
                                        const preview = item.text.substring(0, 100).replace(/\n/g, ' ').trim();
                                        if (preview.length > 10) {
                                            onProgress?.(`[${analyst.name}] 📝 ${preview}`);
                                        }
                                        lastProgressTime = now;
                                    }
                                } else if (item?.type === 'tool_use') {
                                    onProgress?.(`[${analyst.name}] 🔧 Tool: ${item.name || 'unknown'} ${item.input ? '(with params)' : ''}`);
                                } else if (item?.type === 'tool_result') {
                                    const resultLen = item.content ? String(item.content).length : 0;
                                    onProgress?.(`[${analyst.name}] ✓ Tool result (${resultLen} chars)`);
                                }
                            }
                        }
                        
                        // Format 3: type="tool_use" at top level
                        else if (msgType === 'tool_use' && parsed?.name) {
                            onProgress?.(`[${analyst.name}] 🔧 Tool: ${parsed.name}`);
                        }
                        
                        // Format 4: type="tool_result" at top level  
                        else if (msgType === 'tool_result') {
                            onProgress?.(`[${analyst.name}] ✓ Tool result received`);
                        }
                        
                        // Format 5: type="result" - final result
                        else if (msgType === 'result') {
                            if (parsed?.result) {
                                collectedText += parsed.result;
                                onProgress?.(`[${analyst.name}] 📋 Final result (${parsed.result.length} chars)`);
                            }
                        }
                        
                        // Format 6: error at any level
                        else if (parsed?.error) {
                            onProgress?.(`[${analyst.name}] ❌ Error: ${parsed.error}`);
                        }
                        
                        // Unknown JSON type - log it
                        else if (msgType) {
                            onProgress?.(`[${analyst.name}] 📨 Message type: ${msgType}`);
                        }
                        
                    } catch (parseErr) {
                        jsonParseFail++;
                        // Not JSON - check if it's meaningful text
                        const trimmed = line.trim();
                        if (trimmed.length > 10) {
                            // Log more types of meaningful output
                            if (trimmed.includes('gather_task_context') || 
                                trimmed.includes('mcp_unity') ||
                                trimmed.includes('Analyzing') ||
                                trimmed.includes('CONCERN') ||
                                trimmed.includes('Found') ||
                                trimmed.includes('Error') ||
                                trimmed.includes('error:') ||
                                trimmed.includes('Warning') ||
                                trimmed.startsWith('##') ||
                                trimmed.includes('Task')) {
                                onProgress?.(`[${analyst.name}] 📄 ${trimmed.substring(0, 100)}`);
                            }
                            // Log non-JSON lines to debug file
                            fs.appendFileSync(debugLogFile, `[NON-JSON] ${trimmed}\n`);
                        }
                    }
                }
            });

            proc.stderr?.on('data', (data) => {
                const err = data.toString();
                // Log all stderr to debug file
                fs.appendFileSync(debugLogFile, `\n[STDERR] ${err}\n`);
                // Show stderr that might be important
                if (err.trim()) {
                    const preview = err.substring(0, 150).replace(/\n/g, ' ').trim();
                    if (preview.includes('error') || preview.includes('Error') || preview.includes('failed')) {
                        onProgress?.(`[${analyst.name}] ⚠️ ${preview}`);
                    } else {
                        onProgress?.(`[${analyst.name}] 📢 ${preview}`);
                    }
                }
            });

            // Heartbeat - show we're still running every 20 seconds
            let elapsedMinutes = 0;
            const heartbeat = setInterval(() => {
                if (this.activeProcesses.has(processId)) {
                    elapsedMinutes += 1/3; // 20 second intervals
                    const stats = `${chunkCount} chunks, ${totalBytes} bytes, JSON: ${jsonParseSuccess}✓/${jsonParseFail}✗`;
                    onProgress?.(`[${analyst.name}] 💓 Running (${elapsedMinutes.toFixed(1)} min) - ${stats}`);
                } else {
                    clearInterval(heartbeat);
                }
            }, 20000);

            proc.on('close', (code) => {
                clearInterval(heartbeat);
                this.activeProcesses.delete(processId);
                
                // Final stats
                const duration = ((Date.now() - lastProgressTime) / 1000).toFixed(1);
                fs.appendFileSync(debugLogFile, `\n=== Session Complete ===\nExit code: ${code}\nChunks: ${chunkCount}\nBytes: ${totalBytes}\nJSON success/fail: ${jsonParseSuccess}/${jsonParseFail}\nCollected text: ${collectedText.length} chars\n`);
                
                onProgress?.(`[${analyst.name}] ───────────────────────────────────────`);
                if (code === 0) {
                    onProgress?.(`[${analyst.name}] ✅ Session complete!`);
                    onProgress?.(`[${analyst.name}]    Chunks: ${chunkCount}, Bytes: ${totalBytes}`);
                    onProgress?.(`[${analyst.name}]    JSON parsed: ${jsonParseSuccess}/${jsonParseSuccess + jsonParseFail}`);
                } else {
                    onProgress?.(`[${analyst.name}] ⚠️ Exited with code ${code}`);
                    onProgress?.(`[${analyst.name}]    Chunks: ${chunkCount}, Bytes: ${totalBytes}`);
                    onProgress?.(`[${analyst.name}]    Check debug log: ${debugLogFile}`);
                }
                resolve();
            });

            proc.on('error', (err) => {
                clearInterval(heartbeat);
                this.activeProcesses.delete(processId);
                fs.appendFileSync(debugLogFile, `\n=== Process Error ===\n${err.message}\n${err.stack}\n`);
                onProgress?.(`[${analyst.name}] ❌ Process error: ${err.message}`);
                onProgress?.(`[${analyst.name}] 📂 See debug log: ${debugLogFile}`);
                resolve(); // Don't reject, let other analysts continue
            });

            // Timeout after 15 minutes per analyst (they need time to call MCP tools and gather context)
            setTimeout(() => {
                if (this.activeProcesses.has(processId)) {
                    onProgress?.(`[${analyst.name}] ⏰ 15min timeout - completing with partial results`);
                    fs.appendFileSync(debugLogFile, `\n=== Timeout (15min) ===\n`);
                    proc.kill();
                    this.activeProcesses.delete(processId);
                    resolve();
                }
            }, 900000); // 15 minutes
        });
    }

    // Note: Old debate file parsing methods removed (parseDebateFile, parseAnalystSection, 
    // extractBulletPoints, extractTasks). Now using parsePlanFileAnalyses and related methods
    // since agents write directly to the plan file.

    /**
     * Fallback mock analysis when Cursor CLI is not available
     */
    private getMockAnalysis(requirement: string): AgentAnalysis {
        const keywords = requirement.toLowerCase();
        
        const concerns: string[] = [
            'Package compatibility should be verified',
            'Performance profiling needed for target platforms'
        ];
        const recommendations: string[] = [
            'Use GAOS-Logger instead of Debug.Log',
            'Follow Unity best practices from documentation'
        ];
        const tasks: AgentAnalysis['taskBreakdown'] = [];

        if (keywords.includes('service') || keywords.includes('di')) {
            concerns.push('Service registration strategy needs to be defined');
            recommendations.push('Use hybrid service registration');
        }
        if (keywords.includes('ui') || keywords.includes('canvas')) {
            concerns.push('UI complexity requires prefab organization');
            recommendations.push('Build UI in prefabs with SO builders');
            tasks.push({
                name: 'UI System Setup',
                files: ['Assets/Scripts/UI/UIManager.cs'],
                dependencies: [],
                tests: ['UIManagerTests.cs']
            });
        }
        if (keywords.includes('pool') || keywords.includes('spawn')) {
            concerns.push('Object spawning needs pooling to avoid GC');
            recommendations.push('Pre-allocate object pools');
            tasks.push({
                name: 'Object Pooling',
                files: ['Assets/Scripts/Pooling/ObjectPool.cs'],
                dependencies: [],
                tests: ['ObjectPoolTests.cs']
            });
        }

        if (tasks.length === 0) {
            tasks.push({
                name: 'Core Implementation',
                files: ['Assets/Scripts/Core/GameManager.cs'],
                dependencies: [],
                tests: ['GameManagerTests.cs']
            });
        }

        return {
            agentName: 'Fallback Analysis (Cursor CLI not available)',
            model: 'none',
            role: 'General',
            concerns,
            recommendations,
            taskBreakdown: tasks,
            engineerCount: 3,
            rationale: 'Install Cursor CLI for real multi-agent debate',
            rawOutput: 'Mock analysis - install cursor CLI'
        };
    }

    /**
     * Stop all active agent processes
     */
    stopAll(): void {
        for (const [id, proc] of this.activeProcesses) {
            proc.kill();
            this.activeProcesses.delete(id);
        }
    }
}

// Re-export for compatibility
export type AgentType = 'cursor';
