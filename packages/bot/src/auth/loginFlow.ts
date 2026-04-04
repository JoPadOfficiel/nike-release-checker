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
		const outcome = await Promise.race([
			page
				.waitForSelector(selectors.loginSuccessIndicator, { timeout: STEP_TIMEOUT })
				.then(() => 'success' as const),
			page
				.waitForSelector(selectors.loginErrorIndicator, { timeout: STEP_TIMEOUT })
				.then(() => 'error' as const),
		])

		if (outcome === 'error') {
			const errorText = await page.textContent(selectors.loginErrorIndicator)
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
