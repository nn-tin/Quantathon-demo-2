from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.models.schemas import BackendKind, RunConfig
from app.services.pipeline import PipelineService

router = APIRouter(prefix="/api")
service = PipelineService()


@router.get("/health")
def health():
    return {
        "status": "ok",
        "run_mode": "classical_and_hybrid_comparison",
        "methods": [BackendKind.CLASSICAL, BackendKind.HYBRID],
    }


@router.get("/datasets")
def datasets(): return service.datasets.list_datasets()


@router.get("/backends")
def backends():
    return [
        {"id": BackendKind.CLASSICAL, "label": "Classical HiGHS Full UC", "role": "baseline"},
        {"id": BackendKind.HYBRID, "label": "ADMM-Guided Qamomile → CUDA-Q", "role": "proposed"},
    ]


@router.post("/runs")
def create_run(config: RunConfig): return service.execute_run(config)


@router.get("/runs/{run_id}")
def get_run(run_id: str):
    try: return service.store.get(run_id)
    except KeyError as exc: raise HTTPException(status_code=404, detail="Run not found") from exc


@router.get("/runs/{run_id}/events")
def get_events(run_id: str): return get_run(run_id).stages


@router.get("/runs/{run_id}/result")
def get_result(run_id: str): return get_run(run_id).result


@router.get("/runs/{run_id}/qubo")
def get_qubo(run_id: str): return get_run(run_id).qubo
