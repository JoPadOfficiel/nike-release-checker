/** @jsxImportSource react */
import { createElement } from 'react'
import { render } from 'ink'
import { Dashboard } from './Dashboard.tsx'
import type { DashboardProps } from './Dashboard.tsx'

export interface RenderDashboardHandle {
	waitUntilExit: () => Promise<void>
	unmount: () => void
}

/**
 * Render the live Dashboard to the terminal and return a handle to await or
 * unmount it. Thin wrapper around `ink`'s `render()` so callers (CLI) don't
 * need to import React or Ink directly.
 */
export function renderDashboard(props: DashboardProps): RenderDashboardHandle {
	const app = render(createElement(Dashboard, props))
	return {
		waitUntilExit: () => app.waitUntilExit(),
		unmount: () => app.unmount(),
	}
}
