// Minimal type declarations for node:async_hooks AsyncLocalStorage
// Available at runtime via nodejs_compat flag in wrangler.toml.
// Full @types/node is not needed — only AsyncLocalStorage is used.
declare module 'node:async_hooks' {
	export class AsyncLocalStorage<T> {
		getStore(): T | undefined;
		run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R;
	}
}
