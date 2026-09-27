//! The user's data folder, shared by the app and the CLI:
//!
//! ```text
//! <home>/settings.json      preferred profile, backup folder, snapshot capture
//! <home>/profiles/*.json    user device profiles (a built-in ID here overrides the built-in)
//! <home>/presets/*.json     user presets
//! <home>/snapshots/*.json   EQ captured the first time each model was connected
//! ```
//!
//! `<home>` is `$MOONDROP_CTRL_HOME`, else the OS config folder (`~/Library/Application
//! Support/moondrop-ctrl`, `%APPDATA%\moondrop-ctrl`, `~/.config/moondrop-ctrl`).

use crate::presets::{self, Preset, PresetEq};
use crate::profiles::{self, Profile};
use crate::protocol::{EqState, Error, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const HOME_ENV: &str = "MOONDROP_CTRL_HOME";
const SNAPSHOT_PREFIX: &str = "original-";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    /// Use this profile instead of detecting the device by its USB IDs.
    #[serde(default)]
    pub profile: Option<String>,
    /// Where EQ backups are written before every change.
    #[serde(default)]
    pub backup_dir: Option<PathBuf>,
    /// Save the EQ found the first time a model is connected, as a restorable snapshot.
    #[serde(default = "yes")]
    pub capture_original: bool,
}
fn yes() -> bool {
    true
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            profile: None,
            backup_dir: None,
            capture_original: true,
        }
    }
}

#[derive(Debug, Copy, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Builtin,
    User,
    Snapshot,
}

#[derive(Debug, Clone, Serialize)]
pub struct Entry<T> {
    #[serde(flatten)]
    pub item: T,
    pub source: Source,
    pub path: Option<PathBuf>,
    /// A user file with the same ID as a built-in, which it replaces.
    pub overrides_builtin: bool,
}

/// A file in the data folder that could not be used.
#[derive(Debug, Clone, Serialize)]
pub struct FileIssue {
    pub path: PathBuf,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Listing<T> {
    pub items: Vec<Entry<T>>,
    pub issues: Vec<FileIssue>,
}

pub struct Library {
    home: PathBuf,
}

impl Library {
    pub fn default_home() -> PathBuf {
        if let Some(home) = std::env::var_os(HOME_ENV).filter(|v| !v.is_empty()) {
            return PathBuf::from(home);
        }
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("moondrop-ctrl")
    }
    pub fn new(home: impl Into<PathBuf>) -> Self {
        Self { home: home.into() }
    }
    pub fn open_default() -> Self {
        Self::new(Self::default_home())
    }
    pub fn home(&self) -> &Path {
        &self.home
    }
    fn dir(&self, name: &str) -> PathBuf {
        self.home.join(name)
    }
    fn settings_path(&self) -> PathBuf {
        self.home.join("settings.json")
    }

    // Settings

    /// Missing file: defaults. Unreadable file: an error, so a typo is not silently ignored.
    pub fn settings(&self) -> Result<Settings> {
        match fs::read(self.settings_path()) {
            Ok(data) => serde_json::from_slice(&data).map_err(|e| {
                Error::Invalid(format!("{}: {e}", self.settings_path().display()))
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
            Err(e) => Err(io_error(&self.settings_path(), e)),
        }
    }
    pub fn save_settings(&self, settings: &Settings) -> Result<()> {
        if let Some(id) = &settings.profile {
            self.find_profile(id)?;
        }
        write_json(&self.settings_path(), settings)
    }
    pub fn default_backup_dir() -> PathBuf {
        dirs::document_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Moondrop Ctrl Backups")
    }
    pub fn backup_dir(&self) -> PathBuf {
        self.settings()
            .ok()
            .and_then(|s| s.backup_dir)
            .unwrap_or_else(Self::default_backup_dir)
    }

    // Profiles

    pub fn profiles(&self) -> Listing<Profile> {
        let mut items: Vec<Entry<Profile>> = profiles::BUILTIN
            .iter()
            .map(|p| Entry {
                item: p.clone(),
                source: Source::Builtin,
                path: None,
                overrides_builtin: false,
            })
            .collect();
        let mut issues = Vec::new();
        for (path, text) in json_files(&self.dir("profiles"), &mut issues) {
            match Profile::from_json(&text) {
                Ok(profile) => insert(&mut items, &mut issues, profile, path, |p| &p.id),
                Err(e) => issues.push(FileIssue {
                    path,
                    message: e.to_string(),
                }),
            }
        }
        Listing { items, issues }
    }
    /// Every usable profile, built-in and user.
    pub fn profile_list(&self) -> Vec<Profile> {
        self.profiles().items.into_iter().map(|e| e.item).collect()
    }
    pub fn find_profile(&self, id: &str) -> Result<Profile> {
        self.profile_list()
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| Error::Invalid(format!("unknown profile: {id}")))
    }
    /// Save as a user profile, replacing a user profile with the same ID.
    pub fn save_profile(&self, profile: &Profile) -> Result<PathBuf> {
        profile.validate()?;
        let path = self
            .profiles()
            .items
            .into_iter()
            .find(|e| e.item.id == profile.id && e.source == Source::User)
            .and_then(|e| e.path)
            .unwrap_or_else(|| self.dir("profiles").join(format!("{}.json", profile.id)));
        write_text(&path, &profile.to_json()?)?;
        Ok(path)
    }
    pub fn delete_profile(&self, id: &str) -> Result<()> {
        let entry = self
            .profiles()
            .items
            .into_iter()
            .find(|e| e.item.id == id && e.source == Source::User)
            .ok_or_else(|| Error::Invalid(format!("{id} is not a user profile")))?;
        let path = entry.path.expect("user entries have a path");
        fs::remove_file(&path).map_err(|e| io_error(&path, e))
    }

    // Presets

    pub fn presets(&self) -> Listing<Preset> {
        let mut items: Vec<Entry<Preset>> = presets::BUILTIN
            .iter()
            .map(|p| Entry {
                item: p.clone(),
                source: Source::Builtin,
                path: None,
                overrides_builtin: false,
            })
            .collect();
        let mut issues = Vec::new();
        for (path, text) in json_files(&self.dir("presets"), &mut issues) {
            match Preset::from_json(&text) {
                Ok(p) if p.id.starts_with(SNAPSHOT_PREFIX) => issues.push(FileIssue {
                    path,
                    message: format!("preset IDs starting with {SNAPSHOT_PREFIX} are reserved for snapshots"),
                }),
                Ok(p) => insert(&mut items, &mut issues, p, path, |p| &p.id),
                Err(e) => issues.push(FileIssue {
                    path,
                    message: e.to_string(),
                }),
            }
        }
        for (path, text) in json_files(&self.dir("snapshots"), &mut issues) {
            match Preset::from_json(&text) {
                Ok(item) => items.push(Entry {
                    item,
                    source: Source::Snapshot,
                    path: Some(path),
                    overrides_builtin: false,
                }),
                Err(e) => issues.push(FileIssue {
                    path,
                    message: e.to_string(),
                }),
            }
        }
        Listing { items, issues }
    }
    pub fn find_preset(&self, id: &str) -> Result<Preset> {
        self.presets()
            .items
            .into_iter()
            .map(|e| e.item)
            .find(|p| p.id == id)
            .ok_or_else(|| Error::Invalid(format!("unknown preset: {id}")))
    }
    pub fn save_preset(&self, preset: &Preset) -> Result<PathBuf> {
        preset.validate()?;
        if preset.id.starts_with(SNAPSHOT_PREFIX) {
            return Err(Error::Invalid(format!(
                "preset IDs starting with {SNAPSHOT_PREFIX} are reserved for snapshots"
            )));
        }
        let path = self
            .presets()
            .items
            .into_iter()
            .find(|e| e.item.id == preset.id && e.source == Source::User)
            .and_then(|e| e.path)
            .unwrap_or_else(|| self.dir("presets").join(format!("{}.json", preset.id)));
        write_text(&path, &preset.to_json()?)?;
        Ok(path)
    }
    /// Deletes a user preset or a snapshot.
    pub fn delete_preset(&self, id: &str) -> Result<()> {
        let entry = self
            .presets()
            .items
            .into_iter()
            .find(|e| e.item.id == id && e.source != Source::Builtin)
            .ok_or_else(|| Error::Invalid(format!("{id} is not a user preset or snapshot")))?;
        let path = entry.path.expect("user entries have a path");
        fs::remove_file(&path).map_err(|e| io_error(&path, e))
    }

    // Original snapshots

    pub fn snapshot_id(profile_id: &str) -> String {
        format!("{SNAPSHOT_PREFIX}{profile_id}")
    }
    pub fn original(&self, profile_id: &str) -> Result<Preset> {
        self.find_preset(&Self::snapshot_id(profile_id)).map_err(|_| {
            Error::Invalid(format!(
                "no original snapshot for {profile_id}; one is saved the first time the device is read"
            ))
        })
    }
    /// Save `state` as the original snapshot of `profile` unless one exists or capture is off.
    /// Returns the new file's path.
    pub fn capture_original(&self, profile: &Profile, state: &EqState) -> Result<Option<PathBuf>> {
        if !self.settings().map(|s| s.capture_original).unwrap_or(true) {
            return Ok(None);
        }
        let path = self.dir("snapshots").join(format!("{}.json", profile.id));
        if path.exists() {
            return Ok(None);
        }
        let preset = Preset {
            id: Self::snapshot_id(&profile.id),
            title: format!("Original · {}", profile.title),
            note: format!(
                "EQ found on this device when it was first connected ({}). Device-specific, not a factory preset.",
                today()
            ),
            profiles: vec![profile.id.clone()],
            eq: PresetEq::from(state),
        };
        write_text(&path, &preset.to_json()?)?;
        Ok(Some(path))
    }
}

/// Add `item`, replacing a built-in with the same ID; a second user file with one ID is an issue.
fn insert<T>(
    items: &mut Vec<Entry<T>>,
    issues: &mut Vec<FileIssue>,
    item: T,
    path: PathBuf,
    id: impl Fn(&T) -> &String,
) {
    match items.iter().position(|e| id(&e.item) == id(&item)) {
        Some(i) if items[i].source == Source::Builtin => {
            items[i] = Entry {
                item,
                source: Source::User,
                path: Some(path),
                overrides_builtin: true,
            }
        }
        Some(i) => issues.push(FileIssue {
            message: format!(
                "duplicate id {}; already defined in {}",
                id(&item),
                items[i].path.as_deref().unwrap_or(Path::new("?")).display()
            ),
            path,
        }),
        None => items.push(Entry {
            item,
            source: Source::User,
            path: Some(path),
            overrides_builtin: false,
        }),
    }
}

fn json_files(dir: &Path, issues: &mut Vec<FileIssue>) -> Vec<(PathBuf, String)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("json")))
        .collect();
    paths.sort();
    paths
        .into_iter()
        .filter_map(|path| match fs::read_to_string(&path) {
            Ok(text) => Some((path, text)),
            Err(e) => {
                issues.push(FileIssue {
                    message: e.to_string(),
                    path,
                });
                None
            }
        })
        .collect()
}

fn io_error(path: &Path, e: std::io::Error) -> Error {
    Error::Invalid(format!("{}: {e}", path.display()))
}

/// Write through a temporary file so a crash never leaves a half-written file.
pub fn write_text(path: &Path, text: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| io_error(dir, e))?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| io_error(&tmp, e))?;
    fs::rename(&tmp, path).map_err(|e| io_error(path, e))
}
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let text = serde_json::to_string_pretty(value).map_err(|e| Error::Invalid(e.to_string()))?;
    write_text(path, &(text + "\n"))
}

/// Today's UTC date as YYYY-MM-DD.
pub fn today() -> String {
    let days = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0) as i64;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + (m <= 2) as i64;
    format!("{y:04}-{m:02}-{d:02}")
}
