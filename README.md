# cef-bin

Prebuilt CEF (`libcef_dll_wrapper`) tarballs from official CEF distribution.

## Why

The official CEF builds at https://cef-builds.spotifycdn.com/ are
**binary** distributions: they include the CEF shared library, headers, resources, and helper binaries, but **not** `libcef_dll_wrapper`.\
The wrapper is the C++ glue layer that exposes CEF's C API as a normal C++ class hierarchy.

If you want to embed CEF in another project (a node addon, a custom
executable, a binding for another language), you must download CEF and build the wrapper yourself before you can link anything against it.

This repo automates that step and publishes the result as a versioned tarball on GitHub Releases, so you can just download and link.

## What is in the artifact

Each release attaches six tarballs, one per supported platform:

```
cef-<cef-version>+chromium-<chromium-version>-<platform>.tar.gz
```

Supported platforms:
`linux64`,
`linuxarm64`,
`macosx64`,
`macosarm64`,
`windows64`,
`windowsarm64`.

Inside the tarball:

```
package/
    libcef_dll_wrapper.a     # linux, macos (.lib on windows)
    include/                 # CEF C/C++ headers
    Release/                 # libcef, locales, swiftshader, v8 snapshot, ...
    Resources/               # *.pak, icudtl.dat, ... (omitted on macos)
    LICENSE.txt
    CREDITS.html
    .version
```

## How to use

Download the tarball for your platform from the latest GitHub Release,
extract it, and point your build at the wrapper library and the
`include/` and `Release/` directories.

CMake example:

```cmake
set(CEF_ROOT "${CMAKE_CURRENT_BINARY_DIR}/cef")
# extract the tarball into ${CEF_ROOT} first, then:
add_executable(app main.cc)
target_include_directories(app PRIVATE ${CEF_ROOT}/include)
target_link_directories(app PRIVATE ${CEF_ROOT}/Release)
target_link_libraries(app PRIVATE
    ${CEF_ROOT}/Release/libcef          # or libcef.dll / Chromium Embedded Framework.framework
    ${CEF_ROOT}/libcef_dll_wrapper.a    # or .lib on windows
)
```

## Build details

The wrapper is built with CEF's own CMake configuration, unmodified.

That means:

- **Generator**:
  - Linux: `Unix Makefiles`
  - macOS: `Xcode`
  - Windows: `Visual Studio 18 2026` (the runner image
    `windows-2025-vs2026` ships CMake 4.3.2 with that generator)
- **Configuration**: `Release` (`-DCMAKE_BUILD_TYPE=Release` / `--config Release`)
- **Target**: only `libcef_dll_wrapper` is built — the rest of CEF
  (libcef itself, helper, locales) is shipped prebuilt.
- **Source distribution**: CEF *minimal* tarball from Spotify's CDN
  (no debug symbols, no distribution examples, no cefclient/cefsimple
  sources). This keeps the download at roughly 150 MB instead of 1+ GB.
- **No patches or flags overridden** — whatever compile flags CEF's
  upstream `CMakeLists.txt` picks for a `Release` build.
