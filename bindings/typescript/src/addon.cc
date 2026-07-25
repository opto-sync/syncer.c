#include <napi.h>
#include "syncer.h"
#include <string.h>
#include <stdlib.h>
#include <string>

// Callback state for the CURRENT mergeJson call on THIS thread.
// thread_local (not a process global) so concurrent merges on different
// threads (worker_threads) cannot race; the caller saves/restores it so a
// callback that re-enters mergeJson cannot clobber the outer call's callback.
thread_local Napi::FunctionReference* t_callback = nullptr;

// NOTE on exceptions: binding.gyp defines NAPI_DISABLE_CPP_EXCEPTIONS, so
// node-addon-api never throws Napi::Error as a C++ exception. When the JS
// override throws, the exception becomes "pending" on the env and Call()
// returns an empty value. We detect that with env.IsExceptionPending():
// once pending, we stop invoking the callback for subsequent keys (returning
// NULL so the C core falls back to its default merge), and after the merge
// completes we simply return to JS so the pending exception propagates.
char* cpp_override_cb(const char* json_path, const char* v1, const char* v2) {
    if (t_callback == nullptr || t_callback->IsEmpty()) return nullptr;

    Napi::Env env = t_callback->Env();
    // A previous invocation of the JS override already threw: don't call
    // back into JS again while an exception is pending.
    if (env.IsExceptionPending()) return nullptr;

    Napi::HandleScope scope(env);

    napi_value args[3] = {
        Napi::String::New(env, json_path),
        Napi::String::New(env, v1),
        Napi::String::New(env, v2)
    };

    Napi::Value res = t_callback->Call({args[0], args[1], args[2]});
    if (env.IsExceptionPending() || res.IsEmpty()) {
        // JS override threw: leave the exception pending and let the core
        // use its default merge for this (and every later) key.
        return nullptr;
    }
    if (res.IsString()) {
        std::string str = res.As<Napi::String>().Utf8Value();
        return strdup(str.c_str());
    }

    return nullptr;
}

Napi::Value MergeJsonNode(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "String expected").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string j1 = info[0].As<Napi::String>().Utf8Value();
    std::string j2 = info[1].As<Napi::String>().Utf8Value();

    /* syncer_default_options() fully initializes EVERY field, including the
       v0.2.0 array_match_keys pointer — never construct this struct by hand. */
    syncer_merge_options_t opts = syncer_default_options();
    std::string lww_keys_storage; /* to keep the string alive if we copy it */
    std::string fww_keys_storage;
    std::string array_match_keys_storage;
    Napi::FunctionReference cbRef; /* per-call callback ref; released on return */

    /* IsFunction must be tested BEFORE IsObject: node-addon-api's IsObject()
       is true for functions, so an object-first dispatch makes the legacy
       positional-callback branch unreachable. */
    if (info.Length() >= 3 && info[2].IsFunction()) {
        /* Legacy fallback: 3rd arg is directly the callback */
        cbRef.Reset(info[2].As<Napi::Function>(), 1);
        opts.override_cb = cpp_override_cb;
    } else if (info.Length() >= 3 && info[2].IsObject()) {
        Napi::Object jOpts = info[2].As<Napi::Object>();
        
        if (jOpts.Has("arrayStrategy") && jOpts.Get("arrayStrategy").IsNumber()) {
            opts.array_strategy = (syncer_array_strategy_t)jOpts.Get("arrayStrategy").As<Napi::Number>().Int32Value();
        }
        if (jOpts.Has("maxDepth") && jOpts.Get("maxDepth").IsNumber()) {
            opts.max_depth = jOpts.Get("maxDepth").As<Napi::Number>().Uint32Value();
        }
        if (jOpts.Has("detectCircularRefs") && jOpts.Get("detectCircularRefs").IsBoolean()) {
            opts.detect_circular_refs = jOpts.Get("detectCircularRefs").As<Napi::Boolean>().Value();
        }
        if (jOpts.Has("resolveByTimestamp") && jOpts.Get("resolveByTimestamp").IsBoolean()) {
            opts.resolve_by_timestamp = jOpts.Get("resolveByTimestamp").As<Napi::Boolean>().Value();
        }
        if (jOpts.Has("lwwKeys") && jOpts.Get("lwwKeys").IsString()) {
            lww_keys_storage = jOpts.Get("lwwKeys").As<Napi::String>().Utf8Value();
            opts.lww_keys = lww_keys_storage.c_str();
        }
        if (jOpts.Has("fwwKeys") && jOpts.Get("fwwKeys").IsString()) {
            fww_keys_storage = jOpts.Get("fwwKeys").As<Napi::String>().Utf8Value();
            opts.fww_keys = fww_keys_storage.c_str();
        }
        if (jOpts.Has("overrideCb") && jOpts.Get("overrideCb").IsFunction()) {
            cbRef.Reset(jOpts.Get("overrideCb").As<Napi::Function>(), 1);
            opts.override_cb = cpp_override_cb;
        }
    }

    Napi::FunctionReference* prev_callback = t_callback;
    if (opts.override_cb) t_callback = &cbRef;

    char* result = syncer_merge_json_ex(j1.c_str(), j2.c_str(), &opts);

    t_callback = prev_callback;

    if (t_cb_threw) {
        t_cb_threw = false;
        if (result) syncer_free(result);
        Napi::Error::New(env, t_cb_error_msg).ThrowAsJavaScriptException();
        return env.Null();
    }

    if (!result) {
        return env.Null();
    }

    Napi::String ret = Napi::String::New(env, result);
    syncer_free(result);
    return ret;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set(Napi::String::New(env, "mergeJson"), Napi::Function::New(env, MergeJsonNode));
    return exports;
}

NODE_API_MODULE(syncer, Init)
