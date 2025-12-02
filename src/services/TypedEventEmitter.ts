/**
 * TypedEventEmitter - A typed event emitter that replaces vscode.EventEmitter
 * 
 * This provides a vscode-free implementation with a similar API.
 */

import { EventEmitter } from 'events';

/**
 * Typed event emitter that mimics vscode.EventEmitter API
 * 
 * Usage:
 * ```typescript
 * const emitter = new TypedEventEmitter<string>();
 * 
 * // Subscribe (vscode style)
 * const dispose = emitter.event((data) => console.log(data));
 * 
 * // Fire event
 * emitter.fire('hello');
 * 
 * // Unsubscribe
 * dispose.dispose();
 * ```
 */
export class TypedEventEmitter<T> {
    private emitter = new EventEmitter();
    private static counter = 0;
    private eventName: string;
    
    constructor() {
        this.eventName = `event_${TypedEventEmitter.counter++}`;
    }
    
    /**
     * Event property for subscriptions (vscode.EventEmitter API)
     */
    get event(): (listener: (e: T) => any) => { dispose: () => void } {
        return (listener: (e: T) => any) => {
            this.emitter.on(this.eventName, listener);
            return {
                dispose: () => {
                    this.emitter.removeListener(this.eventName, listener);
                }
            };
        };
    }
    
    /**
     * Fire an event
     */
    fire(data: T): void {
        this.emitter.emit(this.eventName, data);
    }
    
    /**
     * Dispose the emitter
     */
    dispose(): void {
        this.emitter.removeAllListeners(this.eventName);
    }
}

/**
 * Disposable interface for vscode compatibility
 */
export interface IDisposable {
    dispose(): void;
}




























