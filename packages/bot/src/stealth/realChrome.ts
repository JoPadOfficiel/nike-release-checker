/**
 * Launches the REAL Google Chrome as an independent process (NOT via Playwright),
 * then connects Playwright to it via CDP. This avoids Playwright's launch-time
 * instrumentation which Kasada/Akamai can fingerprint.
 *
 * Key difference vs chromium.launch({ channel: 'chrome' }):
 *   - Playwright launch: Playwright forks Chrome + injects CDP hooks at startup
 *     → Kasada detects automation signals and freezes the page
 *   - connectOverCDP: Chrome runs normally, Playwright only attaches afterwards
 *     → Chrome behaves identically to a regular user-launched browser
 *
 * The user must NOT close the Chrome window we launch — we manage its lifecycle.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import type { BrowserContext } from 'playwright'

const CHROME_PATHS: string[] = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',  // macOS
  '/usr/bin/google-chrome',  // Linux
  '/usr/bin/google-chrome-stable',  // Linux
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',  // Windows
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',  // Windows
]

function findChromeBinary(): string {
  for (const p of CHROME_PATHS) {
    if (existsSync(p)) return p
  }
  throw new Error('Google Chrome not found. Install it from https://www.google.com/chrome/')
}

export interface RealChromeHandle {
  context: BrowserContext
  close: () => Promise<void>
}

export interface RealChromeOptions {
  headless?: boolean  // Default: false (visible browser)
  port?: number  // Default: 9222
  userDataDir?: string  // Default: ~/.nike-bot/chrome-profile
  locale?: string  // Default: 'fr-FR'
  timezone?: string  // Default: 'Europe/Paris'
  accountId?: string  // When set, uses a per-account profile under ~/.nike-bot/profiles/{accountId}
}

/**
 * Per-account persistent profile directory.
 * Each account gets an isolated Chrome profile so sessions don't mix across accounts.
 */
export function accountProfileDir(accountId: string): string {
  // Strip unsafe path characters from accountId
  const safe = accountId.replace(/[^a-zA-Z0-9@._-]/g, '_')
  return join(homedir(), '.nike-bot', 'profiles', safe)
}

/**
 * Launch real Chrome as an independent process and attach Playwright via CDP.
 * The returned BrowserContext is the DEFAULT context (persistent profile).
 *
 * Cookies, localStorage, and login state PERSIST between runs in the userDataDir.
 * This means: log in once manually, and all subsequent runs use that session.
 */
export async function launchRealChrome(
  options: RealChromeOptions = {},
): Promise<RealChromeHandle> {
  const {
    headless = false,
    port = 9222,
    accountId,
    userDataDir = accountId
      ? accountProfileDir(accountId)
      : join(homedir(), '.nike-bot', 'chrome-profile'),
    locale = 'fr-FR',
  } = options
  // timezone option reserved for future DevTools Protocol call; Chrome inherits system TZ for now
  void options.timezone

  mkdirSync(userDataDir, { recursive: true })

  const chromeBin = findChromeBinary()
  const args: string[] = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--lang=${locale}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1920,1080',
    '--window-position=100,50',  // Explicit position so it's on-screen
    '--start-maximized',  // Full-screen so user can see clearly
  ]
  // Load extensions from ~/.nike-bot/extensions if they exist (e.g. captcha solvers)
  const extensionsDir = join(homedir(), '.nike-bot', 'extensions')
  if (existsSync(extensionsDir)) {
    // Playwright with launched Chrome reads subdirectories as separate extensions
    const { readdirSync } = await import('node:fs')
    const exts = readdirSync(extensionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(extensionsDir, d.name))
    if (exts.length > 0) {
      args.push(`--load-extension=${exts.join(',')}`)
      args.push(`--disable-extensions-except=${exts.join(',')}`)
      console.log(`  [chrome] Loading ${exts.length} extension(s) from ${extensionsDir}`)
    }
  }
  if (headless) {
    args.push('--headless=new')
    // Override the leaked `HeadlessChrome/...` UA — Kasada/Akamai fingerprints
    // it within the first request. Mirror a real desktop Chrome on macOS.
    args.push(
      '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    )
  }

  // Spawn Chrome detached from our process
  const chromeProcess: ChildProcess = spawn(chromeBin, args, {
    detached: false,
    stdio: 'ignore',
  })

  // Wait for the debugging port to be ready
  const cdpUrl = `http://localhost:${port}`
  const MAX_WAIT_MS = 10_000
  const start = Date.now()
  while (Date.now() - start < MAX_WAIT_MS) {
    try {
      const res = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) break
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 200))
  }

  // Connect Playwright to the running Chrome via CDP
  const browser = await chromium.connectOverCDP(cdpUrl)
  const contexts = browser.contexts()
  const context = contexts[0] ?? (await browser.newContext())

  // Apply locale/timezone at the context level
  // Note: these only affect NEW pages opened via context.newPage(),
  // not the initial "New Tab" page that Chrome created at startup.
  await context.setExtraHTTPHeaders({
    'Accept-Language': `${locale},fr;q=0.9,en-US;q=0.8,en;q=0.7`,
  })

  // Remove Nike cookie consent modal via DOM MutationObserver.
  // Nike's cookie modal appears on every page and its backdrop intercepts
  // all click events. Clicking decline/accept doesn't reliably dismiss it
  // (Nike's backend rejects automated events), so we remove it from DOM.
  await context.addInitScript(`
    (function () {
      function nukeCookieModal() {
        var backdrop = document.querySelector('[data-testid="modal-backdrop"]');
        if (backdrop && backdrop.parentElement) {
          backdrop.parentElement.removeChild(backdrop);
        }
        var root = document.querySelector('[data-testid="cookie-modal-root"]');
        if (root && root.parentElement) {
          root.parentElement.removeChild(root);
        }
        var wrapper = document.querySelector('.modal-portal-content-wrapper');
        if (wrapper && wrapper.parentElement && wrapper.querySelector('[data-testid="cookie-modal"]')) {
          wrapper.parentElement.removeChild(wrapper);
        }
      }
      nukeCookieModal();
      var obs = new MutationObserver(function () { nukeCookieModal(); });
      if (document.body) {
        obs.observe(document.body, { childList: true, subtree: true });
      } else {
        document.addEventListener('DOMContentLoaded', function () {
          obs.observe(document.body, { childList: true, subtree: true });
          nukeCookieModal();
        });
      }
    })();
  `)

  const close = async (): Promise<void> => {
    try {
      await browser.close()
    } catch {
      // ignore
    }
    try {
      chromeProcess.kill('SIGTERM')
      // Force kill after grace period
      setTimeout(() => {
        try { chromeProcess.kill('SIGKILL') } catch {}
      }, 3000)
    } catch {
      // ignore
    }
  }

  return { context, close }
}
