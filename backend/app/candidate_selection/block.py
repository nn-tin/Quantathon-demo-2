from __future__ import annotations

from collections import defaultdict

from app.models.schemas import CandidateBlock, CandidateScore, DatasetModel


def select_candidate_block(
    dataset: DatasetModel,
    scores: list[CandidateScore],
    candidate_generators: int = 2,
    candidate_hours: int = 5,
    qubit_budget: int = 10,
) -> CandidateBlock:
    """Select a structured rectangle and fill any remaining qubit positions.

    The original implementation could return fewer active positions than the
    requested budget whenever the budget did not factor cleanly into a
    generator-by-hour rectangle. Benchmark points such as q=14 or q=26 now use
    the same structured core plus the highest-scored adjacent positions until
    the requested budget is reached.
    """

    maximum_positions = len(dataset.generators) * len(dataset.hours)
    target_positions = max(1, min(qubit_budget, maximum_positions))
    generator_count = max(1, min(candidate_generators, len(dataset.generators)))
    hour_count = max(1, min(candidate_hours, len(dataset.hours)))

    while generator_count * hour_count > target_positions and hour_count > 1:
        hour_count -= 1
    while generator_count * hour_count > target_positions and generator_count > 1:
        generator_count -= 1

    score_map = {
        (score.generator_id, score.hour): score.final_score
        for score in scores
    }

    best: tuple[list[int], list[str], float] | None = None
    for start in range(0, len(dataset.hours) - hour_count + 1):
        window = dataset.hours[start : start + hour_count]
        per_generator: dict[str, float] = defaultdict(float)
        for score in scores:
            if score.hour in window:
                per_generator[score.generator_id] += score.final_score
        selected_generators = [
            generator_id
            for generator_id, _value in sorted(
                per_generator.items(),
                key=lambda item: item[1],
                reverse=True,
            )[:generator_count]
        ]
        total = sum(
            score_map.get((generator_id, hour), 0.0)
            for generator_id in selected_generators
            for hour in window
        )
        if best is None or total > best[2]:
            best = (list(window), selected_generators, total)

    if best is None:
        raise RuntimeError("Could not select a structured active block.")

    selected_hours, selected_generators, block_score = best
    positions = [
        (generator_id, hour)
        for generator_id in selected_generators
        for hour in selected_hours
    ]

    # Fill a partial row/column with high-score positions near the core. This
    # preserves temporal structure while making actual_active_qubits equal the
    # requested budget for non-rectangular values such as 14 or 26.
    remaining = target_positions - len(positions)
    if remaining > 0:
        position_set = set(positions)
        core_hours = set(selected_hours)
        adjacent_hours = {
            hour
            for core_hour in selected_hours
            for hour in (core_hour - 1, core_hour + 1)
            if hour in dataset.hours
        }

        def priority(score: CandidateScore) -> tuple[int, int, float]:
            same_generator = int(score.generator_id in selected_generators)
            near_core = int(score.hour in core_hours or score.hour in adjacent_hours)
            return (near_core, same_generator, score.final_score)

        extras = sorted(scores, key=priority, reverse=True)
        for score in extras:
            position = (score.generator_id, score.hour)
            if position in position_set:
                continue
            positions.append(position)
            position_set.add(position)
            remaining -= 1
            if remaining == 0:
                break

    if len(positions) != target_positions:
        raise RuntimeError(
            f"Requested {target_positions} active positions but selected "
            f"{len(positions)}."
        )

    all_generators = list(dict.fromkeys(generator_id for generator_id, _ in positions))
    all_hours = sorted({hour for _, hour in positions})
    position_set = set(positions)
    for score in scores:
        score.selected = (score.generator_id, score.hour) in position_set

    return CandidateBlock(
        generator_ids=all_generators,
        hours=all_hours,
        positions=positions,
        rationale=(
            f"Structured {len(selected_generators)}x{len(selected_hours)} core "
            f"with {len(positions) - len(selected_generators) * len(selected_hours)} "
            f"adjacent high-score positions under the {qubit_budget}-qubit limit."
        ),
        block_score=round(
            sum(score_map.get(position, 0.0) for position in positions),
            8,
        ),
    )
