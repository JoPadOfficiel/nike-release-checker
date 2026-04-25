// NikeCartApi — calls api.nike.com/buy/carts/v2/* via page.evaluate(() => fetch())
// so requests run inside the browser JS context where Kasada's injected ServiceWorker
// can attach valid x-kpsdk-cd proof-of-work headers (bypassed by page.request.fetch).
// Bearer token is extracted from OIDC localStorage by getBearerToken().
//
// See docs/NIKE_API_REFERENCE.md (Cart APIs, Anti-bot — KPSDK).
// POC validation: packages/bot/scripts/poc-page-evaluate-cart.ts

import type { Page } from 'playwright'
import type { Cart, JsonPatchOp } from './cartApi.types.ts'
import { kpsdkCacheHolder, refreshKpsdkToken } from '../../stealth/kpsdk/cache.js'
import { getBearerToken } from './oidcBearer.ts'
import { countryRegistry } from '../../country/registry.ts'
import type { Country } from '../../country/types.ts'
import { cartEndpoints } from './endpoints.ts'

export { UnknownCountryError } from '../../country/registry.ts'

const API_ORIGIN = 'https://api.nike.com'

// RFC 6901 JSON Pointer escaping: `~` → `~0`, `/` → `~1`. Required because
// `itemId` is interpolated into JSON Patch `path` strings (see removeItem,
// setQuantity). Order matters: tilde first, then slash.
const escapeJsonPointer = (token: string): string =>
	token.replace(/~/g, '~0').replace(/\//g, '~1')

// Local request-init shape. Named `CartRequestInit` so it does not shadow the
// global DOM `RequestInit` type when this file is imported elsewhere.
interface CartRequestInit {
	method: 'GET' | 'PATCH' | 'POST' | 'PUT' | 'DELETE'
	headers?: Record<string, string>
	data?: string
}

export class NikeCartApiError extends Error {
	readonly status: number
	readonly method: string
	readonly path: string
	readonly bodyPreview: string
	readonly headers: {
		'x-akamai-request-id'?: string
		'x-kpsdk-st'?: string
	}

	constructor(
		method: string,
		path: string,
		status: number,
		body: string,
		headers: Record<string, string>,
	) {
		super(`Nike cart API ${method} ${path} → ${status}`)
		this.name = 'NikeCartApiError'
		this.status = status
		this.method = method
		this.path = path
		// Redaction: truncate to 256 chars. Pattern-based PII redaction is owned
		// by Story 12.9 — see deferred-work.md.
		this.bodyPreview = body.slice(0, 256)
		// Redaction: only whitelist diagnostic headers — never sid / set-cookie / Authorization.
		// Lower-case keys defensively in case Playwright ever surfaces mixed-case headers.
		const lower = lowerCaseHeaders(headers)
		this.headers = {
			'x-akamai-request-id': lower['x-akamai-request-id'],
			'x-kpsdk-st': lower['x-kpsdk-st'],
		}
	}
}

function lowerCaseHeaders(
	headers: Record<string, string>,
): Record<string, string> {
	const out: Record<string, string> = {}
	for (const k of Object.keys(headers)) {
		out[k.toLowerCase()] = headers[k]!
	}
	return out
}

export class NikeCartApi {
	private readonly page: Page
	private readonly country: Country
	private readonly accountId: string | undefined

	constructor(page: Page, countryCode = 'FR', accountId?: string) {
		this.page = page
		// Throws UnknownCountryError immediately if countryCode is not in the registry.
		this.country = countryRegistry.get(countryCode)
		this.accountId = accountId
	}

	initVisitor(visitorId: string): Promise<Cart> {
		return this.patch([{ op: 'merge', path: '/', value: { visitorId } }])
	}

	addItem(
		skuId: string,
		slug: string,
		styleColor: string,
		quantity = 1,
	): Promise<Cart> {
		// AC5 "missing slug" branch: refuse early so we never send a malformed
		// `/fr/t//${styleColor}` URL to Nike. Surface as a rejection so callers
		// see a uniform Promise contract.
		if (!slug || !styleColor) {
			return Promise.reject(
				new Error(
					`addItem: slug and styleColor are required (slug=${JSON.stringify(slug)}, styleColor=${JSON.stringify(styleColor)})`,
				),
			)
		}
		return this.patch([
			{
				op: 'add',
				path: '/items',
				value: {
					itemData: { url: cartEndpoints.productUrl(this.country, slug, styleColor) },
					skuId,
					quantity,
				},
			},
		])
	}

	getCart(): Promise<Cart> {
		return this.request<Cart>(cartEndpoints.cartGet(this.country).slice(API_ORIGIN.length), { method: 'GET' })
	}

	removeItem(itemId: string): Promise<Cart> {
		// Nike's PATCH cart API rejects an RFC-6902-pure `remove` (it returns
		// 400 MISSING_REQUIRED on `value`). Live capture shows it expects a
		// `value` payload. Cast to JsonPatchOp via unknown — the type union
		// enforces RFC 6902 shape but Nike's server contract is laxer here.
		return this.patch([
			{
				op: 'remove',
				path: `/items/${escapeJsonPointer(itemId)}`,
				value: null,
			} as unknown as JsonPatchOp,
		])
	}

	setQuantity(itemId: string, quantity: number): Promise<Cart> {
		// qty=0 still issues `replace` — never auto-convert to remove.
		return this.patch([
			{
				op: 'replace',
				path: `/items/${escapeJsonPointer(itemId)}/quantity`,
				value: quantity,
			},
		])
	}

	private patch(ops: JsonPatchOp[]): Promise<Cart> {
		// Content-type note: the RFC 6902 standard says JSON Patch ops should be
		// served with `application/json-patch+json`, and Story 12.1 spec asked
		// for that. Live capture (api-trace.ndjson) and the 12.10 live run
		// (415 Unsupported Media Type response) both proved Nike's server
		// REJECTS that content-type when the request is issued from the page
		// JS context — it accepts only `application/json; charset=UTF-8`.
		// We follow what Nike actually accepts, not the standard.
		return this.request<Cart>(cartEndpoints.cart(this.country).slice(API_ORIGIN.length), {
			method: 'PATCH',
			headers: { 'content-type': 'application/json; charset=UTF-8' },
			data: JSON.stringify(ops),
		})
	}

	private async ensureKpsdkToken(): Promise<void> {
		if (!this.accountId) return
		const cache = kpsdkCacheHolder.instance
		const cached = cache.get(this.accountId, this.country.code)
		if (!cached) {
			// Cache miss — force-fire a synthetic KPSDK request to warm the page context.
			await refreshKpsdkToken(cache, this.accountId, this.country.code, this.page)
		}
		// Cache hit: page context is already warm, no force-fire needed.
	}

	private async request<T>(path: string, init: CartRequestInit): Promise<T> {
		await this.ensureKpsdkToken()
		// getBearerToken throws SessionExpiredError if no OIDC token is found —
		// let it propagate so withApiRetry maps it to outcome: 'session-expired'.
		const token = await getBearerToken(this.page)

		// All arguments passed into page.evaluate must be JSON-serializable
		// (structured-clone). Playwright serializes the second arg automatically;
		// do NOT JSON.stringify data here if it is already a string.
		// Accept: required by Nike — without it the API returns 400 REQUEST_INVALID
		// "Accept header currently only supports application/json" (live-confirmed).
		const args = {
			url: `${API_ORIGIN}${path}`,
			method: init.method,
			headers: { accept: 'application/json', ...(init.headers ?? {}) },
			data: init.data ?? null,
			token,
		}

		// The fetch runs in the browser's JS context so Kasada's ServiceWorker
		// intercept fires and attaches x-kpsdk-cd / x-kpsdk-cr POW headers.
		// credentials: 'include' attaches page-origin cookies (KP_UIDz, bm_sv, sid).
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
			throw new NikeCartApiError(
				init.method,
				path,
				res.status,
				res.body,
				res.headers,
			)
		}

		// 200 OK with HTML challenge / non-JSON body must surface as a typed
		// NikeCartApiError, not a raw SyntaxError.
		try {
			return JSON.parse(res.body) as T
		} catch {
			throw new NikeCartApiError(
				init.method,
				path,
				res.status,
				res.body,
				res.headers,
			)
		}
	}
}
