cmake_minimum_required(VERSION 3.14)
project(syncer VERSION 0.1.0 LANGUAGES C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

# Keep the public C ABI usable when consumers build the shared library with
# MSVC. Unix toolchains export external symbols by default; Windows does not.
set(CMAKE_WINDOWS_EXPORT_ALL_SYMBOLS ON)

# Add include directories
include_directories(include)

# Define the library
add_library(syncer SHARED
    src/syncer.c
    src/yyjson.c
)

# Export options
target_include_directories(syncer PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:include>
)

enable_testing()

add_executable(test_syncer
    test/test_syncer.c
    src/syncer.c
    src/yyjson.c
)

target_include_directories(test_syncer PRIVATE include)
add_test(NAME test_syncer COMMAND test_syncer)
