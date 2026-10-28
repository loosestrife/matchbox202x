/*
 * libxoss.c - X Audio Output Stream Subsystem LD_PRELOAD interposer library.
 *
 * Intercepts /dev/audio, /dev/dsp, and /dev/cdrom operations from legacy binaries
 * like 1997 glquake.glx and routes PCM audio and CD-DA streams across X11/XAudio/XBlob.
 */

#define _GNU_SOURCE
#include <stdarg.h>
#include <fcntl.h>
#include <dlfcn.h>
#include "xoss_internal.h"
#include "xoss_ioctl.h"

static xoss_fd_info_t g_fds[MAX_XOSS_FDS];

/* Real function pointers */
static int (*real_open)(const char *pathname, int flags, ...) = NULL;
static int (*real_open64)(const char *pathname, int flags, ...) = NULL;
static int (*real_openat)(int dirfd, const char *pathname, int flags, ...) = NULL;
static int (*real_openat64)(int dirfd, const char *pathname, int flags, ...) = NULL;
static int (*real_close)(int fd) = NULL;
static ssize_t (*real_write)(int fd, const void *buf, size_t count) = NULL;
static int (*real_ioctl)(int fd, unsigned long request, ...) = NULL;

static void init_real_functions(void) {
    if (!real_open) real_open = dlsym(RTLD_NEXT, "open");
    if (!real_open64) real_open64 = dlsym(RTLD_NEXT, "open64");
    if (!real_openat) real_openat = dlsym(RTLD_NEXT, "openat");
    if (!real_openat64) real_openat64 = dlsym(RTLD_NEXT, "openat64");
    if (!real_close) real_close = dlsym(RTLD_NEXT, "close");
    if (!real_write) real_write = dlsym(RTLD_NEXT, "write");
    if (!real_ioctl) real_ioctl = dlsym(RTLD_NEXT, "ioctl");
}

static xoss_fd_info_t *get_fd_info(int fd) {
    if (fd < 0 || fd >= MAX_XOSS_FDS) return NULL;
    if (g_fds[fd].type == FD_TYPE_NONE) return NULL;
    return &g_fds[fd];
}

static bool is_audio_dev(const char *path) {
    if (!path) return false;
    return (strstr(path, "/dev/audio") != NULL ||
            strstr(path, "/dev/dsp") != NULL ||
            strstr(path, "/dev/sound/dsp") != NULL ||
            strstr(path, "/dev/sound/audio") != NULL);
}

static bool is_cdrom_dev(const char *path) {
    if (!path) return false;
    return (strstr(path, "/dev/cdrom") != NULL ||
            strstr(path, "/dev/cdaudio") != NULL ||
            strstr(path, "/dev/cd0") != NULL ||
            strstr(path, "/dev/acd0") != NULL ||
            strstr(path, "/dev/sr0") != NULL ||
            strstr(path, "/dev/scd0") != NULL);
}

static void init_fake_fd_entry(xoss_fd_info_t *entry, int fd, xoss_fd_type_t type) {
    memset(entry, 0, sizeof(xoss_fd_info_t));
    entry->real_fd = fd;
    entry->type = type;
    if (type == FD_TYPE_AUDIO) {
        entry->sample_rate = 22050;
        entry->channels = 2;
        entry->sample_bits = 16;
        entry->fragment_size = 2048;
        entry->total_fragments = 16;
    } else if (type == FD_TYPE_CDROM) {
        entry->current_track = 1;
        entry->cd_status = CDROM_AUDIO_NO_STATUS;
    }
}

static int alloc_fake_fd(xoss_fd_type_t type) {
    init_real_functions();
    int pipefds[2];
    if (pipe(pipefds) < 0) return -1;
    real_close(pipefds[1]);
    int fd = pipefds[0];

    if (fd >= 0 && fd < MAX_XOSS_FDS) {
        init_fake_fd_entry(&g_fds[fd], fd, type);
    }
    return fd;
}

static int try_intercept_device_open(const char *pathname, bool log_intercept) {
    if (is_audio_dev(pathname)) {
        if (log_intercept) fprintf(stderr, "[xoss] Intercepted open(\"%s\") for audio\n", pathname);
        return alloc_fake_fd(FD_TYPE_AUDIO);
    }
    if (is_cdrom_dev(pathname)) {
        if (log_intercept) fprintf(stderr, "[xoss] Intercepted open(\"%s\") for CD-ROM\n", pathname);
        return alloc_fake_fd(FD_TYPE_CDROM);
    }
    return -2;
}

int open(const char *pathname, int flags, ...) {
    init_real_functions();
    int intercepted = try_intercept_device_open(pathname, true);
    if (intercepted != -2) return intercepted;

    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode_t mode = va_arg(args, mode_t);
        va_end(args);
        return real_open(pathname, flags, mode);
    }
    return real_open(pathname, flags);
}

int open64(const char *pathname, int flags, ...) {
    init_real_functions();
    int intercepted = try_intercept_device_open(pathname, false);
    if (intercepted != -2) return intercepted;

    int (*target_fn)(const char *, int, ...) = real_open64 ? real_open64 : real_open;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode_t mode = va_arg(args, mode_t);
        va_end(args);
        return target_fn(pathname, flags, mode);
    }
    return target_fn(pathname, flags);
}

int openat(int dirfd, const char *pathname, int flags, ...) {
    init_real_functions();
    int intercepted = try_intercept_device_open(pathname, false);
    if (intercepted != -2) return intercepted;

    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode_t mode = va_arg(args, mode_t);
        va_end(args);
        return real_openat(dirfd, pathname, flags, mode);
    }
    return real_openat(dirfd, pathname, flags);
}

int openat64(int dirfd, const char *pathname, int flags, ...) {
    init_real_functions();
    int intercepted = try_intercept_device_open(pathname, false);
    if (intercepted != -2) return intercepted;

    int (*target_fn)(int, const char *, int, ...) = real_openat64 ? real_openat64 : real_openat;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode_t mode = va_arg(args, mode_t);
        va_end(args);
        return target_fn(dirfd, pathname, flags, mode);
    }
    return target_fn(dirfd, pathname, flags);
}

int close(int fd) {
    init_real_functions();
    xoss_fd_info_t *info = get_fd_info(fd);
    if (info) {
        info->type = FD_TYPE_NONE;
    }
    return real_close(fd);
}

static size_t compute_audio_block_bytes(const xoss_fd_info_t *info) {
    size_t bytes_per_sample = (info->sample_bits / 8) * info->channels;
    if (bytes_per_sample == 0) bytes_per_sample = 4;
    size_t block_bytes = (info->sample_rate * bytes_per_sample * g_block_size_ms) / 1000;
    return block_bytes ? block_bytes : 4410;
}

static ssize_t write_audio_stream(xoss_fd_info_t *info, const void *buf, size_t count) {
    if (!buf || count == 0) return 0;
    size_t block_bytes = compute_audio_block_bytes(info);
    const uint8_t *src = (const uint8_t *)buf;
    size_t remaining = count;

    while (remaining > 0) {
        size_t space = sizeof(info->buffer) - info->buffer_len;
        size_t copy_size = (remaining < space) ? remaining : space;

        memcpy(info->buffer + info->buffer_len, src, copy_size);
        info->buffer_len += copy_size;
        src += copy_size;
        remaining -= copy_size;

        while (info->buffer_len >= block_bytes) {
            send_audio_chunk(info, info->buffer, block_bytes);
            size_t left = info->buffer_len - block_bytes;
            memmove(info->buffer, info->buffer + block_bytes, left);
            info->buffer_len = left;
        }
    }
    return count;
}

ssize_t write(int fd, const void *buf, size_t count) {
    init_real_functions();
    xoss_fd_info_t *info = get_fd_info(fd);
    if (info && info->type == FD_TYPE_AUDIO) {
        return write_audio_stream(info, buf, count);
    }
    return real_write(fd, buf, count);
}

int ioctl(int fd, unsigned long request, ...) {
    init_real_functions();
    xoss_fd_info_t *info = get_fd_info(fd);

    va_list args;
    va_start(args, request);
    void *argp = va_arg(args, void *);
    va_end(args);

    if (info) {
        return dispatch_xoss_ioctl(info, request, argp);
    }
    return real_ioctl(fd, request, argp);
}
