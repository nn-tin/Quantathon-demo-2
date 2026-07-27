# IEEE30 Offline Benchmark Suite

This package is independent of the localhost Hybrid-only demo. All three experiments use one common data family: a 24-hour copper-plate Unit Commitment adaptation of MATPOWER `case30.m`.

## Data boundary

- The original case has 30 buses and 6 generators.
- This prototype aggregates the 30-bus load into one bus and does **not** solve branch power flows.
- The six source generators are split into ten virtual UC units while preserving total capacity and source cost ordering.
- UC-only parameters absent from `case30.m` (minimum output, ramps, no-load/startup costs and time constraints) are deterministic documented adaptations.
- See `data/IEEE30-DATA-NOTES.md`.

## Experiments

1. `ieee30_method_comparison.py`
   - eight 24-hour IEEE30-derived profiles;
   - same ten-unit fleet in every profile;
   - Hybrid q=10 versus full HiGHS UC.

2. `qubit_budget_scaling.py`
   - one fixed IEEE30-derived ten-generator `double-peak` instance;
   - q = 8, 10, 14, 18, 20, 24, 26;
   - same HiGHS reference at every q;
   - Top-K fixed at 10.

3. `generator_scaling.py`
   - replicated IEEE30-derived fleets G = 10, 20, 30, 40, 50;
   - q = 10 and q = 20;
   - one HiGHS reference per G;
   - Top-K = G, identical between q=10 and q=20.

The full HiGHS UC reference uses a 0.5% relative MIP-gap target and a 60-second limit per dataset.

## Warm-run timing

Every unique quantum configuration runs once as a full discarded warm-up. The second and later runs are measured. Fresh incumbent/ADMM/QAOA state is created for every run; only process-level CUDA/CUDA-Q caches persist. Warm-ups are exported separately and excluded from statistics, plots and runtime ratios.

## Run

```bash
python -m pip install -r benchmark/requirements-benchmark.txt
CUDAQ_TARGET=nvidia REQUIRE_CUDAQ=1 PYTHONPATH=backend:. \
python benchmark/run_all.py --experiments all
```

Quick protocol check, with unchanged solver hyperparameters:

```bash
CUDAQ_TARGET=nvidia REQUIRE_CUDAQ=1 PYTHONPATH=backend:. \
python benchmark/run_all.py --experiments all --quick
```

Individual selections:

```bash
python benchmark/run_all.py --experiments ieee30
python benchmark/run_all.py --experiments qubits
python benchmark/run_all.py --experiments generators
```
