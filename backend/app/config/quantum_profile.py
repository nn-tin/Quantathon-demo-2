from __future__ import annotations

from dataclasses import dataclass

from app.models.schemas import HybridConfig


@dataclass(frozen=True)
class FixedQuantumProfile:
    """One reproducible QAOA profile shared by the GPU demo and benchmarks."""

    qaoa_depth: int = 1
    shots: int = 256
    optimizer_shots: int = 64
    optimizer_evaluations: int = 6
    max_quantum_rounds: int = 2
    quantum_target: str = "nvidia"
    allow_numpy_fallback: bool = False


FIXED_QUANTUM_PROFILE = FixedQuantumProfile()
DEMO_QUBIT_BUDGET = 10
DEMO_TOP_K = 10
DEMO_CANDIDATE_GENERATORS = 2
DEMO_CANDIDATE_HOURS = 5


def build_fixed_hybrid_config(
    *,
    qubit_budget: int = DEMO_QUBIT_BUDGET,
    candidate_generators: int = DEMO_CANDIDATE_GENERATORS,
    candidate_hours: int = DEMO_CANDIDATE_HOURS,
    top_k: int = DEMO_TOP_K,
    random_seed: int = 7,
) -> HybridConfig:
    """Build a HybridConfig while keeping all QAOA hyperparameters fixed.

    Benchmarks may vary only the active-block shape, qubit budget, top-K and
    random seed. Depth, shots, optimizer budget and maximum outer rounds stay
    identical across the demo and all experiments.
    """

    profile = FIXED_QUANTUM_PROFILE
    return HybridConfig(
        qubit_budget=qubit_budget,
        candidate_generators=candidate_generators,
        candidate_hours=candidate_hours,
        qaoa_depth=profile.qaoa_depth,
        shots=profile.shots,
        optimizer_shots=profile.optimizer_shots,
        optimizer_evaluations=profile.optimizer_evaluations,
        top_k=top_k,
        max_quantum_rounds=profile.max_quantum_rounds,
        random_seed=random_seed,
        quantum_target=profile.quantum_target,
        allow_numpy_fallback=profile.allow_numpy_fallback,
    )
