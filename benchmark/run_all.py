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
    QUANTUM_SEEDS,
    QUBIT_BUDGETS,
    SIMBENCH_CASES,
)
from benchmark.data.block_mapping import qubit_scaling_block
from benchmark.data.synthetic_factory import build_synthetic_dataset
from benchmark.experiments import generator_scaling, qubit_budget_scaling, simbench_method_comparison
from benchmark.report.build_report import build_report
from benchmark.runner import (
    ensure_gpu_environment,
    environment_metadata,
    warmup_gpu,
    write_metadata,
    write_records,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the separated PiL-HQUC benchmark suite.")
    parser.add_argument(
        "--experiments",
        nargs="+",
        choices=["simbench", "qubits", "generators", "all"],
        default=["all"],
    )
    parser.add_argument(
        "--quick",
        action="store_true",
        help="Use one seed and a reduced number of data points; solver hyperparameters remain fixed.",
    )
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    selected = {"simbench", "qubits", "generators"} if "all" in args.experiments else set(args.experiments)
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
        "quick_protocol_check": bool(args.quick),
        "selected_experiments": sorted(selected),
    })
    write_metadata(metadata, raw_dir)

    seeds = QUANTUM_SEEDS[:1] if args.quick else QUANTUM_SEEDS
    simbench_cases = SIMBENCH_CASES[:2] if args.quick else SIMBENCH_CASES
    qubits = [8, 14, 20] if args.quick else QUBIT_BUDGETS
    generator_counts = [4, 10, 20] if args.quick else GENERATOR_COUNTS
    generator_qubits = GENERATOR_SCALING_QUBITS

    service = PipelineService()
    warmup_dataset = build_synthetic_dataset(10, scenario_id="warmup", profile_seed=3)
    warmup_gpu(service, warmup_dataset, qubit_scaling_block(8))
    print("GPU warm-up complete and excluded from benchmark records.\n")

    if "simbench" in selected:
        records = simbench_method_comparison.run(
            service,
            seeds=seeds,
            cases=simbench_cases,
            quiet=not args.verbose,
        )
        write_records(records, raw_dir / "simbench_method_comparison")

    if "qubits" in selected:
        records = qubit_budget_scaling.run(
            service,
            seeds=seeds,
            qubit_budgets=qubits,
            quiet=not args.verbose,
        )
        write_records(records, raw_dir / "qubit_budget_scaling")

    if "generators" in selected:
        records = generator_scaling.run(
            service,
            seeds=seeds,
            generator_counts=generator_counts,
            qubit_budgets=generator_qubits,
            quiet=not args.verbose,
        )
        write_records(records, raw_dir / "generator_scaling")

    report = build_report(ROOT)
    print(f"\nBenchmark report: {report}")


if __name__ == "__main__":
    main()
