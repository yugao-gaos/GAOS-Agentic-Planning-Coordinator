/**
 * SVG icon constants for webview components.
 * All icons are 16x16 viewBox, optimized for inline use.
 */
export const ICONS = {
    // Navigation & Actions
    refresh: `<svg viewBox="0 0 16 16"><path d="M2.006 8.267L.78 9.5 0 8.73l2.09-2.07.76.01 2.09 2.12-.76.76-1.167-1.18a5 5 0 0 0 9.4 1.983l.813.597a6 6 0 0 1-11.22-2.683zm10.99-.466L11.76 6.55l-.76.76 2.09 2.11.76.01 2.09-2.07-.75-.76-1.194 1.18a6 6 0 0 0-11.11-2.92l.81.594a5 5 0 0 1 9.3 2.346z"/></svg>`,
    
    settings: `<svg viewBox="0 0 16 16"><path d="M3.5 2h-1v5h1V2zm6.1 5H6.4L6 6.45v-1L6.4 5h3.2l.4.5v1l-.4.5zm-5 3H1.4L1 9.5v-1l.4-.5h3.2l.4.5v1l-.4.5zm3.9-8h-1v2h1V2zm-1 6h1v6h-1V8zm-4 3h-1v3h1v-3zm7.9 0h3.19l.4-.5v-1l-.4-.5H11.4l-.4.5v1l.4.5zm2.1-9h-1v6h1V2zm-1 10h1v2h-1v-2z"/></svg>`,
    
    gear: `<svg viewBox="0 0 16 16"><path fill-rule="evenodd" clip-rule="evenodd" d="M9.1 4.4L8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.2.7-2.4.5v1.2l2.4.5.3.8-1.3 2 .8.8 2-1.3.8.3.4 2.3h1.2l.5-2.4.8-.3 2 1.3.8-.8-1.3-2 .3-.8 2.3-.4V7.4l-2.4-.5-.3-.8 1.3-2-.8-.8-2 1.3-.7-.2zM9.4 1l.5 2.4L12 2.1l2 2-1.4 2.1 2.4.4v2.8l-2.4.5L14 12l-2 2-2.1-1.4-.5 2.4H6.6l-.5-2.4L4 14l-2-2 1.4-2.1L1 9.4V6.6l2.4-.5L2 4l2-2 2.1 1.4.4-2.4h3zm.6 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm1 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"/></svg>`,
    
    add: `<svg viewBox="0 0 16 16"><path d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z"/></svg>`,
    
    remove: `<svg viewBox="0 0 16 16"><path d="M14 3h-3.5l-1-1h-3l-1 1H2v1h12V3zM4 14h8V5H4v9zm2-7h1v5H6V7zm3 0h1v5H9V7z"/></svg>`,
    
    stop: `<svg viewBox="0 0 16 16"><path d="M3 3h10v10H3V3z"/></svg>`,
    
    play: `<svg viewBox="0 0 16 16"><path d="M4 2l9 6-9 6V2z"/></svg>`,
    
    // Expand/Collapse
    chevronRight: `<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4V4z"/></svg>`,
    
    // Documents & Files
    document: `<svg viewBox="0 0 16 16"><path d="M13.5 0H2.5A1.5 1.5 0 001 1.5v13A1.5 1.5 0 002.5 16h11a1.5 1.5 0 001.5-1.5v-13A1.5 1.5 0 0013.5 0zM3 2h10v2H3V2zm0 4h10v2H3V6zm0 4h7v2H3v-2z"/></svg>`,
    
    list: `<svg viewBox="0 0 16 16"><path d="M1 3h14v1H1V3zm0 4h14v1H1V7zm0 4h14v1H1v-1z"/></svg>`,
    
    // Workflow Types
    planning: `<svg viewBox="0 0 16 16"><path d="M9 1v2h3v3h2V2.5l-.5-.5H9zM9 13v2h4.5l.5-.5V11h-2v2H9zM7 13H4v-2H2v3.5l.5.5H7v-2zM7 1H2.5l-.5.5V6h2V3h3V1z"/></svg>`,
    
    revision: `<svg viewBox="0 0 16 16"><path d="M13.23 1h-1.46L3.52 9.25l-.16.22L1 13.59 2.41 15l4.12-2.36.22-.16L15 4.23V2.77L13.23 1zM2.41 13.59l1.51-3 1.45 1.45-2.96 1.55zm3.83-2.06L4.47 9.76l8-8 1.77 1.77-8 8z"/></svg>`,
    
    task: `<svg viewBox="0 0 16 16"><path d="M14.773 3.485l-.78-.184-.108.456c-.108.456-.477.924-.989 1.1l-.523.18c-.558.192-1.056.588-1.344 1.14l-.3.576-.53.18c-.543.192-.964.588-1.188 1.14l-.168.408-.744.24c-.528.168-1.056.612-1.296 1.152l-.12.24-.564.168c-.564.18-.984.732-1.104 1.296l-.048.204-.12.264c-.096.24-.252.456-.444.624l-.252.22-.18.6c-.12.36-.084.756.12 1.092.192.336.516.576.888.66l.948.216.096-.456c.072-.3.288-.54.552-.648l.192-.072.264-.12c.24-.096.504-.144.768-.132l.336.012.6-.216c.516-.192 1.056-.132 1.512.156l.144.084.312.012c.408.012.816-.156 1.092-.456l.18-.192.2-.048c.42-.096.78-.36.996-.732l.3-.54.504-.048c.456-.048.876-.3 1.128-.672l.132-.18.168-.048c.336-.096.636-.324.816-.624.18-.3.216-.648.12-.984l-.168-.54z"/></svg>`,
    
    error: `<svg viewBox="0 0 16 16"><path d="M8 0L0 14h16L8 0zm0 12.5a1 1 0 110-2 1 1 0 010 2zm1-3H7V5h2v4.5z"/></svg>`,
    
    // People & Agents
    person: `<svg viewBox="0 0 16 16"><path d="M8 8a3 3 0 100-6 3 3 0 000 6zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`,
    
    // Workflow
    workflow: `<svg viewBox="0 0 16 16"><path d="M2.5 2h11c.28 0 .5.22.5.5v11c0 .28-.22.5-.5.5h-11a.5.5 0 01-.5-.5v-11c0-.28.22-.5.5-.5zM3 3v10h10V3H3zm1 2h2v2H4V5zm3 0h5v1H7V5zm-3 3h2v2H4V8zm3 0h5v1H7V8z"/></svg>`,
    
    // Dependency Map
    deps: `<svg viewBox="0 0 16 16"><path d="M2 2h3v3H2V2zm0 9h3v3H2v-3zm9-9h3v3h-3V2zm0 9h3v3h-3v-3zM3.5 5v2h2v1h-2v3H5v-3h1V7H5V5H3.5zm6 0v2h-2v1h2v3H11v-3h1V7h-1V5H9.5z"/></svg>`,
} as const;

export type IconName = keyof typeof ICONS;

/**
 * Get an icon by name with optional class
 */
export function icon(name: IconName, className?: string): string {
    const svg = ICONS[name];
    if (className) {
        return svg.replace('<svg', `<svg class="${className}"`);
    }
    return svg;
}

