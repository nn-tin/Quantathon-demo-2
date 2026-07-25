from __future__ import annotations

from app.models.schemas import DatasetModel


def build_baseline_schedule(dataset: DatasetModel, relaxed: dict[tuple[str, int], float]) -> dict[tuple[str, int], int]:
    schedule: dict[tuple[str, int], int] = {}
    merit = sorted(dataset.generators, key=lambda g: (g.variable_cost, g.no_load_cost, g.startup_cost))
    for hour, demand in enumerate(dataset.demand):
        net = max(
            demand
            - dataset.renewable[hour]
            - dataset.grid_import_limit_mw,
            0.0,
        )
        reserve = dataset.reserve[hour]
        target = net + reserve
        committed_capacity = 0.0
        for gen in merit:
            relaxed_value = relaxed[(gen.id, hour)]
            should_commit = 1 if relaxed_value >= 0.5 else 0
            if committed_capacity < target and relaxed_value > 0.15:
                should_commit = 1
            schedule[(gen.id, hour)] = should_commit
            if should_commit:
                committed_capacity += gen.p_max
        if committed_capacity < target:
            for gen in reversed(merit):
                if schedule[(gen.id, hour)] == 0:
                    schedule[(gen.id, hour)] = 1
                    committed_capacity += gen.p_max
                    if committed_capacity >= target:
                        break
    return enforce_min_up_down(dataset, schedule)


def enforce_min_up_down(dataset: DatasetModel, schedule: dict[tuple[str, int], int]) -> dict[tuple[str, int], int]:
    repaired = dict(schedule)
    for gen in dataset.generators:
        up_run = gen.min_up_time if gen.initial_status == 1 else 0
        down_run = gen.min_down_time if gen.initial_status == 0 else 0
        prev = gen.initial_status
        for hour in dataset.hours:
            cur = repaired[(gen.id, hour)]
            if prev == 1 and cur == 0 and up_run < gen.min_up_time:
                repaired[(gen.id, hour)] = 1
                cur = 1
            elif prev == 0 and cur == 1 and down_run < gen.min_down_time:
                repaired[(gen.id, hour)] = 0
                cur = 0
            if cur == 1:
                up_run = up_run + 1 if prev == 1 else 1
                down_run = 0
            else:
                down_run = down_run + 1 if prev == 0 else 1
                up_run = 0
            prev = cur
    return repaired
