import type { FastifyRequest } from 'fastify'

// Audit log stub — Story 16.5 hardens this into real DB writes.
// Failure to write must NOT fail the request.

const PII_FIELDS = new Set(['paymentMethodId', 'payment_method_id', 'secret', 'password', 'token'])

function redact(body: unknown): unknown {
  if (body == null || typeof body !== 'object') return body
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    result[k] = PII_FIELDS.has(k) ? '[REDACTED]' : v
  }
  return result
}

export const audit = {
  log(req: FastifyRequest, action: string, resourceId: string, extra?: Record<string, unknown>): void {
    try {
      req.log.info({
        audit: true,
        customer_id: req.customerId,
        actor: req.apiKeyId,
        action,
        resource_type: 'drop',
        resource_id: resourceId,
        payload_redacted: redact(req.body as unknown),
        ...(extra != null ? { payload_extra: extra } : {}),
      })
    } catch (err) {
      req.log.warn({ err }, 'audit.log failed — non-blocking')
    }
  },
}
