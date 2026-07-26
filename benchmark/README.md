# Offline Benchmark Suite

The localhost application is a **Hybrid-only GPU demo**. Classical comparison and scaling evidence live here and are never called by FastAPI or the React frontend.

## Fixed quantum protocol

All measured runs use the same settings:

- Qamomile → CUDA-Q, target `nvidia`, CPU fallback disabled;
- QAOA depth 1;
- 256 final shots;
- 64 fallback optimizer shots;
- 6 COBYLA objective evaluations;
- at most 2 ADMM-guided quantum rounds.

Only dataset, seed, active-qubit budget, block shape and benchmark Top-K vary. Top-K is fixed across qubit scaling and grows with generator count in the other two experiments.

## Experiments

1. `simbench_method_comparison.py`
   - SimBench annual demand/renewable profiles;
   - aggregated into the prototype single-bus 24-hour UC model;
   - full HiGHS MILP versus Hybrid QAOA on the same converted case.

2. `qubit_budget_scaling.py`
   - one fixed synthetic 10-generator case;
   - q = 8, 10, 14, 18, 20, 24, 26;
   - mapping-like structured blocks defined in Python;
   - fixed Top-K for all q values.

3. `generator_scaling.py`
   - synthetic, capacity-normalized systems with 4–20 generators;
   - q = 10 and q = 20;
   - Top-K grows with generator count and is identical for both q curves.

## Run

```bash
python -m pip install -r benchmark/requirements-benchmark.txt
CUDAQ_TARGET=nvidia REQUIRE_CUDAQ=1 \
PYTHONPATH=backend:. \
python benchmark/run_all.py --experiments all
```

A shorter protocol check keeps the same solver settings but uses fewer seeds/data points:

```bash
CUDAQ_TARGET=nvidia REQUIRE_CUDAQ=1 \
PYTHONPATH=backend:. \
python benchmark/run_all.py --experiments all --quick
```

Outputs:

- raw CSV/JSON: `benchmark/results/raw/`;
- summaries: `benchmark/results/summary/`;
- figures: `benchmark/results/figures/`;
- report: `benchmark/report/benchmark_report.html`.
