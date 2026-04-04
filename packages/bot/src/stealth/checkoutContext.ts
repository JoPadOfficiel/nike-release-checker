import { createStealthContext, type StealthContextOptions } from './contextFactory.ts'
import { loadAndInjectCookies } from '../auth/cookieStore.ts'
import type { BrowserContext } from 'playwright'

export interface CheckoutContextOptions extends StealthContextOptions {
	accountId: string
}

// STANDARD CHECKOUT WORKFLOW (used in Epic 4):
//
//   import { createCheckoutContext } from '../stealth/checkoutContext.ts'
//
//   const context = await createCheckoutContext({ accountId: account.id, proxy: account.proxy })
//   try {
//     await selectSize(context, slug, size)
//     await addToCart(context)
//     await navigateCheckout(context)
//     await fillShipping(context, account)
//     await fillPayment(context, account)
//     await submitOrder(context)
//   } finally {
//     await context.close()  // ALWAYS in finally — even if checkout throws
//   }
//
// PARALLEL EXECUTION (never use Promise.all — use Promise.allSettled):
//
//   const results = await Promise.allSettled(
//     accounts.map(account =>
//       createCheckoutContext({ accountId: account.id, proxy: account.proxy })
//         .then(context => runCheckout(context, account))
//     )
//   )

/**
 * Creates a stealth browser context and injects the Nike session cookies for the given account.
 *
 * This is the STANDARD checkout context lifecycle used by Epic 4.
 *
 * Throws if no session file exists for the account (see loadCookies error messages).
 * The caller should catch this error and skip checkout for that account.
 *
 * @param options.accountId - The stored account UUID
 * @param options.proxy - Optional proxy URL (http://user:pass@host:port)
 * @param options.headless - Default: true
 * @param options.locale - Default: 'fr-FR'
 * @param options.timezone - Default: 'Europe/Paris'
 */
export async function createCheckoutContext(
	options: CheckoutContextOptions,
): Promise<BrowserContext> {
	const { accountId, ...stealthOptions } = options
	const context = await createStealthContext(stealthOptions)
	try {
		await loadAndInjectCookies(context, accountId)
		return context
	} catch (err) {
		// If cookie injection fails for any reason, close the context immediately.
		// We do NOT want to leave orphaned browser contexts.
		// Suppress close() errors so the original error is always re-thrown.
		try { await context.close() } catch {}
		throw err
	}
}
