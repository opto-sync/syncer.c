use std::path::PathBuf;

fn main() {
    // Link the C core's shared library from this repo's core build directory
    // (built by `make` in core/ — run_all.sh guarantees it exists first).
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let build_dir = manifest.join("../../core/build");
    let build_dir = build_dir.canonicalize().unwrap_or(build_dir);
    println!("cargo:rustc-link-search=native={}", build_dir.display());
    println!("cargo:rustc-link-lib=dylib=syncer");
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", build_dir.display());
}
