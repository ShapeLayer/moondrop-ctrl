# Guide for coding agents

This file is for AI coding agents (Claude Code, Codex, Cursor, …) changing this repository. End users who want an AI to tune their EQ or write a device profile should use the prompts in `docs/ai/` instead.

## What the project is

moondrop-ctrl edits the DSP EQ of Moondrop earphones over USB HID. The core is **profile-driven**: nothing about a specific model may be hard-coded outside a profile JSON file. The CHU II DSP (`chu2-dsp`) is the only hardware-verified profile.

## Layout

- `crates/moondrop-core/src/protocol.rs` — `Transport` (variable-length reports), `Band` (natural units, canonical to 6 decimals; reads 0.2 fixed-point fields), `EqState` (`enabled` + bands), `FilterType`, `Device<T: Transport>` (read/apply with quantization, readback and rollback, commit, pregain). Report layout, addresses, commands, encoding, codes and timing all come from `device.profile()`.
- `crates/moondrop-core/src/profiles.rs` — `Profile` (serde, hex strings, defaults for optional sections), structural validation, report building/parsing (`request`, `response_value`), band encode/decode/quantize driven by `band_encoding` (field offsets, sizes, steps, signedness, byte order) over `registers_per_band` registers of `frame.value_length` bytes, limit checks; built-ins from `crates/moondrop-core/profiles/*.json` via `BUILTIN_SOURCES`.
- `crates/moondrop-core/src/presets.rs` — `Preset`, `PresetEq` (colors are display-only), built-ins from `presets/*.json`; reads 0.2 files with `slot`.
- `crates/moondrop-core/src/library.rs` — the data folder: settings, user profiles/presets (a user file with a built-in ID overrides it), original snapshots, backup folder.
- `crates/moondrop-core/src/ops.rs` — open by profile / auto-detect / settings, HID listing, read-only `probe`, `apply_verified` (backup → apply → optional commit → reconnect verify), EQ files.
- `crates/moondrop-core/src/native.rs` + `native/macos_hid.c` — built-in transports (macOS IOHIDManager; hidapi on Windows/Linux).
- `crates/moondrop-ffi` — C ABI v2 (`include/moondrop_ctrl.h`); keep the header, `tests/c_abi_smoke.c`, and `md_abi_version` in step.
- `crates/moondrop-cli` — `moondrop-ctrl`.
- `app/src-tauri/src/main.rs` — Tauri commands; device I/O is serialized through `DEVICE_LOCK` on a blocking thread.
- `app/src` — TypeScript Web Components. `store.ts` (editor state, active profile → limits/filter types), `api.ts` (Tauri bridge + browser mock backed by the same JSON files), `catalog.ts`, `prompts.ts` (fills `docs/ai/*.md`), `components/settings-panel.ts` (all setup UI), `locales/*.json`.
- `docs/ai/` — AI prompt templates with `{{PLACEHOLDERS}}`, shared by the app and manual use. `schemas/` — JSON Schemas.

## Commands

```sh
cargo test --workspace
cargo clippy --workspace --all-targets
cargo check -p moondrop-core -p moondrop-cli -p moondrop-ffi --target x86_64-pc-windows-msvc   # if the target is installed
./scripts/test-c-abi.sh
cd app && npm run build        # type-checks, including locale key parity
cd app && npm run dev          # browser preview with a mock device
```

## Rules

- **Hardware safety.** Never run commands that write to a connected device (`eq import|band|remove|on|off`, `preset apply`, `restore-original`, `commit`, `raw write|transact`, `pregain write`, `device-self-test`, or the app's Apply/Save) unless the user explicitly asks. Read-only commands (`status`, `eq read`, `hid list`, `probe`, `profiles`) are fine. Tests must use fake transports (see `crates/moondrop-core/tests/core.rs`).
- **No model constants in code.** New behaviour that differs between models goes into `Profile` — with a serde default equal to the CHU II DSP's behaviour, validation, a schema entry in `schemas/profile.schema.json`, a form field in `settings-panel.ts` `SECTIONS`, the TypeScript `Profile` type, the `docs/ai/device-profile.md` field list, and strings in all locales — never an `if model == …`. Tests should cover it with a non-CHU profile (see `other_model()` and `a_packed_big_endian_layout_with_one_byte_registers` in `core.rs`, and `other_layout()` in `c_abi_smoke.c`).
- **Keep formats compatible.** Old EQ/preset files must keep loading. If a profile field is added, give it a serde default so existing profile files stay valid.
- **Unverified means unverified.** Do not mark a profile `verified` or claim support for a model without hardware confirmation from the user.
- **UI strings** go in `app/src/locales/ko.json` (reference), `en.json`, and `ja.json`; `npm run build` fails on a missing key.
- **Prompts**: when changing what the app knows (limits, filter types, file format), update the matching `docs/ai/*.md` template and its placeholder table in `docs/ai/README.md`, and `prompts.ts` if a placeholder is added.

## Recipes

- **Add a built-in profile**: `crates/moondrop-core/profiles/<id>.json` → add `include_str!` to `BUILTIN_SOURCES` → `cargo test` (`builtins_are_valid`) → README device table.
- **Add a built-in preset**: `crates/moondrop-core/presets/<id>.json` with `profiles` set → `BUILTIN_SOURCES` in `presets.rs` → optional translated title/note keys `preset.<id>.title|note` in the locales. The browser mock imports built-ins in `app/src/api.ts`; add new files there too.
- **Add a Tauri command**: function + `generate_handler!` in `app/src-tauri/src/main.rs`, a method on `Api` in `app/src/api.ts` with both the Tauri and the mock implementation, and a dialog permission in `app/src-tauri/capabilities/default.json` if it opens one.
