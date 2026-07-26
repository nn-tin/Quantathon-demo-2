from __future__ import annotations

from app.models.schemas import CandidateBlock


def reconstruct_schedule(
    incumbent: dict[tuple[str, int], int],
    block: CandidateBlock,
    bitstring: str,
) -> dict[tuple[str, int], int]:
    """Insert absolute active-block commitment values into the 24-hour schedule."""
    if len(bitstring) != len(block.positions):
        raise ValueError("Bitstring length does not match active block.")
    schedule = dict(incumbent)
    for bit, position in zip(bitstring, block.positions):
        schedule[position] = 1 if bit == "1" else 0
    return schedule
