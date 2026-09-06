import { describe, expect, test } from 'bun:test'
import { generateDeploy } from '../../src/generators/deploy.js'
import { runGenerators } from '../../src/generators/index.js'
import type { GvKitConfig } from '../../src/schema/config.js'

const config: GvKitConfig = {
	configVersion: 2,
	choices: {
		name: 'streaming',
		frontend: 'sveltekit',
		marketing: 'inside-web',
		backend: 'hono',
		i18n: 'skip',
		monitoring: [],
		db: 'postgres',
		apiClient: 'hey-api',
		auth: ['emailOTP'],
		email: 'resend',
		aiTooling: [],
		deploy: 'docker'
	}
}

function ingressConfig(): string {
	return generateDeploy(config).find(
		(entry) => entry.path === 'docker/ingress.conf.template'
	)!.content
}

function locationBlocks(content: string): string[] {
	const blocks: string[] = []
	const starts = content.matchAll(/^\s*location\s+[^{]+\{/gm)
	for (const start of starts) {
		const openingBrace = start.index! + start[0].length - 1
		let depth = 1
		for (let index = openingBrace + 1; index < content.length; index += 1) {
			if (content[index] === '{') depth += 1
			if (content[index] === '}') depth -= 1
			if (depth === 0) {
				blocks.push(content.slice(start.index!, index + 1))
				break
			}
		}
	}
	return blocks
}

describe('Docker gateway streaming ingress', () => {
	test('disables request and response buffering on every public gateway location', () => {
		const gatewayLocations = locationBlocks(ingressConfig()).filter((location) =>
			location.includes('proxy_pass http://gateway_upstream;')
		)

		expect(gatewayLocations).toHaveLength(3)
		for (const location of gatewayLocations) {
			expect(location).toContain('proxy_http_version 1.1;')
			expect(location).toContain('proxy_request_buffering off;')
			expect(location).toContain('proxy_buffering off;')
		}
	})

	test('leaves the non-API web proxy buffering policy unchanged', () => {
		const webLocations = locationBlocks(ingressConfig()).filter((location) =>
			location.includes('proxy_pass http://web_upstream;')
		)

		expect(webLocations).toHaveLength(1)
		expect(webLocations[0]).not.toContain('proxy_request_buffering')
		expect(webLocations[0]).not.toContain('proxy_buffering')
	})

	test('lets the Node transport reframe chunked bodies for its upstream connection', () => {
		const entrypoint = runGenerators(config).find(
			(entry) => entry.path === 'apps/api/src/index.ts'
		)!.content

		expect(entrypoint).toContain("forwarded.headers.delete('transfer-encoding')")
		expect(entrypoint).toContain("return fetch(forwarded, { redirect: 'manual' })")
	})
})
