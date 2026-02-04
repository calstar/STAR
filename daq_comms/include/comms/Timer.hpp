#ifndef _TIMER_HPP_
#define _TIMER_HPP_
#include <time.h>

#include <cstdint>

class Timer {
public:
    // Starts the timer
    /*
     * @return: A timespec struct with the start time
     */
    static inline struct timespec tic() {
        struct timespec startTime;
        clock_gettime(CLOCK_MONOTONIC, &startTime);
        return startTime;
    }

    // Stops the timer and returns the elapsed time in seconds.
    /*
     * @param startTime: The timespec struct with the start time of the timer
     * @return: The elapsed time in seconds as a double
     */
    static inline double toc(const struct timespec &startTime) {
        struct timespec endTime;
        clock_gettime(CLOCK_MONOTONIC, &endTime);
        return (static_cast<double>(endTime.tv_sec) - static_cast<double>(startTime.tv_sec)) +
               (static_cast<double>(endTime.tv_nsec) - static_cast<double>(startTime.tv_nsec)) /
                   1e9;
    }

    // Get current time in seconds as a double
    /*
     * @param time_s: (output) Sets time_s to the current time in seconds as a
     * double
     */
    static inline void get_time(double &time_s) {
        struct timespec curTime;
        clock_gettime(CLOCK_MONOTONIC, &curTime);
        time_s = curTime.tv_sec + curTime.tv_nsec / 1e9;
    }

    // Get current time in seconds as a double
    /*
     * @return: The current time in seconds as a double
     */
    static inline double get_time() {
        double time_s;
        get_time(time_s);
        return time_s;
    }

    // Get current time in nanoseconds as an int64_t
    /*
     * @param time_ns: (output) Sets time_ns to the current time in nanoseconds
     * as an int64_t
     */
    static inline void get_time(uint64_t &time_ns) {
        struct timespec curTime;
        clock_gettime(CLOCK_MONOTONIC, &curTime);
        time_ns = static_cast<uint64_t>(curTime.tv_sec) * static_cast<int64_t>(1000000000) +
                  curTime.tv_nsec;
    }

    // Get current time in nanoseconds as an int64_t
    /*
     * @return: The current time in nanoseconds as an int64_t
     */
    static inline uint64_t get_time_ns() {
        uint64_t time_ns;
        get_time(time_ns);
        return time_ns;
    }

    // Get current time in seconds as two int32_ts, seconds and nanoseconds
    /*
     * @param time_sec: (output) Sets time_sec to the seconds part of the
     * current time
     * @param time_nsec: (output) Sets time_nsec to the nanoseconds part of the
     * current time
     */
    static inline void get_time(int32_t &time_sec, int32_t &time_nsec) {
        struct timespec curTime;
        clock_gettime(CLOCK_MONOTONIC, &curTime);
        time_sec = static_cast<int32_t>(curTime.tv_sec);
        time_nsec = static_cast<int32_t>(curTime.tv_nsec);
    }
};
#endif  // _TIMER_HPP_
