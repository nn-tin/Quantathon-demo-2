# Frontend integration

The localhost UI exposes one action: **Generate 24h Plan**.

It sends the operating scenario to `POST /api/runs`. The demo backend runs only the proposed Hybrid method:

- ADMM-guided active-block selection;
- Qamomile QUBO-to-Ising conversion;
- CUDA-Q execution on the required NVIDIA GPU target;
- top-K reconstruction and the existing ED/feasibility validation.

The recommended operating plan is read from `result.hybrid` / `result.recommended_plan`.
Classical comparison, qubit scaling and generator scaling are intentionally separated into the offline `benchmark/` package and its generated `benchmark_report.html`.

## Environment

For local Vite proxy mode, leave `.env` empty. Vite proxies `/api` to FastAPI on port 8000.

The backend runtime must set:

```env
CUDAQ_TARGET=nvidia
REQUIRE_CUDAQ=1
```

The demo does not silently fall back to NumPy/CPU.

## Runtime inputs

The sliders submit final 24-hour profiles for:

- demand;
- solar availability;
- wind availability;
- grid import limit;
- initial battery SOC and battery capacity.

The demo dataset keeps its generator specifications and reserve requirements fixed. QAOA depth, shots, optimizer budget, top-K and maximum outer rounds are fixed by the backend profile rather than exposed in the frontend request.
