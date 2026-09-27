//! Built-in HID transports: IOHIDManager on macOS (hardware-verified), hidapi on Windows and
//! Linux (not yet verified on hardware). Other hosts can supply their own [`Transport`], e.g.
//! through the C ABI callback.

use crate::profiles::{Profile, UsbMatch};
use crate::protocol::{Error, Result, Transport};
use serde::Serialize;

/// One HID interface as the OS reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HidInfo {
    pub vendor_id: u16,
    pub product_id: u16,
    pub usage_page: u16,
    pub usage: u16,
    pub manufacturer: String,
    pub product: String,
}
impl HidInfo {
    pub fn matches(&self, usb: &UsbMatch) -> bool {
        self.vendor_id == usb.vendor_id
            && self.product_id == usb.product_id
            && usb.usage_page.is_none_or(|p| p == self.usage_page)
            && usb.usage.is_none_or(|u| u == self.usage)
    }
}

fn ambiguous(count: i32, usb: &UsbMatch) -> Error {
    Error::Transport(format!(
        "{count} HID interfaces match {:04X}:{:04X}; set usb.usage_page (and usage) in the profile to pick one",
        usb.vendor_id, usb.product_id
    ))
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use std::ffi::{c_char, c_void, CStr};

    type Visit = unsafe extern "C" fn(*mut c_void, u16, u16, u16, u16, *const c_char, *const c_char);
    extern "C" {
        fn md_macos_open(
            vendor: u16,
            product: u16,
            usage_page: u16,
            usage: u16,
            report_id: u8,
            report_len: usize,
            matches: *mut i32,
        ) -> *mut c_void;
        fn md_macos_close(handle: *mut c_void);
        fn md_macos_transact(
            handle: *mut c_void,
            request: *const u8,
            len: usize,
            response: *mut u8,
            timeout_ms: u32,
            expect_reply: i32,
        ) -> i32;
        fn md_macos_enumerate(visit: Visit, context: *mut c_void) -> i32;
    }

    pub struct NativeTransport {
        handle: *mut c_void,
        timeout_ms: u32,
    }
    // The handle is only used by one thread at a time (callers serialize device access).
    unsafe impl Send for NativeTransport {}

    impl NativeTransport {
        pub fn open(profile: &Profile) -> Result<Self> {
            let usb = &profile.usb;
            let mut matches = 0;
            let handle = unsafe {
                md_macos_open(
                    usb.vendor_id,
                    usb.product_id,
                    usb.usage_page.unwrap_or(0),
                    usb.usage.unwrap_or(0),
                    profile.protocol.report_id,
                    profile.protocol.frame.length,
                    &mut matches,
                )
            };
            if !handle.is_null() {
                return Ok(Self {
                    handle,
                    timeout_ms: profile.protocol.timing.response_timeout_ms,
                });
            }
            Err(match matches {
                0 => Error::Transport(format!(
                    "no HID device {:04X}:{:04X} is connected",
                    usb.vendor_id, usb.product_id
                )),
                1 => Error::Transport("cannot open the HID device (is another app using it?)".into()),
                n => ambiguous(n, usb),
            })
        }
        fn call(&mut self, request: &[u8], reply: bool) -> Result<Vec<u8>> {
            let mut response = vec![0u8; request.len()];
            let status = unsafe {
                md_macos_transact(
                    self.handle,
                    request.as_ptr(),
                    request.len(),
                    response.as_mut_ptr(),
                    self.timeout_ms,
                    reply as i32,
                )
            };
            match status {
                0 => Ok(response),
                -1 => Err(Error::Invalid("report length or report ID does not match the profile".into())),
                -2 => Err(Error::Transport("no response from the device (timeout)".into())),
                s => Err(Error::Transport(format!("macOS HID transaction failed ({s})"))),
            }
        }
    }
    impl Transport for NativeTransport {
        fn transact(&mut self, request: &[u8]) -> Result<Vec<u8>> {
            self.call(request, true)
        }
        fn send(&mut self, request: &[u8]) -> Result<()> {
            self.call(request, false).map(|_| ())
        }
    }
    impl Drop for NativeTransport {
        fn drop(&mut self) {
            unsafe { md_macos_close(self.handle) }
        }
    }

    unsafe extern "C" fn visit(
        context: *mut c_void,
        vendor_id: u16,
        product_id: u16,
        usage_page: u16,
        usage: u16,
        manufacturer: *const c_char,
        product: *const c_char,
    ) {
        let list = unsafe { &mut *(context as *mut Vec<HidInfo>) };
        let text = |p: *const c_char| unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
        list.push(HidInfo {
            vendor_id,
            product_id,
            usage_page,
            usage,
            manufacturer: text(manufacturer),
            product: text(product),
        });
    }

    pub fn enumerate() -> Result<Vec<HidInfo>> {
        let mut list: Vec<HidInfo> = Vec::new();
        let status = unsafe { md_macos_enumerate(visit, &mut list as *mut _ as *mut c_void) };
        if status != 0 {
            return Err(Error::Transport("cannot list HID devices".into()));
        }
        Ok(list)
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
mod imp {
    use super::*;
    use hidapi::{DeviceInfo, HidApi, HidDevice};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    /// hidapi keeps global state; one shared instance, refreshed on every lookup.
    fn api() -> Result<std::sync::MutexGuard<'static, HidApi>> {
        static API: OnceLock<std::result::Result<Mutex<HidApi>, String>> = OnceLock::new();
        let api = API
            .get_or_init(|| HidApi::new().map(Mutex::new).map_err(|e| e.to_string()))
            .as_ref()
            .map_err(|e| Error::Transport(format!("hidapi: {e}")))?;
        let mut guard = api.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .refresh_devices()
            .map_err(|e| Error::Transport(format!("hidapi: {e}")))?;
        Ok(guard)
    }

    fn info(d: &DeviceInfo) -> HidInfo {
        HidInfo {
            vendor_id: d.vendor_id(),
            product_id: d.product_id(),
            usage_page: d.usage_page(),
            usage: d.usage(),
            manufacturer: d.manufacturer_string().unwrap_or_default().to_string(),
            product: d.product_string().unwrap_or_default().to_string(),
        }
    }

    pub struct NativeTransport {
        device: HidDevice,
        report_id: u8,
        timeout_ms: u32,
    }

    impl NativeTransport {
        pub fn open(profile: &Profile) -> Result<Self> {
            let usb = &profile.usb;
            let api = api()?;
            let mut candidates: Vec<&DeviceInfo> =
                api.device_list().filter(|d| info(d).matches(usb)).collect();
            // Windows lists each top-level collection separately. Without an explicit usage,
            // prefer vendor-defined collections, which is where control reports live.
            if candidates.len() > 1 && usb.usage_page.is_none() {
                let vendor: Vec<_> = candidates
                    .iter()
                    .copied()
                    .filter(|d| d.usage_page() >= 0xFF00)
                    .collect();
                if !vendor.is_empty() {
                    candidates = vendor;
                }
            }
            match candidates.as_slice() {
                [] => Err(Error::Transport(format!(
                    "no HID device {:04X}:{:04X} is connected",
                    usb.vendor_id, usb.product_id
                ))),
                [one] => {
                    let device = one
                        .open_device(&api)
                        .map_err(|e| Error::Transport(format!("cannot open HID device: {e}")))?;
                    Ok(Self {
                        device,
                        report_id: profile.protocol.report_id,
                        timeout_ms: profile.protocol.timing.response_timeout_ms,
                    })
                }
                many => Err(ambiguous(many.len() as i32, usb)),
            }
        }
    }
    impl Transport for NativeTransport {
        fn transact(&mut self, request: &[u8]) -> Result<Vec<u8>> {
            self.send(request)?;
            let deadline = Instant::now() + Duration::from_millis(self.timeout_ms as u64);
            let mut buffer = [0u8; 65];
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(Error::Transport("no response from the device (timeout)".into()));
                }
                let n = self
                    .device
                    .read_timeout(&mut buffer, left.as_millis().max(1) as i32)
                    .map_err(|e| Error::Transport(format!("HID read failed: {e}")))?;
                // Numbered reports arrive with the report ID in byte 0.
                if n >= request.len() && buffer[0] == self.report_id {
                    return Ok(buffer[..request.len()].to_vec());
                }
            }
        }
        fn send(&mut self, request: &[u8]) -> Result<()> {
            self.device
                .write(request)
                .map(|_| ())
                .map_err(|e| Error::Transport(format!("HID write failed: {e}")))
        }
    }

    pub fn enumerate() -> Result<Vec<HidInfo>> {
        Ok(api()?.device_list().map(info).collect())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod imp {
    use super::*;
    pub struct NativeTransport;
    fn unsupported() -> Error {
        Error::Unsupported(
            "no built-in HID transport on this platform; use the C callback transport".into(),
        )
    }
    impl NativeTransport {
        pub fn open(_: &Profile) -> Result<Self> {
            Err(unsupported())
        }
    }
    impl Transport for NativeTransport {
        fn transact(&mut self, _: &[u8]) -> Result<Vec<u8>> {
            Err(unsupported())
        }
    }
    pub fn enumerate() -> Result<Vec<HidInfo>> {
        Err(unsupported())
    }
}

pub use imp::{enumerate, NativeTransport};
