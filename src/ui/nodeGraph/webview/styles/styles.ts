// ============================================================================
// Node Graph Editor Styles
// ============================================================================

/**
 * Get all CSS styles for the node graph editor webview
 */
export function getStyles(): string {
    return `
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            overflow: hidden;
            user-select: none;
        }
        
        .editor-container {
            display: flex;
            flex-direction: column;
            height: 100vh;
        }
        
        /* ================================================================
         * Toolbar
         * ================================================================ */
        .toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            background: var(--vscode-titleBar-activeBackground);
            border-bottom: 1px solid var(--vscode-panel-border);
            gap: 8px;
        }
        
        .toolbar-left, .toolbar-right, .toolbar-center {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        
        .toolbar-center {
            flex: 1;
            justify-content: center;
        }
        
        .toolbar button {
            padding: 4px 12px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        
        .toolbar button:hover:not(:disabled) {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        
        .toolbar button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .toolbar button.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        
        .toolbar .separator {
            width: 1px;
            height: 20px;
            background: var(--vscode-panel-border);
            margin: 0 4px;
        }
        
        .toolbar input[type="text"] {
            padding: 4px 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            width: 180px;
        }
        
        .toolbar .dropdown {
            position: relative;
        }
        
        .toolbar .dropdown-content {
            display: none;
            position: absolute;
            top: 100%;
            left: 0;
            background: var(--vscode-dropdown-background);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 4px;
            min-width: 150px;
            z-index: 1000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        }
        
        .toolbar .dropdown:hover .dropdown-content,
        .toolbar .dropdown.open .dropdown-content {
            display: block;
        }
        
        .toolbar .dropdown-item {
            padding: 6px 12px;
            cursor: pointer;
            font-size: 12px;
        }
        
        .toolbar .dropdown-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        
        .toolbar .dropdown-divider {
            height: 1px;
            background: var(--vscode-panel-border);
            margin: 4px 0;
        }
        
        .view-mode-toggle {
            display: flex;
            background: var(--vscode-input-background);
            border-radius: 4px;
            overflow: hidden;
            border: 1px solid var(--vscode-input-border);
        }
        
        .view-mode-btn {
            padding: 4px 12px !important;
            background: transparent !important;
            border: none !important;
            border-radius: 0 !important;
            font-size: 11px !important;
            color: var(--vscode-descriptionForeground) !important;
            cursor: pointer;
            transition: all 0.15s ease;
        }
        
        .view-mode-btn:hover:not(.active) {
            background: var(--vscode-list-hoverBackground) !important;
            color: var(--vscode-foreground) !important;
        }
        
        .view-mode-btn.active {
            background: var(--vscode-button-background) !important;
            color: var(--vscode-button-foreground) !important;
        }
        
        .view-mode-btn + .view-mode-btn {
            border-left: 1px solid var(--vscode-input-border);
        }
        
        .zoom-control {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        
        .zoom-control input[type="range"] {
            width: 80px;
            cursor: pointer;
        }
        
        .zoom-display {
            min-width: 45px;
            text-align: center;
            font-size: 11px;
            cursor: pointer;
        }
        
        /* ================================================================
         * Main Content Layout
         * ================================================================ */
        .main-content {
            display: flex;
            flex: 1;
            overflow: hidden;
        }
        
        /* ================================================================
         * Node Palette
         * ================================================================ */
        .palette {
            width: 180px;
            background: var(--vscode-sideBar-background);
            border-right: 1px solid var(--vscode-panel-border);
            display: flex;
            flex-direction: column;
        }
        
        .palette-header, .properties-header {
            padding: 8px 12px;
            font-weight: 600;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            background: var(--vscode-sideBarSectionHeader-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        
        .palette-search {
            display: none; /* Hidden for now */
            padding: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        
        .palette-search input {
            width: 100%;
            padding: 6px 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-size: 12px;
        }
        
        .palette-content {
            flex: 1;
            overflow-y: auto;
            padding: 10px;
            scrollbar-width: none; /* Firefox */
            -ms-overflow-style: none; /* IE/Edge */
        }
        
        .palette-content::-webkit-scrollbar {
            display: none; /* Chrome/Safari */
        }
        
        .palette-category {
            margin-bottom: 14px;
        }
        
        .category-header {
            font-size: 9px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
            padding: 0;
            opacity: 0.7;
        }
        
        .palette-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 6px;
        }
        
        .palette-node {
            aspect-ratio: 1;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 8px;
            cursor: grab;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.15s ease;
        }
        
        .palette-node:hover {
            background: var(--vscode-button-background);
            border-color: var(--vscode-button-background);
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        }
        
        .palette-node:active {
            transform: translateY(0);
            cursor: grabbing;
        }
        
        .palette-node.dragging {
            opacity: 0.5;
        }
        
        .palette-node.hidden {
            display: none;
        }
        
        .palette-icon {
            width: 22px;
            height: 22px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .palette-icon svg {
            width: 100%;
            height: 100%;
            fill: currentColor;
            opacity: 0.85;
        }
        
        .palette-node:hover .palette-icon svg {
            opacity: 1;
        }
        
        /* ================================================================
         * Canvas
         * ================================================================ */
        .canvas-container {
            flex: 1;
            position: relative;
            overflow: hidden;
            background: var(--vscode-editor-background);
            background-image: 
                linear-gradient(rgba(128,128,128,0.1) 1px, transparent 1px),
                linear-gradient(90deg, rgba(128,128,128,0.1) 1px, transparent 1px);
            background-size: 20px 20px;
        }
        
        .connections-layer {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            overflow: visible;
            transform-origin: 0 0;
            z-index: 1; /* Above loop containers (z-index: 0), below regular nodes (z-index: 2) */
        }
        
        .nodes-layer {
            position: absolute;
            top: 0;
            left: 0;
            transform-origin: 0 0;
        }
        
        /* Selection box */
        .selection-box {
            position: absolute;
            border: 1px dashed var(--vscode-focusBorder);
            background: rgba(0, 120, 212, 0.1);
            pointer-events: none;
            z-index: 1000;
        }
        
        /* ================================================================
         * Nodes
         * ================================================================ */
        .node {
            position: absolute;
            min-width: 150px;
            background: var(--vscode-editor-background);
            border: 2px solid var(--vscode-panel-border);
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            cursor: move;
            transition: box-shadow 0.15s ease;
            z-index: 2; /* Regular nodes above connections (z-index: 1) and loop containers (z-index: 0) */
        }
        
        .node:hover {
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        }
        
        .node.selected {
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 0 0 2px var(--vscode-focusBorder);
        }
        
        .node.dragging {
            opacity: 0.8;
            z-index: 100;
        }
        
        .node-header {
            padding: 8px 12px;
            background: var(--vscode-badge-background);
            border-radius: 6px 6px 0 0;
            font-weight: 600;
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .node-header-icon {
            flex-shrink: 0;
        }
        
        .node-header-title {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        
        .node-lock-btn {
            flex-shrink: 0;
            cursor: pointer;
            opacity: 0.4;
            transition: opacity 0.15s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 2px;
            border-radius: 3px;
        }
        
        .node-lock-btn:hover {
            opacity: 0.8;
            background: rgba(255,255,255,0.1);
        }
        
        .node-lock-btn.locked {
            opacity: 1;
            color: var(--vscode-inputValidation-warningBorder, #f0ad4e);
        }
        
        .node.locked {
            cursor: default;
        }
        
        .node-body {
            padding: 8px 0;
        }
        
        .node-port {
            display: flex;
            align-items: center;
            padding: 4px 12px;
            font-size: 11px;
        }
        
        .node-port.input {
            justify-content: flex-start;
        }
        
        .node-port.output {
            justify-content: flex-end;
        }
        
        /* Port dots with type colors */
        .port-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: var(--vscode-badge-background);
            border: 2px solid var(--vscode-foreground);
            cursor: crosshair;
            transition: transform 0.1s ease, background 0.1s ease;
        }
        
        .port-dot:hover {
            transform: scale(1.3);
            background: var(--vscode-focusBorder);
        }
        
        .port-dot.compatible {
            background: #4CAF50;
            box-shadow: 0 0 6px #4CAF50;
            animation: pulse 1s infinite;
        }
        
        .port-dot.incompatible {
            opacity: 0.3;
        }
        
        @keyframes pulse {
            0%, 100% { box-shadow: 0 0 6px #4CAF50; }
            50% { box-shadow: 0 0 12px #4CAF50; }
        }
        
        .port-dot.input {
            margin-right: 6px;
        }
        
        .port-dot.output {
            margin-left: 6px;
        }
        
        /* Port type colors - matching connection colors */
        
        /* Trigger ports - Arrow icon style (execution flow) */
        .port-dot[data-type="trigger"] { 
            width: 14px;
            height: 14px;
            border: none;
            border-radius: 2px;
            background: transparent;
            color: #10b981;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .port-dot[data-type="trigger"] svg {
            width: 14px;
            height: 14px;
        }
        
        .port-dot[data-type="trigger"]:hover {
            color: #34d399;
            transform: scale(1.2);
            filter: drop-shadow(0 0 3px rgba(16, 185, 129, 0.6));
        }
        
        .port-dot[data-type="trigger"].compatible {
            color: #34d399;
            filter: drop-shadow(0 0 6px rgba(16, 185, 129, 0.8));
        }
        
        /* Data ports - Circle style with colored fill matching connection line colors */
        .port-dot[data-type="string"] { border-color: #4CAF50; background: #4CAF50; }
        .port-dot[data-type="number"] { border-color: #3b82f6; background: #3b82f6; }
        .port-dot[data-type="boolean"] { border-color: #a855f7; background: #a855f7; }
        .port-dot[data-type="object"] { border-color: #78909C; background: #78909C; }
        .port-dot[data-type="array"] { border-color: #06b6d4; background: #06b6d4; }
        .port-dot[data-type="any"] { border-color: #9CA3AF; background: #9CA3AF; }
        .port-dot[data-type="agent"] { border-color: #ec4899; background: #ec4899; }
        
        /* ================================================================
         * Comment Nodes (sticky note style)
         * ================================================================ */
        .node-comment {
            min-width: auto !important;
            border: none !important;
            box-shadow: 2px 2px 8px rgba(0,0,0,0.3) !important;
        }
        
        .node-comment.selected {
            box-shadow: 0 0 0 2px var(--vscode-focusBorder), 2px 2px 8px rgba(0,0,0,0.3) !important;
        }
        
        /* ================================================================
         * Group Nodes (frame style)
         * ================================================================ */
        .node-group {
            min-width: auto !important;
            box-shadow: none !important;
            z-index: -1;
        }
        
        .node-group.selected {
            box-shadow: 0 0 0 2px var(--vscode-focusBorder) !important;
        }
        
        /* ================================================================
         * Loop Container Nodes
         * ================================================================ */
        .node-loop {
            min-width: 250px;
            min-height: 150px;
            background: var(--vscode-editor-background);
            border: 2px solid var(--vscode-panel-border);
            border-radius: 8px;
            display: flex;
            flex-direction: column;
            overflow: visible;
            z-index: 0 !important; /* Render behind regular nodes (which are z-index: 1) */
        }
        
        .node-loop.selected {
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 0 0 2px var(--vscode-focusBorder);
        }
        
        .node-loop.locked {
            cursor: default;
        }
        
        /* Title bar */
        .loop-title-bar {
            padding: 8px 12px;
            font-weight: 600;
            font-size: 12px;
            color: #fff;
            display: flex;
            align-items: center;
            gap: 6px;
            border-radius: 6px 6px 0 0;
            cursor: move;
        }
        
        .loop-title {
            flex: 1;
        }
        
        .loop-title-bar .node-header-icon svg {
            width: 14px;
            height: 14px;
            fill: currentColor;
        }
        
        /* External ports bar - between title and container */
        .loop-ports-bar {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            padding: 8px 4px;
            background: var(--vscode-editor-background);
            border-bottom: 1px solid;
            border-color: inherit;
        }
        
        .loop-external-inputs {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        
        .loop-external-outputs {
            display: flex;
            flex-direction: column;
            gap: 4px;
            align-items: flex-end;
        }
        
        .loop-ports-bar .node-port {
            font-size: 10px;
            padding: 2px 4px;
        }
        
        /* Container area - where loop body nodes go */
        .loop-container-area {
            flex: 1;
            margin: 8px;
            border: 2px dashed;
            border-radius: 6px;
            position: relative;
            background: transparent;
            min-height: 80px;
            pointer-events: none; /* Allow clicking through to nodes behind */
        }
        
        /* But internal ports should be clickable */
        .loop-internal-ports {
            pointer-events: auto;
        }
        
        /* Internal ports - positioned inside the container */
        .loop-internal-ports {
            position: absolute;
            display: flex;
            flex-direction: column;
            gap: 8px;
            top: 50%;
            transform: translateY(-50%);
        }
        
        .loop-internal-left {
            left: 8px;
        }
        
        .loop-internal-right {
            right: 8px;
        }
        
        .loop-internal-ports .node-port {
            background: rgba(0, 150, 136, 0.2);
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 10px;
            border: 1px solid rgba(0, 150, 136, 0.4);
        }
        
        .loop-internal-ports .node-port:hover {
            background: rgba(0, 150, 136, 0.35);
        }
        
        /* Resize handle */
        .loop-resize-handle {
            position: absolute;
            bottom: 2px;
            right: 2px;
            width: 16px;
            height: 16px;
            cursor: nwse-resize;
            color: var(--vscode-descriptionForeground);
            opacity: 0.5;
            display: flex;
            align-items: center;
            justify-content: center;
            pointer-events: auto;
        }
        
        .loop-resize-handle:hover {
            opacity: 1;
        }
        
        .node-loop:hover .loop-resize-handle {
            opacity: 0.7;
        }
        
        /* ================================================================
         * Connections
         * ================================================================ */
        .connection {
            fill: none;
            stroke: var(--vscode-foreground);
            stroke-width: 2;
            stroke-dasharray: 6, 4;
            pointer-events: stroke;
            cursor: pointer;
        }
        
        .connection:hover {
            stroke-width: 3;
            stroke-dasharray: 8, 4;
        }
        
        .connection.selected {
            stroke: var(--vscode-focusBorder);
            stroke-width: 3;
        }
        
        .connection-temp {
            stroke: var(--vscode-focusBorder);
            stroke-dasharray: 5, 5;
            pointer-events: none;
        }
        
        /* Trigger/Execution flow - GREEN, SOLID, THICK */
        .connection[data-type="trigger"] { 
            stroke: #10b981;
            stroke-width: 3;
            stroke-dasharray: none;
        }
        .connection[data-type="trigger"]:hover {
            stroke-width: 4;
            filter: drop-shadow(0 0 4px rgba(16, 185, 129, 0.5));
        }
        
        /* Data connections - colored, dashed */
        .connection[data-type="string"] { stroke: #4CAF50; }
        .connection[data-type="number"] { stroke: #3b82f6; }
        .connection[data-type="boolean"] { stroke: #a855f7; }
        .connection[data-type="object"] { stroke: #78909C; }
        .connection[data-type="array"] { stroke: #06b6d4; }
        .connection[data-type="any"] { stroke: #9CA3AF; }
        
        /* Agent connections - SOLID, pink */
        .connection[data-type="agent"] { 
            stroke: #ec4899;
            stroke-width: 3;
            stroke-dasharray: none;
        }
        .connection[data-type="agent"]:hover {
            stroke-width: 4;
            filter: drop-shadow(0 0 4px rgba(236, 72, 153, 0.5));
        }
        
        /* ================================================================
         * View Mode Filtering
         * ================================================================ */
        
        /* Execution mode - grey out data connections/ports */
        .view-mode-execution .connection[data-type="string"],
        .view-mode-execution .connection[data-type="number"],
        .view-mode-execution .connection[data-type="boolean"],
        .view-mode-execution .connection[data-type="object"],
        .view-mode-execution .connection[data-type="array"],
        .view-mode-execution .connection[data-type="any"] {
            stroke: #555 !important;
            opacity: 0.3;
            pointer-events: none !important;
            cursor: default;
        }
        
        .view-mode-execution .port-dot[data-type="string"],
        .view-mode-execution .port-dot[data-type="number"],
        .view-mode-execution .port-dot[data-type="boolean"],
        .view-mode-execution .port-dot[data-type="object"],
        .view-mode-execution .port-dot[data-type="array"],
        .view-mode-execution .port-dot[data-type="any"] {
            border-color: #555 !important;
            opacity: 0.3;
            pointer-events: none;
            cursor: default;
        }
        
        /* Grey out port labels in execution mode */
        .view-mode-execution .port-dot[data-type="string"] + span,
        .view-mode-execution .port-dot[data-type="number"] + span,
        .view-mode-execution .port-dot[data-type="boolean"] + span,
        .view-mode-execution .port-dot[data-type="object"] + span,
        .view-mode-execution .port-dot[data-type="array"] + span,
        .view-mode-execution .port-dot[data-type="any"] + span,
        .view-mode-execution span:has(+ .port-dot[data-type="string"]),
        .view-mode-execution span:has(+ .port-dot[data-type="number"]),
        .view-mode-execution span:has(+ .port-dot[data-type="boolean"]),
        .view-mode-execution span:has(+ .port-dot[data-type="object"]),
        .view-mode-execution span:has(+ .port-dot[data-type="array"]),
        .view-mode-execution span:has(+ .port-dot[data-type="any"]) {
            color: #555 !important;
            opacity: 0.3;
        }
        
        /* Data mode - grey out trigger and agent connections/ports */
        .view-mode-data .connection[data-type="trigger"],
        .view-mode-data .connection[data-type="agent"] {
            stroke: #555 !important;
            opacity: 0.3;
            pointer-events: none !important;
            cursor: default;
        }
        
        .view-mode-data .port-dot[data-type="trigger"],
        .view-mode-data .port-dot[data-type="agent"] {
            border-color: #555 !important;
            opacity: 0.3;
            pointer-events: none;
            cursor: default;
        }
        
        .view-mode-data .port-dot[data-type="trigger"] svg {
            color: #555 !important;
            opacity: 0.3;
        }
        
        /* Grey out port labels in data mode */
        .view-mode-data .port-dot[data-type="trigger"] + span,
        .view-mode-data .port-dot[data-type="agent"] + span,
        .view-mode-data span:has(+ .port-dot[data-type="trigger"]),
        .view-mode-data span:has(+ .port-dot[data-type="agent"]) {
            color: #555 !important;
            opacity: 0.3;
        }
        
        /* Reroute points */
        .reroute-point {
            fill: #9CA3AF;
            stroke: var(--vscode-editor-background);
            stroke-width: 2;
            cursor: move;
            pointer-events: all;
        }
        
        .reroute-point:hover {
            filter: brightness(1.3);
            stroke-width: 4;
        }
        
        /* Reroute point colors matching connection types */
        .reroute-point[data-type="trigger"] { fill: #10b981; }
        .reroute-point[data-type="agent"] { fill: #ec4899; }
        .reroute-point[data-type="string"] { fill: #4CAF50; }
        .reroute-point[data-type="number"] { fill: #3b82f6; }
        .reroute-point[data-type="boolean"] { fill: #a855f7; }
        .reroute-point[data-type="object"] { fill: #78909C; }
        .reroute-point[data-type="array"] { fill: #06b6d4; }
        .reroute-point[data-type="any"] { fill: #9CA3AF; }
        
        /* Execution mode - grey out data reroute points */
        .view-mode-execution .reroute-point[data-type="string"],
        .view-mode-execution .reroute-point[data-type="number"],
        .view-mode-execution .reroute-point[data-type="boolean"],
        .view-mode-execution .reroute-point[data-type="object"],
        .view-mode-execution .reroute-point[data-type="array"],
        .view-mode-execution .reroute-point[data-type="any"] {
            fill: #555 !important;
            opacity: 0.3;
            pointer-events: none !important;
            cursor: default;
        }
        
        /* Data mode - grey out trigger/agent reroute points */
        .view-mode-data .reroute-point[data-type="trigger"],
        .view-mode-data .reroute-point[data-type="agent"] {
            fill: #555 !important;
            opacity: 0.3;
            pointer-events: none !important;
            cursor: default;
        }
        
        /* ================================================================
         * Properties Panel
         * ================================================================ */
        .properties {
            width: 280px;
            background: var(--vscode-sideBar-background);
            border-left: 1px solid var(--vscode-panel-border);
            display: flex;
            flex-direction: column;
        }
        
        .properties-tabs {
            display: flex;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        
        .properties-tab {
            flex: 1;
            padding: 8px;
            text-align: center;
            cursor: pointer;
            font-size: 12px;
            background: transparent;
            border: none;
            color: var(--vscode-foreground);
        }
        
        .properties-tab:hover {
            background: var(--vscode-list-hoverBackground);
        }
        
        .properties-tab.active {
            background: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }
        
        .properties-content {
            flex: 1;
            overflow-y: auto;
            padding: 12px;
        }
        
        .properties-content .placeholder {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            text-align: center;
            padding: 20px;
        }
        
        .property-group {
            margin-bottom: 16px;
        }
        
        .property-label {
            font-size: 11px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }
        
        .property-description {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
            font-style: italic;
        }
        
        .property-input {
            width: 100%;
            padding: 6px 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-size: 12px;
            font-family: inherit;
        }
        
        .property-input:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }
        
        .property-input[readonly] {
            opacity: 0.7;
        }
        
        textarea.property-input {
            min-height: 80px;
            resize: vertical;
            font-family: var(--vscode-editor-font-family, monospace);
        }
        
        select.property-input {
            cursor: pointer;
        }
        
        input[type="checkbox"].property-input {
            width: auto;
            margin-right: 8px;
        }
        
        .property-row {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .btn-delete {
            padding: 8px;
            background: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-inputValidation-errorForeground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            width: 100%;
            font-size: 12px;
        }
        
        .btn-delete:hover {
            opacity: 0.9;
        }
        
        /* ================================================================
         * Context Menu
         * ================================================================ */
        .context-menu {
            position: fixed;
            background: var(--vscode-menu-background);
            border: 1px solid var(--vscode-menu-border);
            border-radius: 4px;
            min-width: 180px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 10000;
            padding: 4px 0;
        }
        
        .context-menu-item {
            padding: 6px 12px;
            cursor: pointer;
            font-size: 12px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            color: var(--vscode-menu-foreground);
        }
        
        .context-menu-item:hover {
            background: var(--vscode-menu-selectionBackground);
            color: var(--vscode-menu-selectionForeground);
        }
        
        .context-menu-item.disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .context-menu-item .shortcut {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            margin-left: 20px;
        }
        
        .context-menu-divider {
            height: 1px;
            background: var(--vscode-menu-separatorBackground);
            margin: 4px 0;
        }
        
        .context-menu-submenu {
            position: relative;
        }
        
        .context-menu-submenu::after {
            content: "▶";
            font-size: 8px;
        }
        
        .context-menu-submenu .context-menu {
            display: none;
            position: absolute;
            left: 100%;
            top: 0;
        }
        
        .context-menu-submenu:hover .context-menu {
            display: block;
        }
        
        /* ================================================================
         * Quick Add Modal (Ctrl+P)
         * ================================================================ */
        .quick-add-modal {
            position: fixed;
            top: 20%;
            left: 50%;
            transform: translateX(-50%);
            width: 400px;
            background: var(--vscode-quickInput-background);
            border: 1px solid var(--vscode-contrastBorder);
            border-radius: 6px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.4);
            z-index: 10000;
        }
        
        .quick-add-input {
            width: 100%;
            padding: 12px;
            background: transparent;
            border: none;
            border-bottom: 1px solid var(--vscode-panel-border);
            color: var(--vscode-foreground);
            font-size: 14px;
        }
        
        .quick-add-input:focus {
            outline: none;
        }
        
        .quick-add-list {
            max-height: 300px;
            overflow-y: auto;
        }
        
        .quick-add-item {
            padding: 8px 12px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .quick-add-item:hover,
        .quick-add-item.selected {
            background: var(--vscode-list-hoverBackground);
        }
        
        .quick-add-item .category {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            background: var(--vscode-badge-background);
            padding: 2px 6px;
            border-radius: 3px;
        }
        
        /* ================================================================
         * Minimap
         * ================================================================ */
        .minimap {
            position: absolute;
            bottom: 20px;
            right: 20px;
            width: 180px;
            height: 120px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            overflow: hidden;
            z-index: 100;
        }
        
        .minimap.hidden {
            display: none;
        }
        
        .minimap-content {
            position: relative;
            width: 100%;
            height: 100%;
        }
        
        .minimap-node {
            position: absolute;
            background: var(--vscode-badge-background);
            border-radius: 2px;
            min-width: 4px;
            min-height: 3px;
        }
        
        .minimap-viewport {
            position: absolute;
            border: 2px solid var(--vscode-focusBorder);
            background: rgba(0, 120, 212, 0.1);
            cursor: move;
        }
        
        /* ================================================================
         * Status Bar
         * ================================================================ */
        .status-bar {
            display: flex;
            align-items: center;
            gap: 20px;
            padding: 4px 12px;
            background: var(--vscode-statusBar-background);
            color: var(--vscode-statusBar-foreground);
            font-size: 12px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        
        .status-bar .status-item {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        
        .status-bar .validation-badge {
            background: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-inputValidation-errorForeground);
            padding: 1px 6px;
            border-radius: 10px;
            font-size: 10px;
            cursor: pointer;
        }
        
        /* ================================================================
         * Validation Panel
         * ================================================================ */
        .validation-panel {
            position: absolute;
            bottom: 40px;
            left: 210px;
            right: 290px;
            max-height: 200px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            box-shadow: 0 -2px 8px rgba(0,0,0,0.2);
            overflow: hidden;
            z-index: 50;
        }
        
        .validation-panel.hidden {
            display: none;
        }
        
        .validation-header {
            padding: 8px 12px;
            background: var(--vscode-inputValidation-errorBackground);
            font-weight: 600;
            font-size: 12px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        
        .validation-list {
            max-height: 160px;
            overflow-y: auto;
        }
        
        .validation-item {
            padding: 6px 12px;
            font-size: 12px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .validation-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        
        .validation-item .icon {
            color: var(--vscode-inputValidation-errorForeground);
        }
        
        /* ================================================================
         * Breadcrumb
         * ================================================================ */
        .breadcrumb {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 4px 12px;
            background: var(--vscode-breadcrumb-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 12px;
        }
        
        .breadcrumb.hidden {
            display: none;
        }
        
        .breadcrumb-item {
            cursor: pointer;
            color: var(--vscode-breadcrumb-foreground);
        }
        
        .breadcrumb-item:hover {
            color: var(--vscode-breadcrumb-focusForeground);
            text-decoration: underline;
        }
        
        .breadcrumb-separator {
            color: var(--vscode-breadcrumb-foreground);
            opacity: 0.6;
        }
        
        /* ================================================================
         * Animations
         * ================================================================ */
        .node.animating {
            transition: left 0.3s ease, top 0.3s ease;
        }
        
        /* ================================================================
         * Expression Autocomplete
         * ================================================================ */
        .autocomplete-dropdown {
            position: absolute;
            background: var(--vscode-editorSuggestWidget-background);
            border: 1px solid var(--vscode-editorSuggestWidget-border);
            border-radius: 4px;
            max-height: 200px;
            overflow-y: auto;
            z-index: 10000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        }
        
        .autocomplete-item {
            padding: 6px 10px;
            cursor: pointer;
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .autocomplete-item:hover,
        .autocomplete-item.selected {
            background: var(--vscode-editorSuggestWidget-selectedBackground);
        }
        
        .autocomplete-item .type {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
        }
        
        /* Template syntax highlighting */
        .template-highlight {
            color: var(--vscode-symbolIcon-variableForeground, #75beff);
        }
    `;
}

