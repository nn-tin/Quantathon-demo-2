from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from app.api.routes import router


class PublicGpuRunGuard(BaseHTTPMiddleware):
    """Protect one public GPU from concurrent or repeated run requests.

    The application intentionally uses one Uvicorn worker and one GPU. A run
    request is rejected with HTTP 429 while the GPU is busy instead of being
    queued indefinitely. Each client also receives a small cooldown between
    accepted requests.
    """

    _run_lock = asyncio.Lock()
    _last_request_by_client: dict[str, float] = {}

    async def dispatch(self, request: Request, call_next):
        if request.method != "POST" or request.url.path != "/api/runs":
            return await call_next(request)

        forwarded_for = request.headers.get("x-forwarded-for", "")
        client_ip = forwarded_for.split(",", maxsplit=1)[0].strip()
        if not client_ip:
            client_ip = request.client.host if request.client else "unknown"

        now = time.monotonic()
        cooldown_seconds = max(
            int(os.getenv("GPU_RUN_COOLDOWN_SECONDS", "15")),
            0,
        )
        previous = self._last_request_by_client.get(client_ip, 0.0)
        remaining = cooldown_seconds - (now - previous)
        if remaining > 0:
            return JSONResponse(
                status_code=429,
                content={
                    "detail": "Please wait before starting another GPU run.",
                    "retry_after_seconds": max(int(remaining) + 1, 1),
                },
                headers={"Retry-After": str(max(int(remaining) + 1, 1))},
            )

        if self._run_lock.locked():
            return JSONResponse(
                status_code=429,
                content={
                    "detail": "The GPU is currently processing another run.",
                    "retry_after_seconds": 10,
                },
                headers={"Retry-After": "10"},
            )

        self._last_request_by_client[client_ip] = now
        async with self._run_lock:
            return await call_next(request)


app = FastAPI(
    title="Quantum-Assisted Unit Commitment",
    description="WATTS UP — AWS GPU deployment",
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
)

app.add_middleware(PublicGpuRunGuard)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)
app.include_router(router)


@app.get("/api/deployment")
def deployment_info():
    return {
        "name": "Quantum-Assisted Unit Commitment",
        "team": "WATTS UP",
        "event": "the 2nd SEA Quantathon (QC4SG 2026)",
        "platform": "aws_ec2_gpu",
        "cudaq_target": os.getenv("CUDAQ_TARGET", "nvidia"),
        "require_cudaq": os.getenv("REQUIRE_CUDAQ", "1"),
        "gpu_run_cooldown_seconds": int(
            os.getenv("GPU_RUN_COOLDOWN_SECONDS", "15")
        ),
    }


frontend_dir = Path(os.getenv("FRONTEND_DIST", "/app/frontend_dist"))
if not frontend_dir.exists():

    @app.get("/")
    def frontend_missing():
        return JSONResponse(
            status_code=503,
            content={
                "status": "frontend_missing",
                "expected_directory": str(frontend_dir),
                "api_health": "/api/health",
                "api_docs": "/api/docs",
            },
        )

else:
    # Mount last so every /api route has priority over the React application.
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
