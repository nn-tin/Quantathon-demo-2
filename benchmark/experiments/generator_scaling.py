from __future__ import annotations

from typing import Iterable

from app.services.pipeline import PipelineService
from benchmark.config import GENERATOR_COUNTS, GENERATOR_SCALING_QUBITS
from benchmark.data.block_mapping import benchmark_top_k, generator_scaling_block
from benchmark.data.synthetic_factory import build_synthetic_dataset
from benchmark.runner import cost_gap_percent, print_case, run_classical_case, run_hybrid_case


def run(
    service: PipelineService,
    *,
    seeds: Iterable[int],
    generator_counts: Iterable[int] = GENERATOR_COUNTS,
    qubit_budgets: Iterable[int] = GENERATOR_SCALING_QUBITS,
    quiet: bool = True,
) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for generator_count in generator_counts:
        dataset = build_synthetic_dataset(
            int(generator_count),
            scenario_id="generator_scaling",
            profile_seed=29,
        )
        classical = run_classical_case(dataset)
        top_k = benchmark_top_k(int(generator_count))
        for qubit_budget in qubit_budgets:
            shape = generator_scaling_block(
                int(generator_count),
                int(qubit_budget),
            )
            for seed in seeds:
                hybrid = run_hybrid_case(
                    service,
                    dataset,
                    qubit_budget=int(qubit_budget),
                    shape=shape,
                    top_k=top_k,
                    seed=int(seed),
                    quiet=quiet,
                )
                record: dict[str, object] = {
                    "experiment": "generator_scaling",
                    "case_id": dataset.id,
                    "generator_count": int(generator_count),
                    "seed": int(seed),
                    **classical,
                    **hybrid,
                }
                record["cost_gap_percent"] = cost_gap_percent(
                    float(record["hybrid_cost"]),
                    float(record["milp_cost"]),
                )
                records.append(record)
                print_case(record)
    return records
