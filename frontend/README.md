# PiL-HQUC Frontend

The `frontend/` directory contains the interactive web interface for the PiL-HQUC Hybrid Unit Commitment demo. It is built with React and Vite and is designed to let users configure a 24-hour operating scenario, submit it to the FastAPI backend, and inspect the validated operating plan returned by the Hybrid solver.

The frontend is an operational demonstration interface. It does not execute QAOA, Economic Dispatch, or feasibility validation in the browser. All optimization is performed by the backend.

## What the interface demonstrates

The application presents the project as a three-stage workflow:

1. **Project introduction** — explains the scheduling problem and the role of the Hybrid quantum-classical method.
2. **Operating workspace** — lets the user configure demand, renewable availability, grid import, and battery conditions.
3. **Recommended schedule** — displays the final 24-hour operating plan, cost summary, generator commitment, dispatch information, validation status, and solver execution log.

The public demo is intentionally **Hybrid-only**. Classical HiGHS comparisons and scaling studies are kept in the separate [`benchmark/`](../benchmark/) package.

## Main capabilities

- Select predefined operating profiles.
- Adjust system-level operating inputs.
- Generate complete 24-hour demand, solar, and wind profiles.
- Submit a scenario to `POST /api/runs`.
- Display backend execution stages and completion status.
- Visualize generator on/off commitment across 24 hours.
- Present hourly power supply and operating summaries.
- Display feasibility, operating cost, renewable contribution, curtailment, and runtime information returned by the backend.
- Normalize the backend response into the result format expected by the interface.
- Support local API proxying and an externally hosted API URL.

## Technology

- React 18
- Vite 5
- JavaScript
- CSS
- Native browser `fetch` API

## Directory structure

```text
frontend/
├── index.html
├── package.json
├── package-lock.json
├── vite.config.js
└── src/
    ├── main.jsx
    ├── App.jsx
    └── styles.css
```

The current interface is intentionally contained in a small number of files so the hackathon demo remains easy to run and transfer. `App.jsx` includes the application state, backend adapter, scenario generation, result normalization, charts, exports, and page components. `styles.css` contains the complete visual system and responsive layout.

## Backend connection

By default, the frontend sends requests to relative `/api` paths. During local development, Vite proxies those requests to:

```text
http://127.0.0.1:8000
```

The proxy is configured in `vite.config.js`.

The API base URL can also be changed with:

```env
VITE_API_BASE_URL=https://your-backend.example.com/api
```

A runtime configuration object may be provided before the application loads:

```html
<script>
  window.__HQUC_CONFIG__ = {
    apiBaseUrl: "https://your-backend.example.com/api",
    requestTimeoutMs: 180000,
    pollIntervalMs: 900,
    maxPollAttempts: 160
  };
</script>
```

When no custom configuration is provided, the interface uses:

```text
API base URL:       /api
Health endpoint:    /health
Dataset endpoint:   /datasets
Create run:         /runs
Run status:         /runs/{runId}
```

## Scenario data sent to the backend

The frontend sends operating data rather than quantum hyperparameters. A run request contains:

- dataset ID;
- run mode;
- scenario metadata;
- 24 hourly demand values;
- 24 hourly solar availability values;
- 24 hourly wind availability values;
- grid import limit;
- initial battery state of charge;
- battery capacity.

Example request shape:

```json
{
  "dataset_id": "default_10x24",
  "run_mode": "hybrid_demo",
  "presentation_mode": false,
  "presentation_delay_ms": 0,
  "scenario_input": {
    "contract_version": "pil-hquc-scenario-input-v1",
    "scenario_id": "custom",
    "scenario_name": "Selected scenario",
    "horizon_hours": 24,
    "grid_import_limit_mw": 40,
    "initial_battery_soc_mwh": 32,
    "battery_capacity_mwh": 80,
    "profiles": {
      "demand_mw": [126, 122, 118, 117, 120, 132, 153, 180, 204, 219, 213, 195, 177, 168, 165, 171, 180, 189, 198, 204, 195, 180, 159, 141],
      "solar_available_mw": [0, 0, 0, 0, 0, 1, 4, 10, 18, 28, 39, 48, 52, 49, 40, 28, 14, 4, 0, 0, 0, 0, 0, 0],
      "wind_available_mw": [16, 15, 14, 13, 12, 10, 8, 5, 3, 5, 6, 6, 6, 8, 12, 17, 22, 23, 21, 18, 16, 16, 15, 14]
    }
  }
}
```

QAOA depth, shots, optimizer budget, Top-K size, active qubit budget, and maximum quantum rounds are fixed by the backend profile and are not controlled from the interface.

## Expected backend response

The frontend accepts the completed `RunSummary` returned by the backend. The recommended operating plan is read primarily from:

```text
result.hybrid
```

For compatibility with earlier result formats, it can also read:

```text
result.recommended_plan
```

The response is normalized before rendering so that the result page can display:

- run status and execution stages;
- recommended commitment schedule;
- hourly dispatch;
- operating cost;
- feasibility state;
- validation checks;
- selected quantum candidate;
- QAOA and end-to-end runtime information;
- operator-oriented recommended actions.

## Run locally

### 1. Start the backend

Follow the instructions in [`backend/README.md`](../backend/README.md). The backend should be available on port `8000`.

### 2. Install frontend dependencies

```bash
cd frontend
npm ci
```

### 3. Start the development server

```bash
npm run dev
```

Open:

```text
http://localhost:5173
```

## Build the frontend

Create a production build:

```bash
npm run build
```

Preview the generated build locally:

```bash
npm run preview
```

The production files are written to:

```text
dist/
```

## Deployment note

The static Vite build can be hosted on services such as Vercel or another static web host. A deployed frontend still needs access to a running PiL-HQUC backend. Set `VITE_API_BASE_URL` to the public backend API before building, or provide `window.__HQUC_CONFIG__` at runtime.

For a portfolio-only deployment, the interface may also be connected to a verified recorded result, provided that the website clearly identifies it as a recorded GPU run rather than a live CUDA-Q execution.

## Current scope

This frontend is designed as a project demonstration rather than a complete production energy-management platform. It focuses on:

- communicating the Hybrid workflow clearly;
- collecting one 24-hour operating scenario;
- presenting one validated recommended schedule;
- visualizing evidence returned by the solver.

Offline Classical comparisons, qubit scaling, generator scaling, raw benchmark records, and benchmark charts belong to the [`benchmark/`](../benchmark/) directory and are not shown as competing methods in the operational interface.
