#include <fcntl.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>
#include "video_src.h"
#include "h264_util.h"
#include "esp_check.h"
#include "esp_timer.h"
#include "esp_video_init.h"
#include "esp_video_device.h"
#include "linux/videodev2.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "video";
#define CAP_BUFS 2

typedef struct {
    video_src_config_t c;
    int cap_fd, enc_fd;
    uint8_t *cap_buf[CAP_BUFS];
    uint8_t *enc_buf;
} vs_t;
static vs_t s;
static volatile bool s_want_key;

void video_src_request_key(void) { s_want_key = true; }

static esp_err_t ctrl(int fd, uint32_t id, int32_t v)
{
    struct v4l2_ext_control c = { .id = id, .value = v };
    struct v4l2_ext_controls cs = { .ctrl_class = V4L2_CID_CODEC_CLASS, .count = 1, .controls = &c };
    return ioctl(fd, VIDIOC_S_EXT_CTRLS, &cs) == 0 ? ESP_OK : ESP_FAIL;
}

static esp_err_t setup(void)
{
    static esp_video_init_csi_config_t csi;
    csi.sccb_config.init_sccb = true;
    csi.sccb_config.i2c_config.port = s.c.sccb_port;
    csi.sccb_config.i2c_config.scl_pin = s.c.sccb_scl;
    csi.sccb_config.i2c_config.sda_pin = s.c.sccb_sda;
    csi.sccb_config.freq = 100000;
    csi.reset_pin = s.c.reset_pin;
    csi.pwdn_pin = s.c.pwdn_pin;
    esp_video_init_config_t vc = { .csi = &csi };
    ESP_RETURN_ON_ERROR(esp_video_init(&vc), TAG, "esp_video_init (camera on the SCCB bus?)");

    s.cap_fd = open(ESP_VIDEO_MIPI_CSI_DEVICE_NAME, O_RDONLY);
    ESP_RETURN_ON_FALSE(s.cap_fd >= 0, ESP_FAIL, TAG, "open camera");
    s.enc_fd = open(ESP_VIDEO_H264_DEVICE_NAME, O_RDONLY);
    ESP_RETURN_ON_FALSE(s.enc_fd >= 0, ESP_FAIL, TAG, "open H.264 encoder");

    if (ctrl(s.enc_fd, V4L2_CID_MPEG_VIDEO_H264_I_PERIOD, s.c.gop) != ESP_OK ||
        ctrl(s.enc_fd, V4L2_CID_MPEG_VIDEO_BITRATE, s.c.bitrate) != ESP_OK ||
        ctrl(s.enc_fd, V4L2_CID_MPEG_VIDEO_H264_MIN_QP, s.c.min_qp) != ESP_OK ||
        ctrl(s.enc_fd, V4L2_CID_MPEG_VIDEO_H264_MAX_QP, s.c.max_qp) != ESP_OK)
        ESP_LOGW(TAG, "an H.264 control was refused");

    struct v4l2_format f = { .type = V4L2_BUF_TYPE_VIDEO_CAPTURE };
    f.fmt.pix.width = s.c.width;
    f.fmt.pix.height = s.c.height;
    f.fmt.pix.pixelformat = V4L2_PIX_FMT_YUV420;
    ESP_RETURN_ON_FALSE(ioctl(s.cap_fd, VIDIOC_S_FMT, &f) == 0, ESP_FAIL, TAG, "camera format");
    struct v4l2_requestbuffers rq = { .count = CAP_BUFS, .type = V4L2_BUF_TYPE_VIDEO_CAPTURE,
                                      .memory = V4L2_MEMORY_MMAP };
    ESP_RETURN_ON_FALSE(ioctl(s.cap_fd, VIDIOC_REQBUFS, &rq) == 0, ESP_FAIL, TAG, "camera buffers");
    for (int i = 0; i < CAP_BUFS; i++) {
        struct v4l2_buffer b = { .type = V4L2_BUF_TYPE_VIDEO_CAPTURE, .memory = V4L2_MEMORY_MMAP, .index = i };
        ESP_RETURN_ON_FALSE(ioctl(s.cap_fd, VIDIOC_QUERYBUF, &b) == 0, ESP_FAIL, TAG, "querybuf");
        s.cap_buf[i] = mmap(NULL, b.length, PROT_READ | PROT_WRITE, MAP_SHARED, s.cap_fd, b.m.offset);
        ESP_RETURN_ON_FALSE(s.cap_buf[i], ESP_ERR_NO_MEM, TAG, "mmap");
        ESP_RETURN_ON_FALSE(ioctl(s.cap_fd, VIDIOC_QBUF, &b) == 0, ESP_FAIL, TAG, "qbuf");
    }

    // Encoder: raw frames in (OUTPUT, user pointers into the camera's
    // buffers), H.264 out (CAPTURE, one mmap buffer).
    f = (struct v4l2_format){ .type = V4L2_BUF_TYPE_VIDEO_OUTPUT };
    f.fmt.pix.width = s.c.width;
    f.fmt.pix.height = s.c.height;
    f.fmt.pix.pixelformat = V4L2_PIX_FMT_YUV420;
    ESP_RETURN_ON_FALSE(ioctl(s.enc_fd, VIDIOC_S_FMT, &f) == 0, ESP_FAIL, TAG, "encoder input format");
    rq = (struct v4l2_requestbuffers){ .count = 1, .type = V4L2_BUF_TYPE_VIDEO_OUTPUT, .memory = V4L2_MEMORY_USERPTR };
    ESP_RETURN_ON_FALSE(ioctl(s.enc_fd, VIDIOC_REQBUFS, &rq) == 0, ESP_FAIL, TAG, "encoder input");
    f = (struct v4l2_format){ .type = V4L2_BUF_TYPE_VIDEO_CAPTURE };
    f.fmt.pix.width = s.c.width;
    f.fmt.pix.height = s.c.height;
    f.fmt.pix.pixelformat = V4L2_PIX_FMT_H264;
    ESP_RETURN_ON_FALSE(ioctl(s.enc_fd, VIDIOC_S_FMT, &f) == 0, ESP_FAIL, TAG, "encoder output format");
    rq = (struct v4l2_requestbuffers){ .count = 1, .type = V4L2_BUF_TYPE_VIDEO_CAPTURE, .memory = V4L2_MEMORY_MMAP };
    ESP_RETURN_ON_FALSE(ioctl(s.enc_fd, VIDIOC_REQBUFS, &rq) == 0, ESP_FAIL, TAG, "encoder output");
    struct v4l2_buffer b = { .type = V4L2_BUF_TYPE_VIDEO_CAPTURE, .memory = V4L2_MEMORY_MMAP, .index = 0 };
    ESP_RETURN_ON_FALSE(ioctl(s.enc_fd, VIDIOC_QUERYBUF, &b) == 0, ESP_FAIL, TAG, "querybuf");
    s.enc_buf = mmap(NULL, b.length, PROT_READ | PROT_WRITE, MAP_SHARED, s.enc_fd, b.m.offset);
    ESP_RETURN_ON_FALSE(s.enc_buf, ESP_ERR_NO_MEM, TAG, "mmap");
    ESP_RETURN_ON_FALSE(ioctl(s.enc_fd, VIDIOC_QBUF, &b) == 0, ESP_FAIL, TAG, "qbuf");

    int t = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    ESP_RETURN_ON_FALSE(ioctl(s.enc_fd, VIDIOC_STREAMON, &t) == 0, ESP_FAIL, TAG, "encoder on");
    t = V4L2_BUF_TYPE_VIDEO_OUTPUT;
    ESP_RETURN_ON_FALSE(ioctl(s.enc_fd, VIDIOC_STREAMON, &t) == 0, ESP_FAIL, TAG, "encoder on");
    t = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    ESP_RETURN_ON_FALSE(ioctl(s.cap_fd, VIDIOC_STREAMON, &t) == 0, ESP_FAIL, TAG, "camera on");
    return ESP_OK;
}

static void task(void *arg)
{
    for (;;) {
        struct v4l2_buffer cb = { .type = V4L2_BUF_TYPE_VIDEO_CAPTURE, .memory = V4L2_MEMORY_MMAP };
        if (ioctl(s.cap_fd, VIDIOC_DQBUF, &cb) != 0) { vTaskDelay(1); continue; }
        int64_t t_us = esp_timer_get_time();
        struct v4l2_buffer in = { .type = V4L2_BUF_TYPE_VIDEO_OUTPUT, .memory = V4L2_MEMORY_USERPTR,
                                  .index = 0, .length = cb.bytesused };
        in.m.userptr = (unsigned long)s.cap_buf[cb.index];
        if (s_want_key) {
            s_want_key = false;
#ifdef V4L2_CID_MPEG_VIDEO_FORCE_KEY_FRAME
            if (ctrl(s.enc_fd, V4L2_CID_MPEG_VIDEO_FORCE_KEY_FRAME, 1) != ESP_OK)
#endif
                ESP_LOGW(TAG, "encoder will not force a key frame: next one in at most %d frames", s.c.gop);
        }
        struct v4l2_buffer out = { .type = V4L2_BUF_TYPE_VIDEO_CAPTURE, .memory = V4L2_MEMORY_MMAP };
        if (ioctl(s.enc_fd, VIDIOC_QBUF, &in) == 0 && ioctl(s.enc_fd, VIDIOC_DQBUF, &out) == 0) {
            s.c.cb(s.enc_buf, out.bytesused, h264_au_is_idr(s.enc_buf, out.bytesused), t_us, s.c.arg);
            ioctl(s.enc_fd, VIDIOC_DQBUF, &in);
            ioctl(s.enc_fd, VIDIOC_QBUF, &out);
        }
        ioctl(s.cap_fd, VIDIOC_QBUF, &cb);
    }
}

esp_err_t video_src_start(const video_src_config_t *cfg)
{
    s.c = *cfg;
    ESP_RETURN_ON_ERROR(setup(), TAG, "setup");
    ESP_LOGI(TAG, "camera %dx%d -> H.264 %d bit/s, GOP %d", cfg->width, cfg->height, cfg->bitrate, cfg->gop);
    return xTaskCreate(task, "video", 6144, NULL, 6, NULL) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}
