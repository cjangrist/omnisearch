// Structured logging utility for Cloudflare Workers
// Provides consistent log formatting with tags, levels, and context

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

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
	private requestId?: string;

	constructor(component: string, requestId?: string) {
		this.component = component;
		this.requestId = requestId;
	}

	/**
	 * Create a child logger with additional context
	 */
	child(context: LogContext): Logger {
		const childLogger = new Logger(context.component || this.component, context.requestId || this.requestId);
		return childLogger;
	}

	/**
	 * Set request ID for correlation
	 */
	setRequestId(requestId: string): void {
		this.requestId = requestId;
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
				requestId: this.requestId,
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

	trace(message: string, context?: LogContext): void {
		this.log('trace', message, context);
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
	 * Log operation start with timing
	 */
	startOp(operation: string, context?: LogContext): { end: (success?: boolean, extra?: Record<string, unknown>) => void } {
		const startTime = Date.now();
		this.info(`Starting: ${operation}`, { op: operation, ...context });

		return {
			end: (success = true, extra = {}) => {
				const duration = Date.now() - startTime;
				const level = success ? 'info' : 'warn';
				this.log(level, `Completed: ${operation}`, {
					op: operation,
					duration_ms: duration,
					success,
					...context,
					...extra,
				});
			},
		};
	}

	/**
	 * Log provider-specific operations
	 */
	providerLog(provider: string, level: LogLevel, message: string, context?: LogContext): void {
		this.log(level, `[${provider}] ${message}`, { provider, ...context });
	}

	/**
	 * Log request details
	 */
	request(method: string, path: string, context?: LogContext): void {
		this.info(`${method} ${path}`, { op: 'http_request', method, path, ...context });
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
	search: (provider?: string) => new Logger('search', undefined),
	aiResponse: (provider?: string) => new Logger('ai_response', undefined),
	server: () => new Logger('server'),
	rest: () => new Logger('rest_api'),
	mcp: () => new Logger('mcp'),
	rrf: () => new Logger('rrf_ranking'),
	snippets: () => new Logger('snippet_selector'),
	http: () => new Logger('http_client'),
};

// Export Logger class for custom instances
export { Logger };

// Default logger for quick usage
export const logger = new Logger('app');
