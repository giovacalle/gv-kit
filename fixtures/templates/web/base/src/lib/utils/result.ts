import { err, ok, type Result } from 'neverthrow'

export type AppError = {
	code: string
	message: string
	status: number
	details?: Record<string, unknown>
}

export function extractAppError(payload: string, fallbackStatus: number): AppError {
	try {
		const parsed = JSON.parse(payload)
		if (parsed && typeof parsed === 'object' && typeof parsed.message === 'string') {
			return {
				code: typeof parsed.code === 'string' ? parsed.code : 'unknown_error',
				message: parsed.message,
				status: typeof parsed.status === 'number' ? parsed.status : fallbackStatus,
				details: parsed.details ?? undefined
			}
		}
	} catch {
		// fall through
	}
	return {
		code: 'unknown_error',
		message: payload || 'Unknown error',
		status: fallbackStatus
	}
}

export { err, ok, type Result }
