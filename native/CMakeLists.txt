cmake_minimum_required(VERSION 3.25)

project(winhelm_native_boundary LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "WinHelm native boundary is Windows-only")
endif()

if(NOT MSVC)
  message(FATAL_ERROR "WinHelm native boundary qualification requires MSVC")
endif()

set(NODE_INCLUDE_DIR "" CACHE PATH "Path to exact Node.js include/node directory")
set(NODE_LIB_FILE "" CACHE FILEPATH "Path to exact Node.js x64 node.lib")

if(NOT EXISTS "${NODE_INCLUDE_DIR}/node_api.h")
  message(FATAL_ERROR "NODE_INCLUDE_DIR must contain node_api.h")
endif()

if(NOT EXISTS "${NODE_LIB_FILE}")
  message(FATAL_ERROR "NODE_LIB_FILE must point to exact Node.js x64 node.lib")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

function(configure_winhelm_native target_name)
  add_library(${target_name} MODULE src/winhelm_native.cpp)
  target_include_directories(${target_name} PRIVATE "${NODE_INCLUDE_DIR}")
  target_link_libraries(${target_name} PRIVATE "${NODE_LIB_FILE}" bcrypt)
  target_compile_definitions(${target_name} PRIVATE
    NAPI_VERSION=10
    NODE_GYP_MODULE_NAME=${target_name}
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    UNICODE
    _UNICODE
    PSAPI_VERSION=2
  )
  target_compile_options(${target_name} PRIVATE
    /W4
    /WX
    /permissive-
    /guard:cf
    /sdl
  )
  target_link_options(${target_name} PRIVATE
    /guard:cf
    /DYNAMICBASE
    /NXCOMPAT
  )
  set_target_properties(${target_name} PROPERTIES
    PREFIX ""
    SUFFIX ".node"
  )
endfunction()

configure_winhelm_native(winhelm_native)
configure_winhelm_native(winhelm_native_test)
target_compile_definitions(winhelm_native_test PRIVATE WINHELM_NATIVE_TEST_HOOKS=1)

# Test-only helper executable for A4 stdio/environment qualification.
add_executable(a4_child test/helpers/a4-child.cpp)
target_compile_definitions(a4_child PRIVATE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  UNICODE
  _UNICODE
)
target_compile_options(a4_child PRIVATE /W4 /WX)
