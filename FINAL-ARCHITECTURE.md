# Final Architecture

## GPU demo

- React/Vite at `localhost:5173`.
- FastAPI at `localhost:8000`.
- Hybrid-only result contract: `pil-hquc-hybrid-v1`.
- Qamomile → CUDA-Q target `nvidia`; CPU/NumPy fallback disabled.
- Fixed profile: p=1, 256 final shots, 64 fallback optimizer shots, 6 COBYLA evaluations, maximum 2 ADMM-guided rounds.
- Demo active block: q=10, Top-K=10.
- Frontend sends only the 24-hour operating scenario. Solver settings are controlled by the backend.

## Safe pipeline optimizations

- Removed duplicate strict/relaxed ED solves before the outer loop.
- Reused the final accepted strict ED instead of solving it again.
- Reused `accepted_candidate.is_feasible` in early stopping and final payload.
- Kept the existing QUBO, Hamiltonian, ED constraints, residual definition and scoring formula.
- Added separate QAOA, candidate-validation and end-to-end timing fields.

## Offline benchmark report

The former `evaluate/` and `compare_hybrid_milp.py` workflow was removed. The independent `benchmark/` package creates CSV, JSON, PNG and `benchmark_report.html`.

1. SimBench-derived Hybrid vs full MILP.
2. Fixed 10-generator qubit scaling: q=8,10,14,18,20,24,26.
3. Synthetic generator scaling: G=4,6,8,10,12,16,20 at q=10 and q=20.

Top-K:

```text
min(32, 256, max(10, ceil(1.5 × generator_count)))
```

It is constant in qubit scaling because generator count is fixed, and grows with generator count in the other two benchmarks.

## Validated benchmark scope

- 24-hour horizon.
- 4–20 synthetic dispatchable generators.
- 8–26 active qubits in the main report.
- Non-rectangular budgets use a structured rectangle plus adjacent high-score positions, so requested and actual active qubits match.
