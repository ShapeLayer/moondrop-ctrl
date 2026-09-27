//! Host-side workflows shared by the CLI and the desktop app: finding the connected device,
//! read-only probing of a profile, backed-up apply with readback, commit with reconnect
//! verification, and EQ files.

use crate::backup;
use crate::library::Library;
use crate::native::{self, HidInfo, NativeTransport};
use crate::presets::PresetEq;
use crate::profiles::Profile;
use crate::protocol::hex_bytes;
use crate::{Band, Device, EqState, Error, Result, Transport};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

pub type Hardware = Device<NativeTransport>;

/// Open a device with `profile` through the built-in HID transport.
pub fn open_profile(profile: &Profile) -> Result<Hardware> {
    let transport = NativeTransport::open(profile)?;
    Ok(Device::new(transport, profile.clone()))
}

/// Open the first connected device among `profiles`, matched by USB IDs.
pub fn open_first(profiles: &[Profile]) -> Result<Hardware> {
    if profiles.is_empty() {
        return Err(Error::Invalid("no device profiles available".into()));
    }
    // Only try profiles whose device is present, so the error names what was looked for.
    let connected = native::enumerate().ok();
    let candidates: Vec<&Profile> = match &connected {
        Some(list) => profiles
            .iter()
            .filter(|p| list.iter().any(|d| d.matches(&p.usb)))
            .collect(),
        None => profiles.iter().collect(),
    };
    let mut last = None;
    for profile in candidates {
        match open_profile(profile) {
            Ok(device) => return Ok(device),
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(|| {
        let known = profiles
            .iter()
            .map(|p| format!("{} ({:04X}:{:04X})", p.title, p.usb.vendor_id, p.usb.product_id))
            .collect::<Vec<_>>()
            .join(", ");
        Error::Transport(format!(
            "no supported device is connected. Known profiles: {known}. For another model, add a profile (app: Settings → Profiles; CLI: profile import)"
        ))
    }))
}

/// Open the device the settings ask for: the chosen profile, else auto-detection.
pub fn open_configured(library: &Library) -> Result<Hardware> {
    match library.settings()?.profile {
        Some(id) => open_profile(&library.find_profile(&id)?),
        None => open_first(&library.profile_list()),
    }
}

/// HID interfaces on this computer, with the profiles that match each.
#[derive(Debug, Clone, Serialize)]
pub struct HidEntry {
    #[serde(flatten)]
    pub info: HidInfo,
    pub profiles: Vec<String>,
}
pub fn hid_devices(profiles: &[Profile]) -> Result<Vec<HidEntry>> {
    let mut list: Vec<HidEntry> = native::enumerate()?
        .into_iter()
        .map(|info| HidEntry {
            profiles: profiles
                .iter()
                .filter(|p| info.matches(&p.usb))
                .map(|p| p.id.clone())
                .collect(),
            info,
        })
        .collect();
    list.sort_by_key(|e| (e.info.vendor_id, e.info.product_id, e.info.usage_page, e.info.usage));
    list.dedup_by(|a, b| a.info == b.info);
    Ok(list)
}

/// Linux udev rules letting the logged-in user open the HID devices of every profile's vendor.
pub fn udev_rules(profiles: &[Profile]) -> String {
    let mut vendors: Vec<u16> = profiles.iter().map(|p| p.usb.vendor_id).collect();
    vendors.sort();
    vendors.dedup();
    let mut text = String::from(
        "# moondrop-ctrl: let the logged-in user open these HID devices.\n\
         # Save as /etc/udev/rules.d/70-moondrop-ctrl.rules, then: sudo udevadm control --reload && sudo udevadm trigger\n",
    );
    for v in vendors {
        text += &format!("KERNEL==\"hidraw*\", ATTRS{{idVendor}}==\"{v:04x}\", TAG+=\"uaccess\"\n");
    }
    text
}

#[derive(Debug, Clone, Serialize)]
pub struct RegisterRead {
    pub register: u8,
    /// Hex bytes, e.g. `"03 00 00 00"`.
    pub value: Option<String>,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
pub struct BandProbe {
    pub registers: Vec<RegisterRead>,
    pub band: Option<Band>,
    pub error: Option<String>,
}
/// What a read-only pass over a profile's registers found. Nothing is written.
#[derive(Debug, Clone, Serialize)]
pub struct ProbeReport {
    pub profile: String,
    /// `None` when the profile has no EQ switch.
    pub eq_switch: Option<RegisterRead>,
    pub enabled: Option<bool>,
    pub bands: Vec<BandProbe>,
    pub pregain: Option<RegisterRead>,
    /// The profile decoded every register it describes.
    pub ok: bool,
    /// Human-readable findings for the user (or an AI assistant) to act on.
    pub findings: Vec<String>,
}

fn read_logged<T: Transport>(device: &mut Device<T>, register: u8) -> (RegisterRead, Option<Vec<u8>>) {
    match device.read_register(register) {
        Ok(v) => (
            RegisterRead {
                register,
                value: Some(hex_bytes(&v)),
                error: None,
            },
            Some(v),
        ),
        Err(e) => (
            RegisterRead {
                register,
                value: None,
                error: Some(e.to_string()),
            },
            None,
        ),
    }
}

/// Read every register the profile describes and try to decode it, without writing anything.
pub fn probe<T: Transport>(device: &mut Device<T>) -> ProbeReport {
    let profile = device.profile().clone();
    let mut findings = Vec::new();
    let (eq_switch, enabled) = match profile.protocol.eq_switch.as_ref().map(|s| s.register) {
        None => (None, Some(true)),
        Some(register) => {
            let (read, value) = read_logged(device, register);
            let enabled = match value.map(|v| profile.switch_enabled(v[0])) {
                Some(Ok(on)) => Some(on),
                Some(Err(e)) => {
                    findings.push(format!("EQ switch: {e}"));
                    None
                }
                None => {
                    findings.push(format!(
                        "EQ switch register 0x{register:02X} did not answer: {}",
                        read.error.clone().unwrap_or_default()
                    ));
                    None
                }
            };
            (Some(read), enabled)
        }
    };
    let mut bands = Vec::new();
    for i in 0..profile.protocol.bands.count {
        let regs = profile.band_registers(i);
        let (reads, values): (Vec<_>, Vec<_>) = regs.iter().map(|&r| read_logged(device, r)).unzip();
        let (band, error) = match values.into_iter().collect::<Option<Vec<_>>>() {
            Some(values) => match profile
                .decode_band(&values)
                .and_then(|band| profile.validate_band(&band).map(|_| band))
            {
                Ok(band) => (Some(band), None),
                Err(e) => (None, Some(e.to_string())),
            },
            None => (None, Some("register read failed".to_string())),
        };
        if let Some(e) = &error {
            let names: Vec<String> = regs.iter().map(|r| format!("0x{r:02X}")).collect();
            findings.push(format!("Band {} ({}): {e}", i + 1, names.join("/")));
        }
        bands.push(BandProbe {
            registers: reads,
            band,
            error,
        });
    }
    let pregain = profile.protocol.pregain_register.map(|r| {
        let (read, _) = read_logged(device, r);
        if let Some(e) = &read.error {
            findings.push(format!("Pregain register 0x{r:02X}: {e}"));
        }
        read
    });
    let ok = enabled.is_some() && bands.iter().all(|b| b.band.is_some());
    if ok {
        findings.push(
            "Every described register answered and decoded. Next: apply a small change temporarily (not saved) and read it back."
                .into(),
        );
    }
    ProbeReport {
        profile: profile.id,
        eq_switch,
        enabled,
        bands,
        pregain,
        ok,
        findings,
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ApplyOutcome {
    /// Backup of the previous device EQ, written only when the EQ actually changed.
    pub backup: Option<PathBuf>,
    pub changed: bool,
    /// Set once the saved EQ has been read back after the device reconnected.
    pub committed: bool,
}

/// Back up the current EQ, apply `state` with readback, and optionally commit.
///
/// `open` must return a fresh handle each call: a commit restarts the device, so persistence is
/// verified by reopening it.
pub fn apply_verified<T, F>(
    open: F,
    state: &EqState,
    commit: bool,
    backup_dir: &Path,
) -> Result<ApplyOutcome>
where
    T: Transport,
    F: Fn() -> Result<Device<T>>,
{
    let mut device = open()?;
    let profile = device.profile().clone();
    profile.validate_eq(state)?;
    // Compare with what a read reports: values in the device's steps, and bands equal to the
    // unused-slot filler read back as empty.
    let state = &profile
        .quantize_eq(state)?
        .trimmed(&profile.protocol.unused_band);
    let current = device.read_eq()?;
    let mut outcome = ApplyOutcome::default();
    if current != *state {
        outcome.backup = Some(backup::save_eq(&current, backup_dir, &profile.id)?);
        device.apply_eq(state)?;
        outcome.changed = true;
    }
    if commit {
        device.commit()?;
        drop(device);
        let tries = (profile.protocol.timing.reconnect_timeout_ms / 250).max(1);
        for _ in 0..tries {
            thread::sleep(Duration::from_millis(250));
            if let Ok(mut reopened) = open() {
                if reopened.read_eq().ok().as_ref() == Some(state) {
                    outcome.committed = true;
                    return Ok(outcome);
                }
            }
        }
        return Err(Error::Protocol(
            "commit sent, but post-reconnect EQ could not be verified".into(),
        ));
    }
    Ok(outcome)
}

pub fn to_json(eq: &PresetEq) -> Result<String> {
    serde_json::to_string_pretty(eq)
        .map(|s| s + "\n")
        .map_err(|e| Error::Invalid(e.to_string()))
}

/// Reads an EQ file: an export, a backup, or a preset file (its `eq` part).
pub fn read_json(path: &Path) -> Result<PresetEq> {
    let text =
        fs::read_to_string(path).map_err(|e| Error::Invalid(format!("{}: {e}", path.display())))?;
    parse_eq(&text)
}
pub fn parse_eq(text: &str) -> Result<PresetEq> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| Error::Invalid(e.to_string()))?;
    let value = match value.get("eq") {
        Some(eq) => eq.clone(),
        None => value,
    };
    let eq: PresetEq = serde_json::from_value(value).map_err(|e| Error::Invalid(e.to_string()))?;
    eq.validate()?;
    Ok(eq)
}

pub fn write_json(path: &Path, eq: &PresetEq, overwrite: bool) -> Result<()> {
    eq.validate()?;
    if !overwrite && path.exists() {
        return Err(Error::Invalid(format!(
            "file already exists: {}",
            path.display()
        )));
    }
    fs::write(path, to_json(eq)?).map_err(|e| Error::Invalid(e.to_string()))
}
