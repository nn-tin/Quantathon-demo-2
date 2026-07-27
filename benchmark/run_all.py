from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
for path in (ROOT, BACKEND):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from app.services.pipeline import PipelineService
from benchmark.config import (
    GENERATOR_COUNTS,
    GENERATOR_SCALING_QUBITS,
    IEEE30_CASES,
    QUANTUM_SEEDS,
    QUBIT_BUDGETS,
)
from benchmark.experiments import generator_scaling, ieee30_method_comparison, qubit_budget_scaling
from benchmark.report.build_report import build_report
from benchmark.runner import ensure_gpu_environment, environment_metadata, write_metadata, write_records


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the IEEE30-based PiL-HQUC benchmark suite.")
    parser.add_argument(
        "--experiments",
        nargs="+",
        choices=["ieee30", "qubits", "generators", "all"],
        default=["all"],
    )
    parser.add_argument(
        "--quick",
        action="store_true",
        help="Use one seed and fewer IEEE30 cases/scale points; solver hyperparameters remain fixed.",
    )
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    selected = {"ieee30", "qubits", "generators"} if "all" in args.experiments else set(args.experiments)
    ensure_gpu_environment()

    results_root = ROOT / "benchmark" / "results"
    raw_dir = results_root / "raw"
    summary_dir = results_root / "summary"
    figures_dir = results_root / "figures"
    for directory in (raw_dir, summary_dir, figures_dir):
        if directory.exists():
            shutil.rmtree(directory)
        directory.mkdir(parents=True, exist_ok=True)

    metadata = environment_metadata()
    metadata.update({
        "benchmark_data_family": "MATPOWER case30 copper-plate UC adaptation",
        "quick_protocol_check": bool(args.quick),
        "selected_experiments": sorted(selected),
        "timing_protocol": "first_run_discarded_second_and_later_measured",
        "warmup_runs_per_unique_quantum_configuration": 1,
        "warmup_included_in_statistics": False,
    })
    write_metadata(metadata, raw_dir)

    seeds = QUANTUM_SEEDS[:1] if args.quick else QUANTUM_SEEDS
    ieee30_cases = IEEE30_CASES[:2] if args.quick else IEEE30_CASES
    qubits = [8, 14, 20] if args.quick else QUBIT_BUDGETS
    generator_counts = [10, 30, 50] if args.quick else GENERATOR_COUNTS
    generator_qubits = GENERATOR_SCALING_QUBITS

    service = PipelineService()
    warmup_records: list[dict[str, object]] = []

    if "ieee30" in selected:
        records = ieee30_method_comparison.run(
            service,
            seeds=seeds,
            cases=ieee30_cases,
            quiet=not args.verbose,
            warmup_records=warmup_records,
        )
        write_records(records, raw_dir / "ieee30_method_comparison")

    if "qubits" in selected:
        records = qubit_budget_scaling.run(
            service,
            seeds=seeds,
            qubit_budgets=qubits,
            quiet=not args.verbose,
            warmup_records=warmup_records,
        )
        write_records(records, raw_dir / "ieee30_qubit_budget_scaling")

    if "generators" in selected:
        records = generator_scaling.run(
            service,
            seeds=seeds,
            generator_counts=generator_counts,
            qubit_budgets=generator_qubits,
            quiet=not args.verbose,
            warmup_records=warmup_records,
        )
        write_records(records, raw_dir / "ieee30_generator_scaling")

    write_records(warmup_records, raw_dir / "discarded_quantum_warmups")
    metadata["discarded_warmup_configuration_count"] = len(warmup_records)
    write_metadata(metadata, raw_dir)
    print(
        f"\nDiscarded {len(warmup_records)} first-run quantum warm-ups; "
        "only subsequent runs are summarized."
    )

    report = build_report(ROOT)
    print(f"\nBenchmark report: {report}")


if __name__ == "__main__":
    main()
