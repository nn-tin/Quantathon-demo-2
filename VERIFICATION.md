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
- [x] One in-process warm-up is excluded from benchmark records.
- [x] Three benchmark experiments are separated.
- [x] HTML report generation included.
- [x] Backend tests pass.
