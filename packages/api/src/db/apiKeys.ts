/**
 * In-memory stub for the api_keys repository.
 * Story 16.x will replace this with a real Postgres implementation.
 */

export interface ApiKeyRow {
	key_id: string
	customer_id: string
	secret_hash: string
	label?: string
	created_at: Date
	last_used_at?: Date
	revoked_at?: Date
}

const store = new Map<string, ApiKeyRow>()

export const apiKeysDb = {
	/**
	 * Look up an API key row by its key_id.
	 * Returns undefined if not found.
	 */
	findByKeyId(keyId: string): ApiKeyRow | undefined {
		return store.get(keyId)
	},

	/**
	 * Update last_used_at to now (fire-and-forget acceptable).
	 */
	touchLastUsed(keyId: string): void {
		const row = store.get(keyId)
		if (row != null) {
			row.last_used_at = new Date()
		}
	},

	/**
	 * Seed a key for testing / bootstrapping.
	 * Not exposed in the public API surface — tests import this directly.
	 */
	_seed(row: ApiKeyRow): void {
		store.set(row.key_id, row)
	},

	/** Clear all keys — used between tests. */
	_clear(): void {
		store.clear()
	},
}
