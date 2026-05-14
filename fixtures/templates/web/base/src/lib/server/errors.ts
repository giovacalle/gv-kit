import { error } from '@sveltejs/kit'

export type ErrorCode =
	| 'NOT_FOUND'
	| 'UNAUTHENTICATED'
	| 'FORBIDDEN'
	| 'INVALID_INPUT'
	| 'CONFLICT'
	| 'INTERNAL_ERROR'

export class AppError extends Error {
	constructor(
		public readonly code: ErrorCode,
		message: string
	) {
		super(message)
		this.name = 'AppError'
	}
}

export const throwAppError = (code: ErrorCode, message: string): never => {
	throw new AppError(code, message)
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError

export const httpStatusFor = (code: ErrorCode): number =>
	({
		NOT_FOUND: 404,
		UNAUTHENTICATED: 401,
		FORBIDDEN: 403,
		INVALID_INPUT: 400,
		CONFLICT: 409,
		INTERNAL_ERROR: 500
	})[code]

export async function guardAppError<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn()
	} catch (e) {
		if (isAppError(e)) throw error(httpStatusFor(e.code), e.message)
		throw e
	}
}
