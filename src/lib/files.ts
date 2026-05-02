import type { GvKitConfig } from '../schema/config.js'

export type FileEntry = {
	path: string
	content: string
	mode?: number
}

export type GeneratorFn = (cfg: GvKitConfig) => FileEntry[]
