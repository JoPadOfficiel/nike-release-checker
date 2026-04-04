import * as v from 'valibot'

export const AccountConfigSchema = v.object({
	id: v.pipe(v.string(), v.minLength(1)),
	email: v.pipe(v.string(), v.email()),
	password: v.pipe(v.string(), v.minLength(1)),
	proxy: v.pipe(v.string(), v.url()),
	country: v.pipe(v.string(), v.length(2)),
	preferredSizes: v.optional(v.array(v.string()), []),
	paymentMethod: v.optional(v.string(), 'PRE_SAVED'),
})

export const AccountsArraySchema = v.array(AccountConfigSchema)

export type AccountConfig = v.InferOutput<typeof AccountConfigSchema>
