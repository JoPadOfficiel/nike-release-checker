/**
 * In-memory stub for the customers repository.
 * Story 16.x will replace this with a real Postgres implementation.
 */

import { randomUUID } from 'node:crypto'
import { provisionDek } from '../crypto/dek.ts'

export interface CustomerRow {
	id: string
	email: string
	tier: 'solo' | 'pro' | 'enterprise'
	created_at: Date
	stripe_customer_id?: string
	deleted_at?: Date
	default_currency?: string
	/** KMS-wrapped IKM for DEK derivation (Story 16.2) */
	dek_wrapped?: Buffer
	/** Per-customer 32-byte HKDF salt (Story 16.2) */
	dek_salt?: Buffer
}

export interface CreateCustomerInput {
	email: string
	tier?: 'solo' | 'pro' | 'enterprise'
	stripe_customer_id?: string
	default_currency?: string
}

const store = new Map<string, CustomerRow>()

export const customersDb = {
	findById(id: string): CustomerRow | undefined {
		return store.get(id)
	},

	/**
	 * Create a new customer row and provision a per-customer DEK via KMS.
	 * The `dek_wrapped` and `dek_salt` are persisted in the same logical
	 * "transaction" as the customer row (Story 16.2).
	 */
	async create(input: CreateCustomerInput): Promise<CustomerRow> {
		const id = randomUUID()
		const { dek_wrapped, dek_salt } = await provisionDek(id)
		const row: CustomerRow = {
			id,
			email: input.email,
			tier: input.tier ?? 'solo',
			stripe_customer_id: input.stripe_customer_id,
			default_currency: input.default_currency ?? 'USD',
			created_at: new Date(),
			dek_wrapped,
			dek_salt,
		}
		store.set(id, row)
		return row
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
