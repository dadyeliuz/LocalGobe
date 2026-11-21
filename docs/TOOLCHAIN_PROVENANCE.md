# Toolchain Assets Provenance & Licensing

This document details the exact provenance, upstream source commits, build procedures, cryptographic digests, licenses, and redistribution terms for all third-party toolchain and runtime assets utilized by LocalGobe.

---

## 1. Summary of Assets

| Asset | Upstream Project | Version / Commit | SHA-256 Digest | Size (bytes) | License |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `asc.jar` | Apache Flex / Ruffle | `edef34c136f318f5c03c339d48ea527899864e53` | `4dc2aef13198cfa0692b2f2dda3cce10890277066d7c5aa2ac3e9c9f9a2c462e` | 1,359,221 | Apache-2.0 |
| `playerglobal_import.abc` | Ruffle (`build_playerglobal`) | `edef34c136f318f5c03c339d48ea527899864e53` | `3c402028d02037f5eee0e988fec8a7c12fb889457094fcf7f7c3bb1cbddddc97` | 293,707 | MIT / Apache-2.0 |
| `ruffle-selfhosted.tar.gz` | Ruffle | `edef34c136f318f5c03c339d48ea527899864e53` | `86493bca32b106a04d01b9ebe592c971d4ddaa0b15750219f138abf0f24f1aad` | 5,398,697 | MIT / Apache-2.0 |

Immutable Git storage location:
- Repository: `https://github.com/dadyeliuz/LocalGobe.git`
- Branch: `toolchain-assets`
- Immutable Commit SHA: `a7d418d26538b232e3fb2da3646b23146f78173a`

---

## 2. ActionScript 3 Compiler (`asc.jar`)

### Upstream Project
- **Project**: Apache Flex SDK (ActionScript 3 Compiler) / Ruffle toolchain
- **Upstream Repository**: https://github.com/ruffle-rs/ruffle.git (`tools/asc/asc.jar`)
- **Pinned Upstream Commit**: `edef34c136f318f5c03c339d48ea527899864e53`
- **Origin**: Open-source ActionScript Compiler (Macromedia ASC open-source release / Apache Flex SDK `modules/asc`)
- **License**: Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0)
- **NOTICE**: This product includes software developed at The Apache Software Foundation (http://www.apache.org/).

### Purpose in LocalGobe
Compiles clean-room ActionScript 3 shims (`src/compatibility/air/as3/`) into minimal SWF bytecode modules required for running historical Flash/AIR client assets without proprietary dependencies.

### Cryptographic Digest
- **SHA-256**: `4dc2aef13198cfa0692b2f2dda3cce10890277066d7c5aa2ac3e9c9f9a2c462e`
- **File size**: 1,359,221 bytes
- **Bit-identical to upstream**: YES (verified against raw upstream Ruffle repository at commit `edef34c136f318f5c03c339d48ea527899864e53`).

### Notice & Redistribution Clearance
- Permitted under Apache License 2.0 Section 4 with attribution and NOTICE preserved in `THIRD_PARTY_NOTICES.md`.

---

## 3. Ruffle Open-Source Playerglobal Catalog (`playerglobal_import.abc`)

### Upstream Project
- **Project**: Ruffle (`core/build_playerglobal`)
- **Upstream Repository**: https://github.com/ruffle-rs/ruffle.git
- **Pinned Upstream Commit**: `edef34c136f318f5c03c339d48ea527899864e53`
- **License**: Dual-licensed under MIT License and Apache License, Version 2.0

### True Origin & Clean-Room Construction
- Built **entirely** from Ruffle's own open-source Flash API definitions in `core/src/avm2/globals/` (such as `Toplevel.as`, `globals.as`, and AS3 class stubs in `core/src/avm2/globals/flash/`).
- **NO Adobe PlayerGlobal.swc binary was used as input.**
- **NO Adobe AIR SDK or Flash Player SDK binary was used as input.**
- **NO Apache Flex `playerglobal.swc` binary was used as input.**
- `ADOBE_PLAYERGLOBAL_INPUT_USED = NO`

### Build Procedure & Reproduction Command
Built from Ruffle source tree using Ruffle's internal builder:
```bash
cargo run --package=build_playerglobal -- compile <out_dir>
```
During the compilation step in `core/build_playerglobal/src/avm2.rs` (lines 88–96):
1. `asc.jar` compiles Ruffle's ActionScript definitions into raw ABC bytecode (`playerglobal_avm2.abc`).
2. The builder explicitly preserves the raw ABC bytecode by renaming `playerglobal_avm2.abc` to `playerglobal_import.abc` for use as an `asc.jar -import` catalog:
   ```rust
   // Keep a copy of the raw ABC for use as an asc.jar import library.
   std::fs::rename(
       playerglobal.with_extension("abc"),
       out_dir.join("playerglobal_import.abc"),
   )?;
   ```

### Cryptographic Digest
- **SHA-256**: `3c402028d02037f5eee0e988fec8a7c12fb889457094fcf7f7c3bb1cbddddc97`
- **File size**: 293,707 bytes
- **Bit-identical to source build**: YES (independently reproduced from source with zero byte differences).

### Purpose in LocalGobe
Serves as the type import catalog passed to `asc.jar -import playerglobal_import.abc` when compiling LocalGobe's clean-room AIR shims.

### Notice & Redistribution Clearance
- Permitted under dual MIT / Apache-2.0 licenses.

---

## 4. Ruffle Flash Emulator Runtime (`ruffle-selfhosted.tar.gz`)

### Upstream Project
- **Project**: Ruffle (Open-source Flash Player emulator written in Rust)
- **Home**: https://ruffle.rs/
- **Repository**: https://github.com/ruffle-rs/ruffle.git
- **Pinned Upstream Commit**: `edef34c136f318f5c03c339d48ea527899864e53`
- **License**: Dual-licensed under MIT License and Apache License, Version 2.0

### Purpose in LocalGobe
Provides in-browser WebAssembly Flash emulation engine executing client SWF files safely with bidirectional Hebrew text support and ActionScript runtime support.

### Reproducible Build Environment
- **Rust Toolchain**: `1.96.0` (target `wasm32-unknown-unknown`)
- **wasm-bindgen-cli**: `0.2.127`
- **Node.js**: `24.x`
- **Command**:
  ```bash
  git clone https://github.com/ruffle-rs/ruffle.git
  cd ruffle
  git checkout edef34c136f318f5c03c339d48ea527899864e53
  cargo build --package ruffle_web --target wasm32-unknown-unknown --release
  npm --prefix web install
  npm --prefix web run build:selfhosted
  tar -czf ruffle-selfhosted.tar.gz -C web/packages/selfhosted/dist .
  ```

### Archive Contents
- `853a7813b20bbbc33718.wasm` (Compiled WebAssembly Flash engine)
- `core.ruffle.*.js` (WebAssembly instantiator)
- `ruffle.js` (Self-hosted loader script)
- `LICENSE_MIT` and `LICENSE_APACHE`
- `package.json` and `README.md`
*(Contains no Adobe, Mogobe, or user proprietary assets).*

### Cryptographic Digest
- **SHA-256**: `86493bca32b106a04d01b9ebe592c971d4ddaa0b15750219f138abf0f24f1aad`
- **File size**: 5,398,697 bytes

### Notice & Redistribution Clearance
- Dual MIT / Apache-2.0 licenses permit redistribution in binary and source form. Both license texts are distributed alongside the artifact in packages and in the repository.
