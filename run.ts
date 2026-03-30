#!/usr/bin/env bun

import * as fs   from "node:fs"
import * as path from "node:path"
import * as os   from "node:os"
import * as util from "node:util"

const INDEX_URL    = "https://cef-builds.spotifycdn.com/index.json"
const VERSION_FILE = path.join(import.meta.dir, ".last_version")
const DIST_DIR     = path.join(import.meta.dir, "dist")
const CEF_DIR      = path.join(import.meta.dir, "cef")

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

async function get_latest_version(args: Global_Args): Promise<Cef_Build_Info | null> {

	let res = await fetch(INDEX_URL, {cache: "no-store"})
	if (!res.ok) {
		throw new Error(`Failed to fetch ${INDEX_URL}: ${res.status}`)
	}
	let index = await res.json() as Record<string, {versions?: Array<{cef_version: string; chromium_version: string; channel: string}>}>

    let platform_index = index[args.platform]
    if (platform_index == null) return null

    let versions = platform_index.versions
    if (versions == null) return null

    let largest: [number, number, number, number] = [0,0,0,0]
    let result: Cef_Build_Info | null = null

    builds: for (let build of versions) {

        if ((build.channel === "beta") !== args.beta) {
            continue // wrong channel
        }

        let cef_version = build.cef_version.match(/^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/)
        if (cef_version == null) continue // incorrect version format

        for (let i = 0; i < 4; i += 1) {
            let str = cef_version[i]
            if (str == null) continue builds
            let n = Number(str)
            let c = largest[i]!
            if (n < c) continue builds
            if (n > c) {
                // Found next largest version
                for (let i = 0; i < 4; i += 1) {
                    largest[i] = Number(cef_version[i])
                }
                result = {
                    version:          build.cef_version,
                    chromium_version: build.chromium_version,
                    channel:          build.channel,
                }
            }
        }
    }

    return result
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

function parse_version(version: string): {cef: string; chromium: string} | null {
	let match = version.match(/^(.+)\+chromium-(\d+\.\d+\.\d+\.\d+)$/)
	if (match) {
		return {cef: match[1]!, chromium: match[2]!}
	}
	match = version.match(/^(\d+\.\d+\.\d+(?:\.\d+)?)$/)
	if (match) {
		return {cef: match[1]!, chromium: ""}
	}
	return null
}

interface Global_Args {
	platform: string
	beta:     boolean
}

function parse_global_args(args: string[]): Global_Args {
	let {values} = util.parseArgs({
		args,
        strict: false,
		options: {
			"platform": {type: "string",  short: "p"},
			"beta":     {type: "boolean", default: false},
		},
	})
	return {
		platform: typeof values.platform === "string" ? values.platform : current_platform(),
		beta: Boolean(values.beta),
	}
}

async function cmd_latest(cmd_args: string[]): Promise<void> {

	let args = parse_global_args(cmd_args)
	let build_info = await get_latest_version(args)
	if (!build_info) {
		console.error("No build found")
		process.exit(1)
	}
	console.log(build_info.version)
}

interface Download_Args extends Global_Args {
	version: string | undefined
	force: boolean
	skip_download: boolean
	skip_build: boolean
	skip_package: boolean
}

function parse_download_args(cmd_args: string[]): Download_Args {
	let {values} = util.parseArgs({
		args: cmd_args,
        strict: false,
		options: {
			"version":       {type: "string",  short: "v"},
			"force":         {type: "boolean", short: "f"},
			"skip-download": {type: "boolean"},
			"skip-build":    {type: "boolean"},
			"skip-package":  {type: "boolean"},
		},
	})
	return {
		...parse_global_args(cmd_args),
		version: typeof values.version === "string" ? values.version : undefined,
		force: Boolean(values.force),
		skip_download: Boolean(values["skip-download"]),
		skip_build: Boolean(values["skip-build"]),
		skip_package: Boolean(values["skip-package"]),
	}
}

async function cmd_download(cmd_args: string[]): Promise<void> {

	let args = parse_download_args(cmd_args)
	let cef_platform = platform_to_cef(args.platform)

    console.log(args, args.platform, cef_platform)

	let cef_version: string
	let chromium_version: string
	let channel: string

	if (args.version) {
		let parsed = parse_version(args.version)
		if (!parsed) {
			throw new Error(`Invalid version format: ${args.version}`)
		}
		if (!parsed.chromium) {
			throw new Error(`Short version requires fetching full version info. Use full version or omit --version`)
		}
		cef_version = parsed.cef
		chromium_version = parsed.chromium
		channel = "stable"
	} else {
		console.log("[download] No version specified, fetching latest...")
		let build_info = await get_latest_version(args)
		if (!build_info) {
			throw new Error("No CEF build found")
		}
		let parsed = parse_version(build_info.version)
		cef_version = parsed?.cef ?? build_info.version
		chromium_version = parsed?.chromium ?? ""
		channel = build_info.channel
	}

	let full_version = `${cef_version}+chromium-${chromium_version}`
	let output_dir = path.join(CEF_DIR, cef_platform)
	let build_dir = path.join(output_dir, "build")

	console.log(`[download] Platform: ${args.platform} (${cef_platform})`)
	console.log(`[download] Channel: ${channel}`)
	console.log(`[download] Version: ${full_version}`)

	let wrapper_path: string
	if (args.platform.startsWith("windows")) {
		wrapper_path = path.join(build_dir, "libcef_dll_wrapper", "Release", "libcef_dll_wrapper.lib")
	} else {
		wrapper_path = path.join(build_dir, "libcef_dll_wrapper", "libcef_dll_wrapper.a")
	}

	let version_file = path.join(output_dir, ".version")
	let existing_version = fs.existsSync(version_file) ? fs.readFileSync(version_file, "utf-8") : null
	let needs_download = args.force || !fs.existsSync(output_dir) || existing_version !== full_version

	if (args.skip_download) {
		console.log("[download] Skipping download")
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

	if (!args.skip_build) {
		console.log("[download] Building wrapper library...")

		fs.mkdirSync(build_dir, {recursive: true})

		let gen = args.platform === "win32" ? "Visual Studio 17 2022"
			: args.platform === "darwin" ? "Xcode"
			: "Unix Makefiles"

		await new Promise<void>((resolve, reject) => {
			let proc = Bun.spawn(["cmake", "-G", gen, "-DCMAKE_BUILD_TYPE=Release", "-B", "build", "-S", "."], {cwd: output_dir})
			proc.exited.then(code => code === 0 ? resolve() : reject(new Error(`cmake configure exited ${code}`)))
		})

		await new Promise<void>((resolve, reject) => {
			let jobs = os.cpus().length
			let cfg = args.platform === "win32" ? "Release" : ""
			let proc = Bun.spawn(["cmake", "--build", "build", "--target", "libcef_dll_wrapper", "-j", String(jobs), ...(cfg ? ["--config", cfg] : [])], {cwd: output_dir})
			proc.exited.then(code => code === 0 ? resolve() : reject(new Error(`cmake build exited ${code}`)))
		})

		console.log("[download] Build complete")
	}

	if (!args.skip_package) {
		console.log("[download] Creating package...")

		let dist_name = `cef-${full_version}-${cef_platform}`
		let pkg_dir = path.join(DIST_DIR, dist_name, "package")
		fs.mkdirSync(pkg_dir, {recursive: true})

		let ext = args.platform.startsWith("windows") ? ".lib" : ".a"
		if (!fs.existsSync(wrapper_path)) throw new Error(`Wrapper not found: ${wrapper_path}`)
		fs.cpSync(wrapper_path, path.join(pkg_dir, `libcef_dll_wrapper${ext}`))
		fs.cpSync(path.join(output_dir, "include"), path.join(pkg_dir, "include"), {recursive: true})

		if (args.platform.startsWith("macos")) {
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
}

interface Workflow_Args extends Global_Args {
	force: boolean
	skip_download: boolean
	skip_build: boolean
	skip_package: boolean
}

function parse_workflow_args(cmd_args: string[]): Workflow_Args {
	let {values} = util.parseArgs({
		args: cmd_args,
		options: {
			"platform":      {type: "string",  short: "p"},
			"beta":          {type: "boolean", default: false},
			"force":         {type: "boolean", short: "f"},
			"skip-download": {type: "boolean"},
			"skip-build":    {type: "boolean"},
			"skip-package":  {type: "boolean"},
		},
	})
	return {
		...parse_global_args(cmd_args),
		force: Boolean(values.force),
		skip_download: Boolean(values["skip-download"]),
		skip_build: Boolean(values["skip-build"]),
		skip_package: Boolean(values["skip-package"]),
	}
}

async function cmd_workflow(cmd_args: string[]): Promise<void> {

	let args = parse_workflow_args(cmd_args)
	console.log("[workflow] Starting CEF build workflow")

	let build_info = await get_latest_version(args)
	if (!build_info) {
		throw new Error("No CEF build found")
	}

	let parsed = parse_version(build_info.version)
	let cef_version = parsed?.cef ?? build_info.version
	let chromium_version = parsed?.chromium ?? ""

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
			await build_platform({
				platform,
				cef_version,
				chromium_version,
				skip_download: args.skip_download,
				skip_build: args.skip_build,
				skip_package: args.skip_package,
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

	let full_version = `${cef_version}+chromium-${chromium_version}`
	let artifacts = PLATFORMS
		.map((p: Platform) => path.join(DIST_DIR, `cef-${full_version}-${p}`, `cef-${full_version}-${p}.tar.gz`))
		.filter(fs.existsSync)

	console.log(`[workflow] ${artifacts.length} artifacts:`)
	for (let a of artifacts) {
		let size = fs.statSync(a).size
		console.log(`  - ${path.basename(a)} (${(size / 1024 / 1024).toFixed(1)} MB)`)
	}

	console.log("[workflow] Done")
}

interface Build_Args {
	platform: Platform
	cef_version: string
	chromium_version: string
	skip_download: boolean
	skip_build: boolean
	skip_package: boolean
}

async function build_platform(args: Build_Args): Promise<void> {
	let {platform, cef_version, chromium_version, skip_download, skip_build, skip_package} = args
	let cef_platform = platform_to_cef(platform)
	let full_version = `${cef_version}+chromium-${chromium_version}`
	let output_dir = path.join(CEF_DIR, cef_platform)
	let build_dir = path.join(output_dir, "build")

	console.log(`[download] Platform: ${platform} (${cef_platform})`)
	console.log(`[download] Version: ${full_version}`)

	let wrapper_path: string
	if (platform.startsWith("windows")) {
		wrapper_path = path.join(build_dir, "libcef_dll_wrapper", "Release", "libcef_dll_wrapper.lib")
	} else {
		wrapper_path = path.join(build_dir, "libcef_dll_wrapper", "libcef_dll_wrapper.a")
	}

	let version_file = path.join(output_dir, ".version")
	let existing_version = fs.existsSync(version_file) ? fs.readFileSync(version_file, "utf-8") : null
	let needs_download = !fs.existsSync(output_dir) || existing_version !== full_version

	if (skip_download) {
		console.log("[download] Skipping download")
	} else if (!needs_download && fs.existsSync(wrapper_path)) {
		console.log("[download] Already downloaded and built, skipping")
	} else {
		if (existing_version && existing_version !== full_version) {
			console.log(`[download] Version mismatch: ${existing_version} != ${full_version}`)
		}

		let url = `https://cef-builds.spotifycdn.com/cef_binary_${cef_version}+chromium-${chromium_version}_${cef_platform}_minimal.tar.bz2`
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

	if (!skip_build) {
		console.log("[download] Building wrapper library...")

		fs.mkdirSync(build_dir, {recursive: true})

		let gen = platform.startsWith("windows") ? "Visual Studio 17 2022"
			: platform.startsWith("macos") ? "Xcode"
			: "Unix Makefiles"

		await new Promise<void>((resolve, reject) => {
			let proc = Bun.spawn(["cmake", "-G", gen, "-DCMAKE_BUILD_TYPE=Release", "-B", "build", "-S", "."], {cwd: output_dir})
			proc.exited.then(code => code === 0 ? resolve() : reject(new Error(`cmake configure exited ${code}`)))
		})

		await new Promise<void>((resolve, reject) => {
			let jobs = os.cpus().length
			let cfg = platform.startsWith("windows") ? "Release" : ""
			let proc = Bun.spawn(["cmake", "--build", "build", "--target", "libcef_dll_wrapper", "-j", String(jobs), ...(cfg ? ["--config", cfg] : [])], {cwd: output_dir})
			proc.exited.then(code => code === 0 ? resolve() : reject(new Error(`cmake build exited ${code}`)))
		})

		console.log("[download] Build complete")
	}

	if (!skip_package) {
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
}

function print_usage(): void {
	console.log(`Usage: run.ts <command> [options]`)
	console.log(``)
	console.log(`Commands:`)
	console.log(`  latest    Show the latest CEF version`)
	console.log(`  download  Download, build, and package CEF`)
	console.log(`  workflow  Build for all platforms`)
	console.log(``)
	console.log(`Options:`)
	console.log(`  -p, --platform <name>  Target platform (default: current platform)`)
	console.log(`  -v, --version <ver>    CEF version (full or short, e.g., "147.0.2" or`)
	console.log(`                         "147.0.2+g3182a54+chromium-147.0.7727.24")`)
	console.log(`  -f, --force            Force redownload even if already present`)
	console.log(`  --skip-download        Skip download step`)
	console.log(`  --skip-build           Skip building wrapper library`)
	console.log(`  --skip-package         Skip creating package`)
	console.log(`  --beta                 Include beta versions`)
}

async function main(): Promise<void> {

	let args = Bun.argv.slice(2)
	let cmd = args[0]
    args = args.slice(1)

	if (!cmd) {
		print_usage()
		process.exit(1)
	}

	switch (cmd) {
	case "latest":   return cmd_latest(args)
	case "download": return cmd_download(args)
	case "workflow": return cmd_workflow(args)
	default:
		console.error(`Unknown command: ${cmd}`)
		print_usage()
		process.exit(1)
	}
}

try {
	await main()
} catch (e) {
	console.error(`Error: ${e}`)
	process.exit(1)
}
