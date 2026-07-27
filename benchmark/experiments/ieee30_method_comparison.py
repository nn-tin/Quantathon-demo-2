from __future__ import annotations

from typing import Iterable

from app.services.pipeline import PipelineService
from benchmark.config import IEEE30_CASES, METHOD_COMPARISON_QUBITS
from benchmark.data.block_mapping import benchmark_top_k, generator_scaling_block
from benchmark.data.ieee30_factory import IEEE30_BASE_GENERATOR_COUNT, IEEE30_SOURCE_URL, build_ieee30_dataset
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
    cases=IEEE30_CASES,
    quiet: bool = True,
    warmup_records: list[dict[str, object]] | None = None,
) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    generator_count = IEEE30_BASE_GENERATOR_COUNT
    shape = generator_scaling_block(generator_count, METHOD_COMPARISON_QUBITS)
    top_k = benchmark_top_k(generator_count)

    for case in cases:
        dataset = build_ieee30_dataset(case.case_id, generator_count=generator_count)
        classical = run_classical_case(dataset)
        configuration_id = f"ieee30:{case.case_id}:g{generator_count}:q{METHOD_COMPARISON_QUBITS}"
        warmup = warmup_hybrid_configuration(
            service,
            dataset,
            qubit_budget=METHOD_COMPARISON_QUBITS,
            shape=shape,
            top_k=top_k,
            configuration_id=configuration_id,
            quiet=quiet,
        )
        warmup.update({
            "experiment": "ieee30_method_comparison",
            "case_id": case.case_id,
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
                qubit_budget=METHOD_COMPARISON_QUBITS,
                shape=shape,
                top_k=top_k,
                seed=int(seed),
                quiet=quiet,
            )
            record: dict[str, object] = {
                "experiment": "ieee30_method_comparison",
                "case_id": case.case_id,
                "case_description": case.description,
                "data_family": "MATPOWER case30 copper-plate adaptation",
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
            records.append(record)
            print_case(record)
    return records
