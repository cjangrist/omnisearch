// Structured logging utility for Cloudflare Workers
// Provides consistent log formatting with tags, levels, and context

// AsyncLocalStorage for request-scoped context — prevents request ID cross-contamination
// when CF Workers process concurrent requests in the same isolate.
// Requires nodejs_compat flag in wrangler.toml.
import { AsyncLocalStorage } from 'node:async_hooks';

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const request_id_store = new AsyncLocalStorage<string>();

export const run_with_request_id = <R>(id: string, fn: () => R): R =>
	request_id_store.run(id, fn);

// Internal-only — the active request id is read from ALS, never imported elsewhere.
const get_request_id = (): string | undefined =>
	request_id_store.getStore();

interface LogContext {
	component?: string;
	op?: string;
	provider?: string;
	requestId?: string;
	[key: string]: unknown;
}

interface LogEntry {
	timestamp: string;
	level: LogLevel;
	message: string;
	component: string;
	context?: LogContext;
}

// Log level priority (lower = more verbose)
const LOG_LEVELS: Record<LogLevel, number> = {
	trace: 0,
	debug: 1,
	info: 2,
	warn: 3,
	error: 4,
};

// Default minimum log level (can be overridden via env)
const DEFAULT_MIN_LEVEL: LogLevel = 'info';

class Logger {
	private component: string;

	constructor(component: string) {
		this.component = component;
	}

	private shouldLog(level: LogLevel): boolean {
		// In Cloudflare Workers, env vars aren't available via process
		// LOG_LEVEL can be set via globalThis.__LOG_LEVEL or defaults to 'info'
		const minLevel = (globalThis as unknown as { __LOG_LEVEL?: LogLevel }).__LOG_LEVEL || DEFAULT_MIN_LEVEL;
		return LOG_LEVELS[level] >= LOG_LEVELS[minLevel];
	}

	private formatMessage(level: LogLevel, message: string, context?: LogContext): string {
		const entry: LogEntry = {
			timestamp: new Date().toISOString(),
			level,
			message,
			component: this.component,
			context: {
				...context,
				requestId: get_request_id(),
			},
		};
		return JSON.stringify(entry);
	}

	private log(level: LogLevel, message: string, context?: LogContext): void {
		if (!this.shouldLog(level)) return;

		const formatted = this.formatMessage(level, message, context);

		switch (level) {
			case 'trace':
			case 'debug':
				console.debug(formatted);
				break;
			case 'info':
				console.log(formatted);
				break;
			case 'warn':
				console.warn(formatted);
				break;
			case 'error':
				console.error(formatted);
				break;
		}
	}

	debug(message: string, context?: LogContext): void {
		this.log('debug', message, context);
	}

	info(message: string, context?: LogContext): void {
		this.log('info', message, context);
	}

	warn(message: string, context?: LogContext): void {
		this.log('warn', message, context);
	}

	error(message: string, context?: LogContext): void {
		this.log('error', message, context);
	}

	/**
	 * Log response details
	 */
	response(method: string, path: string, status: number, duration: number, context?: LogContext): void {
		const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
		this.log(level, `${method} ${path} - ${status}`, {
			op: 'http_response',
			method,
			path,
			status,
			duration_ms: duration,
			...context,
		});
	}
}

// Create logger instances for each component
export const loggers = {
	worker: () => new Logger('worker'),
	config: () => new Logger('config'),
	providers: () => new Logger('providers'),
	search: (provider?: string) => new Logger(provider ? `search:${provider}` : 'search'),
	rest: () => new Logger('rest_api'),
	mcp: () => new Logger('mcp'),
	http: () => new Logger('http_client'),
	fetch: (provider?: string) => new Logger(provider ? `fetch:${provider}` : 'fetch'),
};
