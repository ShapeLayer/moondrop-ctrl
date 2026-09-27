#ifndef MOONDROP_CTRL_H
#define MOONDROP_CTRL_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

/* ABI version 2. All functions return 0 on success unless otherwise noted; -1 on error, with
   md_last_error describing it.
   Changes from version 1: md_eq_state.slot became md_eq_state.enabled; profiles are data
   (md_open_transport_json); md_restore_original_snapshot was removed because snapshots are
   now per user (see the data folder's snapshots/). */
uint32_t md_abi_version(void);
/* Returns required size including NUL. Copies a truncated, NUL-terminated message if buffer is smaller. */
size_t md_last_error(char *buffer, size_t capacity);

typedef struct md_device md_device;
/* Natural units. Values are rounded to the profile's band_encoding steps when written. */
typedef struct {
    double gain_db;
    double frequency_hz;
    double q;
    uint8_t filter_type; /* 0 peaking, 1 low pass, 2 high pass, 3 low shelf, 4 high shelf, 5 band pass,
                            6 notch; the profile maps these to device bytes */
    uint8_t reserved[7];
} md_band;
#define MD_MAX_BANDS 16
typedef struct {
    uint8_t enabled; /* 1 custom EQ on, 0 bypassed (always 1 for profiles without an EQ switch) */
    uint8_t band_count; /* active bands in bands[]; at most the profile's band count */
    uint8_t reserved[2];
    md_band bands[MD_MAX_BANDS];
} md_eq_state;

/* request and response are report_len bytes (the profile's protocol.frame.length); timeout_ms
   is the profile's protocol.timing.response_timeout_ms. */
typedef int32_t (*md_transact_fn)(void *user, const uint8_t *request,
    uint8_t *response, size_t report_len, uint32_t timeout_ms);
typedef void (*md_close_fn)(void *user);
typedef struct {
    uint32_t abi_version; /* set to 1 */
    void *user;
    md_transact_fn transact;
    md_close_fn close; /* optional; called when md_device is closed */
} md_transport_v1;

/* Built-in HID transport (macOS; Windows and Linux via hidapi). Opens the first connected device
   matching a built-in or user profile (user profiles come from the data folder, see README). */
md_device *md_open_default(void);
/* Host-supplied HID transport for Android, iOS, or other platforms, with a built-in or user
   profile ID... */
md_device *md_open_transport(const md_transport_v1 *callbacks, const char *profile_id);
/* ...or with a profile given as JSON (schemas/profile.schema.json). */
md_device *md_open_transport_json(const md_transport_v1 *callbacks, const char *profile_json);
void md_close(md_device *device);
/* The open device's profile as JSON. Returns the size needed including NUL (0 on error); copies
   only when the buffer is large enough. */
size_t md_device_profile_json(md_device *device, char *buffer, size_t capacity);

int32_t md_read_eq(md_device *device, md_eq_state *out);
/* Temporary write with readback and best-effort rollback on failure. Explicit md_commit is required to persist.
   Values are checked against the profile's limits. Device slots past band_count are cleared;
   md_read_eq leaves cleared slots out. */
int32_t md_apply_eq(md_device *device, const md_eq_state *state);
/* Device restarts. Reopen and call md_read_eq to verify persistence. */
int32_t md_commit(md_device *device);
/* Register values are the profile's protocol.frame.value_length bytes. out_len (optional)
   receives the length read; md_write_register needs exactly value_length bytes. */
int32_t md_read_register(md_device *device, uint8_t reg, uint8_t *out, size_t capacity, size_t *out_len);
int32_t md_write_register(md_device *device, uint8_t reg, const uint8_t *value, size_t len);
/* Expert escape hatch: a full HID report (the profile's frame length, report ID in byte 0).
   The response is as long as the request and must fit response_capacity. */
int32_t md_raw_command(md_device *device, const uint8_t *request, size_t request_len,
    uint8_t *response, size_t response_capacity);
/* Experimental: register round-trip works, audible pregain effect is unverified. Fails when the
   profile has no pregain register. */
int32_t md_read_pregain_db(md_device *device, int8_t *out);
int32_t md_write_pregain_db(md_device *device, int8_t gain);

/* Every built-in and user profile / preset (plus snapshots) as JSON:
   {"items": [...], "issues": [...]} with each item carrying "source" and "path". Returns the size
   needed including NUL (0 on error); copies only when the buffer is large enough. */
size_t md_profiles_json(char *buffer, size_t capacity);
size_t md_presets_json(char *buffer, size_t capacity);

/* Built-in presets. */
size_t md_preset_count(void);
int32_t md_preset_get(size_t index, char *id_buffer, size_t id_capacity, md_eq_state *out);
/* Built-in, user, or snapshot preset by ID; refused if it does not fit the device's profile. */
int32_t md_apply_preset(md_device *device, const char *id);
/* Built-in profiles. */
size_t md_profile_count(void);
int32_t md_profile_get(size_t index, char *id_buffer, size_t id_capacity,
    uint16_t *vendor, uint16_t *product, uint8_t *band_count);

#ifdef __cplusplus
}
#endif
#endif
