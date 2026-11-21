# Ruffle Integration for LocalGobe

LocalGobe uses a patched build of **Ruffle** (upstream `ruffle-rs/ruffle`, Cargo workspace `0.6.0`, dual-licensed under MIT and Apache-2.0) to execute user-provided Mogobe SWF files in the browser without modifying original historical binaries.

## What Is Included Here

- `patches/localgobe-ruffle.patch` — LocalGobe runtime compatibility diff (AIR mode support, Hebrew BiDi layout, AVM2/MovieClip/Timer/Navigator adjustments).
- `src/` — Original LocalGobe Rust compatibility modules (`mogobe_item_compat.rs`, `mogobe_platform_compat.rs`, `mogobe_room_compat.rs`, `diagnostics.rs`).
- `LICENSE_MIT` & `LICENSE_APACHE` — Upstream Ruffle licenses.

Compiled `.wasm` / `.js` binaries are **not** tracked in Git. Instead, LocalGobe loads the selfhosted Ruffle bundle from `data/runtime/ruffle/` (or the path specified by `LOCALGOBE_RUFFLE_DIST`).

## Building Ruffle from Source

Prerequisites: Rust stable with `wasm32-unknown-unknown`, Java, Node.js, and `wasm-bindgen-cli` matching Ruffle's `Cargo.lock`.

1. Clone upstream Ruffle (`ruffle-rs/ruffle`, `0.6.0` base).
2. Apply `ruffle/patches/localgobe-ruffle.patch` and copy `ruffle/src/*.rs` into `core/src/` (see patch paths).
3. Build the selfhosted web package:
   ```bash
   cd web
   npm ci
   npm run build
   ```
4. Copy `web/packages/selfhosted/dist/*` into `data/runtime/ruffle/`.
5. Verify with:
   ```bash
   npm run setup:ruffle
   ```
