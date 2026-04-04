import * as v from 'valibot'

export const SelectorsSchema = v.object({
	// Product page - size grid
	sizeAvailable: v.string(),
	sizeSelected: v.string(),
	purchaseButton: v.string(),

	// Cart / checkout navigation
	checkoutLink: v.string(),

	// Checkout - shipping step
	shippingSaveButton: v.string(),

	// Checkout - payment step
	paymentContinueButton: v.string(),

	// Checkout - order review step
	orderSubmitButton: v.string(),

	// Error detection
	soldOutIndicator: v.string(),
	blockDetectionSignal: v.string(),

	// 3D Secure detection
	threeDSecureIframe: v.string(),
})

export type Selectors = v.InferOutput<typeof SelectorsSchema>
