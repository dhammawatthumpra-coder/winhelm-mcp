#pragma once

#include <node_api.h>

namespace winhelm::guarded_marker {

napi_value Begin(napi_env env, napi_callback_info info);
napi_value Acknowledge(napi_env env, napi_callback_info info);

#ifdef WINHELM_NATIVE_TEST_HOOKS
napi_value BeginTest(napi_env env, napi_callback_info info);
napi_value AttemptDeleteDirectoryTest(napi_env env, napi_callback_info info);
#endif

}  // namespace winhelm::guarded_marker
