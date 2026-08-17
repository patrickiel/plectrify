cmake_minimum_required(VERSION 3.22)

# macOS target settings — cache defaults set before project() so the first
# configure picks them up. Apple Silicon only; the 13.3 floor is set by the UI
# (relative colour syntax needs the WebKit shipped with Safari 16.4, and
# WKWebView tracks the OS WebKit). Inert on other platforms.
if (APPLE)
    set(CMAKE_OSX_DEPLOYMENT_TARGET "13.3" CACHE STRING "Minimum macOS version")
    set(CMAKE_OSX_ARCHITECTURES "arm64" CACHE STRING "Target architectures")
endif()

file(STRINGS "${CMAKE_CURRENT_LIST_DIR}/VERSION" PLECTRIFY_VERSION LIMIT_COUNT 1)
if (NOT PLECTRIFY_VERSION MATCHES "^[0-9]+\\.[0-9]+\\.[0-9]+$")
    message(FATAL_ERROR "VERSION must contain a numeric semantic version (MAJOR.MINOR.PATCH)")
endif()

project(Plectrify VERSION ${PLECTRIFY_VERSION} LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ---------------------------------------------------------------------------
# JUCE — pulled via FetchContent and pinned to an immutable release commit for reproducible,
# CI-friendly builds. First configure downloads JUCE (a few minutes).
# ---------------------------------------------------------------------------
# The WebView2 SDK is Windows-only: macOS uses the OS-provided WKWebView, which
# needs no SDK package and no runtime installer.
if (WIN32)
    # Where JUCE's FindWebView2 looks for the Microsoft.Web.WebView2 NuGet package
    # (fetched into third_party/). A plain (non-cache) variable so it reliably
    # overrides any stale/mis-typed cache entry. Enables the embedded Svelte UI.
    set(JUCE_WEBVIEW2_PACKAGE_LOCATION "${CMAKE_CURRENT_SOURCE_DIR}/third_party")

    # third_party/ is gitignored, so fetch and unpack the WebView2 package on first
    # configure — a fresh clone must build without manual bootstrap. A .nupkg is a
    # plain zip already in the build/native/... layout JUCE's FindWebView2 expects.
    # (The ASIO SDK stays manual: it is licence-gated and must not be automated.)
    set(PLECTRIFY_WEBVIEW2_VERSION "1.0.3485.44")
    set(_webview2_dir "${CMAKE_CURRENT_SOURCE_DIR}/third_party/Microsoft.Web.WebView2.${PLECTRIFY_WEBVIEW2_VERSION}")
    if (NOT EXISTS "${_webview2_dir}/build/native/include/WebView2.h")
        set(_webview2_nupkg "${CMAKE_CURRENT_BINARY_DIR}/Microsoft.Web.WebView2.${PLECTRIFY_WEBVIEW2_VERSION}.nupkg")
        message(STATUS "Plectrify: fetching Microsoft.Web.WebView2 ${PLECTRIFY_WEBVIEW2_VERSION} NuGet package")
        file(DOWNLOAD
            "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/${PLECTRIFY_WEBVIEW2_VERSION}"
            "${_webview2_nupkg}"
            EXPECTED_HASH SHA256=bc09150b179246ac90189649b13be8e6b11b3ac200e817e18df106e1f3cf489e
            STATUS _webview2_download_status)
        list(GET _webview2_download_status 0 _webview2_download_code)
        if (NOT _webview2_download_code EQUAL 0)
            message(FATAL_ERROR "Plectrify: WebView2 package download failed (${_webview2_download_status}). "
                                "Fetch it manually into third_party/ — see AGENTS.md 'Optional dependencies'.")
        endif()
        file(ARCHIVE_EXTRACT INPUT "${_webview2_nupkg}" DESTINATION "${_webview2_dir}")
        file(REMOVE "${_webview2_nupkg}")
    endif()
endif()

include(FetchContent)
find_package(Git REQUIRED)

FetchContent_Declare(
    JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG        2cdfca8feb300fb424002ba2c2751569e5bacb64 # JUCE 8.0.14
    GIT_SHALLOW    TRUE
    # The dependency is pinned. Once populated, avoid a Git update + patch
    # cycle on every configure; clean build trees still clone and patch once.
    UPDATE_DISCONNECTED TRUE
    # Small guarded host-side fixes JUCE 8.0.14 needs, applied at fetch
    # time. Each platform-specific patch is applied on both OSes anyway,
    # because the patched tree is what the release scripts publish as
    # corresponding source: one tree, one answer to "what was this built from".
    #   - webview2-zoom: 8.0.14 does not expose WebView2's zoom settings
    #     through its Options API (Windows).
    #   - vst3-no-mac-content-scale: JUCE reports a content scale factor to
    #     hosted VST3s on macOS, where the interface does not apply, which
    #     halves the UI of any plugin that believes it (macOS).
    #   - vst3-scale-before-attach: JUCE reports the real scale a message loop
    #     after attaching the view, so a plugin that reads it once - while
    #     building its UI - draws the whole editor at 1:1 (Windows, Linux).
    #   - no-double-escape-url: the mac web-view backend re-escapes URLs that
    #     already carry percent-escapes (macOS).
    #   - graph-host-owned-bypass: a bypass the host requested is enforced by
    #     the graph instead of being delegated to the plugin's own exported
    #     bypass parameter, which some plugins export but ignore (both OSes).
    PATCH_COMMAND  "${CMAKE_COMMAND}"
                   "-DGIT_EXECUTABLE=${GIT_EXECUTABLE}"
                   "-DPATCH_FILE=${CMAKE_CURRENT_SOURCE_DIR}/cmake/juce-disable-webview2-zoom.patch"
                   "-DSOURCE_DIR=<SOURCE_DIR>"
                   -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/ApplyPatch.cmake"
           COMMAND "${CMAKE_COMMAND}"
                   "-DGIT_EXECUTABLE=${GIT_EXECUTABLE}"
                   "-DPATCH_FILE=${CMAKE_CURRENT_SOURCE_DIR}/cmake/juce-vst3-no-mac-content-scale.patch"
                   "-DSOURCE_DIR=<SOURCE_DIR>"
                   -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/ApplyPatch.cmake"
           COMMAND "${CMAKE_COMMAND}"
                   "-DGIT_EXECUTABLE=${GIT_EXECUTABLE}"
                   "-DPATCH_FILE=${CMAKE_CURRENT_SOURCE_DIR}/cmake/juce-vst3-scale-before-attach.patch"
                   "-DSOURCE_DIR=<SOURCE_DIR>"
                   -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/ApplyPatch.cmake"
           COMMAND "${CMAKE_COMMAND}"
                   "-DGIT_EXECUTABLE=${GIT_EXECUTABLE}"
                   "-DPATCH_FILE=${CMAKE_CURRENT_SOURCE_DIR}/cmake/juce-no-double-escape-url.patch"
                   "-DSOURCE_DIR=<SOURCE_DIR>"
                   -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/ApplyPatch.cmake"
           COMMAND "${CMAKE_COMMAND}"
                   "-DGIT_EXECUTABLE=${GIT_EXECUTABLE}"
                   "-DPATCH_FILE=${CMAKE_CURRENT_SOURCE_DIR}/cmake/juce-graph-host-owned-bypass.patch"
                   "-DSOURCE_DIR=<SOURCE_DIR>"
                   -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/ApplyPatch.cmake"
)
FetchContent_MakeAvailable(JUCE)

# ---------------------------------------------------------------------------
# The standalone guitar-rig host application.
# ---------------------------------------------------------------------------
# Per-platform arguments for juce_add_gui_app. Windows links the WebView2
# loader; macOS declares its bundle identity, the microphone-permission plist
# entry (without which macOS silently denies audio input — a guitar rig's whole
# point), and the hardened runtime notarization requires. The
# disable-library-validation entitlement is what lets a hardened-runtime
# process load third-party VST3 code not signed by our team.
if (WIN32)
    set(PLECTRIFY_PLATFORM_APP_ARGS NEEDS_WEBVIEW2 TRUE)
elseif (APPLE)
    set(PLECTRIFY_PLATFORM_APP_ARGS
        BUNDLE_ID io.github.patrickiel.plectrify
        MICROPHONE_PERMISSION_ENABLED TRUE
        MICROPHONE_PERMISSION_TEXT "Plectrify processes your guitar signal live, so it needs access to your audio interface's input."
        HARDENED_RUNTIME_ENABLED TRUE
        HARDENED_RUNTIME_OPTIONS com.apple.security.device.audio-input com.apple.security.cs.disable-library-validation)
else()
    set(PLECTRIFY_PLATFORM_APP_ARGS "")
endif()

juce_add_gui_app(Plectrify
    PRODUCT_NAME "Plectrify"
    COMPANY_NAME "Plectrify"
    VERSION      "${PROJECT_VERSION}"
    ICON_BIG     "${CMAKE_CURRENT_SOURCE_DIR}/Assets/PlectrifyIcon.png"
    ICON_SMALL   "${CMAKE_CURRENT_SOURCE_DIR}/Assets/PlectrifyIconSmall.png"
    ${PLECTRIFY_PLATFORM_APP_ARGS})

# Replace the .icns JUCE derives from ICON_BIG/ICON_SMALL with a full macOS
# icon ladder built from the same artwork — every representation the OS asks
# for, sized onto Apple's icon grid. See cmake/MakeMacAppIcon.cmake for why the
# generated one is not good enough. This overwrites JUCE's copy inside the
# bundle after the target's own resources land, and before either the run or
# the release script codesigns, so the icon is inside the seal like any other
# bundle resource.
if (APPLE)
    set(PLECTRIFY_MAC_ICON_DIR "${CMAKE_CURRENT_BINARY_DIR}/PlectrifyAppIcon")
    set(PLECTRIFY_MAC_ICNS "${PLECTRIFY_MAC_ICON_DIR}/AppIcon.icns")

    add_custom_command(
        OUTPUT  "${PLECTRIFY_MAC_ICNS}"
        COMMAND "${CMAKE_COMMAND}"
                "-DSOURCE_PNG=${CMAKE_CURRENT_SOURCE_DIR}/Assets/PlectrifyIcon.png"
                "-DOUTPUT_ICNS=${PLECTRIFY_MAC_ICNS}"
                "-DWORK_DIR=${PLECTRIFY_MAC_ICON_DIR}"
                -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/MakeMacAppIcon.cmake"
        DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/Assets/PlectrifyIcon.png"
                "${CMAKE_CURRENT_SOURCE_DIR}/cmake/MakeMacAppIcon.cmake"
        COMMENT "Plectrify: building the macOS icon ladder"
        VERBATIM)

    add_custom_target(PlectrifyMacAppIcon DEPENDS "${PLECTRIFY_MAC_ICNS}")
    add_dependencies(Plectrify PlectrifyMacAppIcon)

    add_custom_command(TARGET Plectrify POST_BUILD
        COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${PLECTRIFY_MAC_ICNS}"
                "$<TARGET_BUNDLE_CONTENT_DIR:Plectrify>/Resources/AppIcon.icns"
        VERBATIM)
endif()

# Embed the same artwork used by the executable resource so JUCE can also
# render it in the app's custom, non-native title bar — plus the wordmark face
# that bar sets the title in (the same Chakra Petch 600 the website's logo
# uses, as a TTF because JUCE cannot read the site's woff2).
juce_add_binary_data(PlectrifyAssets
    HEADER_NAME "PlectrifyAssets.h"
    NAMESPACE   "PlectrifyAssets"
    SOURCES
        Assets/ChakraPetch-SemiBold.ttf
        Assets/PlectrifyIcon.png
        Assets/PlectrifyIconSmall.png)

# Sources shared by every target that embeds the engine — the standalone app
# and the VST3 plugin. The standalone shell (Main.cpp, MainComponent.cpp,
# WindowLookAndFeel.cpp) and the plugin's processor/editor stay per-target;
# everything else is the one engine both of them run.
set(PLECTRIFY_ENGINE_SOURCES
    Source/app/BuildInfo.cpp
    Source/app/EngineWebView.cpp
    Source/app/LooperSessionStore.cpp
    Source/app/MidiInputManager.cpp
    Source/app/PlectrifyEngine.cpp
    Source/audio/LooperProcessor.cpp
    Source/audio/MetronomeProcessor.cpp
    Source/audio/RackProcessor.cpp
    Source/audio/TunerDetector.cpp
    Source/plugins/PluginManager.cpp
    Source/plugins/Catalogue.cpp
    Source/plugins/CatalogueInstaller.cpp
    Source/rackui/PluginEditorWindow.cpp
    Source/tone3000/NamStateCodec.cpp
    Source/tone3000/Tone3000Auth.cpp
    Source/tone3000/Tone3000BrowserWindow.cpp
    Source/tone3000/Tone3000Client.cpp
    Source/tone3000/Tone3000Library.cpp
    Source/tone3000/Tone3000SelectUrl.cpp
    Source/tone3000/Tone3000Service.cpp
    Source/tone3000/Tone3000WindowState.cpp)

target_sources(Plectrify PRIVATE
    ${PLECTRIFY_ENGINE_SOURCES}
    Source/app/Main.cpp
    Source/app/MainComponent.cpp
    Source/app/WindowLookAndFeel.cpp)

# ---------------------------------------------------------------------------
# Build provenance for the About dialog's diagnostics: commit, dirty flag and
# build time, regenerated on every build so the report never claims a commit the
# exe was not built from. Only BuildInfo.cpp includes the generated header, so a
# new commit costs one small recompile plus the relink.
# ---------------------------------------------------------------------------
# Base URL of the published plugin catalogue (see
# `pnpm --dir packaging setup-r2`, which creates the bucket and prints this).
# A cache variable so pointing a build at a custom domain — or a fork at its own
# bucket — needs no source edit. Note this only says *where* the catalogue is:
# what makes it trustworthy is the signature checked against the key compiled
# into Catalogue.cpp, so a wrong URL here cannot become a security
# problem, only a broken download.
#
# A custom domain on the bucket rather than its `pub-<hash>.r2.dev` dev URL,
# because this string is compiled in and therefore permanent for every build
# that carries it: the dev URL is rate limited, and it names the *bucket*, so
# recreating or moving that bucket would strand every installer ever shipped.
# The dev URL stays enabled and keeps serving the builds up to v0.1.0 that have
# it baked in — see R2_PUBLIC_BASE in packaging/scripts/pack.ts, which is the
# same address for the tooling half and must be kept in step with this.
set(PLECTRIFY_CATALOGUE_URL
    "https://cdn.plectrify.com/plugins/v1"
    CACHE STRING "Base URL of the published plugin catalogue")

# ---------------------------------------------------------------------------
# TONE3000. The client id is the *publishable* half of an API key and is meant
# to be embedded in a client application, so it lives here rather than in a
# secret: it identifies the OAuth client, it authorises nothing on its own, and
# PKCE is what proves a code may be redeemed. The `t3k_cs_` secret key is a
# server-only credential — Plectrify has no server, needs none, and must never
# carry one.
#
# Deliberately not in catalogue.json: that file is a signed trust root about
# *binaries*, an OAuth client id is app identity, and a build that cannot reach
# R2 must still be able to sign in.
#
# The redirect URI only has to be *accepted* by TONE3000 and registered against
# the key — the app intercepts the navigation before it loads, so it never has
# to resolve. Localhost is allowed for development, which is why the two
# configurations differ; the release URI is a real prerendered page in site/ so
# the fallback path (see Tone3000BrowserWindow) has somewhere to land.
set(PLECTRIFY_TONE3000_CLIENT_ID
    "t3k_pub_2v0r7-_nE2VNyk8knetlfMqnIwTdEZR3"
    CACHE STRING "TONE3000 publishable OAuth client id")
set(PLECTRIFY_TONE3000_API
    "https://www.tone3000.com"
    CACHE STRING "TONE3000 API base URL")
set(PLECTRIFY_TONE3000_REDIRECT_URI
    "https://plectrify.com/oauth/tone3000"
    CACHE STRING "TONE3000 redirect URI registered against the client id (release)")
set(PLECTRIFY_TONE3000_REDIRECT_URI_DEBUG
    "http://localhost:5173/oauth/tone3000"
    CACHE STRING "TONE3000 redirect URI used by Debug builds")

set(PLECTRIFY_BUILD_INFO_DIR "${CMAKE_CURRENT_BINARY_DIR}/generated")
add_custom_target(PlectrifyBuildInfo
    BYPRODUCTS "${PLECTRIFY_BUILD_INFO_DIR}/PlectrifyBuildInfo.h"
    COMMAND ${CMAKE_COMMAND}
            "-DSOURCE_DIR=${CMAKE_CURRENT_SOURCE_DIR}"
            "-DTEMPLATE_FILE=${CMAKE_CURRENT_SOURCE_DIR}/cmake/PlectrifyBuildInfo.h.in"
            "-DOUTPUT_FILE=${PLECTRIFY_BUILD_INFO_DIR}/PlectrifyBuildInfo.h"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/WriteBuildInfo.cmake"
    COMMENT "Plectrify: stamping build provenance"
    VERBATIM)
# The header must exist before the first build, or the initial compile of
# BuildInfo.cpp races the custom target. (Each engine target's dependency on
# PlectrifyBuildInfo is added by plectrify_configure_target below.)
execute_process(COMMAND ${CMAKE_COMMAND}
    "-DSOURCE_DIR=${CMAKE_CURRENT_SOURCE_DIR}"
    "-DTEMPLATE_FILE=${CMAKE_CURRENT_SOURCE_DIR}/cmake/PlectrifyBuildInfo.h.in"
    "-DOUTPUT_FILE=${PLECTRIFY_BUILD_INFO_DIR}/PlectrifyBuildInfo.h"
    -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/WriteBuildInfo.cmake")

# ---------------------------------------------------------------------------
# One configuration for every engine-carrying target — the standalone app and
# the VST3 plugin. Both compile PLECTRIFY_ENGINE_SOURCES, so their include
# paths, compile definitions and link libraries must be identical: a
# definition present on one and not the other is an ODR hazard in the shared
# objects. Per-target facts stay outside this function — JUCE_ASIO (app-only;
# a DAW owns the driver), the shell/plugin sources, and the plugin's format
# arguments.
# ---------------------------------------------------------------------------
function(plectrify_configure_target target)
    juce_generate_juce_header(${target})
    add_dependencies(${target} PlectrifyBuildInfo)

    # Keep Visual Studio's F5 debugger on the native host. With Debugger Type
    # set to Auto, VS may attach its JavaScript debugger to msedgewebview2.exe
    # and stop the entire app on WebView2's internal debug breaks. The custom
    # property sheet imports the developer's normal platform user props before
    # applying this one project-specific setting.
    if (MSVC)
        set_target_properties(${target} PROPERTIES
            VS_USER_PROPS "${CMAKE_CURRENT_SOURCE_DIR}/cmake/Plectrify.user.props")
    endif()

    # Vertical slices — each feature folder is on the include path so
    # cross-slice #include "Header.h" keeps working without long relative
    # paths.
    target_include_directories(${target} PRIVATE
        Source/app
        Source/audio
        Source/plugins
        Source/rackui
        Source/tone3000
        "${PLECTRIFY_BUILD_INFO_DIR}")

    # Windows-only build switches. None of these may leak onto other
    # platforms: the WebView2/WinRT symbols are meaningless outside Windows
    # (macOS renders the UI in the OS-provided WKWebView and talks CoreAudio
    # and CoreMIDI natively). JUCE_ASIO deliberately is NOT here — it belongs
    # to the standalone alone, since a hosted plugin never opens a driver and
    # its About diagnostics must not claim ASIO support it cannot use.
    if (WIN32)
        target_compile_definitions(${target} PRIVATE
            JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1  # NEEDS_WEBVIEW2 links the static loader
            PLECTRIFY_DISABLE_WEBVIEW2_ZOOM=1  # rack zoom is UI-owned; disable WebView2 page/pinch zoom
            # MIDI runs on the legacy Win32 (winmm) backend only. JUCE 8.0.14's
            # WinRT/UMP backends corrupt the heap on current Windows 11 builds
            # (the OS-side Windows MIDI Services rework), so with WINRT off and
            # JUCE_USE_WINDOWS_MIDI_SERVICES left at its default of 0 that code
            # is never compiled and the backend factory falls through to winmm.
            # Devices are opened only by MidiInputManager (the standalone
            # shell); AudioDeviceManager's MIDI machinery is still bypassed —
            # see audioSetupFromXml.
            JUCE_USE_WINRT_MIDI=0)
    endif()

    target_compile_definitions(${target} PRIVATE
        JUCE_PLUGINHOST_VST3=1          # host VST3 plugins
        JUCE_PLUGINHOST_VST=0           # legacy VST2 needs the Steinberg SDK/licence
        JUCE_PLUGINHOST_LADSPA=0
        JUCE_WEB_BROWSER=1              # host the embedded Svelte UI
        JUCE_USE_CURL=0
        # Debug-only source-tree fallback for serving ui/dist. Release binaries
        # must not bake a dev-machine path; they serve only the staged ui/
        # directory — next to the executable on Windows (scripts/run.windows.ts
        # stages it there), inside the bundle at Contents/Resources/ui on macOS
        # (scripts/run.macos.ts stages it). The same fallback is what lets a
        # Debug plugin build run with no staging at all.
        $<$<CONFIG:Debug>:PLECTRIFY_UI_DIST_DIR="${CMAKE_CURRENT_SOURCE_DIR}/ui/dist">
        # Debug-only: read the plugin catalogue straight from the source
        # tree, so editing the JSON and restarting is the whole dev loop — no
        # upload, no cache to clear, no network.
        #
        # This path is UNSIGNED. Release builds must reach a parsed catalogue only
        # through signature verification, so the bypass is a compile-time symbol
        # that does not exist outside Debug — never a runtime flag, setting or env
        # var, any of which would let a downgrade attack switch verification off.
        $<$<CONFIG:Debug>:PLECTRIFY_CATALOGUE_FILE="${CMAKE_CURRENT_SOURCE_DIR}/packaging/catalogue.json">
        # Debug-only: where the shipped plugins would be. A release stages them
        # beside the executable (inside the bundle on macOS); a Debug build has no
        # such layout, so it looks here instead — drop NeuralAmpModeler.vst3 into
        # third_party/plugins/ to exercise what a shipped install actually has.
        # Gitignored like the rest of third_party/, and simply absent otherwise, in
        # which case the dev loop finds whatever is installed on the machine.
        $<$<CONFIG:Debug>:PLECTRIFY_BUNDLED_PLUGIN_DIR="${CMAKE_CURRENT_SOURCE_DIR}/third_party/plugins">
        PLECTRIFY_CATALOGUE_URL="${PLECTRIFY_CATALOGUE_URL}"
        # TONE3000. The redirect URI differs per configuration because localhost is
        # always accepted for development, which keeps the dev loop independent of
        # whatever is deployed to plectrify.com. Both must be listed under the key's
        # allowed redirect URIs, or OAuth refuses them.
        PLECTRIFY_TONE3000_CLIENT_ID="${PLECTRIFY_TONE3000_CLIENT_ID}"
        PLECTRIFY_TONE3000_API="${PLECTRIFY_TONE3000_API}"
        $<$<CONFIG:Debug>:PLECTRIFY_TONE3000_REDIRECT_URI="${PLECTRIFY_TONE3000_REDIRECT_URI_DEBUG}">
        $<$<NOT:$<CONFIG:Debug>>:PLECTRIFY_TONE3000_REDIRECT_URI="${PLECTRIFY_TONE3000_REDIRECT_URI}">
        JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:${target},JUCE_PRODUCT_NAME>"
        JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:${target},JUCE_VERSION>")

    target_link_libraries(${target} PRIVATE
        juce::juce_audio_utils          # AudioDeviceSelectorComponent, AudioProcessorPlayer
        juce::juce_audio_processors      # plugin hosting + AudioProcessorGraph
        juce::juce_audio_devices
        juce::juce_gui_extra
        juce::juce_cryptography          # SHA256 for asset pins, RSAKey for manifest signatures
        PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags)

    if (WIN32)
        # GetProcessMemoryInfo for the status-bar RAM readout.
        target_link_libraries(${target} PRIVATE psapi)

        # Release builds emit a PDB. Without one, a field crash is an Event Log
        # entry with a raw offset and nothing to map it to — access violations in
        # installed builds were undiagnosable. /Zi + /DEBUG cost nothing at
        # runtime and do not reduce optimisation; /OPT:REF,ICF restores the
        # dead-stripping that /DEBUG would otherwise turn off. The release script
        # archives the PDB beside the installer (never inside it) so any dump or
        # fault offset from that build stays symbolisable.
        target_compile_options(${target} PRIVATE $<$<CONFIG:Release>:/Zi>)
        target_link_options(${target} PRIVATE $<$<CONFIG:Release>:/DEBUG /OPT:REF /OPT:ICF>)
    endif()
endfunction()

plectrify_configure_target(Plectrify)

# ASIO — low-latency Windows audio, the driver a live guitar rig wants. The
# standalone alone: a hosted plugin never opens a driver, and its About
# diagnostics must not claim ASIO support. JUCE bundles the Steinberg ASIO 2.3
# headers under juce_audio_devices/native/asio, so no external SDK download is
# needed: JUCE_ASIO_USE_EXTERNAL_SDK stays at its default of 0 and the bundled
# header is used. The resulting binary is subject to Steinberg's ASIO SDK
# licence terms.
if (WIN32)
    target_compile_definitions(Plectrify PRIVATE JUCE_ASIO=1)
endif()

# The window-chrome assets (title-bar wordmark font, icons) are the shell's
# alone — the plugin has no JUCE-drawn chrome.
target_link_libraries(Plectrify PRIVATE PlectrifyAssets)

# ---------------------------------------------------------------------------
# The VST3 plugin: the same engine hosted inside a DAW. Shares
# PLECTRIFY_ENGINE_SOURCES and the whole configuration function with the app;
# only the thin processor/editor pair in Source/plugin/ is its own. The same
# per-user data root means rigs, patches, installed packages and the TONE3000
# account are shared with the standalone by construction.
# ---------------------------------------------------------------------------
if (WIN32)
    set(PLECTRIFY_PLATFORM_PLUGIN_ARGS NEEDS_WEBVIEW2 TRUE)
elseif (APPLE)
    # Hardened runtime + disable-library-validation mirror the app: the
    # signing itself is release plumbing, but the arguments must be here so a
    # signed build keeps the ability to load third-party VST3 code. (Note the
    # DAW process's own entitlements are what actually govern library loading
    # at runtime — every mainstream host disables validation.)
    set(PLECTRIFY_PLATFORM_PLUGIN_ARGS
        BUNDLE_ID io.github.patrickiel.plectrify.plugin
        HARDENED_RUNTIME_ENABLED TRUE
        HARDENED_RUNTIME_OPTIONS com.apple.security.device.audio-input com.apple.security.cs.disable-library-validation)
else()
    set(PLECTRIFY_PLATFORM_PLUGIN_ARGS "")
endif()

juce_add_plugin(PlectrifyPlugin
    PRODUCT_NAME "Plectrify"
    COMPANY_NAME "Plectrify"
    VERSION      "${PROJECT_VERSION}"
    FORMATS VST3
    PLUGIN_MANUFACTURER_CODE Plct
    PLUGIN_CODE Pfy1
    VST3_CATEGORIES Fx
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT TRUE              # rig/scene switching, MIDI learn — from the host track
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    COPY_PLUGIN_AFTER_BUILD FALSE      # the dev loop / release scripts place the bundle
    # juce_vst3_helper generates moduleinfo.json by LOADING the built plugin at
    # build time — which would spin up WebView2 statics and the engine inside
    # the build. Opt out; the plugin loads fine without the fast-scan manifest.
    VST3_AUTO_MANIFEST FALSE
    ${PLECTRIFY_PLATFORM_PLUGIN_ARGS})

target_sources(PlectrifyPlugin PRIVATE
    ${PLECTRIFY_ENGINE_SOURCES}
    Source/plugin/PluginProcessor.cpp
    Source/plugin/PluginEditor.cpp)

# There has never been a VST2 Plectrify, so the VST3 keeps its own parameter-ID
# scheme instead of emulating a VST2 predecessor's — the alternative trips the
# plugin client's parameter-automation-conflict guard.
target_compile_definitions(PlectrifyPlugin PRIVATE JUCE_VST3_CAN_REPLACE_VST2=0)

plectrify_configure_target(PlectrifyPlugin)

# The Release PDB flags again, on the format target this time. juce_add_plugin
# splits the plugin in two: PlectrifyPlugin is a shared-code static library
# (where the function's /Zi lands, correctly — that is where the sources
# compile), but the DLL is linked by PlectrifyPlugin_VST3, and link options on
# a static library reach no linker. Without this the Release .vst3 has no PDB
# and a DAW-side field crash is an unmappable offset; the release script gates
# on exactly that.
if (WIN32)
    target_link_options(PlectrifyPlugin_VST3 PRIVATE $<$<CONFIG:Release>:/DEBUG /OPT:REF /OPT:ICF>)
endif()

# Focused synthetic-signal coverage for the tuner DSP. This remains a separate
# target so normal application builds do not pull test code into the host.
include(CTest)
if (BUILD_TESTING)
    juce_add_console_app(PlectrifyTests PRODUCT_NAME "Plectrify Tests")
    juce_generate_juce_header(PlectrifyTests)
    target_sources(PlectrifyTests PRIVATE
        Source/audio/TunerDetector.cpp
        Tests/audio/TunerDetectorTests.cpp)
    target_include_directories(PlectrifyTests PRIVATE Source/audio)
    target_compile_definitions(PlectrifyTests PRIVATE JUCE_USE_CURL=0)
    target_link_libraries(PlectrifyTests PRIVATE
        juce::juce_audio_basics
        PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)
    add_test(NAME Plectrify.TunerDetector COMMAND PlectrifyTests)

    # Headless topology tests for the rack graph (slot order, connection
    # rebuilding, split-position arithmetic). Separate target so the tuner
    # tests keep their minimal link footprint.
    juce_add_console_app(PlectrifyRackTests PRODUCT_NAME "Plectrify Rack Tests")
    juce_generate_juce_header(PlectrifyRackTests)
    target_sources(PlectrifyRackTests PRIVATE
        Source/audio/LooperProcessor.cpp
        Source/audio/MetronomeProcessor.cpp
        Source/audio/RackProcessor.cpp
        Source/audio/TunerDetector.cpp
        Tests/audio/RackProcessorTests.cpp)
    target_include_directories(PlectrifyRackTests PRIVATE Source/audio)
    target_compile_definitions(PlectrifyRackTests PRIVATE
        JUCE_USE_CURL=0
        JUCE_WEB_BROWSER=0          # keep the console target free of WebView2
        JUCE_PLUGINHOST_VST3=0)     # dummy in-memory plugins only
    target_link_libraries(PlectrifyRackTests PRIVATE
        juce::juce_audio_processors
        PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)
    add_test(NAME Plectrify.RackProcessor COMMAND PlectrifyRackTests)

    # The looper's state machine and audio path: toggle cycle, record/playback
    # fidelity, overdub summing and the amortized undo snapshot — all against
    # the bare processor, no graph involved.
    juce_add_console_app(PlectrifyLooperTests PRODUCT_NAME "Plectrify Looper Tests")
    juce_generate_juce_header(PlectrifyLooperTests)
    target_sources(PlectrifyLooperTests PRIVATE
        Source/audio/LooperProcessor.cpp
        Tests/audio/LooperProcessorTests.cpp)
    target_include_directories(PlectrifyLooperTests PRIVATE Source/audio)
    target_compile_definitions(PlectrifyLooperTests PRIVATE
        JUCE_USE_CURL=0
        JUCE_WEB_BROWSER=0
        JUCE_PLUGINHOST_VST3=0)
    target_link_libraries(PlectrifyLooperTests PRIVATE
        juce::juce_audio_processors
        PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)
    add_test(NAME Plectrify.LooperProcessor COMMAND PlectrifyLooperTests)

    # The plugin catalogue's trust boundary: manifest validation,
    # signature verification, which archive entries may be unpacked and where
    # they may land. All pure functions, so this runs offline.
    juce_add_console_app(PlectrifyCatalogueTests PRODUCT_NAME "Plectrify Catalogue Tests")
    juce_generate_juce_header(PlectrifyCatalogueTests)
    target_sources(PlectrifyCatalogueTests PRIVATE
        Source/plugins/Catalogue.cpp
        Tests/plugins/CatalogueTests.cpp)
    target_include_directories(PlectrifyCatalogueTests PRIVATE Source/plugins)
    target_compile_definitions(PlectrifyCatalogueTests PRIVATE
        JUCE_USE_CURL=0
        JUCE_WEB_BROWSER=0
        JUCE_PLUGINHOST_VST3=0
        # The real authoring file, so the shipped parser is tested against what
        # is actually published rather than only against fixtures. The JSON and
        # this parser are edited independently; `pnpm --dir packaging validate`
        # checks the file against the TypeScript rules, and this checks it
        # against the C++ ones.
        PLECTRIFY_REAL_CATALOGUE="${CMAKE_CURRENT_SOURCE_DIR}/packaging/catalogue.json")
    target_link_libraries(PlectrifyCatalogueTests PRIVATE
        juce::juce_cryptography
        PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)
    add_test(NAME Plectrify.Catalogue COMMAND PlectrifyCatalogueTests)

    # The TONE3000 integration's one piece of surgery on an opaque plugin
    # state: repointing Neural Amp Modeler at a downloaded capture. Pure
    # string/buffer work, so it runs offline and with no plugin installed —
    # the synthetic cases always run, and any state captured from a real NAM
    # and dropped into Tests/tone3000/fixtures is checked as well.
    juce_add_console_app(PlectrifyNamStateTests PRODUCT_NAME "Plectrify NAM State Tests")
    juce_generate_juce_header(PlectrifyNamStateTests)
    target_sources(PlectrifyNamStateTests PRIVATE
        Source/tone3000/NamStateCodec.cpp
        Tests/tone3000/NamStateCodecTests.cpp)
    target_include_directories(PlectrifyNamStateTests PRIVATE Source/tone3000)
    target_compile_definitions(PlectrifyNamStateTests PRIVATE
        JUCE_USE_CURL=0
        JUCE_WEB_BROWSER=0
        JUCE_PLUGINHOST_VST3=0
        PLECTRIFY_TONE3000_FIXTURE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/Tests/tone3000/fixtures")
    target_link_libraries(PlectrifyNamStateTests PRIVATE
        # For AudioProcessor::copyXmlToBinary/getXmlFromBinary — the codec goes
        # through JUCE's own pair rather than reimplementing the envelope.
        juce::juce_audio_processors
        PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)
    add_test(NAME Plectrify.NamStateCodec COMMAND PlectrifyNamStateTests)

    # TONE3000's OAuth rules: the PKCE derivation, the authorize URL and the
    # callback checks that decide whether a sign-in is this app's to redeem.
    juce_add_console_app(PlectrifyTone3000AuthTests PRODUCT_NAME "Plectrify TONE3000 Auth Tests")
    juce_generate_juce_header(PlectrifyTone3000AuthTests)
    target_sources(PlectrifyTone3000AuthTests PRIVATE
        Source/tone3000/Tone3000Auth.cpp
        Tests/tone3000/Tone3000AuthTests.cpp)
    target_include_directories(PlectrifyTone3000AuthTests PRIVATE Source/tone3000)
    target_compile_definitions(PlectrifyTone3000AuthTests PRIVATE
        JUCE_USE_CURL=0
        JUCE_WEB_BROWSER=0
        JUCE_PLUGINHOST_VST3=0)
    target_link_libraries(PlectrifyTone3000AuthTests PRIVATE
        juce::juce_cryptography
        PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)
    add_test(NAME Plectrify.Tone3000Auth COMMAND PlectrifyTone3000AuthTests)

    # Where a TONE3000 download lands and what it is called: the id-only naming
    # every patch's plugin state depends on, and the two guards that keep a
    # network-supplied id or URL from naming a file outside the download root.
    juce_add_console_app(PlectrifyTone3000LibraryTests PRODUCT_NAME "Plectrify TONE3000 Library Tests")
    juce_generate_juce_header(PlectrifyTone3000LibraryTests)
    target_sources(PlectrifyTone3000LibraryTests PRIVATE
        Source/tone3000/Tone3000Library.cpp
        Source/tone3000/Tone3000SelectUrl.cpp
        Source/tone3000/Tone3000WindowState.cpp
        Tests/tone3000/Tone3000LibraryTests.cpp)
    # Source/app for AppPaths.h, which the slice's Debug-only window trace
    # writes through — the same per-user root the app itself uses.
    target_include_directories(PlectrifyTone3000LibraryTests PRIVATE Source/tone3000 Source/app)
    target_compile_definitions(PlectrifyTone3000LibraryTests PRIVATE
        JUCE_USE_CURL=0
        JUCE_WEB_BROWSER=0
        JUCE_PLUGINHOST_VST3=0)
    target_link_libraries(PlectrifyTone3000LibraryTests PRIVATE
        juce::juce_core
        # juce_graphics for juce::Rectangle alone — the window-placement rule is
        # geometry, and it is tested without a screen.
        juce::juce_graphics
        PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)
    add_test(NAME Plectrify.Tone3000Library COMMAND PlectrifyTone3000LibraryTests)

    # A manual probe, deliberately NOT registered with add_test: it loads a real
    # Neural Amp Modeler into the process to prove the plugin accepts a state
    # whose model path we rewrote. `ctest` stays offline and plugin-free —
    # scanning is user-triggered in Plectrify and must be here too. Run it by hand
    # after bumping NAM (see the release procedure in AGENTS.md):
    #   PlectrifyNamStateProbe <NeuralAmpModeler.vst3> <capture.nam> [fixture dir]
    juce_add_console_app(PlectrifyNamStateProbe PRODUCT_NAME "Plectrify NAM State Probe")
    juce_generate_juce_header(PlectrifyNamStateProbe)
    target_sources(PlectrifyNamStateProbe PRIVATE
        Source/tone3000/NamStateCodec.cpp
        Tests/tone3000/NamStateProbe.cpp)
    target_include_directories(PlectrifyNamStateProbe PRIVATE Source/tone3000)
    target_compile_definitions(PlectrifyNamStateProbe PRIVATE
        JUCE_USE_CURL=0
        JUCE_WEB_BROWSER=0
        JUCE_PLUGINHOST_VST3=1
        # NAM stages its model off the message thread, so the probe has to pump
        # the loop while it waits. Safe in a console tool; never in the app.
        JUCE_MODAL_LOOPS_PERMITTED=1)
    target_link_libraries(PlectrifyNamStateProbe PRIVATE
        juce::juce_audio_processors
        juce::juce_audio_utils
        PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)

    # A manual probe, deliberately NOT registered with add_test: it loads a real
    # third-party VST3 to answer whether bypassing it the way the rack does
    # (Node::setBypassed -> the plugin's own kIsBypass parameter, if exported)
    # actually silences its effect. See Tests/audio/BypassProbe.cpp.
    #   PlectrifyBypassProbe <plugin.vst3>
    juce_add_console_app(PlectrifyBypassProbe PRODUCT_NAME "Plectrify Bypass Probe")
    juce_generate_juce_header(PlectrifyBypassProbe)
    target_sources(PlectrifyBypassProbe PRIVATE
        Tests/audio/BypassProbe.cpp)
    target_compile_definitions(PlectrifyBypassProbe PRIVATE
        JUCE_USE_CURL=0
        JUCE_WEB_BROWSER=0
        JUCE_PLUGINHOST_VST3=1
        # The probe pumps the loop after setting the bypass parameter, the same
        # licence NamStateProbe has. Safe in a console tool; never in the app.
        JUCE_MODAL_LOOPS_PERMITTED=1)
    target_link_libraries(PlectrifyBypassProbe PRIVATE
        juce::juce_audio_processors
        juce::juce_audio_utils
        PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)

    # The fixed click generator: timing, subdivisions, accent pattern and
    # transparent passthrough, exercised without the rack graph.
    juce_add_console_app(PlectrifyMetronomeTests PRODUCT_NAME "Plectrify Metronome Tests")
    juce_generate_juce_header(PlectrifyMetronomeTests)
    target_sources(PlectrifyMetronomeTests PRIVATE
        Source/audio/MetronomeProcessor.cpp
        Tests/audio/MetronomeProcessorTests.cpp)
    target_include_directories(PlectrifyMetronomeTests PRIVATE Source/audio)
    target_compile_definitions(PlectrifyMetronomeTests PRIVATE
        JUCE_USE_CURL=0
        JUCE_WEB_BROWSER=0
        JUCE_PLUGINHOST_VST3=0)
    target_link_libraries(PlectrifyMetronomeTests PRIVATE
        juce::juce_audio_processors
        PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)
    add_test(NAME Plectrify.Metronome COMMAND PlectrifyMetronomeTests)

    # Auto Standby's idle policy: stage timings and transition ordering, driven
    # by a synthetic clock. Its own target because the controller is header-only
    # and needs nothing but juce_core — no graph, no plugins, no audio.
    juce_add_console_app(PlectrifyStandbyTests PRODUCT_NAME "Plectrify Standby Tests")
    juce_generate_juce_header(PlectrifyStandbyTests)
    target_sources(PlectrifyStandbyTests PRIVATE
        Tests/app/StandbyControllerTests.cpp)
    target_include_directories(PlectrifyStandbyTests PRIVATE Source/app)
    target_compile_definitions(PlectrifyStandbyTests PRIVATE
        JUCE_USE_CURL=0
        JUCE_WEB_BROWSER=0)
    target_link_libraries(PlectrifyStandbyTests PRIVATE
        juce::juce_audio_basics
        PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)
    add_test(NAME Plectrify.StandbyController COMMAND PlectrifyStandbyTests)

    # What a first launch opens: which driver family, and how big a block. Both
    # rules are pure functions with no device manager in them, so this target
    # needs nothing but juce_core either.
    juce_add_console_app(PlectrifyAudioSetupTests PRODUCT_NAME "Plectrify Audio Setup Tests")
    juce_generate_juce_header(PlectrifyAudioSetupTests)
    target_sources(PlectrifyAudioSetupTests PRIVATE
        Tests/app/AudioSetupRulesTests.cpp)
    target_include_directories(PlectrifyAudioSetupTests PRIVATE Source/app)
    target_compile_definitions(PlectrifyAudioSetupTests PRIVATE
        JUCE_USE_CURL=0
        JUCE_WEB_BROWSER=0)
    target_link_libraries(PlectrifyAudioSetupTests PRIVATE
        juce::juce_audio_basics
        PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)
    add_test(NAME Plectrify.AudioSetupRules COMMAND PlectrifyAudioSetupTests)
endif()
