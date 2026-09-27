//! Presets and the EQ file format: device band values plus a display color per band. Colors
//! never reach the device; they only travel with presets and JSON files. Built-in presets live
//! in `crates/moondrop-core/presets/`; user presets in the data folder's `presets/` directory.

use crate::profiles::Profile;
use crate::protocol::{enabled_from_file, Band, EqState, Error, Result};
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

/// One band in a preset or EQ file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PresetBand {
    #[serde(flatten)]
    pub band: Band,
    /// Display color as `#rrggbb`. Missing colors are chosen by the app.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// EQ as stored in presets and JSON files. Files from version 0.2 with `"slot": 3` (on) or
/// `2` (off) instead of `enabled` are still read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "PresetEqFile")]
pub struct PresetEq {
    pub enabled: bool,
    pub bands: Vec<PresetBand>,
}
#[derive(Deserialize)]
struct PresetEqFile {
    enabled: Option<bool>,
    slot: Option<u8>,
    bands: Vec<PresetBand>,
}
impl TryFrom<PresetEqFile> for PresetEq {
    type Error = String;
    fn try_from(f: PresetEqFile) -> std::result::Result<Self, String> {
        Ok(Self {
            enabled: enabled_from_file(f.enabled, f.slot)?,
            bands: f.bands,
        })
    }
}
impl PresetEq {
    /// Checks that do not depend on a device: colors are well formed.
    pub fn validate(&self) -> Result<()> {
        for color in self.bands.iter().filter_map(|b| b.color.as_deref()) {
            let hex = color.strip_prefix('#').unwrap_or("");
            if hex.len() != 6 || !hex.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err(Error::Invalid(format!(
                    "band color must be #rrggbb, got {color}"
                )));
            }
        }
        Ok(())
    }
    /// The device part, without colors.
    pub fn state(&self) -> EqState {
        EqState {
            enabled: self.enabled,
            bands: self.bands.iter().map(|b| b.band).collect(),
        }
    }
}
impl From<&EqState> for PresetEq {
    /// Device state without colors, e.g. for exporting what the device holds.
    fn from(state: &EqState) -> Self {
        Self {
            enabled: state.enabled,
            bands: state
                .bands
                .iter()
                .map(|&band| PresetBand { band, color: None })
                .collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Preset {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub note: String,
    /// Profile IDs this preset is meant for. Empty means any device whose limits it fits.
    #[serde(default)]
    pub profiles: Vec<String>,
    pub eq: PresetEq,
}
impl Preset {
    pub fn from_json(text: &str) -> Result<Self> {
        let preset: Preset = serde_json::from_str(text)
            .map_err(|e| Error::Invalid(format!("preset JSON: {e}")))?;
        preset.validate()?;
        Ok(preset)
    }
    pub fn to_json(&self) -> Result<String> {
        serde_json::to_string_pretty(self)
            .map(|s| s + "\n")
            .map_err(|e| Error::Invalid(e.to_string()))
    }
    pub fn validate(&self) -> Result<()> {
        let valid_id = !self.id.is_empty()
            && self.id.len() <= 64
            && self
                .id
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_');
        if !valid_id {
            return Err(Error::Invalid(
                "preset id must be 1-64 characters of a-z, 0-9, - and _".into(),
            ));
        }
        if self.title.trim().is_empty() {
            return Err(Error::Invalid("preset title is empty".into()));
        }
        self.eq.validate()
    }
    /// Whether this preset may be sent to a device with `profile`: it names the profile (or no
    /// profile at all) and fits its band count, limits and filter types.
    pub fn fits(&self, profile: &Profile) -> Result<()> {
        if !self.profiles.is_empty() && !self.profiles.contains(&profile.id) {
            return Err(Error::Invalid(format!(
                "preset {} is for {}, not {}",
                self.id,
                self.profiles.join(", "),
                profile.id
            )));
        }
        profile.validate_eq(&self.eq.state())
    }
}

/// Presets shipped with the library. Keep each file listed here.
const BUILTIN_SOURCES: &[&str] = &[
    include_str!("../presets/flat.json"),
    include_str!("../presets/chu2-quiet-18db.json"),
];

pub static BUILTIN: LazyLock<Vec<Preset>> = LazyLock::new(|| {
    BUILTIN_SOURCES
        .iter()
        .map(|s| Preset::from_json(s).expect("built-in preset is valid"))
        .collect()
});

pub fn builtin(id: &str) -> Option<&'static Preset> {
    BUILTIN.iter().find(|p| p.id == id)
}
