from __future__ import annotations

from typing import Iterable

from app.services.pipeline import PipelineService
from benchmark.config import GENERATOR_COUNTS, GENERATOR_SCALING_QUBITS, GENERATOR_SCALING_SCENARIO
from benchmark.data.block_mapping import benchmark_top_k, generator_scaling_block
from benchmark.data.ieee30_factory import IEEE30_SOURCE_URL, build_ieee30_dataset
from benchmark.runner import (
    cost_gap_percent,
    print_case,
    run_classical_case,
    run_hybrid_case,
    warmup_hybrid_configuration,
)


def run(
    service: PipelineService,
    *,
    seeds: Iterable[int],
    generator_counts: Iterable[int] = GENERATOR_COUNTS,
    qubit_budgets: Iterable[int] = GENERATOR_SCALING_QUBITS,
    quiet: bool = True,
    warmup_records: list[dict[str, object]] | None = None,
) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for generator_count in generator_counts:
        generator_count = int(generator_count)
        dataset = build_ieee30_dataset(
            GENERATOR_SCALING_SCENARIO,
            generator_count=generator_count,
        )
        classical = run_classical_case(dataset)
        top_k = benchmark_top_k(generator_count)

        for qubit_budget in qubit_budgets:
            qubit_budget = int(qubit_budget)
            shape = generator_scaling_block(generator_count, qubit_budget)
            configuration_id = (
                f"ieee30-generator-scaling:{GENERATOR_SCALING_SCENARIO}:"
                f"g{generator_count}:q{qubit_budget}"
            )
            warmup = warmup_hybrid_configuration(
                service,
                dataset,
                qubit_budget=qubit_budget,
                shape=shape,
                top_k=top_k,
                configuration_id=configuration_id,
                quiet=quiet,
            )
            warmup.update({
                "experiment": "ieee30_generator_scaling",
                "case_id": dataset.id,
                "generator_count": generator_count,
            })
            if warmup_records is not None:
                warmup_records.append(warmup)
            print(
                f"warmup_discarded | configuration_id={configuration_id} | "
                f"runtime_ms={warmup['hybrid_runtime_ms']}"
            )

            for seed in seeds:
                hybrid = run_hybrid_case(
                    service,
                    dataset,
                    qubit_budget=qubit_budget,
                    shape=shape,
                    top_k=top_k,
                    seed=int(seed),
                    quiet=quiet,
                )
                record: dict[str, object] = {
                    "experiment": "ieee30_generator_scaling",
                    "case_id": dataset.id,
                    "scenario_id": GENERATOR_SCALING_SCENARIO,
                    "data_family": "replicated MATPOWER case30 copper-plate adaptation",
                    "data_source": IEEE30_SOURCE_URL,
                    "generator_count": generator_count,
                    "seed": int(seed),
                    "configuration_id": configuration_id,
                    "timing_protocol": "first_run_discarded_second_and_later_measured",
                    "warmup_runs_for_configuration": 1,
                    "warmup_included_in_statistics": False,
                    **classical,
                    **hybrid,
                }
                record["cost_gap_percent"] = cost_gap_percent(
                    float(record["hybrid_cost"]),
                    float(record["milp_cost"]),
                )
                record["runtime_ratio_hybrid_over_milp"] = (
                    float(record["hybrid_runtime_ms"])
                    / max(float(record["milp_runtime_ms"]), 1e-9)
                )
                record["classical_reference_reused"] = True
                records.append(record)
                print_case(record)
    return records
