# Final Architecture

## GPU demo

- React/Vite frontend runs locally and calls the public FastAPI URL from Colab.
- Qamomile → CUDA-Q target `nvidia`; CPU/NumPy fallback disabled.
- Hybrid-only result contract; full Classical comparison remains offline.
- Fixed profile: p=1, 256 final shots, 64 fallback optimizer shots, 6 COBYLA evaluations, maximum 2 ADMM-guided rounds.
- Demo active block: q=10, Top-K=10.

## Safe pipeline optimizations

- Duplicate strict/relaxed ED solves are removed.
- The accepted strict ED and feasibility result are reused.
- Existing QUBO, Hamiltonian, ED constraints, residual and scoring formula remain unchanged.
- QAOA, candidate validation and Hybrid end-to-end runtime are exported separately.

## IEEE30 offline benchmarks

All three experiments use a MATPOWER case30-derived copper-plate Unit Commitment data family. This is a single-bus adaptation, not a network-constrained IEEE30 UC claim.

1. Eight IEEE30-derived 24-hour scenarios: Hybrid q=10 versus full HiGHS UC.
2. Fixed IEEE30-derived ten-generator instance: q=8,10,14,18,20,24,26 versus one reused HiGHS reference.
3. Replicated IEEE30-derived fleets: G=10,20,30,40,50 at q=10 and q=20, each compared with full HiGHS UC.

Top-K:

```text
Benchmark 1: 10
Benchmark 2: 10 at every q
Benchmark 3: 10, 20, 30, 40, 50 as G increases
```

## Timing protocol

Each unique quantum configuration is run once as an unmeasured warm-up and then run again for measurement. The first run is excluded from means, medians, figures and Hybrid/Classical runtime ratios. Fresh algorithm state is created for every run; only process-level CUDA/CUDA-Q caches persist.

## Validated benchmark scope

- 24-hour horizon.
- 10–50 IEEE30-derived dispatchable generators.
- 8–26 active qubits in the main report.
- Structured rectangle plus adjacent high-score positions for non-rectangular qubit budgets.
