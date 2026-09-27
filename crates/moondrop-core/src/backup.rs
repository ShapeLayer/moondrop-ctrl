//! Timestamped, create-new JSON backups of device EQ state. A backup is an EQ file (it can be
//! imported like any preset file) that also names the profile it came from.

use crate::{EqState, Error, Result};
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
struct BackupFile<'a> {
    profile: &'a str,
    #[serde(flatten)]
    state: &'a EqState,
}

/// Writes `<directory>/<profile_id>-backup-<unix seconds>-<n>.json`.
pub fn save_eq(state: &EqState, directory: &Path, profile_id: &str) -> Result<PathBuf> {
    fs::create_dir_all(directory)
        .map_err(|e| Error::Invalid(format!("cannot create backup directory: {e}")))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| Error::Invalid(e.to_string()))?
        .as_secs();
    let data = serde_json::to_vec_pretty(&BackupFile {
        profile: profile_id,
        state,
    })
    .map_err(|e| Error::Invalid(e.to_string()))?;
    for index in 0..100 {
        let path = directory.join(format!("{profile_id}-backup-{stamp}-{index}.json"));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(&data)
                    .and_then(|_| file.write_all(b"\n"))
                    .map_err(|e| Error::Invalid(e.to_string()))?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(Error::Invalid(format!("cannot create backup: {e}"))),
        }
    }
    Err(Error::Invalid(
        "could not find a free backup filename".into(),
    ))
}
