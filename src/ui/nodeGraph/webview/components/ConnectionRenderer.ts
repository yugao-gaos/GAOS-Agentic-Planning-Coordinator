// ============================================================================
// ConnectionRenderer - SVG bezier curves, validation colors
// ============================================================================

/**
 * Get the ConnectionRenderer module code for the webview
 */
export function getConnectionRendererCode(): string {
    return `
// ============================================================================
// ConnectionRenderer - Connection rendering and management
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
        path.setAttribute('d', this.createBezierPath(points));
        
        // Click to select connection
        path.style.pointerEvents = 'stroke';
        path.addEventListener('click', (e) => {
            e.stopPropagation();
            // Check if connection is interactable based on view mode
            if (!this.isConnectionInteractable(dataType)) return;
            GraphState.selectConnection(conn.id);
            this.updateConnectionSelection();
        });
        
        // Context menu
        path.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            // Check if connection is interactable based on view mode
            if (!this.isConnectionInteractable(dataType)) return;
            GraphState.selectConnection(conn.id);
            this.updateConnectionSelection();
            ContextMenu.showConnectionMenu(e.clientX, e.clientY, conn.id);
        });
        
        // Double-click to add reroute point
        path.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            // Check if connection is interactable based on view mode
            if (!this.isConnectionInteractable(dataType)) return;
            const pos = Canvas.screenToCanvas(e.clientX, e.clientY);
            this.addReroutePoint(conn.id, pos);
        });
        
        this.svg.appendChild(path);
        
        // Render reroute points
        if (conn.reroutes && conn.reroutes.length > 0) {
            for (let i = 0; i < conn.reroutes.length; i++) {
                this.renderReroutePoint(conn.id, i, conn.reroutes[i]);
            }
        }
    },
    
    // Get connection endpoint coordinates
    getConnectionPoints(fromPort, toPort, reroutes) {
        // Get node elements
        const fromNodeId = fromPort.dataset.node;
        const toNodeId = toPort.dataset.node;
        const fromNodeEl = document.getElementById('node-' + fromNodeId);
        const toNodeEl = document.getElementById('node-' + toNodeId);
        
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
        
        const points = [{ x: x1, y: y1 }];
        
        if (reroutes && reroutes.length > 0) {
            for (const rp of reroutes) {
                points.push({ x: rp.x, y: rp.y });
            }
        }
        
        points.push({ x: x2, y: y2 });
        
        return points;
    },
    
    // Create orthogonal path with 90-degree turns and rounded corners
    createBezierPath(points) {
        const radius = 8; // Corner radius
        
        if (points.length === 2) {
            const [p1, p2] = points;
            return this.createOrthogonalSegment(p1, p2, radius, true, true);
        }
        
        // Multi-point path through reroutes
        let d = '';
        
        for (let i = 0; i < points.length - 1; i++) {
            const p1 = points[i];
            const p2 = points[i + 1];
            const isFirst = i === 0;
            const isLast = i === points.length - 2;
            
            const segment = this.createOrthogonalSegment(p1, p2, radius, isFirst, isLast);
            
            if (isFirst) {
                d = segment;
            } else {
                // Connect from previous endpoint - skip the M command
                d += segment.replace(/^M [\\d.-]+ [\\d.-]+/, '');
            }
        }
        
        return d;
    },
    
    // Create a single orthogonal segment between two points
    // exitHorizontal: true if this is the first segment (must exit right from output port)
    // enterHorizontal: true if this is the last segment (must enter left into input port)
    createOrthogonalSegment(p1, p2, radius, exitHorizontal, enterHorizontal) {
        const MIN_EXTRUSION = 15; // Minimum horizontal extrusion from node edge
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        
        // Clamp radius
        const r = Math.min(radius, 8);
        
        // Start path
        let d = \`M \${p1.x} \${p1.y}\`;
        
        // For middle segments (reroute to reroute), use simpler routing
        if (!exitHorizontal && !enterHorizontal) {
            // Simple L-shaped or direct connection between reroutes
            if (absDx < 4 || absDy < 4) {
                d += \` L \${p2.x} \${p2.y}\`;
            } else {
                // L-shape: go horizontal first, then vertical
                const effectiveR = Math.min(r, absDx / 2, absDy / 2);
                const signX = dx > 0 ? 1 : -1;
                const signY = dy > 0 ? 1 : -1;
                d += \` L \${p2.x - effectiveR * signX} \${p1.y}\`;
                d += \` Q \${p2.x} \${p1.y}, \${p2.x} \${p1.y + effectiveR * signY}\`;
                d += \` L \${p2.x} \${p2.y}\`;
            }
            return d;
        }
        
        // For first segment only (output to reroute): exit right, connect to reroute
        if (exitHorizontal && !enterHorizontal) {
            const exitX = p1.x + MIN_EXTRUSION;
            const signY = dy >= 0 ? 1 : -1;
            
            if (p2.x > exitX + r * 2) {
                // Reroute is well to the right - simple S-bend
                const midX = (exitX + p2.x) / 2;
                const effectiveR = Math.min(r, (p2.x - exitX) / 2, absDy / 2);
                if (effectiveR < 2 || absDy < 4) {
                    d += \` L \${p2.x} \${p2.y}\`;
                } else {
                    d += \` L \${midX - effectiveR} \${p1.y}\`;
                    d += \` Q \${midX} \${p1.y}, \${midX} \${p1.y + effectiveR * signY}\`;
                    d += \` L \${midX} \${p2.y - effectiveR * signY}\`;
                    d += \` Q \${midX} \${p2.y}, \${midX + effectiveR} \${p2.y}\`;
                    d += \` L \${p2.x} \${p2.y}\`;
                }
            } else {
                // Reroute is to the left or close - exit right, go vertical, then horizontal to reroute
                const effectiveR = Math.min(r, 6);
                
                // Always exit horizontally to the right first
                d += \` L \${exitX} \${p1.y}\`;
                
                if (absDy > effectiveR * 2) {
                    // Go vertical toward reroute Y level
                    d += \` L \${exitX} \${p1.y + effectiveR * signY}\`;
                    d += \` L \${exitX} \${p2.y - effectiveR * signY}\`;
                    // Turn toward reroute (could be left or right)
                    if (p2.x < exitX) {
                        // Reroute is to the left - turn left
                        d += \` Q \${exitX} \${p2.y}, \${exitX - effectiveR} \${p2.y}\`;
                        d += \` L \${p2.x} \${p2.y}\`;
                    } else {
                        // Reroute is close but to the right - turn right
                        d += \` Q \${exitX} \${p2.y}, \${exitX + effectiveR} \${p2.y}\`;
                        d += \` L \${p2.x} \${p2.y}\`;
                    }
                } else {
                    // Small vertical distance - direct to reroute
                    d += \` L \${p2.x} \${p2.y}\`;
                }
            }
            return d;
        }
        
        // For last segment only (reroute to input): connect from reroute, enter from left
        if (!exitHorizontal && enterHorizontal) {
            const entryX = p2.x - MIN_EXTRUSION;
            const signY = dy >= 0 ? 1 : -1;
            
            if (p1.x < entryX - r * 2) {
                // Reroute is well to the left - simple S-bend through midpoint
                const midX = (p1.x + entryX) / 2;
                const effectiveR = Math.min(r, (entryX - p1.x) / 2, absDy / 2);
                if (effectiveR < 2 || absDy < 4) {
                    d += \` L \${p2.x} \${p2.y}\`;
                } else {
                    d += \` L \${midX - effectiveR} \${p1.y}\`;
                    d += \` Q \${midX} \${p1.y}, \${midX} \${p1.y + effectiveR * signY}\`;
                    d += \` L \${midX} \${p2.y - effectiveR * signY}\`;
                    d += \` Q \${midX} \${p2.y}, \${midX + effectiveR} \${p2.y}\`;
                    d += \` L \${p2.x} \${p2.y}\`;
                }
            } else {
                // Reroute is to the right or close - must route to enter from left
                // Simple approach: go vertical to dest Y, then horizontal left past entryX, then right to port
                
                // Go vertical to destination Y level
                d += \` L \${p1.x} \${p2.y}\`;
                // Go left past the entry point
                d += \` L \${entryX} \${p2.y}\`;
                // Enter the port from the left
                d += \` L \${p2.x} \${p2.y}\`;
            }
            return d;
        }
        
        // Full connection (output port to input port, no reroutes)
        // If points are nearly aligned horizontally and destination is to the right
        if (absDy < 2 && p2.x > p1.x + MIN_EXTRUSION) {
            return \`M \${p1.x} \${p1.y} L \${p2.x} \${p2.y}\`;
        }
        
        // Calculate exit and entry points with minimum extrusion
        const exitX = p1.x + MIN_EXTRUSION;
        const entryX = p2.x - MIN_EXTRUSION;
        
        // Direction toward destination
        const signY = dy >= 0 ? 1 : -1;
        
        // Case 1: Normal flow (exit point is well left of entry point)
        if (exitX < entryX - r * 2) {
            const midX = (exitX + entryX) / 2;
            const effectiveR = Math.min(r, Math.abs(midX - exitX) - 1, absDy / 2 - 1);
            
            if (effectiveR < 1 || absDy < 4) {
                d += \` L \${p2.x} \${p2.y}\`;
            } else {
                d += \` L \${midX - effectiveR} \${p1.y}\`;
                d += \` Q \${midX} \${p1.y}, \${midX} \${p1.y + effectiveR * signY}\`;
                d += \` L \${midX} \${p2.y - effectiveR * signY}\`;
                d += \` Q \${midX} \${p2.y}, \${midX + effectiveR} \${p2.y}\`;
                d += \` L \${p2.x} \${p2.y}\`;
            }
        }
        // Case 2: Backward flow (destination is to the left or close)
        else {
            // Route TOWARD the destination using midpoint Y
            const midY = (p1.y + p2.y) / 2;
            
            // Ensure enough vertical space for corners
            const minVerticalTravel = r * 2 + 4;
            let routeY;
            
            if (absDy < minVerticalTravel * 2) {
                // Not enough vertical space - extend beyond destination
                routeY = signY > 0 ? Math.max(p2.y + 30, p1.y + 30) : Math.min(p2.y - 30, p1.y - 30);
            } else {
                routeY = midY;
            }
            
            const effectiveR = Math.min(r, Math.abs(routeY - p1.y) / 2 - 1, Math.abs(routeY - p2.y) / 2 - 1, 6);
            const safeR = Math.max(effectiveR, 2);
            
            const signYToRoute = routeY > p1.y ? 1 : -1;
            const signYToDest = p2.y > routeY ? 1 : -1;
            
            d += \` L \${exitX - safeR} \${p1.y}\`;
            d += \` Q \${exitX} \${p1.y}, \${exitX} \${p1.y + safeR * signYToRoute}\`;
            d += \` L \${exitX} \${routeY - safeR * signYToRoute}\`;
            d += \` Q \${exitX} \${routeY}, \${exitX - safeR} \${routeY}\`;
            d += \` L \${entryX + safeR} \${routeY}\`;
            d += \` Q \${entryX} \${routeY}, \${entryX} \${routeY + safeR * signYToDest}\`;
            d += \` L \${entryX} \${p2.y - safeR * signYToDest}\`;
            d += \` Q \${entryX} \${p2.y}, \${entryX + safeR} \${p2.y}\`;
            d += \` L \${p2.x} \${p2.y}\`;
        }
        
        return d;
    },
    
    // Add reroute point at the correct position along the path
    addReroutePoint(connectionId, pos) {
        const conn = GraphState.getConnection(connectionId);
        if (!conn) return;
        
        if (!conn.reroutes) {
            conn.reroutes = [];
        }
        
        // Get the connection path points (from node -> reroutes -> to node)
        const fromNode = document.getElementById('node-' + conn.fromNodeId);
        const toNode = document.getElementById('node-' + conn.toNodeId);
        if (!fromNode || !toNode) return;
        
        const fromPort = fromNode.querySelector('[data-port="' + conn.fromPortId + '"]');
        const toPort = toNode.querySelector('[data-port="' + conn.toPortId + '"]');
        if (!fromPort || !toPort) return;
        
        // Build the full path points array
        const pathPoints = this.getConnectionPoints(fromPort, toPort, conn.reroutes);
        
        // Find which segment the point is ON (projection falls within segment bounds)
        let insertIndex = -1;
        let bestDistance = Infinity;
        
        for (let i = 0; i < pathPoints.length - 1; i++) {
            const p1 = pathPoints[i];
            const p2 = pathPoints[i + 1];
            
            // Get projection info for this segment
            const projInfo = this.getProjectionOnSegment(pos, p1, p2);
            
            // Only consider this segment if the point projects onto it (t between 0 and 1)
            if (projInfo.t >= 0 && projInfo.t <= 1) {
                if (projInfo.distance < bestDistance) {
                    bestDistance = projInfo.distance;
                    insertIndex = i;
                }
            }
        }
        
        // If point doesn't project onto any segment, don't add reroute
        if (insertIndex === -1) return;
        
        // Insert at the correct position
        conn.reroutes.splice(insertIndex, 0, { x: pos.x, y: pos.y });
        
        // Re-render connection
        this.removeConnection(connectionId);
        this.renderConnection(conn);
        
        // Notify extension
        vscode.postMessage({
            type: 'updateConnection',
            payload: { connectionId, reroutes: conn.reroutes }
        });
    },
    
    // Get projection info of a point onto a line segment
    getProjectionOnSegment(point, segStart, segEnd) {
        const dx = segEnd.x - segStart.x;
        const dy = segEnd.y - segStart.y;
        const lengthSq = dx * dx + dy * dy;
        
        if (lengthSq === 0) {
            // Segment is a point
            const dist = Math.sqrt(Math.pow(point.x - segStart.x, 2) + Math.pow(point.y - segStart.y, 2));
            return { t: 0, distance: dist };
        }
        
        // Calculate t (projection parameter: 0 = at start, 1 = at end)
        const t = ((point.x - segStart.x) * dx + (point.y - segStart.y) * dy) / lengthSq;
        
        // Calculate perpendicular distance
        const projX = segStart.x + t * dx;
        const projY = segStart.y + t * dy;
        const distance = Math.sqrt(Math.pow(point.x - projX, 2) + Math.pow(point.y - projY, 2));
        
        return { t, distance };
    },
    
    // Render reroute point
    renderReroutePoint(connectionId, index, pos) {
        // Get the connection's data type for color matching
        const connPath = document.getElementById('conn-' + connectionId);
        const dataType = connPath?.dataset?.type || 'any';
        
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.className.baseVal = 'reroute-point';
        circle.id = \`reroute-\${connectionId}-\${index}\`;
        circle.setAttribute('cx', pos.x);
        circle.setAttribute('cy', pos.y);
        circle.setAttribute('r', 7);
        circle.dataset.connId = connectionId;
        circle.dataset.index = index;
        circle.dataset.type = dataType;
        
        // Drag reroute point
        let isDragging = false;
        let startPos = null;
        
        circle.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            // Check if reroute point is interactable based on view mode
            if (!this.isConnectionInteractable(dataType)) return;
            isDragging = true;
            startPos = { x: pos.x, y: pos.y };
            document.addEventListener('mousemove', onDrag);
            document.addEventListener('mouseup', onDragEnd);
        });
        
        const onDrag = (e) => {
            if (!isDragging) return;
            const newPos = Canvas.screenToCanvas(e.clientX, e.clientY);
            pos.x = newPos.x;
            pos.y = newPos.y;
            circle.setAttribute('cx', pos.x);
            circle.setAttribute('cy', pos.y);
            
            const conn = GraphState.getConnection(connectionId);
            if (conn && conn.reroutes) {
                conn.reroutes[index] = { x: pos.x, y: pos.y };
                // Update path
                const path = document.getElementById('conn-' + connectionId);
                if (path) {
                    const fromPort = document.querySelector('[data-node="' + conn.fromNodeId + '"][data-port="' + conn.fromPortId + '"]');
                    const toPort = document.querySelector('[data-node="' + conn.toNodeId + '"][data-port="' + conn.toPortId + '"]');
                    if (fromPort && toPort) {
                        const points = this.getConnectionPoints(fromPort, toPort, conn.reroutes);
                        path.setAttribute('d', this.createBezierPath(points));
                    }
                }
            }
        };
        
        const onDragEnd = () => {
            isDragging = false;
            document.removeEventListener('mousemove', onDrag);
            document.removeEventListener('mouseup', onDragEnd);
            
            const conn = GraphState.getConnection(connectionId);
            if (conn) {
                vscode.postMessage({
                    type: 'updateConnection',
                    payload: { connectionId, reroutes: conn.reroutes }
                });
            }
        };
        
        // Right-click to delete
        circle.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            // Check if reroute point is interactable based on view mode
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
        
        this.tempLine.setAttribute('d', this.createBezierPath([
            { x: x1, y: y1 },
            { x: x2, y: y2 }
        ]));
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

