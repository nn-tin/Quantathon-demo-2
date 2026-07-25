from __future__ import annotations

from app.classical.full_uc import solve_lp_relaxation
from app.models.schemas import DatasetModel


def compute_relaxed_commitment(dataset: DatasetModel) -> dict[tuple[str, int], float]:
    """Solve the continuous relaxation of the full 24-hour UC model."""
    return solve_lp_relaxation(dataset)
