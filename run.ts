#!/usr/bin/env bun

import * as fs   from "node:fs"
import * as path from "node:path"
import * as os   from "node:os"
import * as util from "node:util"

const INDEX_URL = "https://cef-builds.spotifycdn.com/index.json"
const VERSION_FILE = path.join(import.meta.dir, ".last_version")
const DIST_DIR = path.join(import.meta.dir, "dist")
const CEF_DIR = path.join(import.meta.dir, "cef")

type Platform = "linux64" | "linuxarm64" | "macosx64" | "macosarm64" | "windows64" | "windowsarm64"

const PLATFORMS: Platform[] = [
	"linux64",
	"linuxarm64",
	"macosx64",
	"macosarm64",
	"windows64",
	"windowsarm64",
]

interface Cef_Build_Info {
	version: string
	channel: string
	chromium_version: string
}

async function get_latest_version({beta = false} = {}): Promise<Cef_Build_Info | null> {
	let res = await fetch(INDEX_URL, {cache: "no-store"})
	if (!res.ok) {
		throw new Error(`Failed to fetch ${INDEX_URL}: ${res.status}`)
	}
	let index = await res.json() as Record<string, {versions?: Array<{cef_version: string; chromium_version: string; channel?: string}>}>

	let builds: Array<{version: string; channel: string; chromium_version: string; parts: number[]}> = []

	for (let entry of Object.values(index)) {
		for (let build of entry?.versions ?? []) {
			if (beta || !build.cef_version.includes("_beta")) {
				let match = build.cef_version.match(/^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/)
				builds.push({
					version: build.cef_version,
					channel: build.channel ?? "stable",
					chromium_version: build.chromium_version,
					parts: [
						Number(match?.[1] ?? 0),
						Number(match?.[2] ?? 0),
						Number(match?.[3] ?? 0),
						Number(match?.[4] ?? 0),
					],
				})
			}
		}
	}

	builds.sort((a, b) => {
		for (let i = 0; i < 4; i++) {
			let diff = (b.parts[i] ?? 0) - (a.parts[i] ?? 0)
			if (diff !== 0) return diff
		}
		return 0
	})

	let first = builds[0]
	if (!first) return null
	return {
		version: first.version,
		channel: first.channel,
		chromium_version: first.chromium_version,
	}
}

function read_last_version(): string | null {
	try {
		return fs.readFileSync(VERSION_FILE, "utf-8").trim()
	} catch {
		return null
	}
}

function write_last_version(version: string): void {
	fs.writeFileSync(VERSION_FILE, version)
}

function platform_to_cef(platform: string): string {
	if (PLATFORMS.includes(platform as Platform)) {
		return platform
	}
	throw new Error(`Unknown platform: ${platform}`)
}

function to_platform(os: string, arch: string): string {
	let os_name: string
	switch (os) {
	case "linux":  os_name = "linux"  ;break
	case "darwin": os_name = "macos"  ;break
	case "win32":  os_name = "windows";break
	default:       throw new Error(`Unsupported OS: ${os}`)
	}
	let arch_suffix = arch === "arm64" ? "arm64" : "64"
	return os_name + arch_suffix
}

function current_platform(): string {
	return to_platform(process.platform, process.arch)
}

async function cmd_latest(_args: {beta: boolean}): Promise<void> {
	let build_info = await get_latest_version({beta: _args.beta})
	if (!build_info) {
		console.error("No build found")
		process.exit(1)
	}
	console.log(build_info.version)
}

async function cmd_download(args: {
	platform: string | undefined
	cef_version: string | undefined
	chromium_version: string | undefined
	force: boolean
	skip_build: boolean
	package_only: boolean
}): Promise<void> {
	let platform = args.platform ?? current_platform()
	let cef_platform = platform_to_cef(platform)

	let cef_version = args.cef_version
	let chromium_version = args.chromium_version
	let channel = "stable"

	if (!cef_version || !chromium_version) {
		console.log("[download] No version specified, fetching latest...")
		let build_info = await get_latest_version()
		if (!build_info) {
			throw new Error("No CEF build found")
		}
		let match = build_info.version.match(/^(.+)\+chromium-(\d+\.\d+\.\d+\.\d+)$/)
		cef_version = cef_version ?? (match?.[1] ?? build_info.version)
		chromium_version = chromium_version ?? build_info.chromium_version
		channel = build_info.channel
	}

	let full_version = `${cef_version}+chromium-${chromium_version}`
	let output_dir = path.join(CEF_DIR, cef_platform)
	let build_dir = path.join(output_dir, "build")

	console.log(`[download] Platform: ${platform} (${cef_platform})`)
	console.log(`[download] Channel: ${channel}`)
	console.log(`[download] Version: ${full_version}`)

	let wrapper_path: string
	if (platform.startsWith("windows")) {
		wrapper_path = path.join(build_dir, "libcef_dll_wrapper", "Release", "libcef_dll_wrapper.lib")
	} else {
		wrapper_path = path.join(build_dir, "libcef_dll_wrapper", "libcef_dll_wrapper.a")
	}

	let version_file = path.join(output_dir, ".version")
	let existing_version = fs.existsSync(version_file) ? fs.readFileSync(version_file, "utf-8") : null
	let needs_download = args.force || !fs.existsSync(output_dir) || existing_version !== full_version

	if (args.package_only) {
		console.log("[download] Package-only mode")
	} else if (!needs_download && fs.existsSync(wrapper_path)) {
		console.log("[download] Already downloaded and built, skipping")
	} else {
		if (existing_version && existing_version !== full_version) {
			console.log(`[download] Version mismatch: ${existing_version} != ${full_version}`)
		}

		let channel_suffix = channel === "stable" ? "" : `_${channel}`
		let url = `https://cef-builds.spotifycdn.com/cef_binary_${cef_version}+chromium-${chromium_version}_${cef_platform}${channel_suffix}_minimal.tar.bz2`
		console.log(`[download] Downloading from: ${url}`)

		fs.mkdirSync(output_dir, {recursive: true})

		let tmp_dir = fs.mkdtempSync(path.join(os.tmpdir(), "cef-"))
		let archive = path.join(tmp_dir, "cef.tar.bz2")

		try {
			let res = await fetch(url)
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`)
			}
			let data = await res.arrayBuffer()
			fs.writeFileSync(archive, Buffer.from(data))

			console.log(`[download] Extracting...`)
			await new Promise<void>((resolve, reject) => {
				let proc = Bun.spawn(["tar", "-xjf", archive, "--strip-components=1", "-C", output_dir])
				proc.exited.then(code => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)))
			})

			fs.writeFileSync(version_file, full_version)
		} finally {
			fs.rmSync(tmp_dir, {force: true, recursive: true})
		}
	}

	if (!args.skip_build && !args.package_only) {
		console.log("[download] Building wrapper library...")

		fs.mkdirSync(build_dir, {recursive: true})

		let gen = platform === "win32" ? "Visual Studio 17 2022"
			: platform === "darwin" ? "Xcode"
			: "Unix Makefiles"

		await new Promise<void>((resolve, reject) => {
			let proc = Bun.spawn(["cmake", "-G", gen, "-DCMAKE_BUILD_TYPE=Release", "-B", "build", "-S", "."], {cwd: output_dir})
			proc.exited.then(code => code === 0 ? resolve() : reject(new Error(`cmake configure exited ${code}`)))
		})

		await new Promise<void>((resolve, reject) => {
			let jobs = os.cpus().length
			let cfg = platform === "win32" ? "Release" : ""
			let proc = Bun.spawn(["cmake", "--build", "build", "--target", "libcef_dll_wrapper", "-j", String(jobs), ...(cfg ? ["--config", cfg] : [])], {cwd: output_dir})
			proc.exited.then(code => code === 0 ? resolve() : reject(new Error(`cmake build exited ${code}`)))
		})

		console.log("[download] Build complete")
	}

	console.log("[download] Creating package...")

	let dist_name = `cef-${full_version}-${cef_platform}`
	let pkg_dir = path.join(DIST_DIR, dist_name, "package")
	fs.mkdirSync(pkg_dir, {recursive: true})

	let ext = platform.startsWith("windows") ? ".lib" : ".a"
	if (!fs.existsSync(wrapper_path)) throw new Error(`Wrapper not found: ${wrapper_path}`)
	fs.cpSync(wrapper_path, path.join(pkg_dir, `libcef_dll_wrapper${ext}`))
	fs.cpSync(path.join(output_dir, "include"), path.join(pkg_dir, "include"), {recursive: true})

	if (platform.startsWith("macos")) {
		fs.cpSync(path.join(output_dir, "Chromium Embedded Framework.framework"), path.join(pkg_dir, "Chromium Embedded Framework.framework"), {recursive: true})
	} else {
		fs.cpSync(path.join(output_dir, "Resources"), path.join(pkg_dir, "Resources"), {recursive: true})
		fs.cpSync(path.join(output_dir, "Release"), path.join(pkg_dir, "Release"), {recursive: true})
	}

	for (let f of ["LICENSE.txt", "CREDITS.html"]) {
		let src = path.join(output_dir, f)
		if (fs.existsSync(src)) fs.cpSync(src, path.join(pkg_dir, f))
	}

	let archive_path = path.join(DIST_DIR, dist_name, `${dist_name}.tar.gz`)
	await new Promise<void>((resolve, reject) => {
		let proc = Bun.spawn(["tar", "-czf", archive_path, "-C", pkg_dir, "."])
		proc.exited.then(code => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)))
	})

	let size = fs.statSync(archive_path).size
	console.log(`[download] Package: ${archive_path} (${(size / 1024 / 1024).toFixed(1)} MB)`)
}

async function cmd_workflow(args: {force: boolean; beta: boolean; platform: string | undefined; skip_build: boolean}): Promise<void> {
	console.log("[workflow] Starting CEF build workflow")

	let build_info = await get_latest_version({beta: args.beta})
	if (!build_info) {
		throw new Error("No CEF build found")
	}

	let match = build_info.version.match(/^(.+)\+chromium-(\d+\.\d+\.\d+\.\d+)$/)
	let cef_version = match?.[1] ?? build_info.version
	let chromium_version = match?.[2] ?? build_info.chromium_version

	console.log(`[workflow] Latest: ${build_info.version}`)

	let last_version = read_last_version()
	console.log(`[workflow] Last built: ${last_version ?? "(none)"}`)

	if (!args.force && last_version === build_info.version) {
		console.log("[workflow] Version unchanged, skipping")
		return
	}

	let target_platforms: Platform[] = args.platform
		? [args.platform as Platform]
		: PLATFORMS

	console.log(`[workflow] Building: ${target_platforms.join(", ")}`)

	let results: Array<{platform: Platform; success: boolean; error?: string}> = []

	for (let platform of target_platforms) {
		try {
			await cmd_download({
				platform,
				cef_version,
				chromium_version,
				force: args.force,
				skip_build: args.skip_build,
				package_only: false,
			})
			results.push({platform, success: true})
		} catch (e) {
			results.push({platform, success: false, error: String(e)})
		}
	}

	let failures = results.filter(r => !r.success)
	if (failures.length > 0) {
		console.error(`[workflow] ${failures.length} failed:`)
		for (let f of failures) {
			console.error(`  - ${f.platform}: ${f.error}`)
		}
		process.exit(1)
	}

	write_last_version(build_info.version)
	console.log(`[workflow] Updated version to ${build_info.version}`)

	let artifacts = PLATFORMS
		.map((p: Platform) => path.join(DIST_DIR, `cef-${build_info.version}-${p}`, `cef-${build_info.version}-${p}.tar.gz`))
		.filter(fs.existsSync)

	console.log(`[workflow] ${artifacts.length} artifacts:`)
	for (let a of artifacts) {
		let size = fs.statSync(a).size
		console.log(`  - ${path.basename(a)} (${(size / 1024 / 1024).toFixed(1)} MB)`)
	}

	console.log("[workflow] Done")
}

async function main(): Promise<void> {
	let {positionals, values} = util.parseArgs({
		allow_positionals: true,
		strict: false,
		options: {
			beta:             {type: "boolean"},
			force:            {type: "boolean"},
			platform:         {type: "string"},
			cef_version:      {type: "string"},
			chromium_version: {type: "string"},
			skip_build:       {type: "boolean"},
			package_only:     {type: "boolean"},
		},
	})

	let cmd = positionals[0] ?? "workflow"

	switch (cmd) {
	case "latest": {
		await cmd_latest({beta: Boolean(values.beta)})
		break
	}
	case "download": {
		await cmd_download({
			platform: typeof values.platform === "string" ? values.platform : undefined,
			cef_version: typeof values.cef_version === "string" ? values.cef_version : undefined,
			chromium_version: typeof values.chromium_version === "string" ? values.chromium_version : undefined,
			force: Boolean(values.force),
			skip_build: Boolean(values.skip_build),
			package_only: Boolean(values.package_only),
		})
		break
	}
	case "workflow": {
		await cmd_workflow({
			force: Boolean(values.force),
			beta: Boolean(values.beta),
			platform: typeof values.platform === "string" ? values.platform : undefined,
			skip_build: Boolean(values.skip_build),
		})
		break
	}
	default:
		console.error(`Unknown command: ${cmd}`)
		console.error("Usage: run.ts <latest|download|workflow>")
		process.exit(1)
	}
}

main().catch(e => {
	console.error(`Error: ${e}`)
	process.exit(1)
})
