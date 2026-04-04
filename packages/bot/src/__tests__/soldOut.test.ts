import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

// Helper to build a minimal mock Page
function makePage(options: {
  badgeVisible?: boolean
  atcVisible?: boolean
  atcEnabled?: boolean
  bodyText?: string
}): unknown {
  const { badgeVisible = false, atcVisible = true, atcEnabled = true, bodyText = '' } = options
  return {
    locator: (selector: string) => {
      // sold-out badge selector
      if (selector === '.sold-out-badge') {
        return {
          isVisible: async () => badgeVisible,
          isEnabled: async () => true,
        }
      }
      // ATC button selector
      return {
        isVisible: async () => atcVisible,
        isEnabled: async () => atcEnabled,
      }
    },
    textContent: async (_sel: string) => bodyText,
  }
}

// Minimal selectors for testing
const selectors = {
  productPage: {
    soldOutIndicator: '.sold-out-badge',
    addToCartButton: '.atc-button',
    sizeGrid: '',
    sizeButton: '',
  },
  cart: { checkoutButton: '', cartCount: '' },
  checkout: {
    shippingContinueButton: '',
    paymentSection: '',
    paymentContinueButton: '',
    threeDSIframe: '',
    submitOrderButton: '',
    orderConfirmation: '',
  },
  loginEmailInput: '',
  loginContinueButton: '',
  loginPasswordInput: '',
  loginSubmitButton: '',
  loginSuccessIndicator: '',
  loginErrorIndicator: '',
  sizeAvailable: '',
  sizeSelected: '',
  purchaseButton: '',
  checkoutLink: '',
  shippingSaveButton: '',
  paymentContinueButton: '',
  orderSubmitButton: '',
  soldOutIndicator: '',
  blockDetectionSignal: '',
  threeDSecureIframe: '',
}

describe('soldOutDetector', () => {
  test('returns not sold out when no signals detected', async () => {
    const { checkSoldOut } = await import('../checkout/detectors/soldOutDetector.ts')
    const page = makePage({ badgeVisible: false, atcEnabled: true, bodyText: 'Available now!' })
    const result = await checkSoldOut(page as never, selectors as never)
    assert.equal(result.soldOut, false)
    assert.equal(result.signal, null)
  })

  test('detects badge_sold_out signal', async () => {
    const { checkSoldOut } = await import('../checkout/detectors/soldOutDetector.ts')
    const page = makePage({ badgeVisible: true })
    const result = await checkSoldOut(page as never, selectors as never)
    assert.equal(result.soldOut, true)
    assert.equal(result.signal, 'badge_sold_out')
  })

  test('detects button_disabled signal when badge not visible', async () => {
    const { checkSoldOut } = await import('../checkout/detectors/soldOutDetector.ts')
    const page = makePage({ badgeVisible: false, atcVisible: true, atcEnabled: false })
    const result = await checkSoldOut(page as never, selectors as never)
    assert.equal(result.soldOut, true)
    assert.equal(result.signal, 'button_disabled')
  })

  test('detects text_detection signal for "sold out"', async () => {
    const { checkSoldOut } = await import('../checkout/detectors/soldOutDetector.ts')
    const page = makePage({ badgeVisible: false, atcEnabled: true, bodyText: 'Sorry, this product is sold out' })
    const result = await checkSoldOut(page as never, selectors as never)
    assert.equal(result.soldOut, true)
    assert.equal(result.signal, 'text_detection')
  })

  test('detects text_detection signal for "épuisé" (French)', async () => {
    const { checkSoldOut } = await import('../checkout/detectors/soldOutDetector.ts')
    const page = makePage({ badgeVisible: false, atcEnabled: true, bodyText: 'Ce produit est épuisé' })
    const result = await checkSoldOut(page as never, selectors as never)
    assert.equal(result.soldOut, true)
    assert.equal(result.signal, 'text_detection')
  })

  test('badge_sold_out takes priority over button_disabled', async () => {
    const { checkSoldOut } = await import('../checkout/detectors/soldOutDetector.ts')
    const page = makePage({ badgeVisible: true, atcEnabled: false })
    const result = await checkSoldOut(page as never, selectors as never)
    assert.equal(result.signal, 'badge_sold_out')
  })
})
