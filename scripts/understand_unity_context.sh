#!/bin/bash

# understand_unity_context.sh
# Uses Cursor CLI with Gemini to analyze Unity files and generate context documentation

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONTEXT_DIR="$PROJECT_ROOT/_AiDevLog/Context"
CONTEXT_INDEX="$CONTEXT_DIR/ContextIndex.md"
DOCS_DIR="$PROJECT_ROOT/_AiDevLog/Docs"
GAME_CONTEXT_DOCS=""  # Will be set from command line parameter

# Supported file types
SUPPORTED_IMAGE_TYPES=("jpg" "jpeg" "png" "tga" "psd" "bmp" "gif")
SUPPORTED_UNITY_TYPES=("prefab" "scene" "asset" "mat" "fbx" "obj" "blend")
SUPPORTED_FONT_TYPES=("ttf" "otf" "fnt")
SUPPORTED_FX_TYPES=("vfx" "shadergraph" "shadersubgraph")
SUPPORTED_CODE_TYPES=("cs" "shader" "cginc" "compute" "hlsl" "glsl")

# Function to print colored messages
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# Function to build game context from documentation files
build_game_context() {
    local docs_param="$1"
    local game_context=""
    
    if [ -z "$docs_param" ]; then
        return
    fi
    
    # Parse comma-separated list of doc files
    IFS=',' read -ra DOC_FILES <<< "$docs_param"
    
    print_info "Loading game context from ${#DOC_FILES[@]} documentation file(s)..."
    
    for doc_file in "${DOC_FILES[@]}"; do
        # Trim whitespace
        doc_file=$(echo "$doc_file" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
        
        # Check if it's a relative path
        if [[ "$doc_file" != /* ]]; then
            doc_file="$DOCS_DIR/$doc_file"
        fi
        
        if [ -f "$doc_file" ]; then
            local doc_name=$(basename "$doc_file")
            print_info "  ✓ Loaded: $doc_name"
            # Read first 1000 lines of doc (to avoid massive context)
            local doc_content=$(head -n 1000 "$doc_file")
            game_context="${game_context}\n\n=== Game Documentation: $doc_name ===\n${doc_content}"
        else
            print_warning "  ✗ Not found: $doc_file"
        fi
    done
    
    echo "$game_context"
}

# Function to check if file type is supported
is_supported_type() {
    local file_type="$1"
    local type_lower=$(echo "$file_type" | tr '[:upper:]' '[:lower:]') # Convert to lowercase
    
    for img_type in "${SUPPORTED_IMAGE_TYPES[@]}"; do
        if [ "$type_lower" == "$img_type" ]; then
            return 0
        fi
    done
    
    for unity_type in "${SUPPORTED_UNITY_TYPES[@]}"; do
        if [ "$type_lower" == "$unity_type" ]; then
            return 0
        fi
    done
    
    for font_type in "${SUPPORTED_FONT_TYPES[@]}"; do
        if [ "$type_lower" == "$font_type" ]; then
            return 0
        fi
    done
    
    for fx_type in "${SUPPORTED_FX_TYPES[@]}"; do
        if [ "$type_lower" == "$fx_type" ]; then
            return 0
        fi
    done
    
    for code_type in "${SUPPORTED_CODE_TYPES[@]}"; do
        if [ "$type_lower" == "$code_type" ]; then
            return 0
        fi
    done
    
    return 1
}

# Function to analyze image files using Gemini with enhanced sprite understanding
analyze_image() {
    local file_path="$1"
    local file_name="$2"
    local folder_context="$3"
    
    # Check meta file for sprite settings (9-slice info)
    local meta_file="${file_path}.meta"
    local sprite_info=""
    
    if [ -f "$meta_file" ]; then
        # Look for 9-slice (border) settings in meta file
        if grep -q "spriteBorder:" "$meta_file"; then
            local borders=$(grep "spriteBorder:" "$meta_file" | head -n 1)
            if [[ ! "$borders" =~ "x: 0" || ! "$borders" =~ "y: 0" ]]; then
                sprite_info="9-slice sprite - "
            fi
        fi
        
        # Check for sprite mode (single, multiple)
        if grep -q "spriteMode: 2" "$meta_file"; then
            sprite_info="${sprite_info}Multi-sprite sheet - "
        fi
    fi
    
    # Prepare enhanced prompt for Gemini with game context
    local context_hint=""
    if [ -n "$folder_context" ]; then
        context_hint="Folder context: '$folder_context'. "
    fi
    
    local game_aware_prompt="$context_hint

GAME: This is for a Match-3 puzzle game (like Candy Crush/Bejeweled). 
${GAME_CONTEXT_DOCS}

Analyze this Unity texture/sprite image. Describe what it looks like and suggest specific uses in our Match-3 game, OR note if it's not relevant. One concise sentence. Examples: 'Low-poly grass texture - could be used for game board background', 'Blue gradient sky - not relevant for Match-3 gameplay', 'Colorful gem texture - perfect for gem visuals'. ${sprite_info}"
    
    # Use cursor agent with Gemini to analyze the image (with UnityMCP access)
    local description=$(cursor agent --print --output-format text --approve-mcps --model gemini-3-pro --workspace "$PROJECT_ROOT" "Analyze image at $file_path. $game_aware_prompt" 2>&1 | grep -v "^\[" | grep -v "^$" | grep -v "Warning:" | head -n 1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    
    if [ -z "$description" ] || [[ "$description" == *"Error"* ]] || [[ "$description" == *"error"* ]]; then
        description="${sprite_info}Image/texture asset"
    else
        # Prepend sprite info if present
        if [ -n "$sprite_info" ]; then
            description="${sprite_info}${description}"
        fi
    fi
    
    echo "$description"
}

# Function to analyze font files
analyze_font() {
    local file_path="$1"
    local file_name="$2"
    local file_type="$3"
    local folder_context="$4"
    
    # Check meta file for font settings
    local meta_file="${file_path}.meta"
    local font_info=""
    
    if [ -f "$meta_file" ]; then
        local meta_content=$(cat "$meta_file")
        
        local context_hint=""
        if [ -n "$folder_context" ]; then
            context_hint="Folder context: '$folder_context'. "
        fi
        
        local prompt="${context_hint}

GAME: This is for a Match-3 puzzle game.
${GAME_CONTEXT_DOCS}

Analyze this Unity font meta file. Determine the font family, style, and suggest uses in our Match-3 game OR note if not relevant. One sentence. Example: 'Sans-serif font - good for UI score display and menus'."
        
        font_info=$(cursor agent --print --output-format text --approve-mcps --model gemini-3-pro --workspace "$PROJECT_ROOT" "$prompt Meta file content: $meta_content" 2>&1 | grep -v "^\[" | grep -v "^$" | grep -v "Warning:" | head -n 1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    fi
    
    if [ -z "$font_info" ] || [[ "$font_info" == *"Error"* ]] || [[ "$font_info" == *"error"* ]]; then
        font_info="Font asset"
    fi
    
    echo "$font_info"
}

# Function to analyze code files (C#, shaders, etc.)
analyze_code() {
    local file_path="$1"
    local file_name="$2"
    local file_type="$3"
    local folder_context="$4"
    
    # Read file content for analysis
    if [ ! -f "$file_path" ]; then
        echo "Code file"
        return
    fi
    
    # Read up to 500 lines for code analysis
    local file_content=$(head -n 500 "$file_path")
    
    local context_hint=""
    if [ -n "$folder_context" ]; then
        context_hint="Folder context: '$folder_context'. "
    fi
    
    local prompt=""
    case "$file_type" in
        "cs")
            prompt="${context_hint}

GAME: This is for a Match-3 puzzle game.
${GAME_CONTEXT_DOCS}

Analyze this C# Unity script. Describe its purpose and relevance to our Match-3 game in ONE sentence. Examples: 'BoardManager script - already implemented for our match-3 board', 'Enemy AI script - not relevant to puzzle game', 'Particle controller - could be used for gem pop effects'."
            ;;
        "shader"|"cginc"|"hlsl"|"glsl")
            prompt="${context_hint}

GAME: Match-3 puzzle game.
${GAME_CONTEXT_DOCS}

Analyze this shader. Describe visual effect and potential use in our game in ONE sentence. Examples: 'PBR metallic shader - good for gem rendering', 'Toon outline shader - not relevant to our art style'."
            ;;
        "compute")
            prompt="${context_hint}

GAME: Match-3 puzzle game.
${GAME_CONTEXT_DOCS}

Analyze this compute shader and suggest Match-3 game applications. ONE sentence. Example: 'Particle physics compute - could optimize gem cascade effects'."
            ;;
    esac
    
    # Use cursor CLI with Gemini to analyze
    local description=$(echo "$file_content" | cursor chat --model gemini-3-pro --message "$prompt" --stdin --format text 2>&1 | grep -v "^\[" | grep -v "^$" | head -n 1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    
    if [ -z "$description" ] || [[ "$description" == *"Error"* ]] || [[ "$description" == *"error"* ]]; then
        case "$file_type" in
            "cs") description="C# Unity script" ;;
            "shader") description="Shader code" ;;
            "cginc") description="Shader include file" ;;
            "compute") description="Compute shader" ;;
            "hlsl"|"glsl") description="Shader code" ;;
            *) description="Code file" ;;
        esac
    fi
    
    echo "$description"
}

# Function to analyze VFX/particle system files
analyze_fx() {
    local file_path="$1"
    local file_name="$2"
    local file_type="$3"
    local folder_context="$4"
    
    # Read file content for analysis
    if [ ! -f "$file_path" ]; then
        echo "VFX/particle effect prefab"
        return
    fi
    
    local file_content=$(head -n 300 "$file_path")
    
    local context_hint=""
    if [ -n "$folder_context" ]; then
        context_hint="Folder context: '$folder_context'. "
    fi
    
    local prompt="${context_hint}

GAME: Match-3 puzzle game (like Candy Crush).
${GAME_CONTEXT_DOCS}

Analyze this Unity particle/VFX file. Describe the visual effect and suggest specific uses in our Match-3 game OR note if not relevant. ONE sentence. Examples: 'Sparkle particles - perfect for gem collection feedback', 'Explosion effect - good for special gem activation', 'Weather particles - not relevant to puzzle gameplay'."
    
    # Use cursor agent with Gemini and UnityMCP to analyze VFX
    local description=$(cursor agent --print --output-format text --approve-mcps --model gemini-3-pro --workspace "$PROJECT_ROOT" "$prompt File content: $file_content" 2>&1 | grep -v "^\[" | grep -v "^$" | grep -v "Warning:" | head -n 1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    
    if [ -z "$description" ] || [[ "$description" == *"Error"* ]] || [[ "$description" == *"error"* ]]; then
        description="VFX/particle effect prefab"
    fi
    
    echo "$description"
}

# Function to analyze Unity text-based files (prefab, scene, asset, mat)
analyze_unity_text_file() {
    local file_path="$1"
    local file_name="$2"
    local file_type="$3"
    local folder_context="$4"
    
    # Check if file exists and is readable
    if [ ! -f "$file_path" ]; then
        echo "File not found"
        return
    fi
    
    # Extract first 200 lines for analysis (Unity files can be large)
    local file_content=$(head -n 200 "$file_path")
    
    # Prepare prompt based on file type
    local context_hint=""
    if [ -n "$folder_context" ]; then
        context_hint="Context: This file is in a folder described as: '$folder_context'. "
    fi
    
    local prompt=""
    case "$file_type" in
        "prefab")
            prompt="${context_hint}

GAME: Match-3 puzzle game. We need: gems (6 colors), obstacles (boxes/ice/jelly), board tiles, UI elements, particle effects.
${GAME_CONTEXT_DOCS}

Analyze this Unity prefab using UnityMCP if helpful. Describe the 3D model and rate its relevance to our Match-3 game (HIGH/MEDIUM/LOW/NONE). ONE sentence. Examples: 'Low-poly sphere - HIGH relevance, perfect base for gem prefabs', 'Building column - NONE, not relevant to puzzle game', 'Coin icon - MEDIUM, could be used for currency UI'."
            ;;
        "scene")
            prompt="${context_hint}

GAME: Match-3 puzzle game.
${GAME_CONTEXT_DOCS}

Analyze this Unity scene. Describe structure and Match-3 relevance. ONE sentence. Example: 'Demo scene with environment - LOW relevance, we need board-focused gameplay scene'."
            ;;
        "asset")
            prompt="${context_hint}

GAME: Match-3 puzzle game.
${GAME_CONTEXT_DOCS}

Analyze this ScriptableObject asset. Describe data purpose and Match-3 relevance. ONE sentence. Example: 'Level config asset - HIGH relevance if matches our LevelData structure'."
            ;;
        "mat")
            prompt="${context_hint}

GAME: Match-3 puzzle game needing colorful gem materials.
${GAME_CONTEXT_DOCS}

Analyze this Unity material. Describe appearance and suggest Match-3 uses or note if not relevant. ONE sentence. Example: 'Metallic PBR material - MEDIUM, good base for gem variants'."
            ;;
    esac
    
    # Use cursor agent with Gemini and UnityMCP to analyze Unity files
    local description=$(cursor agent --print --output-format text --approve-mcps --model gemini-3-pro --workspace "$PROJECT_ROOT" "$prompt You can use UnityMCP tools to inspect this asset at path: $file_path. File content: $file_content" 2>&1 | grep -v "^\[" | grep -v "^$" | grep -v "Warning:" | head -n 1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    
    if [ -z "$description" ] || [[ "$description" == *"Error"* ]] || [[ "$description" == *"error"* ]]; then
        case "$file_type" in
            "prefab") description="3D model prefab" ;;
            "scene") description="Unity scene" ;;
            "asset") description="ScriptableObject asset" ;;
            "mat") description="Material asset" ;;
            *) description="Unity $file_type asset" ;;
        esac
    fi
    
    echo "$description"
}

# Function to analyze 3D model files
analyze_3d_model() {
    local file_path="$1"
    local file_name="$2"
    local file_type="$3"
    local folder_context="$4"
    
    # For 3D models, look for associated .meta file and material references
    local meta_file="${file_path}.meta"
    local description="3D model file"
    
    # Try to infer from filename
    local base_name=$(basename "$file_name" .${file_type})
    
    if [ -f "$meta_file" ]; then
        local meta_content=$(cat "$meta_file")
        
        local context_hint=""
        if [ -n "$folder_context" ]; then
            context_hint="Folder context: '$folder_context'. "
        fi
        
        # Extract material and texture info from meta
        local prompt="${context_hint}

GAME: Match-3 puzzle game needing gems, obstacles, board tiles, UI.
${GAME_CONTEXT_DOCS}

Analyze this 3D FBX model (filename: ${base_name}). Describe what it is and rate Match-3 relevance (HIGH/MEDIUM/LOW/NONE). ONE sentence. Examples: 'Sphere model - HIGH, perfect for gems', 'Tree model - NONE, not relevant', 'Cube model - MEDIUM, could be obstacle base'."
        
        description=$(cursor agent --print --output-format text --approve-mcps --model gemini-3-pro --workspace "$PROJECT_ROOT" "$prompt You can use UnityMCP's manage_asset tool to inspect this FBX at: $file_path. Meta content: $meta_content" 2>&1 | grep -v "^\[" | grep -v "^$" | grep -v "Warning:" | head -n 1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
        
        if [ -z "$description" ] || [[ "$description" == *"Error"* ]] || [[ "$description" == *"error"* ]]; then
            description="3D model file"
        fi
    fi
    
    echo "$description"
}

# Function to get relative path from project root
get_relative_path() {
    local file_path="$1"
    local rel_path="${file_path#$PROJECT_ROOT/}"
    echo "/$rel_path"
}

# Function to update context index
update_context_index() {
    local folder_path="$1"
    local context_file="$2"
    
    # Get relative paths
    local rel_folder=$(get_relative_path "$folder_path")
    local context_file_name=$(basename "$context_file")
    
    # Check if context file is already in index
    if [ -f "$CONTEXT_INDEX" ]; then
        if grep -q "$context_file_name" "$CONTEXT_INDEX"; then
            print_info "Context file already in index: $context_file_name"
            return
        fi
    else
        # Create context index if it doesn't exist
        touch "$CONTEXT_INDEX"
    fi
    
    # Add to index
    echo "_AiDevLog/Context/$context_file_name" >> "$CONTEXT_INDEX"
    print_success "Added $context_file_name to context index"
}

# Function to create or update context file
process_folder() {
    local folder_path="$1"
    local file_type="$2"
    local folder_description="$3"
    
    # Validate folder exists
    if [ ! -d "$folder_path" ]; then
        print_error "Folder not found: $folder_path"
        exit 1
    fi
    
    # Validate file type
    if ! is_supported_type "$file_type"; then
        print_error "Unsupported file type: $file_type"
        echo "Supported types:"
        echo "  Images: ${SUPPORTED_IMAGE_TYPES[*]}"
        echo "  Unity files: ${SUPPORTED_UNITY_TYPES[*]}"
        echo "  Fonts: ${SUPPORTED_FONT_TYPES[*]}"
        echo "  FX: ${SUPPORTED_FX_TYPES[*]}"
        echo "  Code: ${SUPPORTED_CODE_TYPES[*]}"
        exit 1
    fi
    
    # Generate context file name
    local folder_name=$(basename "$folder_path")
    local context_file_name="${folder_name}_${file_type}.md"
    local context_file="$CONTEXT_DIR/$context_file_name"
    
    # Get relative folder path
    local rel_folder=$(get_relative_path "$folder_path")
    
    print_info "Processing folder: $rel_folder"
    print_info "Looking for .$file_type files"
    
    # Find all files of specified type
    local files=()
    while IFS= read -r -d '' file; do
        files+=("$file")
    done < <(find "$folder_path" -maxdepth 1 -type f -name "*.${file_type}" -print0 2>/dev/null)
    
    if [ ${#files[@]} -eq 0 ]; then
        print_warning "No .$file_type files found in $rel_folder"
        exit 0
    fi
    
    print_info "Found ${#files[@]} files to analyze"
    
    # Create or update context file
    local file_exists=false
    if [ -f "$context_file" ]; then
        file_exists=true
        print_info "Updating existing context file: $context_file_name"
    else
        print_info "Creating new context file: $context_file_name"
        # Write header
        echo "Folder: $rel_folder" > "$context_file"
        
        # Add folder description if provided
        if [ -n "$folder_description" ]; then
            echo "Desc: $folder_description" >> "$context_file"
        fi
        
        echo "" >> "$context_file"
    fi
    
    # Process each file
    local counter=1
    if [ "$file_exists" = true ]; then
        # Get the last entry number
        counter=$(grep -c "^#" "$context_file" 2>/dev/null || echo 0)
        counter=$((counter + 1))
    fi
    
    for file_path in "${files[@]}"; do
        local file_name=$(basename "$file_path")
        local rel_file_path=$(get_relative_path "$file_path")
        
        # Skip if already in context file
        if [ "$file_exists" = true ] && grep -q "$rel_file_path" "$context_file"; then
            print_info "Skipping already documented file: $file_name"
            continue
        fi
        
        # Show progress
        print_info "Analyzing ($counter/${#files[@]}): $file_name"
        
        # Analyze file based on type
        local description=""
        local type_lower=$(echo "$file_type" | tr '[:upper:]' '[:lower:]')
        
        # Check file type category
        local is_image=false
        local is_font=false
        local is_fx=false
        local is_code=false
        
        for img_type in "${SUPPORTED_IMAGE_TYPES[@]}"; do
            if [ "$type_lower" == "$img_type" ]; then
                is_image=true
                break
            fi
        done
        
        for font_type in "${SUPPORTED_FONT_TYPES[@]}"; do
            if [ "$type_lower" == "$font_type" ]; then
                is_font=true
                break
            fi
        done
        
        for fx_type in "${SUPPORTED_FX_TYPES[@]}"; do
            if [ "$type_lower" == "$fx_type" ]; then
                is_fx=true
                break
            fi
        done
        
        for code_type in "${SUPPORTED_CODE_TYPES[@]}"; do
            if [ "$type_lower" == "$code_type" ]; then
                is_code=true
                break
            fi
        done
        
        # Route to appropriate analyzer
        if [ "$is_image" = true ]; then
            description=$(analyze_image "$file_path" "$file_name" "$folder_description")
        elif [ "$is_font" = true ]; then
            description=$(analyze_font "$file_path" "$file_name" "$file_type" "$folder_description")
        elif [ "$is_code" = true ]; then
            description=$(analyze_code "$file_path" "$file_name" "$file_type" "$folder_description")
        elif [ "$is_fx" = true ]; then
            description=$(analyze_fx "$file_path" "$file_name" "$file_type" "$folder_description")
        elif [[ "$type_lower" == "fbx" || "$type_lower" == "obj" || "$type_lower" == "blend" ]]; then
            description=$(analyze_3d_model "$file_path" "$file_name" "$file_type" "$folder_description")
        else
            # Check if it's a particle system prefab by examining file content
            if [[ "$type_lower" == "prefab" ]]; then
                if grep -q "ParticleSystem" "$file_path" 2>/dev/null; then
                    # It's a particle system prefab, treat as FX
                    description=$(analyze_fx "$file_path" "$file_name" "prefab" "$folder_description")
                else
                    description=$(analyze_unity_text_file "$file_path" "$file_name" "$file_type" "$folder_description")
                fi
            else
                description=$(analyze_unity_text_file "$file_path" "$file_name" "$file_type" "$folder_description")
            fi
        fi
        
        # Write entry to context file
        echo "#$counter." >> "$context_file"
        echo "Url: $rel_file_path" >> "$context_file"
        echo "Desc: $description" >> "$context_file"
        echo "" >> "$context_file"
        
        print_success "Documented: $file_name"
        counter=$((counter + 1))
    done
    
    # Update context index
    update_context_index "$folder_path" "$context_file"
    
    print_success "Context documentation complete: $context_file_name"
}

# Main script
main() {
    print_info "Unity Context Understanding Script"
    print_info "===================================="
    echo ""
    
    # Check arguments
    if [ $# -lt 2 ]; then
        echo "Usage: $0 <folder_path> <file_type> [folder_description] [--docs doc1.md,doc2.md,...]"
        echo ""
        echo "Arguments:"
        echo "  folder_path         - Path to the folder containing files to analyze"
        echo "  file_type          - File extension to analyze (e.g., png, prefab, asset)"
        echo "  folder_description - (Optional) Your understanding of what this folder contains"
        echo "  --docs             - (Optional) Comma-separated list of game docs for context"
        echo ""
        echo "Examples:"
        echo "  $0 Assets/Prefabs/Gems prefab"
        echo "  $0 Assets/Prefabs prefab \"3D models\" --docs GemSystem_Implementation.md,BoardSystem_Documentation.md"
        echo "  $0 Assets/Textures/UI png \"UI sprites\""
        echo "  $0 Assets/VFX/Particles prefab \"Particle effects\" --docs Animation_VFX_Design.md"
        echo "  $0 Assets/Scripts/Board cs \"Match-3 scripts\""
        echo ""
        echo "Supported file types:"
        echo "  Images: ${SUPPORTED_IMAGE_TYPES[*]}"
        echo "  Unity files: ${SUPPORTED_UNITY_TYPES[*]}"
        echo "  Fonts: ${SUPPORTED_FONT_TYPES[*]}"
        echo "  FX: ${SUPPORTED_FX_TYPES[*]} (or prefab with ParticleSystem)"
        echo "  Code: ${SUPPORTED_CODE_TYPES[*]}"
        exit 1
    fi
    
    local folder_path="$1"
    local file_type="$2"
    local folder_description=""
    local docs_param=""
    
    # Parse remaining arguments
    shift 2
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --docs)
                docs_param="$2"
                shift 2
                ;;
            *)
                if [ -z "$folder_description" ]; then
                    folder_description="$1"
                fi
                shift
                ;;
        esac
    done
    
    # Convert relative path to absolute if needed
    if [[ "$folder_path" != /* ]]; then
        folder_path="$PROJECT_ROOT/$folder_path"
    fi
    
    # Ensure context directory exists
    mkdir -p "$CONTEXT_DIR"
    
    # Build game context from documentation
    GAME_CONTEXT_DOCS=$(build_game_context "$docs_param")
    
    # Display folder description if provided
    if [ -n "$folder_description" ]; then
        print_info "Folder context: $folder_description"
    fi
    
    # Process the folder
    process_folder "$folder_path" "$file_type" "$folder_description"
    
    echo ""
    print_success "All done! Context files are in: $CONTEXT_DIR"
}

# Run main function
main "$@"

