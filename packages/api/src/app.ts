import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import Fastify from 'fastify'

import { errorHandlerPlugin } from './plugins/errorHandler.ts'
import { requestIdPlugin } from './plugins/requestId.ts'
import { healthRoute } from './routes/health.ts'

export async function buildApp() {
	const app = Fastify({
		logger: {
			level: process.env['LOG_LEVEL'] ?? 'info',
			serializers: {
				req(req) {
					return {
						method: req.method,
						url: req.url,
						// Redact authorization header
						headers: Object.fromEntries(
							Object.entries(req.headers as Record<string, unknown>).filter(
								([k]) => k.toLowerCase() !== 'authorization',
							),
						),
					}
				},
				res(reply) {
					return { statusCode: reply.statusCode }
				},
			},
		},
		genReqId: () => {
			// Will be overwritten by requestIdPlugin after reading headers
			return ''
		},
		disableRequestLogging: false,
	})

	// Plugins
	await app.register(errorHandlerPlugin)
	await app.register(requestIdPlugin)

	// OpenAPI
	await app.register(fastifySwagger, {
		openapi: {
			openapi: '3.1.0',
			info: {
				title: 'Nike Bot API',
				version: '0.1.0',
				description: 'B2B REST API gateway for Nike drop orchestration',
			},
		},
	})

	await app.register(fastifySwaggerUi, {
		routePrefix: '/docs',
	})

	// Expose raw OpenAPI JSON
	app.get('/docs/openapi.json', async (_req, reply) => {
		await reply.send(app.swagger())
	})

	// Routes
	await app.register(healthRoute)

	return app
}
