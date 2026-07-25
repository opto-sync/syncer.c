/*
 * cgo compilation shim.
 *
 * cgo compiles every .c file that lives in the package directory, so this
 * file pulls the frozen C core straight into the Go build. No prebuilt
 * libsyncer.dylib/.so and no -L/-l linker flags are needed: `go build`
 * produces a fully self-contained package.
 *
 * The #include below resolves relative to THIS file's directory.
 * yyjson.c is compiled by the sibling shim yyjson_core.c as a separate
 * translation unit (exactly like the core's own build), so there are no
 * duplicate-symbol collisions.
 */
#include "../../core/src/syncer.c"
