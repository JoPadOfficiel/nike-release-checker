// errorToBlockReason — single lookup table mapping every typed error to a
// BlockReason. Epic 12 + orchestrator (Epic 11) consume this exclusively.
// NEVER propagate raw error.message into outcomes — use this function.
//
// Stories 12.2-12.8 will register their own error classes here as they land.
// See TODO markers below.
//
// Story 12.9.

import type { BlockReason } from '../../outcomes/blockReason.ts'
import {
	KpsdkBlockedError,
	RateLimitedError,
	ServerError,
	SessionExpiredError,
} from './apiErrors.ts'
import { NikeCartApiError } from './cartApi.ts'
import { KpsdkBlockedError as KpsdkFetchBlockedError } from '../../stealth/kpsdk/protectedFetch.js'

// TODO(Story 12.2): import { CartViewTimeoutError, CartViewError } from './cartViewsApi.ts'
// TODO(Story 12.3): import { FulfillmentJobTimeoutError, FulfillmentJobFailedError, NoFulfillmentOfferingError } from './fulfillmentApi.ts'
// TODO(Story 12.4): import { NoPaymentMethodError, PaymentApiAuthError } from './paymentApi.ts'
// TODO(Story 12.5): import { TotalMismatchError, ReviewTimeoutError, ReviewError } from './reviewApi.ts'
// TODO(Story 12.6): import { CheckoutKpsdkBlockedError, CheckoutServerError, CheckoutDeclinedError } from './checkoutsApi.ts'
// TODO(Story 12.7): import { SkuNotFoundError, StyleColorNotFoundError } from './skuResolver.ts'

export const errorToBlockReason = (e: unknown): BlockReason => {
	// --- Envelope-level errors (Story 12.9) ---
	if (e instanceof KpsdkBlockedError) return 'blocked'
	// --- KPSDK fetch-level block (Story 14.3) — enriched with accountId/country/url/attempts ---
	if (e instanceof KpsdkFetchBlockedError) return 'blocked'
	if (e instanceof RateLimitedError) return 'rate_limited'
	if (e instanceof SessionExpiredError) return 'session_expired'
	if (e instanceof ServerError) return 'submit_failed'

	// --- Cart API base error (Story 12.1) ---
	if (e instanceof NikeCartApiError) return 'cart_error'

	// TODO(Story 12.2): CartViewTimeoutError → 'view_timeout'
	// TODO(Story 12.2): CartViewError → 'invalid_address'
	// TODO(Story 12.3): FulfillmentJobTimeoutError → 'fulfillment_timeout'
	// TODO(Story 12.3): FulfillmentJobFailedError → 'fulfillment_unavailable'
	// TODO(Story 12.3): NoFulfillmentOfferingError → 'no_shipping_method'
	// TODO(Story 12.4): NoPaymentMethodError → 'no_payment_method'
	// TODO(Story 12.4): PaymentApiAuthError → 'session_expired'
	// TODO(Story 12.5): TotalMismatchError → 'total_mismatch'
	// TODO(Story 12.5): ReviewTimeoutError → 'view_timeout'
	// TODO(Story 12.5): ReviewError → 'review_failed'
	// TODO(Story 12.6): CheckoutKpsdkBlockedError → 'blocked'
	// TODO(Story 12.6): CheckoutServerError → 'submit_failed'
	// TODO(Story 12.6): CheckoutDeclinedError → 'payment_declined'
	// TODO(Story 12.7): SkuNotFoundError → 'sku_not_available'
	// TODO(Story 12.7): StyleColorNotFoundError → 'style_color_not_found'

	return 'unknown_error'
}
