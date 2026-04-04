export interface ProxyTestResult {
	success: boolean
	latencyMs: number
	error?: string
}

export interface AccountImportError {
	accountId: string
	reason: string
}

export interface ImportResult {
	imported: number
	failed: number // schema-invalid + dedup-skipped + proxy-failed (all non-imported)
	errors: AccountImportError[]
	processedAccounts: Array<{ id: string; email: string; proxy: string }>
}

export interface LoginResult {
	success: boolean
	error?: string
	durationMs: number
}

export interface AuthResult {
	accountId: string
	success: boolean
	error?: string
	durationMs: number
}

export interface CookieData {
	name: string
	value: string
	domain: string
	path: string
	expires: number
	httpOnly: boolean
	secure: boolean
	sameSite?: 'Strict' | 'Lax' | 'None'
}
