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
	failed: number
	errors: AccountImportError[]
}
