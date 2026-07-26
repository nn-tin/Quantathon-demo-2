# PiL-HQUC — GPU Hybrid Unit Commitment Demo

PiL-HQUC is an ADMM-guided active-block Unit Commitment prototype. The operational demo is **Hybrid-only** and executes:

```text
LP relaxation + heuristic incumbent
→ relaxed Economic Dispatch and ADMM feedback
→ structured active-block selection
→ dynamic QUBO
→ Qamomile QUBO-to-QAOA conversion
→ CUDA-Q on NVIDIA GPU
→ Top-K reconstruction
→ strict ED and feasibility validation
```

The full classical MILP comparison and scaling experiments are separated into the offline `benchmark/` suite.

## Fixed quantum profile

The demo and all benchmarks use the same solver settings:

- QAOA depth: `1`;
- final shots: `256`;
- fallback optimizer shots: `64`;
- COBYLA evaluations: `6`;
- maximum ADMM-guided QAOA rounds: `2`;
- CUDA-Q target: `nvidia`;
- NumPy/CPU fallback: disabled.

The localhost demo uses 10 active qubits and Top-K 10. Benchmark Top-K increases with generator count; it remains constant within qubit scaling.

## Project layout

```text
backend/                     FastAPI Hybrid demo and shared solver core
frontend/                    React/Vite operational demo
benchmark/                   Offline research experiments and HTML report
  data/                      SimBench adapter and synthetic mapping-like data
  experiments/               Three separate benchmark experiments
  results/                   Raw CSV/JSON, summaries and figures
  report/benchmark_report.html
Run_PiL_HQUC_GPU_Demo_and_Benchmarks.ipynb
```

The old top-level `evaluate/` and `compare_hybrid_milp.py` workflow has been removed. Benchmark code is not imported by FastAPI or the frontend.

## Run the localhost GPU demo

Install the quantum requirements on a CUDA-capable machine:

```bash
python -m pip install -r backend/requirements-quantum-colab.txt
```

Start the API:

```bash
CUDAQ_TARGET=nvidia REQUIRE_CUDAQ=1 \
PYTHONPATH=backend \
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Start the frontend in another terminal:

```bash
cd frontend
npm ci
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` to FastAPI. The backend rejects a run if CUDA-Q cannot use the NVIDIA target.

## Run the three offline benchmarks

```bash
python -m pip install -r benchmark/requirements-benchmark.txt
CUDAQ_TARGET=nvidia REQUIRE_CUDAQ=1 \
PYTHONPATH=backend:. \
python benchmark/run_all.py --experiments all
```

A quick protocol check keeps the same solver settings but uses fewer seeds and data points:

```bash
CUDAQ_TARGET=nvidia REQUIRE_CUDAQ=1 \
PYTHONPATH=backend:. \
python benchmark/run_all.py --experiments all --quick
```

### Benchmark 1 — SimBench method comparison

- SimBench annual demand and renewable profiles;
- five 24-hour windows;
- aggregated into the prototype single-bus UC formulation;
- full HiGHS MILP and Hybrid QAOA solve the same converted case;
- Top-K scales with generator count.

### Benchmark 2 — Qubit-budget scaling

- one fixed synthetic 10-generator, 24-hour instance;
- q = `8, 10, 14, 18, 20, 24, 26`;
- mapping-like structured blocks defined in Python;
- Top-K is fixed across all q values.

### Benchmark 3 — Generator scaling

- generator count = `4, 6, 8, 10, 12, 16, 20`;
- q = `10` and q = `20`;
- capacity-normalized synthetic datasets;
- Top-K increases with generator count and is identical for both q curves at a given system size.

Outputs are written to:

```text
benchmark/results/raw/
benchmark/results/summary/
benchmark/results/figures/
benchmark/report/benchmark_report.html
```

## Colab

Use `Run_PiL_HQUC_GPU_Demo_and_Benchmarks.ipynb`. It safely uploads/extracts the project, installs the exact dependencies, verifies the NVIDIA target, opens the GPU demo through a Colab proxy, runs the benchmark suite, and downloads the report bundle.

## Tests

```bash
PYTHONPATH=backend pytest -q backend/tests
```
