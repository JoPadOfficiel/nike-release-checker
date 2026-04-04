import { access, readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import * as v from 'valibot'
import { SelectorsSchema, type Selectors } from './selectorSchema.ts'

const DEFAULT_SELECTORS_PATH = './selectors.yaml'

export async function loadSelectors(selectorsPath?: string): Promise<Selectors> {
	const resolvedPath = selectorsPath ?? DEFAULT_SELECTORS_PATH

	const exists = await access(resolvedPath)
		.then(() => true)
		.catch(() => false)

	if (!exists) {
		throw new Error(
			`Selectors file not found: ${resolvedPath}\n` +
				`Copy selectors.example.yaml to selectors.yaml and customize if needed.`,
		)
	}

	const raw = await readFile(resolvedPath, 'utf-8')
	const parsed = parse(raw) as unknown

	try {
		return v.parse(SelectorsSchema, parsed)
	} catch (err) {
		if (err instanceof v.ValiError) {
			const flat = v.flatten(err.issues)
			const missingKeys = Object.keys(flat.nested ?? {})
			if (missingKeys.length > 0) {
				throw new Error(
					`Missing required selectors in ${resolvedPath}: ${missingKeys.join(', ')}`,
				)
			}
			throw new Error(`Invalid selectors file ${resolvedPath}:\n${err.message}`)
		}
		throw err
	}
}
