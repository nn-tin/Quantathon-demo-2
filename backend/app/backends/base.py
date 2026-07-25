from __future__ import annotations

from abc import ABC, abstractmethod

from app.models.schemas import BackendResult, QUBOProblem, RunConfig


class OptimizationBackend(ABC):
    @abstractmethod
    def solve(self, problem: QUBOProblem, config: RunConfig) -> BackendResult:
        raise NotImplementedError

