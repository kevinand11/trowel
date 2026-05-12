import path from 'node:path'

export type EnsureSandboxImageDeps = {
	dockerfileSrc: string
	dockerfileDst: string
	copyFile: (src: string, dst: string) => Promise<void>
	statFile: (filePath: string) => Promise<{ mtime: Date } | null>
	inspectImageCreatedAt: (imageName: string) => Promise<Date | null>
	buildImage: (imageName: string, dockerfilePath: string, buildContext: string) => Promise<void>
}

export async function ensureSandboxImage(imageName: string, deps: EnsureSandboxImageDeps): Promise<void> {
	let dst = await deps.statFile(deps.dockerfileDst)
	if (dst === null) {
		await deps.copyFile(deps.dockerfileSrc, deps.dockerfileDst)
		dst = await deps.statFile(deps.dockerfileDst)
		if (dst === null) throw new Error(`copyFile did not materialise ${deps.dockerfileDst}`)
	}
	const imageCreated = await deps.inspectImageCreatedAt(imageName)
	if (imageCreated === null || dst.mtime > imageCreated) {
		await deps.buildImage(imageName, deps.dockerfileDst, path.dirname(deps.dockerfileDst))
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	function makeDeps(overrides: Partial<EnsureSandboxImageDeps> = {}): EnsureSandboxImageDeps {
		return {
			dockerfileSrc: '/repo/assets/Dockerfile',
			dockerfileDst: '/home/user/.trowel/Dockerfile',
			copyFile: async () => {},
			statFile: async () => ({ mtime: new Date('2026-01-01T00:00:00Z') }),
			inspectImageCreatedAt: async () => new Date('2026-06-01T00:00:00Z'),
			buildImage: async () => {},
			...overrides,
		}
	}

	describe('ensureSandboxImage', () => {
		test('builds the image when no image with the given name exists locally', async () => {
			const builds: Array<{ imageName: string; dockerfilePath: string; buildContext: string }> = []
			await ensureSandboxImage('trowel:latest', makeDeps({
				inspectImageCreatedAt: async () => null,
				buildImage: async (imageName, dockerfilePath, buildContext) => {
					builds.push({ imageName, dockerfilePath, buildContext })
				},
			}))
			expect(builds).toHaveLength(1)
			expect(builds[0]!.imageName).toBe('trowel:latest')
		})

		test('rebuilds when the Dockerfile is newer than the image', async () => {
			let buildCount = 0
			await ensureSandboxImage('trowel:latest', makeDeps({
				statFile: async () => ({ mtime: new Date('2026-07-01T00:00:00Z') }), // newer
				inspectImageCreatedAt: async () => new Date('2026-06-01T00:00:00Z'),
				buildImage: async () => {
					buildCount += 1
				},
			}))
			expect(buildCount).toBe(1)
		})

		test('skips the build when the image is newer than the Dockerfile', async () => {
			let buildCount = 0
			await ensureSandboxImage('trowel:latest', makeDeps({
				statFile: async () => ({ mtime: new Date('2026-01-01T00:00:00Z') }), // older
				inspectImageCreatedAt: async () => new Date('2026-06-01T00:00:00Z'),
				buildImage: async () => {
					buildCount += 1
				},
			}))
			expect(buildCount).toBe(0)
		})

		test('lazy-copies dockerfileSrc → dockerfileDst when dst is missing, then builds', async () => {
			const copies: Array<{ src: string; dst: string }> = []
			let dstExists = false
			let buildCount = 0
			await ensureSandboxImage('trowel:latest', makeDeps({
				statFile: async (p) => (p === '/home/user/.trowel/Dockerfile' && dstExists ? { mtime: new Date('2026-07-01T00:00:00Z') } : null),
				copyFile: async (src, dst) => {
					copies.push({ src, dst })
					dstExists = true
				},
				inspectImageCreatedAt: async () => null,
				buildImage: async () => {
					buildCount += 1
				},
			}))
			expect(copies).toEqual([{ src: '/repo/assets/Dockerfile', dst: '/home/user/.trowel/Dockerfile' }])
			expect(buildCount).toBe(1)
		})

		test('does not copy when dockerfileDst already exists', async () => {
			let copyCalled = false
			await ensureSandboxImage('trowel:latest', makeDeps({
				copyFile: async () => {
					copyCalled = true
				},
			}))
			expect(copyCalled).toBe(false)
		})
	})
}
