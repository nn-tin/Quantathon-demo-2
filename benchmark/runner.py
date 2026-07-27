from __future__ import annotations

import contextlib
import csv
import io
import json
import math
import os
import platform
import sys
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from app.classical.full_uc import solve_full_uc_highs
from app.config.quantum_profile import build_fixed_hybrid_config
from app.models.schemas import DatasetModel, RunConfig
from app.services.pipeline import PipelineService
from benchmark.config import (
    CLASSICAL_MIP_GAP,
    CLASSICAL_TIME_LIMIT_SECONDS,
    WARMUP_SEED,
)
from benchmark.data.block_mapping import BlockShape


def ensure_gpu_environment() -> dict[str, str]:
    os.environ["CUDAQ_TARGET"] = "nvidia"
    os.environ["REQUIRE_CUDAQ"] = "1"
    try:
        import cudaq

        cudaq.set_target("nvidia")
        target = cudaq.get_target()
        name_value = getattr(target, "name", str(target))
        name = name_value() if callable(name_value) else str(name_value)
    except Exception as exc:
        raise RuntimeError(
            "Benchmark requires CUDA-Q with the NVIDIA target. "
            f"Initialization failed: {type(exc).__name__}: {exc}"
        ) from exc
    if "nvidia" not in name.lower():
        raise RuntimeError(f"Expected NVIDIA CUDA-Q target, received {name}.")
    return {"target": name, "execution_device": "gpu"}


def environment_metadata() -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "cudaq_target": os.getenv("CUDAQ_TARGET", "nvidia"),
    }
    for package_name, import_name in (
        ("cuda-quantum", "cudaq"),
        ("qamomile", "qamomile"),
    ):
        try:
            module = __import__(import_name)
            metadata[package_name] = getattr(module, "__version__", "installed")
        except Exception:
            metadata[package_name] = "not-installed"
    return metadata


def warmup_hybrid_configuration(
    service: PipelineService,
    dataset: DatasetModel,
    *,
    qubit_budget: int,
    shape: BlockShape,
    top_k: int,
    configuration_id: str,
    quiet: bool = True,
) -> dict[str, Any]:
    """Run and discard one full Hybrid solve for a quantum configuration.

    This first run initializes the CUDA context, CUDA-Q/Qamomile resources and
    circuit-size-specific runtime state. The returned record is written only to
    ``discarded_quantum_warmups.*`` and is never included in benchmark
    summaries, plots, runtime ratios or conclusions.
    """

    result = run_hybrid_case(
        service,
        dataset,
        qubit_budget=qubit_budget,
        shape=shape,
        top_k=top_k,
        seed=WARMUP_SEED,
        quiet=quiet,
        run_mode="benchmark_warmup_discarded",
    )
    return {
        "configuration_id": configuration_id,
        "discarded": True,
        "warmup_seed": WARMUP_SEED,
        "timing_protocol": "first_run_discarded_second_and_later_measured",
        **result,
    }


def run_classical_case(dataset: DatasetModel) -> dict[str, Any]:
    result = solve_full_uc_highs(
        dataset,
        mip_gap=CLASSICAL_MIP_GAP,
        time_limit_seconds=CLASSICAL_TIME_LIMIT_SECONDS,
    )
    return {
        "milp_success": bool(result.success),
        "milp_feasible": bool(result.dispatch.feasible),
        "milp_cost": float(result.dispatch.total_cost),
        "milp_runtime_ms": float(result.runtime_ms),
        "milp_gap": result.mip_gap,
        "milp_message": result.message,
    }


def run_hybrid_case(
    service: PipelineService,
    dataset: DatasetModel,
    *,
    qubit_budget: int,
    shape: BlockShape,
    top_k: int,
    seed: int,
    quiet: bool = True,
    run_mode: str = "offline_benchmark",
) -> dict[str, Any]:
    if shape.total_positions != qubit_budget:
        raise ValueError(
            f"Block shape uses {shape.total_positions} positions but q={qubit_budget}."
        )
    config = RunConfig(
        dataset_id=dataset.id,
        run_mode=run_mode,
        hybrid_config=build_fixed_hybrid_config(
            qubit_budget=qubit_budget,
            candidate_generators=shape.candidate_generators,
            candidate_hours=shape.candidate_hours,
            top_k=top_k,
            random_seed=seed,
        ),
    )
    output = io.StringIO()
    context = contextlib.redirect_stdout(output) if quiet else contextlib.nullcontext()
    # Each warm-up/measured solve starts from a fresh DatasetModel and a
    # fresh RunConfig. Only process-level CUDA/CUDA-Q caches survive.
    fresh_dataset = dataset.model_copy(deep=True)
    with context:
        summary = service.execute_dataset(fresh_dataset, config)

    hybrid = summary.result["hybrid"]
    selected = hybrid.get("selected_candidate", {})
    rounds = hybrid.get("quantum_rounds", [])
    unique_bitstrings = 0
    if rounds:
        unique_bitstrings = len(
            {
                candidate.get("bitstring")
                for candidate in rounds[-1].get("backend", {}).get("candidates", [])
                if candidate.get("bitstring") is not None
            }
        )
    execution_device = str(hybrid.get("execution_device", ""))
    if execution_device.lower() != "gpu":
        raise RuntimeError(
            f"Benchmark case executed on {execution_device!r}, not GPU."
        )

    return {
        "hybrid_feasible": bool(hybrid.get("feasible")),
        "hybrid_cost": float(hybrid.get("true_operating_cost", math.nan)),
        "hybrid_runtime_ms": float(hybrid.get("runtime_ms", math.nan)),
        "qaoa_runtime_ms": float(hybrid.get("qaoa_runtime_ms", math.nan)),
        "candidate_validation_runtime_ms": float(
            hybrid.get("candidate_validation_runtime_ms", math.nan)
        ),
        "lp_preprocessing_runtime_ms": float(
            hybrid.get("lp_preprocessing_runtime_ms", math.nan)
        ),
        "round_count": int(hybrid.get("round_count", len(rounds))),
        "requested_qubits": int(qubit_budget),
        "actual_active_qubits": int(hybrid.get("active_qubits", 0)),
        "top_k": int(top_k),
        "unique_bitstrings": int(unique_bitstrings),
        "selected_bitstring": selected.get("bitstring"),
        "selected_energy": selected.get("energy"),
        "backend_source": hybrid.get("backend_source"),
        "quantum_target": hybrid.get("quantum_target"),
        "execution_device": execution_device,
        "execution_backend": hybrid.get("execution_backend"),
        "candidate_generators": shape.candidate_generators,
        "candidate_hours": shape.candidate_hours,
        "extra_positions": shape.extra_positions,
    }


def cost_gap_percent(hybrid_cost: float, milp_cost: float) -> float:
    if not math.isfinite(milp_cost) or abs(milp_cost) <= 1e-12:
        return math.nan
    return 100.0 * (hybrid_cost - milp_cost) / abs(milp_cost)


def _jsonable(value: Any) -> Any:
    if is_dataclass(value):
        return {key: _jsonable(item) for key, item in asdict(value).items()}
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, Path):
        return str(value)
    return value


def write_records(records: list[dict[str, Any]], base_path: Path) -> None:
    base_path.parent.mkdir(parents=True, exist_ok=True)
    json_path = base_path.with_suffix(".json")
    csv_path = base_path.with_suffix(".csv")
    json_path.write_text(
        json.dumps(_jsonable(records), indent=2, allow_nan=True),
        encoding="utf-8",
    )
    if not records:
        csv_path.write_text("", encoding="utf-8")
        return
    fieldnames = sorted({key for record in records for key in record})
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(records)


def write_metadata(metadata: dict[str, Any], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "environment.json").write_text(
        json.dumps(_jsonable(metadata), indent=2),
        encoding="utf-8",
    )


def print_case(record: dict[str, Any]) -> None:
    fields = []
    for key in (
        "experiment",
        "case_id",
        "generator_count",
        "requested_qubits",
        "seed",
        "cost_gap_percent",
        "hybrid_feasible",
        "hybrid_runtime_ms",
    ):
        if key in record:
            fields.append(f"{key}={record[key]}")
    print(" | ".join(fields))
