from __future__ import annotations

import logging
import math
import os
import time
from collections import Counter
from typing import Any

import numpy as np
from scipy.optimize import minimize

from app.backends.base import OptimizationBackend
from app.models.schemas import (
    BackendKind,
    BackendResult,
    CandidateBitstring,
    QUBOProblem,
    RunConfig,
)
from app.qubo.builder import evaluate_qubo_energy


LOGGER = logging.getLogger(__name__)


def _hamming(a: str, b: str) -> int:
    return sum(left != right for left, right in zip(a, b))


def _select_candidates(
    problem: QUBOProblem,
    counts: dict[str, int],
    top_k: int,
    source: str,
) -> list[CandidateBitstring]:
    incumbent = str(problem.metadata.get("incumbent_bitstring", "0" * problem.dimension))
    counts = {bits: int(count) for bits, count in counts.items() if len(bits) == problem.dimension and count > 0}
    counts.setdefault(incumbent, 1)
    total = max(1, sum(counts.values()))
    by_energy = sorted(counts, key=lambda bits: (evaluate_qubo_energy(problem, bits), -counts[bits]))
    by_frequency = sorted(counts, key=lambda bits: (-counts[bits], evaluate_qubo_energy(problem, bits)))
    chosen: list[str] = []
    energy_quota = max(1, min(top_k, int(math.ceil(0.6 * top_k))))
    for bits in by_energy[:energy_quota] + by_frequency:
        if bits not in chosen: chosen.append(bits)
        if len(chosen) >= top_k: break
    if incumbent not in chosen:
        chosen[-1 if chosen else 0:] = [incumbent]
    chosen = sorted(set(chosen), key=lambda bits: (evaluate_qubo_energy(problem, bits), -counts.get(bits, 0)))[:top_k]
    return [
        CandidateBitstring(
            rank=rank,
            bitstring=bits,
            energy=round(evaluate_qubo_energy(problem, bits), 10),
            sample_count=counts.get(bits, 1),
            probability=counts.get(bits, 1) / total,
            hamming_distance_from_incumbent=_hamming(bits, incumbent),
            source=source,
        )
        for rank, bits in enumerate(chosen, start=1)
    ]


def _apply_mixer(state: np.ndarray, beta: float, n: int) -> np.ndarray:
    c, s = math.cos(beta), -1j * math.sin(beta)
    result = state.copy()
    for qubit in range(n):
        mask = 1 << (n - 1 - qubit)
        for basis in range(2**n):
            if basis & mask: continue
            partner = basis | mask
            a, b = result[basis], result[partner]
            result[basis] = c * a + s * b
            result[partner] = s * a + c * b
    return result


def _numpy_qaoa(
    problem: QUBOProblem,
    config: RunConfig,
) -> tuple[dict[str, int], dict[str, Any]]:
    hybrid = config.hybrid_config
    n, p = problem.dimension, hybrid.qaoa_depth
    LOGGER.warning(
        "QAOA runtime mode=numpy_fallback target=cpu-simulator qubits=%s depth=%s shots=%s optimizer_evals=%s",
        n,
        p,
        hybrid.shots,
        hybrid.optimizer_evaluations,
    )
    states = [format(index, f"0{n}b") for index in range(2**n)]
    energies = np.asarray([evaluate_qubo_energy(problem, bits) for bits in states], dtype=float)
    uniform = np.ones(2**n, dtype=complex) / math.sqrt(2**n)
    trace: list[dict[str, Any]] = []

    def state_for(params: np.ndarray) -> np.ndarray:
        state = uniform.copy()
        gammas, betas = params[:p], params[p:]
        for layer in range(p):
            state *= np.exp(-1j * gammas[layer] * energies)
            state = _apply_mixer(state, float(betas[layer]), n)
        return state

    def objective(params: np.ndarray) -> float:
        probs = np.abs(state_for(params)) ** 2
        value = float(np.dot(probs, energies))
        trace.append({"evaluation": len(trace) + 1, "expectation": value, "parameters": params.tolist()})
        return value

    rng = np.random.default_rng(hybrid.random_seed)
    initial = np.concatenate([
        rng.uniform(0.15, 0.85, size=p),
        rng.uniform(0.10, 0.70, size=p),
    ])
    result = minimize(
        objective,
        initial,
        method="COBYLA",
        options={"maxiter": hybrid.optimizer_evaluations, "rhobeg": 0.35, "tol": 1e-4},
    )
    probabilities = np.abs(state_for(np.asarray(result.x, dtype=float))) ** 2
    sampled = rng.choice(2**n, size=hybrid.shots, p=probabilities / probabilities.sum())
    counts = Counter(states[int(index)] for index in sampled)
    return dict(counts), {
        "optimizer": "COBYLA",
        "optimal_parameters": result.x.tolist(),
        "optimal_expectation": float(result.fun),
        "optimizer_trace": trace,
        "success": bool(result.success),
        "message": str(result.message),
    }


def _extract_qamomile_counts(decoded: Any, dimension: int) -> dict[str, int]:
    counts: dict[str, int] = {}
    samples = getattr(decoded, "samples", None)
    occurrences = getattr(decoded, "num_occurrences", None)
    if samples is not None and occurrences is not None:
        for sample, count in zip(samples, occurrences):
            if isinstance(sample, dict):
                bits = "".join(str(int(sample.get(i, sample.get(str(i), 0)))) for i in range(dimension))
            else:
                bits = "".join(str(int(value)) for value in list(sample)[:dimension])
            counts[bits] = counts.get(bits, 0) + int(count)
        return counts
    if isinstance(decoded, dict):
        for key, value in decoded.items():
            bits = str(key).replace(" ", "")
            if len(bits) == dimension: counts[bits] = int(value)
    return counts


def _qamomile_cudaq(
    problem: QUBOProblem,
    config: RunConfig,
    target: str,
) -> tuple[dict[str, int], dict[str, Any]]:
    """Qamomile QUBO→QAOA conversion followed by CUDA-Q execution.

    Imports are local so the backend remains testable without the optional
    Colab quantum dependencies. The NumPy statevector path is used only when
    the configured environment cannot load or execute Qamomile/CUDA-Q.
    """
    from qamomile.optimization.binary_model import BinaryModel
    from qamomile.optimization.qaoa import QAOAConverter
    from qamomile.cudaq import CudaqTranspiler

    hybrid = config.hybrid_config
    LOGGER.info(
        "QAOA runtime mode=cudaq requested_target=%s qubits=%s depth=%s shots=%s optimizer_evals=%s",
        target,
        problem.dimension,
        hybrid.qaoa_depth,
        hybrid.shots,
        hybrid.optimizer_evaluations,
    )
    qubo: dict[tuple[int, int], float] = {}
    for key, value in problem.linear.items():
        i = int(key); qubo[(i, i)] = float(value)
    for key, value in problem.quadratic.items():
        i, j = (int(part) for part in key.split(",")); qubo[(i, j)] = float(value)

    try:
        binary_model = BinaryModel.from_qubo(qubo, constant=float(problem.offset))
    except TypeError:
        binary_model = BinaryModel.from_qubo(qubo, float(problem.offset))

    converter = QAOAConverter(binary_model)
    # Normalize the spin Hamiltonian before circuit construction so large UC
    # penalty coefficients do not create unnecessarily extreme phase angles.
    if hasattr(converter, "spin_model") and hasattr(converter.spin_model, "normalize_by_abs_max"):
        converter.spin_model = converter.spin_model.normalize_by_abs_max()
    transpiler = CudaqTranspiler()
    executable = converter.transpile(transpiler, p=hybrid.qaoa_depth)
    executor = transpiler.executor(target=target)
    LOGGER.info(
        "QAOA executor initialized backend=cudaq target=%s parameter_count=%s",
        target,
        len(executable.parameter_names),
    )
    trace: list[dict[str, Any]] = []
    p = hybrid.qaoa_depth
    qaoa_circuit = executable.get_first_circuit()
    cost_hamiltonian = converter.get_cost_hamiltonian()
    objective_mode = "cudaq_observe_expectation"

    def parameter_bindings(params: np.ndarray) -> dict[str, list[float]]:
        return {"gammas": params[:p].tolist(), "betas": params[p:].tolist()}

    def flat_cudaq_parameters(params: np.ndarray) -> list[float]:
        # CUDA-Q artifacts use Qamomile's registered first-use order, which is
        # generally interleaved by layer. Never assume [all gamma, all beta].
        named = {f"gammas[{i}]": float(params[i]) for i in range(p)}
        named.update({f"betas[{i}]": float(params[p + i]) for i in range(p)})
        return [named[name] for name in executable.parameter_names]

    def sample_for(params: np.ndarray, shots: int):
        return executable.sample(
            executor,
            shots=shots,
            bindings=parameter_bindings(params),
        ).result()

    def objective(params: np.ndarray) -> float:
        nonlocal objective_mode
        try:
            if qaoa_circuit is None:
                raise RuntimeError("Qamomile produced no CUDA-Q circuit artifact.")
            value = float(
                executor.estimate(
                    qaoa_circuit,
                    cost_hamiltonian,
                    params=flat_cudaq_parameters(params),
                )
            )
        except Exception:
            # Compatibility fallback for CUDA-Q builds where observe/estimate
            # is unavailable. The final candidate generation still samples.
            objective_mode = "sampled_mean_energy_fallback"
            sample_result = sample_for(params, hybrid.optimizer_shots)
            decoded = converter.decode_to_binary_sampleset(sample_result)
            if hasattr(decoded, "energy_mean"):
                value = float(decoded.energy_mean())
            else:
                counts = _extract_qamomile_counts(decoded, problem.dimension)
                total = max(1, sum(counts.values()))
                value = sum(
                    evaluate_qubo_energy(problem, bits) * count
                    for bits, count in counts.items()
                ) / total
        trace.append({"evaluation": len(trace) + 1, "expectation": value, "parameters": params.tolist()})
        return value

    rng = np.random.default_rng(hybrid.random_seed)
    initial = np.concatenate([rng.uniform(0.15, 0.85, p), rng.uniform(0.10, 0.70, p)])
    optimized = minimize(
        objective,
        initial,
        method="COBYLA",
        options={"maxiter": hybrid.optimizer_evaluations, "rhobeg": 0.35, "tol": 1e-4},
    )
    final_result = sample_for(np.asarray(optimized.x, dtype=float), hybrid.shots)
    decoded = converter.decode_to_binary_sampleset(final_result)
    counts = _extract_qamomile_counts(decoded, problem.dimension)
    if not counts:
        # Some versions expose raw CUDA-Q counts on the sample result.
        raw = getattr(final_result, "counts", None) or getattr(final_result, "data", None)
        counts = _extract_qamomile_counts(raw, problem.dimension)
    if not counts:
        raise RuntimeError("Qamomile/CUDA-Q returned no decodable bitstrings.")
    LOGGER.info(
        "QAOA finished backend=cudaq target=%s objective_mode=%s unique_bitstrings=%s success=%s",
        target,
        objective_mode,
        len(counts),
        bool(optimized.success),
    )
    return counts, {
        "optimizer": "COBYLA",
        "optimal_parameters": optimized.x.tolist(),
        "optimal_expectation": float(optimized.fun),
        "optimizer_trace": trace,
        "objective_mode": objective_mode,
        "target": target,
        "success": bool(optimized.success),
        "message": str(optimized.message),
    }


class HybridQAOABackend(OptimizationBackend):
    def solve(self, problem: QUBOProblem, config: RunConfig) -> BackendResult:
        start = time.perf_counter()
        hybrid = config.hybrid_config
        target = hybrid.quantum_target or os.getenv("CUDAQ_TARGET", "qpp-cpu")
        notes: list[str] = []
        source = f"qamomile_cudaq_{target}"
        LOGGER.info(
            "HybridQAOA solve start requested_target=%s qubits=%s top_k=%s allow_numpy_fallback=%s",
            target,
            problem.dimension,
            hybrid.top_k,
            hybrid.allow_numpy_fallback,
        )
        try:
            counts, raw = _qamomile_cudaq(problem, config, target)
        except Exception as exc:
            require_cudaq = os.getenv("REQUIRE_CUDAQ", "0").strip().lower() in {"1", "true", "yes"}
            if require_cudaq or not hybrid.allow_numpy_fallback:
                LOGGER.exception(
                    "HybridQAOA solve failed without fallback requested_target=%s qubits=%s",
                    target,
                    problem.dimension,
                )
                raise
            counts, raw = _numpy_qaoa(problem, config)
            source = "numpy_statevector_qaoa_fallback"
            raw["fallback_reason"] = f"{type(exc).__name__}: {exc}"
            raw["requested_target"] = target
            raw["execution_device"] = "cpu"
            raw["execution_backend"] = "numpy_fallback"
            notes.append(
                "Qamomile/CUDA-Q was unavailable or failed; used the deterministic NumPy statevector QAOA fallback for this run."
            )
            LOGGER.warning(
                "HybridQAOA fallback backend=numpy requested_target=%s qubits=%s reason=%s",
                target,
                problem.dimension,
                raw["fallback_reason"],
            )

        candidates = _select_candidates(problem, counts, hybrid.top_k, source)
        raw.setdefault("target", target)
        raw.setdefault("execution_backend", "cudaq")
        raw.setdefault("execution_device", "gpu" if target == "nvidia" else "cpu")
        LOGGER.info(
            "HybridQAOA solve complete source=%s target=%s execution_device=%s backend_runtime_ms=%.3f candidates=%s",
            source,
            raw.get("target"),
            raw.get("execution_device"),
            (time.perf_counter() - start) * 1000.0,
            len(candidates),
        )
        return BackendResult(
            backend=BackendKind.HYBRID,
            status="completed",
            mode_label="Qamomile → CUDA-Q QAOA",
            best_energy=candidates[0].energy if candidates else None,
            candidates=candidates,
            raw_payload=raw,
            backend_runtime_ms=(time.perf_counter() - start) * 1000.0,
            notes=notes,
        )
