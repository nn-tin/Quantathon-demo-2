from __future__ import annotations

import math
import time
import uuid
from typing import Any

from app.backends.hybrid_qaoa import HybridQAOABackend
from app.baseline.heuristic import build_baseline_schedule
from app.candidate_selection.block import select_candidate_block
from app.candidate_selection.scoring import score_candidates
from app.config.quantum_profile import FIXED_QUANTUM_PROFILE, build_fixed_hybrid_config
from app.datasets.repository import DatasetRepository
from app.dispatch.economic_dispatch import (
    solve_economic_dispatch,
    solve_relaxed_economic_dispatch,
)
from app.evaluation.reconstruct import reconstruct_schedule
from app.feasibility.checks import check_schedule_feasibility
from app.models.schemas import (
    CandidateBitstring,
    DatasetModel,
    DispatchResult,
    HybridConfig,
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
    "LP relaxation and heuristic rounding",
    "Relaxed ED and ADMM feedback",
    "Structured active-block selection",
    "Dynamic QUBO construction",
    "Qamomile to CUDA-Q QAOA",
    "Top-K reconstruction and validation",
    "ADMM outer-loop update",
    "Validated hybrid operating plan",
]


class RunStore:
    def __init__(self) -> None:
        self._runs: dict[str, RunSummary] = {}

    def save(self, run: RunSummary) -> None:
        self._runs[run.run_id] = run

    def get(self, run_id: str) -> RunSummary:
        return self._runs[run_id]


def apply_scenario_input(
    dataset: DatasetModel,
    scenario_input: ScenarioInput | None,
) -> DatasetModel:
    if scenario_input is None:
        return dataset.model_copy(deep=True)

    profiles = scenario_input.profiles
    horizon = len(dataset.hours)
    demand = [max(0.0, float(value)) for value in profiles.demand_mw]
    solar = [max(0.0, float(value)) for value in profiles.solar_available_mw]
    wind = [max(0.0, float(value)) for value in profiles.wind_available_mw]

    for name, values in (
        ("demand_mw", demand),
        ("solar_available_mw", solar),
        ("wind_available_mw", wind),
    ):
        if len(values) != horizon:
            raise ValueError(
                f"{name} must contain exactly {horizon} values; "
                f"received {len(values)}."
            )

    renewable = [solar_mw + wind_mw for solar_mw, wind_mw in zip(solar, wind)]
    capacity = max(0.0, float(scenario_input.battery_capacity_mwh or 0.0))
    initial_soc = min(
        max(0.0, float(scenario_input.initial_battery_soc_mwh or 0.0)),
        capacity,
    )
    default_power = 0.25 * capacity

    return dataset.model_copy(
        deep=True,
        update={
            "demand": demand,
            "solar_available": solar,
            "wind_available": wind,
            "renewable": renewable,
            "grid_import_limit_mw": max(
                0.0,
                float(scenario_input.grid_import_limit_mw or 0.0),
            ),
            "initial_battery_soc_mwh": initial_soc,
            "battery_capacity_mwh": capacity,
            "battery_charge_limit_mw": min(
                capacity,
                max(
                    0.0,
                    float(
                        scenario_input.battery_charge_limit_mw
                        if scenario_input.battery_charge_limit_mw is not None
                        else default_power
                    ),
                ),
            ),
            "battery_discharge_limit_mw": min(
                capacity,
                max(
                    0.0,
                    float(
                        scenario_input.battery_discharge_limit_mw
                        if scenario_input.battery_discharge_limit_mw is not None
                        else default_power
                    ),
                ),
            ),
        },
    )


def build_runtime_input_metrics(
    config: RunConfig,
    dataset: DatasetModel,
) -> dict[str, float | bool | str]:
    battery_percent = (
        100.0
        * dataset.initial_battery_soc_mwh
        / dataset.battery_capacity_mwh
        if dataset.battery_capacity_mwh > 0
        else 0.0
    )
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
        "runtime_battery_discharge_limit_mw": round(
            dataset.battery_discharge_limit_mw,
            3,
        ),
        "quantum_target": str(config.hybrid_config.quantum_target or "nvidia"),
    }


def _schedule_rows(
    dataset: DatasetModel,
    schedule: dict[tuple[str, int], int],
) -> list[dict[str, Any]]:
    return [
        {
            "generator_id": generator.id,
            "generator_name": generator.name,
            "values": [
                int(schedule[(generator.id, hour)])
                for hour in dataset.hours
            ],
        }
        for generator in dataset.generators
    ]


def _candidate_key(
    candidate: CandidateBitstring,
) -> tuple[float, float, float, float]:
    return (
        float(candidate.violation_count),
        float(candidate.weighted_violation),
        float(
            candidate.residual_norm_mw
            if candidate.residual_norm_mw is not None
            else math.inf
        ),
        float(
            candidate.true_cost
            if candidate.true_cost is not None
            else math.inf
        ),
    )


def _evaluate_schedule(
    dataset: DatasetModel,
    schedule: dict[tuple[str, int], int],
    candidate: CandidateBitstring,
) -> tuple[CandidateBitstring, DispatchResult, DispatchResult]:
    strict = solve_economic_dispatch(dataset, schedule)
    relaxed = solve_relaxed_economic_dispatch(dataset, schedule)
    violations = list(
        dict.fromkeys(
            check_schedule_feasibility(
                dataset,
                schedule,
                strict.hourly_dispatch,
            )
            + strict.violations
        )
    )
    residual_norm = relaxed.residual_l2_mw
    shortage = relaxed.total_shortage_mwh
    reserve_count = sum("reserve" in text.lower() for text in violations)
    weighted = (
        len(violations)
        + 100.0 * shortage
        + 5.0 * reserve_count
        + residual_norm
    )

    candidate.is_feasible = bool(strict.feasible and not violations)
    candidate.true_cost = strict.total_cost if strict.feasible else relaxed.total_cost
    candidate.violation_count = len(violations)
    candidate.weighted_violation = round(weighted, 8)
    candidate.residual_norm_mw = residual_norm
    candidate.violation = (
        None
        if candidate.is_feasible
        else (
            violations[0]
            if violations
            else "Relaxed dispatch retains a non-zero residual."
        )
    )
    candidate.dispatch = (
        strict.hourly_dispatch
        if strict.feasible
        else relaxed.hourly_dispatch
    )
    return candidate, strict, relaxed


def _method_payload(
    dataset: DatasetModel,
    schedule: dict[tuple[str, int], int],
    dispatch: DispatchResult,
    *,
    validated_candidate: CandidateBitstring,
    runtime_ms: float,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    # Use the already-computed full candidate validation. This fixes the old
    # payload bug where an ED-feasible but UC-invalid schedule could be reported
    # as feasible without re-running any checks.
    validated_feasible = bool(validated_candidate.is_feasible)
    dispatch_payload = dispatch.model_dump()
    dispatch_payload["feasible"] = validated_feasible
    if validated_candidate.violation:
        dispatch_payload["violations"] = list(
            dict.fromkeys(
                list(dispatch_payload.get("violations", []))
                + [validated_candidate.violation]
            )
        )

    payload = {
        "id": "hybrid",
        "name": "ADMM-Guided Active-Block QAOA",
        "feasible": validated_feasible,
        "true_operating_cost": dispatch.total_cost,
        "runtime_ms": round(runtime_ms, 3),
        "schedule": _schedule_rows(dataset, schedule),
        "dispatch": dispatch_payload,
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
        "total_renewable_curtailment_mwh": (
            dispatch.total_renewable_curtailment_mwh
        ),
        "residual_l2_mw": dispatch.residual_l2_mw,
    }
    if extra:
        payload.update(extra)
    return payload


def _assert_fixed_profile(config: HybridConfig) -> None:
    profile = FIXED_QUANTUM_PROFILE
    actual = {
        "qaoa_depth": config.qaoa_depth,
        "shots": config.shots,
        "optimizer_shots": config.optimizer_shots,
        "optimizer_evaluations": config.optimizer_evaluations,
        "max_quantum_rounds": config.max_quantum_rounds,
        "quantum_target": config.quantum_target,
        "allow_numpy_fallback": config.allow_numpy_fallback,
    }
    expected = {
        "qaoa_depth": profile.qaoa_depth,
        "shots": profile.shots,
        "optimizer_shots": profile.optimizer_shots,
        "optimizer_evaluations": profile.optimizer_evaluations,
        "max_quantum_rounds": profile.max_quantum_rounds,
        "quantum_target": profile.quantum_target,
        "allow_numpy_fallback": profile.allow_numpy_fallback,
    }
    mismatches = {
        key: (actual[key], expected[key])
        for key in expected
        if actual[key] != expected[key]
    }
    if mismatches:
        raise ValueError(
            "The demo and benchmark must use the fixed quantum profile. "
            f"Mismatches: {mismatches}"
        )


class PipelineService:
    def __init__(self) -> None:
        self.datasets = DatasetRepository()
        self.store = RunStore()
        self.quantum_backend = HybridQAOABackend()

    def execute_run(self, config: RunConfig) -> RunSummary:
        """Run the public localhost demo with the immutable NVIDIA profile."""

        base = self.datasets.get_dataset(config.dataset_id)
        dataset = apply_scenario_input(base, config.scenario_input)
        fixed_config = config.model_copy(
            deep=True,
            update={
                "run_mode": "hybrid_demo",
                "hybrid_config": build_fixed_hybrid_config(),
            },
        )
        return self.execute_dataset(
            dataset,
            fixed_config,
            scenario_input_applied=config.scenario_input is not None,
            persist=True,
        )

    def execute_dataset(
        self,
        dataset: DatasetModel,
        config: RunConfig,
        *,
        scenario_input_applied: bool = False,
        persist: bool = False,
    ) -> RunSummary:
        """Run Hybrid QAOA on an explicit dataset.

        This method is used by the offline benchmark package. It does not run
        the full classical baseline; benchmark experiments invoke that baseline
        independently so the localhost demo stays Hybrid-only.
        """

        _assert_fixed_profile(config.hybrid_config)
        config = config.model_copy(
            deep=True,
            update={
                "scenario_input": config.scenario_input
                if scenario_input_applied
                else None,
            },
        )

        run_id = str(uuid.uuid4())
        stages: list[StageEvent] = []
        started = time.perf_counter()

        def emit(
            stage: str,
            state: StageState,
            message: str,
            details: dict[str, Any] | None = None,
        ) -> None:
            stages.append(
                StageEvent(
                    stage=stage,
                    state=state,
                    message=message,
                    timestamp=time.time(),
                    details=details or {},
                )
            )
            if config.presentation_mode and config.presentation_delay_ms > 0:
                time.sleep(config.presentation_delay_ms / 1000.0)

        runtime_metrics = build_runtime_input_metrics(config, dataset)
        runtime_metrics["scenario_input_applied"] = scenario_input_applied
        emit(
            PIPELINE_STAGES[0],
            StageState.COMPLETED,
            "Runtime demand, renewable, grid and battery inputs loaded.",
            runtime_metrics,
        )

        lp_started = time.perf_counter()
        relaxed_commitment = compute_relaxed_commitment(dataset)
        initial_incumbent = build_baseline_schedule(dataset, relaxed_commitment)
        incumbent = dict(initial_incumbent)
        lp_runtime_ms = (time.perf_counter() - lp_started) * 1000.0
        emit(
            PIPELINE_STAGES[1],
            StageState.COMPLETED,
            "LP relaxation and heuristic rounding created the hybrid incumbent.",
            {
                "fractional_variables": sum(
                    1
                    for value in relaxed_commitment.values()
                    if 1e-6 < value < 1 - 1e-6
                ),
                "runtime_ms": lp_runtime_ms,
            },
        )

        hybrid = config.hybrid_config
        dual = [0.0 for _ in dataset.hours]
        rho = hybrid.rho_initial
        rounds: list[dict[str, Any]] = []
        last_qubo = None
        hybrid_started = time.perf_counter()
        qaoa_runtime_ms = 0.0
        validation_runtime_ms = 0.0

        accepted_candidate = CandidateBitstring(
            rank=0,
            bitstring="",
            energy=0.0,
            sample_count=1,
            probability=1.0,
            hamming_distance_from_incumbent=0,
            source="initial_incumbent",
        )
        # One strict/relaxed evaluation only. The old pipeline solved both EDs
        # twice before entering the outer loop.
        accepted_candidate, accepted_strict, accepted_relaxed = _evaluate_schedule(
            dataset,
            incumbent,
            accepted_candidate,
        )

        for round_index in range(hybrid.max_quantum_rounds):
            residual_before = list(accepted_relaxed.residual)
            norm_before = accepted_relaxed.residual_l2_mw
            emit(
                PIPELINE_STAGES[2],
                StageState.COMPLETED,
                (
                    f"Round {round_index + 1}: relaxed ED produced "
                    "shortage-minus-surplus residual feedback."
                ),
                {
                    "residual_l2_mw": norm_before,
                    "rho": rho,
                    "dual_l2": math.sqrt(sum(value * value for value in dual)),
                },
            )

            scores = score_candidates(
                dataset,
                relaxed_commitment,
                incumbent,
                accepted_relaxed,
                dual,
                hybrid.score_weights,
            )
            block = select_candidate_block(
                dataset,
                scores,
                hybrid.candidate_generators,
                hybrid.candidate_hours,
                hybrid.qubit_budget,
            )
            emit(
                PIPELINE_STAGES[3],
                StageState.COMPLETED,
                (
                    f"Round {round_index + 1}: selected "
                    f"{len(block.positions)} active commitment variables."
                ),
                {
                    "generators": block.generator_ids,
                    "hours": block.hours,
                    "qubits": len(block.positions),
                },
            )

            qubo = build_dynamic_qubo(
                dataset,
                incumbent,
                block,
                accepted_relaxed,
                residual_before,
                dual,
                rho,
                deviation_weight=hybrid.deviation_weight,
                temporal_weight=hybrid.temporal_weight,
            )
            last_qubo = qubo
            emit(
                PIPELINE_STAGES[4],
                StageState.COMPLETED,
                f"Round {round_index + 1}: ADMM-guided dynamic QUBO constructed.",
                {
                    "dimension": qubo.dimension,
                    "rho": rho,
                    "coefficient_scale": qubo.metadata.get("coefficient_scale"),
                },
            )

            quantum_result = self.quantum_backend.solve(qubo, config)
            qaoa_runtime_ms += float(quantum_result.backend_runtime_ms)
            emit(
                PIPELINE_STAGES[5],
                StageState.COMPLETED,
                f"Round {round_index + 1}: GPU QAOA produced candidate bitstrings.",
                {
                    "source": (
                        quantum_result.candidates[0].source
                        if quantum_result.candidates
                        else None
                    ),
                    "runtime_ms": quantum_result.backend_runtime_ms,
                    "execution_device": quantum_result.raw_payload.get(
                        "execution_device"
                    ),
                },
            )

            validation_started = time.perf_counter()
            evaluated: list[
                tuple[
                    CandidateBitstring,
                    dict[tuple[str, int], int],
                    DispatchResult,
                    DispatchResult,
                ]
            ] = []
            for candidate in quantum_result.candidates:
                schedule = reconstruct_schedule(
                    incumbent,
                    block,
                    candidate.bitstring,
                )
                candidate, strict, relaxed = _evaluate_schedule(
                    dataset,
                    schedule,
                    candidate,
                )
                evaluated.append((candidate, schedule, strict, relaxed))

            incumbent_bits = str(qubo.metadata["incumbent_bitstring"])
            incumbent_entry = next(
                (
                    item
                    for item in evaluated
                    if item[0].bitstring == incumbent_bits
                ),
                None,
            )
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
                keep, strict, relaxed = _evaluate_schedule(
                    dataset,
                    incumbent,
                    keep,
                )
                incumbent_entry = (keep, dict(incumbent), strict, relaxed)
                evaluated.append(incumbent_entry)

            evaluated.sort(key=lambda item: _candidate_key(item[0]))
            winner, winner_schedule, winner_strict, winner_relaxed = evaluated[0]
            previous_key = _candidate_key(incumbent_entry[0])
            accepted = _candidate_key(winner) <= previous_key
            if accepted:
                incumbent = winner_schedule
                accepted_candidate = winner
                accepted_strict = winner_strict
                accepted_relaxed = winner_relaxed
            else:
                (
                    accepted_candidate,
                    _incumbent_schedule,
                    accepted_strict,
                    accepted_relaxed,
                ) = incumbent_entry

            round_validation_ms = (
                time.perf_counter() - validation_started
            ) * 1000.0
            validation_runtime_ms += round_validation_ms
            emit(
                PIPELINE_STAGES[6],
                StageState.COMPLETED,
                (
                    f"Round {round_index + 1}: reconstructed and validated "
                    f"{len(evaluated)} schedules."
                ),
                {
                    "accepted_bitstring": accepted_candidate.bitstring,
                    "feasible_candidates": sum(
                        1 for item in evaluated if item[0].is_feasible
                    ),
                    "accepted": accepted,
                    "validation_runtime_ms": round_validation_ms,
                },
            )

            residual_after = list(accepted_relaxed.residual)
            norm_after = accepted_relaxed.residual_l2_mw
            dual = [
                multiplier + rho * residual
                for multiplier, residual in zip(dual, residual_after)
            ]
            rho_before = rho
            if norm_after > hybrid.residual_progress_ratio * max(norm_before, 1e-9):
                rho = min(hybrid.rho_max, hybrid.rho_growth * rho)
            emit(
                PIPELINE_STAGES[7],
                StageState.COMPLETED,
                f"Round {round_index + 1}: updated dual multiplier and penalty.",
                {
                    "residual_before": norm_before,
                    "residual_after": norm_after,
                    "rho_before": rho_before,
                    "rho_after": rho,
                },
            )

            rounds.append(
                {
                    "round": round_index + 1,
                    "block": block.model_dump(),
                    "scores": [
                        score.model_dump()
                        for score in scores
                        if score.selected
                    ],
                    "qubo": qubo.model_dump(),
                    "backend": quantum_result.model_dump(),
                    "evaluated_candidates": [
                        item[0].model_dump()
                        for item in evaluated
                    ],
                    "accepted_candidate": accepted_candidate.model_dump(),
                    "residual_before_l2_mw": norm_before,
                    "residual_after_l2_mw": norm_after,
                    "dual": list(dual),
                    "rho_before": rho_before,
                    "rho_after": rho,
                    "candidate_validation_runtime_ms": round_validation_ms,
                }
            )

            # Reuse the full feasibility result already computed by
            # _evaluate_schedule; do not repeat the physical checks here.
            if (
                accepted_candidate.is_feasible
                and norm_after <= hybrid.residual_tolerance_mw
            ):
                break

        hybrid_runtime_ms = (
            time.perf_counter() - hybrid_started
        ) * 1000.0 + lp_runtime_ms

        # accepted_strict belongs to the final incumbent. Reusing it removes an
        # unnecessary final LP solve without changing the selected schedule.
        final_dispatch = (
            accepted_strict
            if accepted_strict.feasible
            else accepted_relaxed
        )
        final_backend = rounds[-1]["backend"] if rounds else {}
        raw_payload = final_backend.get("raw_payload", {})

        hybrid_payload = _method_payload(
            dataset,
            incumbent,
            final_dispatch,
            validated_candidate=accepted_candidate,
            runtime_ms=hybrid_runtime_ms,
            extra={
                "initial_schedule": _schedule_rows(dataset, initial_incumbent),
                "fractional_commitment": [
                    {
                        "generator_id": generator.id,
                        "values": [
                            round(
                                relaxed_commitment[(generator.id, hour)],
                                6,
                            )
                            for hour in dataset.hours
                        ],
                    }
                    for generator in dataset.generators
                ],
                "quantum_rounds": rounds,
                "round_count": len(rounds),
                "active_qubits": last_qubo.dimension if last_qubo else 0,
                "selected_candidate": accepted_candidate.model_dump(),
                "dual": dual,
                "rho_final": rho,
                "backend_source": (
                    final_backend.get("candidates", [{}])[0].get("source")
                    if final_backend.get("candidates")
                    else None
                ),
                "execution_device": raw_payload.get("execution_device"),
                "execution_backend": raw_payload.get("execution_backend"),
                "quantum_target": raw_payload.get(
                    "target",
                    hybrid.quantum_target,
                ),
                "qaoa_runtime_ms": round(qaoa_runtime_ms, 3),
                "candidate_validation_runtime_ms": round(
                    validation_runtime_ms,
                    3,
                ),
                "lp_preprocessing_runtime_ms": round(lp_runtime_ms, 3),
                "fixed_quantum_profile": {
                    "qaoa_depth": hybrid.qaoa_depth,
                    "shots": hybrid.shots,
                    "optimizer_shots": hybrid.optimizer_shots,
                    "optimizer_evaluations": hybrid.optimizer_evaluations,
                    "max_quantum_rounds": hybrid.max_quantum_rounds,
                },
            },
        )

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
            PIPELINE_STAGES[8],
            (
                StageState.COMPLETED
                if hybrid_payload["feasible"]
                else StageState.WARNING
            ),
            "Hybrid operating plan reconstructed and validated.",
            {
                "feasible": hybrid_payload["feasible"],
                "runtime_ms": hybrid_runtime_ms,
                "round_count": len(rounds),
            },
        )

        result = {
            "contract_version": "pil-hquc-hybrid-v1",
            "scenario_input_applied": scenario_input_applied,
            "hybrid": hybrid_payload,
            "recommended_plan": hybrid_payload,
            "convergence": convergence,
        }
        metrics = {
            "total_commitment_variables": (
                len(dataset.generators) * len(dataset.hours)
            ),
            "candidate_variables": last_qubo.dimension if last_qubo else 0,
            "reduction_ratio": round(
                (last_qubo.dimension if last_qubo else 0)
                / max(len(dataset.generators) * len(dataset.hours), 1),
                6,
            ),
            "total_runtime_ms": round(
                (time.perf_counter() - started) * 1000.0,
                3,
            ),
            "qaoa_runtime_ms": round(qaoa_runtime_ms, 3),
            "candidate_validation_runtime_ms": round(
                validation_runtime_ms,
                3,
            ),
            **runtime_metrics,
        }
        summary = RunSummary(
            run_id=run_id,
            status=(
                "completed"
                if hybrid_payload["feasible"]
                else "completed_with_warnings"
            ),
            config=config,
            dataset=dataset,
            stages=stages,
            metrics=metrics,
            result=result,
            qubo=last_qubo,
        )
        if persist:
            self.store.save(summary)
        return summary
