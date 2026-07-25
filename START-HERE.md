# Start here

This archive is a complete project. Do not copy individual replacement files.

## Local integration/debug run

```bash
cd backend
python -m venv .venv
# Linux/macOS: source .venv/bin/activate
# Windows: .venv\Scripts\activate
pip install -r requirements.txt
PYTHONPATH=. pytest -q
uvicorn app.main:app --reload --port 8000
```

In another terminal:

```bash
cd frontend
npm install
npm run dev
```

The local backend uses the NumPy statevector QAOA fallback when Qamomile/CUDA-Q is not installed. Both Classical HiGHS and Hybrid QAOA still run in one `/api/runs` request.

## Official Colab GPU run

Open `run_colab.ipynb`, enable a T4 GPU, set your repository URL, and run the cells. The notebook installs the pinned Qamomile/CUDA-Q pair, verifies the real Qamomile → CUDA-Q path with fallback disabled, and starts FastAPI with `CUDAQ_TARGET=nvidia`.

## Frontend behavior

The UI keeps one **Generate 24h Plan** button. Demand, Solar, Wind, Grid Limit, and Battery SOC/Capacity are sent to the backend and applied to the same runtime dataset used by both methods.
