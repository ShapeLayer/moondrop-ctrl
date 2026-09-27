//! Serde helpers for byte and ID fields in profile files. They are written as `"0x31B2"` so
//! they read like USB IDs and register addresses do in datasheets; plain JSON numbers are
//! accepted too.

use serde::{de::Error as _, Deserialize, Deserializer, Serializer};

#[derive(Deserialize)]
#[serde(untagged)]
enum Number {
    Int(u64),
    Text(String),
}

fn parse(value: Number, max: u64) -> Result<u64, String> {
    let n = match value {
        Number::Int(n) => n,
        Number::Text(s) => {
            let s = s.trim();
            match s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
                Some(hex) => u64::from_str_radix(hex, 16),
                None => s.parse(),
            }
            .map_err(|_| format!("expected a number or 0x-prefixed hex, got {s:?}"))?
        }
    };
    if n > max {
        return Err(format!("{n} is larger than {max}"));
    }
    Ok(n)
}

macro_rules! hex_module {
    ($name:ident, $opt:ident, $ty:ty, $width:literal) => {
        pub mod $name {
            use super::*;
            pub fn serialize<S: Serializer>(v: &$ty, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(&format!(concat!("0x{:0", $width, "X}"), v))
            }
            pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<$ty, D::Error> {
                parse(Number::deserialize(d)?, <$ty>::MAX as u64)
                    .map(|n| n as $ty)
                    .map_err(D::Error::custom)
            }
        }
        pub mod $opt {
            use super::*;
            pub fn serialize<S: Serializer>(v: &Option<$ty>, s: S) -> Result<S::Ok, S::Error> {
                match v {
                    Some(v) => super::$name::serialize(v, s),
                    None => s.serialize_none(),
                }
            }
            pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<$ty>, D::Error> {
                match Option::<Number>::deserialize(d)? {
                    Some(n) => parse(n, <$ty>::MAX as u64)
                        .map(|n| Some(n as $ty))
                        .map_err(D::Error::custom),
                    None => Ok(None),
                }
            }
        }
    };
}
hex_module!(u8, opt_u8, u8, 2);
hex_module!(u16, opt_u16, u16, 4);

/// Register bytes as `["0x03", "0x00", "0x00", "0x00"]`.
pub mod bytes {
    use super::*;
    use serde::ser::SerializeSeq;
    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> Result<S::Ok, S::Error> {
        let mut seq = s.serialize_seq(Some(v.len()))?;
        for b in v {
            seq.serialize_element(&format!("0x{b:02X}"))?;
        }
        seq.end()
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        Vec::<Number>::deserialize(d)?
            .into_iter()
            .map(|n| parse(n, 255).map(|n| n as u8).map_err(D::Error::custom))
            .collect()
    }
}
