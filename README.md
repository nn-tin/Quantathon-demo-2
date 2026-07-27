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

Every unique quantum benchmark configuration uses a two-stage timing protocol: the first full Hybrid run is discarded as initialization warm-up, and only the second and later runs are included in runtime statistics.

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
  data/                      IEEE30 copper-plate factory and block mapping
  experiments/               Three separate benchmark experiments
  results/                   Raw CSV/JSON, summaries and figures
  report/benchmark_report.html
PiL-HQUC_Colab_GPU_Demo_API.ipynb
PiL-HQUC_Colab_GPU_Backend_Tests_and_3_Benchmarks.ipynb
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

The full HiGHS UC reference uses a 0.5% relative MIP-gap target and a 60-second limit per dataset.

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

### Benchmark 1 — IEEE30 method comparison

- eight 24-hour scenarios from one MATPOWER case30-derived ten-unit fleet;
- full HiGHS UC and Hybrid q=10 solve the same scenario;
- Top-K = 10.

### Benchmark 2 — IEEE30 qubit-budget scaling

- one fixed IEEE30-derived 10-generator `double-peak` instance;
- q = `8, 10, 14, 18, 20, 24, 26`;
- the same HiGHS full-UC reference at every q;
- mapping-like structured active blocks defined in Python;
- Top-K fixed at 10.

### Benchmark 3 — IEEE30-derived generator scaling

- generator count = `10, 20, 30, 40, 50`;
- q = `10` and q = `20`;
- fleets are controlled replicas of the same IEEE30-derived ten-unit base;
- demand, renewable and reserve profiles scale with installed capacity;
- Top-K = generator count and is identical for both q curves.

Outputs are written to:

```text
benchmark/results/raw/
benchmark/results/summary/
benchmark/results/figures/
benchmark/report/benchmark_report.html
```

## Colab

The project contains exactly two purpose-specific notebooks:

- `PiL-HQUC_Colab_GPU_Demo_API.ipynb`: starts only the FastAPI GPU backend and Cloudflare tunnel for the local frontend demo. It does not run tests or benchmarks.
- `PiL-HQUC_Colab_GPU_Backend_Tests_and_3_Benchmarks.ipynb`: runs all backend and benchmark tests, then executes all three IEEE30 benchmarks and exports the complete report/results bundle. It does not start the frontend API or tunnel.

## Tests

```bash
PYTHONPATH=backend:. pytest -q backend/tests benchmark/tests
```
