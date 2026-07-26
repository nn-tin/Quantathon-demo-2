from __future__ import annotations

from typing import Iterable

from app.services.pipeline import PipelineService
from benchmark.config import METHOD_COMPARISON_QUBITS, SIMBENCH_CASES, SIMBENCH_CODE
from benchmark.data.block_mapping import benchmark_top_k, generator_scaling_block
from benchmark.data.simbench_adapter import build_simbench_uc_dataset
from benchmark.runner import cost_gap_percent, print_case, run_classical_case, run_hybrid_case


def run(
    service: PipelineService,
    *,
    seeds: Iterable[int],
    cases=SIMBENCH_CASES,
    quiet: bool = True,
) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for case in cases:
        dataset, metadata = build_simbench_uc_dataset(
            simbench_code=SIMBENCH_CODE,
            day_index=case.day_index,
            generator_count=case.generator_count,
            case_id=case.case_id,
        )
        classical = run_classical_case(dataset)
        shape = generator_scaling_block(
            case.generator_count,
            METHOD_COMPARISON_QUBITS,
        )
        top_k = benchmark_top_k(case.generator_count)
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
                "experiment": "simbench_method_comparison",
                "case_id": case.case_id,
                "case_description": case.description,
                "simbench_code": metadata.simbench_code,
                "simbench_day_index": metadata.day_index,
                "generator_count": case.generator_count,
                "seed": int(seed),
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
