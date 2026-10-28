/*
 * xoss_internal.h - Internal types, X11 IPC state, and WAV helpers for libxoss.
 */

#ifndef XOSS_INTERNAL_H
#define XOSS_INTERNAL_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <unistd.h>
#include <time.h>
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/Xutil.h>

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

static void copy_env_if_set(const char *env_name, char *dest, size_t max_len) {
    const char *val = getenv(env_name);
    if (val && *val) {
        strncpy(dest, val, max_len - 1);
    }
}

static void read_env_config(void) {
    const char *bs = getenv("XOSS_BLOCK_SIZE");
    if (bs) {
        int v = atoi(bs);
        if (v > 0) g_block_size_ms = v;
    }
    copy_env_if_set("XOSS_STREAM_POLICY", g_stream_policy, sizeof(g_stream_policy));
    copy_env_if_set("XOSS_TRANSCODE", g_transcode, sizeof(g_transcode));
    copy_env_if_set("XOSS_FALLBACK", g_fallback, sizeof(g_fallback));
}

static void setup_x11_atoms_and_windows(const char *disp_str) {
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

    pid_t pid = getpid();
    Atom atom_pid = XInternAtom(g_x11_dpy, "_NET_WM_PID", False);
    Atom atom_cardinal = XInternAtom(g_x11_dpy, "CARDINAL", False);
    XChangeProperty(g_x11_dpy, g_client_win, atom_pid, atom_cardinal, 32, PropModeReplace, (unsigned char *)&pid, 1);

    XClassHint class_hint = { "xoss", "glquake" };
    XSetClassHint(g_x11_dpy, g_client_win, &class_hint);

    fprintf(stderr, "[xoss] Connected to X11 %s (sink_win=0x%lx, client_win=0x%lx)\n",
            disp_str, (unsigned long)g_sink_win, (unsigned long)g_client_win);
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

    setup_x11_atoms_and_windows(disp_str);
}

static void create_wav_header(uint8_t *header, uint32_t data_len, uint32_t sample_rate, uint16_t channels, uint16_t bits_per_sample) {
    uint32_t block_align = channels * (bits_per_sample / 8);
    uint32_t byte_rate = sample_rate * block_align;
    uint32_t riff_len = 36 + data_len;
    uint32_t fmt_len = 16;
    uint16_t format_pcm = 1;

    memcpy(header, "RIFF", 4);
    memcpy(header + 4, &riff_len, 4);
    memcpy(header + 8, "WAVEfmt ", 8);
    memcpy(header + 16, &fmt_len, 4);
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
    if (!g_x11_dpy || !g_sink_win) return;

    info->seq_num++;
    uint8_t *wav_buf = (uint8_t *)malloc(44 + size);
    if (!wav_buf) return;

    create_wav_header(wav_buf, (uint32_t)size, (uint32_t)info->sample_rate, (uint16_t)info->channels, (uint16_t)info->sample_bits);
    memcpy(wav_buf + 44, data, size);

    XChangeProperty(g_x11_dpy, g_client_win, g_atom_xintent_data, XA_STRING, 8,
                    PropModeReplace, wav_buf, 44 + size);

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
    ev.data.l[1] = (long)cmd;
    ev.data.l[2] = (long)track;

    XSendEvent(g_x11_dpy, g_sink_win, False, NoEventMask, (XEvent *)&ev);
    XFlush(g_x11_dpy);
}

#endif /* XOSS_INTERNAL_H */
