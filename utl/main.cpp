#include "test_matrix_alg.hpp"

int main() {
    run_basic_tests<32>();
    run_benchmarks<32>();
    return 0;
}