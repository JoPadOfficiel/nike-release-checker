import { build } from 'esbuild'

await build({
	entryPoints: ['src/cli/index.ts'],
	bundle: true,
	platform: 'node',
	target: 'node24',
	format: 'cjs',
	outfile: 'dist/nike-bot.bundle.js',
	external: [
		'playwright',
		'playwright-extra',
		'playwright-core',
		'rebrowser-playwright',
		'better-sqlite3',
		// ink/yoga-layout use top-level await + ESM; react-devtools-core is optional.
		// Keep them as externals so the CJS SEA bundle builds; CI install step provides node_modules.
		'ink',
		'ink-spinner',
		'ink-text-input',
		'ink-testing-library',
		'yoga-layout',
		'react-devtools-core',
	],
	loader: {
		'.ts': 'ts',
		'.tsx': 'tsx',
	},
	resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.cjs', '.json'],
	jsx: 'automatic',
	minify: true,
	sourcemap: false,
	logLevel: 'info',
})
