#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/hid/IOHIDManager.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define MD_MAX_REPORT 64

typedef struct {
    IOHIDManagerRef manager;
    IOHIDDeviceRef device;
    uint8_t report_id;
    size_t report_len;
    uint8_t input[MD_MAX_REPORT];
    uint8_t response[MD_MAX_REPORT];
    int received;
} md_macos_device;

static void on_input(void *context, IOReturn result, void *sender, IOHIDReportType type,
                     uint32_t report_id, uint8_t *report, CFIndex length) {
    (void)sender; (void)type; (void)report_id;
    md_macos_device *d = (md_macos_device *)context;
    if (result == kIOReturnSuccess && (size_t)length >= d->report_len && report[0] == d->report_id) {
        memcpy(d->response, report, d->report_len);
        d->received = 1;
    }
}

static void set_number(CFMutableDictionaryRef dict, CFStringRef key, int32_t value) {
    CFNumberRef n = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &value);
    CFDictionarySetValue(dict, key, n);
    CFRelease(n);
}

static int32_t get_number(IOHIDDeviceRef device, CFStringRef key) {
    CFTypeRef value = IOHIDDeviceGetProperty(device, key);
    int32_t n = 0;
    if (value && CFGetTypeID(value) == CFNumberGetTypeID())
        CFNumberGetValue((CFNumberRef)value, kCFNumberSInt32Type, &n);
    return n;
}

static void get_string(IOHIDDeviceRef device, CFStringRef key, char *out, size_t capacity) {
    out[0] = 0;
    CFTypeRef value = IOHIDDeviceGetProperty(device, key);
    if (value && CFGetTypeID(value) == CFStringGetTypeID())
        CFStringGetCString((CFStringRef)value, out, (CFIndex)capacity, kCFStringEncodingUTF8);
}

/* usage_page / usage: 0 matches any. Returns NULL with *matches set to the number of
   matching interfaces when there is not exactly one. */
void *md_macos_open(uint16_t vendor, uint16_t product, uint16_t usage_page, uint16_t usage,
                    uint8_t report_id, size_t report_len, int32_t *matches) {
    *matches = 0;
    if (report_len == 0 || report_len > MD_MAX_REPORT) return NULL;
    md_macos_device *d = calloc(1, sizeof(*d));
    if (!d) return NULL;
    d->report_id = report_id;
    d->report_len = report_len;
    d->manager = IOHIDManagerCreate(kCFAllocatorDefault, kIOHIDOptionsTypeNone);
    if (!d->manager) { free(d); return NULL; }
    CFMutableDictionaryRef match = CFDictionaryCreateMutable(kCFAllocatorDefault, 4,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    set_number(match, CFSTR(kIOHIDVendorIDKey), vendor);
    set_number(match, CFSTR(kIOHIDProductIDKey), product);
    if (usage_page) set_number(match, CFSTR(kIOHIDPrimaryUsagePageKey), usage_page);
    if (usage) set_number(match, CFSTR(kIOHIDPrimaryUsageKey), usage);
    IOHIDManagerSetDeviceMatching(d->manager, match);
    CFRelease(match);
    if (IOHIDManagerOpen(d->manager, kIOHIDOptionsTypeNone) != kIOReturnSuccess) goto fail;
    CFSetRef devices = IOHIDManagerCopyDevices(d->manager);
    *matches = devices ? (int32_t)CFSetGetCount(devices) : 0;
    if (!devices || CFSetGetCount(devices) != 1) { if (devices) CFRelease(devices); goto fail; }
    const void *candidate = NULL;
    CFSetGetValues(devices, &candidate);
    d->device = (IOHIDDeviceRef)candidate;
    CFRetain(d->device);
    CFRelease(devices);
    if (IOHIDDeviceOpen(d->device, kIOHIDOptionsTypeNone) != kIOReturnSuccess) goto fail;
    IOHIDDeviceRegisterInputReportCallback(d->device, d->input, sizeof(d->input), on_input, d);
    return d;
fail:
    if (d->device) CFRelease(d->device);
    IOHIDManagerClose(d->manager, kIOHIDOptionsTypeNone);
    CFRelease(d->manager);
    free(d);
    return NULL;
}

/* expect_reply = 0 sends without waiting, e.g. for a commit that restarts the device. */
int md_macos_transact(void *handle, const uint8_t *request, size_t len, uint8_t *response,
                      uint32_t timeout_ms, int expect_reply) {
    md_macos_device *d = (md_macos_device *)handle;
    if (!d || !request || len != d->report_len || request[0] != d->report_id) return -1;
    CFRunLoopRef run_loop = CFRunLoopGetCurrent();
    IOHIDDeviceScheduleWithRunLoop(d->device, run_loop, kCFRunLoopDefaultMode);
    d->received = 0;
    IOReturn result = IOHIDDeviceSetReport(d->device, kIOHIDReportTypeOutput, d->report_id,
                                           request, (CFIndex)len);
    int status = 0;
    if (result != kIOReturnSuccess) { status = (int)result; goto done; }
    if (!expect_reply) goto done;
    CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent() + timeout_ms / 1000.0;
    while (!d->received && CFAbsoluteTimeGetCurrent() < deadline) {
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, false);
    }
    if (!d->received) { status = -2; goto done; }
    if (response) memcpy(response, d->response, len);
done:
    IOHIDDeviceUnscheduleFromRunLoop(d->device, run_loop, kCFRunLoopDefaultMode);
    return status;
}

void md_macos_close(void *handle) {
    md_macos_device *d = (md_macos_device *)handle;
    if (!d) return;
    IOHIDDeviceClose(d->device, kIOHIDOptionsTypeNone);
    CFRelease(d->device);
    IOHIDManagerClose(d->manager, kIOHIDOptionsTypeNone);
    CFRelease(d->manager);
    free(d);
}

typedef void (*md_macos_visit)(void *context, uint16_t vendor, uint16_t product,
    uint16_t usage_page, uint16_t usage, const char *manufacturer, const char *name);

/* Lists HID interfaces without opening them, so no input-monitoring permission is needed. */
int md_macos_enumerate(md_macos_visit visit, void *context) {
    IOHIDManagerRef manager = IOHIDManagerCreate(kCFAllocatorDefault, kIOHIDOptionsTypeNone);
    if (!manager) return -1;
    IOHIDManagerSetDeviceMatching(manager, NULL);
    CFSetRef devices = IOHIDManagerCopyDevices(manager);
    if (devices) {
        CFIndex count = CFSetGetCount(devices);
        const void **items = calloc((size_t)count, sizeof(void *));
        if (items) {
            CFSetGetValues(devices, items);
            for (CFIndex i = 0; i < count; i++) {
                IOHIDDeviceRef device = (IOHIDDeviceRef)items[i];
                char manufacturer[128], name[128];
                get_string(device, CFSTR(kIOHIDManufacturerKey), manufacturer, sizeof manufacturer);
                get_string(device, CFSTR(kIOHIDProductKey), name, sizeof name);
                visit(context,
                      (uint16_t)get_number(device, CFSTR(kIOHIDVendorIDKey)),
                      (uint16_t)get_number(device, CFSTR(kIOHIDProductIDKey)),
                      (uint16_t)get_number(device, CFSTR(kIOHIDPrimaryUsagePageKey)),
                      (uint16_t)get_number(device, CFSTR(kIOHIDPrimaryUsageKey)),
                      manufacturer, name);
            }
            free(items);
        }
        CFRelease(devices);
    }
    CFRelease(manager);
    return 0;
}
