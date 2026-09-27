#include "moondrop_ctrl.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint8_t registers[256][4];
static unsigned commits = 0;

static void put_band(int i, int16_t gain, uint16_t freq, uint16_t q, uint8_t type) {
    uint8_t *a = registers[0x26 + 2*i];
    uint8_t *c = registers[0x27 + 2*i];
    a[0] = gain & 0xff;
    a[1] = (gain >> 8) & 0xff;
    a[2] = freq & 0xff;
    a[3] = freq >> 8;
    c[0] = q & 0xff;
    c[1] = q >> 8;
    c[2] = type;
    c[3] = 0;
}
/* Starting device state: EQ on with five peaking bands. */
static void load_device(void) {
    registers[0x24][0] = 3;
    put_band(0, -47, 25, 300, 0);
    put_band(1, -50, 200, 700, 0);
    put_band(2, -25, 1400, 1600, 0);
    put_band(3, -48, 3500, 1000, 0);
    put_band(4, -20, 9000, 1500, 0);
}
static int32_t fake_transact(void *user, const uint8_t *request, uint8_t *response,
                             size_t len, uint32_t timeout_ms) {
    (void)user; (void)timeout_ms;
    if (len != 11 || request[0] != 0x4B) return -1;
    uint8_t reg = request[1];
    memcpy(response, request, 11);
    switch (request[5]) {
        case 0x52: memcpy(response+7, registers[reg], 4); break;
        case 0x57: memcpy(registers[reg], request+7, 4); break;
        case 0x53: ++commits; break;
        default: return -2;
    }
    return 0;
}
/* A second fake device with another layout: 16-byte reports, report ID 0x4C, command at byte 1,
   register at byte 2, value at byte 8, no EQ switch, 8 bands from 0x40 with stride 3. */
static uint8_t other[256][4];
static int32_t other_transact(void *user, const uint8_t *request, uint8_t *response,
                              size_t len, uint32_t timeout_ms) {
    (void)user; (void)timeout_ms;
    if (len != 16 || request[0] != 0x4C) return -1;
    memcpy(response, request, 16);
    if (request[1] == 0x01) memcpy(response + 8, other[request[2]], 4);
    else if (request[1] == 0x02) memcpy(other[request[2]], request + 8, 4);
    else return -2;
    return 0;
}
static const char *OTHER_PROFILE =
    "{\"id\":\"other\",\"title\":\"Other\",\"usb\":{\"vendor_id\":\"0x1234\",\"product_id\":\"0x0001\"},"
    "\"protocol\":{\"report_id\":\"0x4C\",\"frame\":{\"length\":16,\"register_offset\":2,\"command_offset\":1,"
    "\"value_offset\":8,\"echo_length\":3},\"read_command\":\"0x01\",\"write_command\":\"0x02\","
    "\"commit_command\":null,\"eq_switch\":null,\"bands\":{\"count\":8,\"first_register\":\"0x40\",\"stride\":3},"
    "\"filter_codes\":{\"peaking\":\"0x02\",\"low_pass\":\"0x05\"},"
    "\"unused_band\":{\"gain_tenths_db\":0,\"frequency_hz\":1000,\"q_thousandths\":1000,\"filter_type\":\"peaking\"}},"
    "\"limits\":{\"gain_db\":{\"min\":-10,\"max\":10},\"frequency_hz\":{\"min\":20,\"max\":20000},\"q\":{\"min\":0.1,\"max\":10}}}";

static void other_layout(void) {
    for (int i = 0; i < 8; ++i) { /* empty slots: 0 dB peaking, 1 kHz, Q 1 */
        uint8_t *a = other[0x40 + 3*i], *c = other[0x41 + 3*i];
        a[2] = 1000 & 0xff; a[3] = 1000 >> 8;
        c[0] = 1000 & 0xff; c[1] = 1000 >> 8; c[2] = 2;
    }
    md_transport_v1 callbacks = {1, NULL, other_transact, NULL};
    md_device *device = md_open_transport_json(&callbacks, OTHER_PROFILE);
    assert(device != NULL);
    md_eq_state state;
    assert(md_read_eq(device, &state) == 0 && state.band_count == 0 && state.enabled == 1);
    state.band_count = 2;
    state.bands[0] = (md_band){-3.5, 80, 0.7, 0, {0}};  /* peaking */
    state.bands[1] = (md_band){0, 30, 0.707, 1, {0}};   /* low pass */
    assert(md_apply_eq(device, &state) == 0);
    assert(other[0x44][2] == 5); /* band 2's filter byte is the profile's low-pass code */
    md_eq_state back;
    assert(md_read_eq(device, &back) == 0 && back.band_count == 2 && back.bands[1].filter_type == 1);
    state.enabled = 0;
    assert(md_apply_eq(device, &state) == -1); /* no EQ switch */
    assert(md_commit(device) == -1);           /* no commit command */
    uint8_t request[16] = {0x4C, 0x01, 0x40}, response[16];
    assert(md_raw_command(device, request, 16, response, sizeof(response)) == 0 && response[8] == (uint8_t)-35);
    uint8_t value[16];
    size_t value_len = 0;
    assert(md_read_register(device, 0x44, value, sizeof(value), &value_len) == 0 && value_len == 4 && value[2] == 5);
    assert(md_write_register(device, 0x44, value, 3) == -1); /* wrong value length */
    md_close(device);
}

int main(void) {
    assert(md_abi_version() == 2 && md_preset_count() == 2);
    load_device();
    md_transport_v1 callbacks = {1, NULL, fake_transact, NULL};
    md_device *device = md_open_transport(&callbacks, "chu2-dsp");
    assert(device != NULL);
    md_eq_state state;
    assert(md_read_eq(device, &state) == 0);
    assert(state.band_count == 5 && state.bands[0].gain_db == -4.7);

    char profile[32];
    uint16_t vendor, product;
    uint8_t slots;
    assert(md_profile_get(0, profile, sizeof(profile), &vendor, &product, &slots) == 0);
    assert(strcmp(profile, "chu2-dsp") == 0 && slots == 5);

    /* Fewer bands than slots: the rest are cleared and read back as absent. */
    md_eq_state three = state;
    three.band_count = 3;
    assert(md_apply_eq(device, &three) == 0);
    assert(md_read_eq(device, &state) == 0 && state.band_count == 3);
    assert(state.bands[2].frequency_hz == 1400.0);
    /* More bands than slots is refused without touching the device. */
    md_eq_state six = state;
    six.band_count = 6;
    for (int i = 3; i < 6; ++i) six.bands[i] = six.bands[0];
    assert(md_apply_eq(device, &six) == -1);
    assert(md_read_eq(device, &state) == 0 && state.band_count == 3);

    assert(md_apply_preset(device, "chu2-quiet-18db") == 0);
    assert(md_read_eq(device, &state) == 0);
    assert(state.band_count == 5 && state.bands[0].gain_db == -12.0);
    assert(state.bands[4].frequency_hz == 10234.0);
    assert(md_commit(device) == 0 && commits == 1);
    assert(md_apply_preset(device, "flat") == 0);
    assert(md_read_eq(device, &state) == 0 && state.band_count == 0 && state.enabled == 1);

    char json[4096];
    size_t need = md_device_profile_json(device, json, sizeof(json));
    assert(need > 1 && need <= sizeof(json) && strstr(json, "\"0x31B2\"") != NULL);
    md_close(device);

    /* A profile passed as JSON: same device, described inline. */
    device = md_open_transport_json(&callbacks, json);
    assert(device != NULL);
    assert(md_read_eq(device, &state) == 0 && state.band_count == 0);
    md_close(device);
    assert(md_open_transport_json(&callbacks, "{\"id\": \"x\"}") == NULL);
    other_layout();
    size_t list_size = md_profiles_json(NULL, 0);
    char *profiles = malloc(list_size);
    assert(profiles && md_profiles_json(profiles, list_size) == list_size && strstr(profiles, "\"chu2-dsp\"") != NULL);
    free(profiles);
    puts("C ABI smoke test passed");
    return 0;
}
