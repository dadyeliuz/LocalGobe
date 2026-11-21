# AIR / ANE Compatibility Layer

Mogobe Android 1.4.7 (`20160725-android-1.4.7`) is an Adobe AIR mobile application
(`air.mogobe.mogoTab.IL`) that expects:

1. Adobe AIR runtime APIs (`playerRuntime: "air"` in Ruffle).
2. `flash.text.StageText` and `flash.text.StageTextInitOptions` for mobile text input.
3. `com.freshplanet.nativeExtensions.AirNetworkInfo` reporting active connectivity.
4. ActionScript interface libraries (`library.swf`) for 11 bundled ANEs preloaded into
   `ApplicationDomain.currentDomain` prior to loading the unmodified `MogobeTabIL.swf`.

## Architecture

Original Mogobe SWFs are never modified. Instead, LocalGobe provides clean-room
ActionScript 3 compatibility shims in `src/compatibility/air/as3/`:

- `AirBootstrap.as` — loads shims and APK-extracted ANE `library.swf`s into
  `ApplicationDomain.currentDomain`, then loads `/game/MogobeTabIL.swf`.
- `StageText.as` — clean-room `StageText` backed by an AVM2 `TextField`.
- `StageTextInitOptions.as` — clean-room options class.
- `AirNetworkInfo.as` & `NativeNetworkInterface.as` — clean-room network connectivity stub.

Compiled shim binaries are placed in `data/runtime/air/` (gitignored) via
`npm run build:air-shims` and served under `/runtime/air/*.swf`.
