// NikeCartViewsApi — calls api.nike.com/buy/cart_views/v1/* via page.evaluate(() => fetch())
// so requests run inside the browser JS context where Kasada's injected ServiceWorker
// can attach valid x-kpsdk-cd proof-of-work headers.
// Bearer token is extracted from OIDC localStorage by getBearerToken().
//
// View UUIDs are client-generated (crypto.randomUUID). Nike allocates the resource
// on first PUT. See docs/NIKE_API_REFERENCE.md (Cart views section).
// Story 12.3, FR62.

import type { Page } from 'playwright'
import { randomUUID } from 'node:crypto'
import type { CartView, NikeAddress } from './cartViewsApi.types.ts'
import { getBearerToken } from './oidcBearer.ts'

const API_ORIGIN = 'https://api.nike.com'
const CART_VIEWS_BASE = '/buy/cart_views/v1'

// Injectable UUID generator so tests can stub it deterministically.
export type UuidGen = () => string
export const defaultUuidGen: UuidGen = () => randomUUID()

// ─── Error classes ────────────────────────────────────────────────────────────

export class CartViewTimeoutError extends Error {
	readonly viewId: string
	readonly lastStatus: string | undefined
	readonly elapsedMs: number

	constructor(viewId: string, lastStatus: string | undefined, elapsedMs: number) {
		super(`view ${viewId} timed out after ${elapsedMs}ms (last=${lastStatus})`)
		this.name = 'CartViewTimeoutError'
		this.viewId = viewId
		this.lastStatus = lastStatus
		this.elapsedMs = elapsedMs
	}
}

export class CartViewError extends Error {
	readonly view: CartView

	constructor(view: CartView) {
		super(`view ${view.viewId} entered ERROR: ${JSON.stringify(view.errors)}`)
		this.name = 'CartViewError'
		this.view = view
	}
}

// Known error code → BlockReason mapping (AC: error mapping).
// Callers can inspect CartViewApiError.nikeCode to derive BlockReason without
// importing blockReason.ts (avoids circular deps in the api layer).
export class CartViewApiError extends Error {
	readonly status: number
	readonly nikeCode: string | undefined
	readonly field: string | undefined
	readonly bodyPreview: string

	constructor(
		status: number,
		body: string,
		nikeCode?: string,
		field?: string,
	) {
		super(`Nike cart_views API → ${status}${nikeCode ? ` [${nikeCode}]` : ''}`)
		this.name = 'CartViewApiError'
		this.status = status
		this.nikeCode = nikeCode
		this.field = field
		this.bodyPreview = body.slice(0, 256)
	}
}

// ─── API client ───────────────────────────────────────────────────────────────

interface CartViewsRequestInit {
	method: 'GET' | 'PUT'
	data?: string
}

export class NikeCartViewsApi {
	private readonly page: Page
	private readonly uuidGen: UuidGen

	constructor(page: Page, uuidGen: UuidGen = defaultUuidGen) {
		this.page = page
		this.uuidGen = uuidGen
	}

	// Opens a shipping view for the given cartId. Generates a fresh client-side
	// viewUuid per call (Nike allocates the resource on first PUT).
	async openShippingView(cartId: string, address: NikeAddress): Promise<CartView> {
		const viewUuid = this.uuidGen()
		return this.put(viewUuid, { type: 'SHIPPING' as const, cartId, address })
	}

	// Polls GET /buy/cart_views/v1/{viewId} until status === 'READY' or timeout.
	async waitForView(
		viewId: string,
		opts: { timeoutMs?: number; intervalMs?: number } = {},
	): Promise<CartView> {
		const timeoutMs = opts.timeoutMs ?? 10_000
		const intervalMs = opts.intervalMs ?? 250
		const start = Date.now()
		let last: CartView | undefined

		while (Date.now() - start < timeoutMs) {
			last = await this.get(viewId)
			if (last.status === 'READY') return last
			if (last.status === 'ERROR') throw new CartViewError(last)
			await new Promise<void>((r) => setTimeout(r, intervalMs))
		}

		throw new CartViewTimeoutError(viewId, last?.status, Date.now() - start)
	}

	// ─── Private transport ────────────────────────────────────────────────────

	private put(viewUuid: string, body: unknown): Promise<CartView> {
		return this.request<CartView>(`${CART_VIEWS_BASE}/${viewUuid}`, {
			method: 'PUT',
			data: JSON.stringify(body),
		})
	}

	private get(viewId: string): Promise<CartView> {
		return this.request<CartView>(`${CART_VIEWS_BASE}/${viewId}`, {
			method: 'GET',
		})
	}

	private async request<T>(path: string, init: CartViewsRequestInit): Promise<T> {
		const token = await getBearerToken(this.page)

		const args = {
			url: `${API_ORIGIN}${path}`,
			method: init.method,
			headers: {
				accept: 'application/json',
				...(init.data !== undefined
					? { 'content-type': 'application/json; charset=UTF-8' }
					: {}),
			},
			data: init.data ?? null,
			token,
		}

		// Runs inside the browser JS context so Kasada's ServiceWorker intercept fires
		// and attaches x-kpsdk-cd / x-kpsdk-cr POW headers.
		const res = await this.page.evaluate(
			async (a: {
				url: string
				method: string
				headers: Record<string, string>
				data: string | null
				token: string
			}) => {
				const r = await fetch(a.url, {
					method: a.method,
					credentials: 'include',
					body: a.data ?? null,
					headers: {
						...a.headers,
						Authorization: 'Bearer ' + a.token,
					},
				})
				const headersObj: Record<string, string> = {}
				r.headers.forEach((v, k) => {
					headersObj[k] = v
				})
				let bodyText = ''
				try {
					bodyText = await r.text()
				} catch {
					bodyText = ''
				}
				return {
					status: r.status,
					headers: headersObj,
					body: bodyText,
					ok: r.ok,
				}
			},
			args,
		)

		if (!res.ok) {
			// Parse Nike error codes for known 4xx validation failures.
			let nikeCode: string | undefined
			let field: string | undefined
			try {
				const parsed = JSON.parse(res.body) as {
					errors?: Array<{ code?: string; field?: string }>
				}
				if (parsed.errors?.[0]) {
					nikeCode = parsed.errors[0].code
					field = parsed.errors[0].field
				}
			} catch {
				// Non-JSON body — leave nikeCode/field undefined.
			}
			throw new CartViewApiError(res.status, res.body, nikeCode, field)
		}

		try {
			return JSON.parse(res.body) as T
		} catch {
			throw new CartViewApiError(res.status, res.body)
		}
	}
}
