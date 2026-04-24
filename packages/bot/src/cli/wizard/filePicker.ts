import { spawn } from 'node:child_process'
import { platform } from 'node:os'

/**
 * Open a native file picker. Returns the absolute path selected by the user,
 * or undefined if the user cancelled / the platform has no picker available.
 *
 * macOS → osascript "choose file" dialog.
 * Linux/Windows → no native picker wired up; returns undefined so callers fall
 * back to typing a path manually.
 */
export function openFilePicker(): Promise<string | undefined> {
	if (platform() !== 'darwin') {
		return Promise.resolve(undefined)
	}

	return new Promise((resolve) => {
		const script =
			'set f to choose file with prompt "Select a CSV file"\n' +
			'POSIX path of f'

		const child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
		let stdout = ''
		let stderr = ''

		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf8')
		})
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8')
		})

		child.on('error', () => resolve(undefined))
		child.on('close', (code) => {
			if (code !== 0) {
				// User cancelled or osascript errored — degrade gracefully.
				if (stderr.includes('User canceled')) return resolve(undefined)
				return resolve(undefined)
			}
			const trimmed = stdout.trim().replace(/^['"]|['"]$/g, '')
			resolve(trimmed.length > 0 ? trimmed : undefined)
		})
	})
}
