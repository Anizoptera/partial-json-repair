//! Captures the compiler that built this binary, so the emitted runtime label is a fact rather than
//! an assumption.
//!
//! `bench/prior-art/baseline.ts` refuses a fork whose reported runtime is not the one it asked for,
//! because a version pin that silently falls back files one engine's numbers under another engine's
//! name — measured in this repository for bun. Reporting the compiler that actually ran makes the
//! repository's rustup pin checkable rather than assumed.
use std::process::Command;

fn main() {
    let version = Command::new(std::env::var("RUSTC").unwrap_or_else(|_| "rustc".into()))
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .unwrap_or_default();
    // `rustc 1.97.1 (8bab26f4f 2026-07-14)` -> `1.97.1`
    let number = version.split_whitespace().nth(1).unwrap_or("unknown");
    println!("cargo:rustc-env=BUILT_BY_RUSTC={number}");
    println!("cargo:rerun-if-changed=build.rs");
}
