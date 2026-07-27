# Verification Checklist

- [x] Qamomile + CUDA-Q remains the quantum path.
- [x] Demo requires NVIDIA GPU and disables NumPy fallback.
- [x] Demo is Hybrid-only; full MILP comparison is offline.
- [x] One fixed quantum profile is shared by demo and benchmarks.
- [x] Top-K scales with generator count in applicable benchmarks.
- [x] Qubit scaling keeps Top-K constant.
- [x] Active block fills non-rectangular budgets such as q=14 and q=26.
- [x] Duplicate ED solves removed from the outer loop.
- [x] Final feasible flag reuses full candidate validation.
- [x] One full first-run warm-up is discarded for every unique quantum configuration.
- [x] All three separated benchmarks use the IEEE30-derived data family.
- [x] HTML report generation included.
- [x] Backend and benchmark tests pass (15/15).
