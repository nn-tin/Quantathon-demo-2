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
    generator_count = max(1, min(candidate_generators, len(dataset.generators)))
    hour_count = max(1, min(candidate_hours, len(dataset.hours)))
    if generator_count * hour_count > qubit_budget:
        hour_count = max(1, qubit_budget // generator_count)
    if generator_count * hour_count > qubit_budget:
        generator_count = max(1, min(generator_count, qubit_budget))

    score_map = {(score.generator_id, score.hour): score.final_score for score in scores}

    best: tuple[list[int], list[str], float] | None = None
    for start in range(0, len(dataset.hours) - hour_count + 1):
        window = dataset.hours[start:start + hour_count]
        per_gen: dict[str, float] = defaultdict(float)
        for score in scores:
            if score.hour in window:
                per_gen[score.generator_id] += score.final_score
        selected_generators = [
            generator_id
            for generator_id, _value in sorted(
                per_gen.items(),
                key=lambda item: item[1],
                reverse=True,
            )[:generator_count]
        ]
        total = sum(score_map[(generator_id, hour)] for generator_id in selected_generators for hour in window)
        if best is None or total > best[2]:
            best = (list(window), selected_generators, total)

    if best is None:
        raise RuntimeError("Could not select a structured active block.")

    selected_hours, selected_generators, block_score = best
    positions = [(generator_id, hour) for generator_id in selected_generators for hour in selected_hours]
    if len(positions) > qubit_budget:
        trimmed_hours = max(1, qubit_budget // max(1, len(selected_generators)))
        selected_hours = selected_hours[:trimmed_hours]
        positions = [(generator_id, hour) for generator_id in selected_generators for hour in selected_hours]

    for score in scores:
        score.selected = (score.generator_id, score.hour) in positions

    return CandidateBlock(
        generator_ids=selected_generators,
        hours=selected_hours,
        positions=positions,
        rationale=(
            f"Structured {len(selected_generators)}x{len(selected_hours)} active block "
            f"covering hours {selected_hours[0]}-{selected_hours[-1]} under the {qubit_budget}-qubit limit."
        ),
        block_score=round(block_score, 8),
    )
