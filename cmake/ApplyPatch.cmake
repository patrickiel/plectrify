# Apply a FetchContent patch exactly once. ExternalProject may rerun its patch
# step after every Git update check, so an already-applied patch is success.
#
# Every `git apply` here passes --ignore-whitespace, which is what makes the
# patch portable. JUCE checks its Windows-only sources in with CRLF line
# endings and ships no .gitattributes normalising them, so juce-src carries
# literal CRs on every OS; our patch files are LF. On Windows the mismatch
# hides because core.autocrlf checks the .patch out as CRLF too, so both sides
# happen to agree — on macOS nothing translates and the context match fails
# with a bare "patch does not apply". Matching modulo whitespace makes the
# result depend on the patch's content rather than on each developer's
# autocrlf setting. It must be on all three invocations: leaving it off the
# reverse check would make an applied patch look absent and abort the configure.
set(git_apply_options --ignore-whitespace --whitespace=nowarn)

foreach(required_variable IN ITEMS GIT_EXECUTABLE PATCH_FILE SOURCE_DIR)
    if (NOT DEFINED ${required_variable})
        message(FATAL_ERROR "ApplyPatch.cmake requires ${required_variable}")
    endif()
endforeach()

execute_process(
    COMMAND "${GIT_EXECUTABLE}" apply --check ${git_apply_options} "${PATCH_FILE}"
    WORKING_DIRECTORY "${SOURCE_DIR}"
    RESULT_VARIABLE can_apply
    ERROR_VARIABLE apply_check_error)

if (can_apply EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" apply ${git_apply_options} "${PATCH_FILE}"
        WORKING_DIRECTORY "${SOURCE_DIR}"
        RESULT_VARIABLE apply_result
        ERROR_VARIABLE apply_error)

    if (NOT apply_result EQUAL 0)
        message(FATAL_ERROR "Failed to apply ${PATCH_FILE}:\n${apply_error}")
    endif()

    message(STATUS "Applied ${PATCH_FILE}")
    return()
endif()

execute_process(
    COMMAND "${GIT_EXECUTABLE}" apply --check --reverse ${git_apply_options} "${PATCH_FILE}"
    WORKING_DIRECTORY "${SOURCE_DIR}"
    RESULT_VARIABLE is_applied
    ERROR_VARIABLE reverse_check_error)

if (is_applied EQUAL 0)
    message(STATUS "Patch already applied: ${PATCH_FILE}")
    return()
endif()

message(FATAL_ERROR
    "Patch cannot be applied and is not already present: ${PATCH_FILE}\n"
    "Apply check:\n${apply_check_error}\n"
    "Reverse check:\n${reverse_check_error}\n"
    "If the JUCE tag was changed, regenerate the patch against the new JUCE "
    "sources and delete ${SOURCE_DIR} so FetchContent re-populates it. "
    "Stale _deps state from an interrupted configure can cause this too — the "
    "same delete fixes it. (The build tree differs per platform, hence naming "
    "it here rather than the Windows-only build/_deps path this used to print.)")
