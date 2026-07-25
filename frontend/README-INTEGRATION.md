# Frontend integration

The UI exposes one action: **Generate 24h Plan**.

It sends one comparison request to `POST /api/runs`. The backend runs:

- `classical`: Classical HiGHS full-UC baseline;
- `hybrid`: ADMM-guided active-block QAOA using Qamomile → CUDA-Q.

The recommended operating plan is always read from `result.hybrid` / `result.recommended_plan`. The Classical result is used only as the benchmark reference.

## Environment

For local Vite proxy mode, leave `.env` empty.

For a Colab-hosted backend:

```env
VITE_API_BASE_URL=https://YOUR-PUBLIC-BACKEND/api
```

Optional frontend override of the CUDA-Q target:

```env
VITE_QUANTUM_TARGET=nvidia
```

Normally the target is controlled by the backend environment variable `CUDAQ_TARGET`, so this frontend variable can be omitted.

## Runtime inputs

The existing sliders continue to submit final 24-hour profiles for:

- demand;
- solar availability;
- wind availability;
- grid import limit;
- initial battery SOC and battery capacity.

Generator specifications and reserve requirements remain fixed in the selected backend dataset.
