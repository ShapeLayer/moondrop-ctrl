# moondrop-ctrl

An open-source desktop app, command line tool, and C library for editing the built-in DSP equalizer of Moondrop earphones over USB.

Everything model-specific lives in a JSON **device profile** — USB IDs, report layout, command bytes, register map, value encoding, filter codes, value ranges, and timing — and the library, the CLI, the C ABI, and the app all read it. Another Moondrop DSP model is supported by adding a profile (in the app, with the CLI, or as a file), without changing code. Every setup step has a control in the app, and an AI assistant (any chat AI) can help design EQ presets or write a profile for a new model.

> **Unofficial.** Not affiliated with or endorsed by Moondrop. The protocol was learned from the [chu2-studio](https://github.com/jcharvet/chu2-studio) project and checked against real hardware. Every change is backed up first and temporary changes are undone by unplugging, but you use this at your own risk.

## Device support

| Model | Profile | Status |
| --- | --- | --- |
| MOONDROP CHU II DSP | `chu2-dsp` (built in) | Verified on macOS: read, write with readback, save (commit) with reconnect check. Pregain register reads/writes; audible effect unverified. |
| Other Moondrop DSP models | Add one in **Settings → Device profiles** | Likely the same protocol with other USB IDs or band layouts; check with the read-only probe. Please contribute profiles that work (see [Contributing](#contributing)). |

| Platform | HID transport | Status |
| --- | --- | --- |
| macOS | IOHIDManager | Hardware-verified |
| Windows | hidapi | Builds; not yet verified on hardware |
| Linux | hidapi (hidraw) | Builds; not yet verified on hardware. For non-root access install a udev rule: [`scripts/linux/70-moondrop-ctrl.rules`](scripts/linux/70-moondrop-ctrl.rules) covers the built-in profiles; `moondrop-ctrl udev-rules` (or Settings → General) prints one covering your own profiles too. |
| iOS, Android, others | Your app's own USB/HID code through the C ABI callback | See [Integration](#integration-c-abi) |

## Build and run

Requirements: Rust (stable), Node.js 20+, and the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/) for your OS. On Linux, hidapi also needs `libudev-dev` (Debian/Ubuntu) or `systemd-devel` (Fedora).

```sh
cd app && npm install
npm run tauri dev      # desktop app with hot reload
npm run dev            # browser-only preview with a mock device (http://localhost:1420)
```

Release builds:

```sh
cargo test --workspace
./scripts/test-c-abi.sh        # builds the C library and runs the C smoke test
./scripts/build-macos-app.sh   # target/release/bundle/macos/Moondrop Ctrl.app
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1            # tests, CLI, C library, NSIS + MSI installers
powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -SkipApp   # CLI and moondrop_ctrl.lib only
```

## Using the app

On launch the app reads the connected device (read only) and shows its EQ as a graph. The curve is modelled from RBJ biquads at 48 kHz; it is a model, not a measurement.

- **Editing**: drag a point for frequency and gain (Shift locks an axis), scroll for Q, double-click for 0 dB. The cards under the graph accept typed values (`2.5k` works), arrow keys (Shift ×10), or dragging the label. **Add band** or a double-click on empty graph space adds a band, up to the device's slot count; × or Delete removes one. Click a band's number to pick its color (colors travel with presets and files, never to the device).
- **Apply** backs up the device EQ, writes the editor EQ, and reads it back. It is temporary: unplugging restores the saved EQ. **Save to device** also commits; the device restarts and the app verifies the EQ after it reconnects. The footer shows whether the editor matches the device.
- **Undo/redo**: ⌘Z / ⇧⌘Z (macOS), Ctrl+Z / Ctrl+Y (Windows, Linux).
- **Languages**: Korean, English, Japanese; follows the system unless you pick one (toolbar or View → Language).

### Settings (⌘, / Ctrl+,)

| Tab | What you can do |
| --- | --- |
| **Device** | See the connected device and its profile. Choose automatic detection or force a profile. List the HID devices on the computer (VID:PID, usage page, which profile matches) and create a profile from any of them. |
| **Device profiles** | Edit every profile field in a form or as JSON, run a **read-only probe** against the connected device, save, duplicate, import/export, delete, or make it the profile always used. Saving a built-in creates a user copy that overrides it. |
| **Presets** | Load, export, delete, and import presets; save the editor's EQ as a preset (optionally only for the current model). |
| **AI assistant** | Build a complete prompt for any chat AI (design an EQ, support a new model, troubleshoot), copy it, then paste the AI's reply back. The app extracts the JSON, checks it against the device's limits, and loads it into the editor or the profile editor. Nothing is sent to the device until you press Apply or Save. |
| **Advanced** | Read/write single registers, the experimental pregain register, raw reports in the profile's layout, and a bare commit. No backups; for experts. |
| **General** | Open the data folder, choose the backup folder, turn automatic original snapshots on or off, and get Linux udev rules for all known profiles. |

## Device profiles

A profile ([schema](schemas/profile.schema.json), [example](crates/moondrop-core/profiles/chu2-dsp.json)) describes:

| Section | What it sets |
| --- | --- |
| `usb` | Vendor/product ID, and the HID usage page/usage when a device has several interfaces |
| `protocol.frame` | Report length; the positions of register, command and value; the value length; how many leading bytes a response echoes |
| `protocol` commands | Report ID, read/write/commit commands, commit register, optional pregain register |
| `protocol.eq_switch` | EQ on/off register, its read argument and on/off values — or `null` when the device has none |
| `protocol.bands` | Slot count, first register, stride, registers per band |
| `protocol.band_encoding` | Byte order, and the offset, size, step and sign of gain, frequency, Q and filter code within a band's bytes |
| `protocol.filter_codes` | Device byte for peaking, low/high shelf, low/high pass, band pass, notch (`null` = unsupported) |
| `protocol.unused_band`, `timing` | Filler for empty slots; response and reconnect timeouts |
| `limits`, `dsp` | Gain/frequency/Q ranges; the sample rate the graph models |

Optional sections take the CHU II DSP's values when omitted, so older profile files stay valid. EQ and preset files store bands in natural units (`gain_db`, `frequency_hz`, `q`), so their resolution is whatever the device's encoding allows; files with the 0.2 fixed-point fields (`gain_tenths_db`, `q_thousandths`) are still read. The core validates every profile (registers within 0xFF, no overlapping report fields or registers, distinct filter codes, an inaudible unused band, values that fit their encoding) before it is used or saved.

## Supporting another Moondrop model

1. Connect the earphone and open **Settings → Device**. Find it in the USB device list and choose **Create profile…**. This copies the template profile (the closest verified one; choose it in **Device profiles**) with your device's IDs and marks it unverified.
2. In **Device profiles**, press **Probe (read-only)**. It reads the EQ switch and every band register the profile describes and decodes them without writing anything.
   - Everything decodes and matches what Moondrop's own app shows → the layout probably matches.
   - Timeouts, unexpected responses, or undecodable values → adjust the report layout, report ID, usage page, band count, register base, encoding, or filter codes. The **AI assistant → Support a new model** prompt includes the probe result and explains how to read it.
3. Save the profile, then in the main window make a small change and press **Apply** (temporary; the app asks for confirmation because the profile is unverified). Check that it reads back and sounds right.
4. Press **Save to device**. When it verifies after reconnect, tick **Verified on hardware** in the profile and save it.
5. Share it: export the profile and open a pull request adding it to [`crates/moondrop-core/profiles/`](crates/moondrop-core/profiles/).

The same steps work from the CLI: `hid list`, `profile new ID VID PID`, `profile set ID FIELD VALUE` (e.g. `protocol.bands.count 8`), `probe ID`, then `eq band … --profile ID --force`.

## AI assistance

The prompt templates the app uses are plain Markdown in [`docs/ai/`](docs/ai/) with `{{PLACEHOLDERS}}`, so they also work without the app (the [README there](docs/ai/README.md) lists where each value comes from):

- [`eq-preset.md`](docs/ai/eq-preset.md) — design or adjust an EQ within the device's limits
- [`device-profile.md`](docs/ai/device-profile.md) — write and validate a profile for a new model
- [`troubleshoot.md`](docs/ai/troubleshoot.md) — diagnose connection or save problems

The file formats have JSON Schemas: [`schemas/profile.schema.json`](schemas/profile.schema.json) and [`schemas/preset.schema.json`](schemas/preset.schema.json). Coding agents working on this repository should read [`AGENTS.md`](AGENTS.md).

## Data folder

Shared by the app and the CLI. The location is `$MOONDROP_CTRL_HOME`, or else:

| OS | Folder |
| --- | --- |
| macOS | `~/Library/Application Support/moondrop-ctrl` |
| Windows | `%APPDATA%\moondrop-ctrl` |
| Linux | `~/.config/moondrop-ctrl` |

```text
settings.json      forced profile (or auto), backup folder, snapshot capture
profiles/*.json    user profiles; a built-in ID here overrides the built-in
presets/*.json     user presets
snapshots/*.json   each model's EQ as found on first connection ("Original" preset)
```

Backups go to `~/Documents/Moondrop Ctrl Backups` unless changed. A backup is an EQ file that also names its profile; it can be imported like any preset. Preset and EQ files written by 0.2 (`"slot": 3/2`, fixed-point band fields) are still read.

## CLI

```sh
cargo run -p moondrop-cli -- --help
```

```sh
moondrop-ctrl status                              # profile, EQ, pregain (read only)
moondrop-ctrl eq export before.json
moondrop-ctrl preset apply chu2-quiet-18db        # temporary, until unplug
moondrop-ctrl preset apply chu2-quiet-18db --commit
moondrop-ctrl restore-original --commit           # the snapshot taken on first connection
moondrop-ctrl eq band 1 -6.0 1000 1.0 low         # edit or append a band (dB, Hz, Q)
moondrop-ctrl eq remove 5
moondrop-ctrl hid list                            # find VID:PID of an unknown model
moondrop-ctrl profile new my-model 0x31B2 0x0200  # copy the first verified profile
moondrop-ctrl profile set my-model protocol.bands.count 8
moondrop-ctrl probe my-model                      # read-only check (also takes a JSON file)
moondrop-ctrl profile import my-model.json
moondrop-ctrl settings profile my-model           # or: settings profile auto
moondrop-ctrl udev-rules                          # Linux rules for every known profile
moondrop-ctrl profiles --json                     # machine-readable output (scripts, AI tools)
```

Structured EQ changes are backed up first. `--commit` is explicit and is followed by a reconnect check. Writes with an unverified profile need `--force`. `--profile ID` overrides the configured profile for one command, `--home DIR` the data folder, and `--json` prints lists, `status`, and `settings` as JSON.

## Integration (C ABI)

`crates/moondrop-ffi` builds `libmoondrop_ctrl.a` (`moondrop_ctrl.lib` on Windows); the header is [`crates/moondrop-ffi/include/moondrop_ctrl.h`](crates/moondrop-ffi/include/moondrop_ctrl.h) (ABI version 2).

- `md_open_default()` opens the first connected device matching a built-in or user profile through the built-in transport. On macOS link with `-framework IOKit -framework CoreFoundation` (see `scripts/test-c-abi.sh`).
- Any other host implements `md_transport_v1.transact` — send the report (`report_len` bytes, the profile's frame length) to the device's HID interface, wait up to `timeout_ms` for the answer of the same length, return 0 — and calls `md_open_transport(&callbacks, "PROFILE_ID")` or `md_open_transport_json(&callbacks, profile_json)`. The commit command may restart the device before it answers; the callback can return the sent report as the acknowledgement and reopen the device to verify.
- `md_read_eq`, `md_apply_eq` (bands in natural units as `double`s, checked against the profile's limits and rounded to its encoding), and `md_commit` provide structured control; `md_read_register` / `md_write_register` (values of the profile's value length) and `md_raw_command` go lower. `md_profiles_json` / `md_presets_json` list every built-in and user profile and preset; `md_device_profile_json` returns the open device's profile. Calls on one handle must be serialized. Errors return -1; `md_last_error` describes them.

The Rust API exposes the same pieces directly: `Profile`, the `Transport` trait, `Device<T>`, `ops::probe`, and `ops::apply_verified`.

## Workspace layout

| Path | Role |
| --- | --- |
| `crates/moondrop-core` | Register protocol driven by `Profile`, HID transports (`native/macos_hid.c`, hidapi), built-in profiles and presets (`profiles/`, `presets/`), the data folder (`library`), backups, probe, and the backup → apply → commit → reconnect-verify workflow (`ops`). |
| `crates/moondrop-ffi` | C ABI. |
| `crates/moondrop-cli` | `moondrop-ctrl` command line tool. |
| `app/` | Tauri 2 desktop app. TypeScript + Web Components in `app/src`, Rust commands in `app/src-tauri`. |
| `docs/ai/` | AI prompt templates (used by the app and usable by hand). |
| `schemas/` | JSON Schemas for profiles and presets. |
| `data/device-snapshots/` | A reference register dump from one CHU II DSP. |

## Contributing

- **A profile for another model**: add `crates/moondrop-core/profiles/<id>.json`, list it in `BUILTIN_SOURCES` in `crates/moondrop-core/src/profiles.rs`, and describe in `notes` how it was verified. Set `verified` only after write, readback, and save were confirmed on the hardware.
- **Presets**: add `crates/moondrop-core/presets/<id>.json` (listed in `presets.rs`), scoped to the profiles it was made for.
- **Translations**: `app/src/locales/ko.json` is the reference; a key missing in another locale fails `npm run build`. Add a language by adding its file and listing it in `LANGUAGES` (`app/src/i18n.ts`), the Info.plist localizations, and the installer languages.
- Run `cargo test --workspace`, `./scripts/test-c-abi.sh`, and `npm run build` in `app/` before sending changes.

## License

MIT. See [LICENSE](LICENSE).
