/*
 * libxoss.c - X Audio Output Stream Subsystem LD_PRELOAD interposer library.
 *
 * Intercepts /dev/audio, /dev/dsp, and /dev/cdrom operations from legacy binaries
 * like 1997 glquake.glx and routes PCM audio and CD-DA streams across X11/XAudio/XBlob.
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdarg.h>
#include <unistd.h>
#include <fcntl.h>
#include <dlfcn.h>
#include <errno.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/ioctl.h>
#include <sys/soundcard.h>
#include <linux/cdrom.h>
#include <time.h>
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/Xutil.h>

#ifndef CDROMPLAYTRK
#define CDROMPLAYTRK 0x5304
#endif

#define MAX_XOSS_FDS 64
#define AUDIO_BUF_SIZE 131072

typedef enum {
    FD_TYPE_NONE = 0,
    FD_TYPE_AUDIO,
    FD_TYPE_CDROM
} xoss_fd_type_t;

typedef struct {
    int real_fd;
    xoss_fd_type_t type;

    /* Audio settings */
    int sample_rate;
    int channels;
    int sample_bits;
    int fragment_size;
    int total_fragments;
    int non_blocking;

    uint8_t buffer[AUDIO_BUF_SIZE];
    size_t buffer_len;
    uint32_t seq_num;

    /* CDROM settings */
    int current_track;
    int cd_status;
    time_t play_start_time;
} xoss_fd_info_t;

static xoss_fd_info_t g_fds[MAX_XOSS_FDS];

/* Real function pointers */
static int (*real_open)(const char *pathname, int flags, ...) = NULL;
static int (*real_open64)(const char *pathname, int flags, ...) = NULL;
static int (*real_openat)(int dirfd, const char *pathname, int flags, ...) = NULL;
static int (*real_openat64)(int dirfd, const char *pathname, int flags, ...) = NULL;
static int (*real_close)(int fd) = NULL;
static ssize_t (*real_write)(int fd, const void *buf, size_t count) = NULL;
static int (*real_ioctl)(int fd, unsigned long request, ...) = NULL;

/* X11 state */
static Display *g_x11_dpy = NULL;
static Window g_client_win = 0;
static Window g_sink_win = 0;
static Atom g_atom_xaudio_play = 0;
static Atom g_atom_xaudio_control = 0;
static Atom g_atom_xblob_create = 0;
static Atom g_atom_xintent_data = 0;
static bool g_x11_inited = false;

/* Configuration from environment */
static int g_block_size_ms = 50;
static char g_stream_policy[64] = "MediaStream";
static char g_transcode[64] = "audio/raw;rate=22050;channels=2";
static char g_fallback[32] = "null";

static void init_real_functions(void) {
    if (!real_open) real_open = dlsym(RTLD_NEXT, "open");
    if (!real_open64) real_open64 = dlsym(RTLD_NEXT, "open64");
    if (!real_openat) real_openat = dlsym(RTLD_NEXT, "openat");
    if (!real_openat64) real_openat64 = dlsym(RTLD_NEXT, "openat64");
    if (!real_close) real_close = dlsym(RTLD_NEXT, "close");
    if (!real_write) real_write = dlsym(RTLD_NEXT, "write");
    if (!real_ioctl) real_ioctl = dlsym(RTLD_NEXT, "ioctl");
}

static void read_env_config(void) {
    const char *bs = getenv("XOSS_BLOCK_SIZE");
    if (bs) {
        int v = atoi(bs);
        if (v > 0) g_block_size_ms = v;
    }
    const char *sp = getenv("XOSS_STREAM_POLICY");
    if (sp && *sp) {
        strncpy(g_stream_policy, sp, sizeof(g_stream_policy) - 1);
    }
    const char *tc = getenv("XOSS_TRANSCODE");
    if (tc && *tc) {
        strncpy(g_transcode, tc, sizeof(g_transcode) - 1);
    }
    const char *fb = getenv("XOSS_FALLBACK");
    if (fb && *fb) {
        strncpy(g_fallback, fb, sizeof(g_fallback) - 1);
    }
}

static void init_x11(void) {
    if (g_x11_inited) return;
    g_x11_inited = true;
    read_env_config();

    const char *disp_str = getenv("DISPLAY");
    if (!disp_str || !*disp_str) {
        fprintf(stderr, "[xoss] DISPLAY not set, running in fallback mode (%s)\n", g_fallback);
        return;
    }

    g_x11_dpy = XOpenDisplay(disp_str);
    if (!g_x11_dpy) {
        fprintf(stderr, "[xoss] Cannot open X display %s, fallback mode (%s)\n", disp_str, g_fallback);
        return;
    }

    Window root = RootWindow(g_x11_dpy, DefaultScreen(g_x11_dpy));

    Atom atom_xintent = XInternAtom(g_x11_dpy, "XINTENT", False);
    Atom atom_xchannel = XInternAtom(g_x11_dpy, "XCHANNEL", False);
    Atom atom_speakers = XInternAtom(g_x11_dpy, "SESSION_SPEAKERS", False);

    g_atom_xaudio_play = XInternAtom(g_x11_dpy, "XAUDIO_PLAY_V0", False);
    g_atom_xaudio_control = XInternAtom(g_x11_dpy, "XAUDIO_CONTROL_V0", False);
    g_atom_xblob_create = XInternAtom(g_x11_dpy, "XBLOB_CREATE_V0", False);
    g_atom_xintent_data = XInternAtom(g_x11_dpy, "XINTENT_DATA", False);

    Window router_win = XGetSelectionOwner(g_x11_dpy, atom_xintent);
    if (!router_win) router_win = XGetSelectionOwner(g_x11_dpy, atom_xchannel);

    g_sink_win = XGetSelectionOwner(g_x11_dpy, atom_speakers);
    if (!g_sink_win) g_sink_win = router_win;

    g_client_win = XCreateSimpleWindow(g_x11_dpy, root, 0, 0, 1, 1, 0, 0, 0);

    /* Set _NET_WM_PID */
    pid_t pid = getpid();
    Atom atom_pid = XInternAtom(g_x11_dpy, "_NET_WM_PID", False);
    Atom atom_cardinal = XInternAtom(g_x11_dpy, "CARDINAL", False);
    XChangeProperty(g_x11_dpy, g_client_win, atom_pid, atom_cardinal, 32, PropModeReplace, (unsigned char *)&pid, 1);

    /* Set WM_CLASS */
    XClassHint class_hint = { "xoss", "glquake" };
    XSetClassHint(g_x11_dpy, g_client_win, &class_hint);

    fprintf(stderr, "[xoss] Connected to X11 %s (sink_win=0x%lx, client_win=0x%lx)\n",
            disp_str, (unsigned long)g_sink_win, (unsigned long)g_client_win);
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

static int alloc_fake_fd(xoss_fd_type_t type) {
    init_real_functions();
    int pipefds[2];
    if (pipe(pipefds) < 0) return -1;
    real_close(pipefds[1]); // keep read end
    int fd = pipefds[0];

    if (fd >= 0 && fd < MAX_XOSS_FDS) {
        memset(&g_fds[fd], 0, sizeof(xoss_fd_info_t));
        g_fds[fd].real_fd = fd;
        g_fds[fd].type = type;
        if (type == FD_TYPE_AUDIO) {
            g_fds[fd].sample_rate = 22050;
            g_fds[fd].channels = 2;
            g_fds[fd].sample_bits = 16;
            g_fds[fd].fragment_size = 2048;
            g_fds[fd].total_fragments = 16;
        } else if (type == FD_TYPE_CDROM) {
            g_fds[fd].current_track = 1;
            g_fds[fd].cd_status = CDROM_AUDIO_NO_STATUS;
        }
        return fd;
    }
    return fd;
}

static void create_wav_header(uint8_t *header, uint32_t data_len, uint32_t sample_rate, uint16_t channels, uint16_t bits_per_sample) {
    uint32_t block_align = channels * (bits_per_sample / 8);
    uint32_t byte_rate = sample_rate * block_align;

    memcpy(header, "RIFF", 4);
    uint32_t riff_len = 36 + data_len;
    memcpy(header + 4, &riff_len, 4);
    memcpy(header + 8, "WAVEfmt ", 8);
    uint32_t fmt_len = 16;
    memcpy(header + 16, &fmt_len, 4);
    uint16_t format_pcm = 1;
    memcpy(header + 20, &format_pcm, 2);
    memcpy(header + 22, &channels, 2);
    memcpy(header + 24, &sample_rate, 4);
    memcpy(header + 28, &byte_rate, 4);
    memcpy(header + 32, &block_align, 2);
    memcpy(header + 34, &bits_per_sample, 2);
    memcpy(header + 36, "data", 4);
    memcpy(header + 40, &data_len, 4);
}

static void send_audio_chunk(xoss_fd_info_t *info, const uint8_t *data, size_t size) {
    init_x11();
    if (!g_x11_dpy || !g_sink_win) {
        return;
    }

    info->seq_num++;

    /* Prepend WAV header */
    uint8_t *wav_buf = (uint8_t *)malloc(44 + size);
    if (!wav_buf) return;

    create_wav_header(wav_buf, (uint32_t)size, (uint32_t)info->sample_rate, (uint16_t)info->channels, (uint16_t)info->sample_bits);
    memcpy(wav_buf + 44, data, size);

    /* Publish property chunk */
    XChangeProperty(g_x11_dpy, g_client_win, g_atom_xintent_data, XA_STRING, 8,
                    PropModeReplace, wav_buf, 44 + size);

    /* Send XAUDIO_PLAY_V0 ClientMessage */
    XClientMessageEvent ev;
    memset(&ev, 0, sizeof(ev));
    ev.type = ClientMessage;
    ev.window = g_sink_win;
    ev.message_type = g_atom_xaudio_play;
    ev.format = 32;
    ev.data.l[0] = (long)g_client_win;
    ev.data.l[1] = (long)info->seq_num;
    ev.data.l[2] = (long)info->sample_rate;
    ev.data.l[3] = (long)((info->channels << 16) | (info->sample_bits & 0xffff));
    ev.data.l[4] = (long)(44 + size);

    XSendEvent(g_x11_dpy, g_sink_win, False, NoEventMask, (XEvent *)&ev);
    XFlush(g_x11_dpy);

    free(wav_buf);
}

static void send_cd_control(int cmd, int track) {
    init_x11();
    if (!g_x11_dpy || !g_sink_win) return;

    XClientMessageEvent ev;
    memset(&ev, 0, sizeof(ev));
    ev.type = ClientMessage;
    ev.window = g_sink_win;
    ev.message_type = g_atom_xaudio_control;
    ev.format = 32;
    ev.data.l[0] = (long)g_client_win;
    ev.data.l[1] = (long)cmd;    /* 1=play, 2=pause, 3=resume, 4=stop */
    ev.data.l[2] = (long)track;  /* CD track number */
    ev.data.l[3] = 0;
    ev.data.l[4] = 0;

    XSendEvent(g_x11_dpy, g_sink_win, False, NoEventMask, (XEvent *)&ev);
    XFlush(g_x11_dpy);
}

/* Intercepted open */
int open(const char *pathname, int flags, ...) {
    init_real_functions();
    if (is_audio_dev(pathname)) {
        fprintf(stderr, "[xoss] Intercepted open(\"%s\") for audio\n", pathname);
        return alloc_fake_fd(FD_TYPE_AUDIO);
    }
    if (is_cdrom_dev(pathname)) {
        fprintf(stderr, "[xoss] Intercepted open(\"%s\") for CD-ROM\n", pathname);
        return alloc_fake_fd(FD_TYPE_CDROM);
    }

    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode = va_arg(args, mode_t);
        va_end(args);
        return real_open(pathname, flags, mode);
    }
    return real_open(pathname, flags);
}

int open64(const char *pathname, int flags, ...) {
    init_real_functions();
    if (is_audio_dev(pathname)) {
        return alloc_fake_fd(FD_TYPE_AUDIO);
    }
    if (is_cdrom_dev(pathname)) {
        return alloc_fake_fd(FD_TYPE_CDROM);
    }
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode = va_arg(args, mode_t);
        va_end(args);
        return real_open64 ? real_open64(pathname, flags, mode) : real_open(pathname, flags, mode);
    }
    return real_open64 ? real_open64(pathname, flags) : real_open(pathname, flags);
}

int openat(int dirfd, const char *pathname, int flags, ...) {
    init_real_functions();
    if (is_audio_dev(pathname)) {
        return alloc_fake_fd(FD_TYPE_AUDIO);
    }
    if (is_cdrom_dev(pathname)) {
        return alloc_fake_fd(FD_TYPE_CDROM);
    }
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode = va_arg(args, mode_t);
        va_end(args);
        return real_openat(dirfd, pathname, flags, mode);
    }
    return real_openat(dirfd, pathname, flags);
}

int openat64(int dirfd, const char *pathname, int flags, ...) {
    init_real_functions();
    if (is_audio_dev(pathname)) {
        return alloc_fake_fd(FD_TYPE_AUDIO);
    }
    if (is_cdrom_dev(pathname)) {
        return alloc_fake_fd(FD_TYPE_CDROM);
    }
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode = va_arg(args, mode_t);
        va_end(args);
        return real_openat64 ? real_openat64(dirfd, pathname, flags, mode) : real_openat(dirfd, pathname, flags, mode);
    }
    return real_openat64 ? real_openat64(dirfd, pathname, flags) : real_openat(dirfd, pathname, flags);
}

int close(int fd) {
    init_real_functions();
    xoss_fd_info_t *info = get_fd_info(fd);
    if (info) {
        info->type = FD_TYPE_NONE;
        return real_close(fd);
    }
    return real_close(fd);
}

ssize_t write(int fd, const void *buf, size_t count) {
    init_real_functions();
    xoss_fd_info_t *info = get_fd_info(fd);
    if (info && info->type == FD_TYPE_AUDIO) {
        if (!buf || count == 0) return 0;

        size_t bytes_per_sample = (info->sample_bits / 8) * info->channels;
        if (bytes_per_sample == 0) bytes_per_sample = 4;

        size_t block_bytes = (info->sample_rate * bytes_per_sample * g_block_size_ms) / 1000;
        if (block_bytes == 0) block_bytes = 4410; // 50ms @ 22050 16-bit stereo

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
        if (info->type == FD_TYPE_AUDIO) {
            if (request == SNDCTL_DSP_RESET) {
                info->buffer_len = 0;
                return 0;
            } else if (request == SNDCTL_DSP_SPEED || request == SOUND_PCM_WRITE_RATE) {
                if (argp) {
                    int r = *(int *)argp;
                    if (r > 0) info->sample_rate = r;
                    *(int *)argp = info->sample_rate;
                }
                return 0;
            } else if (request == SNDCTL_DSP_STEREO || request == SOUND_PCM_WRITE_CHANNELS || request == SNDCTL_DSP_CHANNELS) {
                if (argp) {
                    int c = *(int *)argp;
                    info->channels = (c > 1) ? 2 : 1;
                    *(int *)argp = info->channels;
                }
                return 0;
            } else if (request == SNDCTL_DSP_SETFMT || request == SOUND_PCM_WRITE_BITS) {
                if (argp) {
                    int fmt = *(int *)argp;
                    if (fmt == AFMT_U8) info->sample_bits = 8;
                    else info->sample_bits = 16;
                    *(int *)argp = (info->sample_bits == 8) ? AFMT_U8 : AFMT_S16_LE;
                }
                return 0;
            } else if (request == SNDCTL_DSP_GETFMTS) {
                if (argp) {
                    *(int *)argp = AFMT_S16_LE | AFMT_U8 | AFMT_S8 | AFMT_U16_LE;
                }
                return 0;
            } else if (request == SNDCTL_DSP_GETOSPACE) {
                if (argp) {
                    audio_buf_info *abi = (audio_buf_info *)argp;
                    abi->fragments = 14;
                    abi->fragstotal = 16;
                    abi->fragsize = info->fragment_size;
                    abi->bytes = abi->fragments * abi->fragsize;
                }
                return 0;
            } else if (request == SNDCTL_DSP_GETCAPS) {
                if (argp) {
                    *(int *)argp = DSP_CAP_DUPLEX | DSP_CAP_REALTIME | DSP_CAP_BATCH | DSP_CAP_MMAP;
                }
                return 0;
            } else if (request == SNDCTL_DSP_NONBLOCK) {
                info->non_blocking = 1;
                return 0;
            } else if (request == SNDCTL_DSP_POST || request == SNDCTL_DSP_SETFRAGMENT) {
                return 0;
            } else {
                return 0;
            }
        } else if (info->type == FD_TYPE_CDROM) {
            if (request == CDROMREADTOCHDR) {
                if (argp) {
                    struct cdrom_tochdr *th = (struct cdrom_tochdr *)argp;
                    th->cdth_trk0 = 1;
                    th->cdth_trk1 = 11;
                }
                return 0;
            } else if (request == CDROMREADTOCENTRY) {
                if (argp) {
                    struct cdrom_tocentry *te = (struct cdrom_tocentry *)argp;
                    int trk = te->cdte_track;
                    te->cdte_ctrl = (trk == 1) ? CDROM_DATA_TRACK : 0;

                    /* LBA offsets for tracks */
                    int lba = 0;
                    if (trk == 1) lba = 0;
                    else if (trk == 2) lba = 118104;
                    else if (trk == 3) lba = 138804;
                    else if (trk == 4) lba = 153204;
                    else if (trk == 0xAA) lba = 300000; // leadout
                    else lba = 153204 + (trk - 4) * 15000;

                    if (te->cdte_format == CDROM_MSF) {
                        int total_sec = lba / 75;
                        te->cdte_addr.msf.minute = total_sec / 60;
                        te->cdte_addr.msf.second = total_sec % 60;
                        te->cdte_addr.msf.frame = lba % 75;
                    } else {
                        te->cdte_addr.lba = lba;
                    }
                }
                return 0;
            } else if (request == CDROMPLAYTRK) {
                if (argp) {
                    struct cdrom_ti *ti = (struct cdrom_ti *)argp;
                    int track = ti->cdti_trk0;
                    info->current_track = track;
                    info->cd_status = CDROM_AUDIO_PLAY;
                    info->play_start_time = time(NULL);
                    fprintf(stderr, "[xoss] CDROMPLAYTRK track %d\n", track);
                    send_cd_control(1, track);
                }
                return 0;
            } else if (request == CDROMPAUSE) {
                info->cd_status = CDROM_AUDIO_PAUSED;
                send_cd_control(2, info->current_track);
                return 0;
            } else if (request == CDROMRESUME) {
                info->cd_status = CDROM_AUDIO_PLAY;
                send_cd_control(3, info->current_track);
                return 0;
            } else if (request == CDROMSUBCHNL) {
                if (argp) {
                    struct cdrom_subchnl *sub = (struct cdrom_subchnl *)argp;
                    sub->cdsc_audiostatus = info->cd_status;
                    sub->cdsc_trk = info->current_track;
                    time_t elapsed = time(NULL) - info->play_start_time;

                    if (sub->cdsc_format == CDROM_MSF) {
                        sub->cdsc_reladdr.msf.minute = elapsed / 60;
                        sub->cdsc_reladdr.msf.second = elapsed % 60;
                        sub->cdsc_reladdr.msf.frame = (elapsed * 75) % 75;
                    } else {
                        sub->cdsc_reladdr.lba = elapsed * 75;
                    }
                }
                return 0;
            } else if (request == CDROMSTOP) {
                info->cd_status = CDROM_AUDIO_NO_STATUS;
                send_cd_control(4, info->current_track);
                return 0;
            } else {
                return 0;
            }
        }
    }

    return real_ioctl(fd, request, argp);
}
