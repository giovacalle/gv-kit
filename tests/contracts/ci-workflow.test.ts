import { describe, expect, test } from 'bun:test'

interface WorkflowStep {
	name?: string
	uses?: string
	with?: Record<string, string | number>
	env?: Record<string, string>
}

interface Workflow {
	jobs: Record<string, { steps: WorkflowStep[] }>
}

async function readWorkflow(): Promise<Workflow> {
	const source = await Bun.file('.github/workflows/ci.yml').text()
	return Bun.YAML.parse(source) as Workflow
}

describe('CI scaffold workflow contract', () => {
	test('runs generated projects on their declared Node 24 runtime', async () => {
		const workflow = await readWorkflow()
		const steps = workflow.jobs['scaffold-matrix']!.steps
		const setupNode = steps.find((step) => step.uses === 'actions/setup-node@v4')

		expect(setupNode?.with?.['node-version']).toBe(24)
	})

	test('provides every static public origin required by scaffold typecheck', async () => {
		const workflow = await readWorkflow()
		const steps = workflow.jobs['scaffold-matrix']!.steps
		const typecheck = steps.find((step) => step.name === 'Typecheck scaffolded')

		expect(typecheck?.env).toEqual({
			PUBLIC_AUTH_URL: 'https://auth.example.test',
			PUBLIC_MARKETING_URL: 'https://marketing.example.test',
			PUBLIC_APP_URL: 'https://app.example.test'
		})
	})
})
