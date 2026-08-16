# Stamp the commit and build time into a generated header. Run at *build* time
# (not configure time) so the provenance in a bug report is the provenance of
# the exe that produced it — a commit hash captured at configure time goes stale
# on the very next `git commit` and would then be worse than no hash at all.
#
# configure_file writes only when the content differs, so the header's mtime
# (and with it the recompile of the single TU that includes it) tracks real
# changes rather than every build.
foreach(required_variable IN ITEMS SOURCE_DIR OUTPUT_FILE TEMPLATE_FILE)
    if (NOT DEFINED ${required_variable})
        message(FATAL_ERROR "WriteBuildInfo.cmake requires ${required_variable}")
    endif()
endforeach()

set(PLECTRIFY_GIT_COMMIT "")
set(PLECTRIFY_GIT_DIRTY 0)

find_package(Git QUIET)
if (GIT_FOUND)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" rev-parse --short HEAD
        WORKING_DIRECTORY "${SOURCE_DIR}"
        OUTPUT_VARIABLE PLECTRIFY_GIT_COMMIT
        OUTPUT_STRIP_TRAILING_WHITESPACE
        ERROR_QUIET)

    # Uncommitted work means the hash alone does not identify the build, and a
    # report from such a build should say so out loud.
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" status --porcelain --untracked-files=no
        WORKING_DIRECTORY "${SOURCE_DIR}"
        OUTPUT_VARIABLE _git_status
        OUTPUT_STRIP_TRAILING_WHITESPACE
        ERROR_QUIET)
    if (NOT _git_status STREQUAL "")
        set(PLECTRIFY_GIT_DIRTY 1)
    endif()
endif()

# UTC: a timestamp from a machine in an unknown time zone is ambiguous, and the
# reader of a bug report has no way to resolve it.
string(TIMESTAMP PLECTRIFY_BUILD_TIME "%Y-%m-%d %H:%M UTC" UTC)

configure_file("${TEMPLATE_FILE}" "${OUTPUT_FILE}" @ONLY)
