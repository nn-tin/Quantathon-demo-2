from __future__ import annotations

import math
import time
import uuid
from dataclasses import dataclass
from typing import Any

from app.backends.hybrid_qaoa import HybridQAOABackend
from app.baseline.heuristic import build_baseline_schedule
from app.candidate_selection.block import select_candidate_block
from app.candidate_selection.scoring import score_candidates
from app.classical.full_uc import solve_full_uc_highs
from app.datasets.repository import DatasetRepository
from app.dispatch.economic_dispatch import (
    solve_economic_dispatch,
    solve_relaxed_economic_dispatch,
)
from app.evaluation.reconstruct import reconstruct_schedule
from app.feasibility.checks import check_schedule_feasibility
from app.hybrid_mapping import resolve_hybrid_mapping
from app.models.schemas import (
    CandidateBitstring,
    DatasetModel,
    DispatchResult,
    RunConfig,
    RunSummary,
    ScenarioInput,
    StageEvent,
    StageState,
)
from app.preprocessing.preprocess import compute_relaxed_commitment
from app.qubo.builder import build_dynamic_qubo


PIPELINE_STAGES = [
    "Load runtime 24-hour UC input",
    "Classical HiGHS full-UC baseline",
    "LP relaxation and heuristic rounding",
    "Relaxed ED and ADMM feedback",
    "Structured active-block selection",
    "Dynamic QUBO construction",
    "Qamomile to CUDA-Q QAOA",
    "Top-K reconstruction and validation",
    "ADMM outer-loop update",
    "Classical versus hybrid comparison",
]


class RunStore:
    def __init__(self) -> None:
        self._runs: dict[str, RunSummary] = {}

    def save(self, run: RunSummary) -> None: self._runs[run.run_id] = run
    def get(self, run_id: str) -> RunSummary: return self._runs[run_id]


def apply_scenario_input(dataset: DatasetModel, scenario_input: ScenarioInput | None) -> DatasetModel:
    if scenario_input is None:
        return dataset.model_copy(deep=True)
    profiles, horizon = scenario_input.profiles, len(dataset.hours)
    demand = [max(0.0, float(v)) for v in profiles.demand_mw]
    solar = [max(0.0, float(v)) for v in profiles.solar_available_mw]
    wind = [max(0.0, float(v)) for v in profiles.wind_available_mw]
    for name, values in (("demand_mw", demand), ("solar_available_mw", solar), ("wind_available_mw", wind)):
        if len(values) != horizon:
            raise ValueError(f"{name} must contain exactly {horizon} values; received {len(values)}.")
    renewable = [s + w for s, w in zip(solar, wind)]
    capacity = max(0.0, float(scenario_input.battery_capacity_mwh or 0.0))
    initial_soc = min(max(0.0, float(scenario_input.initial_battery_soc_mwh or 0.0)), capacity)
    default_power = 0.25 * capacity
    return dataset.model_copy(deep=True, update={
        "demand": demand,
        "solar_available": solar,
        "wind_available": wind,
        "renewable": renewable,
        "grid_import_limit_mw": max(0.0, float(scenario_input.grid_import_limit_mw or 0.0)),
        "initial_battery_soc_mwh": initial_soc,
        "battery_capacity_mwh": capacity,
        "battery_charge_limit_mw": min(capacity, max(0.0, float(scenario_input.battery_charge_limit_mw if scenario_input.battery_charge_limit_mw is not None else default_power))),
        "battery_discharge_limit_mw": min(capacity, max(0.0, float(scenario_input.battery_discharge_limit_mw if scenario_input.battery_discharge_limit_mw is not None else default_power))),
    })


def build_runtime_input_metrics(config: RunConfig, dataset: DatasetModel) -> dict[str, float | bool]:
    battery_percent = 100.0 * dataset.initial_battery_soc_mwh / dataset.battery_capacity_mwh if dataset.battery_capacity_mwh > 0 else 0.0
    return {
        "scenario_input_applied": config.scenario_input is not None,
        "runtime_peak_demand_mw": round(max(dataset.demand, default=0.0), 3),
        "runtime_peak_renewable_mw": round(max(dataset.renewable, default=0.0), 3),
        "runtime_total_demand_mwh": round(sum(dataset.demand), 3),
        "runtime_total_renewable_available_mwh": round(sum(dataset.renewable), 3),
        "runtime_grid_import_limit_mw": round(dataset.grid_import_limit_mw, 3),
        "runtime_initial_battery_soc_mwh": round(dataset.initial_battery_soc_mwh, 3),
        "runtime_initial_battery_soc_percent": round(battery_percent, 3),
        "runtime_battery_capacity_mwh": round(dataset.battery_capacity_mwh, 3),
        "runtime_battery_charge_limit_mw": round(dataset.battery_charge_limit_mw, 3),
        "runtime_battery_discharge_limit_mw": round(dataset.battery_discharge_limit_mw, 3),
    }


def _schedule_rows(dataset: DatasetModel, schedule: dict[tuple[str, int], int]) -> list[dict[str, Any]]:
    return [
        {
            "generator_id": gen.id,
            "generator_name": gen.name,
            "values": [int(schedule[(gen.id, hour)]) for hour in dataset.hours],
        }
        for gen in dataset.generators
    ]


def _candidate_key(candidate: CandidateBitstring) -> tuple[float, float, float, float]:
    return (
        float(candidate.violation_count),
        float(candidate.weighted_violation),
        float(candidate.residual_norm_mw if candidate.residual_norm_mw is not None else math.inf),
        float(candidate.true_cost if candidate.true_cost is not None else math.inf),
    )


def _evaluate_schedule(
    dataset: DatasetModel,
    schedule: dict[tuple[str, int], int],
    candidate: CandidateBitstring,
) -> tuple[CandidateBitstring, DispatchResult, DispatchResult]:
    strict = solve_economic_dispatch(dataset, schedule)
    relaxed = solve_relaxed_economic_dispatch(dataset, schedule)
    violations = list(dict.fromkeys(
        check_schedule_feasibility(dataset, schedule, strict.hourly_dispatch) + strict.violations
    ))
    residual_norm = relaxed.residual_l2_mw
    shortage = relaxed.total_shortage_mwh
    reserve_count = sum("reserve" in text.lower() for text in violations)
    weighted = len(violations) + 100.0 * shortage + 5.0 * reserve_count + residual_norm
    candidate.is_feasible = bool(strict.feasible and not violations)
    candidate.true_cost = strict.total_cost if strict.feasible else relaxed.total_cost
    candidate.violation_count = len(violations)
    candidate.weighted_violation = round(weighted, 8)
    candidate.residual_norm_mw = residual_norm
    candidate.violation = None if candidate.is_feasible else (violations[0] if violations else "Relaxed dispatch retains a non-zero residual.")
    candidate.dispatch = strict.hourly_dispatch if strict.feasible else relaxed.hourly_dispatch
    return candidate, strict, relaxed


def _method_payload(
    dataset: DatasetModel,
    schedule: dict[tuple[str, int], int],
    dispatch: DispatchResult,
    *,
    runtime_ms: float,
    method_id: str,
    method_name: str,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = {
        "id": method_id,
        "name": method_name,
        "feasible": dispatch.feasible,
        "true_operating_cost": dispatch.total_cost,
        "runtime_ms": round(runtime_ms, 3),
        "schedule": _schedule_rows(dataset, schedule),
        "dispatch": dispatch.model_dump(),
        "cost_breakdown": {
            "variable": dispatch.total_variable_cost,
            "no_load": dispatch.total_no_load_cost,
            "startup": dispatch.total_startup_cost,
            "grid": dispatch.total_grid_import_cost,
            "battery": dispatch.total_battery_cost,
            "curtailment": dispatch.total_curtailment_cost,
        },
        "total_grid_import_mwh": dispatch.total_grid_import_mwh,
        "total_battery_discharge_mwh": dispatch.total_battery_discharge_mwh,
        "total_battery_charge_mwh": dispatch.total_battery_charge_mwh,
        "total_renewable_curtailment_mwh": dispatch.total_renewable_curtailment_mwh,
        "residual_l2_mw": dispatch.residual_l2_mw,
    }
    if extra: payload.update(extra)
    return payload


class PipelineService:
    def __init__(self) -> None:
        self.datasets = DatasetRepository()
        self.store = RunStore()
        self.quantum_backend = HybridQAOABackend()

    def execute_run(self, config: RunConfig) -> RunSummary:
        run_id = str(uuid.uuid4())
        stages: list[StageEvent] = []
        started = time.perf_counter()

        def emit(stage: str, state: StageState, message: str, details: dict[str, Any] | None = None) -> None:
            stages.append(StageEvent(stage=stage, state=state, message=message, timestamp=time.time(), details=details or {}))
            if config.presentation_mode and config.presentation_delay_ms > 0:
                time.sleep(config.presentation_delay_ms / 1000.0)

        base = self.datasets.get_dataset(config.dataset_id)
        dataset = apply_scenario_input(base, config.scenario_input)
        mapping = resolve_hybrid_mapping(len(dataset.generators), config.hybrid_config.qubit_budget)
        if mapping is not None:
            config = config.model_copy(deep=True)
            config.hybrid_config = config.hybrid_config.model_copy(update={
                "qubit_budget": mapping.qubit_budget,
                "candidate_generators": mapping.candidate_generators,
                "candidate_hours": mapping.candidate_hours,
                "top_k": mapping.top_k,
            })
        runtime_metrics = build_runtime_input_metrics(config, dataset)
        if mapping is not None:
            runtime_metrics.update({
                "mapping_qubit_budget": mapping.qubit_budget,
                "mapping_candidate_generators": mapping.candidate_generators,
                "mapping_candidate_hours": mapping.candidate_hours,
                "mapping_top_k": mapping.top_k,
            })
        emit(PIPELINE_STAGES[0], StageState.COMPLETED, "Runtime demand, renewable, grid and battery inputs loaded.", runtime_metrics)

        # Method 2: exact full-UC classical baseline, independent of Method 1.
        classical = solve_full_uc_highs(
            dataset,
            mip_gap=config.classical_config.mip_gap,
            time_limit_seconds=config.classical_config.time_limit_seconds,
        )
        emit(
            PIPELINE_STAGES[1],
            StageState.COMPLETED if classical.success else StageState.WARNING,
            "Full 24-hour UC solved with SciPy HiGHS MILP.",
            {"success": classical.success, "runtime_ms": classical.runtime_ms, "mip_gap": classical.mip_gap, "message": classical.message},
        )

        # Method 1 starts only from LP relaxation + heuristic rounding.
        lp_started = time.perf_counter()
        relaxed_commitment = compute_relaxed_commitment(dataset)
        incumbent = build_baseline_schedule(dataset, relaxed_commitment)
        lp_runtime_ms = (time.perf_counter() - lp_started) * 1000.0
        emit(
            PIPELINE_STAGES[2], StageState.COMPLETED,
            "LP fractional commitment retained separately; heuristic rounding created the hybrid incumbent.",
            {"fractional_variables": sum(1 for v in relaxed_commitment.values() if 1e-6 < v < 1 - 1e-6), "runtime_ms": lp_runtime_ms},
        )

        hybrid = config.hybrid_config
        dual = [0.0 for _ in dataset.hours]
        rho = hybrid.rho_initial
        rounds: list[dict[str, Any]] = []
        last_qubo = None
        hybrid_started = time.perf_counter()
        accepted_strict = solve_economic_dispatch(dataset, incumbent)
        accepted_relaxed = solve_relaxed_economic_dispatch(dataset, incumbent)
        accepted_candidate = CandidateBitstring(
            rank=0,
            bitstring="",
            energy=0.0,
            sample_count=1,
            probability=1.0,
            hamming_distance_from_incumbent=0,
            source="initial_incumbent",
        )
        accepted_candidate, accepted_strict, accepted_relaxed = _evaluate_schedule(dataset, incumbent, accepted_candidate)

        for round_index in range(hybrid.max_quantum_rounds):
            residual_before = list(accepted_relaxed.residual)
            norm_before = accepted_relaxed.residual_l2_mw
            emit(
                PIPELINE_STAGES[3], StageState.COMPLETED,
                f"Round {round_index + 1}: relaxed ED produced shortage-minus-surplus residual feedback.",
                {"residual_l2_mw": norm_before, "rho": rho, "dual_l2": math.sqrt(sum(v*v for v in dual))},
            )

            scores = score_candidates(
                dataset, relaxed_commitment, incumbent, accepted_relaxed, dual, hybrid.score_weights
            )
            block = select_candidate_block(
                dataset, scores, hybrid.candidate_generators, hybrid.candidate_hours, hybrid.qubit_budget
            )
            emit(
                PIPELINE_STAGES[4], StageState.COMPLETED,
                f"Round {round_index + 1}: selected a structured {len(block.generator_ids)}×{len(block.hours)} active block.",
                {"generators": block.generator_ids, "hours": block.hours, "qubits": len(block.positions)},
            )

            qubo = build_dynamic_qubo(
                dataset, incumbent, block, accepted_relaxed, residual_before, dual, rho,
                deviation_weight=hybrid.deviation_weight,
                temporal_weight=hybrid.temporal_weight,
            )
            last_qubo = qubo
            emit(
                PIPELINE_STAGES[5], StageState.COMPLETED,
                f"Round {round_index + 1}: ADMM-guided dynamic QUBO constructed.",
                {"dimension": qubo.dimension, "rho": rho, "coefficient_scale": qubo.metadata.get("coefficient_scale")},
            )

            quantum_result = self.quantum_backend.solve(qubo, config)
            emit(
                PIPELINE_STAGES[6], StageState.COMPLETED,
                f"Round {round_index + 1}: QAOA produced candidate bitstrings.",
                {"source": quantum_result.candidates[0].source if quantum_result.candidates else None, "runtime_ms": quantum_result.backend_runtime_ms},
            )

            evaluated: list[tuple[CandidateBitstring, dict[tuple[str, int], int], DispatchResult, DispatchResult]] = []
            for candidate in quantum_result.candidates:
                schedule = reconstruct_schedule(incumbent, block, candidate.bitstring)
                candidate, strict, relaxed = _evaluate_schedule(dataset, schedule, candidate)
                evaluated.append((candidate, schedule, strict, relaxed))

            incumbent_bits = str(qubo.metadata["incumbent_bitstring"])
            incumbent_entry = next((item for item in evaluated if item[0].bitstring == incumbent_bits), None)
            if incumbent_entry is None:
                keep = CandidateBitstring(
                    rank=len(evaluated) + 1,
                    bitstring=incumbent_bits,
                    energy=0.0,
                    sample_count=1,
                    probability=0.0,
                    hamming_distance_from_incumbent=0,
                    source="incumbent_safety_candidate",
                )
                keep, strict, relaxed = _evaluate_schedule(dataset, incumbent, keep)
                incumbent_entry = (keep, dict(incumbent), strict, relaxed)
                evaluated.append(incumbent_entry)

            evaluated.sort(key=lambda item: _candidate_key(item[0]))
            winner, winner_schedule, winner_strict, winner_relaxed = evaluated[0]
            previous_key = _candidate_key(incumbent_entry[0])
            accepted = _candidate_key(winner) <= previous_key
            if accepted:
                incumbent = winner_schedule
                accepted_candidate = winner
                accepted_strict, accepted_relaxed = winner_strict, winner_relaxed
            else:
                accepted_candidate, _, accepted_strict, accepted_relaxed = incumbent_entry

            emit(
                PIPELINE_STAGES[7], StageState.COMPLETED,
                f"Round {round_index + 1}: reconstructed and validated {len(evaluated)} schedules.",
                {"accepted_bitstring": accepted_candidate.bitstring, "feasible_candidates": sum(1 for item in evaluated if item[0].is_feasible), "accepted": accepted},
            )

            residual_after = list(accepted_relaxed.residual)
            norm_after = accepted_relaxed.residual_l2_mw
            dual = [lam + rho * residual for lam, residual in zip(dual, residual_after)]
            rho_before = rho
            if norm_after > hybrid.residual_progress_ratio * max(norm_before, 1e-9):
                rho = min(hybrid.rho_max, hybrid.rho_growth * rho)
            emit(
                PIPELINE_STAGES[8], StageState.COMPLETED,
                f"Round {round_index + 1}: updated dual multiplier and penalty.",
                {"residual_before": norm_before, "residual_after": norm_after, "rho_before": rho_before, "rho_after": rho},
            )

            rounds.append({
                "round": round_index + 1,
                "block": block.model_dump(),
                "scores": [score.model_dump() for score in scores if score.selected],
                "qubo": qubo.model_dump(),
                "backend": quantum_result.model_dump(),
                "evaluated_candidates": [item[0].model_dump() for item in evaluated],
                "accepted_candidate": accepted_candidate.model_dump(),
                "residual_before_l2_mw": norm_before,
                "residual_after_l2_mw": norm_after,
                "dual": list(dual),
                "rho_before": rho_before,
                "rho_after": rho,
            })

            # At least one quantum round is always executed. Afterwards, stop
            # only when exact physical validation and residual tolerance agree.
            if round_index >= 0 and accepted_strict.feasible and not check_schedule_feasibility(dataset, incumbent, accepted_strict.hourly_dispatch) and norm_after <= hybrid.residual_tolerance_mw:
                break

        hybrid_runtime_ms = (time.perf_counter() - hybrid_started) * 1000.0 + lp_runtime_ms
        final_strict = solve_economic_dispatch(dataset, incumbent)
        if not final_strict.feasible:
            final_dispatch = accepted_relaxed
        else:
            final_dispatch = final_strict

        classical_payload = _method_payload(
            dataset, classical.schedule, classical.dispatch,
            runtime_ms=classical.runtime_ms,
            method_id="classical",
            method_name="Classical HiGHS Full UC",
            extra={"mip_gap": classical.mip_gap, "solver_message": classical.message, "objective": classical.objective},
        )
        hybrid_payload = _method_payload(
            dataset, incumbent, final_dispatch,
            runtime_ms=hybrid_runtime_ms,
            method_id="hybrid",
            method_name="ADMM-Guided Active-Block QAOA",
            extra={
                "initial_schedule": _schedule_rows(dataset, build_baseline_schedule(dataset, relaxed_commitment)),
                "fractional_commitment": [
                    {"generator_id": gen.id, "values": [round(relaxed_commitment[(gen.id, hour)], 6) for hour in dataset.hours]}
                    for gen in dataset.generators
                ],
                "quantum_rounds": rounds,
                "round_count": len(rounds),
                "active_qubits": last_qubo.dimension if last_qubo else 0,
                "selected_candidate": accepted_candidate.model_dump(),
                "dual": dual,
                "rho_final": rho,
                "backend_source": rounds[-1]["backend"]["candidates"][0]["source"] if rounds and rounds[-1]["backend"]["candidates"] else None,
            },
        )

        cost_gap = (
            100.0 * (hybrid_payload["true_operating_cost"] - classical_payload["true_operating_cost"]) / classical_payload["true_operating_cost"]
            if classical_payload["true_operating_cost"] else 0.0
        )
        runtime_ratio = hybrid_runtime_ms / max(classical.runtime_ms, 1e-9)
        comparison = {
            "cost_gap_percent": round(cost_gap, 6),
            "runtime_ratio_hybrid_over_classical": round(runtime_ratio, 6),
            "classical_cost": classical_payload["true_operating_cost"],
            "hybrid_cost": hybrid_payload["true_operating_cost"],
            "classical_runtime_ms": classical.runtime_ms,
            "hybrid_runtime_ms": hybrid_runtime_ms,
            "both_feasible": bool(classical_payload["feasible"] and hybrid_payload["feasible"]),
            "same_runtime_dataset": True,
        }
        convergence = [
            {
                "round": row["round"],
                "residual_l2_mw": row["residual_after_l2_mw"],
                "validated_cost": row["accepted_candidate"].get("true_cost"),
                "best_qubo_energy": row["backend"].get("best_energy"),
                "rho": row["rho_after"],
            }
            for row in rounds
        ]
        emit(
            PIPELINE_STAGES[9], StageState.COMPLETED,
            "Classical and hybrid methods compared on the same runtime dataset.",
            comparison,
        )

        result = {
            "contract_version": "pil-hquc-comparison-v2",
            "scenario_input_applied": config.scenario_input is not None,
            "classical": classical_payload,
            "hybrid": hybrid_payload,
            "recommended_plan": hybrid_payload,
            "comparison": comparison,
            "convergence": convergence,
        }
        metrics = {
            "total_commitment_variables": len(dataset.generators) * len(dataset.hours),
            "candidate_variables": last_qubo.dimension if last_qubo else 0,
            "reduction_ratio": round((last_qubo.dimension if last_qubo else 0) / max(len(dataset.generators) * len(dataset.hours), 1), 6),
            "total_runtime_ms": round((time.perf_counter() - started) * 1000.0, 3),
            **runtime_metrics,
        }
        summary = RunSummary(
            run_id=run_id,
            status="completed" if classical.success else "completed_with_warnings",
            config=config,
            dataset=dataset,
            stages=stages,
            metrics=metrics,
            result=result,
            qubo=last_qubo,
        )
        self.store.save(summary)
        return summary
