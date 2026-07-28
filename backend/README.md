# Backend — Quantum-Assisted Unit Commitment

A FastAPI backend implementing the classical preprocessing, ADMM-guided active-block selection, QUBO construction, CUDA-Q QAOA execution, schedule reconstruction and feasibility validation pipeline.

## Features

- ⚙️ FastAPI REST API
- 📦 Pydantic request and response schemas
- 🧮 LP relaxation and heuristic initial commitment
- ⚡ Relaxed and exact Economic Dispatch
- 🧠 Residual and dual-signal active-block ranking
- 🔲 Dynamic QUBO construction
- ⚛️ QUBO-to-Ising conversion through Qamomile
- 🎮 CUDA-Q NVIDIA GPU execution
- 🎯 Top-K bitstring candidate selection
- ✅ Full 24-hour schedule reconstruction and validation
- 🧪 API and pipeline tests
- ☁️ AWS GPU deployment entry point

## Technology Stack

| Area | Technology |
|---|---|
| API | FastAPI |
| Validation | Pydantic |
| Server | Uvicorn |
| Classical optimization | HiGHS and linear Economic Dispatch |
| Hybrid coordination | ADMM-guided active-block selection |
| Binary model | QUBO |
| Quantum model | Ising Hamiltonian and QAOA |
| Quantum software | Qamomile, CUDA-Q, CUDA-Q Solvers |
| Testing | pytest, FastAPI TestClient |
| Deployment | Docker, AWS EC2 GPU |

## Overview

The backend solves a full 24-hour Unit Commitment workflow while restricting the quantum stage to a small active block.

The full problem may contain hundreds or thousands of binary commitment decisions. The quantum stage does not represent every binary variable. Instead, the backend selects the most influential unit-hour decisions based on residual and dual-pressure signals.

## Hybrid Pipeline

```text
Input validation
        ↓
Initial commitment schedule
        ↓
Relaxed Economic Dispatch
        ↓
Residual and dual-signal computation
        ↓
Active-block selection
        ↓
Dynamic QUBO
        ↓
QUBO-to-Ising mapping
        ↓
QAOA execution
        ↓
Top-K bitstrings
        ↓
Full schedule reconstruction
        ↓
Exact Economic Dispatch
        ↓
Feasibility checks
        ↓
Best candidate
```

### 1. Initial Commitment

A lightweight classical heuristic creates a complete starting schedule.

### 2. Relaxed Economic Dispatch

Dispatch is solved for the current schedule with slack information used to identify pressure points.

### 3. Active-Block Selection

The pipeline ranks binary commitment decisions using:

- demand-supply residuals;
- dual signals;
- generator capability;
- hour structure;
- current commitment state.

### 4. Dynamic QUBO

The selected variables form a small QUBO whose coefficients reflect the current ADMM state.

### 5. Quantum Execution

The QUBO is converted to an Ising representation and solved using QAOA with CUDA-Q.

### 6. Reconstruction and Validation

Every measured bitstring is inserted back into the complete 24-hour commitment schedule. Exact Economic Dispatch and feasibility checks determine whether the candidate can be accepted.

## API Endpoints

### Health

```http
GET /api/health
```

Reports:

- API status;
- CUDA-Q availability;
- selected target;
- GPU or CPU execution device;
- fixed demo configuration.

### Start Optimization

```http
POST /api/runs
Content-Type: application/json
```

Returns a `run_id` and the current run record.

### Read Optimization Result

```http
GET /api/runs/{run_id}
```

Returns the run configuration, Hybrid result, schedule, cost, feasibility and execution details.

### API Documentation

```text
http://localhost:8000/docs
```

AWS entry point:

```text
http://AWS_HOST/api/docs
```

## Prerequisites

### Tests and classical components

- Python 3.12
- pip
- Packages in `backend/requirements.txt`

### Real GPU Hybrid execution

- Linux x86_64
- NVIDIA GPU and driver
- CUDA-compatible runtime
- Packages in `backend/requirements-quantum-colab.txt`
- `CUDAQ_TARGET=nvidia`
- `REQUIRE_CUDAQ=1`

## Quick Start

### Install Base Dependencies

```bash
python -m pip install -r backend/requirements.txt
```

### Install Quantum Dependencies

```bash
python -m pip install -r backend/requirements-quantum-colab.txt
```

### Run API

From the repository root:

```bash
CUDAQ_TARGET=nvidia \
REQUIRE_CUDAQ=1 \
PYTHONPATH=backend \
python -m uvicorn app.main:app \
  --host 0.0.0.0 \
  --port 8000
```

Open:

```text
http://localhost:8000/api/health
http://localhost:8000/docs
```

## Configuration

Important environment variables:

| Variable | Purpose | Recommended value |
|---|---|---|
| `CUDAQ_TARGET` | CUDA-Q execution target | `nvidia` |
| `REQUIRE_CUDAQ` | Prevent silent fallback | `1` |
| `PYTHONPATH` | Expose backend package | `backend` |
| `GPU_RUN_COOLDOWN_SECONDS` | Limit repeated public AWS runs | `15` |
| `FRONTEND_DIST` | Static frontend directory in AWS container | `/app/frontend_dist` |

The fixed demonstration profile includes:

| Parameter | Value |
|---|---:|
| QAOA depth | 1 |
| Final shots | 256 |
| Optimizer shots | 64 |
| Optimizer evaluations | 6 |
| Maximum ADMM-guided rounds | 2 |

## AWS Entry Point

The AWS deployment uses:

```text
backend/app/aws_main.py
```

It adds:

- static React serving;
- same-domain API routing;
- one public GPU run at a time;
- HTTP 429 while the GPU is busy;
- per-client cooldown;
- one Uvicorn worker.

Deployment files:

```text
deploy/aws-ec2/
AWS-DEPLOY.md
```

## Project Structure

```text
backend/
├── app/
│   ├── api/
│   │   └── routes.py
│   ├── backends/
│   ├── classical/
│   ├── config/
│   ├── dispatch/
│   ├── models/
│   ├── quantum/
│   ├── services/
│   │   └── pipeline.py
│   ├── main.py
│   └── aws_main.py
├── tests/
│   ├── test_api_contract.py
│   └── test_pipeline.py
├── requirements.txt
├── requirements-quantum-colab.txt
└── README.md
```

## Testing

From the repository root:

```bash
python -m pip install \
  -r backend/requirements.txt \
  -r benchmark/requirements-benchmark.txt

PYTHONPATH=backend:. \
python -m pytest -q backend/tests benchmark/tests
```

The current combined suite contains 15 passing tests.

## Development Notes

### CPU-only local development

Tests can exercise most pipeline components without requiring a GPU. Official Hybrid benchmark results must still be produced with CUDA-Q on the `nvidia` target.

### Run storage

The API currently stores run records in memory. Restarting the process clears previous runs.

### Public concurrency

The AWS entry point serializes GPU requests because one EC2 instance exposes one GPU to all visitors.

## Troubleshooting

### `ModuleNotFoundError`

Run from the repository root with:

```bash
PYTHONPATH=backend
```

### CUDA-Q import or target failure

Check:

```bash
nvidia-smi
python -c "import cudaq; cudaq.set_target('nvidia'); print(cudaq.get_target())"
```

### Health endpoint reports unavailable

Open application logs and verify that the installed CUDA-Q build matches the container and driver environment.

### API test requires `httpx`

Install the complete base requirements:

```bash
python -m pip install -r backend/requirements.txt
```

### GPU is busy

The AWS API returns HTTP 429 while another run is active. Wait and retry after the value in the `Retry-After` header.

## Current Limitations

- Run storage is in memory.
- Public GPU runs are processed one at a time.
- The model is copper-plate UC and excludes transmission constraints.
- QAOA execution uses a GPU simulator.
- Strict feasibility is not achieved by every candidate or benchmark configuration.
- The backend is a research prototype, not a production grid-control service.
