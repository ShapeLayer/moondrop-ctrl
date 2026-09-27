//! Device profiles: how to find a device on USB, how its reports are framed, where its EQ
//! registers are, and how band values are encoded in them. Profiles are JSON data (see
//! `schemas/profile.schema.json`). Built-in ones live in `crates/moondrop-core/profiles/`; users
//! add their own through the app, the CLI, or by dropping a file into the data folder's
//! `profiles/` directory. Every optional section defaults to the CHU II DSP's layout.

use crate::hex;
use crate::protocol::{canonical, hex_bytes, Band, EqState, Error, FilterType, Result};
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

/// Most band slots a profile may declare (the C ABI's `MD_MAX_BANDS`).
pub const MAX_BANDS: usize = 16;
/// Longest report a profile may declare.
pub const MAX_REPORT_LEN: usize = 64;
/// Longest register value a profile may declare.
pub const MAX_VALUE_LEN: usize = 16;
/// Most registers one band may span.
pub const MAX_REGISTERS_PER_BAND: usize = 8;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Profile {
    /// Stable identifier: lowercase letters, digits, `-` and `_`.
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub notes: String,
    /// Set once writes, readback and commit have been confirmed on real hardware. Apps ask
    /// for confirmation before writing to a device whose profile is not verified.
    #[serde(default)]
    pub verified: bool,
    pub usb: UsbMatch,
    pub protocol: Protocol,
    pub limits: Limits,
    /// How apps model the response for display. Never sent to the device.
    #[serde(default)]
    pub dsp: DspModel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsbMatch {
    #[serde(with = "hex::u16")]
    pub vendor_id: u16,
    #[serde(with = "hex::u16")]
    pub product_id: u16,
    /// HID usage page of the control interface, when the device exposes several interfaces.
    #[serde(default, with = "hex::opt_u16", skip_serializing_if = "Option::is_none")]
    pub usage_page: Option<u16>,
    #[serde(default, with = "hex::opt_u16", skip_serializing_if = "Option::is_none")]
    pub usage: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Protocol {
    /// First byte of every report.
    #[serde(with = "hex::u8")]
    pub report_id: u8,
    /// Where the register, command and value sit in a report.
    #[serde(default)]
    pub frame: Frame,
    #[serde(with = "hex::u8")]
    pub read_command: u8,
    #[serde(with = "hex::u8")]
    pub write_command: u8,
    /// Saves the current settings; the device may restart. `null` if saving is not supported.
    #[serde(default, with = "hex::opt_u8")]
    pub commit_command: Option<u8>,
    /// Register byte sent with the commit command.
    #[serde(default, with = "hex::u8")]
    pub commit_register: u8,
    /// The register that turns the custom EQ on and off; `null` if the device has none (the
    /// EQ is then always on).
    #[serde(default)]
    pub eq_switch: Option<EqSwitch>,
    pub bands: BandLayout,
    /// Where each band value sits in the band's bytes, and its units.
    #[serde(default)]
    pub band_encoding: BandEncoding,
    pub filter_codes: FilterCodes,
    /// Written to slots that hold no band. It must be inaudible (0 dB); slots holding exactly
    /// this value are left out when the EQ is read.
    pub unused_band: Band,
    /// Register whose first value byte is a signed pregain in dB. Optional and experimental.
    #[serde(default, with = "hex::opt_u8")]
    pub pregain_register: Option<u8>,
    #[serde(default)]
    pub timing: Timing,
}

/// Report layout: `[report_id, …]`, `length` bytes, zero-filled, with the register, the command
/// and the `value_length`-byte value at the given offsets. A response must repeat the request's
/// first `echo_length` bytes and carries the register value at `value_offset`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Frame {
    pub length: usize,
    pub register_offset: usize,
    pub command_offset: usize,
    pub value_offset: usize,
    pub value_length: usize,
    pub echo_length: usize,
}
impl Default for Frame {
    fn default() -> Self {
        Self {
            length: 11,
            register_offset: 1,
            command_offset: 5,
            value_offset: 7,
            value_length: 4,
            echo_length: 7,
        }
    }
}

#[derive(Debug, Copy, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ByteOrder {
    Little,
    Big,
}

/// One number inside a band's bytes. Wire value = natural value / `step`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Field {
    /// Byte offset within the band's bytes (its registers' values, concatenated).
    pub offset: usize,
    /// 1 to 4 bytes.
    pub size: usize,
    #[serde(default = "one")]
    pub step: f64,
    #[serde(default)]
    pub signed: bool,
}
fn one() -> f64 {
    1.0
}
impl Field {
    fn new(offset: usize, size: usize, step: f64, signed: bool) -> Self {
        Self {
            offset,
            size,
            step,
            signed,
        }
    }
    fn range(&self) -> (i64, i64) {
        let bits = 8 * self.size as u32;
        if self.signed {
            (-(1i64 << (bits - 1)), (1i64 << (bits - 1)) - 1)
        } else {
            (0, (1i64 << bits) - 1)
        }
    }
    fn bytes(&self) -> std::ops::Range<usize> {
        self.offset..self.offset + self.size
    }
}

/// Band bytes: the values of a band's `registers_per_band` registers, concatenated. The CHU II
/// DSP uses `[gain i16, frequency u16 | Q u16, filter code, 0]`, little endian, in 0.1 dB, 1 Hz and
/// 0.001 Q. Bytes no field covers are written as 0 and must read back as 0.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BandEncoding {
    pub byte_order: ByteOrder,
    pub gain: Field,
    pub frequency: Field,
    pub q: Field,
    /// The filter code; `step` is ignored.
    pub filter: Field,
}
impl Default for BandEncoding {
    fn default() -> Self {
        Self {
            byte_order: ByteOrder::Little,
            gain: Field::new(0, 2, 0.1, true),
            frequency: Field::new(2, 2, 1.0, false),
            q: Field::new(4, 2, 0.001, false),
            filter: Field::new(6, 1, 1.0, false),
        }
    }
}
impl BandEncoding {
    fn fields(&self) -> [(&'static str, &Field); 4] {
        [
            ("gain", &self.gain),
            ("frequency", &self.frequency),
            ("q", &self.q),
            ("filter", &self.filter),
        ]
    }
    fn put(&self, bytes: &mut [u8], field: &Field, raw: i64) -> Result<()> {
        let (lo, hi) = field.range();
        if raw < lo || raw > hi {
            return Err(Error::Invalid(format!(
                "value {raw} does not fit a {}-byte {} field",
                field.size,
                if field.signed { "signed" } else { "unsigned" }
            )));
        }
        let le = (raw as u64).to_le_bytes();
        let slot = &mut bytes[field.bytes()];
        for (i, b) in slot.iter_mut().enumerate() {
            *b = match self.byte_order {
                ByteOrder::Little => le[i],
                ByteOrder::Big => le[field.size - 1 - i],
            };
        }
        Ok(())
    }
    fn get(&self, bytes: &[u8], field: &Field) -> i64 {
        let slot = &bytes[field.bytes()];
        let mut raw: u64 = 0;
        for i in 0..field.size {
            let b = match self.byte_order {
                ByteOrder::Little => slot[field.size - 1 - i],
                ByteOrder::Big => slot[i],
            };
            raw = (raw << 8) | b as u64;
        }
        if field.signed {
            let shift = 64 - 8 * field.size as u32;
            ((raw << shift) as i64) >> shift
        } else {
            raw as i64
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Timing {
    /// How long to wait for a response report.
    pub response_timeout_ms: u32,
    /// How long to wait for the device to come back after a commit.
    pub reconnect_timeout_ms: u32,
}
impl Default for Timing {
    fn default() -> Self {
        Self {
            response_timeout_ms: 1000,
            reconnect_timeout_ms: 5000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DspModel {
    /// Sample rate the response graph assumes.
    pub sample_rate_hz: u32,
}
impl Default for DspModel {
    fn default() -> Self {
        Self {
            sample_rate_hz: 48_000,
        }
    }
}

/// The register that switches the custom EQ on or off. Its first value byte holds `on` or `off`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EqSwitch {
    #[serde(with = "hex::u8")]
    pub register: u8,
    /// Value bytes sent with a read of this register (the CHU II DSP expects `03 00 00 00`).
    /// Empty means zeros.
    #[serde(default, with = "hex::bytes")]
    pub read_argument: Vec<u8>,
    #[serde(with = "hex::u8")]
    pub on: u8,
    #[serde(with = "hex::u8")]
    pub off: u8,
}

/// Band `i` uses the `registers_per_band` registers starting at `first_register + i * stride`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BandLayout {
    pub count: usize,
    #[serde(with = "hex::u8")]
    pub first_register: u8,
    pub stride: u8,
    #[serde(default = "two")]
    pub registers_per_band: usize,
}
fn two() -> usize {
    2
}

/// Device byte for each filter shape; `null` or missing means the device has no such filter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilterCodes {
    #[serde(with = "hex::opt_u8")]
    pub peaking: Option<u8>,
    #[serde(default, with = "hex::opt_u8")]
    pub low_shelf: Option<u8>,
    #[serde(default, with = "hex::opt_u8")]
    pub high_shelf: Option<u8>,
    #[serde(default, with = "hex::opt_u8", skip_serializing_if = "Option::is_none")]
    pub low_pass: Option<u8>,
    #[serde(default, with = "hex::opt_u8", skip_serializing_if = "Option::is_none")]
    pub high_pass: Option<u8>,
    #[serde(default, with = "hex::opt_u8", skip_serializing_if = "Option::is_none")]
    pub band_pass: Option<u8>,
    #[serde(default, with = "hex::opt_u8", skip_serializing_if = "Option::is_none")]
    pub notch: Option<u8>,
}
impl FilterCodes {
    pub fn code(&self, kind: FilterType) -> Option<u8> {
        match kind {
            FilterType::Peaking => self.peaking,
            FilterType::LowShelf => self.low_shelf,
            FilterType::HighShelf => self.high_shelf,
            FilterType::LowPass => self.low_pass,
            FilterType::HighPass => self.high_pass,
            FilterType::BandPass => self.band_pass,
            FilterType::Notch => self.notch,
        }
    }
    pub fn kind(&self, code: u8) -> Option<FilterType> {
        FilterType::ALL
            .into_iter()
            .find(|&k| self.code(k) == Some(code))
    }
    pub fn supported(&self) -> Vec<FilterType> {
        FilterType::ALL
            .into_iter()
            .filter(|&k| self.code(k).is_some())
            .collect()
    }
}

#[derive(Debug, Copy, Clone, PartialEq, Serialize, Deserialize)]
pub struct Range {
    pub min: f64,
    pub max: f64,
}
impl Range {
    fn contains(&self, v: f64) -> bool {
        // Values are canonical to 6 decimals; allow for float rounding at the ends.
        v >= self.min - 1e-9 && v <= self.max + 1e-9
    }
}

/// Values the device accepts, in natural units.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Limits {
    pub gain_db: Range,
    pub frequency_hz: Range,
    pub q: Range,
}

fn is_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_')
}

/// Whether two byte ranges `[a, a + la)` and `[b, b + lb)` overlap.
fn overlaps(a: usize, la: usize, b: usize, lb: usize) -> bool {
    a < b + lb && b < a + la
}

impl Profile {
    pub fn from_json(text: &str) -> Result<Self> {
        let profile: Profile = serde_json::from_str(text)
            .map_err(|e| Error::Invalid(format!("profile JSON: {e}")))?;
        profile.validate()?;
        Ok(profile)
    }
    pub fn to_json(&self) -> Result<String> {
        serde_json::to_string_pretty(self)
            .map(|s| s + "\n")
            .map_err(|e| Error::Invalid(e.to_string()))
    }

    /// Structural checks, so a profile can never address a register past 0xFF, build a report
    /// or band whose fields overlap, collide two filter codes, describe an audible unused-slot
    /// filler, or allow values its encoding cannot hold.
    pub fn validate(&self) -> Result<()> {
        let bad = |m: String| Err(Error::Invalid(format!("profile {}: {m}", self.id)));
        if !is_id(&self.id) {
            return bad("id must be 1-64 characters of a-z, 0-9, - and _".into());
        }
        if self.title.trim().is_empty() {
            return bad("title is empty".into());
        }
        let p = &self.protocol;

        // Report frame.
        let f = &p.frame;
        if !(2..=MAX_REPORT_LEN).contains(&f.length) {
            return bad(format!("frame.length must be 2 to {MAX_REPORT_LEN}"));
        }
        if !(1..=MAX_VALUE_LEN).contains(&f.value_length) {
            return bad(format!("frame.value_length must be 1 to {MAX_VALUE_LEN}"));
        }
        let fields = [
            ("register_offset", f.register_offset, 1),
            ("command_offset", f.command_offset, 1),
            ("value_offset", f.value_offset, f.value_length),
        ];
        for (i, &(name, at, len)) in fields.iter().enumerate() {
            if at == 0 || at + len > f.length {
                return bad(format!(
                    "frame.{name} must be 1 or more and fit in frame.length (byte 0 is the report ID)"
                ));
            }
            for &(other, at2, len2) in &fields[..i] {
                if overlaps(at, len, at2, len2) {
                    return bad(format!("frame.{name} overlaps frame.{other}"));
                }
            }
        }
        if f.echo_length <= f.register_offset.max(f.command_offset) || f.echo_length > f.value_offset {
            return bad("frame.echo_length must cover the register and command bytes but not the value".into());
        }

        // Band registers.
        let b = &p.bands;
        if b.count == 0 || b.count > MAX_BANDS {
            return bad(format!("bands.count must be 1 to {MAX_BANDS}"));
        }
        if !(1..=MAX_REGISTERS_PER_BAND).contains(&b.registers_per_band) {
            return bad(format!("bands.registers_per_band must be 1 to {MAX_REGISTERS_PER_BAND}"));
        }
        if (b.stride as usize) < b.registers_per_band {
            return bad("bands.stride must be at least registers_per_band".into());
        }
        let last = b.first_register as usize + (b.count - 1) * b.stride as usize + b.registers_per_band - 1;
        if last > 0xFF {
            return bad(format!("band registers run past 0xFF (last would be 0x{last:X})"));
        }
        let band_regs: Vec<u8> = (0..b.count).flat_map(|i| self.band_registers(i)).collect();
        if let Some(sw) = &p.eq_switch {
            if band_regs.contains(&sw.register) {
                return bad("eq_switch.register overlaps a band register".into());
            }
            if sw.on == sw.off {
                return bad("eq_switch.on and eq_switch.off must differ".into());
            }
            if sw.read_argument.len() > f.value_length {
                return bad("eq_switch.read_argument is longer than frame.value_length".into());
            }
        }
        if p.pregain_register.is_some_and(|r| band_regs.contains(&r)) {
            return bad("pregain_register overlaps a band register".into());
        }
        if p.read_command == p.write_command
            || Some(p.write_command) == p.commit_command
            || Some(p.read_command) == p.commit_command
        {
            return bad("read, write and commit commands must differ".into());
        }

        // Band encoding.
        let e = &p.band_encoding;
        let band_len = b.registers_per_band * f.value_length;
        let named = e.fields();
        for (i, &(name, field)) in named.iter().enumerate() {
            if !(1..=4).contains(&field.size) {
                return bad(format!("band_encoding.{name}.size must be 1 to 4"));
            }
            if field.offset + field.size > band_len {
                return bad(format!(
                    "band_encoding.{name} runs past the band's {band_len} bytes (registers_per_band × value_length)"
                ));
            }
            if name != "filter" && !(field.step.is_finite() && field.step > 0.0) {
                return bad(format!("band_encoding.{name}.step must be positive"));
            }
            for &(other, field2) in &named[..i] {
                if overlaps(field.offset, field.size, field2.offset, field2.size) {
                    return bad(format!("band_encoding.{name} overlaps band_encoding.{other}"));
                }
            }
        }
        if !e.gain.signed {
            return bad("band_encoding.gain must be signed (cuts are negative)".into());
        }

        // Filter codes.
        let codes: Vec<u8> = FilterType::ALL
            .into_iter()
            .filter_map(|k| p.filter_codes.code(k))
            .collect();
        if p.filter_codes.peaking.is_none() {
            return bad("filter_codes.peaking is required".into());
        }
        if (1..codes.len()).any(|i| codes[..i].contains(&codes[i])) {
            return bad("filter codes must be distinct".into());
        }
        let (_, code_max) = e.filter.range();
        if codes.iter().any(|&c| c as i64 > code_max) {
            return bad("a filter code does not fit band_encoding.filter".into());
        }

        if p.timing.response_timeout_ms == 0 || p.timing.response_timeout_ms > 60_000 {
            return bad("timing.response_timeout_ms must be 1 to 60000".into());
        }
        if p.timing.reconnect_timeout_ms > 120_000 {
            return bad("timing.reconnect_timeout_ms must be at most 120000".into());
        }
        if !(8_000..=384_000).contains(&self.dsp.sample_rate_hz) {
            return bad("dsp.sample_rate_hz must be 8000 to 384000".into());
        }

        // Limits must be representable in the encoding.
        let l = &self.limits;
        for (name, r, field) in [
            ("gain_db", l.gain_db, &e.gain),
            ("frequency_hz", l.frequency_hz, &e.frequency),
            ("q", l.q, &e.q),
        ] {
            if !(r.min.is_finite() && r.max.is_finite() && r.min < r.max) {
                return bad(format!("limits.{name} needs finite min < max"));
            }
            let (lo, hi) = field.range();
            if (r.min / field.step).round() < lo as f64 || (r.max / field.step).round() > hi as f64 {
                return bad(format!("limits.{name} does not fit its band_encoding field"));
            }
        }
        if l.frequency_hz.min <= 0.0 || l.q.min <= 0.0 {
            return bad("limits.frequency_hz and limits.q must be positive".into());
        }
        if p.unused_band.gain_db != 0.0 || !p.unused_band.filter_type.has_gain() {
            return bad("unused_band must be a 0 dB peaking or shelf filter".into());
        }
        self.validate_band(&p.unused_band)?;
        if self.quantize_band(&p.unused_band)? != p.unused_band {
            return bad("unused_band must be representable exactly in band_encoding steps".into());
        }
        Ok(())
    }

    // Reports

    /// A request report for `register` and `command` carrying `value` (zero-padded to
    /// `frame.value_length`).
    pub fn request(&self, register: u8, command: u8, value: &[u8]) -> Result<Vec<u8>> {
        let f = &self.protocol.frame;
        if value.len() > f.value_length {
            return Err(Error::Invalid(format!(
                "value is {} bytes; the profile's values are {}",
                value.len(),
                f.value_length
            )));
        }
        let mut report = vec![0u8; f.length];
        report[0] = self.protocol.report_id;
        report[f.register_offset] = register;
        report[f.command_offset] = command;
        report[f.value_offset..f.value_offset + value.len()].copy_from_slice(value);
        Ok(report)
    }
    /// The value in a response to `request`, after checking that it echoes the request header.
    pub fn response_value(&self, request: &[u8], response: &[u8]) -> Result<Vec<u8>> {
        let f = &self.protocol.frame;
        if response.len() < f.length || response[..f.echo_length] != request[..f.echo_length] {
            return Err(Error::Protocol(format!(
                "unexpected response to {}: {}",
                hex_bytes(request),
                hex_bytes(response)
            )));
        }
        Ok(response[f.value_offset..f.value_offset + f.value_length].to_vec())
    }
    /// A register value whose first byte is `byte` (switch values, pregain).
    pub fn byte_value(&self, byte: u8) -> Vec<u8> {
        let mut value = vec![0u8; self.protocol.frame.value_length];
        value[0] = byte;
        value
    }

    // Registers

    pub fn band_registers(&self, index: usize) -> Vec<u8> {
        let b = &self.protocol.bands;
        let first = b.first_register as usize + index * b.stride as usize;
        (0..b.registers_per_band).map(|k| (first + k) as u8).collect()
    }
    /// Band index and register position within the band for a band register.
    pub fn band_of_register(&self, register: u8) -> Option<(usize, usize)> {
        (0..self.protocol.bands.count).find_map(|i| {
            let regs = self.band_registers(i);
            regs.iter().position(|&r| r == register).map(|k| (i, k))
        })
    }
    pub fn switch_enabled(&self, value: u8) -> Result<bool> {
        let Some(s) = &self.protocol.eq_switch else {
            return Ok(true);
        };
        match value {
            v if v == s.on => Ok(true),
            v if v == s.off => Ok(false),
            v => Err(Error::Protocol(format!(
                "EQ switch register holds 0x{v:02X}, expected 0x{:02X} (on) or 0x{:02X} (off)",
                s.on, s.off
            ))),
        }
    }

    // Band values

    /// The register values for `band`, one per band register.
    pub fn encode_band(&self, band: &Band) -> Result<Vec<Vec<u8>>> {
        let code = self.protocol.filter_codes.code(band.filter_type).ok_or_else(|| {
            Error::Invalid(format!(
                "{} has no {} filter",
                self.title,
                band.filter_type.name()
            ))
        })?;
        let e = &self.protocol.band_encoding;
        let value_length = self.protocol.frame.value_length;
        let mut bytes = vec![0u8; self.protocol.bands.registers_per_band * value_length];
        let scaled = |v: f64, f: &Field| (v / f.step).round() as i64;
        e.put(&mut bytes, &e.gain, scaled(band.gain_db, &e.gain))?;
        e.put(&mut bytes, &e.frequency, scaled(band.frequency_hz, &e.frequency))?;
        e.put(&mut bytes, &e.q, scaled(band.q, &e.q))?;
        e.put(&mut bytes, &e.filter, code as i64)?;
        Ok(bytes.chunks(value_length).map(<[u8]>::to_vec).collect())
    }
    /// A band from its register values (as returned by `encode_band`).
    pub fn decode_band(&self, values: &[Vec<u8>]) -> Result<Band> {
        let e = &self.protocol.band_encoding;
        let bytes: Vec<u8> = values.concat();
        if bytes.len() != self.protocol.bands.registers_per_band * self.protocol.frame.value_length {
            return Err(Error::Protocol("wrong number of band bytes".into()));
        }
        let covered: Vec<usize> = e.fields().iter().flat_map(|(_, f)| f.bytes()).collect();
        if let Some(i) = (0..bytes.len()).find(|i| !covered.contains(i) && bytes[*i] != 0) {
            return Err(Error::Protocol(format!(
                "unexpected byte 0x{:02X} at band byte {i}, which no field covers",
                bytes[i]
            )));
        }
        let code = e.get(&bytes, &e.filter);
        let filter_type = u8::try_from(code)
            .ok()
            .and_then(|c| self.protocol.filter_codes.kind(c))
            .ok_or_else(|| Error::Protocol(format!("unknown filter code 0x{code:02X}")))?;
        let value = |f: &Field| canonical(e.get(&bytes, f) as f64 * f.step);
        Band::new(value(&e.gain), value(&e.frequency), value(&e.q), filter_type)
            .map_err(|err| Error::Protocol(err.to_string()))
    }
    /// `band` as the device will store it (rounded to its encoding steps).
    pub fn quantize_band(&self, band: &Band) -> Result<Band> {
        self.decode_band(&self.encode_band(band)?)
    }
    /// `state` as the device will store and report it.
    pub fn quantize_eq(&self, state: &EqState) -> Result<EqState> {
        Ok(EqState {
            enabled: state.enabled,
            bands: state
                .bands
                .iter()
                .map(|b| self.quantize_band(b))
                .collect::<Result<_>>()?,
        })
    }

    pub fn validate_band(&self, band: &Band) -> Result<()> {
        let l = &self.limits;
        if !l.gain_db.contains(band.gain_db) {
            return Err(Error::Invalid(format!(
                "gain {} dB is outside {} to {} dB",
                band.gain_db, l.gain_db.min, l.gain_db.max
            )));
        }
        if !l.frequency_hz.contains(band.frequency_hz) {
            return Err(Error::Invalid(format!(
                "frequency {} Hz is outside {} to {} Hz",
                band.frequency_hz, l.frequency_hz.min, l.frequency_hz.max
            )));
        }
        if !l.q.contains(band.q) {
            return Err(Error::Invalid(format!(
                "Q {} is outside {} to {}",
                band.q, l.q.min, l.q.max
            )));
        }
        if self.protocol.filter_codes.code(band.filter_type).is_none() {
            return Err(Error::Invalid(format!(
                "{} has no {} filter",
                self.title,
                band.filter_type.name()
            )));
        }
        Ok(())
    }
    pub fn validate_eq(&self, state: &EqState) -> Result<()> {
        let capacity = self.protocol.bands.count;
        if state.bands.len() > capacity {
            return Err(Error::Invalid(format!(
                "{} supports at most {capacity} bands, got {}",
                self.title,
                state.bands.len()
            )));
        }
        if !state.enabled && self.protocol.eq_switch.is_none() {
            return Err(Error::Unsupported(format!(
                "{} has no EQ on/off switch",
                self.title
            )));
        }
        for (i, band) in state.bands.iter().enumerate() {
            self.validate_band(band)
                .map_err(|e| Error::Invalid(format!("band {}: {e}", i + 1)))?;
        }
        Ok(())
    }
}

/// Profiles shipped with the library. Keep each file listed here.
const BUILTIN_SOURCES: &[&str] = &[include_str!("../profiles/chu2-dsp.json")];

pub static BUILTIN: LazyLock<Vec<Profile>> = LazyLock::new(|| {
    BUILTIN_SOURCES
        .iter()
        .map(|s| Profile::from_json(s).expect("built-in profile is valid"))
        .collect()
});

/// A built-in profile by ID.
pub fn builtin(id: &str) -> Option<&'static Profile> {
    BUILTIN.iter().find(|p| p.id == id)
}
