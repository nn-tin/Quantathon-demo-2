from __future__ import annotations

from dataclasses import dataclass

from app.config.quantum_profile import FIXED_QUANTUM_PROFILE


QUBIT_BUDGETS = [8, 10, 14, 18, 20, 24, 26]
GENERATOR_COUNTS = [4, 6, 8, 10, 12, 16, 20]
GENERATOR_SCALING_QUBITS = [10, 20]
QUANTUM_SEEDS = [11, 23, 37]

METHOD_COMPARISON_QUBITS = 10
SIMBENCH_CODE = "1-MVLV-urban-all-0-sw"


@dataclass(frozen=True)
class SimBenchCase:
    case_id: str
    day_index: int
    generator_count: int
    description: str


# Five 24-hour windows from the official SimBench annual profiles. The network
# code is the documented example from the SimBench API; only demand and
# renewable time-series shapes are aggregated into the prototype single-bus UC.
SIMBENCH_CASES = [
    SimBenchCase("winter-weekday", 15, 6, "Winter SimBench profile window"),
    SimBenchCase("spring-transition", 75, 8, "Spring SimBench profile window"),
    SimBenchCase("summer-renewable", 165, 10, "Summer SimBench profile window"),
    SimBenchCase("autumn-peak", 255, 12, "Autumn SimBench profile window"),
    SimBenchCase("winter-evening", 330, 16, "Late-year SimBench profile window"),
]

CLASSICAL_MIP_GAP = 0.001
CLASSICAL_TIME_LIMIT_SECONDS = 60.0
WARMUP_QUBITS = 8

FIXED_PROFILE = FIXED_QUANTUM_PROFILE
