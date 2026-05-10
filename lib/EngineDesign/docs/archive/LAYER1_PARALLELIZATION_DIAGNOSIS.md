# Layer 1 Static Optimizer - Parallelization & Speedup Diagnosis

## Executive Summary

The Layer 1 optimizer has **significant parallelization opportunities**, particularly in:
1. **CMA-ES population evaluation** (highest impact - ~48 candidates per iteration)
2. **Random restarts** (3 sequential restarts)
3. **Multi-track hybrid optimization** (multiple independent tracks)
4. **Block re-optimization** (blocks can be optimized independently)
5. **Random sampling phase** (20 sequential evaluations)

**Estimated speedup potential**: 5-20x depending on CPU cores available (assuming 8-16 cores).

---

## Detailed Analysis

### 1. CMA-ES Population Evaluation (HIGHEST PRIORITY) ⭐⭐⭐

**Location**: Lines 1326-1333, 1836-1876

**Current Implementation**:
```python
candidates = es.ask()
values = []
for cand in candidates:  # Sequential loop
    cand_arr = np.clip(np.asarray(cand, dtype=float), lower_bounds, upper_bounds)
    val = objective(cand_arr)  # Expensive: ~0.1-1s per evaluation
    values.append(float(val))
es.tell(candidates, values)
```

**Problem**: 
- Population size is **48** (line 1170)
- Each `objective()` call involves:
  - Config deep copy (line 790)
  - `PintleEngineRunner` creation (line 796)
  - `runner.evaluate()` - expensive physics solver (line 798)
- Total: **48 sequential evaluations per iteration**
- With ~150 iterations: **~7,200 sequential evaluations**

**Parallelization Opportunity**:
- Use `multiprocessing.Pool` or `concurrent.futures.ProcessPoolExecutor`
- Parallelize the entire population evaluation loop
- **Expected speedup**: 8-16x on 8-16 core machine (assuming linear scaling up to core count)

**Implementation Notes**:
- Need to make objective function picklable (may require refactoring closures)
- Cache is thread-safe (dict operations), but consider using `multiprocessing.Manager().dict()` for shared cache
- Each worker needs its own `config_base` copy (already doing deepcopy)

**Code Pattern**:
```python
from concurrent.futures import ProcessPoolExecutor
# ... in CMA-ES loop ...
with ProcessPoolExecutor(max_workers=8) as executor:
    futures = [executor.submit(objective, np.clip(cand, lower_bounds, upper_bounds)) 
               for cand in candidates]
    values = [f.result() for f in futures]
```

---

### 2. Random Restarts (HIGH PRIORITY) ⭐⭐

**Location**: Lines 1271-1364

**Current Implementation**:
```python
for restart_idx in range(num_restarts):  # num_restarts = 3
    # ... run CMA-ES for this restart ...
```

**Problem**:
- 3 sequential restarts, each running full CMA-ES
- Each restart is independent (different starting point)
- Total time: 3 × single restart time

**Parallelization Opportunity**:
- Run all 3 restarts in parallel
- Each restart is independent, so no synchronization needed
- Collect best result from all restarts
- **Expected speedup**: ~3x (limited by number of restarts)

**Implementation Notes**:
- Each restart needs its own random seed or RNG state
- Need to merge results and select best
- Early stopping logic (line 1353) becomes more complex

---

### 3. Multi-Track Hybrid Optimization (HIGH PRIORITY) ⭐⭐

**Location**: Lines 1221-1245

**Current Implementation**:
```python
for track_i in range(num_tracks):
    # ... run hybrid optimization for this track ...
```

**Problem**:
- Multiple independent tracks run sequentially
- Each track runs full hybrid optimization (Stage A + cycles)
- Total time: num_tracks × single track time

**Parallelization Opportunity**:
- Run all tracks in parallel
- Each track is completely independent
- **Expected speedup**: ~num_tracks (if num_tracks ≤ CPU cores)

**Implementation Notes**:
- Each track needs its own RNG state
- Simple to parallelize with `ProcessPoolExecutor`

---

### 4. Block Re-optimization (MEDIUM PRIORITY) ⭐

**Location**: Lines 2139-2189

**Current Implementation**:
```python
for b_i, block_indices in enumerate(blocks):
    # ... optimize this block ...
```

**Problem**:
- Blocks are optimized sequentially
- Each block optimization is independent (different variable subsets)
- Number of blocks: typically 2-5

**Parallelization Opportunity**:
- Optimize multiple blocks in parallel
- **Expected speedup**: ~2-5x (limited by number of blocks)

**Implementation Notes**:
- Blocks share `current_x` baseline, but updates are independent
- Need to merge results after all blocks complete
- Consider using locks if updating shared state

---

### 5. Random Sampling Phase (LOW PRIORITY) ⭐

**Location**: Lines 278-290

**Current Implementation**:
```python
for _ in range(n_random):  # n_random = 5-20
    candidate = lower + rng.random(dim) * (upper - lower)
    f_val = float(objective(candidate))
```

**Problem**:
- 5-20 sequential random evaluations
- Each evaluation is independent

**Parallelization Opportunity**:
- Parallelize random sampling
- **Expected speedup**: ~5-20x (limited by n_random)

**Implementation Notes**:
- Small impact compared to CMA-ES (only 5-20 evals vs 7,200)
- Easy to parallelize

---

### 6. Differential Evolution (LOW PRIORITY)

**Location**: Lines 323-334

**Current Implementation**:
- Uses scipy's `differential_evolution`
- Scipy may have some internal parallelization, but wrapped objective is sequential

**Parallelization Opportunity**:
- Scipy's DE supports `workers` parameter for parallelization
- **Expected speedup**: Limited (DE is only used briefly in global search)

---

## Non-Parallelization Speed Improvements

### 1. Reduce Deep Copy Overhead

**Location**: Lines 790, 1458, 477

**Problem**:
- Multiple `copy.deepcopy(config_base)` calls per evaluation
- Deep copy of complex config objects is expensive (~10-50ms)

**Optimization**:
- Use shallow copy + selective deep copy only for mutable nested objects
- Cache config copies if geometry hasn't changed
- Consider using `copy.copy()` with manual deep copy only for specific attributes

**Expected speedup**: 10-20% reduction in per-evaluation time

---

### 2. Optimize Cache Key Generation

**Location**: Lines 617-631

**Problem**:
- Cache key generation involves multiple array operations and rounding
- Called for every evaluation

**Optimization**:
- Pre-compute cache steps once
- Use faster hashing (e.g., `hashlib.md5` of quantized array)
- Consider using `functools.lru_cache` with custom key function

**Expected speedup**: 1-5% reduction in per-evaluation time

---

### 3. Early Feasibility Checks

**Location**: Lines 684-886

**Current Implementation**: Already good!
- Geometric validation before expensive evaluation
- Skips evaluation if infeasible

**Further Optimization**:
- Consider vectorizing some geometric checks
- Pre-compute constant terms

**Expected speedup**: 1-2% (already well-optimized)

---

### 4. Reduce Logger Flush Frequency

**Location**: Lines 672-673, 1075-1076, 1357-1358

**Problem**:
- Frequent `handler.flush()` calls
- File I/O is slow

**Optimization**:
- Flush only every N iterations or on best updates
- Use buffered logging

**Expected speedup**: 1-3% (small but easy win)

---

### 5. Optimize Objective Function Structure

**Location**: Lines 642-1113

**Problem**:
- Large nested function with many local variables
- Some redundant calculations

**Optimization**:
- Extract common calculations outside loop
- Use numpy vectorization where possible
- Profile to identify hotspots

**Expected speedup**: 2-5%

---

## Implementation Priority

### Phase 1: High Impact, Low Risk
1. **CMA-ES population parallelization** (8-16x speedup)
   - Highest impact
   - Relatively straightforward
   - Requires making objective picklable

### Phase 2: Medium Impact, Low Risk
2. **Random restarts parallelization** (3x speedup)
   - Easy to implement
   - Independent restarts

3. **Multi-track parallelization** (num_tracks speedup)
   - Easy to implement
   - Independent tracks

### Phase 3: Lower Impact
4. **Block re-optimization parallelization** (2-5x speedup)
   - More complex (shared state)
   - Lower impact

5. **Random sampling parallelization** (5-20x but small absolute impact)
   - Easy but low impact

6. **Deep copy optimization** (10-20% speedup)
   - Moderate effort
   - Good incremental improvement

---

## Technical Considerations

### Thread Safety
- **Cache**: Current dict is thread-safe for reads, but consider `multiprocessing.Manager().dict()` for shared cache across processes
- **Logger**: Python logging is thread-safe
- **RNG**: Each worker needs its own RNG state

### Memory Considerations
- Parallel evaluation increases memory usage (N workers × config size)
- Consider limiting worker count based on available memory
- Use process pool instead of thread pool (GIL limitation for CPU-bound work)

### Pickling Requirements
- Objective function closure needs to be picklable
- May need to refactor to avoid closures or use `functools.partial`
- Config objects need to be picklable (likely already are)

### Load Balancing
- CMA-ES evaluations are roughly equal duration
- Good for static load balancing
- Consider dynamic work stealing if evaluation times vary significantly

---

## Estimated Overall Speedup

**Conservative estimate** (8-core machine):
- CMA-ES parallelization: 6x (not perfect scaling)
- Random restarts: 2.5x (overhead)
- Other optimizations: 1.2x
- **Total: ~18x speedup**

**Optimistic estimate** (16-core machine):
- CMA-ES parallelization: 12x
- Random restarts: 2.8x
- Multi-track: 3x (if using 3 tracks)
- Other optimizations: 1.3x
- **Total: ~130x speedup** (but this assumes all optimizations combined)

**Realistic estimate** (8-core machine, Phase 1 only):
- CMA-ES parallelization: 6x
- **Total: ~6x speedup** (most practical)

---

## Recommendations

1. **Start with CMA-ES population parallelization** - highest impact, manageable complexity
2. **Add random restarts parallelization** - easy win, good speedup
3. **Profile before optimizing** - use `cProfile` to identify actual bottlenecks
4. **Consider using `joblib`** - easier parallelization API than raw multiprocessing
5. **Add configuration option** - allow users to control parallelization (number of workers)

---

## Code Locations Summary

| Optimization | Lines | Impact | Difficulty |
|------------|-------|--------|------------|
| CMA-ES population | 1329-1332, 1843-1876 | ⭐⭐⭐ | Medium |
| Random restarts | 1271-1364 | ⭐⭐ | Easy |
| Multi-track | 1221-1245 | ⭐⭐ | Easy |
| Block re-opt | 2139-2189 | ⭐ | Medium |
| Random sampling | 278-290 | ⭐ | Easy |
| Deep copy | 790, 1458, 477 | ⭐ | Medium |
| Cache key | 617-631 | ⭐ | Easy |

---

## Notes

- L-BFGS-B refinement (lines 1389-1410) is inherently sequential (gradient-based)
- Caching is already well-implemented (lines 615-809)
- Early feasibility checks are already good (lines 684-886)
- The expensive operation is `runner.evaluate()` which involves physics solvers - this is CPU-bound and perfect for parallelization




