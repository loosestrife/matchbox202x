/*
 * test_glquake_sim.c - Simulated 1997 glquake.glx audio & CD-ROM subsystem test.
 *
 * Simulates opening /dev/dsp and /dev/cdrom, calling soundcard and cdrom ioctls,
 * and writing PCM audio blocks.
 */

#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <sys/soundcard.h>
#include <linux/cdrom.h>
#include <math.h>

#ifndef CDROMPLAYTRK
#define CDROMPLAYTRK 0x5304
#endif

static void configure_dsp_audio(int audio_fd) {
    int rate = 22050;
    if (ioctl(audio_fd, SNDCTL_DSP_SPEED, &rate) < 0) {
        perror("SNDCTL_DSP_SPEED");
    } else {
        printf("Set sample rate: %d Hz\n", rate);
    }

    int channels = 2;
    if (ioctl(audio_fd, SNDCTL_DSP_STEREO, &channels) < 0) {
        perror("SNDCTL_DSP_STEREO");
    } else {
        printf("Set channels: %d (stereo)\n", channels);
    }

    int format = AFMT_S16_LE;
    if (ioctl(audio_fd, SNDCTL_DSP_SETFMT, &format) < 0) {
        perror("SNDCTL_DSP_SETFMT");
    } else {
        printf("Set format: 16-bit LE PCM\n");
    }

    audio_buf_info abi;
    if (ioctl(audio_fd, SNDCTL_DSP_GETOSPACE, &abi) == 0) {
        printf("GETOSPACE: %d fragments, fragsize = %d bytes, free bytes = %d\n",
               abi.fragments, abi.fragsize, abi.bytes);
    }
}

static void write_test_pcm_frames(int audio_fd) {
    int samples_per_block = (22050 * 50) / 1000;
    int block_bytes = samples_per_block * 2 * 2;
    short pcm[2205];

    printf("Writing 10 audio PCM frames (50ms each)...\n");
    for (int frame = 0; frame < 10; frame++) {
        for (int i = 0; i < samples_per_block; i++) {
            double t = (double)(frame * samples_per_block + i) / 22050.0;
            short val = (short)(12000.0 * sin(2.0 * 3.14159265 * 440.0 * t));
            pcm[i * 2] = val;
            pcm[i * 2 + 1] = val;
        }
        ssize_t ret = write(audio_fd, pcm, block_bytes);
        printf("Wrote frame %d (%zd bytes)\n", frame + 1, ret);
        usleep(10000);
    }
}

static void test_cdrom_toc(int cd_fd) {
    struct cdrom_tochdr th;
    if (ioctl(cd_fd, CDROMREADTOCHDR, &th) == 0) {
        printf("CD TOC Header: start track %d, end track %d\n", th.cdth_trk0, th.cdth_trk1);
    }

    struct cdrom_tocentry te;
    te.cdte_track = 3;
    te.cdte_format = CDROM_MSF;
    if (ioctl(cd_fd, CDROMREADTOCENTRY, &te) == 0) {
        printf("Track 3 TOC Entry MSF: %02d:%02d:%02d (ctrl=0x%x)\n",
               te.cdte_addr.msf.minute, te.cdte_addr.msf.second, te.cdte_addr.msf.frame,
               te.cdte_ctrl);
    }
}

static void test_cdrom_playback(int cd_fd) {
    struct cdrom_ti ti;
    ti.cdti_trk0 = 3;
    ti.cdti_ind0 = 1;
    ti.cdti_trk1 = 3;
    ti.cdti_ind1 = 1;
    if (ioctl(cd_fd, CDROMPLAYTRK, &ti) == 0) {
        printf("CDROMPLAYTRK track %d initiated\n", ti.cdti_trk0);
    }

    struct cdrom_subchnl sub;
    sub.cdsc_format = CDROM_MSF;
    if (ioctl(cd_fd, CDROMSUBCHNL, &sub) == 0) {
        printf("CDROMSUBCHNL: status = %d, track = %d, rel MSF = %02d:%02d:%02d\n",
               sub.cdsc_audiostatus, sub.cdsc_trk,
               sub.cdsc_reladdr.msf.minute, sub.cdsc_reladdr.msf.second, sub.cdsc_reladdr.msf.frame);
    }
}

static void run_cdrom_simulation(void) {
    int cd_fd = open("/dev/cdrom", O_RDONLY);
    if (cd_fd < 0) {
        perror("open /dev/cdrom failed");
        return;
    }
    printf("Opened /dev/cdrom (fd = %d)\n", cd_fd);
    test_cdrom_toc(cd_fd);
    test_cdrom_playback(cd_fd);
    close(cd_fd);
}

int main(void) {
    printf("=== Simulated 1997 glquake.glx starting ===\n");

    int audio_fd = open("/dev/dsp", O_WRONLY);
    if (audio_fd < 0) {
        perror("open /dev/dsp failed");
        return 1;
    }
    printf("Opened /dev/dsp (fd = %d)\n", audio_fd);

    configure_dsp_audio(audio_fd);
    write_test_pcm_frames(audio_fd);
    run_cdrom_simulation();

    close(audio_fd);
    printf("=== glquake test finished successfully ===\n");
    return 0;
}
