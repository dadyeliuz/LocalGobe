# Third-Party Notices

LocalGobe is original preservation software licensed under the MIT License (see `LICENSE`).
It does not include, redistribute, or claim ownership over any copyrighted Mogobe game assets,
APKs, SWFs, rooms, items, artwork, or audio.

---

## 1. Electron Framework & Node.js

LocalGobe packages an Electron desktop runtime for Windows:

- **Electron**: MIT License, Copyright (c) Electron contributors, OpenJS Foundation.
  Full notice: Distributed as `LICENSE.electron.txt` in release packages.
- **Chromium**: BSD 3-Clause, LGPL 2.1+, Apache 2.0, and other permissive licenses.
  Full notices: Distributed as `LICENSES.chromium.html` in release packages.
- **Node.js**: MIT License, Copyright (c) Node.js contributors, Joyent, Inc. and other contributors.

---

## 2. Ruffle (Flash Player Emulator)

LocalGobe runs user-provided SWF content using a build of **Ruffle**:

- Upstream project: https://github.com/ruffle-rs/ruffle
- Upstream commit: `edef34c136f318f5c03c339d48ea527899864e53`
- License: Dual-licensed under MIT License and Apache-2.0
- Full license texts: `ruffle/LICENSE_MIT` (or `LICENSE_MIT_RUFFLE`) and `ruffle/LICENSE_APACHE` (or `LICENSE_APACHE_RUFFLE`)
- Copyright: (c) 2019+ Ruffle LLC and contributors

---

## 3. Fonts

- **Arimo**: SIL Open Font License, Version 1.1 (OFL-1.1), Copyright (c) 2010–2013 Steve Matteson.
  License text: `runtime/fonts/OFL.txt`
- **Rubik**: SIL Open Font License, Version 1.1 (OFL-1.1), Copyright (c) 2015 Hubert & Fischer, Meir Sadan, Cyreal.

---

## 4. Build Toolchain Assets (ActionScript 3 Compilation)

Used strictly for compiling clean-room ActionScript 3 shims during build:

- **asc.jar** (ActionScript 3 Compiler):
  - Upstream project: Apache Flex SDK / Ruffle toolchain (`tools/asc/asc.jar`)
  - License: Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0)
  - NOTICE: This product includes software developed at The Apache Software Foundation (http://www.apache.org/).

- **playerglobal_import.abc** (AVM2 API Import Catalog):
  - Upstream project: Ruffle (`core/build_playerglobal`)
  - License: Dual-licensed under MIT License and Apache License, Version 2.0
  - Generated entirely from Ruffle's open-source ActionScript definitions in `core/src/avm2/globals/`.
  - No Adobe PlayerGlobal, AIR SDK, or Flash Player SDK binary was used as input.

See `docs/TOOLCHAIN_PROVENANCE.md` for cryptographic digests and reproduction procedures.

---

## 5. Clean-Room Compatibility Shims

The ActionScript 3 compatibility shims under `src/compatibility/air/as3/` are original
clean-room implementations written specifically for LocalGobe and licensed under the MIT License.
When compiled locally with an ActionScript 3 compiler (such as Apache Flex / ASC),
compiled binaries (`airbootstrap.swf`, `stage_text_shim.swf`, etc.) contain only LocalGobe-authored
shim code and are covered by the MIT License.

---

## 6. npm Dependencies

- `@fontsource-variable/rubik` — SIL Open Font License 1.1 (OFL-1.1)
- `vite` — MIT License
- `typescript` — Apache-2.0 License
- `ws` — MIT License
- `@types/node`, `@types/ws` — MIT License
