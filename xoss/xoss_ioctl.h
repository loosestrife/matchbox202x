/*
 * xoss_ioctl.h - OSS soundcard and CD-ROM ioctl handlers for libxoss.
 */

#ifndef XOSS_IOCTL_H
#define XOSS_IOCTL_H

#include <sys/ioctl.h>
#include <sys/soundcard.h>
#include <linux/cdrom.h>
#include "xoss_internal.h"

#ifndef CDROMPLAYTRK
#define CDROMPLAYTRK 0x5304
#endif

static void ioctl_audio_set_speed(xoss_fd_info_t *info, int *argp) {
    if (!argp) return;
    if (*argp > 0) info->sample_rate = *argp;
    *argp = info->sample_rate;
}

static void ioctl_audio_set_channels(xoss_fd_info_t *info, int *argp) {
    if (!argp) return;
    info->channels = (*argp > 1) ? 2 : 1;
    *argp = info->channels;
}

static void ioctl_audio_set_format(xoss_fd_info_t *info, int *argp) {
    if (!argp) return;
    info->sample_bits = (*argp == AFMT_U8) ? 8 : 16;
    *argp = (info->sample_bits == 8) ? AFMT_U8 : AFMT_S16_LE;
}

static void ioctl_audio_get_ospace(xoss_fd_info_t *info, audio_buf_info *abi) {
    if (!abi) return;
    abi->fragments = 14;
    abi->fragstotal = 16;
    abi->fragsize = info->fragment_size;
    abi->bytes = abi->fragments * abi->fragsize;
}

static int handle_audio_ioctl(xoss_fd_info_t *info, unsigned long request, void *argp) {
    switch (request) {
    case SNDCTL_DSP_RESET:
        info->buffer_len = 0;
        break;
    case SNDCTL_DSP_SPEED:
        ioctl_audio_set_speed(info, (int *)argp);
        break;
    case SNDCTL_DSP_STEREO:
    case SNDCTL_DSP_CHANNELS:
        ioctl_audio_set_channels(info, (int *)argp);
        break;
    case SNDCTL_DSP_SETFMT:
        ioctl_audio_set_format(info, (int *)argp);
        break;
    case SNDCTL_DSP_GETFMTS:
        if (argp) *(int *)argp = AFMT_S16_LE | AFMT_U8 | AFMT_S8 | AFMT_U16_LE;
        break;
    case SNDCTL_DSP_GETOSPACE:
        ioctl_audio_get_ospace(info, (audio_buf_info *)argp);
        break;
    case SNDCTL_DSP_GETCAPS:
        if (argp) *(int *)argp = DSP_CAP_DUPLEX | DSP_CAP_REALTIME | DSP_CAP_BATCH | DSP_CAP_MMAP;
        break;
    case SNDCTL_DSP_NONBLOCK:
        info->non_blocking = 1;
        break;
    case SNDCTL_DSP_POST:
    case SNDCTL_DSP_SETFRAGMENT:
    default:
        break;
    }
    return 0;
}

static int track_lba_offset(int trk) {
    switch (trk) {
    case 1: return 0;
    case 2: return 118104;
    case 3: return 138804;
    case 4: return 153204;
    case 0xAA: return 300000;
    default: return 153204 + (trk - 4) * 15000;
    }
}

static void ioctl_cdrom_read_tochdr(struct cdrom_tochdr *th) {
    if (!th) return;
    th->cdth_trk0 = 1;
    th->cdth_trk1 = 11;
}

static void ioctl_cdrom_read_tocentry(struct cdrom_tocentry *te) {
    if (!te) return;
    int trk = te->cdte_track;
    int lba = track_lba_offset(trk);
    te->cdte_ctrl = (trk == 1) ? CDROM_DATA_TRACK : 0;

    if (te->cdte_format == CDROM_MSF) {
        int total_sec = lba / 75;
        te->cdte_addr.msf.minute = total_sec / 60;
        te->cdte_addr.msf.second = total_sec % 60;
        te->cdte_addr.msf.frame = lba % 75;
    } else {
        te->cdte_addr.lba = lba;
    }
}

static void ioctl_cdrom_play_track(xoss_fd_info_t *info, struct cdrom_ti *ti) {
    if (!ti) return;
    int track = ti->cdti_trk0;
    info->current_track = track;
    info->cd_status = CDROM_AUDIO_PLAY;
    info->play_start_time = time(NULL);
    fprintf(stderr, "[xoss] CDROMPLAYTRK track %d\n", track);
    send_cd_control(1, track);
}

static void ioctl_cdrom_subchnl(xoss_fd_info_t *info, struct cdrom_subchnl *sub) {
    if (!sub) return;
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

static int handle_cdrom_ioctl(xoss_fd_info_t *info, unsigned long request, void *argp) {
    switch (request) {
    case CDROMREADTOCHDR:
        ioctl_cdrom_read_tochdr((struct cdrom_tochdr *)argp);
        break;
    case CDROMREADTOCENTRY:
        ioctl_cdrom_read_tocentry((struct cdrom_tocentry *)argp);
        break;
    case CDROMPLAYTRK:
        ioctl_cdrom_play_track(info, (struct cdrom_ti *)argp);
        break;
    case CDROMPAUSE:
        info->cd_status = CDROM_AUDIO_PAUSED;
        send_cd_control(2, info->current_track);
        break;
    case CDROMRESUME:
        info->cd_status = CDROM_AUDIO_PLAY;
        send_cd_control(3, info->current_track);
        break;
    case CDROMSUBCHNL:
        ioctl_cdrom_subchnl(info, (struct cdrom_subchnl *)argp);
        break;
    case CDROMSTOP:
        info->cd_status = CDROM_AUDIO_NO_STATUS;
        send_cd_control(4, info->current_track);
        break;
    default:
        break;
    }
    return 0;
}

static int dispatch_xoss_ioctl(xoss_fd_info_t *info, unsigned long request, void *argp) {
    if (info->type == FD_TYPE_AUDIO) {
        return handle_audio_ioctl(info, request, argp);
    }
    if (info->type == FD_TYPE_CDROM) {
        return handle_cdrom_ioctl(info, request, argp);
    }
    return 0;
}

#endif /* XOSS_IOCTL_H */
