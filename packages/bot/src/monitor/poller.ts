import { getProductFeed, formatProductFeedResponse } from '@nike-release-checker/sdk'
import type { BotConfig } from '../config/botConfigSchema.ts'

export interface ProductStatus {
  slug: string
  availableSizes: string[]
  polledAt: Date
}

export type PollCallback = (status: ProductStatus) => void | Promise<void>

type FormattedRelease = ReturnType<typeof formatProductFeedResponse>[number]

/**
 * Extract available (in-stock) sizes from a formatted SDK release.
 * A size is available if its `level` is 'HIGH', 'LOW', or 'MEDIUM'.
 */
export function extractAvailableSizes(formatted: FormattedRelease[]): string[] {
  const availableSizes: string[] = []
  const AVAILABLE_LEVELS = new Set(['HIGH', 'LOW', 'MEDIUM'])

  for (const release of formatted) {
    for (const model of release.models) {
      for (const size of model.sizes) {
        if (AVAILABLE_LEVELS.has(size.level)) {
          availableSizes.push(size.size)
        }
      }
    }
  }

  // Deduplicate
  return [...new Set(availableSizes)]
}

/**
 * Fetch the current product status for a given slug.
 * Fetches the full Nike FR feed and filters to the requested slug.
 */
export async function fetchProductStatus(slug: string): Promise<ProductStatus> {
  const feed = await getProductFeed({ countryCode: 'FR', language: 'fr' })
  const formatted = formatProductFeedResponse(feed)
  // Filter to the specific slug
  const releaseForSlug = formatted.filter((r) => r.slug === slug)
  const availableSizes = extractAvailableSizes(releaseForSlug)
  return {
    slug,
    availableSizes,
    polledAt: new Date(),
  }
}

/**
 * Start polling a product slug on a fixed interval.
 * The polling loop stops cleanly when the AbortSignal is aborted.
 * Errors during a poll are caught and reported via the callback with an empty sizes array.
 */
export async function startPolling(
  slug: string,
  config: BotConfig,
  onPoll: PollCallback,
  signal: AbortSignal,
): Promise<void> {
  const intervalMs = config.polling?.interval ?? 5000

  while (!signal.aborted) {
    try {
      const status = await fetchProductStatus(slug)
      await onPoll(status)
    } catch (err) {
      // Report error but continue polling
      await onPoll({
        slug,
        availableSizes: [],
        polledAt: new Date(),
      })
      process.stderr.write(`[poller] Error polling ${slug}: ${err}\n`)
    }

    // Abort-aware sleep
    await abortableSleep(intervalMs, signal)
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}
