from __future__ import annotations

from typing import Iterable

from app.services.pipeline import PipelineService
from benchmark.config import QUBIT_BUDGETS
from benchmark.data.block_mapping import benchmark_top_k, qubit_scaling_block
from benchmark.data.synthetic_factory import build_synthetic_dataset
from benchmark.runner import cost_gap_percent, print_case, run_classical_case, run_hybrid_case


def run(
    service: PipelineService,
    *,
    seeds: Iterable[int],
    qubit_budgets: Iterable[int] = QUBIT_BUDGETS,
    quiet: bool = True,
) -> list[dict[str, object]]:
    dataset = build_synthetic_dataset(
        10,
        scenario_id="qubit_scaling",
        profile_seed=17,
    )
    classical = run_classical_case(dataset)
    top_k = benchmark_top_k(10)
    records: list[dict[str, object]] = []
    for qubit_budget in qubit_budgets:
        shape = qubit_scaling_block(int(qubit_budget))
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
                "experiment": "qubit_budget_scaling",
                "case_id": dataset.id,
                "generator_count": 10,
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
