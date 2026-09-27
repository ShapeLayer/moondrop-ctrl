// Tauri shell around moondrop-core. Device I/O runs on a blocking worker thread and is
// serialized through one mutex, because a handle must not be used concurrently.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use moondrop_core::library::{self, Library, Listing, Settings};
use moondrop_core::ops::{self, HidEntry, ProbeReport};
use moondrop_core::presets::{Preset, PresetEq};
use moondrop_core::profiles::Profile;
use moondrop_core::protocol::{hex_bytes, parse_hex_bytes};
use moondrop_core::{EqState, Error, Result as CoreResult};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static DEVICE_LOCK: Mutex<()> = Mutex::new(());

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> CoreResult<T> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = DEVICE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        work()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

fn lib() -> Library {
    Library::open_default()
}

/// Open the configured device and, on first contact with a model, keep its EQ as a snapshot.
/// An EQ that does not decode (e.g. a profile being debugged) does not block opening.
fn open() -> CoreResult<(ops::Hardware, Option<PathBuf>)> {
    let lib = lib();
    let mut device = ops::open_configured(&lib)?;
    let snapshot = match device.read_eq() {
        Ok(state) => lib.capture_original(device.profile(), &state).unwrap_or(None),
        Err(_) => None,
    };
    Ok((device, snapshot))
}

#[derive(Serialize)]
struct ReadReport {
    profile: Profile,
    eq: EqState,
    /// Set when this read saved the model's original snapshot.
    snapshot: Option<String>,
}

#[derive(Serialize)]
struct ApplyReport {
    profile: Profile,
    changed: bool,
    committed: bool,
    backup: Option<String>,
}

#[derive(Serialize)]
struct SettingsInfo {
    settings: Settings,
    home: String,
    backup_dir: String,
    default_backup_dir: String,
}

fn display(p: &Path) -> String {
    p.display().to_string()
}

/// Profile of the connected device, or `None` when no supported device is found.
#[tauri::command]
async fn device_profile() -> Option<Profile> {
    blocking(|| ops::open_configured(&lib()).map(|d| d.profile().clone()))
        .await
        .ok()
}

/// The user's preferred system languages, most preferred first (BCP 47, e.g. "ko-KR").
/// Read natively because a macOS webview reports the bundle's language, not the system's.
#[tauri::command]
fn system_locales() -> Vec<String> {
    sys_locale::get_locales().collect()
}

#[tauri::command]
async fn read_eq() -> Result<ReadReport, String> {
    blocking(|| {
        let (mut device, snapshot) = open()?;
        Ok(ReadReport {
            eq: device.read_eq()?,
            profile: device.profile().clone(),
            snapshot: snapshot.as_deref().map(display),
        })
    })
    .await
}

#[tauri::command]
async fn apply_eq(state: EqState, commit: bool) -> Result<ApplyReport, String> {
    blocking(move || {
        let (device, _) = open()?;
        let profile = device.profile().clone();
        drop(device);
        let open = || ops::open_profile(&profile);
        let outcome = ops::apply_verified(open, &state, commit, &lib().backup_dir())?;
        Ok(ApplyReport {
            profile,
            changed: outcome.changed,
            committed: outcome.committed,
            backup: outcome.backup.as_deref().map(display),
        })
    })
    .await
}

#[tauri::command]
async fn export_json(path: String, state: PresetEq) -> Result<(), String> {
    blocking(move || ops::write_json(Path::new(&path), &state, true)).await
}

/// EQ, backup, or preset file → editor EQ.
#[tauri::command]
async fn import_json(path: String) -> Result<PresetEq, String> {
    blocking(move || ops::read_json(Path::new(&path))).await
}

// Profiles

#[tauri::command]
async fn list_profiles() -> Result<Listing<Profile>, String> {
    blocking(|| Ok(lib().profiles())).await
}

#[tauri::command]
async fn save_profile(profile: Profile) -> Result<String, String> {
    blocking(move || lib().save_profile(&profile).map(|p| display(&p))).await
}

#[tauri::command]
async fn delete_profile(id: String) -> Result<(), String> {
    blocking(move || lib().delete_profile(&id)).await
}

/// Validates a profile the editor built, without saving it.
#[tauri::command]
fn check_profile(profile: Profile) -> Result<(), String> {
    profile.validate().map_err(|e| e.to_string())
}

#[tauri::command]
async fn import_profile(path: String) -> Result<Profile, String> {
    blocking(move || {
        let text = std::fs::read_to_string(&path).map_err(|e| Error::Invalid(e.to_string()))?;
        Profile::from_json(&text)
    })
    .await
}

#[tauri::command]
async fn export_profile(path: String, profile: Profile) -> Result<(), String> {
    blocking(move || {
        profile.validate()?;
        library::write_text(Path::new(&path), &profile.to_json()?)
    })
    .await
}

#[tauri::command]
async fn hid_devices() -> Result<Vec<HidEntry>, String> {
    blocking(|| ops::hid_devices(&lib().profile_list())).await
}

/// Read-only register check of `profile` against the connected device.
#[tauri::command]
async fn probe(profile: Profile) -> Result<ProbeReport, String> {
    blocking(move || {
        profile.validate()?;
        let mut device = ops::open_profile(&profile)?;
        Ok(ops::probe(&mut device))
    })
    .await
}

// Presets

#[tauri::command]
async fn list_presets() -> Result<Listing<Preset>, String> {
    blocking(|| Ok(lib().presets())).await
}

#[tauri::command]
async fn save_preset(preset: Preset) -> Result<String, String> {
    blocking(move || lib().save_preset(&preset).map(|p| display(&p))).await
}

#[tauri::command]
async fn delete_preset(id: String) -> Result<(), String> {
    blocking(move || lib().delete_preset(&id)).await
}

#[tauri::command]
async fn import_preset(path: String) -> Result<Preset, String> {
    blocking(move || {
        let text = std::fs::read_to_string(&path).map_err(|e| Error::Invalid(e.to_string()))?;
        Preset::from_json(&text)
    })
    .await
}

#[tauri::command]
async fn export_preset(path: String, preset: Preset) -> Result<(), String> {
    blocking(move || {
        preset.validate()?;
        library::write_text(Path::new(&path), &preset.to_json()?)
    })
    .await
}

// Settings

fn settings_info(lib: &Library) -> CoreResult<SettingsInfo> {
    Ok(SettingsInfo {
        settings: lib.settings()?,
        home: display(lib.home()),
        backup_dir: display(&lib.backup_dir()),
        default_backup_dir: display(&Library::default_backup_dir()),
    })
}

#[tauri::command]
async fn get_settings() -> Result<SettingsInfo, String> {
    blocking(|| settings_info(&lib())).await
}

#[tauri::command]
async fn set_settings(settings: Settings) -> Result<SettingsInfo, String> {
    blocking(move || {
        let lib = lib();
        lib.save_settings(&settings)?;
        settings_info(&lib)
    })
    .await
}

/// Show a folder in Finder / Explorer / the file manager, creating it first.
#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener)
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// Expert tools: no backups.

#[tauri::command]
async fn register_read(register: u8) -> Result<String, String> {
    blocking(move || Ok(hex_bytes(&open()?.0.read_register(register)?))).await
}

#[tauri::command]
async fn register_write(register: u8, value: String) -> Result<(), String> {
    blocking(move || {
        // The device checks the length against the profile's value length.
        open()?.0.write_register(register, &parse_hex_bytes(&value)?)
    })
    .await
}

#[tauri::command]
async fn raw_transact(report: String) -> Result<String, String> {
    blocking(move || {
        let request = parse_hex_bytes(&report)?;
        let (mut device, _) = open()?;
        let expected = device.profile().protocol.frame.length;
        if request.len() != expected {
            return Err(Error::Invalid(format!(
                "the profile's reports are {expected} bytes, got {}",
                request.len()
            )));
        }
        Ok(hex_bytes(&device.raw_command(&request)?))
    })
    .await
}

#[tauri::command]
async fn udev_rules() -> Result<String, String> {
    blocking(|| Ok(ops::udev_rules(&lib().profile_list()))).await
}

#[tauri::command]
async fn pregain_read() -> Result<i8, String> {
    blocking(|| open()?.0.read_pregain_db()).await
}

#[tauri::command]
async fn pregain_write(db: i8) -> Result<(), String> {
    blocking(move || open()?.0.write_pregain_db(db)).await
}

#[tauri::command]
async fn commit() -> Result<(), String> {
    blocking(|| open()?.0.commit()).await
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            device_profile,
            system_locales,
            read_eq,
            apply_eq,
            export_json,
            import_json,
            list_profiles,
            save_profile,
            delete_profile,
            check_profile,
            import_profile,
            export_profile,
            hid_devices,
            probe,
            list_presets,
            save_preset,
            delete_preset,
            import_preset,
            export_preset,
            get_settings,
            set_settings,
            reveal,
            register_read,
            register_write,
            raw_transact,
            udev_rules,
            pregain_read,
            pregain_write,
            commit
        ])
        .run(tauri::generate_context!())
        .expect("error while running Moondrop Ctrl");
}
