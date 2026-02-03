#ifndef COMMS_MATRIX_HPP
#define COMMS_MATRIX_HPP

#include <cstddef>
#include <cstring>
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace comms {
namespace math {

/**
 * @brief Matrix operations for sensor calibration and filtering
 * 
 * Standalone implementation for DAQ system.
 * Provides essential matrix operations needed for calibration algorithms.
 */

// Matrix multiplication: C = A * B
// A: m x n, B: n x p, C: m x p
inline void matrix_multiply(const double* A, size_t m, size_t n,
                            const double* B, size_t p,
                            double* C) {
    for (size_t i = 0; i < m; i++) {
        for (size_t j = 0; j < p; j++) {
            double sum = 0.0;
            for (size_t k = 0; k < n; k++) {
                sum += A[i * n + k] * B[k * p + j];
            }
            C[i * p + j] = sum;
        }
    }
}

// Matrix transpose: B = A^T
// A: m x n, B: n x m
inline void matrix_transpose(const double* A, size_t m, size_t n, double* B) {
    for (size_t i = 0; i < m; i++) {
        for (size_t j = 0; j < n; j++) {
            B[j * m + i] = A[i * n + j];
        }
    }
}

// Matrix addition: C = A + B
// All matrices: m x n
inline void matrix_add(const double* A, const double* B, size_t m, size_t n, double* C) {
    for (size_t i = 0; i < m * n; i++) {
        C[i] = A[i] + B[i];
    }
}

// Matrix subtraction: C = A - B
// All matrices: m x n
inline void matrix_subtract(const double* A, const double* B, size_t m, size_t n, double* C) {
    for (size_t i = 0; i < m * n; i++) {
        C[i] = A[i] - B[i];
    }
}

// Scalar multiplication: B = alpha * A
// A, B: m x n
inline void matrix_scale(const double* A, double alpha, size_t m, size_t n, double* B) {
    for (size_t i = 0; i < m * n; i++) {
        B[i] = alpha * A[i];
    }
}

// Initialize matrix to zeros
inline void matrix_zeros(double* A, size_t m, size_t n) {
    std::fill(A, A + m * n, 0.0);
}

// Initialize matrix to identity
inline void matrix_identity(double* A, size_t n) {
    matrix_zeros(A, n, n);
    for (size_t i = 0; i < n; i++) {
        A[i * n + i] = 1.0;
    }
}

// Copy matrix: B = A
inline void matrix_copy(const double* A, size_t m, size_t n, double* B) {
    std::memcpy(B, A, m * n * sizeof(double));
}

// Matrix-vector multiplication: y = A * x
// A: m x n, x: n x 1, y: m x 1
inline void matrix_vector_multiply(const double* A, size_t m, size_t n,
                                   const double* x, double* y) {
    for (size_t i = 0; i < m; i++) {
        double sum = 0.0;
        for (size_t j = 0; j < n; j++) {
            sum += A[i * n + j] * x[j];
        }
        y[i] = sum;
    }
}

// Vector dot product
inline double vector_dot(const double* a, const double* b, size_t n) {
    double sum = 0.0;
    for (size_t i = 0; i < n; i++) {
        sum += a[i] * b[i];
    }
    return sum;
}

// Vector L2 norm
inline double vector_norm(const double* a, size_t n) {
    return std::sqrt(vector_dot(a, a, n));
}

// Matrix trace (sum of diagonal elements)
inline double matrix_trace(const double* A, size_t n) {
    double sum = 0.0;
    for (size_t i = 0; i < n; i++) {
        sum += A[i * n + i];
    }
    return sum;
}

} // namespace math
} // namespace comms

#endif // COMMS_MATRIX_HPP

