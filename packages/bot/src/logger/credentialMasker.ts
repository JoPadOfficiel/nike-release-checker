/**
 * Masks sensitive credentials in strings before logging or display.
 * Emails: user@example.com → u***@example.com
 * Proxy URLs: http://user:pass@host:port → http://u***:***@host:port
 * Passwords: never logged — callers must not pass raw passwords
 */

export function maskEmail(email: string): string {
	const atIndex = email.indexOf('@')
	if (atIndex <= 0) return '***'
	return `${email[0]}***@${email.slice(atIndex + 1)}`
}

export function maskProxy(proxyUrl: string): string {
	// Match http://user:pass@host or http://user@host patterns
	return proxyUrl.replace(
		/^(https?:\/\/)([^:@]+)(?::([^@]+))?@/,
		(_match, protocol, _user, pass) => `${protocol}u***${pass !== undefined ? ':***' : ''}@`,
	)
}

export function maskCredentials(text: string): string {
	// Mask email-like patterns
	let masked = text.replace(/\b([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g, (_m, local, domain) => {
		return `${local[0]}***@${domain}`
	})
	// Mask proxy credentials
	masked = masked.replace(/(https?:\/\/)([^:@/\s]+)(?::([^@/\s]+))?@/g, (_match, protocol, _user, pass) => {
		return `${protocol}u***${pass !== undefined ? ':***' : ''}@`
	})
	return masked
}
