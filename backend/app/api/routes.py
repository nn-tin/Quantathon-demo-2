from __future__ import annotations

import json
import os
import signal
import subprocess
import sys

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


def _disable_child_core_dump() -> None:
    """Prevent a failed CUDA-Q probe from leaving a large core file."""

    try:
        import resource

        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    except Exception:
        # The probe still works on platforms without ``resource``.
        pass


def _cudaq_status() -> dict[str, object]:
    """Probe CUDA-Q in a child process instead of importing it in the API.

    A CUDA-Q binary/runtime mismatch can terminate the interpreter with
    SIGABRT during ``import cudaq``. A normal try/except cannot catch that.
    Isolating the probe keeps FastAPI and local pytest alive while still
    reporting the real NVIDIA target inside the AWS GPU container.
    """

    requested = os.getenv("CUDAQ_TARGET", FIXED_QUANTUM_PROFILE.quantum_target)
    timeout_seconds = max(
        float(os.getenv("CUDAQ_HEALTHCHECK_TIMEOUT_SECONDS", "15")),
        1.0,
    )
    probe = r'''
import json
import sys

requested = sys.argv[1]
try:
    import cudaq

    cudaq.set_target(requested)
    target = cudaq.get_target()
    name_value = getattr(target, "name", str(target))
    name = name_value() if callable(name_value) else str(name_value)
    print(json.dumps({
        "available": True,
        "target": name,
        "execution_device": "gpu" if "nvidia" in name.lower() else "cpu",
    }))
except BaseException as exc:
    print(json.dumps({
        "available": False,
        "target": requested,
        "execution_device": "unavailable",
        "error": f"{type(exc).__name__}: {exc}",
    }))
'''

    env = os.environ.copy()
    env["CUDAQ_TARGET"] = requested

    try:
        completed = subprocess.run(
            [sys.executable, "-c", probe, requested],
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            env=env,
            preexec_fn=_disable_child_core_dump if os.name == "posix" else None,
        )
    except subprocess.TimeoutExpired:
        return {
            "available": False,
            "target": requested,
            "execution_device": "unavailable",
            "error": f"CUDA-Q health probe timed out after {timeout_seconds:g}s",
        }
    except Exception as exc:
        return {
            "available": False,
            "target": requested,
            "execution_device": "unavailable",
            "error": f"{type(exc).__name__}: {exc}",
        }

    if completed.returncode == 0:
        for line in reversed(completed.stdout.splitlines()):
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict) and "available" in payload:
                return payload

    if completed.returncode < 0:
        signal_number = -completed.returncode
        try:
            signal_name = signal.Signals(signal_number).name
        except ValueError:
            signal_name = f"signal {signal_number}"
        detail = f"CUDA-Q probe terminated by {signal_name}"
    else:
        detail = f"CUDA-Q probe exited with code {completed.returncode}"

    stderr = completed.stderr.strip().splitlines()
    if stderr:
        detail = f"{detail}: {stderr[-1][:500]}"

    return {
        "available": False,
        "target": requested,
        "execution_device": "unavailable",
        "error": detail,
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
