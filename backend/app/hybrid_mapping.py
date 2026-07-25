from __future__ import annotations

import csv
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


@dataclass(frozen=True)
class HybridMappingRow:
    total_generators: int
    qubit_budget: int
    candidate_generators: int
    candidate_hours: int
    qubits_used: int
    top_k: int


def _default_mapping_path() -> Path:
    return Path(__file__).resolve().parents[2] / "evaluate" / "test-gpu" / "generator-qubit-candidate-mapping.csv"


@lru_cache(maxsize=1)
def load_hybrid_mapping_rows() -> tuple[HybridMappingRow, ...]:
    path = _default_mapping_path()
    if not path.exists():
        return ()
    with path.open("r", newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        return tuple(
            HybridMappingRow(
                total_generators=int(row["total_generators"]),
                qubit_budget=int(row["qubit_budget"]),
                candidate_generators=int(row["candidate_generators"]),
                candidate_hours=int(row["candidate_hours"]),
                qubits_used=int(row["qubits_used"]),
                top_k=int(row["top_k"]),
            )
            for row in reader
        )


def resolve_hybrid_mapping(total_generators: int, qubit_budget: int) -> HybridMappingRow | None:
    for row in load_hybrid_mapping_rows():
        if row.total_generators == total_generators and row.qubit_budget == qubit_budget:
            return row
    return None
