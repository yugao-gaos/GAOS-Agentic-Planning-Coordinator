/**
 * ServiceLocator.ts - Centralized service registry with singleton lifecycle support
 * 
 * Replaces scattered singleton patterns with a unified service locator.
 * Uses class-based tokens for type safety.
 * 
 * Usage:
 *   // Register a service
 *   ServiceLocator.register(OutputChannelManager, () => new OutputChannelManager());
 * 
 *   // Resolve a service
 *   const manager = ServiceLocator.resolve(OutputChannelManager);
 * 
 *   // Dispose all services (call on extension deactivation)
 *   await ServiceLocator.dispose();
 */

// Type for class constructors
type Constructor<T> = new (...args: any[]) => T;

/**
 * Service registration metadata
 */
interface ServiceRegistration<T> {
    factory: () => T;
    instance?: T;
    lifecycle: 'singleton' | 'transient';
}

/**
 * ServiceLocator - Central registry for all services
 * 
 * Features:
 * - Class-based tokens for type safety
 * - Singleton lifecycle with lazy instantiation
 * - Transient lifecycle for per-request instances
 * - Proper dispose ordering (LIFO)
 * - Circular dependency detection
 * - Testing support via reset() and mockService()
 */
export class ServiceLocator {
    private static registrations = new Map<Constructor<any>, ServiceRegistration<any>>();
    private static disposeOrder: Constructor<any>[] = [];
    private static initialized = false;
    
    /** Tracks services currently being resolved - for circular dependency detection */
    private static resolving = new Set<Constructor<any>>();

    /**
     * Register a service with the locator
     * 
     * @param token The class constructor used as the token
     * @param factory Factory function to create the service instance
     * @param lifecycle 'singleton' (default) or 'transient'
     */
    static register<T>(
        token: Constructor<T>,
        factory: () => T,
        lifecycle: 'singleton' | 'transient' = 'singleton'
    ): void {
        // Check if already registered and handle re-registration
        const existing = this.registrations.get(token);
        if (existing) {
            // Remove from disposeOrder to prevent duplicate entries
            const idx = this.disposeOrder.indexOf(token);
            if (idx !== -1) {
                this.disposeOrder.splice(idx, 1);
            }
            // Note: We don't dispose the existing instance here because
            // re-registration typically happens for mocking during tests
            // and the caller is responsible for cleanup if needed
        }
        
        this.registrations.set(token, { factory, lifecycle });
        if (lifecycle === 'singleton') {
            // Add to dispose order (LIFO - last registered disposed first)
            this.disposeOrder.unshift(token);
        }
    }

    /**
     * Resolve a service from the locator
     * 
     * For singletons, returns the cached instance (creating it if needed)
     * For transients, creates a new instance each time
     * 
     * @param token The class constructor to resolve
     * @returns The service instance
     * @throws Error if service is not registered
     * @throws Error if circular dependency detected
     */
    static resolve<T>(token: Constructor<T>): T {
        const reg = this.registrations.get(token);
        if (!reg) {
            throw new Error(`Service not registered: ${token.name}. Did you call bootstrapServices()?`);
        }
        
        if (reg.lifecycle === 'singleton') {
            if (!reg.instance) {
                // Circular dependency detection
                if (this.resolving.has(token)) {
                    const chain = Array.from(this.resolving).map(t => t.name).join(' -> ');
                    throw new Error(
                        `Circular dependency detected when resolving: ${token.name}. ` +
                        `Resolution chain: ${chain} -> ${token.name}`
                    );
                }
                
                this.resolving.add(token);
                try {
                    reg.instance = reg.factory();
                } finally {
                    this.resolving.delete(token);
                }
            }
            return reg.instance;
        }
        
        // Transient - create new instance each time
        return reg.factory();
    }

    /**
     * Dispose all registered singleton services
     * 
     * Services are disposed in reverse registration order (LIFO)
     * to respect dependency relationships.
     * 
     * Call this during extension deactivation.
     */
    static async dispose(): Promise<void> {
        for (const token of this.disposeOrder) {
            const reg = this.registrations.get(token);
            if (reg?.instance && typeof (reg.instance as any).dispose === 'function') {
                try {
                    const result = (reg.instance as any).dispose();
                    // Handle both sync and async dispose
                    if (result instanceof Promise) {
                        await result;
                    }
                    console.log(`[ServiceLocator] Disposed: ${token.name}`);
                } catch (err) {
                    console.error(`[ServiceLocator] Error disposing ${token.name}:`, err);
                }
            }
            // Clear the instance reference
            if (reg) {
                reg.instance = undefined;
            }
        }
        
        this.registrations.clear();
        this.disposeOrder = [];
        this.resolving.clear();
        this.initialized = false;
    }

    /**
     * Check if a service is registered
     */
    static isRegistered<T>(token: Constructor<T>): boolean {
        return this.registrations.has(token);
    }

    /**
     * Check if a service instance has been created (for singletons)
     */
    static isInstantiated<T>(token: Constructor<T>): boolean {
        const reg = this.registrations.get(token);
        return reg?.instance !== undefined;
    }

    /**
     * Reset the locator - clears all registrations and instances
     * 
     * Use this in tests to start fresh between test cases.
     * Does NOT call dispose on instances - call dispose() first if needed.
     */
    static reset(): void {
        this.registrations.clear();
        this.disposeOrder = [];
        this.resolving.clear();
        this.initialized = false;
    }

    /**
     * Mark the locator as initialized
     * Used to track if bootstrapServices() has been called
     */
    static markInitialized(): void {
        this.initialized = true;
    }

    /**
     * Check if the locator has been initialized
     */
    static isInitialized(): boolean {
        return this.initialized;
    }

    /**
     * Get list of all registered service names (for debugging)
     */
    static getRegisteredServices(): string[] {
        return Array.from(this.registrations.keys()).map(ctor => ctor.name);
    }
}

/**
 * Helper function to mock a service for testing
 * 
 * @param token The service class to mock
 * @param mock The mock instance to use
 */
export function mockService<T>(token: Constructor<T>, mock: T): void {
    // register() now handles duplicate prevention in disposeOrder
    ServiceLocator.register(token, () => mock, 'singleton');
    // Force the instance to be set immediately (bypass factory)
    const reg = (ServiceLocator as any).registrations.get(token);
    if (reg) {
        reg.instance = mock;
    }
}
