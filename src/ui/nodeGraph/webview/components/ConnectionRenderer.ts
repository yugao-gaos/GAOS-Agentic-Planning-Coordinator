// ============================================================================
// ConnectionRenderer - SVG bezier curves with routing knobs
// ============================================================================

/**
 * Get the ConnectionRenderer module code for the webview
 */
export function getConnectionRendererCode(): string {
    return `
// ============================================================================
// ConnectionRenderer - Smooth Bezier curves with routing knobs
// ============================================================================

const ConnectionRenderer = {
    svg: null,
    tempLine: null,
    
    init() {
        this.svg = document.getElementById('connections-svg');
    },
    
    // Check if a connection is interactable based on current view mode
    isConnectionInteractable(dataType) {
        const viewMode = GraphState.viewMode;
        if (viewMode === 'all') return true;
        
        const isExecutionType = dataType === 'trigger' || dataType === 'agent';
        const isDataType = !isExecutionType;
        
        if (viewMode === 'execution') {
            return isExecutionType;
        }
        if (viewMode === 'data') {
            return isDataType;
        }
        return true;
    },
    
    // Render all connections
    renderAll() {
        // Clear existing (except temp line)
        const tempLine = this.tempLine;
        this.svg.innerHTML = '';
        if (tempLine) {
            this.svg.appendChild(tempLine);
        }
        
        if (GraphState.graph && GraphState.graph.connections) {
            for (const conn of GraphState.graph.connections) {
                this.renderConnection(conn);
            }
        }
    },
    
    // Render a single connection
    renderConnection(conn) {
        const fromNode = document.getElementById('node-' + conn.fromNodeId);
        const toNode = document.getElementById('node-' + conn.toNodeId);
        if (!fromNode || !toNode) return;
        
        const fromPort = fromNode.querySelector('[data-port="' + conn.fromPortId + '"]');
        const toPort = toNode.querySelector('[data-port="' + conn.toPortId + '"]');
        if (!fromPort || !toPort) return;
        
        const points = this.getConnectionPoints(fromPort, toPort, conn.reroutes);
        const dataType = fromPort.dataset.type || 'any';
        
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.id = 'conn-' + conn.id;
        path.className.baseVal = 'connection';
        path.dataset.connId = conn.id;
        path.dataset.type = dataType;
        path.setAttribute('d', this.createSmoothPath(points));
        
        // Click to select connection
        path.style.pointerEvents = 'stroke';
        path.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!this.isConnectionInteractable(dataType)) return;
            GraphState.selectConnection(conn.id);
            this.updateConnectionSelection();
        });
        
        // Context menu
        path.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!this.isConnectionInteractable(dataType)) return;
            GraphState.selectConnection(conn.id);
            this.updateConnectionSelection();
            ContextMenu.showConnectionMenu(e.clientX, e.clientY, conn.id);
        });
        
        // Double-click to add reroute point
        path.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            if (!this.isConnectionInteractable(dataType)) return;
            const pos = Canvas.screenToCanvas(e.clientX, e.clientY);
            this.addReroutePoint(conn.id, pos);
        });
        
        this.svg.appendChild(path);
        
        // Render reroute points
        if (conn.reroutes && conn.reroutes.length > 0) {
            for (let i = 0; i < conn.reroutes.length; i++) {
                this.renderReroutePoint(conn.id, i, conn.reroutes[i], dataType);
            }
        }
    },
    
    // Get all points for a connection (start, reroutes, end)
    getConnectionPoints(fromPort, toPort, reroutes) {
        const fromNodeEl = document.getElementById('node-' + fromPort.dataset.node);
        const toNodeEl = document.getElementById('node-' + toPort.dataset.node);
        
        if (!fromNodeEl || !toNodeEl) return [{ x: 0, y: 0 }, { x: 0, y: 0 }];
        
        // Get port positions relative to their nodes
        const fromPortRect = fromPort.getBoundingClientRect();
        const fromNodeRect = fromNodeEl.getBoundingClientRect();
        const toPortRect = toPort.getBoundingClientRect();
        const toNodeRect = toNodeEl.getBoundingClientRect();
        
        // Get node positions from their style (canvas coordinates)
        const fromNodeX = parseFloat(fromNodeEl.style.left) || 0;
        const fromNodeY = parseFloat(fromNodeEl.style.top) || 0;
        const toNodeX = parseFloat(toNodeEl.style.left) || 0;
        const toNodeY = parseFloat(toNodeEl.style.top) || 0;
        
        // Calculate port offset within node (in screen pixels, need to un-scale)
        const fromPortOffsetX = (fromPortRect.left - fromNodeRect.left + fromPortRect.width/2) / GraphState.zoom;
        const fromPortOffsetY = (fromPortRect.top - fromNodeRect.top + fromPortRect.height/2) / GraphState.zoom;
        const toPortOffsetX = (toPortRect.left - toNodeRect.left + toPortRect.width/2) / GraphState.zoom;
        const toPortOffsetY = (toPortRect.top - toNodeRect.top + toPortRect.height/2) / GraphState.zoom;
        
        // Final positions in canvas coordinates
        const x1 = fromNodeX + fromPortOffsetX;
        const y1 = fromNodeY + fromPortOffsetY;
        const x2 = toNodeX + toPortOffsetX;
        const y2 = toNodeY + toPortOffsetY;
        
        // Build points array
        const points = [{ x: x1, y: y1 }];
        
        if (reroutes && reroutes.length > 0) {
            for (const rp of reroutes) {
                points.push({ x: rp.x, y: rp.y });
            }
        }
        
        points.push({ x: x2, y: y2 });
        
        return points;
    },
    
    // Create a smooth path through all points using Bezier curves
    createSmoothPath(points) {
        if (!points || points.length < 2) return '';
        
        // Simple case: direct connection (no reroutes)
        if (points.length === 2) {
            return this.createBezierSegment(points[0], points[1], true, true);
        }
        
        // Multiple points: create smooth curves through each segment
        let d = '';
        
        for (let i = 0; i < points.length - 1; i++) {
            const p1 = points[i];
            const p2 = points[i + 1];
            const isFirst = (i === 0);
            const isLast = (i === points.length - 2);
            
            // Get previous and next points for smooth tangent calculation
            const prev = isFirst ? null : points[i - 1];
            const next = isLast ? null : points[i + 2];
            
            const segment = this.createSmoothSegment(p1, p2, prev, next, isFirst, isLast);
            
            if (isFirst) {
                d = segment;
            } else {
                // Remove the M command from subsequent segments
                d += segment.replace(/^M [\\d.-]+ [\\d.-]+\\s*/, ' ');
            }
        }
        
        return d;
    },
    
    // Create a smooth Bezier segment between two points
    // Uses neighboring points to calculate smooth tangents
    createSmoothSegment(p1, p2, prev, next, isFirst, isLast) {
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        // Base tension for control points (0.3 = smooth, higher = tighter)
        const tension = 0.4;
        const baseDist = Math.max(30, dist * tension);
        
        let cp1x, cp1y, cp2x, cp2y;
        
        if (isFirst) {
            // First segment: exit horizontally from port
            const offset = Math.max(50, Math.min(Math.abs(dx) * 0.5, 150));
            const backwardOffset = dx < 0 ? Math.max(80, Math.abs(dy) * 0.3) : 0;
            cp1x = p1.x + offset + backwardOffset;
            cp1y = p1.y;
        } else if (prev) {
            // Middle segment start: smooth tangent based on previous point
            const tangentX = p2.x - prev.x;
            const tangentY = p2.y - prev.y;
            const tangentLen = Math.sqrt(tangentX * tangentX + tangentY * tangentY);
            if (tangentLen > 0) {
                cp1x = p1.x + (tangentX / tangentLen) * baseDist;
                cp1y = p1.y + (tangentY / tangentLen) * baseDist;
            } else {
                cp1x = p1.x + baseDist;
                cp1y = p1.y;
            }
        } else {
            cp1x = p1.x + baseDist;
            cp1y = p1.y;
        }
        
        if (isLast) {
            // Last segment: enter horizontally into port
            const offset = Math.max(50, Math.min(Math.abs(dx) * 0.5, 150));
            const backwardOffset = dx < 0 ? Math.max(80, Math.abs(dy) * 0.3) : 0;
            cp2x = p2.x - offset - backwardOffset;
            cp2y = p2.y;
        } else if (next) {
            // Middle segment end: smooth tangent based on next point
            const tangentX = p1.x - next.x;
            const tangentY = p1.y - next.y;
            const tangentLen = Math.sqrt(tangentX * tangentX + tangentY * tangentY);
            if (tangentLen > 0) {
                cp2x = p2.x + (tangentX / tangentLen) * baseDist;
                cp2y = p2.y + (tangentY / tangentLen) * baseDist;
            } else {
                cp2x = p2.x - baseDist;
                cp2y = p2.y;
            }
        } else {
            cp2x = p2.x - baseDist;
            cp2y = p2.y;
        }
        
        return \`M \${p1.x} \${p1.y} C \${cp1x} \${cp1y}, \${cp2x} \${cp2y}, \${p2.x} \${p2.y}\`;
    },
    
    // Create a simple Bezier curve between two points (for direct connections)
    createBezierSegment(p1, p2, exitHorizontal, enterHorizontal) {
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        
        const offset = Math.max(50, Math.min(absDx * 0.5, 150));
        const backwardOffset = dx < 0 ? Math.max(100, absDy * 0.5) : 0;
        
        const cp1x = exitHorizontal ? p1.x + offset + backwardOffset : p1.x;
        const cp1y = exitHorizontal ? p1.y : p1.y + offset;
        const cp2x = enterHorizontal ? p2.x - offset - backwardOffset : p2.x;
        const cp2y = enterHorizontal ? p2.y : p2.y - offset;
        
        return \`M \${p1.x} \${p1.y} C \${cp1x} \${cp1y}, \${cp2x} \${cp2y}, \${p2.x} \${p2.y}\`;
    },
    
    // Add a reroute point to a connection
    addReroutePoint(connectionId, pos) {
        const conn = GraphState.getConnection(connectionId);
        if (!conn) return;
        
        if (!conn.reroutes) {
            conn.reroutes = [];
        }
        
        // Find the best position to insert the reroute point
        const fromNode = document.getElementById('node-' + conn.fromNodeId);
        const toNode = document.getElementById('node-' + conn.toNodeId);
        if (!fromNode || !toNode) return;
        
        const fromPort = fromNode.querySelector('[data-port="' + conn.fromPortId + '"]');
        const toPort = toNode.querySelector('[data-port="' + conn.toPortId + '"]');
        if (!fromPort || !toPort) return;
        
        const points = this.getConnectionPoints(fromPort, toPort, conn.reroutes);
        
        // Find which segment the click is closest to
        let bestIndex = conn.reroutes.length; // Default: add at end
        let bestDist = Infinity;
        
        for (let i = 0; i < points.length - 1; i++) {
            const p1 = points[i];
            const p2 = points[i + 1];
            const dist = this.pointToSegmentDistance(pos, p1, p2);
            
            if (dist < bestDist) {
                bestDist = dist;
                bestIndex = i;
            }
        }
        
        // Insert at the best position
        conn.reroutes.splice(bestIndex, 0, { x: pos.x, y: pos.y });
        
        // Re-render
        this.removeConnection(connectionId);
        this.renderConnection(conn);
        
        // Notify
        vscode.postMessage({
            type: 'updateConnection',
            payload: { connectionId, reroutes: conn.reroutes }
        });
    },
    
    // Calculate distance from point to line segment
    pointToSegmentDistance(point, segStart, segEnd) {
        const dx = segEnd.x - segStart.x;
        const dy = segEnd.y - segStart.y;
        const lengthSq = dx * dx + dy * dy;
        
        if (lengthSq === 0) {
            return Math.sqrt(Math.pow(point.x - segStart.x, 2) + Math.pow(point.y - segStart.y, 2));
        }
        
        let t = ((point.x - segStart.x) * dx + (point.y - segStart.y) * dy) / lengthSq;
        t = Math.max(0, Math.min(1, t));
        
        const projX = segStart.x + t * dx;
        const projY = segStart.y + t * dy;
        
        return Math.sqrt(Math.pow(point.x - projX, 2) + Math.pow(point.y - projY, 2));
    },
    
    // Get the loop container that a point is inside (if any)
    getContainingLoopForPoint(x, y) {
        const loopNodes = GraphState.graph?.nodes?.filter(n => n.type === 'for_loop') || [];
        for (const loop of loopNodes) {
            const loopRect = {
                x: loop.position?.x || 0,
                y: (loop.position?.y || 0) + 35, // Below title bar
                width: loop.config?.width || 400,
                height: (loop.config?.height || 250) - 35
            };
            
            if (x > loopRect.x && x < loopRect.x + loopRect.width &&
                y > loopRect.y && y < loopRect.y + loopRect.height) {
                return { loop, rect: loopRect };
            }
        }
        return null;
    },
    
    // Constrain a point to stay within loop container bounds
    constrainToLoopBounds(x, y, loopRect, padding = 10) {
        const minX = loopRect.x + padding;
        const maxX = loopRect.x + loopRect.width - padding;
        const minY = loopRect.y + padding;
        const maxY = loopRect.y + loopRect.height - padding;
        
        return {
            x: Math.max(minX, Math.min(maxX, x)),
            y: Math.max(minY, Math.min(maxY, y))
        };
    },
    
    // Render a reroute point (knob)
    renderReroutePoint(connectionId, index, pos, dataType) {
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.className.baseVal = 'reroute-point';
        circle.id = \`reroute-\${connectionId}-\${index}\`;
        circle.setAttribute('cx', pos.x);
        circle.setAttribute('cy', pos.y);
        circle.setAttribute('r', 6);
        circle.dataset.connId = connectionId;
        circle.dataset.index = index;
        circle.dataset.type = dataType;
        
        // Drag handling
        let isDragging = false;
        let containingLoop = null; // Track if this point started inside a loop
        
        circle.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            if (!this.isConnectionInteractable(dataType)) return;
            isDragging = true;
            
            // Check if this reroute point is inside a loop container at drag start
            containingLoop = this.getContainingLoopForPoint(pos.x, pos.y);
            
            const onDrag = (e) => {
                if (!isDragging) return;
                let newPos = Canvas.screenToCanvas(e.clientX, e.clientY);
                
                // If started inside a loop, constrain movement to that loop
                if (containingLoop) {
                    // Recalculate loop bounds in case the loop was resized
                    const loopRect = {
                        x: containingLoop.loop.position?.x || 0,
                        y: (containingLoop.loop.position?.y || 0) + 35,
                        width: containingLoop.loop.config?.width || 400,
                        height: (containingLoop.loop.config?.height || 250) - 35
                    };
                    newPos = this.constrainToLoopBounds(newPos.x, newPos.y, loopRect);
                }
                
                pos.x = newPos.x;
                pos.y = newPos.y;
                circle.setAttribute('cx', pos.x);
                circle.setAttribute('cy', pos.y);
                
                // Update the connection path
                const conn = GraphState.getConnection(connectionId);
                if (conn && conn.reroutes) {
                    conn.reroutes[index] = { x: pos.x, y: pos.y };
                    const path = document.getElementById('conn-' + connectionId);
                    if (path) {
                        const fromNode = document.getElementById('node-' + conn.fromNodeId);
                        const toNode = document.getElementById('node-' + conn.toNodeId);
                        if (fromNode && toNode) {
                            const fromPort = fromNode.querySelector('[data-port="' + conn.fromPortId + '"]');
                            const toPort = toNode.querySelector('[data-port="' + conn.toPortId + '"]');
                            if (fromPort && toPort) {
                                const points = this.getConnectionPoints(fromPort, toPort, conn.reroutes);
                                path.setAttribute('d', this.createSmoothPath(points));
                            }
                        }
                    }
                }
            };
            
            const onDragEnd = () => {
                isDragging = false;
                containingLoop = null;
                document.removeEventListener('mousemove', onDrag);
                document.removeEventListener('mouseup', onDragEnd);
                
                // Save changes
                const conn = GraphState.getConnection(connectionId);
                if (conn) {
                    vscode.postMessage({
                        type: 'updateConnection',
                        payload: { connectionId, reroutes: conn.reroutes }
                    });
                }
            };
            
            document.addEventListener('mousemove', onDrag);
            document.addEventListener('mouseup', onDragEnd);
        });
        
        // Right-click to delete
        circle.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!this.isConnectionInteractable(dataType)) return;
            
            const conn = GraphState.getConnection(connectionId);
            if (conn && conn.reroutes) {
                conn.reroutes.splice(index, 1);
                this.removeConnection(connectionId);
                this.renderConnection(conn);
                
                vscode.postMessage({
                    type: 'updateConnection',
                    payload: { connectionId, reroutes: conn.reroutes }
                });
            }
        });
        
        this.svg.appendChild(circle);
    },
    
    // Remove connection from DOM
    removeConnection(connectionId) {
        const path = document.getElementById('conn-' + connectionId);
        if (path) path.remove();
        
        // Remove reroute points
        document.querySelectorAll(\`[id^="reroute-\${connectionId}"]\`).forEach(el => el.remove());
    },
    
    // Update all connections
    updateAllConnections() {
        this.renderAll();
    },
    
    // Update connection selection visual
    updateConnectionSelection() {
        document.querySelectorAll('.connection').forEach(path => {
            const connId = path.dataset.connId;
            if (connId === GraphState.selectedConnectionId) {
                path.classList.add('selected');
            } else {
                path.classList.remove('selected');
            }
        });
    },
    
    // Create temporary connection line
    createTempLine() {
        this.tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        this.tempLine.className.baseVal = 'connection connection-temp';
        this.svg.appendChild(this.tempLine);
        return this.tempLine;
    },
    
    // Update temporary connection line
    updateTempLine(x1, y1, x2, y2, dataType) {
        if (!this.tempLine) return;
        this.tempLine.setAttribute('d', this.createSmoothPath([{ x: x1, y: y1 }, { x: x2, y: y2 }]));
        this.tempLine.dataset.type = dataType || 'any';
    },
    
    // Remove temporary connection line
    removeTempLine() {
        if (this.tempLine) {
            this.tempLine.remove();
            this.tempLine = null;
        }
    }
};
`;
}

