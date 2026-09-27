use moondrop_core::library::Library;
use moondrop_core::ops;
use moondrop_core::presets;
use moondrop_core::profiles::{self, Profile};
use moondrop_core::protocol::{Band, Device, EqState, Error, FilterType, Result, Transport};
use std::cell::RefCell;
use std::ffi::{c_char, c_void, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;

thread_local! { static LAST_ERROR: RefCell<CString> = RefCell::new(CString::new("no error").unwrap()); }
fn set_error(error: impl ToString) {
    let safe = error.to_string().replace('\0', " ");
    LAST_ERROR.with(|s| *s.borrow_mut() = CString::new(safe).unwrap());
}
fn guarded(f: impl FnOnce() -> Result<()>) -> i32 {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(())) => 0,
        Ok(Err(e)) => {
            set_error(e);
            -1
        }
        Err(_) => {
            set_error("panic crossing FFI boundary prevented");
            -2
        }
    }
}
fn open_guarded(f: impl FnOnce() -> Result<MdDevice>) -> *mut MdDevice {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(device)) => Box::into_raw(Box::new(device)),
        Ok(Err(e)) => {
            set_error(e);
            ptr::null_mut()
        }
        Err(_) => {
            set_error("panic crossing FFI boundary prevented");
            ptr::null_mut()
        }
    }
}
fn device<'a>(handle: *mut MdDevice) -> Result<&'a mut MdDevice> {
    unsafe { handle.as_mut() }.ok_or_else(|| Error::Invalid("null device handle".into()))
}
unsafe fn c_string<'a>(ptr: *const c_char) -> Result<&'a str> {
    if ptr.is_null() {
        return Err(Error::Invalid("null string".into()));
    }
    CStr::from_ptr(ptr)
        .to_str()
        .map_err(|_| Error::Invalid("string is not UTF-8".into()))
}
unsafe fn output<'a, T>(ptr: *mut T) -> Result<&'a mut T> {
    ptr.as_mut()
        .ok_or_else(|| Error::Invalid("null output pointer".into()))
}

#[repr(C)]
#[derive(Copy, Clone, Default)]
pub struct MdBand {
    pub gain_db: f64,
    pub frequency_hz: f64,
    pub q: f64,
    pub filter_type: u8,
    pub reserved: [u8; 7],
}
/// Capacity of `MdEqState::bands`; every profile's `band_count` must fit.
pub const MD_MAX_BANDS: usize = 16;
#[repr(C)]
#[derive(Copy, Clone, Default)]
pub struct MdEqState {
    /// 1 when the custom EQ is on, 0 when it is bypassed.
    pub enabled: u8,
    pub band_count: u8,
    pub reserved: [u8; 2],
    pub bands: [MdBand; MD_MAX_BANDS],
}
impl TryFrom<MdEqState> for EqState {
    type Error = Error;
    fn try_from(value: MdEqState) -> Result<Self> {
        let count = value.band_count as usize;
        if count > MD_MAX_BANDS {
            return Err(Error::Invalid(format!("band_count must be at most {MD_MAX_BANDS}")));
        }
        let bands = value.bands[..count]
            .iter()
            .map(|b| Band::new(b.gain_db, b.frequency_hz, b.q, FilterType::try_from(b.filter_type)?))
            .collect::<Result<Vec<_>>>()?;
        if value.enabled > 1 {
            return Err(Error::Invalid("enabled must be 0 or 1".into()));
        }
        Ok(EqState {
            enabled: value.enabled == 1,
            bands,
        })
    }
}
impl From<&EqState> for MdEqState {
    /// Callers pass states read from a device or presets, which never exceed `MD_MAX_BANDS`.
    fn from(value: &EqState) -> Self {
        let mut result = Self {
            enabled: value.enabled as u8,
            band_count: value.bands.len().min(MD_MAX_BANDS) as u8,
            ..Self::default()
        };
        for (target, source) in result.bands.iter_mut().zip(&value.bands) {
            *target = MdBand {
                gain_db: source.gain_db,
                frequency_hz: source.frequency_hz,
                q: source.q,
                filter_type: source.filter_type as u8,
                reserved: [0; 7],
            };
        }
        result
    }
}

pub type MdTransact = unsafe extern "C" fn(
    user: *mut c_void,
    request: *const u8,
    response: *mut u8,
    report_len: usize,
    timeout_ms: u32,
) -> i32;
pub type MdClose = unsafe extern "C" fn(user: *mut c_void);
#[repr(C)]
#[derive(Copy, Clone)]
pub struct MdTransportV1 {
    pub abi_version: u32,
    pub user: *mut c_void,
    pub transact: Option<MdTransact>,
    pub close: Option<MdClose>,
}
struct CallbackTransport {
    callbacks: MdTransportV1,
    timeout_ms: u32,
}
impl Transport for CallbackTransport {
    fn transact(&mut self, request: &[u8]) -> Result<Vec<u8>> {
        let mut response = vec![0u8; request.len()];
        let callback = self
            .callbacks
            .transact
            .ok_or_else(|| Error::Invalid("missing transact callback".into()))?;
        let status = unsafe {
            callback(
                self.callbacks.user,
                request.as_ptr(),
                response.as_mut_ptr(),
                request.len(),
                self.timeout_ms,
            )
        };
        if status == 0 {
            Ok(response)
        } else {
            Err(Error::Transport(format!(
                "host HID callback returned {status}"
            )))
        }
    }
}
impl Drop for CallbackTransport {
    fn drop(&mut self) {
        if let Some(close) = self.callbacks.close {
            unsafe { close(self.callbacks.user) }
        }
    }
}

pub struct MdDevice {
    inner: Device<Box<dyn Transport>>,
}
#[no_mangle]
pub extern "C" fn md_abi_version() -> u32 {
    2
}
/// # Safety
/// All non-null pointers must reference valid storage for the documented sizes. Device handles
/// must come from this library, remain open, and be used by only one caller at a time.
#[no_mangle]
pub unsafe extern "C" fn md_last_error(buffer: *mut c_char, capacity: usize) -> usize {
    LAST_ERROR.with(|s| {
        let value = s.borrow();
        let bytes = value.as_bytes_with_nul();
        if !buffer.is_null() && capacity > 0 {
            let n = (capacity - 1).min(bytes.len() - 1);
            unsafe {
                ptr::copy_nonoverlapping(bytes.as_ptr(), buffer as *mut u8, n);
                *buffer.add(n) = 0;
            }
        }
        bytes.len()
    })
}
#[no_mangle]
pub extern "C" fn md_open_default() -> *mut MdDevice {
    open_guarded(|| {
        let device = ops::open_first(&Library::open_default().profile_list())?;
        let profile = device.profile().clone();
        Ok(MdDevice {
            inner: Device::new(
                Box::new(device.into_transport()) as Box<dyn Transport>,
                profile,
            ),
        })
    })
}
/// # Safety
/// All non-null pointers must reference valid storage for the documented sizes. Device handles
/// must come from this library, remain open, and be used by only one caller at a time.
#[no_mangle]
pub unsafe extern "C" fn md_open_transport(
    callbacks: *const MdTransportV1,
    profile_id: *const c_char,
) -> *mut MdDevice {
    open_guarded(|| {
        let id = unsafe { c_string(profile_id) }?;
        let profile = Library::open_default().find_profile(id)?;
        unsafe { callback_device(callbacks, profile) }
    })
}
/// # Safety
/// As `md_open_transport`; `profile_json` is a NUL-terminated UTF-8 profile document.
#[no_mangle]
pub unsafe extern "C" fn md_open_transport_json(
    callbacks: *const MdTransportV1,
    profile_json: *const c_char,
) -> *mut MdDevice {
    open_guarded(|| {
        let profile = Profile::from_json(unsafe { c_string(profile_json) }?)?;
        unsafe { callback_device(callbacks, profile) }
    })
}
unsafe fn callback_device(callbacks: *const MdTransportV1, profile: Profile) -> Result<MdDevice> {
    let callbacks = unsafe { callbacks.as_ref() }
        .ok_or_else(|| Error::Invalid("null transport callbacks".into()))?;
    if callbacks.abi_version != 1 || callbacks.transact.is_none() {
        return Err(Error::Invalid(
            "unsupported callback ABI or missing transact".into(),
        ));
    }
    Ok(MdDevice {
        inner: Device::new(
            Box::new(CallbackTransport {
                callbacks: *callbacks,
                timeout_ms: profile.protocol.timing.response_timeout_ms,
            }) as Box<dyn Transport>,
            profile,
        ),
    })
}
/// # Safety
/// All non-null pointers must reference valid storage for the documented sizes. Device handles
/// must come from this library, remain open, and be used by only one caller at a time.
#[no_mangle]
pub unsafe extern "C" fn md_close(handle: *mut MdDevice) {
    if !handle.is_null() {
        unsafe {
            drop(Box::from_raw(handle));
        }
    }
}
/// # Safety
/// All non-null pointers must reference valid storage for the documented sizes. Device handles
/// must come from this library, remain open, and be used by only one caller at a time.
#[no_mangle]
pub unsafe extern "C" fn md_read_eq(handle: *mut MdDevice, out: *mut MdEqState) -> i32 {
    guarded(|| {
        let state = device(handle)?.inner.read_eq()?;
        *unsafe { output(out) }? = MdEqState::from(&state);
        Ok(())
    })
}
/// # Safety
/// All non-null pointers must reference valid storage for the documented sizes. Device handles
/// must come from this library, remain open, and be used by only one caller at a time.
#[no_mangle]
pub unsafe extern "C" fn md_apply_eq(handle: *mut MdDevice, state: *const MdEqState) -> i32 {
    guarded(|| {
        let state =
            *unsafe { state.as_ref() }.ok_or_else(|| Error::Invalid("null EQ state".into()))?;
        device(handle)?.inner.apply_eq(&EqState::try_from(state)?)
    })
}
/// # Safety
/// All non-null pointers must reference valid storage for the documented sizes. Device handles
/// must come from this library, remain open, and be used by only one caller at a time.
#[no_mangle]
pub unsafe extern "C" fn md_commit(handle: *mut MdDevice) -> i32 {
    guarded(|| device(handle)?.inner.commit())
}
/// # Safety
/// All non-null pointers must reference valid storage for the documented sizes. Device handles
/// must come from this library, remain open, and be used by only one caller at a time.
#[no_mangle]
pub unsafe extern "C" fn md_read_register(
    handle: *mut MdDevice,
    register: u8,
    out: *mut u8,
    capacity: usize,
    out_len: *mut usize,
) -> i32 {
    guarded(|| {
        if out.is_null() {
            return Err(Error::Invalid("null output buffer".into()));
        }
        let value = device(handle)?.inner.read_register(register)?;
        if value.len() > capacity {
            return Err(Error::Invalid(format!(
                "register value is {} bytes; buffer holds {capacity}",
                value.len()
            )));
        }
        unsafe {
            ptr::copy_nonoverlapping(value.as_ptr(), out, value.len());
            if let Some(len) = out_len.as_mut() {
                *len = value.len();
            }
        }
        Ok(())
    })
}
/// # Safety
/// All non-null pointers must reference valid storage for the documented sizes. Device handles
/// must come from this library, remain open, and be used by only one caller at a time.
#[no_mangle]
pub unsafe extern "C" fn md_write_register(
    handle: *mut MdDevice,
    register: u8,
    value: *const u8,
    len: usize,
) -> i32 {
    guarded(|| {
        if value.is_null() {
            return Err(Error::Invalid("null input buffer".into()));
        }
        let bytes = unsafe { std::slice::from_raw_parts(value, len) };
        device(handle)?.inner.write_register(register, bytes)
    })
}
/// # Safety
/// All non-null pointers must reference valid storage for the documented sizes. Device handles
/// must come from this library, remain open, and be used by only one caller at a time.
#[no_mangle]
pub unsafe extern "C" fn md_raw_command(
    handle: *mut MdDevice,
    request: *const u8,
    request_len: usize,
    response: *mut u8,
    response_capacity: usize,
) -> i32 {
    guarded(|| {
        if request.is_null() || response.is_null() || request_len == 0 {
            return Err(Error::Invalid("null or empty report buffer".into()));
        }
        let bytes = unsafe { std::slice::from_raw_parts(request, request_len) };
        let answer = device(handle)?.inner.raw_command(bytes)?;
        if answer.len() > response_capacity {
            return Err(Error::Invalid(format!(
                "response is {} bytes; buffer holds {response_capacity}",
                answer.len()
            )));
        }
        unsafe { ptr::copy_nonoverlapping(answer.as_ptr(), response, answer.len()) };
        Ok(())
    })
}
/// # Safety
/// All non-null pointers must reference valid storage for the documented sizes. Device handles
/// must come from this library, remain open, and be used by only one caller at a time.
#[no_mangle]
pub unsafe extern "C" fn md_read_pregain_db(handle: *mut MdDevice, out: *mut i8) -> i32 {
    guarded(|| {
        *unsafe { output(out) }? = device(handle)?.inner.read_pregain_db()?;
        Ok(())
    })
}
/// # Safety
/// All non-null pointers must reference valid storage for the documented sizes. Device handles
/// must come from this library, remain open, and be used by only one caller at a time.
#[no_mangle]
pub unsafe extern "C" fn md_write_pregain_db(handle: *mut MdDevice, gain: i8) -> i32 {
    guarded(|| device(handle)?.inner.write_pregain_db(gain))
}
#[no_mangle]
pub extern "C" fn md_preset_count() -> usize {
    presets::BUILTIN.len()
}
/// # Safety
/// All non-null pointers must reference valid storage for the documented sizes. Device handles
/// must come from this library, remain open, and be used by only one caller at a time.
#[no_mangle]
pub unsafe extern "C" fn md_preset_get(
    index: usize,
    id_buffer: *mut c_char,
    id_capacity: usize,
    out: *mut MdEqState,
) -> i32 {
    guarded(|| {
        let preset = presets::BUILTIN
            .get(index)
            .ok_or_else(|| Error::Invalid("preset index out of range".into()))?;
        if id_buffer.is_null() || id_capacity <= preset.id.len() {
            return Err(Error::Invalid("preset ID buffer too small".into()));
        }
        unsafe {
            ptr::copy_nonoverlapping(preset.id.as_ptr(), id_buffer as *mut u8, preset.id.len());
            *id_buffer.add(preset.id.len()) = 0;
            *output(out)? = MdEqState::from(&preset.eq.state());
        }
        Ok(())
    })
}
/// # Safety
/// All non-null pointers must reference valid storage for the documented sizes. Device handles
/// must come from this library, remain open, and be used by only one caller at a time.
#[no_mangle]
pub unsafe extern "C" fn md_apply_preset(handle: *mut MdDevice, id: *const c_char) -> i32 {
    guarded(|| {
        let name = unsafe { c_string(id) }?;
        let preset = Library::open_default().find_preset(name)?;
        let device = device(handle)?;
        preset.fits(device.inner.profile())?;
        device.inner.apply_eq(&preset.eq.state())
    })
}
/// # Safety
/// All non-null pointers must reference valid storage for the documented sizes. Device handles
/// must come from this library, remain open, and be used by only one caller at a time.
#[no_mangle]
pub unsafe extern "C" fn md_device_profile_json(
    handle: *mut MdDevice,
    buffer: *mut c_char,
    capacity: usize,
) -> usize {
    let Ok(device) = device(handle) else {
        set_error("null device handle");
        return 0;
    };
    let Ok(json) = device.inner.profile().to_json() else {
        return 0;
    };
    unsafe { copy_out(&json, buffer, capacity) }
}
/// Copies `text` NUL-terminated when it fits; returns the size needed including NUL.
unsafe fn copy_out(text: &str, buffer: *mut c_char, capacity: usize) -> usize {
    let bytes = text.as_bytes();
    if !buffer.is_null() && capacity > bytes.len() {
        unsafe {
            ptr::copy_nonoverlapping(bytes.as_ptr(), buffer as *mut u8, bytes.len());
            *buffer.add(bytes.len()) = 0;
        }
    }
    bytes.len() + 1
}
/// # Safety
/// `buffer` must be null or hold `capacity` bytes.
#[no_mangle]
pub unsafe extern "C" fn md_profiles_json(buffer: *mut c_char, capacity: usize) -> usize {
    match serde_json::to_string(&Library::open_default().profiles()) {
        Ok(json) => unsafe { copy_out(&json, buffer, capacity) },
        Err(e) => {
            set_error(e);
            0
        }
    }
}
/// # Safety
/// `buffer` must be null or hold `capacity` bytes.
#[no_mangle]
pub unsafe extern "C" fn md_presets_json(buffer: *mut c_char, capacity: usize) -> usize {
    match serde_json::to_string(&Library::open_default().presets()) {
        Ok(json) => unsafe { copy_out(&json, buffer, capacity) },
        Err(e) => {
            set_error(e);
            0
        }
    }
}
#[no_mangle]
pub extern "C" fn md_profile_count() -> usize {
    profiles::BUILTIN.len()
}
/// # Safety
/// All non-null pointers must reference valid storage for the documented sizes. Device handles
/// must come from this library, remain open, and be used by only one caller at a time.
#[no_mangle]
pub unsafe extern "C" fn md_profile_get(
    index: usize,
    id_buffer: *mut c_char,
    id_capacity: usize,
    vendor: *mut u16,
    product: *mut u16,
    band_count: *mut u8,
) -> i32 {
    guarded(|| {
        let profile = profiles::BUILTIN
            .get(index)
            .ok_or_else(|| Error::Invalid("profile index out of range".into()))?;
        if id_buffer.is_null() || id_capacity <= profile.id.len() {
            return Err(Error::Invalid("profile ID buffer too small".into()));
        }
        unsafe {
            ptr::copy_nonoverlapping(profile.id.as_ptr(), id_buffer as *mut u8, profile.id.len());
            *id_buffer.add(profile.id.len()) = 0;
            *output(vendor)? = profile.usb.vendor_id;
            *output(product)? = profile.usb.product_id;
            *output(band_count)? = profile.protocol.bands.count as u8;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_profile_fits_the_c_band_array() {
        assert_eq!(profiles::MAX_BANDS, MD_MAX_BANDS);
        assert!(profiles::BUILTIN.iter().all(|p| p.protocol.bands.count <= MD_MAX_BANDS));
    }

    #[test]
    fn eq_state_round_trips_with_fewer_bands() {
        let mut state = presets::builtin("chu2-quiet-18db").unwrap().eq.state();
        state.bands.truncate(2);
        let c = MdEqState::from(&state);
        assert_eq!(c.band_count, 2);
        assert_eq!(EqState::try_from(c).unwrap(), state);
    }
}
