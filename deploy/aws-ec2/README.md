# AWS EC2 GPU deployment

This directory deploys the complete React frontend and FastAPI/CUDA-Q backend
on one NVIDIA GPU EC2 instance.

## Architecture

```text
Browser
   │ HTTP :80
   ▼
Docker container
   ├── React/Vite static frontend
   ├── FastAPI API under /api
   └── Qamomile → CUDA-Q target nvidia
          │
          ▼
      NVIDIA T4 GPU
```

The frontend uses the relative `/api` URL, so no frontend environment variable
or separate CORS domain is required.

## Files

- `Dockerfile` — builds React, installs the pinned quantum dependencies and
  launches the AWS FastAPI entry point.
- `Dockerfile.dockerignore` — excludes local dependencies, caches and archives
  from the Docker build context.
- `compose.yaml` — exposes port 80 and reserves one NVIDIA GPU.
- `scripts/install-host.sh` — installs Docker Engine and NVIDIA Container
  Toolkit on an Ubuntu GPU host whose NVIDIA driver is already available.
- `scripts/deploy.sh` — builds and starts the application.
- `scripts/update.sh` — pulls the latest Git commit and rebuilds.
- `scripts/logs.sh` — follows application logs.
- `scripts/verify.sh` — checks the GPU and public API endpoints.
- `scripts/remove-app.sh` — removes the application container. It does not stop
  the EC2 instance.

See [`../../AWS-DEPLOY.md`](../../AWS-DEPLOY.md) for the complete AWS Console
walkthrough.
