use moondrop_core::library::{Library, Settings, Source};
use moondrop_core::ops::{self, Hardware};
use moondrop_core::presets::{Preset, PresetEq};
use moondrop_core::profiles::Profile;
use moondrop_core::{Band, EqState, Error, FilterType, Result};
use serde::Serialize;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn usage() -> String {
    format!(
        "\
moondrop-ctrl {version}
Control Moondrop DSP earphones described by a device profile.

Device and EQ
  status                           Read live EQ and pregain
  eq read                          Read live EQ as JSON
  eq export FILE                   Save live EQ to JSON
  eq import FILE [--commit]        Apply an EQ, preset, or backup file
  eq band INDEX GAIN FREQ Q TYPE [--commit]  Edit or append one band (dB, Hz, Q; TYPE below)
  eq remove INDEX [--commit]       Remove one band; later bands move up
  eq on|off [--commit]             Enable or bypass the custom EQ
  commit                           Persist current temporary device settings
  device-self-test                 Lower one band 0.1 dB temporarily, then restore

Presets
  preset list                      Built-in, user, and snapshot presets
  preset show ID
  preset apply ID [--commit]
  preset save ID TITLE [NOTE]      Save the live device EQ as a user preset
  preset import FILE               Copy a preset file into the data folder
  preset delete ID                 Delete a user preset or snapshot
  restore-original [--commit]      Apply the snapshot taken when this model was first read

Profiles (support for other models)
  profiles                         List known profiles
  profile show ID                  Print a profile as JSON
  profile new ID VID PID [TEMPLATE]  Create a user profile from a template (default: first verified)
  profile set ID FIELD VALUE       Change one field, e.g. protocol.bands.count 8 (VALUE is JSON or text)
  profile import FILE              Validate and add a profile to the data folder
  profile export ID FILE
  profile delete ID                Delete a user profile
  hid list                         List HID devices on this computer (find VID/PID)
  probe [ID | FILE]                Read-only check of a profile against the device
  udev-rules                       Print Linux udev rules for every known profile's USB vendor

Settings
  home                             Print the data folder
  settings                         Print settings
  settings profile ID|auto         Always use this profile, or detect by USB IDs
  settings backup-dir PATH|default Where backups are written
  settings capture-original on|off Snapshot a model's EQ the first time it is read

Expert (no backups; export the EQ first)
  pregain read | pregain write DB  Experimental pregain register; effect unverified
  raw read REGISTER                Read a register (0xNN or decimal)
  raw write REGISTER HEX...        Write a register value (the profile's value length, e.g. 03 00 00 00)
  raw transact HEX                 Send a whole HID report (the profile's frame length)

Options
  --profile ID    Use this profile for this command instead of the configured one
  --commit        Save to the device (it restarts) and verify after reconnect
  --force         Allow writes with a profile that is not marked verified
  --json          Machine-readable output for list, show, status, and settings commands
  --home DIR      Use DIR as the data folder (default below)

Filter TYPE: peaking (peak), low_shelf (low), high_shelf (high), low_pass (lp), high_pass (hp),
band_pass (bp), notch; the profile decides which the device supports.

Structured EQ changes back up the device EQ first (see `settings`). Without --commit,
unplugging restores the last saved EQ. Data folder: {home} (override with ${env}).
",
        version = env!("CARGO_PKG_VERSION"),
        home = Library::default_home().display(),
        env = moondrop_core::library::HOME_ENV,
    )
}

struct Cli {
    lib: Library,
    profile: Option<String>,
    commit: bool,
    force: bool,
    json: bool,
}

fn parse_u8(value: &str) -> Result<u8> {
    if let Some(hex) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        u8::from_str_radix(hex, 16)
    } else {
        value.parse()
    }
    .map_err(|_| Error::Invalid(format!("invalid byte: {value}")))
}
fn parse_number<T: std::str::FromStr>(value: &str, name: &str) -> Result<T> {
    value
        .parse()
        .map_err(|_| Error::Invalid(format!("invalid {name}: {value}")))
}
fn kind(value: &str) -> Result<FilterType> {
    let name = match value {
        "peak" => "peaking",
        "low" => "low_shelf",
        "high" => "high_shelf",
        "lp" => "low_pass",
        "hp" => "high_pass",
        "bp" => "band_pass",
        other => other,
    };
    FilterType::from_name(&name.replace('-', "_")).ok_or_else(|| {
        let names: Vec<_> = FilterType::ALL.iter().map(|t| t.name()).collect();
        Error::Invalid(format!("filter type must be one of {}", names.join(", ")))
    })
}
/// A field value from the command line: JSON when it parses (numbers, null, true), else text.
fn field_value(text: &str) -> serde_json::Value {
    serde_json::from_str(text).unwrap_or_else(|_| serde_json::Value::String(text.to_string()))
}
fn json<T: Serialize>(value: &T) -> Result<String> {
    serde_json::to_string_pretty(value).map_err(|e| Error::Invalid(e.to_string()))
}
fn read_text(path: &str) -> Result<String> {
    fs::read_to_string(path).map_err(|e| Error::Invalid(format!("{path}: {e}")))
}

impl Cli {
    fn profile(&self) -> Result<Option<Profile>> {
        self.profile
            .as_deref()
            .map(|id| self.lib.find_profile(id))
            .transpose()
    }
    fn open(&self) -> Result<Hardware> {
        let mut device = match self.profile()? {
            Some(p) => ops::open_profile(&p)?,
            None => ops::open_configured(&self.lib)?,
        };
        // First contact with a model: keep what it held, so it can be restored later.
        if let Ok(state) = device.read_eq() {
            if let Ok(Some(path)) = self.lib.capture_original(device.profile(), &state) {
                eprintln!("Saved this device's original EQ: {}", path.display());
            }
        }
        Ok(device)
    }
    /// Open for writing: refuses unverified profiles unless --force.
    fn open_for_write(&self) -> Result<Hardware> {
        let device = self.open()?;
        let p = device.profile();
        if !p.verified && !self.force {
            return Err(Error::Invalid(format!(
                "profile {} is not marked verified; check it with `probe` and pass --force to write",
                p.id
            )));
        }
        Ok(device)
    }
    fn apply(&self, state: &EqState) -> Result<()> {
        let profile = self.open_for_write()?.profile().clone();
        let open = || ops::open_profile(&profile);
        let outcome = ops::apply_verified(open, state, self.commit, &self.lib.backup_dir())?;
        match &outcome.backup {
            Some(path) => {
                println!("Backup: {}", path.display());
                println!("Temporary EQ applied and read back.");
            }
            None => println!("EQ already matches requested state."),
        }
        if outcome.committed {
            println!("Saved EQ verified after device reconnect.");
        }
        Ok(())
    }
    fn device_self_test(&self) -> Result<()> {
        let mut device = self.open_for_write()?;
        let original = device.read_eq()?;
        let backup_path = moondrop_core::backup::save_eq(
            &original,
            &self.lib.backup_dir(),
            &device.profile().id,
        )?;
        // One step of the device's gain encoding (at least 0.1 dB).
        let step = device.profile().protocol.band_encoding.gain.step.max(0.1);
        let min = device.profile().limits.gain_db.min;
        let mut temporary = original.clone();
        let index = temporary
            .bands
            .iter()
            .position(|band| band.filter_type.has_gain() && band.gain_db - step >= min)
            .ok_or_else(|| Error::Invalid("no band has room for a downward test".into()))?;
        let b = temporary.bands[index];
        temporary.bands[index] = Band::new(b.gain_db - step, b.frequency_hz, b.q, b.filter_type)?;
        println!("Backup: {}", backup_path.display());
        device.apply_eq(&temporary)?;
        println!("Temporary {step} dB decrease on band {} read back.", index + 1);
        device.apply_eq(&original)?;
        if device.read_eq()? != original {
            return Err(Error::Protocol(
                "original EQ did not read back; unplug/reconnect to restore saved settings".into(),
            ));
        }
        println!("Original EQ restored and verified. No commit sent.");
        Ok(())
    }
    fn probe(&self, target: Option<&str>) -> Result<()> {
        let profile = match target {
            Some(t) if Path::new(t).is_file() => Profile::from_json(&read_text(t)?)?,
            Some(id) => self.lib.find_profile(id)?,
            None => match self.profile()? {
                Some(p) => p,
                None => self.open()?.profile().clone(),
            },
        };
        let mut device = ops::open_profile(&profile)?;
        let report = ops::probe(&mut device);
        println!("{}", json(&report)?);
        for finding in &report.findings {
            eprintln!("- {finding}");
        }
        Ok(())
    }

    fn run(&self, a: &[&str]) -> Result<()> {
        match a {
            [] | ["help"] => {
                print!("{}", usage());
                Ok(())
            }
            ["profiles"] if self.json => {
                println!("{}", json(&self.lib.profiles())?);
                Ok(())
            }
            ["profiles"] => {
                let listing = self.lib.profiles();
                for e in &listing.items {
                    let p = &e.item;
                    println!(
                        "{:<20} {:<28} {:04X}:{:04X}  {} bands  {}{}",
                        p.id,
                        p.title,
                        p.usb.vendor_id,
                        p.usb.product_id,
                        p.protocol.bands.count,
                        source_name(e.source),
                        if p.verified { "" } else { ", unverified" }
                    );
                }
                for issue in &listing.issues {
                    eprintln!("Skipped {}: {}", issue.path.display(), issue.message);
                }
                Ok(())
            }
            ["profile", "show", id] => {
                print!("{}", self.lib.find_profile(id)?.to_json()?);
                Ok(())
            }
            ["profile", "new", id, vid, pid] | ["profile", "new", id, vid, pid, _] => {
                let template = match a.get(5) {
                    Some(t) => self.lib.find_profile(t)?,
                    None => self
                        .lib
                        .profile_list()
                        .into_iter()
                        .find(|p| p.verified)
                        .ok_or_else(|| Error::Invalid("no verified template profile; name one".into()))?,
                };
                let mut value = serde_json::to_value(&template).map_err(|e| Error::Invalid(e.to_string()))?;
                value["id"] = serde_json::json!(id);
                value["title"] = serde_json::json!(id);
                value["verified"] = serde_json::json!(false);
                value["notes"] = serde_json::json!(format!("Started from the {} template; not verified.", template.id));
                value["usb"] = serde_json::json!({ "vendor_id": vid, "product_id": pid });
                let profile: Profile = serde_json::from_value(value).map_err(|e| Error::Invalid(e.to_string()))?;
                let saved = self.lib.save_profile(&profile)?;
                println!("Saved profile {id} to {}", saved.display());
                println!("Next: moondrop-ctrl probe {id}");
                Ok(())
            }
            ["profile", "set", id, field, value] => {
                let profile = self.lib.find_profile(id)?;
                let mut doc = serde_json::to_value(&profile).map_err(|e| Error::Invalid(e.to_string()))?;
                let pointer = format!("/{}", field.replace('.', "/"));
                let (parent, key) = pointer.rsplit_once('/').expect("pointer has a slash");
                let target = doc
                    .pointer_mut(if parent.is_empty() { "" } else { parent })
                    .and_then(|v| v.as_object_mut())
                    .ok_or_else(|| Error::Invalid(format!("no such field: {field}")))?;
                target.insert(key.to_string(), field_value(value));
                let updated: Profile = serde_json::from_value(doc).map_err(|e| Error::Invalid(e.to_string()))?;
                let saved = self.lib.save_profile(&updated)?;
                println!("Saved {}", saved.display());
                Ok(())
            }
            ["udev-rules"] => {
                print!("{}", ops::udev_rules(&self.lib.profile_list()));
                Ok(())
            }
            ["profile", "import", path] => {
                let profile = Profile::from_json(&read_text(path)?)?;
                let saved = self.lib.save_profile(&profile)?;
                println!("Saved profile {} to {}", profile.id, saved.display());
                Ok(())
            }
            ["profile", "export", id, path] => {
                moondrop_core::library::write_text(
                    Path::new(path),
                    &self.lib.find_profile(id)?.to_json()?,
                )?;
                println!("Saved {path}");
                Ok(())
            }
            ["profile", "delete", id] => {
                self.lib.delete_profile(id)?;
                println!("Deleted user profile {id}");
                Ok(())
            }
            ["hid", "list"] => {
                let profiles = self.lib.profile_list();
                let list = ops::hid_devices(&profiles)?;
                if self.json {
                    println!("{}", json(&list)?);
                    return Ok(());
                }
                for d in list {
                    println!(
                        "{:04X}:{:04X}  usage {:04X}:{:04X}  {} {}{}",
                        d.info.vendor_id,
                        d.info.product_id,
                        d.info.usage_page,
                        d.info.usage,
                        d.info.manufacturer,
                        d.info.product,
                        if d.profiles.is_empty() {
                            String::new()
                        } else {
                            format!("  [profile: {}]", d.profiles.join(", "))
                        }
                    );
                }
                Ok(())
            }
            ["probe"] => self.probe(None),
            ["probe", target] => self.probe(Some(target)),
            ["home"] => {
                println!("{}", self.lib.home().display());
                Ok(())
            }
            ["settings"] if self.json => {
                println!(
                    "{}",
                    json(&serde_json::json!({
                        "settings": self.lib.settings()?,
                        "home": self.lib.home(),
                        "backup_dir": self.lib.backup_dir(),
                    }))?
                );
                Ok(())
            }
            ["settings"] => {
                let s = self.lib.settings()?;
                println!("{}", json(&s)?);
                println!("Backups go to {}", self.lib.backup_dir().display());
                Ok(())
            }
            ["settings", key, value] => {
                let mut s: Settings = self.lib.settings()?;
                match (*key, *value) {
                    ("profile", "auto") => s.profile = None,
                    ("profile", id) => s.profile = Some(id.to_string()),
                    ("backup-dir", "default") => s.backup_dir = None,
                    ("backup-dir", path) => s.backup_dir = Some(PathBuf::from(path)),
                    ("capture-original", "on") => s.capture_original = true,
                    ("capture-original", "off") => s.capture_original = false,
                    _ => return Err(Error::Invalid(format!("unknown setting\n{}", usage()))),
                }
                self.lib.save_settings(&s)?;
                println!("{}", json(&s)?);
                Ok(())
            }
            ["status"] if self.json => {
                let mut d = self.open()?;
                let eq = d.read_eq()?;
                let pregain = d.read_pregain_db().ok();
                println!(
                    "{}",
                    json(&serde_json::json!({ "profile": d.profile(), "eq": eq, "pregain_db": pregain }))?
                );
                Ok(())
            }
            ["status"] => {
                let mut d = self.open()?;
                eprintln!("Profile: {} ({})", d.profile().title, d.profile().id);
                println!("{}", json(&d.read_eq()?)?);
                match d.read_pregain_db() {
                    Ok(v) => {
                        eprintln!("Experimental pregain register: {v} dB (audible effect unverified)")
                    }
                    Err(e) => eprintln!("Pregain read unavailable: {e}"),
                };
                Ok(())
            }
            ["eq", "read"] => {
                println!("{}", json(&self.open()?.read_eq()?)?);
                Ok(())
            }
            ["eq", "export", path] => {
                let state = self.open()?.read_eq()?;
                ops::write_json(Path::new(path), &PresetEq::from(&state), false)?;
                println!("Saved {path}");
                Ok(())
            }
            ["eq", "import", path] => self.apply(&ops::read_json(Path::new(path))?.state()),
            ["eq", "band", index, gain, frequency, q, filter] => {
                let index: usize = parse_number(index, "band index")?;
                let gain: f64 = parse_number(gain, "gain")?;
                let frequency: f64 = parse_number(frequency, "frequency")?;
                let q: f64 = parse_number(q, "Q")?;
                let band = Band::new(gain, frequency, q, kind(filter)?)?;
                let mut state = self.open()?.read_eq()?;
                let count = state.bands.len();
                match index {
                    i if (1..=count).contains(&i) => state.bands[i - 1] = band,
                    i if i == count + 1 => state.bands.push(band),
                    _ => {
                        return Err(Error::Invalid(format!(
                            "band index must be 1-{} (the next index appends a band)",
                            count + 1
                        )))
                    }
                }
                self.apply(&state)
            }
            ["eq", "remove", index] => {
                let index: usize = parse_number(index, "band index")?;
                let mut state = self.open()?.read_eq()?;
                if !(1..=state.bands.len()).contains(&index) {
                    return Err(Error::Invalid(format!(
                        "band index must be 1-{}",
                        state.bands.len()
                    )));
                }
                state.bands.remove(index - 1);
                self.apply(&state)
            }
            // `eq slot on|off` is the 0.2 spelling.
            ["eq", value @ ("on" | "off")] | ["eq", "slot", value @ ("on" | "off")] => {
                let mut state = self.open()?.read_eq()?;
                state.enabled = *value == "on";
                self.apply(&state)
            }
            ["preset", "list"] if self.json => {
                println!("{}", json(&self.lib.presets())?);
                Ok(())
            }
            ["preset", "list"] => {
                let listing = self.lib.presets();
                for e in &listing.items {
                    let p = &e.item;
                    let scope = if p.profiles.is_empty() {
                        "any device".to_string()
                    } else {
                        p.profiles.join(", ")
                    };
                    println!("{:<24} {:<32} {} · {}", p.id, p.title, scope, source_name(e.source));
                }
                for issue in &listing.issues {
                    eprintln!("Skipped {}: {}", issue.path.display(), issue.message);
                }
                Ok(())
            }
            ["preset", "show", id] => {
                print!("{}", self.lib.find_preset(id)?.to_json()?);
                Ok(())
            }
            ["preset", "apply", id] => {
                let preset = self.lib.find_preset(id)?;
                preset.fits(self.open()?.profile())?;
                self.apply(&preset.eq.state())
            }
            ["preset", "save", id, title] | ["preset", "save", id, title, _] => {
                let mut device = self.open()?;
                let preset = Preset {
                    id: id.to_string(),
                    title: title.to_string(),
                    note: a.get(4).map(|s| s.to_string()).unwrap_or_default(),
                    profiles: vec![device.profile().id.clone()],
                    eq: PresetEq::from(&device.read_eq()?),
                };
                println!("Saved {}", self.lib.save_preset(&preset)?.display());
                Ok(())
            }
            ["preset", "import", path] => {
                let preset = Preset::from_json(&read_text(path)?)?;
                println!("Saved {}", self.lib.save_preset(&preset)?.display());
                Ok(())
            }
            ["preset", "delete", id] => {
                self.lib.delete_preset(id)?;
                println!("Deleted {id}");
                Ok(())
            }
            ["restore-original"] => {
                let profile = self.open()?.profile().clone();
                self.apply(&self.lib.original(&profile.id)?.eq.state())
            }
            ["pregain", "read"] => {
                println!("{}", self.open()?.read_pregain_db()?);
                Ok(())
            }
            ["pregain", "write", gain] => {
                let value: i8 = parse_number(gain, "pregain")?;
                self.open_for_write()?.write_pregain_db(value)?;
                eprintln!("Pregain register written; audible effect is unverified. No commit sent.");
                Ok(())
            }
            ["raw", "read", register] => {
                let reg = parse_u8(register)?;
                let value = self.open()?.read_register(reg)?;
                println!("0x{reg:02X}: {}", moondrop_core::protocol::hex_bytes(&value));
                Ok(())
            }
            ["raw", "write", register, bytes @ ..] if !bytes.is_empty() => {
                let reg = parse_u8(register)?;
                // Accept "03 00 00 00", "03000000" or "0x03 0x00 …".
                let joined: String = bytes.iter().map(|b| b.trim_start_matches("0x").trim_start_matches("0X")).collect();
                let value = moondrop_core::protocol::parse_hex_bytes(&joined)?;
                self.open_for_write()?.write_register(reg, &value)?;
                println!("Wrote 0x{reg:02X}; no commit sent.");
                Ok(())
            }
            ["raw", "transact", hex] => {
                let request = moondrop_core::protocol::parse_hex_bytes(hex)?;
                let mut device = self.open_for_write()?;
                let expected = device.profile().protocol.frame.length;
                if request.len() != expected {
                    return Err(Error::Invalid(format!(
                        "the profile's reports are {expected} bytes, got {}",
                        request.len()
                    )));
                }
                let response = device.raw_command(&request)?;
                println!("{}", moondrop_core::protocol::hex_bytes(&response));
                Ok(())
            }
            ["device-self-test"] => self.device_self_test(),
            ["commit"] => {
                self.open_for_write()?.commit()?;
                println!("Commit sent; reconnect and read EQ to verify persistence.");
                Ok(())
            }
            _ => Err(Error::Invalid(format!("unknown command\n{}", usage()))),
        }
    }
}

fn source_name(source: Source) -> &'static str {
    match source {
        Source::Builtin => "built-in",
        Source::User => "user",
        Source::Snapshot => "snapshot",
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let mut cli = Cli {
        lib: Library::open_default(),
        profile: None,
        commit: false,
        force: false,
        json: false,
    };
    let mut rest: Vec<&str> = Vec::new();
    let mut iter = args.iter().map(String::as_str);
    while let Some(arg) = iter.next() {
        match arg {
            "--commit" => cli.commit = true,
            "--force" => cli.force = true,
            "--json" => cli.json = true,
            "--home" => {
                if let Some(dir) = iter.next() {
                    cli.lib = Library::new(dir);
                }
            }
            "--profile" => cli.profile = iter.next().map(str::to_string),
            "--help" | "-h" => rest = vec!["help"],
            other => rest.push(other),
        }
    }
    if let Err(e) = cli.run(&rest) {
        eprintln!("Error: {e}");
        std::process::exit(1)
    }
}
