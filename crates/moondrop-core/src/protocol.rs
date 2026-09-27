//! A register protocol over HID reports: each request reads or writes one 4-byte register.
//! Everything model-specific (report layout, report ID, command bytes, register addresses,
//! value encoding, filter codes, limits, timing) comes from the device's [`Profile`].

use crate::profiles::Profile;
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone)]
pub enum Error {
    Transport(String),
    Protocol(String),
    Invalid(String),
    Unsupported(String),
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transport(s) | Self::Protocol(s) | Self::Invalid(s) | Self::Unsupported(s) => {
                write!(f, "{s}")
            }
        }
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;

/// Filter shapes the editor and the response model understand (RBJ Audio EQ Cookbook). The
/// byte a device uses for each is set per profile (`protocol.filter_codes`); the numeric values
/// here are only the C ABI's codes.
#[repr(u8)]
#[derive(Debug, Copy, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterType {
    Peaking = 0,
    LowPass = 1,
    HighPass = 2,
    LowShelf = 3,
    HighShelf = 4,
    BandPass = 5,
    Notch = 6,
}
impl FilterType {
    pub const ALL: [FilterType; 7] = [
        Self::Peaking,
        Self::LowShelf,
        Self::HighShelf,
        Self::LowPass,
        Self::HighPass,
        Self::BandPass,
        Self::Notch,
    ];
    pub fn name(self) -> &'static str {
        match self {
            Self::Peaking => "peaking",
            Self::LowShelf => "low_shelf",
            Self::HighShelf => "high_shelf",
            Self::LowPass => "low_pass",
            Self::HighPass => "high_pass",
            Self::BandPass => "band_pass",
            Self::Notch => "notch",
        }
    }
    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|t| t.name() == name)
    }
    /// Whether the gain value changes this filter's response.
    pub fn has_gain(self) -> bool {
        matches!(self, Self::Peaking | Self::LowShelf | Self::HighShelf)
    }
}
impl TryFrom<u8> for FilterType {
    type Error = Error;
    /// From a C ABI code.
    fn try_from(value: u8) -> Result<Self> {
        Self::ALL
            .into_iter()
            .find(|t| *t as u8 == value)
            .ok_or_else(|| Error::Invalid(format!("unknown filter type {value}")))
    }
}

/// Values are kept to 6 decimal places, so a value decoded from a device, typed by a user, or
/// read from a file compares equal whenever the decimals agree.
pub fn canonical(x: f64) -> f64 {
    (x * 1e6).round() / 1e6
}

/// One filter in natural units. The device's resolution is set by the profile's
/// `band_encoding`; values are rounded to it when written.
#[derive(Debug, Copy, Clone, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "BandFile")]
pub struct Band {
    pub gain_db: f64,
    pub frequency_hz: f64,
    pub q: f64,
    pub filter_type: FilterType,
}
/// A band as written in files: natural units, or the fixed-point fields of version 0.2
/// (`gain_tenths_db`, `q_thousandths`).
#[derive(Deserialize)]
struct BandFile {
    gain_db: Option<f64>,
    gain_tenths_db: Option<i32>,
    frequency_hz: f64,
    q: Option<f64>,
    q_thousandths: Option<u32>,
    filter_type: FilterType,
}
impl TryFrom<BandFile> for Band {
    type Error = String;
    fn try_from(f: BandFile) -> std::result::Result<Self, String> {
        let gain = f
            .gain_db
            .or(f.gain_tenths_db.map(|g| g as f64 / 10.0))
            .ok_or("band needs gain_db")?;
        let q = f
            .q
            .or(f.q_thousandths.map(|q| q as f64 / 1000.0))
            .ok_or("band needs q")?;
        Band::new(gain, f.frequency_hz, q, f.filter_type).map_err(|e| e.to_string())
    }
}
impl Band {
    /// Range checks against a device happen in [`Profile::validate_band`].
    pub fn new(gain_db: f64, frequency_hz: f64, q: f64, filter_type: FilterType) -> Result<Self> {
        if !gain_db.is_finite() || !frequency_hz.is_finite() || !q.is_finite() {
            return Err(Error::Invalid("gain, frequency and Q must be finite".into()));
        }
        if frequency_hz <= 0.0 || q <= 0.0 {
            return Err(Error::Invalid("frequency and Q must be positive".into()));
        }
        Ok(Self {
            gain_db: canonical(gain_db),
            frequency_hz: canonical(frequency_hz),
            q: canonical(q),
            filter_type,
        })
    }
}

/// Reads `enabled`, or the `slot` field (2 off, 3 on) that files from version 0.2 carry.
pub(crate) fn enabled_from_file(
    enabled: Option<bool>,
    slot: Option<u8>,
) -> std::result::Result<bool, String> {
    match (enabled, slot) {
        (Some(on), _) => Ok(on),
        (None, Some(3)) => Ok(true),
        (None, Some(2)) => Ok(false),
        (None, Some(other)) => Err(format!(
            "legacy slot must be 2 (off) or 3 (on), got {other}"
        )),
        (None, None) => Ok(true),
    }
}

/// EQ as a device holds it: whether it is switched on, and the bands in use.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "EqStateFile")]
pub struct EqState {
    pub enabled: bool,
    /// Active bands, at most the profile's band count.
    pub bands: Vec<Band>,
}
#[derive(Deserialize)]
struct EqStateFile {
    enabled: Option<bool>,
    slot: Option<u8>,
    bands: Vec<Band>,
}
impl TryFrom<EqStateFile> for EqState {
    type Error = String;
    fn try_from(f: EqStateFile) -> std::result::Result<Self, String> {
        Ok(Self {
            enabled: enabled_from_file(f.enabled, f.slot)?,
            bands: f.bands,
        })
    }
}
impl EqState {
    /// The state as `read_eq` reports it: bands equal to the profile's unused-slot filler read
    /// back as empty slots.
    pub fn trimmed(&self, unused: &Band) -> EqState {
        EqState {
            enabled: self.enabled,
            bands: self.bands.iter().copied().filter(|b| b != unused).collect(),
        }
    }
}

/// Moves reports to and from a device. Reports include the report ID in byte 0; their length
/// is the profile's `protocol.frame.length`.
pub trait Transport {
    /// Send one report and return the device's response report.
    fn transact(&mut self, request: &[u8]) -> Result<Vec<u8>>;
    /// Send a report that may get no response, e.g. a commit that restarts the device.
    fn send(&mut self, request: &[u8]) -> Result<()> {
        self.transact(request).map(|_| ())
    }
}

impl<T: Transport + ?Sized> Transport for Box<T> {
    fn transact(&mut self, request: &[u8]) -> Result<Vec<u8>> {
        (**self).transact(request)
    }
    fn send(&mut self, request: &[u8]) -> Result<()> {
        (**self).send(request)
    }
}

pub fn hex_bytes(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Parses hex bytes such as `"4B 24 00"`, `"4b2400"` or `"0x4B2400"`.
pub fn parse_hex_bytes(text: &str) -> Result<Vec<u8>> {
    let digits: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let digits = digits.trim_start_matches("0x").trim_start_matches("0X");
    if digits.is_empty() || !digits.len().is_multiple_of(2) || !digits.is_ascii() {
        return Err(Error::Invalid("expected an even number of hex digits".into()));
    }
    (0..digits.len() / 2)
        .map(|i| {
            u8::from_str_radix(&digits[2 * i..2 * i + 2], 16)
                .map_err(|_| Error::Invalid(format!("invalid hex: {text}")))
        })
        .collect()
}

/// The switch register (if any) and every band slot, unused ones included.
#[derive(Debug, Clone, PartialEq)]
struct Slots {
    switch: Option<u8>,
    bands: Vec<Band>,
}

pub struct Device<T: Transport> {
    transport: T,
    profile: Profile,
}
impl<T: Transport> Device<T> {
    pub fn new(transport: T, profile: Profile) -> Self {
        Self { transport, profile }
    }
    pub fn profile(&self) -> &Profile {
        &self.profile
    }
    /// Send any report (normally `protocol.frame.length` bytes) and return the response.
    pub fn raw_command(&mut self, report: &[u8]) -> Result<Vec<u8>> {
        self.transport.transact(report)
    }
    /// A register's value (`protocol.frame.value_length` bytes).
    pub fn read_register(&mut self, register: u8) -> Result<Vec<u8>> {
        let p = &self.profile.protocol;
        let value = match &p.eq_switch {
            Some(s) if s.register == register => s.read_argument.clone(),
            _ => Vec::new(),
        };
        let request = self.profile.request(register, p.read_command, &value)?;
        let response = self.transport.transact(&request)?;
        self.profile.response_value(&request, &response)
    }
    /// Writes `value`, which must be exactly `protocol.frame.value_length` bytes.
    pub fn write_register(&mut self, register: u8, value: &[u8]) -> Result<()> {
        let length = self.profile.protocol.frame.value_length;
        if value.len() != length {
            return Err(Error::Invalid(format!(
                "a register value is {length} bytes, got {}",
                value.len()
            )));
        }
        let command = self.profile.protocol.write_command;
        let request = self.profile.request(register, command, value)?;
        let response = self.transport.transact(&request)?;
        self.profile.response_value(&request, &response)?;
        Ok(())
    }
    fn read_slots(&mut self) -> Result<Slots> {
        let switch = match self.profile.protocol.eq_switch.as_ref().map(|s| s.register) {
            Some(register) => Some(self.read_register(register)?[0]),
            None => None,
        };
        let mut bands = Vec::with_capacity(self.profile.protocol.bands.count);
        for i in 0..self.profile.protocol.bands.count {
            let values = self
                .profile
                .band_registers(i)
                .into_iter()
                .map(|r| self.read_register(r))
                .collect::<Result<Vec<_>>>()?;
            let band = self.profile.decode_band(&values)?;
            self.profile.validate_band(&band)?;
            bands.push(band);
        }
        Ok(Slots { switch, bands })
    }
    pub fn read_eq(&mut self) -> Result<EqState> {
        let slots = self.read_slots()?;
        let enabled = match slots.switch {
            Some(v) => self.profile.switch_enabled(v)?,
            None => true,
        };
        Ok(EqState {
            enabled,
            bands: slots.bands,
        }
        .trimmed(&self.profile.protocol.unused_band))
    }
    /// Write `state` to the band slots in order; slots past its last band get the profile's
    /// unused-slot filler. Values are rounded to the device's encoding steps. Reads back, and
    /// rolls back on any failure.
    pub fn apply_eq(&mut self, state: &EqState) -> Result<()> {
        self.profile.validate_eq(state)?;
        let state = self.profile.quantize_eq(state)?;
        let p = self.profile.protocol.clone();
        let mut bands = state.bands.clone();
        bands.resize(p.bands.count, p.unused_band);
        let target = Slots {
            switch: p
                .eq_switch
                .as_ref()
                .map(|s| if state.enabled { s.on } else { s.off }),
            bands,
        };
        let previous = self.read_slots()?;
        let mut changed = Vec::new();
        for (i, band) in target.bands.iter().enumerate() {
            let values = self.profile.encode_band(band)?;
            for (reg, value) in self.profile.band_registers(i).into_iter().zip(values) {
                // Include the attempted register: the device may have applied a write
                // even if its acknowledgement was lost.
                changed.push(reg);
                if let Err(error) = self.write_register(reg, &value) {
                    self.rollback(&previous, &changed);
                    return Err(error);
                }
            }
        }
        if let (Some(sw), Some(value)) = (&p.eq_switch, target.switch) {
            if target.switch != previous.switch {
                changed.push(sw.register);
                if let Err(error) = self.write_register(sw.register, &self.profile.byte_value(value)) {
                    self.rollback(&previous, &changed);
                    return Err(error);
                }
            }
        }
        match self.read_slots() {
            Ok(actual) if actual == target => Ok(()),
            Ok(_) => {
                self.rollback(&previous, &changed);
                Err(Error::Protocol(
                    "EQ readback differs; rollback attempted".into(),
                ))
            }
            Err(error) => {
                self.rollback(&previous, &changed);
                Err(Error::Protocol(format!(
                    "EQ readback failed: {error}; rollback attempted"
                )))
            }
        }
    }
    fn rollback(&mut self, original: &Slots, changed: &[u8]) {
        let switch = self.profile.protocol.eq_switch.as_ref().map(|s| s.register);
        for &register in changed.iter().rev() {
            let value = if Some(register) == switch {
                original.switch.map(|v| self.profile.byte_value(v))
            } else {
                self.profile.band_of_register(register).and_then(|(i, k)| {
                    let mut values = self.profile.encode_band(&original.bands[i]).ok()?;
                    Some(values.swap_remove(k))
                })
            };
            if let Some(value) = value {
                let _ = self.write_register(register, &value);
            }
        }
    }
    /// Persist the current settings. The device may restart without answering, so success
    /// only means the report was sent; reopen and read to verify.
    pub fn commit(&mut self) -> Result<()> {
        let p = &self.profile.protocol;
        let command = p.commit_command.ok_or_else(|| {
            Error::Unsupported(format!("{} has no commit command", self.profile.title))
        })?;
        let request = self.profile.request(p.commit_register, command, &[])?;
        self.transport.send(&request)
    }
    fn pregain_register(&self) -> Result<u8> {
        self.profile.protocol.pregain_register.ok_or_else(|| {
            Error::Unsupported(format!("{} has no pregain register", self.profile.title))
        })
    }
    pub fn read_pregain_db(&mut self) -> Result<i8> {
        let register = self.pregain_register()?;
        Ok(self.read_register(register)?[0] as i8)
    }
    pub fn write_pregain_db(&mut self, gain: i8) -> Result<()> {
        let register = self.pregain_register()?;
        let value = self.profile.byte_value(gain as u8);
        self.write_register(register, &value)
    }
    pub fn into_transport(self) -> T {
        self.transport
    }
}
