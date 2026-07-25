# ADMM-Guided Hybrid Unit Commitment Demo

This project compares two methods on the **same 24-hour runtime dataset**:

1. **Classical HiGHS Full UC** — full mixed-integer unit commitment baseline.
2. **ADMM-Guided 8–10-Qubit Active-Block QAOA** — LP initialization, relaxed ED feedback, dynamic QUBO, Qamomile QAOA conversion, CUDA-Q execution, top-K reconstruction, and exact classical validation.

The frontend keeps one **Generate 24h Plan** action. One `/api/runs` request executes both methods and returns `classical`, `hybrid`, `recommended_plan`, `comparison`, and `convergence`.

## Architecture

```text
Frontend runtime inputs
  Demand · Solar · Wind · Grid limit · Battery SOC
                         ↓
FastAPI comparison pipeline
  ├─ Full UC MILP → SciPy HiGHS classical baseline
  └─ LP relaxation → heuristic incumbent
       → relaxed ED with shortage/surplus slack
       → r, λ, ρ feedback
       → structured 2×4 / 2×5 active block
       → ADMM-guided dynamic QUBO
       → Qamomile QUBO→QAOA
       → CUDA-Q target: qpp-cpu or nvidia
       → top-K reconstruction + exact ED validation
       → at most 3 outer rounds
```

## Local development

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Without the optional quantum packages, the backend uses the included NumPy statevector QAOA fallback. This is intended for integration tests and local debugging, not the official Colab GPU run.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Vite proxies `/api` to `http://127.0.0.1:8000` through `vite.config.js`.

## Google Colab GPU

Open `run_colab.ipynb`, enable a GPU runtime, set the repository URL, and run the cells. The notebook installs the pinned Qamomile/CUDA-Q environment and sets:

```bash
CUDAQ_TARGET=nvidia
```

For CPU debugging, use:

```bash
CUDAQ_TARGET=qpp-cpu
```

After installing the optional quantum environment, verify the real integration with:

```bash
PYTHONPATH=backend REQUIRE_CUDAQ=1 python backend/scripts/quantum_smoke.py
```

Qamomile and CUDA-Q still run in sequence in both cases. The target only selects where CUDA-Q simulates the generated QAOA circuit.

## Request contract

See `sample-run-request.json`. Runtime profiles supplied by the frontend are applied before **both** methods run. Generator parameters and reserve remain in the backend dataset. Optional battery charge/discharge limits are supported; when omitted, the backend uses the existing 0.25C assumption.

## Tests

```bash
cd backend
PYTHONPATH=. pytest -q
```

Coverage includes:

- full HiGHS UC baseline;
- LP fractionality and structured 8–10-variable block;
- shortage-positive / surplus-negative residual convention;
- exhaustive QUBO–Ising energy equivalence;
- bit ordering and schedule reconstruction;
- dynamic Hamiltonian change after λ/ρ update;
- one-request Classical + Hybrid response;
- runtime frontend profiles applied to both methods.
