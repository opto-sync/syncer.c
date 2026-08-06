use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let core = manifest.join("../../core");
    let syncer = core.join("src/syncer.c");
    let yyjson = core.join("src/yyjson.c");

    println!("cargo:rerun-if-changed={}", syncer.display());
    println!("cargo:rerun-if-changed={}", yyjson.display());
    println!(
        "cargo:rerun-if-changed={}",
        core.join("include/syncer.h").display()
    );

    // Compile the reference core into the fuzzer. Linking a prebuilt dylib is
    // not portable on macOS: a locally produced library can carry a relative
    // install name such as `build/libsyncer.dylib`, which dyld resolves from
    // the caller's working directory before it considers an rpath. Static
    // test-only linkage also ensures these exact source files are exercised.
    cc::Build::new()
        .include(core.join("include"))
        .include(core.join("src"))
        .file(syncer)
        .file(yyjson)
        .std("c99")
        .compile("syncer_c_reference");
}
