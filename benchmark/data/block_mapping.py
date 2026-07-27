from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class BlockShape:
    candidate_generators: int
    candidate_hours: int
    extra_positions: int = 0

    @property
    def structured_positions(self) -> int:
        return self.candidate_generators * self.candidate_hours

    @property
    def total_positions(self) -> int:
        return self.structured_positions + self.extra_positions


QUBIT_SCALING_BLOCKS: dict[int, BlockShape] = {
    8: BlockShape(4, 2, 0),
    10: BlockShape(5, 2, 0),
    14: BlockShape(7, 2, 0),
    18: BlockShape(6, 3, 0),
    20: BlockShape(5, 4, 0),
    24: BlockShape(8, 3, 0),
    26: BlockShape(8, 3, 2),
}


def benchmark_top_k(generator_count: int, *, shots: int = 256) -> int:
    """Increase validated QAOA candidates with IEEE30-derived fleet size.

    For the supported scaling points this gives Top-K = 10, 20, 30, 40, 50.
    It remains fixed at 10 throughout Benchmark 2 because that benchmark keeps
    the IEEE30-derived ten-generator system unchanged.
    """

    return min(shots, max(10, int(generator_count)))


def qubit_scaling_block(qubit_budget: int) -> BlockShape:
    try:
        shape = QUBIT_SCALING_BLOCKS[qubit_budget]
    except KeyError as exc:
        raise ValueError(
            f"Unsupported qubit-scaling budget {qubit_budget}; "
            f"allowed={sorted(QUBIT_SCALING_BLOCKS)}"
        ) from exc
    if shape.total_positions != qubit_budget:
        raise AssertionError("Qubit mapping does not fill the requested budget.")
    return shape


def generator_scaling_block(
    generator_count: int,
    qubit_budget: int,
) -> BlockShape:
    if qubit_budget not in {10, 20}:
        raise ValueError("Generator scaling supports q=10 and q=20 only.")
    if generator_count < 1:
        raise ValueError("generator_count must be positive")

    preferred_generators = 5 if qubit_budget == 10 else 10
    candidate_generators = min(generator_count, preferred_generators)
    candidate_hours = max(1, qubit_budget // candidate_generators)
    used = candidate_generators * candidate_hours
    return BlockShape(
        candidate_generators=candidate_generators,
        candidate_hours=candidate_hours,
        extra_positions=qubit_budget - used,
    )
