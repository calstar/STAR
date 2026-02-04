#ifndef LINEAR_ALGEBRA_HPP
#define LINEAR_ALGEBRA_HPP

/**
 * @file LinearAlgebra.hpp
 * @brief Comprehensive Linear Algebra and Control System Analysis Library
 *
 * Provides robust matrix operations, decompositions, and control system analysis
 * tools for engine control and state estimation.
 *
 * Features:
 * - Matrix decompositions (LU, QR, SVD, Cholesky, Eigenvalue)
 * - Control system analysis (controllability, observability, stability)
 * - LQR/LQG solvers
 * - Riccati equation solvers
 * - System identification utilities
 * - Matrix properties and metrics
 * - Least squares and optimization
 */

#include <Eigen/Cholesky>
#include <Eigen/Dense>
#include <Eigen/Eigenvalues>
#include <Eigen/LU>
#include <Eigen/QR>
#include <Eigen/SVD>
#include <algorithm>
#include <cmath>
#include <complex>
#include <limits>
#include <stdexcept>
#include <vector>

namespace linalg {

using MatrixXd = Eigen::MatrixXd;
using VectorXd = Eigen::VectorXd;
using MatrixXcd = Eigen::MatrixXcd;
using VectorXcd = Eigen::VectorXcd;

/**
 * @brief Matrix decomposition types
 */
enum class DecompositionType {
    LU,          // LU decomposition
    QR,          // QR decomposition
    SVD,         // Singular Value Decomposition
    Cholesky,    // Cholesky decomposition (for positive definite)
    Eigenvalue,  // Eigenvalue decomposition
    Schur        // Schur decomposition
};

/**
 * @brief Matrix properties and analysis
 */
struct MatrixProperties {
    double determinant;
    double trace;
    double condition_number;
    int rank;
    bool is_singular;
    bool is_symmetric;
    bool is_positive_definite;
    bool is_positive_semidefinite;
    bool is_diagonal;
    bool is_orthogonal;
    double frobenius_norm;
    double spectral_norm;
    double max_eigenvalue;
    double min_eigenvalue;
};

/**
 * @brief Control system analysis results
 */
struct ControlSystemAnalysis {
    bool is_controllable;
    bool is_observable;
    bool is_stable;
    bool is_detectable;
    bool is_stabilizable;
    int controllability_rank;
    int observability_rank;
    double controllability_gramian_trace;
    double observability_gramian_trace;
    std::vector<std::complex<double>> eigenvalues;
    std::vector<std::complex<double>> controllable_modes;
    std::vector<std::complex<double>> observable_modes;
    MatrixXd controllability_matrix;
    MatrixXd observability_matrix;
};

/**
 * @brief LQR solution
 */
struct LQRSolution {
    MatrixXd K;              // Feedback gain matrix
    MatrixXd P;              // Riccati solution (cost-to-go matrix)
    VectorXd optimal_input;  // Optimal control input
    double cost;             // Optimal cost
    bool converged;          // Whether solution converged
    int iterations;          // Number of iterations
};

/**
 * @brief Matrix utilities and operations
 */
class MatrixUtils {
public:
    /**
     * @brief Compute matrix properties
     */
    static MatrixProperties analyze(const MatrixXd& A);

    /**
     * @brief Check if matrix is positive definite
     */
    static bool isPositiveDefinite(const MatrixXd& A);

    /**
     * @brief Check if matrix is positive semidefinite
     */
    static bool isPositiveSemidefinite(const MatrixXd& A);

    /**
     * @brief Compute matrix rank
     */
    static int rank(const MatrixXd& A, double tolerance = 1e-10);

    /**
     * @brief Compute condition number
     */
    static double conditionNumber(const MatrixXd& A);

    /**
     * @brief Compute determinant
     */
    static double determinant(const MatrixXd& A);

    /**
     * @brief Compute trace
     */
    static double trace(const MatrixXd& A);

    /**
     * @brief Check if matrix is symmetric
     */
    static bool isSymmetric(const MatrixXd& A, double tolerance = 1e-10);

    /**
     * @brief Check if matrix is diagonal
     */
    static bool isDiagonal(const MatrixXd& A, double tolerance = 1e-10);

    /**
     * @brief Check if matrix is orthogonal
     */
    static bool isOrthogonal(const MatrixXd& A, double tolerance = 1e-10);

    /**
     * @brief Compute Frobenius norm
     */
    static double frobeniusNorm(const MatrixXd& A);

    /**
     * @brief Compute spectral norm (largest singular value)
     */
    static double spectralNorm(const MatrixXd& A);

    /**
     * @brief Compute matrix inverse with error checking
     */
    static MatrixXd inverse(const MatrixXd& A);

    /**
     * @brief Compute Moore-Penrose pseudoinverse
     */
    static MatrixXd pseudoinverse(const MatrixXd& A, double tolerance = 1e-10);

    /**
     * @brief Solve linear system Ax = b
     */
    static VectorXd solve(const MatrixXd& A, const VectorXd& b);

    /**
     * @brief Solve least squares problem min ||Ax - b||^2
     */
    static VectorXd leastSquares(const MatrixXd& A, const VectorXd& b);

    /**
     * @brief Compute eigenvalues
     */
    static VectorXcd eigenvalues(const MatrixXd& A);

    /**
     * @brief Compute eigenvalues and eigenvectors
     */
    static std::pair<VectorXcd, MatrixXcd> eigenDecomposition(const MatrixXd& A);

    /**
     * @brief Compute singular values
     */
    static VectorXd singularValues(const MatrixXd& A);

    /**
     * @brief Compute SVD: A = U * S * V^T
     */
    static std::tuple<MatrixXd, VectorXd, MatrixXd> svd(const MatrixXd& A);

    /**
     * @brief Compute QR decomposition: A = Q * R
     */
    static std::pair<MatrixXd, MatrixXd> qrDecomposition(const MatrixXd& A);

    /**
     * @brief Compute LU decomposition: A = P * L * U
     */
    static std::tuple<MatrixXd, MatrixXd, MatrixXd> luDecomposition(const MatrixXd& A);

    /**
     * @brief Compute Cholesky decomposition: A = L * L^T (for positive definite)
     */
    static MatrixXd choleskyDecomposition(const MatrixXd& A);

    /**
     * @brief Compute matrix exponential: e^A
     */
    static MatrixXd matrixExponential(const MatrixXd& A);

    /**
     * @brief Compute matrix logarithm: log(A)
     */
    static MatrixXd matrixLogarithm(const MatrixXd& A);

    /**
     * @brief Compute matrix power: A^n
     */
    static MatrixXd matrixPower(const MatrixXd& A, int n);

    /**
     * @brief Compute matrix square root: sqrt(A)
     */
    static MatrixXd matrixSqrt(const MatrixXd& A);

    /**
     * @brief Compute Kronecker product: A ⊗ B
     */
    static MatrixXd kroneckerProduct(const MatrixXd& A, const MatrixXd& B);

    /**
     * @brief Compute vectorization: vec(A)
     */
    static VectorXd vectorize(const MatrixXd& A);

    /**
     * @brief Reshape vector to matrix
     */
    static MatrixXd reshape(const VectorXd& v, int rows, int cols);

    /**
     * @brief Extract diagonal
     */
    static VectorXd diagonal(const MatrixXd& A);

    /**
     * @brief Create diagonal matrix from vector
     */
    static MatrixXd diagonalMatrix(const VectorXd& v);

    /**
     * @brief Compute block diagonal matrix
     */
    static MatrixXd blockDiagonal(const std::vector<MatrixXd>& blocks);

    /**
     * @brief Compute matrix derivative: d(A*B)/dA
     */
    static MatrixXd matrixDerivative(const MatrixXd& A, const MatrixXd& B);
};

/**
 * @brief Control system analysis utilities
 */
class ControlAnalysis {
public:
    /**
     * @brief Check controllability of (A, B)
     * @param A State matrix (n x n)
     * @param B Input matrix (n x m)
     * @return true if controllable
     */
    static bool isControllable(const MatrixXd& A, const MatrixXd& B, double tolerance = 1e-10);

    /**
     * @brief Check observability of (A, C)
     * @param A State matrix (n x n)
     * @param C Output matrix (p x n)
     * @return true if observable
     */
    static bool isObservable(const MatrixXd& A, const MatrixXd& C, double tolerance = 1e-10);

    /**
     * @brief Check stability (all eigenvalues have negative real part)
     */
    static bool isStable(const MatrixXd& A, double tolerance = 1e-10);

    /**
     * @brief Check detectability (unobservable modes are stable)
     */
    static bool isDetectable(const MatrixXd& A, const MatrixXd& C, double tolerance = 1e-10);

    /**
     * @brief Check stabilizability (uncontrollable modes are stable)
     */
    static bool isStabilizable(const MatrixXd& A, const MatrixXd& B, double tolerance = 1e-10);

    /**
     * @brief Compute controllability matrix: [B AB A^2B ... A^(n-1)B]
     */
    static MatrixXd controllabilityMatrix(const MatrixXd& A, const MatrixXd& B);

    /**
     * @brief Compute observability matrix: [C; CA; CA^2; ...; CA^(n-1)]
     */
    static MatrixXd observabilityMatrix(const MatrixXd& A, const MatrixXd& C);

    /**
     * @brief Compute controllability Gramian: Wc = ∫ e^(At) B B^T e^(A^T t) dt
     */
    static MatrixXd controllabilityGramian(const MatrixXd& A, const MatrixXd& B, double T = 1.0);

    /**
     * @brief Compute observability Gramian: Wo = ∫ e^(A^T t) C^T C e^(At) dt
     */
    static MatrixXd observabilityGramian(const MatrixXd& A, const MatrixXd& C, double T = 1.0);

    /**
     * @brief Compute controllability indices
     */
    static std::vector<int> controllabilityIndices(const MatrixXd& A, const MatrixXd& B);

    /**
     * @brief Compute observability indices
     */
    static std::vector<int> observabilityIndices(const MatrixXd& A, const MatrixXd& C);

    /**
     * @brief Comprehensive control system analysis
     */
    static ControlSystemAnalysis analyze(const MatrixXd& A, const MatrixXd& B, const MatrixXd& C,
                                         const MatrixXd& D = MatrixXd());

    /**
     * @brief Compute system poles (eigenvalues of A)
     */
    static VectorXcd poles(const MatrixXd& A);

    /**
     * @brief Compute system zeros (for SISO systems)
     */
    static VectorXcd zeros(const MatrixXd& A, const MatrixXd& B, const MatrixXd& C,
                           const MatrixXd& D);

    /**
     * @brief Compute transfer function from state-space (SISO)
     */
    static std::vector<std::complex<double>> transferFunction(
        const MatrixXd& A, const MatrixXd& B, const MatrixXd& C, const MatrixXd& D,
        const std::vector<std::complex<double>>& s);
};

/**
 * @brief LQR solver
 */
class LQRSolver {
public:
    /**
     * @brief Solve continuous-time LQR: min ∫ (x^T Q x + u^T R u) dt
     * @param A State matrix
     * @param B Input matrix
     * @param Q State weighting matrix (positive semidefinite)
     * @param R Input weighting matrix (positive definite)
     * @param N Cross-coupling matrix (optional, default zero)
     * @param max_iterations Maximum iterations for Riccati solver
     * @param tolerance Convergence tolerance
     * @return LQR solution
     */
    static LQRSolution solve(const MatrixXd& A, const MatrixXd& B, const MatrixXd& Q,
                             const MatrixXd& R, const MatrixXd& N = MatrixXd(),
                             int max_iterations = 100, double tolerance = 1e-8);

    /**
     * @brief Solve discrete-time LQR
     */
    static LQRSolution solveDiscrete(const MatrixXd& A, const MatrixXd& B, const MatrixXd& Q,
                                     const MatrixXd& R, const MatrixXd& N = MatrixXd(),
                                     int max_iterations = 100, double tolerance = 1e-8);

    /**
     * @brief Compute optimal feedback gain: u = -K * x
     */
    static MatrixXd computeGain(const MatrixXd& A, const MatrixXd& B, const MatrixXd& Q,
                                const MatrixXd& R, const MatrixXd& N = MatrixXd());

    /**
     * @brief Solve algebraic Riccati equation: A^T P + P A - P B R^(-1) B^T P + Q = 0
     */
    static MatrixXd solveRiccati(const MatrixXd& A, const MatrixXd& B, const MatrixXd& Q,
                                 const MatrixXd& R, int max_iterations = 100,
                                 double tolerance = 1e-8);

    /**
     * @brief Solve discrete Riccati equation
     */
    static MatrixXd solveRiccatiDiscrete(const MatrixXd& A, const MatrixXd& B, const MatrixXd& Q,
                                         const MatrixXd& R, int max_iterations = 100,
                                         double tolerance = 1e-8);
};

/**
 * @brief Kalman filter utilities
 */
class KalmanFilter {
public:
    /**
     * @brief Compute Kalman gain
     * @param P Error covariance
     * @param C Output matrix
     * @param R Measurement noise covariance
     */
    static MatrixXd computeGain(const MatrixXd& P, const MatrixXd& C, const MatrixXd& R);

    /**
     * @brief Solve Riccati equation for steady-state Kalman filter
     * @param A State matrix
     * @param C Output matrix
     * @param Q Process noise covariance
     * @param R Measurement noise covariance
     */
    static MatrixXd solveSteadyStateCovariance(const MatrixXd& A, const MatrixXd& C,
                                               const MatrixXd& Q, const MatrixXd& R);
};

/**
 * @brief System identification utilities
 */
class SystemIdentification {
public:
    /**
     * @brief Identify state-space model from input-output data
     * Uses subspace identification (N4SID algorithm)
     */
    static std::tuple<MatrixXd, MatrixXd, MatrixXd, MatrixXd> identifyStateSpace(
        const MatrixXd& inputs, const MatrixXd& outputs, int state_dim, int horizon = 10);

    /**
     * @brief Compute impulse response
     */
    static MatrixXd impulseResponse(const MatrixXd& A, const MatrixXd& B, const MatrixXd& C,
                                    const MatrixXd& D, int num_samples);

    /**
     * @brief Compute step response
     */
    static MatrixXd stepResponse(const MatrixXd& A, const MatrixXd& B, const MatrixXd& C,
                                 const MatrixXd& D, int num_samples, double dt = 0.01);

    /**
     * @brief Compute frequency response (Bode plot data)
     */
    static std::pair<VectorXd, MatrixXcd> frequencyResponse(const MatrixXd& A, const MatrixXd& B,
                                                            const MatrixXd& C, const MatrixXd& D,
                                                            const VectorXd& frequencies);
};

/**
 * @brief Optimization utilities
 */
class Optimization {
public:
    /**
     * @brief Solve quadratic programming: min (1/2) x^T Q x + c^T x subject to Ax <= b
     */
    static VectorXd quadraticProgram(const MatrixXd& Q, const VectorXd& c, const MatrixXd& A,
                                     const VectorXd& b, const MatrixXd& Aeq = MatrixXd(),
                                     const VectorXd& beq = VectorXd());

    /**
     * @brief Solve linear programming: min c^T x subject to Ax <= b
     */
    static VectorXd linearProgram(const VectorXd& c, const MatrixXd& A, const VectorXd& b,
                                  const MatrixXd& Aeq = MatrixXd(),
                                  const VectorXd& beq = VectorXd());
};

}  // namespace linalg

// Include implementation (inline implementations)
#include "LinearAlgebra_impl.hpp"

#endif  // LINEAR_ALGEBRA_HPP
