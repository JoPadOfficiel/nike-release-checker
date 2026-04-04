import { maskProxy } from '../logger/credentialMasker.ts'
import type { ProxyTestResult } from './auth.types.ts'

const PROBE_URL = 'https://www.nike.com/'
const TIMEOUT_MS = 10_000

export async function testProxyConnectivity(proxyUrl: string): Promise<ProxyTestResult> {
	const start = performance.now()
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

	try {
		// Parse proxy URL to set up the request
		const url = new URL(proxyUrl)
		const proxyAuth =
			url.username && url.password
				? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`
				: undefined

		const proxyHost = `${url.hostname}:${url.port}`

		// Use Node.js native fetch with proxy tunnel via HTTPS_PROXY env variable approach
		// Node 24 native fetch does not support proxy configuration directly,
		// so we use a raw TCP tunnel via net.createConnection
		const response = await fetchThroughProxy(PROBE_URL, proxyHost, proxyAuth, controller.signal)

		const latencyMs = Math.round(performance.now() - start)
		clearTimeout(timer)

		if (response >= 200 && response < 500) {
			return { success: true, latencyMs }
		}
		return { success: false, latencyMs, error: `HTTP ${response}` }
	} catch (err) {
		clearTimeout(timer)
		const latencyMs = Math.round(performance.now() - start)
		const raw = err instanceof Error ? err.message : String(err)
		const masked = maskProxy(raw.includes(proxyUrl) ? raw.replace(proxyUrl, maskProxy(proxyUrl)) : raw)
		return { success: false, latencyMs, error: masked }
	}
}

async function fetchThroughProxy(
	targetUrl: string,
	proxyHost: string,
	proxyAuth: string | undefined,
	signal: AbortSignal,
): Promise<number> {
	const { connect } = await import('node:net')
	const { connect: tlsConnect } = await import('node:tls')

	const [proxyHostname, proxyPortStr] = proxyHost.split(':')
	const proxyPort = parseInt(proxyPortStr ?? '8080', 10)

	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error('Request aborted'))
			return
		}

		const target = new URL(targetUrl)
		const targetHost = target.hostname
		const targetPort = target.protocol === 'https:' ? 443 : 80

		const socket = connect(proxyPort, proxyHostname, () => {
			// Send CONNECT tunnel request
			const connectHeaders = [
				`CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
				`Host: ${targetHost}:${targetPort}`,
				...(proxyAuth ? [`Proxy-Authorization: ${proxyAuth}`] : []),
				'',
				'',
			].join('\r\n')

			socket.write(connectHeaders)
		})

		socket.once('error', (err) => reject(err))
		signal.addEventListener('abort', () => {
			socket.destroy()
			reject(new Error('Request aborted (timeout)'))
		})

		let buffer = ''
		socket.on('data', (chunk: Buffer) => {
			buffer += chunk.toString()

			if (buffer.includes('\r\n\r\n')) {
				const statusLine = buffer.split('\r\n')[0] ?? ''
				const statusCode = parseInt(statusLine.split(' ')[1] ?? '0', 10)

				if (statusCode !== 200) {
					socket.destroy()
					resolve(statusCode)
					return
				}

				// Tunnel established — do a quick HEAD request over TLS
				socket.removeAllListeners('data')
				const tlsSocket = tlsConnect({ socket, servername: targetHost }, () => {
					tlsSocket.write(
						[
							`HEAD / HTTP/1.1`,
							`Host: ${targetHost}`,
							`Connection: close`,
							'',
							'',
						].join('\r\n'),
					)
				})

				let tlsBuffer = ''
				tlsSocket.on('data', (tlsChunk: Buffer) => {
					tlsBuffer += tlsChunk.toString()
					if (tlsBuffer.includes('\r\n')) {
						const tlsStatus = parseInt(tlsBuffer.split(' ')[1] ?? '0', 10)
						tlsSocket.destroy()
						socket.destroy()
						resolve(tlsStatus)
					}
				})
				tlsSocket.on('error', (err) => {
					socket.destroy()
					reject(err)
				})
			}
		})
	})
}
