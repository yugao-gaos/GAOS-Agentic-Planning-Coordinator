// ============================================================================
// Annotation Nodes - Comment and Group nodes for visual organization
// ============================================================================

import { 
    INodeDefinition, 
    INodeInstance, 
    NodeExecutor,
    IExecutionContextAPI 
} from '../NodeTypes';
import { nodeRegistry } from '../NodeRegistry';

// ============================================================================
// Comment Node
// ============================================================================

export const CommentNodeDefinition: INodeDefinition = {
    type: 'comment',
    name: 'Comment',
    description: 'A sticky note for adding comments and documentation to your workflow. Does not participate in execution.',
    category: 'annotation',
    icon: 'comment',
    color: '#FFC107',  // Yellow
    defaultInputs: [],
    defaultOutputs: [],
    configSchema: {
        fields: [
            {
                name: 'text',
                type: 'multiline',
                label: 'Comment Text',
                description: 'The text content of this comment',
                defaultValue: 'Add your comment here...'
            },
            {
                name: 'backgroundColor',
                type: 'select',
                label: 'Background Color',
                description: 'Background color for the comment',
                defaultValue: '#FFC107',
                options: [
                    { value: '#FFC107', label: 'Yellow' },
                    { value: '#FF9800', label: 'Orange' },
                    { value: '#4CAF50', label: 'Green' },
                    { value: '#2196F3', label: 'Blue' },
                    { value: '#9C27B0', label: 'Purple' },
                    { value: '#F44336', label: 'Red' },
                    { value: '#607D8B', label: 'Gray' },
                    { value: '#E91E63', label: 'Pink' }
                ]
            },
            {
                name: 'width',
                type: 'number',
                label: 'Width (px)',
                description: 'Width of the comment box',
                defaultValue: 200,
                min: 100,
                max: 600
            }
        ]
    }
};

/**
 * Comment node executor - does nothing, just passes through
 */
export const CommentNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    // Comments don't execute - they're for documentation only
    return {};
};

// ============================================================================
// Group Node (Frame)
// ============================================================================

export const GroupNodeDefinition: INodeDefinition = {
    type: 'group',
    name: 'Group',
    description: 'A frame that groups multiple nodes together. Moving the group moves all contained nodes.',
    category: 'annotation',
    icon: 'group',
    color: '#607D8B',  // Gray
    defaultInputs: [],
    defaultOutputs: [],
    configSchema: {
        fields: [
            {
                name: 'title',
                type: 'string',
                label: 'Group Title',
                description: 'Title displayed on the group frame',
                defaultValue: 'Group'
            },
            {
                name: 'backgroundColor',
                type: 'select',
                label: 'Background Color',
                description: 'Background color for the group',
                defaultValue: '#607D8B',
                options: [
                    { value: '#607D8B', label: 'Gray' },
                    { value: '#FFC107', label: 'Yellow' },
                    { value: '#FF9800', label: 'Orange' },
                    { value: '#4CAF50', label: 'Green' },
                    { value: '#2196F3', label: 'Blue' },
                    { value: '#9C27B0', label: 'Purple' },
                    { value: '#F44336', label: 'Red' },
                    { value: '#E91E63', label: 'Pink' }
                ]
            },
            {
                name: 'collapsed',
                type: 'boolean',
                label: 'Collapsed',
                description: 'Whether the group is collapsed to show only the title',
                defaultValue: false
            },
            {
                name: 'width',
                type: 'number',
                label: 'Width (px)',
                description: 'Width of the group frame',
                defaultValue: 300,
                min: 150,
                max: 1000
            },
            {
                name: 'height',
                type: 'number',
                label: 'Height (px)',
                description: 'Height of the group frame',
                defaultValue: 200,
                min: 100,
                max: 800
            },
            {
                name: 'containedNodeIds',
                type: 'string',
                label: 'Contained Nodes',
                description: 'Comma-separated list of node IDs contained in this group (auto-managed)',
                defaultValue: ''
            }
        ]
    }
};

/**
 * Group node executor - does nothing, just for visual organization
 */
export const GroupNodeExecutor: NodeExecutor = async (
    node: INodeInstance,
    inputs: Record<string, any>,
    context: IExecutionContextAPI
): Promise<Record<string, any>> => {
    // Groups don't execute - they're for organization only
    return {};
};

// ============================================================================
// Registration
// ============================================================================

export function registerAnnotationNodes(): void {
    nodeRegistry.register(CommentNodeDefinition, CommentNodeExecutor);
    nodeRegistry.register(GroupNodeDefinition, GroupNodeExecutor);
}

