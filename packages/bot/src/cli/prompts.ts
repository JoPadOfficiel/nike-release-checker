import { createInterface } from 'node:readline'

/**
 * Prompt the user for a passphrase on stdin, suppressing terminal echo so the
 * typed value does not appear on screen (and is not captured by terminal
 * scrollback). If stdin is not a TTY, echo suppression is a no-op — callers
 * should avoid piping passphrases through non-interactive streams anyway.
 */
export async function promptPassphrase(label = 'Passphrase: '): Promise<string> {
	const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (raw: boolean) => void }
	const isTTY = Boolean(stdin.isTTY)

	process.stdout.write(label)

	// Raw-mode path: read chars directly so we can suppress echo reliably.
	if (isTTY && typeof stdin.setRawMode === 'function') {
		return new Promise<string>((resolve, reject) => {
			const chunks: string[] = []
			stdin.setRawMode!(true)
			stdin.resume()
			stdin.setEncoding('utf8')

			const onData = (chunk: string) => {
				for (const ch of chunk) {
					const code = ch.charCodeAt(0)
					if (ch === '\n' || ch === '\r' || code === 4) {
						// Enter or Ctrl-D → finish
						cleanup()
						process.stdout.write('\n')
						resolve(chunks.join(''))
						return
					}
					if (code === 3) {
						// Ctrl-C → abort
						cleanup()
						process.stdout.write('\n')
						reject(new Error('Passphrase prompt aborted'))
						return
					}
					if (code === 127 || code === 8) {
						// Backspace
						chunks.pop()
						continue
					}
					chunks.push(ch)
				}
			}

			const cleanup = () => {
				stdin.setRawMode!(false)
				stdin.pause()
				stdin.removeListener('data', onData)
			}

			stdin.on('data', onData)
		})
	}

	// Fallback: readline with echo-suppressing stdout shim.
	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
	return new Promise<string>((resolve) => {
		const origWrite = process.stdout.write.bind(process.stdout)
		;(process.stdout as unknown as { write: (chunk: unknown, ...rest: unknown[]) => boolean }).write = (
			chunk: unknown,
			...rest: unknown[]
		) => {
			if (typeof chunk === 'string' && chunk !== '\n' && chunk !== label) return true
			return origWrite(chunk as string, ...(rest as []))
		}
		rl.question('', (answer: string) => {
			;(process.stdout as unknown as { write: typeof origWrite }).write = origWrite
			process.stdout.write('\n')
			rl.close()
			resolve(answer)
		})
	})
}

/**
 * Prompt for a free-form answer (no echo suppression). Used for confirmations.
 */
export async function promptLine(label: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
	return new Promise<string>((resolve) => {
		rl.question(label, (answer: string) => {
			rl.close()
			resolve(answer)
		})
	})
}
