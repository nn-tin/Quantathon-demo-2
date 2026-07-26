from __future__ import annotations

from app.baseline.heuristic import enforce_min_up_down
from app.dispatch.economic_dispatch import solve_economic_dispatch
from app.models.schemas import BaselineBuildResult, DatasetModel


def _rows_from_schedule(dataset: DatasetModel, schedule: dict[tuple[str, int], int]) -> list[dict[str, object]]:
    return [
        {"generator_id": gen.id, "values": [schedule[(gen.id, hour)] for hour in dataset.hours]}
        for gen in dataset.generators
    ]


def _generator_by_id(dataset: DatasetModel, generator_id: str):
    return next(gen for gen in dataset.generators if gen.id == generator_id)


def _commit_generator(schedule: dict[tuple[str, int], int], generator_id: str, hours: list[int]) -> None:
    for hour in hours:
        schedule[(generator_id, hour)] = 1


def _decommit_generator(schedule: dict[tuple[str, int], int], generator_id: str, hours: list[int]) -> None:
    for hour in hours:
        schedule[(generator_id, hour)] = 0


def repair_to_feasible_baseline(
    dataset: DatasetModel,
    initial_schedule: dict[tuple[str, int], int],
    max_iterations: int = 16,
) -> BaselineBuildResult:
    current = enforce_min_up_down(dataset, initial_schedule)
    initial_dispatch = solve_economic_dispatch(dataset, current)
    initial_feasible = initial_dispatch.feasible
    repair_actions: list[str] = []
    before = list(initial_dispatch.violations)
    if initial_feasible:
        return BaselineBuildResult(
            initial_heuristic_commitment=_rows_from_schedule(dataset, current),
            feasible_baseline=_rows_from_schedule(dataset, current),
            initial_baseline_feasible=True,
            baseline_repaired=False,
            repair_actions=[],
            baseline_violations_before=before,
            baseline_violations_after=[],
            initial_dispatch=initial_dispatch,
            feasible_dispatch=initial_dispatch,
        )

    generators_by_flex = sorted(
        dataset.generators,
        key=lambda g: (-g.ramp_up, -g.p_max, g.variable_cost),
    )
    for _ in range(max_iterations):
        dispatch = solve_economic_dispatch(dataset, current)
        if dispatch.feasible:
            break
        changed = False
        for violation in dispatch.structured_violations:
            kind = violation["kind"]
            hour = int(violation["hour"])
            if kind in {"reserve_shortfall", "dispatch_solver_failure"} and hour >= 0:
                for gen in generators_by_flex:
                    if current[(gen.id, hour)] == 0:
                        start_hour = max(0, hour - 1)
                        _commit_generator(current, gen.id, list(range(start_hour, hour + 1)))
                        repair_actions.append(f"Committed {gen.id} around hour {hour} to cover reserve or ramp shortfall.")
                        changed = True
                        break
            elif kind == "minimum_output_exceeds_demand" and hour >= 0:
                committed = [gen for gen in dataset.generators if current[(gen.id, hour)] == 1]
                for gen in sorted(committed, key=lambda g: (g.p_min, g.variable_cost), reverse=True):
                    if hour > 0 and current[(gen.id, hour - 1)] == 1 and gen.min_up_time > 1:
                        continue
                    _decommit_generator(current, gen.id, [hour])
                    repair_actions.append(f"Decommitted {gen.id} at hour {hour} to reduce minimum generation overcommitment.")
                    changed = True
                    break
        current = enforce_min_up_down(dataset, current)
        current = _repair_time_logic(dataset, current, repair_actions)
        if not changed:
            break

    final_dispatch = solve_economic_dispatch(dataset, current)
    after = list(final_dispatch.violations)
    return BaselineBuildResult(
        initial_heuristic_commitment=_rows_from_schedule(dataset, initial_schedule),
        feasible_baseline=_rows_from_schedule(dataset, current) if final_dispatch.feasible else None,
        initial_baseline_feasible=initial_feasible,
        baseline_repaired=final_dispatch.feasible and current != initial_schedule,
        repair_actions=repair_actions,
        baseline_violations_before=before,
        baseline_violations_after=after,
        initial_dispatch=initial_dispatch,
        feasible_dispatch=final_dispatch,
    )


def _repair_time_logic(
    dataset: DatasetModel,
    schedule: dict[tuple[str, int], int],
    repair_actions: list[str],
) -> dict[tuple[str, int], int]:
    repaired = dict(schedule)
    for gen in dataset.generators:
        prev_status = gen.initial_status
        down_run = gen.min_down_time if prev_status == 0 else 0
        up_run = gen.min_up_time if prev_status == 1 else 0
        for hour in dataset.hours:
            status = repaired[(gen.id, hour)]
            if prev_status == 0 and status == 1 and down_run < gen.min_down_time:
                repaired[(gen.id, hour)] = 0
                repair_actions.append(f"Delayed startup of {gen.id} at hour {hour} to satisfy minimum down-time.")
                status = 0
            if prev_status == 1 and status == 0 and up_run < gen.min_up_time:
                repaired[(gen.id, hour)] = 1
                repair_actions.append(f"Kept {gen.id} online at hour {hour} to satisfy minimum up-time.")
                status = 1
            if status == 1:
                up_run = up_run + 1 if prev_status == 1 else 1
                down_run = 0
            else:
                down_run = down_run + 1 if prev_status == 0 else 1
                up_run = 0
            prev_status = status
    return repaired
