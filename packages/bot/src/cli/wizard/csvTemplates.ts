import { writeFile, chmod, access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const ACCOUNTS_TEMPLATE = `# accounts.csv — one row per Nike account
# Columns:
#   account_id      unique id (alphanumeric/_/-), e.g. kev_001
#   email           Nike login email
#   password        Nike login password (stored locally only)
#   proxy_url       optional — http://user:pass@host:port OR socks5://...
#   country         ISO 2-letter code, default FR
#   preferred_sizes ";"-separated list, e.g. 42;42.5;43
account_id,email,password,proxy_url,country,preferred_sizes
# kev_001,sample@mail.com,password1,http://u:p@proxy1.com:8080,FR,42;42.5;43
# kev_002,sample2@mail.com,password2,,FR,41;42
`

const CARDS_TEMPLATE = `# cards.csv — one row per account (card data encrypted on import)
# Columns:
#   account_id     must match an entry in accounts.csv
#   card_number    13-19 digits, no spaces
#   expiry         MM/YY format, e.g. 12/27
#   cvv            3-4 digits
#   holder_name    as on card
# WARNING: delete this file AFTER running "nike-bot cards import" — data is then in encrypted SQLite
account_id,card_number,expiry,cvv,holder_name
# kev_001,4111111111111111,12/27,123,Kevin Dupont
`

const ADDRESSES_TEMPLATE = `# addresses.csv — shipping address per account
# Columns:
#   account_id   must match accounts.csv
#   street       street + number
#   city
#   zip
#   country      ISO 2-letter code
#   phone        optional, international format e.g. +33600000000
account_id,street,city,zip,country,phone
# kev_001,"10 rue de la Paix",Paris,75002,FR,+33600000000
`

const DROP_TEMPLATE = `# drop.csv — configure upcoming drops
# Columns:
#   sku              Nike SKU, e.g. AH7389-106
#   sizes            ";"-separated list to target, e.g. 42;42.5;43
#   accounts_filter  "all" or ";"-separated list of account_ids
sku,sizes,accounts_filter
# AH7389-106,"42;42.5;43",all
# IQ7604-101,"40;41",kev_001;kev_002
`

export type TemplateKey = 'accounts' | 'cards' | 'addresses' | 'drop'

const TEMPLATES: Record<TemplateKey, string> = {
	accounts: ACCOUNTS_TEMPLATE,
	cards: CARDS_TEMPLATE,
	addresses: ADDRESSES_TEMPLATE,
	drop: DROP_TEMPLATE,
}

export async function generateTemplates(
	folder: string,
	opts: { overwrite?: boolean } = {},
): Promise<{ created: TemplateKey[]; skipped: TemplateKey[] }> {
	await mkdir(folder, { recursive: true })
	const created: TemplateKey[] = []
	const skipped: TemplateKey[] = []
	for (const key of Object.keys(TEMPLATES) as TemplateKey[]) {
		const file = join(folder, `${key}.csv`)
		if (!opts.overwrite && (await fileExists(file))) {
			skipped.push(key)
			continue
		}
		await writeFile(file, TEMPLATES[key], 'utf8')
		if (key === 'accounts' || key === 'cards') {
			await chmod(file, 0o600)
		}
		created.push(key)
	}
	return { created, skipped }
}

async function fileExists(p: string): Promise<boolean> {
	try {
		await access(p)
		return true
	} catch {
		return false
	}
}
