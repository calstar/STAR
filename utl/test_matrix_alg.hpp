#pragma once
#include <iostream>
#include <chrono>
#include <cmath>
#include <string>
#include "matrix_alg.hpp"

// ------------------------------
// Fast deterministic pseudo-random generator (no heap, no <random>)
// ------------------------------
inline double fast_rand01(unsigned long long &state) noexcept {
    state = state * 6364136223846793005ULL + 1;
    return static_cast<double>((state >> 11) & ((1ULL << 53) - 1)) / (1ULL << 53);
}

// Fill a matrix with random doubles in [-1, 1]
template<std::size_t R, std::size_t C>
void fill_random(SmallMat<R, C>& M, unsigned long long seed = 1ULL) {
    M.reshape(R, C);
    unsigned long long state = seed;
    for (std::size_t i = 0; i < R * C; ++i)
        M.a[i] = 2.0 * fast_rand01(state) - 1.0;
}

// Simple elementwise comparison
template<std::size_t R, std::size_t C>
bool nearly_equal(const SmallMat<R,C>& A, const SmallMat<R,C>& B, double tol=1e-9) {
    if (A.m != B.m || A.n != B.n) return false;
    for (std::size_t i=0;i<A.m*A.n;++i)
        if (std::fabs(A.a[i]-B.a[i]) > tol) return false;
    return true;
}

// Make a square identity matrix
template<std::size_t N>
void make_identity(SmallMat<N,N>& M) {
    M.reshape(N,N);
    for (std::size_t i = 0; i < N*N; ++i) M.a[i] = 0.0;
    for (std::size_t i = 0; i < N; ++i) M.a[i*M.n + i] = 1.0;
}

//----------------------------------
// Correctness tests
//----------------------------------
template<std::size_t MAX = 32>
void run_basic_tests() {
    using Mx = SmallMat<MAX, MAX>;
    std::cout << "\n=== Correctness Tests ===\n";

    // Matmul (rectangular)
    Mx A{}, B{};
    A.reshape(3,4); B.reshape(4,5);
    fill_random(A, 123); fill_random(B, 321);
    auto C = matmul(A, B);
    std::cout << "matmul(3x4 * 4x5) -> 3x5: "
              << "C(0,0)=" << C(0,0) << "  C(2,4)=" << C(2,4) << "\n";

    // Transpose test (square)
    Mx Tsq{};
    Tsq.reshape(4,4);
    fill_random(Tsq, 42);
    auto TsqT = transpose(Tsq);
    auto TsqTT = transpose(TsqT);
    std::cout << "transpose(4x4): A(0,1)=" << Tsq(0,1)
              << ", A_T(1,0)=" << TsqT(1,0) << "\n";
    std::cout << "Double transpose equals original? "
              << (nearly_equal(Tsq, TsqTT) ? "Yes" : "No") << "\n";

    // Transpose test (rectangular)
    Mx Trect{};
    Trect.reshape(3,5);
    fill_random(Trect, 555);
    auto TrectT = transpose(Trect);   // 5x3
    auto TrectTT = transpose(TrectT); // 3x5
    std::cout << "transpose(3x5): (A_T shape = " << TrectT.m
              << "x" << TrectT.n << ")\n";
    std::cout << "Double transpose equals original? "
              << (nearly_equal(Trect, TrectTT) ? "Yes" : "No") << "\n";

    // Inverse test (square)
    Mx S{};
    S.reshape(3,3);
    fill_random(S, 987);
    for (std::size_t i = 0; i < 3; ++i) S.a[i*S.n + i] += 5.0; // diagonal dominance

    auto Sinv = inverse<MAX>(S);
    auto I = matmul(S, Sinv);
    std::cout << "inverse(3x3):  I(0,0)=" << I(0,0)
              << "  I(0,1)=" << I(0,1)
              << "  I(1,1)=" << I(1,1) << "\n";
}

//----------------------------------
// Timing helper with averaging
//----------------------------------
template<typename Fn>
void timeit_avg(const std::string& name, Fn&& f, int repeats = 5) {
    double total_microseconds = 0.0;
    for (int i = 0; i < repeats; ++i) {
        auto t0 = std::chrono::high_resolution_clock::now();
        f();
        auto t1 = std::chrono::high_resolution_clock::now();
        total_microseconds += std::chrono::duration<double, std::micro>(t1 - t0).count();
    }
    double avg_microseconds = total_microseconds / repeats;
    std::cout << name << ": " << avg_microseconds << " microseconds (avg of " << repeats << " runs)\n";
}

//----------------------------------
// Benchmarks (rectangular & square)
//----------------------------------
template<std::size_t MAX = 32>
void run_benchmarks() {
    using Mx = SmallMat<MAX, MAX>;
    std::cout << "\n=== Benchmark Tests (averaged) ===\n";

    // matmul 12x7 * 7x30
    Mx A{}, B{};
    A.reshape(12,7); B.reshape(7,30);
    fill_random(A, 1001); fill_random(B, 2002);
    timeit_avg("matmul(12x7 * 7x30)", [&]() { auto C = matmul(A,B); });

    // matmul 24x24 * 24x24
    A.reshape(24,24); B.reshape(24,24);
    fill_random(A, 3003); fill_random(B, 4004);
    timeit_avg("matmul(24x24)", [&]() { auto C = matmul(A,B); });

    // transpose 24x30 (rectangular)
    A.reshape(24,30);
    fill_random(A, 5005);
    timeit_avg("transpose(24x30)", [&]() { auto AT = transpose(A); });

    // inverse 24x24
    A.reshape(24,24);
    fill_random(A, 6006);
    for (std::size_t i=0;i<24;++i) A.a[i*A.n + i] += 25.0;
    timeit_avg("inverse(24x24)", [&]() { auto Inv = inverse<MAX>(A); });
}