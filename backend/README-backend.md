# PiL-HQUC Backend

The `backend/` directory contains the FastAPI application and the shared Hybrid Unit Commitment solver used by the PiL-HQUC demo and offline benchmark suite.

The backend receives a complete 24-hour operating scenario, constructs an initial commitment schedule, identifies a small high-impact active block, solves that block with QAOA through Qamomile and CUDA-Q, reconstructs the full schedule, and validates the result using Economic Dispatch and Unit Commitment feasibility checks.

## Hybrid workflow

```text
24-hour operating input
        ↓
LP relaxation and heuristic rounding
        ↓
Initial full commitment schedule
        ↓
Relaxed Economic Dispatch
        ↓
Residual and ADMM feedback signals
        ↓
Structured active-block selection
        ↓
Dynamic QUBO construction
        ↓
Qamomile QUBO-to-Ising conversion
        ↓
CUDA-Q QAOA on NVIDIA GPU
        ↓
Top-K bitstring reconstruction
        ↓
Strict Economic Dispatch and feasibility validation
        ↓
Validated 24-hour operating plan
```

Quantum optimization is applied only to a selected block of commitment decisions. The complete Unit Commitment schedule remains represented and is reconstructed before final validation.

## Responsibilities

The backend provides:

- default 24-hour Unit Commitment data;
- runtime scenario input processing;
- LP-based relaxed commitment values;
- heuristic baseline construction and repair;
- relaxed and strict Economic Dispatch;
- ADMM-guided candidate scoring;
- structured active-block selection;
- dynamic QUBO construction;
- QUBO-to-Ising conversion;
- QAOA execution through Qamomile and CUDA-Q;
- Top-K candidate reconstruction;
- Unit Commitment feasibility checks;
- full result serialization for the frontend;
- shared solver functions for the benchmark suite.

## Fixed GPU profile

The operational demo uses one fixed quantum configuration:

| Setting | Value |
|---|---:|
| Active qubit budget | 10 |
| Candidate generators | 2 |
| Candidate hours | 5 |
| QAOA depth | 1 |
| Final shots | 256 |
| Optimizer shots | 64 |
| COBYLA evaluations | 6 |
| Top-K candidates | 10 |
| Maximum quantum rounds | 2 |
| CUDA-Q target | `nvidia` |
| NumPy/CPU fallback | Disabled |

These values are defined in:

```text
app/config/quantum_profile.py
```

The frontend submits operating inputs only. The public demo endpoint replaces user-supplied quantum settings with this fixed profile to keep runs consistent.

## Directory structure

```text
backend/
├── app/
│   ├── api/                    FastAPI routes
│   ├── backends/               Hybrid QAOA execution backend
│   ├── baseline/               Initial schedule and repair logic
│   ├── candidate_selection/    Candidate scoring and active-block selection
│   ├── classical/              Full HiGHS Unit Commitment reference
│   ├── config/                 Fixed quantum profile
│   ├── datasets/               Default dataset and repository
│   ├── dispatch/               Relaxed and strict Economic Dispatch
│   ├── evaluation/             Full-schedule reconstruction
│   ├── feasibility/            UC and dispatch validation
│   ├── models/                 Pydantic API and domain schemas
│   ├── preprocessing/          Relaxed commitment preprocessing
│   ├── qubo/                   Dynamic QUBO and Ising conversion
│   ├── services/               End-to-end Hybrid pipeline
│   └── main.py                 FastAPI application entry point
├── scripts/
│   └── quantum_smoke.py        CUDA-Q smoke test
├── tests/
│   ├── test_api_contract.py
│   └── test_pipeline.py
├── requirements.txt
└── requirements-quantum-colab.txt
```

## API endpoints

The application exposes interactive API documentation at `/docs`.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/` | Basic application information |
| `GET` | `/api/health` | API, fixed-profile, and CUDA-Q target status |
| `GET` | `/api/datasets` | Available datasets |
| `GET` | `/api/backends` | Available Hybrid backend description |
| `POST` | `/api/runs` | Execute one Hybrid scheduling run |
| `GET` | `/api/runs/{run_id}` | Retrieve a stored run summary |
| `GET` | `/api/runs/{run_id}/events` | Retrieve pipeline stage events |
| `GET` | `/api/runs/{run_id}/result` | Retrieve the run result payload |
| `GET` | `/api/runs/{run_id}/qubo` | Retrieve the generated QUBO |

`POST /api/runs` currently executes the solver in the request process and returns the completed run summary. Completed runs are stored in memory while the API process remains active.

## Run request

The recommended request format is available in [`../sample-run-request.json`](../sample-run-request.json).

A request contains:

- `dataset_id`;
- `run_mode`;
- optional 24-hour scenario input;
- presentation settings used only by the interface;
- an internal Hybrid configuration that is replaced by the fixed demo profile for public API runs.

Minimal example:

```json
{
  "dataset_id": "default_10x24",
  "run_mode": "hybrid_demo",
  "presentation_mode": false,
  "presentation_delay_ms": 0
}
```

A frontend-generated request also includes `scenario_input` with exactly 24 demand, solar, and wind values.

## Result structure

A completed run returns a `RunSummary` containing:

```text
run_id
status
config
dataset
stages
metrics
result
qubo
```

The main operating result is available under:

```text
result.hybrid
```

It includes the validated schedule, hourly dispatch, feasibility state, cost, selected candidate, quantum execution information, active-block information, and runtime breakdown.

## Installation

### Base development and tests

```bash
python -m pip install -r backend/requirements.txt
```

This installs FastAPI, Uvicorn, Pydantic, NumPy, SciPy, and Pytest. It is sufficient for non-GPU tests that mock or avoid the required CUDA-Q execution path.

### NVIDIA CUDA-Q execution

```bash
python -m pip install -r backend/requirements-quantum-colab.txt
```

The quantum requirements use the tested integration pair:

```text
qamomile[cudaq-cu12] == 0.13.0
cuda-quantum-cu12    == 0.14.0
```

A CUDA-capable NVIDIA environment is required for the real Hybrid demo.

## Start the API

From the project root:

```bash
CUDAQ_TARGET=nvidia REQUIRE_CUDAQ=1 \
PYTHONPATH=backend \
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Open:

```text
API root:       http://localhost:8000
Health check:   http://localhost:8000/api/health
API docs:       http://localhost:8000/docs
```

The backend intentionally rejects real demo execution when CUDA-Q cannot initialize the NVIDIA target. It does not silently replace GPU QAOA with NumPy enumeration or CPU simulation.

## Test the API

Health check:

```bash
curl http://localhost:8000/api/health
```

Submit the included example request:

```bash
curl -X POST http://localhost:8000/api/runs \
  -H "Content-Type: application/json" \
  --data @sample-run-request.json
```

## Run tests

From the project root:

```bash
PYTHONPATH=backend:. pytest -q backend/tests
```

Run both backend and benchmark tests:

```bash
PYTHONPATH=backend:. pytest -q backend/tests benchmark/tests
```

The tests cover the API contract, pipeline behavior, active-block construction, QUBO/Ising consistency, reconstruction, feasibility logic, IEEE30-derived data generation, and benchmark warm-up protocol.

## Colab GPU demo

The project includes a notebook dedicated to running the backend with an NVIDIA Colab GPU:

```text
PiL-HQUC_Colab_GPU_Demo_API.ipynb
```

Its role is to:

- install the GPU dependencies;
- select the CUDA-Q NVIDIA target;
- start the FastAPI server;
- expose the API for the local frontend demo.

It does not run the offline benchmark suite.

## Implementation notes

### Active-block design

The full 24-hour Unit Commitment problem contains more binary decisions than the QAOA circuit directly represents. Candidate commitment positions are ranked using information from the relaxed problem, including fractionality, residual pressure, dual information, cost impact, temporal context, and transition behavior.

Only the highest-impact positions enter the quantum block. Every measured bitstring is then inserted back into the full commitment schedule before dispatch and feasibility validation.

### Candidate acceptance

A low QUBO energy is not sufficient by itself. Each reconstructed candidate is checked using:

- strict Economic Dispatch;
- generation limits;
- demand balance;
- reserve requirements;
- ramp behavior;
- minimum up/down constraints;
- residual and violation measures.

The final result is selected from validated full-schedule candidates rather than from quantum energy alone.

### Classical solver boundary

The operational API exposes only the proposed Hybrid method. The full HiGHS Unit Commitment solver in `app/classical/` is used as an offline reference by the benchmark suite and is not shown as a competing method in the frontend demo.

## Current scope and limitations

- The default operational model uses a 24-hour horizon and a fixed generator fleet.
- The API stores completed runs in process memory; restarting the server clears them.
- The real QAOA path requires an NVIDIA CUDA-Q environment.
- The project is a Unit Commitment research prototype and operational demonstration, not a production Energy Management System.
- The Hybrid method does not claim current quantum advantage over the full HiGHS reference.
- Network-constrained power flow is outside the current backend model; the benchmark data uses a documented copper-plate adaptation.
