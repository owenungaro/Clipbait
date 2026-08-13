cmake_minimum_required(VERSION 3.20)
project(clipbait-capture LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "clipbait-capture only builds for Windows (WGC + Media Foundation).")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)

add_executable(clipbait-capture src/main.cpp)
target_compile_definitions(clipbait-capture PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)

# MSVC only: raw WinRT ABI headers + WRL rely on MSVC-specific COM extensions
# (__uuidof and friends) that MinGW does not reliably support.
if(MSVC)
  target_compile_options(clipbait-capture PRIVATE /W4 /EHsc)
else()
  message(FATAL_ERROR "clipbait-capture must be built with MSVC.")
endif()
