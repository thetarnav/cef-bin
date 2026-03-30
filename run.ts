#!/usr/bin/env bun

import * as fs   from "node:fs"
import * as path from "node:path"
import * as os   from "node:os"
import * as util from "node:util"

const INDEX_URL    = "https://cef-builds.spotifycdn.com/index.json"
const VERSION_FILE = path.join(import.meta.dir, ".last_version")
const DIST_DIR     = path.join(import.meta.dir, "dist")
const CEF_DIR      = path.join(import.meta.dir, "cef")

const PLATFORMS = [
    "linux64",
    "linuxarm64",
    "macosx64",
    "macosarm64",
    "windows64",
    "windowsarm64",
] as const

type Platform = typeof PLATFORMS[number]

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

function is_platform(platform: string | Platform): platform is Platform {
    return PLATFORMS.includes(platform as Platform)
}

function to_platform(os: string, arch: string): Platform {
    switch (os) {
    case "linux":  return arch === "arm64" ? "linuxarm64" : "linux64"
    case "darwin": return arch === "arm64" ? "macosarm64" : "macosx64"
    case "win32":  return arch === "arm64" ? "windowsarm64" : "windows64"
    default:       throw new Error(`Unsupported OS: ${os}`)
    }
}

function current_platform(): Platform {
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
    platform: Platform
    beta:     boolean
    force:    boolean
}

function parse_global_args(args: string[]): Global_Args {
    let {values} = util.parseArgs({
        args,
        strict: false,
        options: {
            "platform": {type: "string",  short: "p"},
            "beta":     {type: "boolean", default: false},
            "force":    {type: "boolean", short: "f"},
        },
    })
    return {
        platform: typeof values.platform === "string" && is_platform(values.platform) ? values.platform : current_platform(),
        beta: Boolean(values.beta),
        force: Boolean(values.force),
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

async function build_cef(args: Download_Args, log_prefix: string): Promise<string> {
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
        console.log(`[${log_prefix}] No version specified, fetching latest...`)
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
    let output_dir = path.join(CEF_DIR, args.platform)
    let build_dir = path.join(output_dir, "build")

    console.log(`[${log_prefix}] Platform: ${args.platform} (${args.platform})`)
    console.log(`[${log_prefix}] Channel: ${channel}`)
    console.log(`[${log_prefix}] Version: ${full_version}`)

    let wrapper_lib: string
    let wrapper_path: string
    switch (args.platform) {
    case "linux64":
    case "linuxarm64":
        wrapper_lib = "libcef_dll_wrapper.a"
        wrapper_path = path.join(build_dir, "libcef_dll_wrapper", wrapper_lib)
        break
    case "macosx64":
    case "macosarm64":
        wrapper_lib = "libcef_dll_wrapper.a"
        wrapper_path = path.join(build_dir, "libcef_dll_wrapper", "Release", wrapper_lib)
        break
    case "windows64":
    case "windowsarm64":
        wrapper_lib = "libcef_dll_wrapper.lib"
        wrapper_path = path.join(build_dir, "libcef_dll_wrapper", "Release", wrapper_lib)
        break
    }

    let version_file = path.join(output_dir, ".version")
    let existing_version = fs.existsSync(version_file) ? fs.readFileSync(version_file, "utf-8") : null
    let needs_download = args.force || !fs.existsSync(output_dir) || existing_version !== full_version

    if (args.skip_download) {
        console.log(`[${log_prefix}] Skipping download`)
    } else if (!needs_download && fs.existsSync(wrapper_path)) {
        console.log(`[${log_prefix}] Already downloaded and built, skipping`)
    } else {
        if (existing_version && existing_version !== full_version) {
            console.log(`[${log_prefix}] Version mismatch: ${existing_version} != ${full_version}`)
        }

        let channel_suffix = channel === "stable" ? "" : `_${channel}`
        let url = `https://cef-builds.spotifycdn.com/cef_binary_${cef_version}+chromium-${chromium_version}_${args.platform}${channel_suffix}_minimal.tar.bz2`
        console.log(`[${log_prefix}] Downloading from: ${url}`)

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

            console.log(`[${log_prefix}] Extracting...`)
            let proc = await Bun.$`tar -xjf ${archive} --strip-components=1 -C ${output_dir}`
            if (proc.exitCode !== 0) {
                throw new Error(`tar exited ${proc.exitCode}`)
            }

            fs.writeFileSync(version_file, full_version)
        } finally {
            fs.rmSync(tmp_dir, {force: true, recursive: true})
        }
    }

    if (!args.skip_build) {
        console.log(`[${log_prefix}] Building wrapper library...`)

        fs.mkdirSync(build_dir, {recursive: true})

        let gen: string
        switch (args.platform) {
        case "linux64":
        case "linuxarm64":
            gen = "Unix Makefiles"
            break
        case "macosx64":
        case "macosarm64":
            gen = "Xcode"
            break
        case "windows64":
        case "windowsarm64":
            gen = "Visual Studio 17 2022"
            break
        }
        console.log(`[${log_prefix}] Using CMake generator: ${gen}`)

        console.log(`[${log_prefix}] Running CMake configure...`)
        await Bun.$`cmake -G ${gen} -DCMAKE_BUILD_TYPE=Release -B build -S .`.cwd(output_dir)

        console.log(`[${log_prefix}] Running CMake build for libcef_dll_wrapper...`)
        await Bun.$`cmake --build build --target libcef_dll_wrapper -j ${os.cpus().length} --config Release`.cwd(output_dir)

        console.log(`[${log_prefix}] Build complete`)
    }

    if (!args.skip_package) {
        console.log(`[${log_prefix}] Creating package...`)

        let dist_name = `cef-${full_version}-${args.platform}`
        let pkg_dir = path.join(DIST_DIR, dist_name, "package")
        fs.mkdirSync(pkg_dir, {recursive: true})

        if (!fs.existsSync(wrapper_path)) throw new Error(`Wrapper not found: ${wrapper_path}`)
        fs.cpSync(wrapper_path, path.join(pkg_dir, wrapper_lib))
        fs.cpSync(path.join(output_dir, "include"), path.join(pkg_dir, "include"), {recursive: true})

        if (!args.platform.startsWith("macos")) {
            fs.cpSync(path.join(output_dir, "Resources"), path.join(pkg_dir, "Resources"), {recursive: true})
        }
        fs.cpSync(path.join(output_dir, "Release"), path.join(pkg_dir, "Release"), {recursive: true})

        for (let f of ["LICENSE.txt", "CREDITS.html", ".version"]) {
            let src = path.join(output_dir, f)
            if (fs.existsSync(src)) fs.cpSync(src, path.join(pkg_dir, f))
        }

        let archive_path = path.join(DIST_DIR, dist_name, `${dist_name}.tar.gz`)
        let tar_result = await Bun.$`tar -czf ${archive_path} -C ${pkg_dir} .`
        if (tar_result.exitCode !== 0) {
            throw new Error(`tar exited ${tar_result.exitCode}`)
        }

        let size = fs.statSync(archive_path).size
        console.log(`[${log_prefix}] Package: ${archive_path} (${(size / 1024 / 1024).toFixed(1)} MB)`)
    }

    return full_version
}

async function cmd_download(cmd_args: string[]): Promise<void> {
    let args = parse_download_args(cmd_args)
    await build_cef(args, "download")
}

async function cmd_check(cmd_args: string[]): Promise<void> {
    let args = parse_global_args(cmd_args)
    let build_info = await get_latest_version(args)
    if (!build_info) {
        console.error("No build found")
        process.exit(1)
    }

    let last_version = read_last_version()
    let should_continue = args.force || last_version !== build_info.version

    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `VERSION=${build_info.version}\n`)
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `LAST_VERSION=${last_version ?? ""}\n`)
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `SHOULD_CONTINUE=${should_continue}\n`)
    }

    console.log(`VERSION=${build_info.version}`)
    console.log(`LAST_VERSION=${last_version ?? ""}`)
    console.log(`SHOULD_CONTINUE=${should_continue}`)

    if (!should_continue) {
        console.log("Version unchanged, skipping")
        process.exit(0)
    }
}

async function cmd_workflow(cmd_args: string[]): Promise<void> {
    let args = parse_download_args(cmd_args)
    let args_with_version: Download_Args

    if (args.version) {
        args_with_version = args
    } else {
        let build_info = await get_latest_version(args)
        if (!build_info) {
            throw new Error("No CEF build found")
        }

        let parsed = parse_version(build_info.version)
        let cef_version = parsed?.cef ?? build_info.version
        let chromium_version = parsed?.chromium ?? ""
        let full_version = `${cef_version}+chromium-${chromium_version}`

        console.log(`[workflow] Latest: ${build_info.version}`)

        let last_version = read_last_version()
        console.log(`[workflow] Last built: ${last_version ?? "(none)"}`)

        if (!args.force && last_version === build_info.version) {
            console.log("[workflow] Version unchanged, skipping")
            return
        }

        args_with_version = {...args, version: full_version}
    }

    let full_version = await build_cef(args_with_version, "workflow")
    write_last_version(args_with_version.version!)
    console.log(`[workflow] Updated version to ${full_version}`)
}

function print_usage(): void {
    console.log(`Usage: run.ts <command> [options]`)
    console.log(``)
    console.log(`Commands:`)
    console.log(`  latest    Show the latest CEF version`)
    console.log(`  check     Check if version changed (for CI)`)
    console.log(`  download  Download, build, and package CEF`)
    console.log(`  workflow  Like download, but tracks version in .last_version`)
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
    case "check":    return cmd_check(args)
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
