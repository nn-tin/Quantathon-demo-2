from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.backends.hybrid_qaoa import HybridQAOABackend
from app.models.schemas import HybridConfig, QUBOProblem, RunConfig


def build_mock_qubo(qubits: int, seed: int) -> QUBOProblem:
    linear: dict[str, float] = {}
    quadratic: dict[str, float] = {}
    variable_order: list[tuple[str, int]] = []

    for i in range(qubits):
        sign = -1.0 if i % 2 == 0 else 1.0
        linear[str(i)] = sign * (0.35 + 0.03 * ((i + seed) % 7))
        variable_order.append((f"MOCK_G{i:02d}", i))

    for i in range(qubits):
        for j in range(i + 1, min(qubits, i + 4)):
            parity = -1.0 if (i + j + seed) % 2 == 0 else 1.0
            strength = 0.05 + 0.01 * ((i * 3 + j + seed) % 5)
            quadratic[f"{i},{j}"] = parity * strength

    return QUBOProblem(
        dimension=qubits,
        offset=0.0,
        linear=linear,
        quadratic=quadratic,
        variable_order=variable_order,
        penalty_weights={"mock": 1.0},
        metadata={"incumbent_bitstring": "0" * qubits, "dataset": "mock_qubo"},
    )


def run_case(
    qubits: int,
    target: str,
    depth: int,
    shots: int,
    optimizer_shots: int,
    optimizer_evaluations: int,
    allow_numpy_fallback: bool,
    seed: int,
) -> dict[str, object]:
    problem = build_mock_qubo(qubits, seed)
    config = RunConfig(
        hybrid_config=HybridConfig(
            qaoa_depth=depth,
            shots=shots,
            optimizer_shots=optimizer_shots,
            optimizer_evaluations=optimizer_evaluations,
            top_k=min(20),
            quantum_target=target,
            allow_numpy_fallback=allow_numpy_fallback,
            random_seed=seed,
        )
    )

    started = time.perf_counter()
    backend = HybridQAOABackend()
    result = backend.solve(problem, config)
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    best = result.candidates[0] if result.candidates else None
    fallback_reason = result.raw_payload.get("fallback_reason")

    return {
        "qubits": qubits,
        "status": result.status,
        "mode": result.mode_label,
        "target": result.raw_payload.get("target", target),
        "source": best.source if best else None,
        "best_bitstring": best.bitstring if best else None,
        "best_energy": best.energy if best else None,
        "backend_runtime_ms": round(result.backend_runtime_ms, 3),
        "wall_runtime_ms": round(elapsed_ms, 3),
        "objective_mode": result.raw_payload.get("objective_mode"),
        "fallback_reason": fallback_reason,
        "notes": result.notes,
    }


def format_result(row: dict[str, object]) -> str:
    gpu_used = str(row["source"]).startswith("qamomile_cudaq_") and row["target"] == "nvidia"
    fallback = "yes" if row["fallback_reason"] else "no"
    return (
        f"{int(row['qubits']):>2} qubits | "
        f"target={row['target']} | "
        f"gpu={'yes' if gpu_used else 'no'} | "
        f"fallback={fallback} | "
        f"source={row['source']} | "
        f"backend_ms={row['backend_runtime_ms']} | "
        f"wall_ms={row['wall_runtime_ms']} | "
        f"best_energy={row['best_energy']}"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run standalone mock QUBO cases through the hybrid Qamomile/CUDA-Q backend."
    )
    parser.add_argument(
        "--target",
        default=os.getenv("CUDAQ_TARGET", "qpp-cpu"),
        help="CUDA-Q target to request, for example 'nvidia' or 'qpp-cpu'.",
    )
    parser.add_argument(
        "--qubits",
        nargs="*",
        type=int,
        default=[5, 10, 20, 40],
        help="Mock QUBO sizes to run.",
    )
    parser.add_argument("--depth", type=int, default=1, help="QAOA depth.")
    parser.add_argument("--shots", type=int, default=256, help="Final sampling shots.")
    parser.add_argument("--optimizer-shots", type=int, default=128, help="Shots per sampled objective fallback.")
    parser.add_argument("--optimizer-evals", type=int, default=8, help="COBYLA evaluation budget.")
    parser.add_argument(
        "--seed",
        type=int,
        default=7,
        help="Base random seed. Each case offsets this by its qubit count.",
    )
    parser.add_argument(
        "--require-cudaq",
        action="store_true",
        help="Fail immediately if Qamomile/CUDA-Q cannot execute instead of falling back to NumPy.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    os.environ.setdefault("CUDAQ_TARGET", args.target)
    if args.require_cudaq:
        os.environ["REQUIRE_CUDAQ"] = "1"

    print("Standalone hybrid backend evaluation")
    print(f"repo_root={ROOT}")
    print(f"backend_root={BACKEND_ROOT}")
    print(f"requested_target={args.target}")
    print(f"qubits={args.qubits}")
    print("")

    failures = 0
    for qubits in args.qubits:
        try:
            row = run_case(
                qubits=qubits,
                target=args.target,
                depth=args.depth,
                shots=args.shots,
                optimizer_shots=args.optimizer_shots,
                optimizer_evaluations=args.optimizer_evals,
                allow_numpy_fallback=not args.require_cudaq,
                seed=args.seed + qubits,
            )
            print(format_result(row))
            if row["fallback_reason"]:
                print(f"  fallback_reason={row['fallback_reason']}")
            if row["objective_mode"]:
                print(f"  objective_mode={row['objective_mode']}")
            notes = row["notes"] or []
            for note in notes:
                print(f"  note={note}")
        except Exception as exc:
            failures += 1
            print(f"{qubits:>2} qubits | ERROR | {type(exc).__name__}: {exc}")

    print("")
    print(f"completed_cases={len(args.qubits) - failures}/{len(args.qubits)}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
