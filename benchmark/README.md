# Benchmark Suite — Quantum-Assisted Unit Commitment

A reproducible offline benchmark suite for evaluating the Hybrid active-block QAOA pipeline against a full Classical HiGHS Unit Commitment reference.

## Overview

The benchmark suite is intentionally separated from the operational frontend and FastAPI demo:

- the **frontend demo** presents only the final Hybrid operating plan;
- the **benchmark suite** compares Hybrid results with a full Classical HiGHS Unit Commitment reference;
- offline experiments study scenario variation, active-qubit scaling and generator scaling;
- raw evidence remains traceable through JSON, CSV, PNG and HTML outputs.

This separation prevents research comparisons from being presented as part of the operator-facing product interface.

## Research Questions

The three experiments investigate:

1. **Solution quality across operating scenarios**  
   Can the Hybrid pipeline produce validated schedules with operating costs close to a full Classical reference across different 24-hour profiles?

2. **Effect of active-qubit budget**  
   How do solution quality and QAOA simulation runtime change as the selected quantum active block grows from 8 to 26 qubits?

3. **Scaling beyond the quantum block size**  
   Can the complete Unit Commitment fleet grow from 10 to 50 generators while the QAOA subproblem remains limited to fixed active budgets of 10 or 20 qubits?

## Features

- 📊 Three benchmark groups under one fixed protocol
- ⚙️ Shared MATPOWER case30-derived data family
- 🧮 Full HiGHS Classical Unit Commitment reference
- ⚛️ Qamomile-to-CUDA-Q Hybrid execution
- 🎮 NVIDIA GPU requirement for measured Hybrid runs
- 🔁 Discarded first run for every unique quantum configuration
- 📈 Cost, runtime, feasibility and scaling metrics
- 📄 JSON, CSV, PNG and HTML evidence outputs
- 🧪 Automated tests for data generation and warm-up protocol
- 🔍 Explicit claim boundaries and reproducibility metadata

## Technology Stack

| Area | Technology |
|---|---|
| Experiment runner | Python |
| Classical reference | HiGHS |
| Hybrid solver | Qamomile and NVIDIA CUDA-Q |
| Data processing | pandas and NumPy |
| Visualization | Matplotlib |
| Outputs | JSON, CSV, PNG and HTML |
| Testing | pytest |
| GPU target | CUDA-Q `nvidia` |

## Important Interpretation

These experiments do **not** claim that the current Hybrid implementation is faster or more accurate than HiGHS.

Their purpose is to demonstrate that:

- a small QAOA active block can be integrated into a complete 24-hour Unit Commitment workflow;
- quantum-generated candidates can be reconstructed into complete schedules;
- every candidate can be checked by strict Economic Dispatch and feasibility validation;
- cost quality, runtime, active-block size and generator scaling can be measured under a common protocol.

A lower reported objective value is not sufficient evidence of a better method unless feasibility, solver tolerance and timing definitions are also checked.

## Data Boundary

All experiments use one common data family derived from MATPOWER `case30.m`.

The original case contains:

- 30 buses;
- 6 generators;
- network and branch information.

The project uses a documented **copper-plate Unit Commitment adaptation**:

- bus-level demand is aggregated into one system demand profile;
- branch power-flow constraints are not solved;
- the six source generators are deterministically split into ten virtual Unit Commitment generators;
- total capacity and source cost ordering are preserved;
- missing UC-specific parameters are added through documented deterministic rules.

The benchmark should therefore be described as:

> MATPOWER IEEE 30-bus-derived copper-plate Unit Commitment data

It should not be described as a full network-constrained IEEE 30-bus Unit Commitment solution.

Detailed data notes:

```text
benchmark/data/IEEE30-DATA-NOTES.md
```

## Benchmark Groups

### Benchmark 1 — IEEE30-Derived Scenario Comparison

Implementation:

```text
benchmark/experiments/ieee30_method_comparison.py
```

Protocol:

- eight different 24-hour operating scenarios;
- one common IEEE30-derived ten-generator fleet;
- Hybrid active budget `q = 10`;
- Hybrid Top-K `= 10`;
- one full HiGHS Unit Commitment reference for each scenario;
- repeated measured Hybrid runs using fixed seeds;
- strict feasibility validation for the final reconstructed schedule.

Scenarios:

```text
base-day
cloudy-solar
double-peak
evening-ramp
high-demand
renewable-drop
summer-solar
windy-night
```

Primary outputs:

- Hybrid operating cost;
- HiGHS operating cost;
- Hybrid–HiGHS cost gap;
- Hybrid feasibility;
- Hybrid end-to-end runtime;
- QAOA component runtime;
- candidate-validation runtime;
- HiGHS runtime.

### Benchmark 2 — Active-Qubit Budget Scaling

Implementation:

```text
benchmark/experiments/qubit_budget_scaling.py
```

Protocol:

- one fixed IEEE30-derived ten-generator `double-peak` scenario;
- active-qubit budgets:

```text
8, 10, 14, 18, 20, 24, 26
```

- the same full HiGHS reference at every qubit budget;
- structured active-block shapes defined in Python;
- Top-K fixed at `10`;
- fixed QAOA depth, shots, optimizer budget and maximum Hybrid rounds.

Primary outputs:

- requested and actual active qubits;
- Hybrid operating cost;
- cost gap relative to HiGHS;
- Hybrid end-to-end runtime;
- QAOA runtime;
- selected bitstring and energy;
- number of unique measured bitstrings;
- strict feasibility.

### Benchmark 3 — Generator Scaling

Implementation:

```text
benchmark/experiments/generator_scaling.py
```

Protocol:

- generator counts:

```text
10, 20, 30, 40, 50
```

- fixed active-qubit budgets:

```text
q = 10
q = 20
```

- one full HiGHS Unit Commitment reference for each fleet size;
- controlled replicas of the IEEE30-derived ten-generator base fleet;
- demand, renewable and reserve profiles scaled with installed capacity;
- Top-K equals generator count and is identical for both qubit-budget curves at each fleet size.

This experiment evaluates the central Hybrid design idea: the complete scheduling problem may grow while the quantum subproblem remains bounded.

## Fixed Solver Protocol

All complete benchmark experiments share the same solver profile:

| Setting | Value |
|---|---:|
| QAOA depth | 1 |
| Final shots | 256 |
| Optimizer fallback shots | 64 |
| COBYLA evaluations | 6 |
| Maximum Hybrid rounds | 2 |
| CUDA-Q target | `nvidia` |
| CPU/NumPy fallback | Disabled |
| HiGHS relative MIP-gap target | 0.5% |
| HiGHS time limit | 60 seconds per dataset |

Only the experiment-controlled variables may change:

- scenario;
- active-qubit budget;
- active-block shape;
- generator count;
- Top-K where defined by the experiment;
- random seed.

The fixed quantum profile is defined in:

```text
backend/app/config/quantum_profile.py
```

## Classical Reference

The full Classical reference uses the HiGHS mixed-integer solver implemented in:

```text
backend/app/classical/full_uc.py
```

The Classical solver receives the same dataset as the Hybrid pipeline for each comparison.

HiGHS provides:

- a full Unit Commitment reference;
- a reported operating cost;
- a feasibility result;
- a measured runtime under the configured MIP gap and time limit.

The returned HiGHS value is a bounded solver result under the stated configuration, not an unconditional proof that every experiment reached the exact global optimum.

## Warm-Up and Timing Protocol

GPU initialization can distort the first runtime measurement. Every unique quantum configuration follows this protocol:

1. execute one complete Hybrid solve;
2. mark it as a discarded first run;
3. execute the same configuration again using measured seeds;
4. include only the second and later runs in summaries, plots, ratios and conclusions.

The discarded run initializes resources such as:

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

Discarded records are exported separately:

```text
benchmark/results/raw/discarded_quantum_warmups.json
benchmark/results/raw/discarded_quantum_warmups.csv
```

## Metrics

### Cost Gap

```text
100 × (Hybrid cost − HiGHS cost) / |HiGHS cost|
```

Interpretation:

- `0%`: equal reported operating cost;
- positive value: Hybrid cost is higher;
- negative value: Hybrid cost is lower than the returned HiGHS reference.

A negative value should not automatically be interpreted as proof of superiority. Solver gap, time limit, feasibility and result validation must also be checked.

### Runtime Fields

Raw records distinguish:

- `milp_runtime_ms` — full HiGHS Unit Commitment runtime;
- `hybrid_runtime_ms` — complete measured Hybrid pipeline runtime;
- `qaoa_runtime_ms` — QAOA backend component runtime;
- `lp_preprocessing_runtime_ms` — relaxed preprocessing runtime;
- `candidate_validation_runtime_ms` — reconstruction and validation runtime.

Every runtime chart or statement should name the specific field being shown.

### Feasibility

`hybrid_feasible` is based on the final reconstructed schedule after strict validation.

Quantum energy alone is not treated as evidence of a valid Unit Commitment solution. Cost gap and feasibility must therefore be interpreted together.

## Reported Summary

The supplied HTML report records:

| Metric | Value |
|---|---:|
| Total measured Hybrid runs | 75 |
| Discarded first runs | 25 |
| Aggregate Hybrid feasibility rate | 52.0% |
| Aggregate mean cost gap | 1.714% |
| Validated active-qubit range | 8–26 |
| Generator scaling range | 10–50 |

The report supports low single-digit cost-gap observations in many tested configurations, but strict feasibility is not consistent across the full benchmark suite.

## Prerequisites

- Python 3.12
- NVIDIA GPU
- CUDA-Q-compatible NVIDIA driver and runtime
- Backend quantum dependencies
- Benchmark dependencies
- `CUDAQ_TARGET=nvidia`
- `REQUIRE_CUDAQ=1`

Install from the repository root:

```bash
python -m pip install \
  -r backend/requirements-quantum-colab.txt \
  -r benchmark/requirements-benchmark.txt
```

## Quick Start

Run the complete benchmark suite:

```bash
CUDAQ_TARGET=nvidia \
REQUIRE_CUDAQ=1 \
PYTHONPATH=backend:. \
python benchmark/run_all.py --experiments all
```

The benchmark explicitly checks that CUDA-Q executes on the NVIDIA target and raises an error rather than silently replacing the measured GPU path with a CPU fallback.

## Quick Protocol Check

Quick mode keeps the same solver hyperparameters but reduces seeds and experiment points:

```bash
CUDAQ_TARGET=nvidia \
REQUIRE_CUDAQ=1 \
PYTHONPATH=backend:. \
python benchmark/run_all.py --experiments all --quick
```

Quick mode verifies that:

- CUDA-Q initializes;
- datasets are generated correctly;
- experiment pipelines complete;
- raw and summary outputs are created;
- figures and the HTML report are generated.

Quick mode is not a replacement for the complete benchmark when preparing final evidence.

## Run Individual Experiments

Scenario comparison:

```bash
CUDAQ_TARGET=nvidia REQUIRE_CUDAQ=1 PYTHONPATH=backend:. \
python benchmark/run_all.py --experiments ieee30
```

Active-qubit scaling:

```bash
CUDAQ_TARGET=nvidia REQUIRE_CUDAQ=1 PYTHONPATH=backend:. \
python benchmark/run_all.py --experiments qubits
```

Generator scaling:

```bash
CUDAQ_TARGET=nvidia REQUIRE_CUDAQ=1 PYTHONPATH=backend:. \
python benchmark/run_all.py --experiments generators
```

Multiple selections:

```bash
CUDAQ_TARGET=nvidia REQUIRE_CUDAQ=1 PYTHONPATH=backend:. \
python benchmark/run_all.py --experiments ieee30 qubits
```

Detailed per-run output:

```bash
CUDAQ_TARGET=nvidia REQUIRE_CUDAQ=1 PYTHONPATH=backend:. \
python benchmark/run_all.py --experiments all --verbose
```

## Generated Outputs

### Raw Measured Records

```text
benchmark/results/raw/ieee30_method_comparison.json
benchmark/results/raw/ieee30_method_comparison.csv
benchmark/results/raw/ieee30_qubit_budget_scaling.json
benchmark/results/raw/ieee30_qubit_budget_scaling.csv
benchmark/results/raw/ieee30_generator_scaling.json
benchmark/results/raw/ieee30_generator_scaling.csv
```

### Warm-Up and Environment Evidence

```text
benchmark/results/raw/discarded_quantum_warmups.json
benchmark/results/raw/discarded_quantum_warmups.csv
benchmark/results/raw/environment.json
```

`environment.json` records:

- timestamp;
- Python version;
- platform;
- CUDA-Q target;
- CUDA-Q version;
- Qamomile version;
- selected experiments;
- timing protocol;
- discarded warm-up configuration count.

### Summary Tables

```text
benchmark/results/summary/ieee30_method_comparison_summary.csv
benchmark/results/summary/ieee30_qubit_budget_scaling_summary.csv
benchmark/results/summary/ieee30_generator_scaling_summary.csv
```

### Figures

The report generator creates charts for:

- scenario cost gap;
- scenario runtime;
- qubit-scaling cost;
- qubit-scaling cost gap;
- qubit-scaling runtime;
- generator-scaling cost;
- generator-scaling cost gap;
- generator-scaling runtime.

Output directory:

```text
benchmark/results/figures/
```

### HTML Report

```text
benchmark/report/benchmark_report.html
```

The report contains:

- fixed protocol;
- environment metadata;
- summary indicators;
- generated figures;
- complete result tables for all three benchmark groups.

## Reproducibility

Every exported benchmark bundle should preserve:

- timestamp;
- Python and platform versions;
- CUDA-Q version and target;
- Qamomile availability;
- benchmark data family;
- selected experiments;
- timing protocol;
- discarded warm-up count;
- requested and actual active qubits;
- generator count;
- Top-K;
- random seed;
- cost and runtime measurements;
- final feasibility status.

## Project Structure

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
│   ├── build_report.py
│   └── benchmark_report.html
├── results/
│   ├── raw/
│   ├── summary/
│   └── figures/
├── tests/
│   ├── test_ieee30_factory.py
│   └── test_warmup_protocol.py
└── README.md
```

## Testing

Run benchmark tests:

```bash
PYTHONPATH=backend:. \
python -m pytest -q benchmark/tests
```

Run the complete project test suite:

```bash
PYTHONPATH=backend:. \
python -m pytest -q backend/tests benchmark/tests
```

The current combined suite contains 15 passing tests.

## Colab Benchmark Notebook

Recommended GPU workflow:

```text
PiL-HQUC_Colab_GPU_Backend_Tests_and_3_Benchmarks.ipynb
```

The notebook:

- installs backend and benchmark dependencies;
- verifies CUDA-Q GPU execution;
- runs backend and benchmark tests;
- executes all three experiment groups;
- generates raw JSON and CSV records;
- creates summary CSV files and charts;
- builds the HTML benchmark report;
- exports the result bundle.

It does not start the operational frontend API or Cloudflare tunnel. That role belongs to the separate demo notebook.

## Recommended Evidence for the Project README

After the complete benchmark has run, the main project README should present only the clearest evidence:

1. Hybrid versus HiGHS operating cost across the eight scenarios;
2. cost gap versus active-qubit budget;
3. QAOA runtime versus active-qubit budget;
4. cost gap versus generator count for `q = 10` and `q = 20`.

Raw records, environment metadata and the standalone HTML report should remain available so every chart can be traced to exported benchmark output.

## Troubleshooting

### CUDA-Q Target Is Not NVIDIA

```bash
export CUDAQ_TARGET=nvidia
export REQUIRE_CUDAQ=1
nvidia-smi
```

### First Run Is Much Slower

This is expected. The benchmark discards the first complete run for each unique quantum configuration.

### Missing Report Figures

Run the complete benchmark or report builder after raw and summary outputs have been generated.

### Empty Result Directories

Generated raw files may be omitted from Git history to keep the repository small. Re-run the notebook or `benchmark/run_all.py`.

### Benchmark Stops Instead of Falling Back to CPU

This is intentional. Official measured Hybrid evidence requires CUDA-Q on the NVIDIA target.

## Current Limitations

- The datasets are IEEE30-derived copper-plate UC adaptations, not network-constrained AC or DC optimal-power-flow benchmarks.
- CUDA-Q statevector simulation runtime is not equivalent to physical QPU runtime.
- HiGHS remains a strong Classical reference for the tested problem sizes.
- Results depend on active-block selection, random seed, QAOA optimizer budget, Top-K reconstruction and the fixed simulation profile.
- The supplied report records an aggregate Hybrid feasibility rate of 52%.
- Generator scaling uses controlled replicated fleets to study algorithm behavior; it does not represent five independent real power systems.
- The benchmark evaluates a research prototype and should not be interpreted as proof of present-day quantum speedup or quantum advantage.
