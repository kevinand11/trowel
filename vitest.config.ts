import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: ['src/**/*.{test,spec}.ts'],
		includeSource: ['src/**/*.ts'],
	},
})
