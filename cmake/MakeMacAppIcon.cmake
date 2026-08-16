# Builds the macOS app icon from the shared 1024 px artwork.
#
# Two things are wrong with letting JUCE's own icon writer do it. It emits an
# .icns holding exactly the images it was handed — here 1024 and 64 px — so
# every other representation, including the 16 and 32 px ones Finder, the menu
# bar and Spotlight actually draw, is left for the window server to scale down
# from 1024 at draw time, which is visibly soft. And the artwork is full-bleed:
# its ink is 963 px tall on a 1024 px canvas, where Apple's icon grid sits a
# normal app inside an 824 px box, so Plectrify rendered noticeably larger than
# every neighbour in the Dock.
#
# So the whole ladder is regenerated here instead, from a canvas shrunk to put
# the ink on the grid. sips and iconutil are stock macOS, needing no toolchain
# beyond what a mac build already has, and `sips -c` pads with transparency,
# which is what re-centres the shrunken artwork on a full-size canvas.
#
# Run with -DSOURCE_PNG=<1024 px png> -DOUTPUT_ICNS=<file> -DWORK_DIR=<scratch>.

foreach (required SOURCE_PNG OUTPUT_ICNS WORK_DIR)
    if (NOT DEFINED ${required})
        message(FATAL_ERROR "MakeMacAppIcon.cmake: ${required} is required")
    endif()
endforeach()

# 1024 * 824/963. Measured from the source art's alpha bounds, not guessed:
# re-measure it if the artwork is ever redrawn with different margins.
set(PLECTRIFY_ICON_GRID_CANVAS 876)

set(iconset "${WORK_DIR}/AppIcon.iconset")
file(REMOVE_RECURSE "${iconset}")
file(MAKE_DIRECTORY "${iconset}")

# execute_process reports a failing tool through RESULT_VARIABLE rather than by
# failing the script, so every call is checked.
function(plectrify_run description)
    execute_process(COMMAND ${ARGN} RESULT_VARIABLE status OUTPUT_QUIET)

    if (NOT status EQUAL 0)
        message(FATAL_ERROR "MakeMacAppIcon.cmake: ${description} failed (${status})")
    endif()
endfunction()

set(scaled "${WORK_DIR}/scaled.png")
set(onGrid "${WORK_DIR}/on-grid.png")

plectrify_run("scaling the artwork to the icon grid"
    sips -Z ${PLECTRIFY_ICON_GRID_CANVAS} "${SOURCE_PNG}" --out "${scaled}")
plectrify_run("re-centring the artwork on a full-size canvas"
    sips -c 1024 1024 "${scaled}" --out "${onGrid}")

# Every representation macOS asks for, at both scale factors. iconutil derives
# the .icns element for each from the file name, so these are fixed names.
# Pairs are joined with a colon rather than a semicolon: CMake would read a
# semicolon as a list separator and flatten the pairs apart.
set(PLECTRIFY_ICON_SIZES
    "16:icon_16x16"
    "32:icon_16x16@2x"
    "32:icon_32x32"
    "64:icon_32x32@2x"
    "128:icon_128x128"
    "256:icon_128x128@2x"
    "256:icon_256x256"
    "512:icon_256x256@2x"
    "512:icon_512x512"
    "1024:icon_512x512@2x")

foreach (entry IN LISTS PLECTRIFY_ICON_SIZES)
    string(REPLACE ":" ";" pair "${entry}")
    list(GET pair 0 size)
    list(GET pair 1 name)

    plectrify_run("rendering ${name}"
        sips -z ${size} ${size} "${onGrid}" --out "${iconset}/${name}.png")
endforeach()

get_filename_component(outputDir "${OUTPUT_ICNS}" DIRECTORY)
file(MAKE_DIRECTORY "${outputDir}")

plectrify_run("packing the iconset"
    iconutil --convert icns "${iconset}" --output "${OUTPUT_ICNS}")
