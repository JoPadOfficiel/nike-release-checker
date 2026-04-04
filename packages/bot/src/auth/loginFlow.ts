import type { Page } from 'playwright'
import type { Selectors } from '../config/selectorSchema.ts'
import type { LoginResult } from './auth.types.ts'

const LOGIN_URL = 'https://accounts.nike.com/'
const STEP_TIMEOUT = 20_000

export async function performNikeLogin(
	page: Page,
	email: string,
	password: string,
	selectors: Selectors,
): Promise<LoginResult> {
	const startMs = Date.now()
	try {
		await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT })

		// Step 1: Enter email and click continue
		await page.waitForSelector(selectors.loginEmailInput, { timeout: STEP_TIMEOUT })
		await page.fill(selectors.loginEmailInput, email)
		await page.click(selectors.loginContinueButton)

		// Step 2: Enter password and submit
		await page.waitForSelector(selectors.loginPasswordInput, { timeout: STEP_TIMEOUT })
		await page.fill(selectors.loginPasswordInput, password)
		await page.click(selectors.loginSubmitButton)

		// Step 3: Wait for success or error indicator (race)
		// .catch(() => null) absorbs the losing branch so it doesn't leak for the full STEP_TIMEOUT.
		// null means both indicators timed out → treat as timeout failure.
		const outcome = await Promise.race([
			page
				.waitForSelector(selectors.loginSuccessIndicator, { timeout: STEP_TIMEOUT })
				.then(() => 'success' as const)
				.catch(() => null),
			page
				.waitForSelector(selectors.loginErrorIndicator, { timeout: STEP_TIMEOUT })
				.then(() => 'error' as const)
				.catch(() => null),
		])

		if (outcome === null) {
			return {
				success: false,
				error: `Login timed out waiting for outcome (${STEP_TIMEOUT}ms)`,
				durationMs: Date.now() - startMs,
			}
		}

		if (outcome === 'error') {
			// Wrap in try/catch — element may detach between waitForSelector and textContent (TOCTOU)
			let errorText: string | null = null
			try {
				errorText = await page.textContent(selectors.loginErrorIndicator)
			} catch {
				// element detached; fall through to generic message
			}
			return {
				success: false,
				error: errorText?.trim() ?? 'Login error indicator detected',
				durationMs: Date.now() - startMs,
			}
		}

		return { success: true, durationMs: Date.now() - startMs }
	} catch (err) {
		return { success: false, error: String(err), durationMs: Date.now() - startMs }
	}
}
