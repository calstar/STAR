#include <cstdio>
#include <iostream>

void transpose(double* matrix, size_t width, size_t height, double* out) {
    for (size_t i = 0; i < width; i++) {
        for (size_t j = 0; j < height; j++) {
            out[i * height + j] = matrix[j * width + i];
        }
    }
}

void zeros(double* matrix, size_t n, size_t m) {
    std::fill(matrix, matrix + n * m, 0.0);
}

void ones(double* matrix, size_t n, size_t m) {
    std::fill(matrix, matrix + n * m, 1.0);
}

void eye(double* matrix, size_t n, size_t m) {
    // Create identity matrix
    zeros(matrix, n, m);

    size_t min_dim = (n < m) ? n : m;
    for (size_t i = 0; i < min_dim; i++) {
        matrix[i * n + i] = 1.0;
    }
}

void matmul(double* A, size_t a_width, size_t a_height, double* B, size_t b_width, size_t b_height,
            double* out) {
    // Standard matrix multiplication, with transposed B for cache efficiency
    alignas(64) double BT[b_width * b_height];
    transpose(B, b_width, b_height, BT);

    for (size_t i = 0; i < a_height; i++) {
        for (size_t j = 0; j < b_width; j++) {
            double sum = 0.0;
            for (size_t k = 0; k < a_width; k++) {
                sum += A[i * a_width + k] * BT[j * b_height + k];
            }
            out[i * b_width + j] = sum;
        }
    }
}

void abs(double* matrix, size_t n, size_t m) {
    // In place modify each element to its absolute value
    for (size_t i = 0; i < n * m; i++) {
        if (matrix[i] < 0) {
            matrix[i] = -matrix[i];
        }
    }
}

// double inv

// double l2_norm()

// double matrix_sum()

// double matrix_trace()

// double decompose (chelesky, plu, svd, orthonormal)

// double determinant()

// double is_PSD

// double is_PD

// double is_symmetric():

// double is_singular

// double is_diagonal()

// double inner_product()

// double cross_product

// double matrix_derivative

// double least_squares_solver(y, X, beta)

size_t _printed_length(double value) {
    char buffer[64];  // big enough for any double representation
    int len = std::snprintf(buffer, sizeof(buffer), "%g", value);
    return static_cast<size_t>(len);
}

void print_matrix(double* matrix, size_t n, size_t m) {
    size_t longest_num_in_col[n];
    for (size_t col = 0; col < n; col++) {
        longest_num_in_col[col] = 0;
        for (size_t row = 0; row < m; row++) {
            size_t len = _printed_length(matrix[row * n + col]);
            if (len > longest_num_in_col[col]) {
                longest_num_in_col[col] = len;
            }
        }
    }

    std::cout << "[";
    for (size_t row = 0; row < m; row++) {
        if (row > 0)
            std::cout << " ";
        std::cout << "[";

        for (size_t col = 0; col < n; col++) {
            size_t pad_size = longest_num_in_col[col] - _printed_length(matrix[row * n + col]);
            std::cout << std::string(pad_size + 1, ' ') << matrix[row * n + col];
            if (col < n - 1)
                std::cout << ",";
        }

        std::cout << " ";
        if (row == m - 1)
            std::cout << "]";
        std::cout << "]" << std::endl;
    }
}
