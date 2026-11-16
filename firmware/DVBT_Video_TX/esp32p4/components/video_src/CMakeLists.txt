# Needs Espressif's esp_video (tools/fetch-video-deps.sh); without it this
# component is empty and the firmware runs the service without video.
if(EXISTS ${CMAKE_CURRENT_LIST_DIR}/../../third_party/esp-video-components)
    idf_component_register(SRCS "h264_util.c" "video_src.c" INCLUDE_DIRS "include"
                           PRIV_REQUIRES esp_video esp_timer freertos)
else()
    idf_component_register(SRCS "h264_util.c" INCLUDE_DIRS "include")
endif()
