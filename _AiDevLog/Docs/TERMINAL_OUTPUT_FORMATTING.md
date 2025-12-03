# Terminal Output Formatting Improvements

## Overview
Enhanced the agent terminal output to be more readable by:
1. **Filtering out raw JSON** - No more escaped JSON strings with `\\\\\` in the output
2. **Smart text formatting** - Preserves markdown structure (headers, lists, code blocks)
3. **Sentence breaks** - Long paragraphs are broken at sentence boundaries for readability

## Changes Made

### 1. Filter Raw JSON from Terminal Output
**File**: `src/services/CursorAgentRunner.ts`

**Problem**: When JSON parsing failed, the entire JSON line (with heavily escaped characters) was being dumped to the log file, resulting in unreadable output like:
```
\\\\\\\"type\\\\\\\":\\\\\\\"implementation\\\\\\\",...
```

**Solution**: Modified the `catch` blocks in `parseLine()` and `parseLineSimple()` to skip logging lines that look like JSON:
- Only log lines that don't start with `{` or `"`
- This prevents raw JSON from cluttering the terminal

### 2. Markdown-Aware Text Formatting
**Added**: New `formatTextForTerminal()` method

**Features**:
- **Preserves headers**: Markdown headers (`#`, `##`, `###`) remain intact
- **Preserves bullet lists**: Lists with `-`, `*`, `•`, or numbered items stay formatted
- **Preserves code blocks**: Code starting with ` ``` ` or indented 4 spaces is kept as-is
- **Preserves empty lines**: Whitespace structure is maintained
- **Smart sentence breaks**: Long paragraphs (>80 chars) get line breaks after:
  - Periods followed by capital letters: `. A` → `.\nA`
  - Exclamation/question marks: `! A` or `? A` → `!\nA` or `?\nA`

### 3. Applied Formatting to All Text Output Locations
Updated text logging in:
- **Normal mode** (`parseLine`): Commentary and plan content
- **Simple mode** (`parseLineSimple`): Coordinator output
- **Final results**: Agent final responses

## Example Before/After

### Before:
```
\\\\\\\"type\\\\\\\":\\\\\\\"implementation\\\\\\\", \\\\\\\"description\\\\\\\": \\\\\\\"Implement match detection and special gem spawning in MatchProcessorService with chain reaction support\\\\\\\\
```

### After:
```
💭 Analyzing the task requirements.
The system needs to handle match detection properly.
I'll implement this in three steps:
- First, detect matching gems
- Second, process chain reactions
- Third, spawn special gems
```

## Benefits

1. **Clean terminal output** - No more JSON noise
2. **Better readability** - Text flows naturally with proper breaks
3. **Markdown support** - Lists, headers, and code blocks display correctly
4. **Professional appearance** - Output looks like a conversation, not debug logs

## Testing

To test the improvements:
1. Start any agent task
2. Open the agent's terminal (🔧 icon)
3. Observe:
   - Clean, formatted text
   - No escaped JSON strings
   - Proper line breaks and structure
   - Bullet lists and headers preserved

## Technical Notes

- The formatting function is lightweight and runs on each chunk of output
- Original content is preserved; only display formatting changes
- Handles both streaming (cumulative) and non-streaming text
- Works for both coordinator (simple mode) and agent (normal mode) output

