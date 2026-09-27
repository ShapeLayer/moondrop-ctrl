# AI prompts

moondrop-ctrl is meant to be adjustable with an AI assistant (ChatGPT, Claude, Gemini, …) as well as by hand. The prompts here are the same ones the app uses.

## From the app (recommended)

1. Open **Settings → AI assistant**.
2. Pick a task, describe what you want in your own words, and choose which context to include (current EQ, device profile, HID device list, probe result).
3. Press **Copy prompt** and paste it into any AI chat.
4. Copy the AI's whole reply, paste it into **Paste the AI's reply**, and press **Load**. The app extracts the JSON block, validates it, and:
   - an EQ or preset → loads it into the editor (the device is untouched until you press Apply or Save);
   - a device profile → opens it in the profile editor, where you can probe it read-only and save it.

## By hand

Each file is a template. Replace every `{{PLACEHOLDER}}` with the matching information (the CLI can print most of it):

| Placeholder | Where to get it |
| --- | --- |
| `{{GOAL}}` | What you want, in your words |
| `{{LANGUAGE}}` | The language you want the answer in |
| `{{PROFILE_JSON}}`, `{{PROFILE_ID}}` | `moondrop-ctrl profile show PROFILE_ID` (`moondrop-ctrl profiles` lists IDs) |
| `{{PROFILE_SUMMARY}}`, `{{BAND_COUNT}}`, `{{FILTER_TYPES}}`, `{{GAIN_RANGE}}`, `{{FREQ_RANGE}}`, `{{Q_RANGE}}`, `{{GAIN_STEP}}`, `{{FREQ_STEP}}`, `{{Q_STEP}}` | From the profile's `protocol.bands`, `protocol.filter_codes`, `protocol.band_encoding` (each field's `step`), and `limits` |
| `{{EQ_JSON}}` | `moondrop-ctrl eq read` |
| `{{HID_DEVICES}}` | `moondrop-ctrl hid list` (or `--json`) |
| `{{PROBE}}` | `moondrop-ctrl probe PROFILE_ID_OR_FILE` |
| `{{PROFILE_SCHEMA}}` | [`schemas/profile.schema.json`](../../schemas/profile.schema.json) |
| `{{APP_VERSION}}`, `{{PLATFORM}}`, `{{CONNECTION}}`, `{{STATUS}}`, `{{SETTINGS}}` | `moondrop-ctrl --help` (version), your OS, `moondrop-ctrl status`, `moondrop-ctrl settings` |

Save the AI's JSON to a file and load it with `moondrop-ctrl profile set ID FIELD VALUE` for single-field fixes, or `moondrop-ctrl eq import FILE` (EQ, temporary until `--commit`), `moondrop-ctrl preset import FILE`, or `moondrop-ctrl profile import FILE`.

| Template | Use it to |
| --- | --- |
| [`eq-preset.md`](eq-preset.md) | Design or adjust an EQ (a sound goal, a target curve, a quieter preset, …) |
| [`device-profile.md`](device-profile.md) | Add support for another Moondrop DSP model |
| [`troubleshoot.md`](troubleshoot.md) | Diagnose connection or apply problems |

For coding agents working on this repository, see [`AGENTS.md`](../../AGENTS.md).
