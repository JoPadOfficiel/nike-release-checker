/**
 * In-memory stub for the customers repository.
 * Story 16.x will replace this with a real Postgres implementation.
 */

export interface CustomerRow {
	id: string
	email: string
	tier: 'solo' | 'pro' | 'enterprise'
	created_at: Date
	stripe_customer_id?: string
	deleted_at?: Date
	default_currency?: string
}

const store = new Map<string, CustomerRow>()

export const customersDb = {
	findById(id: string): CustomerRow | undefined {
		return store.get(id)
	},

	/** Seed a customer for testing / bootstrapping. */
	_seed(row: CustomerRow): void {
		store.set(row.id, row)
	},

	/** Clear all customers — used between tests. */
	_clear(): void {
		store.clear()
	},
}
