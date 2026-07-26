from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException

from app.config.quantum_profile import (
    DEMO_QUBIT_BUDGET,
    DEMO_TOP_K,
    FIXED_QUANTUM_PROFILE,
)
from app.models.schemas import BackendKind, RunConfig
from app.services.pipeline import PipelineService

router = APIRouter(prefix="/api")
service = PipelineService()


def _cudaq_status() -> dict[str, object]:
    requested = os.getenv("CUDAQ_TARGET", FIXED_QUANTUM_PROFILE.quantum_target)
    try:
        import cudaq

        cudaq.set_target(requested)
        target = cudaq.get_target()
        name_value = getattr(target, "name", str(target))
        name = name_value() if callable(name_value) else str(name_value)
        return {
            "available": True,
            "target": name,
            "execution_device": "gpu" if "nvidia" in name.lower() else "cpu",
        }
    except Exception as exc:  # optional dependency is absent in CPU-only dev/tests
        return {
            "available": False,
            "target": requested,
            "execution_device": "unavailable",
            "error": f"{type(exc).__name__}: {exc}",
        }


@router.get("/health")
def health():
    return {
        "status": "ok",
        "run_mode": "hybrid_demo",
        "method": BackendKind.HYBRID,
        "quantum_backend": "qamomile_cudaq",
        "cudaq": _cudaq_status(),
        "fixed_profile": {
            "qubit_budget": DEMO_QUBIT_BUDGET,
            "top_k": DEMO_TOP_K,
            "qaoa_depth": FIXED_QUANTUM_PROFILE.qaoa_depth,
            "shots": FIXED_QUANTUM_PROFILE.shots,
            "optimizer_shots": FIXED_QUANTUM_PROFILE.optimizer_shots,
            "optimizer_evaluations": FIXED_QUANTUM_PROFILE.optimizer_evaluations,
            "max_quantum_rounds": FIXED_QUANTUM_PROFILE.max_quantum_rounds,
        },
    }


@router.get("/datasets")
def datasets():
    return service.datasets.list_datasets()


@router.get("/backends")
def backends():
    return [
        {
            "id": BackendKind.HYBRID,
            "label": "ADMM-Guided Qamomile → CUDA-Q",
            "role": "proposed",
            "target": "nvidia",
        }
    ]


@router.post("/runs")
def create_run(config: RunConfig):
    return service.execute_run(config)


@router.get("/runs/{run_id}")
def get_run(run_id: str):
    try:
        return service.store.get(run_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Run not found") from exc


@router.get("/runs/{run_id}/events")
def get_events(run_id: str):
    return get_run(run_id).stages


@router.get("/runs/{run_id}/result")
def get_result(run_id: str):
    return get_run(run_id).result


@router.get("/runs/{run_id}/qubo")
def get_qubo(run_id: str):
    return get_run(run_id).qubo
