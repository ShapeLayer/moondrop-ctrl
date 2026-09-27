use moondrop_core::library::{Library, Source};
use moondrop_core::presets::{self, Preset, PresetEq};
use moondrop_core::profiles::{self, Profile};
use moondrop_core::protocol::{Device, Error, Result, Transport};
use moondrop_core::{Band, EqState, FilterType};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

fn chu2() -> Profile {
    profiles::builtin("chu2-dsp").unwrap().clone()
}
/// A band from tenths of a dB, Hz, and thousandths of Q (compact test literals).
fn band(g: i32, f: u32, q: u32, filter_type: FilterType) -> Band {
    Band::new(g as f64 / 10.0, f as f64, q as f64 / 1000.0, filter_type).unwrap()
}
/// A CHU II DSP's EQ as found on one unit, used as the fake device's starting state.
fn original() -> EqState {
    use FilterType::Peaking;
    EqState {
        enabled: true,
        bands: vec![
            band(-47, 25, 300, Peaking),
            band(-50, 200, 700, Peaking),
            band(-25, 1400, 1600, Peaking),
            band(-48, 3500, 1000, Peaking),
            band(-20, 9000, 1500, Peaking),
        ],
    }
}
fn quiet() -> EqState {
    presets::builtin("chu2-quiet-18db").unwrap().eq.state()
}
fn temp_dir(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("moondrop-test-{name}-{}", std::process::id()))
}

#[derive(Default)]
struct FakeState {
    registers: BTreeMap<u8, Vec<u8>>,
    fail_once_on: Option<u8>,
    commits: u32,
}
/// Register-level fake of a device speaking `profile`'s protocol.
#[derive(Clone)]
struct Fake(Rc<RefCell<FakeState>>, Profile);
impl Fake {
    fn with(profile: Profile, state: &EqState) -> Self {
        let mut registers = BTreeMap::new();
        if let Some(s) = &profile.protocol.eq_switch {
            registers.insert(s.register, profile.byte_value(if state.enabled { s.on } else { s.off }));
        }
        let mut bands = state.bands.clone();
        bands.resize(profile.protocol.bands.count, profile.protocol.unused_band);
        for (i, b) in bands.iter().enumerate() {
            let values = profile.encode_band(b).unwrap();
            for (reg, v) in profile.band_registers(i).into_iter().zip(values) {
                registers.insert(reg, v);
            }
        }
        Self(
            Rc::new(RefCell::new(FakeState {
                registers,
                ..FakeState::default()
            })),
            profile,
        )
    }
    fn original() -> Self {
        Self::with(chu2(), &original())
    }
    fn device(&self) -> Device<Fake> {
        Device::new(self.clone(), self.1.clone())
    }
}
impl Transport for Fake {
    fn transact(&mut self, req: &[u8]) -> Result<Vec<u8>> {
        let p = &self.1.protocol;
        let f = &p.frame;
        assert_eq!(req.len(), f.length);
        assert_eq!(req[0], p.report_id);
        let reg = req[f.register_offset];
        let cmd = req[f.command_offset];
        let mut state = self.0.borrow_mut();
        let value = if cmd == p.read_command {
            state
                .registers
                .get(&reg)
                .cloned()
                .ok_or_else(|| Error::Protocol("missing register".into()))?
        } else if cmd == p.write_command {
            let v = req[f.value_offset..f.value_offset + f.value_length].to_vec();
            state.registers.insert(reg, v.clone());
            if state.fail_once_on == Some(reg) {
                state.fail_once_on = None;
                return Err(Error::Transport("lost acknowledgement".into()));
            }
            v
        } else if Some(cmd) == p.commit_command {
            state.commits += 1;
            vec![0; f.value_length]
        } else {
            return Err(Error::Protocol("unsupported command".into()));
        };
        let mut response = req.to_vec();
        response[f.value_offset..f.value_offset + f.value_length].copy_from_slice(&value);
        Ok(response)
    }
}

#[test]
fn builtins_are_valid() {
    for profile in profiles::BUILTIN.iter() {
        profile.validate().unwrap();
        assert!(profile.protocol.bands.count <= profiles::MAX_BANDS);
    }
    for preset in presets::BUILTIN.iter() {
        preset.validate().unwrap();
        for id in &preset.profiles {
            let profile = profiles::builtin(id).expect("preset names a built-in profile");
            preset.fits(profile).unwrap();
        }
    }
}
#[test]
fn register_encoding_round_trips() {
    let p = chu2();
    for band in quiet().bands {
        let values = p.encode_band(&band).unwrap();
        assert_eq!(p.decode_band(&values).unwrap(), band);
    }
    // CHU II DSP codes: peaking 0, low shelf 3, high shelf 4.
    assert_eq!(p.encode_band(&quiet().bands[0]).unwrap()[1][2], 3);
}
#[test]
fn request_and_response_detect_mismatch() {
    let p = chu2();
    let req = p.request(0x26, 0x52, &[1, 2, 3, 4]).unwrap();
    assert_eq!(req, [0x4B, 0x26, 0, 0, 0, 0x52, 0, 1, 2, 3, 4]);
    let mut resp = req.clone();
    resp[7..].copy_from_slice(&[9, 8, 7, 6]);
    assert_eq!(p.response_value(&req, &resp).unwrap(), [9, 8, 7, 6]);
    let other = p.request(0x27, 0x52, &[]).unwrap();
    assert!(p.response_value(&other, &resp).is_err());
    assert!(p.response_value(&req, &resp[..10]).is_err());
}
#[test]
fn profile_json_round_trips_and_accepts_numbers_or_hex() {
    let p = chu2();
    let json = p.to_json().unwrap();
    assert!(json.contains("\"vendor_id\": \"0x31B2\""));
    assert_eq!(Profile::from_json(&json).unwrap(), p);
    let numeric = json.replace("\"0x31B2\"", "12722");
    assert_eq!(Profile::from_json(&numeric).unwrap(), p);
}
#[test]
fn invalid_profiles_are_rejected() {
    let broken = |edit: fn(&mut Profile)| {
        let mut p = chu2();
        edit(&mut p);
        p.validate().is_err()
    };
    assert!(broken(|p| p.id = "Bad ID".into()));
    assert!(broken(|p| p.protocol.bands.count = 0));
    assert!(broken(|p| p.protocol.bands.count = 17));
    assert!(broken(|p| p.protocol.bands.first_register = 0xF8));
    assert!(broken(|p| p.protocol.eq_switch.as_mut().unwrap().register = 0x28));
    assert!(broken(|p| p.protocol.filter_codes.low_shelf = Some(0)));
    assert!(broken(|p| p.protocol.unused_band.gain_db = 1.0));
    assert!(broken(|p| p.limits.q.min = 0.0));
    assert!(broken(|p| p.protocol.frame.value_offset = 5));
    assert!(broken(|p| p.protocol.frame.length = 9));
    assert!(broken(|p| p.protocol.frame.echo_length = 8));
    assert!(broken(|p| p.protocol.band_encoding.gain.step = 0.0));
    assert!(broken(|p| p.protocol.band_encoding.q.offset = 1));
    assert!(broken(|p| p.protocol.band_encoding.filter.offset = 8));
    assert!(broken(|p| p.protocol.band_encoding.gain.signed = false));
    assert!(broken(|p| p.protocol.bands.registers_per_band = 3));
    assert!(broken(|p| p.protocol.frame.value_length = 5));
    assert!(broken(|p| p.protocol.unused_band.filter_type = FilterType::LowPass));
    assert!(broken(|p| p.protocol.filter_codes.notch = Some(4)));
}
#[test]
fn profiles_written_before_optional_fields_existed_still_load() {
    let mut value: serde_json::Value = serde_json::from_str(&chu2().to_json().unwrap()).unwrap();
    let protocol = value["protocol"].as_object_mut().unwrap();
    for key in ["frame", "commit_register", "band_encoding", "timing"] {
        protocol.remove(key);
    }
    protocol["bands"].as_object_mut().unwrap().remove("registers_per_band");
    // 0.2-style fixed-point unused band.
    protocol["unused_band"] = serde_json::json!({
        "gain_tenths_db": 0, "frequency_hz": 20000, "q_thousandths": 100, "filter_type": "peaking"
    });
    value.as_object_mut().unwrap().remove("dsp");
    assert_eq!(Profile::from_json(&value.to_string()).unwrap(), chu2());
}
#[test]
fn apply_readback_and_commit() {
    let fake = Fake::original();
    let mut device = fake.device();
    assert_eq!(device.read_eq().unwrap(), original());
    device.apply_eq(&quiet()).unwrap();
    assert_eq!(device.read_eq().unwrap(), quiet());
    device.commit().unwrap();
    assert_eq!(fake.0.borrow().commits, 1);
}
#[test]
fn failed_write_rolls_back_even_if_device_applied_it() {
    let fake = Fake::original();
    fake.0.borrow_mut().fail_once_on = Some(0x29);
    let mut device = fake.device();
    assert!(device.apply_eq(&quiet()).is_err());
    assert_eq!(device.read_eq().unwrap(), original());
}
#[test]
fn apply_verified_backs_up_then_commits_and_verifies() {
    use moondrop_core::ops::apply_verified;
    let fake = Fake::original();
    let dir = temp_dir("apply");
    let open = || Ok(fake.device());
    let outcome = apply_verified(open, &quiet(), true, &dir).unwrap();
    assert!(outcome.changed && outcome.committed);
    let backup = outcome.backup.unwrap();
    assert!(backup.file_name().unwrap().to_str().unwrap().starts_with("chu2-dsp-backup-"));
    assert_eq!(moondrop_core::ops::read_json(&backup).unwrap().state(), original());
    assert_eq!(fake.0.borrow().commits, 1);
    let again = apply_verified(open, &quiet(), false, &dir).unwrap();
    assert!(!again.changed && again.backup.is_none());
    std::fs::remove_dir_all(dir).unwrap();
}
#[test]
fn fewer_bands_clear_the_remaining_slots() {
    let fake = Fake::original();
    let mut device = fake.device();
    let mut three = quiet();
    three.bands.truncate(3);
    device.apply_eq(&three).unwrap();
    assert_eq!(device.read_eq().unwrap(), three);
    let unused = chu2().encode_band(&chu2().protocol.unused_band).unwrap();
    let registers = &fake.0.borrow().registers;
    assert_eq!(vec![registers[&0x2c].clone(), registers[&0x2d].clone()], unused);
    assert_eq!(vec![registers[&0x2e].clone(), registers[&0x2f].clone()], unused);
}
#[test]
fn out_of_profile_eq_is_rejected_untouched() {
    let fake = Fake::original();
    let mut device = fake.device();
    let mut six = quiet();
    six.bands.push(six.bands[0]);
    assert!(matches!(device.apply_eq(&six), Err(Error::Invalid(_))));
    let mut loud = quiet();
    loud.bands[0].gain_db = 13.0;
    assert!(matches!(device.apply_eq(&loud), Err(Error::Invalid(_))));
    assert_eq!(device.read_eq().unwrap(), original());
}
#[test]
fn empty_eq_round_trips_and_apply_verified_ignores_unused_bands() {
    use moondrop_core::ops::apply_verified;
    let fake = Fake::original();
    let dir = temp_dir("empty");
    let open = || Ok(fake.device());
    let empty = EqState {
        enabled: true,
        bands: vec![],
    };
    let outcome = apply_verified(open, &empty, true, &dir).unwrap();
    assert!(outcome.changed && outcome.committed);
    assert_eq!(open().unwrap().read_eq().unwrap(), empty);
    // A band equal to the unused marker reads back as an empty slot, not as a mismatch.
    let marker = EqState {
        enabled: true,
        bands: vec![chu2().protocol.unused_band],
    };
    let again = apply_verified(open, &marker, true, &dir).unwrap();
    assert!(!again.changed && again.committed);
    std::fs::remove_dir_all(dir).unwrap();
}
/// A hypothetical model that differs from the CHU II DSP in every configurable way.
fn other_model() -> Profile {
    let mut p = chu2();
    p.id = "test-model".into();
    p.protocol.report_id = 0x4C;
    p.protocol.frame.length = 16;
    p.protocol.frame.register_offset = 2;
    p.protocol.frame.command_offset = 1;
    p.protocol.frame.value_offset = 8;
    p.protocol.frame.echo_length = 3;
    p.protocol.commit_register = 0xFE;
    p.protocol.eq_switch = None;
    p.protocol.bands.count = 8;
    p.protocol.bands.first_register = 0x40;
    p.protocol.bands.stride = 3;
    p.protocol.band_encoding.gain.step = 0.5;
    p.protocol.band_encoding.q.step = 0.01;
    p.protocol.filter_codes.peaking = Some(2);
    p.protocol.filter_codes.low_shelf = Some(1);
    p.protocol.filter_codes.high_shelf = None;
    p.protocol.filter_codes.high_pass = Some(7);
    p.protocol.pregain_register = None;
    p.limits.gain_db = profiles::Range { min: -20.0, max: 6.0 };
    p.validate().unwrap();
    p
}
#[test]
fn a_different_model_works_end_to_end() {
    use moondrop_core::ops::apply_verified;
    let p = other_model();
    let fake = Fake::with(p.clone(), &EqState { enabled: true, bands: vec![] });
    let mut device = fake.device();
    assert_eq!(device.read_eq().unwrap().bands.len(), 0);
    // -4.7 dB is stored in 0.5 dB steps and Q 0.707 in 0.01 steps; the readback check expects that.
    let state = EqState {
        enabled: true,
        bands: vec![
            band(-47, 100, 707, FilterType::LowShelf),
            band(-180, 3000, 2000, FilterType::Peaking),
            band(0, 30, 707, FilterType::HighPass),
        ],
    };
    device.apply_eq(&state).unwrap();
    let stored = device.read_eq().unwrap();
    assert_eq!(stored.bands[0], band(-45, 100, 710, FilterType::LowShelf));
    assert_eq!(stored.bands[1].gain_db, -18.0);
    assert_eq!(stored.bands[2].filter_type, FilterType::HighPass);
    // Band 2 lives at 0x43/0x44; its second register holds Q 2.0 / 0.01 = 200 and the peaking code 2.
    assert_eq!(fake.0.borrow().registers[&0x44], [200, 0, 2, 0]);
    // Gain -18 dB / 0.5 = -36.
    assert_eq!(fake.0.borrow().registers[&0x43][..2], (-36i16).to_le_bytes());
    // No switch: switching off is refused, and nothing outside the limits gets through.
    assert!(device.apply_eq(&EqState { enabled: false, bands: vec![] }).is_err());
    let shelf = EqState { enabled: true, bands: vec![band(0, 5000, 700, FilterType::HighShelf)] };
    assert!(device.apply_eq(&shelf).is_err());
    let loud = EqState { enabled: true, bands: vec![band(80, 5000, 700, FilterType::Peaking)] };
    assert!(device.apply_eq(&loud).is_err());
    assert!(device.read_pregain_db().is_err());
    let report = moondrop_core::ops::probe(&mut device);
    assert!(report.ok && report.eq_switch.is_none(), "{:?}", report.findings);
    assert_eq!(report.bands.len(), 8);
    // The backed-up apply compares against the quantized state, so it neither fails nor re-applies.
    let dir = temp_dir("other");
    let open = || Ok(fake.device());
    let outcome = apply_verified(open, &state, true, &dir).unwrap();
    assert!(!outcome.changed && outcome.committed);
    assert_eq!(fake.0.borrow().commits, 1);
    std::fs::remove_dir_all(&dir).ok();
}
#[test]
fn a_packed_big_endian_layout_with_one_byte_registers() {
    // 2-byte values, 4 registers per band (8 bytes), big endian: [filter, gain i8 in 0.25 dB,
    // frequency u16 in 0.5 Hz, Q u16 in 0.0005, 0, 0].
    let mut p = other_model();
    p.protocol.frame.value_length = 2;
    p.protocol.frame.length = 12;
    p.protocol.bands.registers_per_band = 4;
    p.protocol.bands.stride = 4;
    let e = &mut p.protocol.band_encoding;
    e.byte_order = profiles::ByteOrder::Big;
    e.filter = profiles::Field { offset: 0, size: 1, step: 1.0, signed: false };
    e.gain = profiles::Field { offset: 1, size: 1, step: 0.25, signed: true };
    e.frequency = profiles::Field { offset: 2, size: 2, step: 0.5, signed: false };
    e.q = profiles::Field { offset: 4, size: 2, step: 0.0005, signed: false };
    p.limits.gain_db = profiles::Range { min: -20.0, max: 6.0 };
    p.limits.q = profiles::Range { min: 0.1, max: 10.0 };
    p.protocol.unused_band = band(0, 1000, 1000, FilterType::Peaking);
    p.validate().unwrap();
    let fake = Fake::with(p.clone(), &EqState { enabled: true, bands: vec![] });
    let mut device = fake.device();
    // Finer than 0.1 dB and 1 Hz: the natural-unit file format carries it through.
    let state = EqState {
        enabled: true,
        bands: vec![Band::new(-3.25, 62.5, 0.7075, FilterType::Peaking).unwrap()],
    };
    device.apply_eq(&state).unwrap();
    assert_eq!(device.read_eq().unwrap(), state);
    {
        let regs = &fake.0.borrow().registers;
        // Band 1 at 0x40..0x43: [code 2, -13 (= -3.25 / 0.25)], [125 >> 8, 125], [1415 >> 8, 1415 & 0xFF], [0, 0].
        assert_eq!(regs[&0x40], vec![2, (-13i8) as u8]);
        assert_eq!(regs[&0x41], vec![0, 125]);
        assert_eq!(regs[&0x42], vec![0x05, 0x87]);
        assert_eq!(regs[&0x43], vec![0, 0]);
    }
    // Uncovered bytes must read back as zero.
    drop(device);
    fake.0.borrow_mut().registers.insert(0x43, vec![0, 1]);
    assert!(fake.device().read_eq().is_err());
}
#[test]
fn natural_units_round_trip_through_files() {
    let b = Band::new(-4.75, 31.5, 0.7125, FilterType::Notch).unwrap();
    let json = serde_json::to_string(&b).unwrap();
    assert_eq!(json, r#"{"gain_db":-4.75,"frequency_hz":31.5,"q":0.7125,"filter_type":"notch"}"#);
    assert_eq!(serde_json::from_str::<Band>(&json).unwrap(), b);
    let legacy = r#"{"gain_tenths_db":-47,"frequency_hz":25,"q_thousandths":300,"filter_type":"peaking"}"#;
    assert_eq!(serde_json::from_str::<Band>(legacy).unwrap(), band(-47, 25, 300, FilterType::Peaking));
    assert!(serde_json::from_str::<Band>(r#"{"frequency_hz":25,"q":1,"filter_type":"peaking"}"#).is_err());
}
#[test]
fn probe_reports_undecodable_registers() {
    let fake = Fake::original();
    fake.0.borrow_mut().registers.insert(0x27, vec![0, 0, 9, 0]);
    let report = moondrop_core::ops::probe(&mut fake.device());
    assert!(!report.ok);
    assert!(report.findings[0].contains("unknown filter code 0x09"));
}
#[test]
fn eq_files_keep_colors_accept_legacy_slot_and_preset_files() {
    let dir = temp_dir("json");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("eq.json");
    let eq = presets::builtin("chu2-quiet-18db").unwrap().eq.clone();
    moondrop_core::ops::write_json(&path, &eq, true).unwrap();
    assert_eq!(moondrop_core::ops::read_json(&path).unwrap(), eq);

    let plain = PresetEq::from(&quiet());
    assert!(!moondrop_core::ops::to_json(&plain).unwrap().contains("color"));
    moondrop_core::ops::write_json(&path, &plain, true).unwrap();
    assert_eq!(moondrop_core::ops::read_json(&path).unwrap(), plain);

    let legacy = r#"{"slot": 2, "bands": []}"#;
    assert!(!moondrop_core::ops::parse_eq(legacy).unwrap().enabled);
    assert!(moondrop_core::ops::parse_eq(r#"{"slot": 7, "bands": []}"#).is_err());
    let preset_file = presets::builtin("chu2-quiet-18db").unwrap().to_json().unwrap();
    assert_eq!(moondrop_core::ops::parse_eq(&preset_file).unwrap(), eq);

    let mut bad = eq;
    bad.bands[0].color = Some("red".into());
    assert!(moondrop_core::ops::write_json(&path, &bad, true).is_err());
    std::fs::remove_dir_all(dir).unwrap();
}
#[test]
fn library_merges_user_files_and_captures_one_snapshot() {
    let dir = temp_dir("library");
    let lib = Library::new(&dir);
    // A user profile for another model, and a user copy overriding the built-in.
    let mut other = chu2();
    other.id = "other-model".into();
    other.usb.product_id = 0x0200;
    other.verified = false;
    lib.save_profile(&other).unwrap();
    let mut tweaked = chu2();
    tweaked.title = "My CHU II".into();
    lib.save_profile(&tweaked).unwrap();
    std::fs::write(dir.join("profiles/broken.json"), "{").unwrap();
    let listing = lib.profiles();
    assert_eq!(listing.items.len(), 2);
    assert_eq!(listing.issues.len(), 1);
    let chu = listing.items.iter().find(|e| e.item.id == "chu2-dsp").unwrap();
    assert!(chu.overrides_builtin && chu.item.title == "My CHU II");
    lib.delete_profile("chu2-dsp").unwrap();
    assert_eq!(lib.find_profile("chu2-dsp").unwrap().title, "MOONDROP CHU II DSP");
    assert!(lib.delete_profile("chu2-dsp").is_err());

    let first = lib.capture_original(&chu2(), &original()).unwrap();
    assert!(first.is_some());
    assert!(lib.capture_original(&chu2(), &quiet()).unwrap().is_none());
    let snapshot = lib.original("chu2-dsp").unwrap();
    assert_eq!(snapshot.eq.state(), original());
    let entry = lib.presets().items.into_iter().find(|e| e.item.id == snapshot.id).unwrap();
    assert_eq!(entry.source, Source::Snapshot);

    let mine = Preset {
        id: "mine".into(),
        title: "Mine".into(),
        note: String::new(),
        profiles: vec![],
        eq: PresetEq::from(&quiet()),
    };
    lib.save_preset(&mine).unwrap();
    assert_eq!(lib.find_preset("mine").unwrap(), mine);
    let reserved = Preset { id: "original-x".into(), ..mine };
    assert!(lib.save_preset(&reserved).is_err());

    let mut settings = lib.settings().unwrap();
    assert!(settings.capture_original);
    settings.profile = Some("nope".into());
    assert!(lib.save_settings(&settings).is_err());
    settings.profile = Some("other-model".into());
    lib.save_settings(&settings).unwrap();
    assert_eq!(lib.settings().unwrap().profile.as_deref(), Some("other-model"));
    std::fs::remove_dir_all(dir).unwrap();
}
