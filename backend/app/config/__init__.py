"""Application-wide immutable solver profiles."""

from app.config.quantum_profile import (
    DEMO_QUBIT_BUDGET,
    DEMO_TOP_K,
    FIXED_QUANTUM_PROFILE,
    FixedQuantumProfile,
    build_fixed_hybrid_config,
)

__all__ = [
    "DEMO_QUBIT_BUDGET",
    "DEMO_TOP_K",
    "FIXED_QUANTUM_PROFILE",
    "FixedQuantumProfile",
    "build_fixed_hybrid_config",
]
