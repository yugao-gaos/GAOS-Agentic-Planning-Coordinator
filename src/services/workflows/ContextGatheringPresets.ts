// ============================================================================
// ContextGatheringPresets - Built-in presets and helper functions for
// the ContextGatheringWorkflow. This is a simple module, not a service class.
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { ContextGatheringPresetConfig, ContextPresetUserConfig } from '../../types/workflow';

// ============================================================================
// BUILT-IN PRESETS
// ============================================================================

/**
 * All built-in context gathering presets.
 * These provide specialized prompts for different asset/code types.
 */
export const BUILTIN_PRESETS: Record<string, ContextGatheringPresetConfig> = {
    
    // =========================================================================
    // CODE PRESETS (3)
    // =========================================================================
    
    code_architecture: {
        id: 'code_architecture',
        name: 'Code Architecture',
        description: 'Understand high-level architecture, patterns, and module dependencies',
        filePatterns: ['.ts', '.js', '.cs', '.py', '.java', '.go', '.rs'],
        isBuiltIn: true,
        gatherPrompt: `## Architecture Analysis Focus

Analyze the target codebase for architectural patterns:

1. **Module Organization**
   - Directory structure and logical groupings
   - Entry points and main components
   - Layering (presentation, business logic, data)

2. **Design Patterns**
   - Common patterns used (Factory, Observer, Strategy, etc.)
   - Dependency injection approach
   - State management patterns

3. **Dependencies**
   - External package dependencies
   - Internal module dependencies
   - Circular dependency risks

4. **Integration Points**
   - APIs exposed or consumed
   - Event systems or message buses
   - Plugin/extension points

Document architectural decisions and their rationale where evident.`,
        summarizePrompt: `Create an architecture reference document with:
- Architecture overview (diagram as ASCII if helpful)
- Component responsibilities
- Key design decisions
- Integration patterns
- Dependency graph highlights`
    },
    
    code_implementation: {
        id: 'code_implementation',
        name: 'Implementation Details',
        description: 'Understand specific implementation patterns, APIs, and conventions',
        filePatterns: ['.ts', '.js', '.cs', '.py', '.java', '.go', '.rs', '.cpp', '.h'],
        isBuiltIn: true,
        gatherPrompt: `## Implementation Analysis Focus

Analyze for implementation details:

1. **Code Conventions**
   - Naming conventions (classes, methods, variables)
   - File organization patterns
   - Comment and documentation style

2. **Key Classes/Functions**
   - Public APIs and their signatures
   - Important base classes/interfaces
   - Utility functions and helpers

3. **Error Handling**
   - Exception patterns used
   - Error reporting mechanisms
   - Fallback strategies

4. **Configuration**
   - Config file formats
   - Environment variable usage
   - Feature flags

Include specific code examples that demonstrate patterns.`,
        summarizePrompt: `Create an implementation guide with:
- Key API reference
- Code conventions to follow
- Common patterns with examples
- Error handling approach
- Configuration guide`
    },
    
    code_testing: {
        id: 'code_testing',
        name: 'Testing Infrastructure',
        description: 'Understand test organization, patterns, and fixtures',
        filePatterns: ['.test.ts', '.spec.ts', '.test.js', '.spec.js', '.test.cs', '.Tests.cs'],
        isBuiltIn: true,
        gatherPrompt: `## Testing Analysis Focus

Analyze the testing infrastructure:

1. **Test Organization**
   - Test file locations and naming
   - Test categories (unit, integration, e2e)
   - Test grouping/suites

2. **Test Patterns**
   - Test setup/teardown patterns
   - Mocking and stubbing approach
   - Assertion styles

3. **Test Fixtures**
   - Shared test data
   - Factory patterns
   - Database seeding

4. **CI/CD Integration**
   - Test commands and scripts
   - Coverage requirements
   - Test parallelization`,
        summarizePrompt: `Create a testing guide with:
- Test organization structure
- How to write new tests
- Available fixtures and helpers
- Running tests locally
- Coverage expectations`
    },
    
    // =========================================================================
    // UNITY ASSET PRESETS (7)
    // =========================================================================
    
    unity_visual_assets: {
        id: 'unity_visual_assets',
        name: 'Unity Visual Assets',
        description: 'Analyze sprites, textures, UI images, and 2D visual assets',
        filePatterns: ['.png', '.jpg', '.jpeg', '.psd', '.tga', '.sprite', '.spriteatlas'],
        requiresUnity: true,
        isBuiltIn: true,
        gatherPrompt: `## Unity Visual Assets Analysis

Analyze visual assets in the Unity project:

1. **Sprites & Textures**
   - Sprite atlas organization
   - Texture import settings (compression, filtering)
   - Sprite slicing and pivot points
   - 9-slice configurations for UI

2. **UI Assets**
   - UI image organization (icons, backgrounds, buttons)
   - UI sprite atlas usage
   - Font assets and TextMeshPro settings

3. **2D Animation**
   - Sprite animation clips
   - Animator controllers for 2D
   - Frame-by-frame vs bone animation

4. **Asset Organization**
   - Folder structure for visual assets
   - Naming conventions
   - Addressable/AssetBundle grouping

Note import settings patterns and optimization opportunities.`,
        summarizePrompt: `Create a visual assets reference with:
- Asset organization structure
- Import settings standards
- Sprite atlas configuration
- UI asset conventions
- Optimization recommendations`
    },
    
    unity_3d_assets: {
        id: 'unity_3d_assets',
        name: 'Unity 3D Assets',
        description: 'Analyze 3D models, meshes, animations, and rigs',
        filePatterns: ['.fbx', '.obj', '.blend', '.dae', '.anim', '.controller', '.mask'],
        requiresUnity: true,
        isBuiltIn: true,
        gatherPrompt: `## Unity 3D Assets Analysis

Analyze 3D assets in the Unity project:

1. **3D Models**
   - Model import settings (scale, normals, tangents)
   - Mesh optimization (LOD, vertex count targets)
   - Material slot organization

2. **Animations**
   - Animation clip organization
   - Animator controller structure
   - Animation layers and masks
   - State machine patterns

3. **Rigs & Avatars**
   - Humanoid vs generic rigs
   - Avatar configuration
   - IK setup

4. **Optimization**
   - LOD group usage
   - Static/dynamic batching considerations
   - Mesh compression settings

Identify performance considerations and best practices.`,
        summarizePrompt: `Create a 3D assets reference with:
- Model import guidelines
- Animation organization
- LOD configuration
- Performance tips
- Rig/avatar standards`
    },
    
    unity_materials: {
        id: 'unity_materials',
        name: 'Unity Materials & Shaders',
        description: 'Analyze materials, shaders, and rendering setup',
        filePatterns: ['.mat', '.shader', '.shadergraph', '.compute', '.cginc', '.hlsl'],
        requiresUnity: true,
        isBuiltIn: true,
        gatherPrompt: `## Unity Materials & Shaders Analysis

Analyze rendering setup:

1. **Render Pipeline**
   - Pipeline in use (Built-in, URP, HDRP)
   - Render pipeline assets and settings
   - Quality level configurations

2. **Materials**
   - Material organization
   - Shader usage patterns
   - Material property conventions
   - Material variants

3. **Shaders**
   - Custom shader code
   - Shader Graph usage
   - Shader feature keywords
   - Shader LOD

4. **Lighting & Post-Processing**
   - Lighting setup patterns
   - Post-processing profiles
   - Global illumination settings

Note shader compilation and variant management concerns.`,
        summarizePrompt: `Create a materials/rendering reference with:
- Render pipeline configuration
- Material conventions
- Shader guidelines
- Performance considerations
- Lighting standards`
    },
    
    unity_audio: {
        id: 'unity_audio',
        name: 'Unity Audio',
        description: 'Analyze audio clips, mixers, and spatial audio setup',
        filePatterns: ['.wav', '.mp3', '.ogg', '.aiff', '.mixer'],
        requiresUnity: true,
        isBuiltIn: true,
        gatherPrompt: `## Unity Audio Analysis

Analyze audio setup:

1. **Audio Clips**
   - Audio file organization
   - Import settings (compression, load type)
   - Streaming vs in-memory

2. **Audio Mixers**
   - Mixer group hierarchy
   - Effects and snapshots
   - Exposed parameters

3. **Spatial Audio**
   - 3D sound settings
   - Audio listener setup
   - Reverb zones

4. **Audio Sources**
   - Common audio source configurations
   - Pooling patterns
   - One-shot vs looping patterns`,
        summarizePrompt: `Create an audio reference with:
- Audio organization
- Mixer setup
- Import settings guide
- Common patterns
- Performance tips`
    },
    
    unity_prefabs: {
        id: 'unity_prefabs',
        name: 'Unity Prefabs',
        description: 'Analyze prefab organization, variants, and nesting',
        filePatterns: ['.prefab'],
        requiresUnity: true,
        isBuiltIn: true,
        gatherPrompt: `## Unity Prefab Analysis

Analyze prefab structure:

1. **Prefab Organization**
   - Folder structure
   - Naming conventions
   - Category groupings

2. **Prefab Variants**
   - Base prefab patterns
   - Variant inheritance chains
   - Override patterns

3. **Nested Prefabs**
   - Nesting depth and patterns
   - Shared component prefabs
   - Instance modifications

4. **Component Patterns**
   - Common component combinations
   - Serialized field patterns
   - Reference handling`,
        summarizePrompt: `Create a prefab reference with:
- Organization structure
- Variant patterns
- Component conventions
- Best practices
- Common prefab templates`
    },
    
    unity_scenes: {
        id: 'unity_scenes',
        name: 'Unity Scenes',
        description: 'Analyze scene hierarchy, lighting, and navigation',
        filePatterns: ['.unity'],
        requiresUnity: true,
        isBuiltIn: true,
        gatherPrompt: `## Unity Scene Analysis

Analyze scenes:

1. **Scene Organization**
   - Scene list and purposes
   - Scene loading patterns (single, additive)
   - Scene hierarchy organization

2. **Hierarchy Patterns**
   - Root object organization
   - Layer usage
   - Tag conventions

3. **Lighting**
   - Light setup patterns
   - Baked vs realtime
   - Light probe placement

4. **Navigation**
   - NavMesh configuration
   - Navigable areas
   - Off-mesh links`,
        summarizePrompt: `Create a scene reference with:
- Scene organization
- Hierarchy conventions
- Lighting setup
- Navigation configuration
- Loading patterns`
    },
    
    unity_scriptable_objects: {
        id: 'unity_scriptable_objects',
        name: 'Unity ScriptableObjects',
        description: 'Analyze ScriptableObject patterns and data containers',
        filePatterns: ['.asset'],
        requiresUnity: true,
        isBuiltIn: true,
        gatherPrompt: `## Unity ScriptableObject Analysis

Analyze ScriptableObject usage:

1. **SO Types**
   - Custom SO class definitions
   - Purpose of each SO type
   - Inheritance hierarchies

2. **Data Patterns**
   - Configuration data
   - Game data (items, abilities, etc.)
   - Runtime data containers

3. **Organization**
   - Asset folder structure
   - Naming conventions
   - Editor tooling

4. **Usage Patterns**
   - Singleton patterns
   - Event channels
   - Variable references`,
        summarizePrompt: `Create a ScriptableObject reference with:
- SO type catalog
- Usage patterns
- Organization conventions
- Editor tooling
- Common SO templates`
    }
};

// ============================================================================
// DEFAULT EXTENSION MAPPINGS
// ============================================================================

/**
 * Default mapping from file extension to preset ID.
 * User can override these via context_presets.json
 */
export const DEFAULT_EXTENSION_MAP: Record<string, string> = {
    // Code - Implementation (general)
    '.ts': 'code_implementation',
    '.js': 'code_implementation',
    '.tsx': 'code_implementation',
    '.jsx': 'code_implementation',
    '.cs': 'code_implementation',
    '.py': 'code_implementation',
    '.java': 'code_implementation',
    '.go': 'code_implementation',
    '.rs': 'code_implementation',
    '.cpp': 'code_implementation',
    '.c': 'code_implementation',
    '.h': 'code_implementation',
    '.hpp': 'code_implementation',
    
    // Code - Testing
    '.test.ts': 'code_testing',
    '.spec.ts': 'code_testing',
    '.test.js': 'code_testing',
    '.spec.js': 'code_testing',
    '.test.tsx': 'code_testing',
    '.spec.tsx': 'code_testing',
    '.Tests.cs': 'code_testing',
    
    // Unity - Visual Assets
    '.png': 'unity_visual_assets',
    '.jpg': 'unity_visual_assets',
    '.jpeg': 'unity_visual_assets',
    '.psd': 'unity_visual_assets',
    '.tga': 'unity_visual_assets',
    '.sprite': 'unity_visual_assets',
    '.spriteatlas': 'unity_visual_assets',
    
    // Unity - 3D Assets
    '.fbx': 'unity_3d_assets',
    '.obj': 'unity_3d_assets',
    '.blend': 'unity_3d_assets',
    '.dae': 'unity_3d_assets',
    '.anim': 'unity_3d_assets',
    '.controller': 'unity_3d_assets',
    '.mask': 'unity_3d_assets',
    
    // Unity - Materials & Shaders
    '.mat': 'unity_materials',
    '.shader': 'unity_materials',
    '.shadergraph': 'unity_materials',
    '.compute': 'unity_materials',
    '.cginc': 'unity_materials',
    '.hlsl': 'unity_materials',
    
    // Unity - Audio
    '.wav': 'unity_audio',
    '.mp3': 'unity_audio',
    '.ogg': 'unity_audio',
    '.aiff': 'unity_audio',
    '.mixer': 'unity_audio',
    
    // Unity - Prefabs
    '.prefab': 'unity_prefabs',
    
    // Unity - Scenes
    '.unity': 'unity_scenes',
    
    // Unity - ScriptableObjects
    '.asset': 'unity_scriptable_objects'
};

// ============================================================================
// CONFIG FILE PATH
// ============================================================================

const CONFIG_FILENAME = 'context_presets.json';
const CONFIG_DIR = '_AiDevLog/Config';

/**
 * Get the full path to the user config file
 */
export function getConfigPath(workspaceRoot: string): string {
    return path.join(workspaceRoot, CONFIG_DIR, CONFIG_FILENAME);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Load user configuration from _AiDevLog/Config/context_presets.json
 * Returns null if file doesn't exist or is invalid
 */
export function loadUserConfig(workspaceRoot: string): ContextPresetUserConfig | null {
    const configPath = getConfigPath(workspaceRoot);
    
    if (!fs.existsSync(configPath)) {
        return null;
    }
    
    try {
        const content = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(content) as ContextPresetUserConfig;
        return config;
    } catch (error) {
        console.warn(`[ContextGatheringPresets] Failed to load user config: ${error}`);
        return null;
    }
}

/**
 * Save user configuration to _AiDevLog/Config/context_presets.json
 */
export function saveUserConfig(workspaceRoot: string, config: ContextPresetUserConfig): boolean {
    const configPath = getConfigPath(workspaceRoot);
    const configDir = path.dirname(configPath);
    
    try {
        // Ensure directory exists
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }
        
        const content = JSON.stringify(config, null, 2);
        fs.writeFileSync(configPath, content, 'utf-8');
        return true;
    } catch (error) {
        console.error(`[ContextGatheringPresets] Failed to save user config: ${error}`);
        return false;
    }
}

/**
 * Get all presets (built-in + custom from user config)
 */
export function getAllPresets(workspaceRoot: string): Record<string, ContextGatheringPresetConfig> {
    const userConfig = loadUserConfig(workspaceRoot);
    const presets = { ...BUILTIN_PRESETS };
    
    // Add custom presets from user config
    if (userConfig?.customPresets) {
        for (const preset of userConfig.customPresets) {
            presets[preset.id] = {
                ...preset,
                isBuiltIn: false
            };
        }
    }
    
    return presets;
}

/**
 * Get merged extension map (defaults + user overrides)
 */
export function getExtensionMap(workspaceRoot: string): Record<string, string> {
    const userConfig = loadUserConfig(workspaceRoot);
    const extensionMap = { ...DEFAULT_EXTENSION_MAP };
    
    // Apply user overrides
    if (userConfig?.extensionOverrides) {
        for (const [ext, presetId] of Object.entries(userConfig.extensionOverrides)) {
            extensionMap[ext] = presetId;
        }
    }
    
    return extensionMap;
}

/**
 * Get a specific preset by ID
 */
export function getPreset(presetId: string, workspaceRoot: string): ContextGatheringPresetConfig | undefined {
    const allPresets = getAllPresets(workspaceRoot);
    return allPresets[presetId];
}

/**
 * Detect asset types from a list of file paths.
 * Returns a map of presetId → array of file paths.
 * 
 * @param files Array of file paths to categorize
 * @param extensionMap Extension → preset mapping to use
 * @param unityEnabled Whether Unity presets should be included
 * @param presets All available presets (for checking requiresUnity)
 */
export function detectAssetTypes(
    files: string[],
    extensionMap: Record<string, string>,
    unityEnabled: boolean,
    presets: Record<string, ContextGatheringPresetConfig>
): Map<string, string[]> {
    const result = new Map<string, string[]>();
    
    for (const filePath of files) {
        const ext = getFileExtension(filePath);
        const presetId = extensionMap[ext];
        
        if (!presetId) {
            continue; // No mapping for this extension
        }
        
        const preset = presets[presetId];
        if (!preset) {
            continue; // Preset doesn't exist
        }
        
        // Skip Unity presets if Unity is disabled
        if (preset.requiresUnity && !unityEnabled) {
            continue;
        }
        
        // Add file to the preset's list
        if (!result.has(presetId)) {
            result.set(presetId, []);
        }
        result.get(presetId)!.push(filePath);
    }
    
    return result;
}

/**
 * Get file extension, handling compound extensions like .test.ts
 */
function getFileExtension(filePath: string): string {
    const basename = path.basename(filePath);
    
    // Check for compound extensions first (e.g., .test.ts, .spec.js)
    const compoundExtensions = ['.test.ts', '.spec.ts', '.test.js', '.spec.js', '.test.tsx', '.spec.tsx', '.Tests.cs'];
    for (const compoundExt of compoundExtensions) {
        if (basename.endsWith(compoundExt)) {
            return compoundExt;
        }
    }
    
    // Fall back to simple extension
    return path.extname(filePath).toLowerCase();
}

/**
 * Recursively scan directories for files
 */
export function scanDirectories(
    targets: string[],
    workspaceRoot: string,
    ignorePatterns: string[] = ['node_modules', '.git', 'Library', 'Temp', 'Logs', 'obj', 'bin']
): string[] {
    const files: string[] = [];
    
    for (const target of targets) {
        const fullPath = path.isAbsolute(target) ? target : path.join(workspaceRoot, target);
        
        if (!fs.existsSync(fullPath)) {
            continue;
        }
        
        const stat = fs.statSync(fullPath);
        
        if (stat.isFile()) {
            files.push(fullPath);
        } else if (stat.isDirectory()) {
            scanDirectory(fullPath, files, ignorePatterns);
        }
    }
    
    return files;
}

/**
 * Recursively scan a single directory
 */
function scanDirectory(dirPath: string, files: string[], ignorePatterns: string[]): void {
    let entries: fs.Dirent[];
    
    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
        return; // Skip directories we can't read
    }
    
    for (const entry of entries) {
        // Skip ignored patterns
        if (ignorePatterns.some(pattern => entry.name === pattern || entry.name.startsWith('.'))) {
            continue;
        }
        
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isFile()) {
            files.push(fullPath);
        } else if (entry.isDirectory()) {
            scanDirectory(fullPath, files, ignorePatterns);
        }
    }
}

