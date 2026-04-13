import { getProductFeed, formatProductFeedResponse } from '@nike-release-checker/sdk'
import type { BotConfig } from '../config/botConfigSchema.ts'

export interface SkuResolveResult {
  slug: string
  productUrl: string
  styleColor: string
}

/**
 * Poll the Nike product feed until a SKU (styleColor, e.g. "IQ7604-101") appears.
 * Nike publishes the product a few minutes before drop time — this function blocks
 * until it shows up, then returns the slug and product URL ready for checkout.
 *
 * @param sku - The Nike styleColor code, e.g. "IQ7604-101"
 * @param config - Bot config (market/language)
 * @param signal - AbortSignal to cancel polling (e.g. on timeout)
 * @param pollIntervalMs - How often to poll (default: 3000ms on drop day)
 */
export async function resolveSkuToSlug(
  sku: string,
  config?: BotConfig,
  signal?: AbortSignal,
  pollIntervalMs = 3000,
): Promise<SkuResolveResult> {
  const countryCode = (config?.checkout?.market ?? 'FR') as Parameters<typeof getProductFeed>[0]['countryCode']
  const language = (config?.checkout?.language ?? 'fr') as Parameters<typeof getProductFeed>[0]['language']
  const normalizedSku = sku.toUpperCase()

  while (!signal?.aborted) {
    const feed = await getProductFeed({ countryCode, language })

    for (const thread of feed) {
      const productInfos = (thread as any).productInfo ?? []
      for (const pi of productInfos) {
        const styleColor: string = pi?.merchProduct?.styleColor ?? ''
        if (styleColor.toUpperCase() === normalizedSku) {
          // Found — resolve slug from publishedContent nodes
          const nodes: any[] = thread?.publishedContent?.nodes ?? []
          let slug = ''
          for (const node of nodes) {
            const s = node?.properties?.slug ?? node?.nodes?.find((n: any) => n?.properties?.slug)?.properties?.slug
            if (s) { slug = s; break }
          }
          // Fallback: search in full thread JSON
          if (!slug) {
            const match = JSON.stringify(thread).match(/"slug":"([^"]+)"/)
            if (match) slug = match[1]!
          }
          if (!slug) throw new Error(`SKU ${sku} found in feed but no slug could be extracted`)
          return {
            slug,
            productUrl: `https://www.nike.com/fr/launch/t/${slug}`,
            styleColor,
          }
        }
      }
    }

    process.stderr.write(`[resolveSkuToSlug] SKU ${sku} not in feed yet — retrying in ${pollIntervalMs}ms\n`)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollIntervalMs)
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
  }

  throw new Error(`resolveSkuToSlug aborted before finding SKU ${sku}`)
}

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
 * Uses countryCode and language from the bot config (defaults to FR/fr).
 */
export async function fetchProductStatus(
  slug: string,
  config?: BotConfig,
): Promise<ProductStatus> {
  const countryCode = (config?.checkout?.market ?? 'FR') as Parameters<typeof getProductFeed>[0]['countryCode']
  const language = (config?.checkout?.language ?? 'fr') as Parameters<typeof getProductFeed>[0]['language']
  const feed = await getProductFeed({ countryCode, language })
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
      const status = await fetchProductStatus(slug, config)
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
