# syntax=docker/dockerfile:1

# Build the existing React/Vite frontend. VITE_API_BASE_URL is intentionally
# empty, so the browser calls the same host through the relative /api path.
FROM node:20-bookworm-slim AS frontend-builder
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Keep the exact CUDA-Q version used by the project benchmark report.
FROM nvcr.io/nvidia/quantum/cuda-quantum:cu12-0.14.0

USER root
ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CUDAQ_TARGET=nvidia \
    REQUIRE_CUDAQ=1 \
    FRONTEND_DIST=/app/frontend_dist \
    GPU_RUN_COOLDOWN_SECONDS=15 \
    PORT=8000

WORKDIR /app

COPY backend/requirements.txt /tmp/requirements.txt
COPY backend/requirements-quantum-colab.txt /tmp/requirements-quantum.txt
RUN python3 -m pip install --upgrade "pip>=24" && \
    python3 -m pip install -r /tmp/requirements-quantum.txt && \
    rm -f /tmp/requirements.txt /tmp/requirements-quantum.txt

RUN groupadd --gid 10001 appuser && \
    useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash appuser

COPY --chown=appuser:appuser backend /app/backend
COPY --from=frontend-builder --chown=appuser:appuser \
    /build/frontend/dist /app/frontend_dist

ENV PYTHONPATH=/app/backend \
    HOME=/home/appuser

USER appuser
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=5 \
  CMD python3 -c "import json,urllib.request; d=json.load(urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=8)); assert d['status']=='ok' and d['cudaq']['execution_device']=='gpu'"

# One worker is intentional: run records are held in memory and one T4 GPU is
# shared by all visitors.
CMD ["python3", "-m", "uvicorn", "app.aws_main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]
