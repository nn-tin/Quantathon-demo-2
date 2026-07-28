# Frontend — Quantum-Assisted Unit Commitment

A responsive React/Vite interface for configuring, running and reviewing the Hybrid quantum–classical Unit Commitment workflow.

## Features

- ⚡ Scenario-based 24-hour operating inputs
- 📊 Demand, renewable, storage and grid visualizations
- ✅ System checks before optimization
- 🧠 Hybrid QAOA execution log
- 🗓️ Full 24-hour commitment and dispatch schedule
- 💰 Operating-cost and result summaries
- 📄 Result export support
- 📱 Responsive layouts for mobile, tablet, laptop and desktop
- 🔌 FastAPI integration through configurable API base URLs

## Technology Stack

| Area | Technology |
|---|---|
| UI framework | React |
| Build tool | Vite |
| Language | JavaScript / JSX |
| Styling | CSS |
| API communication | Browser Fetch API |
| Charts and schedules | SVG and custom React visualizations |
| Export | Browser-generated result files |
| Production hosting | Static frontend served with FastAPI in AWS Docker deployment |

## Overview

The frontend is the operational presentation layer of the project. It does not expose the offline Classical-versus-Hybrid benchmark as part of the live user workflow.

The interface focuses on one task:

> Convert operating inputs into a recommended Hybrid 24-hour schedule and present the result in a clear decision-support format.

Classical HiGHS results remain in the offline benchmark suite for evaluation and reporting.

## Main Pages

### 1. Overview

Introduces the Unit Commitment problem and the Hybrid workflow.

### 2. Operating Workspace

Allows the user to:

- select an operating scenario;
- inspect demand and renewable profiles;
- adjust key operating inputs;
- review validation checks;
- start the scheduling pipeline.

### 3. Recommended Schedule

Displays:

- generator commitment decisions;
- dispatch values;
- renewable contribution;
- operating cost;
- validation status;
- execution details;
- downloadable result data.

## Application Flow

```text
Scenario selection
        ↓
Operating-input review
        ↓
System validation
        ↓
POST /api/runs
        ↓
Execution progress
        ↓
GET /api/runs/{run_id}
        ↓
Recommended Hybrid schedule
```

## Prerequisites

- Node.js 20 or newer
- npm
- Running FastAPI backend for live optimization

## Quick Start

```bash
cd frontend
npm ci
npm run dev
```

Open:

```text
http://localhost:5173
```

## Environment Variables

Create:

```text
frontend/.env.local
```

when the backend uses a different origin:

```env
VITE_API_BASE_URL=http://localhost:8000/api
```

For the AWS single-container deployment, frontend and backend use the same domain. Leave the value empty:

```env
VITE_API_BASE_URL=
```

The application then uses the relative path:

```text
/api
```

A safe template is included at:

```text
frontend/.env.example
```

Do not commit `.env.local` if it contains a temporary tunnel or private deployment URL.

## API Integration

### Health Check

```http
GET /api/health
```

Used to detect backend and CUDA-Q availability.

### Start a Run

```http
POST /api/runs
Content-Type: application/json
```

The request contains:

- dataset and scenario information;
- 24-hour demand;
- renewable profiles;
- reserve requirements;
- generator specifications;
- fixed Hybrid configuration.

### Read a Run

```http
GET /api/runs/{run_id}
```

The frontend reads the final Hybrid result and displays the recommended schedule.

## Responsive Behavior

The frontend includes a final responsive safety layer that:

- prevents full-page horizontal overflow;
- stacks workspace columns on narrow screens;
- allows wide 24-hour charts to scroll inside their cards;
- keeps modals and popovers inside the viewport;
- enables vertical scrolling on short laptop displays;
- preserves the approved desktop composition;
- supports screens from approximately 280 CSS pixels wide.

Detailed notes:

```text
docs/project-notes/RESPONSIVE-VALIDATION.md
```

## Project Structure

```text
frontend/
├── src/
│   ├── App.jsx
│   ├── main.jsx
│   └── styles.css
├── .env.example
├── index.html
├── package.json
├── package-lock.json
├── vite.config.js
└── README.md
```

## Production Build

```bash
cd frontend
npm ci
npm run build
```

Generated files:

```text
frontend/dist/
```

`dist/` is build output and should not be committed.

## AWS Deployment

The AWS Dockerfile builds the frontend in a Node build stage and copies the generated static files into the final CUDA-Q/FastAPI container.

Relevant files:

```text
deploy/aws-ec2/Dockerfile
deploy/aws-ec2/compose.yaml
AWS-DEPLOY.md
```

In production:

```text
Browser
   ↓
FastAPI static mount
   ├── React application
   └── /api backend routes
```

## Development

### Install Dependencies

```bash
npm ci
```

### Start Development Server

```bash
npm run dev
```

### Build

```bash
npm run build
```

### Preview Production Build

```bash
npm run preview
```

## Usage Notes

- The UI displays the final Hybrid method result.
- Classical results are not shown in the operational interface.
- The execution log is a visual representation of the backend pipeline.
- Benchmark claims must come from offline benchmark outputs, not from the demo screen.
- A valid result should be interpreted together with feasibility and validation fields.

## Troubleshooting

### Blank page after deployment

Check that:

```bash
npm run build
```

passes locally and that the server serves the generated `dist` directory.

### API connection error

Open:

```text
http://BACKEND_HOST/api/health
```

Then verify `VITE_API_BASE_URL`.

### Temporary Cloudflare URL no longer works

Tunnel URLs can expire. Replace the URL in `.env.local`, or use the AWS same-domain deployment.

### Layout appears compressed

Confirm that the browser is not using an extreme zoom level. On narrow screens, the application intentionally switches to vertical scrolling and stacked cards.

## Current Limitations

- Most UI logic currently remains in a large `App.jsx`.
- The application is optimized for project demonstration rather than multi-user production traffic.
- Run history is not permanently stored after the backend restarts.
- The frontend assumes the API follows the schemas supplied by this repository.
