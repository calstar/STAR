#ifndef COMMS_LINEAR_ALGEBRA_HPP
#define COMMS_LINEAR_ALGEBRA_HPP

#include "Matrix.hpp"
#include <cmath>
#include <algorithm>
#include <stdexcept>

namespace comms {
namespace math {

/**
 * @brief Linear algebra operations for sensor calibration and filtering
 * 
 * Standalone implementation for DAQ system.
 * Provides matrix decompositions, solving, and advanced operations needed
 * for Bayesian calibration and filtering algorithms.
 */

// Cholesky decomposition: A = L * L^T (for positive definite matrices)
// A: n x n (input/output), L: n x n (output, lower triangular)
// Returns true if successful, false if matrix is not positive definite
inline bool cholesky_decompose(double* A, size_t n, double* L) {
    // Initialize L to zero
    matrix_zeros(L, n, n);
    
    for (size_t i = 0; i < n; i++) {
        for (size_t j = 0; j <= i; j++) {
            double sum = 0.0;
            if (j == i) {
                // Diagonal element
                for (size_t k = 0; k < j; k++) {
                    sum += L[j * n + k] * L[j * n + k];
                }
                double diag = A[i * n + i] - sum;
                if (diag <= 0.0) {
                    return false; // Not positive definite
                }
                L[i * n + i] = std::sqrt(diag);
            } else {
                // Off-diagonal element
                for (size_t k = 0; k < j; k++) {
                    sum += L[i * n + k] * L[j * n + k];
                }
                L[i * n + j] = (A[i * n + j] - sum) / L[j * n + j];
            }
        }
    }
    return true;
}

// Solve L * x = b where L is lower triangular
inline void solve_lower_triangular(const double* L, size_t n, const double* b, double* x) {
    for (size_t i = 0; i < n; i++) {
        double sum = 0.0;
        for (size_t j = 0; j < i; j++) {
            sum += L[i * n + j] * x[j];
        }
        x[i] = (b[i] - sum) / L[i * n + i];
    }
}

// Solve L^T * x = b where L^T is upper triangular
inline void solve_upper_triangular(const double* L, size_t n, const double* b, double* x) {
    for (int i = static_cast<int>(n) - 1; i >= 0; i--) {
        double sum = 0.0;
        for (size_t j = static_cast<size_t>(i) + 1; j < n; j++) {
            sum += L[j * n + i] * x[j]; // Note: L^T[j][i] = L[i][j]
        }
        x[i] = (b[i] - sum) / L[i * n + i];
    }
}

// Solve A * x = b using Cholesky decomposition
// A: n x n (positive definite), b: n x 1, x: n x 1 (output)
inline bool solve_cholesky(const double* A, size_t n, const double* b, double* x) {
    // Allocate workspace
    double* L = new double[n * n];
    
    // Decompose A = L * L^T
    if (!cholesky_decompose(const_cast<double*>(A), n, L)) {
        delete[] L;
        return false;
    }
    
    // Solve L * y = b
    double* y = new double[n];
    solve_lower_triangular(L, n, b, y);
    
    // Solve L^T * x = y
    solve_upper_triangular(L, n, y, x);
    
    delete[] y;
    delete[] L;
    return true;
}

// Matrix inverse using Cholesky decomposition (for positive definite matrices)
// A: n x n (input), A_inv: n x n (output)
inline bool matrix_inverse_cholesky(const double* A, size_t n, double* A_inv) {
    // Allocate workspace
    double* L = new double[n * n];
    
    // Decompose A = L * L^T
    if (!cholesky_decompose(const_cast<double*>(A), n, L)) {
        delete[] L;
        return false;
    }
    
    // Solve L * L^T * A_inv = I column by column
    double* b = new double[n];
    double* x = new double[n];
    
    for (size_t j = 0; j < n; j++) {
        // Set b to j-th column of identity matrix
        std::fill(b, b + n, 0.0);
        b[j] = 1.0;
        
        // Solve L * y = b
        solve_lower_triangular(L, n, b, x);
        
        // Solve L^T * col = y
        solve_upper_triangular(L, n, x, b);
        
        // Copy result to j-th column of A_inv
        for (size_t i = 0; i < n; i++) {
            A_inv[i * n + j] = b[i];
        }
    }
    
    delete[] x;
    delete[] b;
    delete[] L;
    return true;
}

// Weighted least squares: solve (X^T * W * X) * beta = X^T * W * y
// X: m x n (design matrix), y: m x 1 (observations), W: m x m (diagonal weight matrix)
// beta: n x 1 (output coefficients)
inline bool weighted_least_squares(const double* X, size_t m, size_t n,
                                    const double* y, const double* W_diag,
                                    double* beta) {
    // Allocate workspace
    double* XTWX = new double[n * n];
    double* XTWy = new double[n];
    
    // Compute X^T * W * X (where W is diagonal)
    matrix_zeros(XTWX, n, n);
    for (size_t i = 0; i < n; i++) {
        for (size_t j = 0; j < n; j++) {
            double sum = 0.0;
            for (size_t k = 0; k < m; k++) {
                sum += X[k * n + i] * W_diag[k] * X[k * n + j];
            }
            XTWX[i * n + j] = sum;
        }
    }
    
    // Compute X^T * W * y
    std::fill(XTWy, XTWy + n, 0.0);
    for (size_t i = 0; i < n; i++) {
        double sum = 0.0;
        for (size_t k = 0; k < m; k++) {
            sum += X[k * n + i] * W_diag[k] * y[k];
        }
        XTWy[i] = sum;
    }
    
    // Solve (X^T * W * X) * beta = X^T * W * y using Cholesky
    bool success = solve_cholesky(XTWX, n, XTWy, beta);
    
    delete[] XTWy;
    delete[] XTWX;
    return success;
}

// Regularized weighted least squares (for Bayesian regression)
// Adds regularization term: (X^T * W * X + lambda * I) * beta = X^T * W * y
inline bool regularized_weighted_least_squares(const double* X, size_t m, size_t n,
                                                 const double* y, const double* W_diag,
                                                 double lambda, double* beta) {
    // Allocate workspace
    double* XTWX = new double[n * n];
    double* XTWy = new double[n];
    
    // Compute X^T * W * X
    matrix_zeros(XTWX, n, n);
    for (size_t i = 0; i < n; i++) {
        for (size_t j = 0; j < n; j++) {
            double sum = 0.0;
            for (size_t k = 0; k < m; k++) {
                sum += X[k * n + i] * W_diag[k] * X[k * n + j];
            }
            XTWX[i * n + j] = sum;
        }
    }
    
    // Add regularization: XTWX += lambda * I
    for (size_t i = 0; i < n; i++) {
        XTWX[i * n + i] += lambda;
    }
    
    // Compute X^T * W * y
    std::fill(XTWy, XTWy + n, 0.0);
    for (size_t i = 0; i < n; i++) {
        double sum = 0.0;
        for (size_t k = 0; k < m; k++) {
            sum += X[k * n + i] * W_diag[k] * y[k];
        }
        XTWy[i] = sum;
    }
    
    // Solve regularized system using Cholesky
    bool success = solve_cholesky(XTWX, n, XTWy, beta);
    
    delete[] XTWy;
    delete[] XTWX;
    return success;
}

} // namespace math
} // namespace comms

#endif // COMMS_LINEAR_ALGEBRA_HPP



