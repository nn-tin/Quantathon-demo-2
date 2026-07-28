# PiL-HQUC Offline Benchmark Suite

The `benchmark/` directory contains the reproducible offline experiments used to evaluate the PiL-HQUC Hybrid Unit Commitment method.

The benchmark suite is intentionally separated from the operational frontend and FastAPI demo:

- the **frontend demo** presents only the final Hybrid operating plan;
- the **benchmark suite** compares Hybrid results with a full Classical HiGHS Unit Commitment reference and studies qubit and generator scaling.

This separation prevents offline research comparisons from being presented as part of the operator-facing product interface.

## Research questions

The three experiments investigate:

1. **Solution quality across operating scenarios**  
   Can the Hybrid pipeline produce feasible schedules with operating costs close to a full Classical reference across different 24-hour profiles?

2. **Effect of active qubit budget**  
   How do solution quality and QAOA simulation runtime change as the selected quantum active block grows from 8 to 26 qubits?

3. **Scaling beyond the quantum block size**  
   Can the full Unit Commitment fleet grow from 10 to 50 generators while the QAOA subproblem remains limited to fixed active budgets of 10 or 20 qubits?

## Important interpretation

These experiments do **not** claim that the current Hybrid implementation is faster or more accurate than HiGHS.

Their purpose is to demonstrate that:

- a small QAOA active block can be integrated into a complete 24-hour Unit Commitment workflow;
- quantum-generated candidates can be reconstructed into full schedules;
- every candidate can be checked by strict Economic Dispatch and feasibility validation;
- cost quality, runtime, active-block size, and generator scaling can be measured using a common protocol.

## Data boundary

All experiments use one common data family derived from MATPOWER `case30.m`.

The original case contains:

- 30 buses;
- 6 generators;
- network and branch information.

The current project uses a documented **copper-plate Unit Commitment adaptation**:

- bus-level demand is aggregated into one system demand profile;
- branch power-flow constraints are not solved;
- the six source generators are deterministically split into ten virtual Unit Commitment generators;
- total capacity and source cost ordering are preserved;
- missing UC-specific parameters are added through documented deterministic rules.

Therefore, the benchmark should be described as:

> MATPOWER IEEE 30-bus-derived copper-plate Unit Commitment data

It should not be described as a full network-constrained IEEE 30-bus Unit Commitment solution.

Detailed data notes are available in [`data/IEEE30-DATA-NOTES.md`](data/IEEE30-DATA-NOTES.md).

## Experiments

### Benchmark 1 — IEEE30-derived method comparison

Implementation:

```text
experiments/ieee30_method_comparison.py
```

Protocol:

- eight different 24-hour operating scenarios;
- one common IEEE30-derived ten-generator fleet;
- Hybrid active budget `q = 10`;
- Hybrid Top-K `= 10`;
- one full HiGHS Unit Commitment reference for the same scenario;
- repeated measured Hybrid runs using fixed seeds;
- strict feasibility validation for the final Hybrid schedule.

The scenarios are configured in `config.py` and are derived from the same base data family. They vary the temporal relationship between demand and renewable availability rather than replacing the generator fleet.

Primary outputs:

- Hybrid operating cost;
- HiGHS operating cost;
- Hybrid–HiGHS cost gap;
- Hybrid feasibility;
- Hybrid end-to-end runtime;
- QAOA component runtime;
- HiGHS runtime.

This experiment supports scenario-by-scenario cost and runtime comparisons.

### Benchmark 2 — Active qubit-budget scaling

Implementation:

```text
experiments/qubit_budget_scaling.py
```

Protocol:

- one fixed IEEE30-derived ten-generator `double-peak` scenario;
- active qubit budgets:

```text
8, 10, 14, 18, 20, 24, 26
```

- the same full HiGHS reference at every qubit budget;
- structured active-block shapes defined in Python;
- Top-K fixed at `10`;
- fixed QAOA depth, shots, optimizer budget, and maximum Hybrid rounds.

Primary outputs:

- requested and actual active qubits;
- Hybrid operating cost;
- cost gap relative to HiGHS;
- Hybrid runtime;
- QAOA runtime;
- selected bitstring and energy;
- number of unique measured bitstrings;
- feasibility.

This experiment shows the trade-off between a larger quantum search space and the cost of GPU statevector simulation.

### Benchmark 3 — Generator scaling

Implementation:

```text
experiments/generator_scaling.py
```

Protocol:

- generator counts:

```text
10, 20, 30, 40, 50
```

- fixed active qubit budgets:

```text
q = 10 and q = 20
```

- one full HiGHS Unit Commitment reference for each fleet size;
- controlled replicas of the IEEE30-derived ten-generator base fleet;
- demand, renewable, and reserve profiles scaled with installed capacity;
- Top-K equals generator count and is identical for both qubit-budget curves at each fleet size.

Primary outputs:

- Hybrid and HiGHS operating cost;
- cost gap for `q = 10` and `q = 20`;
- Hybrid and HiGHS runtime;
- QAOA runtime;
- feasibility;
- active-block shape.

This experiment evaluates the central Hybrid design idea: the complete scheduling problem may grow while the quantum subproblem remains bounded.

## Fixed solver protocol

All experiments share the same QAOA settings:

| Setting | Value |
|---|---:|
| QAOA depth | 1 |
| Final shots | 256 |
| Optimizer shots | 64 |
| COBYLA evaluations | 6 |
| Maximum Hybrid rounds | 2 |
| CUDA-Q target | `nvidia` |
| CPU/NumPy fallback | Disabled |

Only the following experiment variables may change:

- active qubit budget;
- active-block shape;
- Top-K where defined by the experiment;
- generator count;
- scenario;
- random seed.

The fixed profile is defined in:

```text
../backend/app/config/quantum_profile.py
```

## Classical reference

The full Classical reference uses the HiGHS mixed-integer solver implemented in:

```text
../backend/app/classical/full_uc.py
```

Reference configuration:

| Setting | Value |
|---|---:|
| Relative MIP-gap target | 0.5% |
| Time limit | 60 seconds per dataset |

The Classical solver receives the same dataset as the Hybrid pipeline for each comparison.

## Warm-up and timing protocol

GPU initialization can distort the first runtime measurement. For this reason, every unique quantum configuration follows a two-stage protocol:

1. run one complete Hybrid solve;
2. mark it as discarded warm-up;
3. execute the same configuration again using measured seeds;
4. include only the second and later runs in summaries, plots, ratios, and conclusions.

The discarded run initializes process-level resources such as:

- CUDA context;
- CUDA-Q target;
- Qamomile integration;
- circuit-size-specific runtime caches.

Each measured run still creates fresh:

- dataset state;
- initial commitment schedule;
- ADMM state;
- QUBO;
- optimizer evaluations;
- sampled candidates;
- reconstruction and validation steps.

Discarded records are exported separately to:

```text
results/raw/discarded_quantum_warmups.json
results/raw/discarded_quantum_warmups.csv
```

## Metrics

### Cost gap

The benchmark reports the Hybrid cost gap relative to HiGHS as:

```text
100 × (Hybrid cost − HiGHS cost) / |HiGHS cost|
```

Interpretation:

- `0%`: equal reported operating cost;
- positive value: Hybrid cost is higher;
- negative value: Hybrid cost is lower than the returned HiGHS reference.

A negative value should not automatically be interpreted as proof of superiority. Solver gap, time limit, model feasibility, and result validation must also be checked.

### Runtime fields

The raw records distinguish:

- `milp_runtime_ms` — full HiGHS Unit Commitment runtime;
- `hybrid_runtime_ms` — complete Hybrid pipeline runtime;
- `qaoa_runtime_ms` — QAOA backend component runtime;
- `lp_preprocessing_runtime_ms` — relaxed preprocessing runtime;
- `candidate_validation_runtime_ms` — reconstruction and validation runtime.

Runtime comparisons should always state which field is being shown.

### Feasibility

`hybrid_feasible` is based on the final reconstructed schedule after strict validation. Quantum energy alone is not treated as evidence of a valid Unit Commitment solution.

## Directory structure

```text
benchmark/
├── config.py
├── runner.py
├── run_all.py
├── requirements-benchmark.txt
├── data/
│   ├── IEEE30-DATA-NOTES.md
│   ├── block_mapping.py
│   ├── ieee30_factory.py
│   └── validation.py
├── experiments/
│   ├── ieee30_method_comparison.py
│   ├── qubit_budget_scaling.py
│   └── generator_scaling.py
├── report/
│   └── build_report.py
├── results/
│   ├── raw/
│   ├── summary/
│   └── figures/
└── tests/
    ├── test_ieee30_factory.py
    └── test_warmup_protocol.py
```

The `results/` directories are created when the benchmark is executed.

## Installation

Install the benchmark and GPU dependencies from the project root:

```bash
python -m pip install -r benchmark/requirements-benchmark.txt
```

The environment must provide CUDA-Q with the NVIDIA target. The benchmark explicitly checks that execution occurs on a GPU and raises an error otherwise.

## Run all experiments

From the project root:

```bash
CUDAQ_TARGET=nvidia REQUIRE_CUDAQ=1 \
PYTHONPATH=backend:. \
python benchmark/run_all.py --experiments all
```

## Quick protocol check

The quick mode keeps the same solver hyperparameters but reduces the number of seeds and experiment points:

```bash
CUDAQ_TARGET=nvidia REQUIRE_CUDAQ=1 \
PYTHONPATH=backend:. \
python benchmark/run_all.py --experiments all --quick
```

Quick mode is useful for checking that:

- CUDA-Q initializes;
- datasets are generated correctly;
- all experiment pipelines complete;
- output files and the HTML report are produced.

It is not a replacement for the complete benchmark when preparing final results.

## Run individual experiments

```bash
python benchmark/run_all.py --experiments ieee30
```

```bash
python benchmark/run_all.py --experiments qubits
```

```bash
python benchmark/run_all.py --experiments generators
```

Multiple selections are also supported:

```bash
python benchmark/run_all.py --experiments ieee30 qubits
```

Add detailed per-run output with:

```bash
python benchmark/run_all.py --experiments all --verbose
```

When running individual commands directly, retain the required environment variables:

```bash
CUDAQ_TARGET=nvidia REQUIRE_CUDAQ=1 PYTHONPATH=backend:.
```

## Generated outputs

### Raw measured records

```text
results/raw/ieee30_method_comparison.json
results/raw/ieee30_method_comparison.csv
results/raw/ieee30_qubit_budget_scaling.json
results/raw/ieee30_qubit_budget_scaling.csv
results/raw/ieee30_generator_scaling.json
results/raw/ieee30_generator_scaling.csv
```

### Warm-up and environment evidence

```text
results/raw/discarded_quantum_warmups.json
results/raw/discarded_quantum_warmups.csv
results/raw/environment.json
```

`environment.json` records information such as timestamp, Python version, platform, CUDA-Q target, CUDA-Q version, Qamomile version, selected experiments, and timing protocol.

### Summary tables

```text
results/summary/ieee30_method_comparison_summary.csv
results/summary/ieee30_qubit_budget_scaling_summary.csv
results/summary/ieee30_generator_scaling_summary.csv
```

### Figures

The report generator creates PNG charts for:

- scenario cost comparison;
- scenario runtime comparison;
- qubit scaling cost;
- qubit scaling cost gap;
- qubit scaling runtime;
- generator scaling cost;
- generator scaling cost gap;
- generator scaling runtime.

They are written to:

```text
results/figures/
```

### HTML report

The complete standalone report is generated at:

```text
report/benchmark_report.html
```

It includes:

- benchmark protocol;
- fixed quantum settings;
- environment metadata;
- summary indicators;
- generated figures;
- result tables for all three experiments.

## Run tests

From the project root:

```bash
PYTHONPATH=backend:. pytest -q benchmark/tests
```

Run all project tests:

```bash
PYTHONPATH=backend:. pytest -q backend/tests benchmark/tests
```

## Colab benchmark notebook

The recommended GPU workflow is provided in:

```text
../PiL-HQUC_Colab_GPU_Backend_Tests_and_3_Benchmarks.ipynb
```

The notebook:

- installs backend and benchmark dependencies;
- verifies CUDA-Q GPU execution;
- runs backend and benchmark tests;
- executes the three experiments;
- generates raw JSON/CSV records;
- creates summary CSV files and charts;
- builds the HTML benchmark report;
- exports the result bundle for download.

It does not start the operational frontend API or Cloudflare tunnel. That role belongs to the separate demo notebook.

## Recommended evidence for the project README

After the full benchmark has completed, the main project README should present only the clearest evidence:

1. Hybrid versus HiGHS operating cost across the eight scenarios;
2. cost gap versus active qubit budget;
3. QAOA runtime versus active qubit budget;
4. cost gap versus generator count for `q = 10` and `q = 20`.

Raw records, environment metadata, and the standalone HTML report should remain available so every chart can be traced back to exported benchmark output.

## Limitations

- The datasets are IEEE30-derived copper-plate UC adaptations, not network-constrained AC or DC optimal power-flow benchmarks.
- CUDA-Q statevector simulation runtime is not equivalent to physical QPU runtime.
- HiGHS is expected to remain a strong reference for the problem sizes tested.
- Results depend on active-block selection, random seed, QAOA optimizer budget, Top-K reconstruction, and the fixed simulation profile.
- Generator scaling uses controlled replicated fleets to study algorithm behavior; it is not intended to represent five independent real power systems.
- The benchmark evaluates a research prototype and should not be interpreted as proof of present-day quantum advantage.
