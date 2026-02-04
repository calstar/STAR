#include <algorithm>
#include <chrono>
#include <cmath>
#include <iostream>
#include <string>

#include "matrix_alg.hpp"

void random_fill(double* matrix, size_t n, size_t m, float sparsity = 0.0) {
    // Fill the matrix with random values between -100 and 100
    for (size_t i = 0; i < n * m; ++i) {
        if (((double)rand() / RAND_MAX) > sparsity) {
            matrix[i] = ((double)rand() / RAND_MAX) * 200.0 - 100.0;
        } else {
            matrix[i] = 0.0;
        }
    }
}

auto time_matmul(double* out, const size_t out_width, const size_t out_height) {
    alignas(64) double A[out_width * out_height];
    alignas(64) double B[out_width * out_height];
    random_fill(A, out_width, out_height, 0.8);
    random_fill(B, out_width, out_height, 0.8);

    auto t0 = std::chrono::high_resolution_clock::now();

    matmul(A, out_width, out_height, B, out_width, out_height, out);

    auto t1 = std::chrono::high_resolution_clock::now();
    return std::chrono::duration<double, std::nano>(t1 - t0).count();
}

//----------------------------------
// Benchmarks (rectangular & square)
//----------------------------------
int main() {
    std::cout << "\n=== Benchmark Tests (averaged) ===\n";
    constexpr size_t out_width = 35, out_height = 35;
    alignas(64) double out[out_width * out_height];

    // Prevent compiler optimizing away the entire matmul call
    static volatile double sink;

    const int repeats = 100000;
    double total_nanoseconds = 0.0;
    for (int i = 0; i < repeats; ++i) {
        total_nanoseconds += time_matmul(out, out_width, out_height);

        double check = 0.0;
        for (size_t i = 0; i < out_width * out_height; i++)
            check += out[i];
        sink = check;  // observable side effect
    }
    double avg_nanoseconds = total_nanoseconds / repeats;
    std::cout << "matmul(" << out_height << "x" << out_width << " * " << out_height << "x"
              << out_width << "): " << avg_nanoseconds << " nanoseconds (avg of " << repeats / 1000
              << "k runs)\n";

    // Check accuracy by multiplying a 2x3 matrix by a 3x2 matrix
    std::cout << "\n=== Accuracy Test ===\n";
    alignas(64) double A[2 * 3];
    alignas(64) double B[3 * 2];
    std::fill(A, A + 6, 1.0);
    std::fill(B, B + 6, 1.0);
    matmul(A, 3, 2, B, 2, 3, out);

    if (std::all_of(out, out + 4, [](double v) {
            return std::fabs(v - 3.0) < 1e-9;
        })) {
        std::cout << "\033[32mAccuracy test passed.\033[0m" << std::endl;
    } else {
        std::cout << "\033[1;31mAccuracy test failed.\033[0m\nOutput:" << std::endl;
        print_matrix(out, 2, 2);
    }

    std::cout << std::endl;
    return 0;
}
