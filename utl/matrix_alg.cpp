#include <iostream>
#include <cstdio>

// double tranpose()

// double ones()

// double eye()

// double matmul()

// double abs() {
//     // In place modify each element to its absolute value
// }

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

size_t printed_length(double value) {
    char buffer[64]; // big enough for any double representation
    int len = std::snprintf(buffer, sizeof(buffer), "%g", value);
    return static_cast<size_t>(len);
}

void print_matrix(double* matrix, size_t n, size_t m) {
    size_t longest_num_in_col[n];
    for (size_t col = 0; col < n; col++) {
        longest_num_in_col[col] = 0;
        for (size_t row = 0; row < m; row++) {
            size_t len = printed_length(matrix[row * n + col]);
            if (len > longest_num_in_col[col]) {
                longest_num_in_col[col] = len;
            }
        }
    }

    std::cout << "[";
    for (size_t row = 0; row < m; row++) {
        if (row > 0) std::cout << " ";
        std::cout << "[";

        for (size_t col = 0; col < n; col++) {
            size_t pad_size = longest_num_in_col[col] - printed_length(matrix[row * n + col]);
            std::cout << std::string(pad_size + 1, ' ') << matrix[row * n + col];
            if (col < n - 1) std::cout << ",";
        }

        std::cout << " ";
        if (row == m - 1) std::cout << "]";
        std::cout << "]" << std::endl;
    }
}


int main() {
    std::cout << "Matrix algorithms module loaded." << std::endl;
    
    // Define dimensions
    size_t n = 3; // width
    size_t m = 4; // height
    double matrix[n * m];
    print_matrix(matrix, n, m);

    return 0;
}