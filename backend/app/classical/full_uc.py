from __future__ import annotations

import time
from dataclasses import dataclass

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.sparse import lil_matrix

from app.dispatch.economic_dispatch import solve_economic_dispatch
from app.models.schemas import DatasetModel, DispatchResult


@dataclass(frozen=True)
class FullUCResult:
    success: bool
    schedule: dict[tuple[str, int], int]
    fractional_commitment: dict[tuple[str, int], float]
    dispatch: DispatchResult
    objective: float
    runtime_ms: float
    mip_gap: float | None
    message: str


class _Index:
    def __init__(self, ng: int, nt: int) -> None:
        self.ng = ng
        self.nt = nt
        self.block = 4 * ng + 5
        self.size = nt * self.block

    def u(self, t: int, g: int) -> int: return t * self.block + g
    def y(self, t: int, g: int) -> int: return t * self.block + self.ng + g
    def z(self, t: int, g: int) -> int: return t * self.block + 2 * self.ng + g
    def p(self, t: int, g: int) -> int: return t * self.block + 3 * self.ng + g
    def renewable(self, t: int) -> int: return t * self.block + 4 * self.ng
    def grid(self, t: int) -> int: return t * self.block + 4 * self.ng + 1
    def charge(self, t: int) -> int: return t * self.block + 4 * self.ng + 2
    def discharge(self, t: int) -> int: return t * self.block + 4 * self.ng + 3
    def soc(self, t: int) -> int: return t * self.block + 4 * self.ng + 4


def _solve_model(
    dataset: DatasetModel,
    *,
    relax_binaries: bool,
    mip_gap: float = 0.001,
    time_limit_seconds: float = 60.0,
) -> tuple[object, _Index, float]:
    start = time.perf_counter()
    gens, hours = dataset.generators, dataset.hours
    ng, nt = len(gens), len(hours)
    idx = _Index(ng, nt)

    c = np.zeros(idx.size, dtype=float)
    lb = np.zeros(idx.size, dtype=float)
    ub = np.full(idx.size, np.inf, dtype=float)
    integrality = np.zeros(idx.size, dtype=int)

    grid_limit = max(0.0, dataset.grid_import_limit_mw)
    cap = max(0.0, dataset.battery_capacity_mwh)
    initial_soc = min(max(0.0, dataset.initial_battery_soc_mwh), cap)
    charge_limit = min(max(0.0, dataset.battery_charge_limit_mw), cap)
    discharge_limit = min(max(0.0, dataset.battery_discharge_limit_mw), cap)
    eta_c = min(max(dataset.battery_charge_efficiency, 1e-6), 1.0)
    eta_d = min(max(dataset.battery_discharge_efficiency, 1e-6), 1.0)

    for t in range(nt):
        for g, gen in enumerate(gens):
            for pos in (idx.u(t, g), idx.y(t, g), idx.z(t, g)):
                ub[pos] = 1.0
                if not relax_binaries:
                    integrality[pos] = 1
            ub[idx.p(t, g)] = gen.p_max
            c[idx.u(t, g)] = gen.no_load_cost
            c[idx.y(t, g)] = gen.startup_cost
            c[idx.z(t, g)] = gen.shutdown_cost
            c[idx.p(t, g)] = gen.variable_cost
        ub[idx.renewable(t)] = max(0.0, dataset.renewable[t])
        ub[idx.grid(t)] = grid_limit
        ub[idx.charge(t)] = charge_limit
        ub[idx.discharge(t)] = discharge_limit
        ub[idx.soc(t)] = cap
        c[idx.grid(t)] = dataset.grid_import_cost_per_mwh
        c[idx.charge(t)] = dataset.battery_throughput_cost_per_mwh
        c[idx.discharge(t)] = dataset.battery_throughput_cost_per_mwh

    rows: list[dict[int, float]] = []
    lower: list[float] = []
    upper: list[float] = []

    def add(coeff: dict[int, float], lo: float = -np.inf, hi: float = np.inf) -> None:
        rows.append(coeff); lower.append(lo); upper.append(hi)

    for t in range(nt):
        # Exact power balance.
        row = {idx.renewable(t): 1.0, idx.grid(t): 1.0,
               idx.charge(t): -1.0, idx.discharge(t): 1.0}
        for g in range(ng): row[idx.p(t, g)] = 1.0
        demand = max(0.0, dataset.demand[t])
        add(row, demand, demand)

        # Battery energy transition.
        row = {idx.soc(t): 1.0, idx.charge(t): -eta_c,
               idx.discharge(t): 1.0 / eta_d}
        if t > 0:
            row[idx.soc(t - 1)] = -1.0
            add(row, 0.0, 0.0)
        else:
            add(row, initial_soc, initial_soc)

        # Capacity adequacy including reserve.
        row = {}
        for g, gen in enumerate(gens): row[idx.u(t, g)] = gen.p_max
        required_thermal = max(
            0.0,
            dataset.demand[t] + dataset.reserve[t]
            - dataset.renewable[t] - grid_limit - discharge_limit,
        )
        add(row, required_thermal, np.inf)

        for g, gen in enumerate(gens):
            # Pmin*u <= p <= Pmax*u.
            add({idx.p(t, g): 1.0, idx.u(t, g): -gen.p_max}, -np.inf, 0.0)
            add({idx.p(t, g): -1.0, idx.u(t, g): gen.p_min}, -np.inf, 0.0)

            # u_t - u_prev = y_t - z_t.
            transition = {idx.u(t, g): 1.0, idx.y(t, g): -1.0, idx.z(t, g): 1.0}
            if t == 0:
                add(transition, gen.initial_status, gen.initial_status)
            else:
                transition[idx.u(t - 1, g)] = -1.0
                add(transition, 0.0, 0.0)

            # Ramping with commitment-aware startup/shutdown allowance.
            if t == 0:
                add(
                    {idx.p(t, g): 1.0, idx.y(t, g): -gen.p_max},
                    -np.inf,
                    gen.initial_output + gen.ramp_up,
                )
                add(
                    {idx.p(t, g): -1.0, idx.z(t, g): -gen.p_max},
                    -np.inf,
                    gen.ramp_down - gen.initial_output,
                )
            else:
                add(
                    {idx.p(t, g): 1.0, idx.p(t - 1, g): -1.0,
                     idx.y(t, g): -gen.p_max},
                    -np.inf,
                    gen.ramp_up,
                )
                add(
                    {idx.p(t - 1, g): 1.0, idx.p(t, g): -1.0,
                     idx.z(t, g): -gen.p_max},
                    -np.inf,
                    gen.ramp_down,
                )

            # Minimum up/down time, truncated at horizon boundary.
            up_end = min(nt, t + max(1, gen.min_up_time))
            row_up = {idx.u(k, g): 1.0 for k in range(t, up_end)}
            row_up[idx.y(t, g)] = -(up_end - t)
            add(row_up, 0.0, np.inf)

            down_end = min(nt, t + max(1, gen.min_down_time))
            row_down = {idx.u(k, g): -1.0 for k in range(t, down_end)}
            row_down[idx.z(t, g)] = -(down_end - t)
            add(row_down, -(down_end - t), np.inf)

    if nt and cap > 0:
        terminal_min = min(initial_soc, 0.10 * cap)
        add({idx.soc(nt - 1): 1.0}, terminal_min, np.inf)

    a = lil_matrix((len(rows), idx.size), dtype=float)
    for r, coefficients in enumerate(rows):
        for col, value in coefficients.items(): a[r, col] = value

    options = {"time_limit": float(time_limit_seconds)}
    if not relax_binaries:
        options["mip_rel_gap"] = float(mip_gap)
    result = milp(
        c=c,
        integrality=integrality,
        bounds=Bounds(lb, ub),
        constraints=LinearConstraint(a.tocsr(), np.asarray(lower), np.asarray(upper)),
        options=options,
    )
    return result, idx, (time.perf_counter() - start) * 1000.0


def solve_lp_relaxation(dataset: DatasetModel) -> dict[tuple[str, int], float]:
    result, idx, _ = _solve_model(
        dataset,
        relax_binaries=True,
        time_limit_seconds=30.0,
    )
    if not bool(result.success) or result.x is None:
        raise RuntimeError(f"LP relaxation failed: {result.message}")
    return {
        (gen.id, hour): float(np.clip(result.x[idx.u(t, g)], 0.0, 1.0))
        for t, hour in enumerate(dataset.hours)
        for g, gen in enumerate(dataset.generators)
    }


def solve_full_uc_highs(
    dataset: DatasetModel,
    *,
    mip_gap: float = 0.001,
    time_limit_seconds: float = 60.0,
) -> FullUCResult:
    result, idx, runtime_ms = _solve_model(
        dataset,
        relax_binaries=False,
        mip_gap=mip_gap,
        time_limit_seconds=time_limit_seconds,
    )
    if not bool(result.success) or result.x is None:
        empty_schedule = {
            (gen.id, hour): int(gen.initial_status)
            for gen in dataset.generators for hour in dataset.hours
        }
        dispatch = solve_economic_dispatch(dataset, empty_schedule)
        return FullUCResult(
            False, empty_schedule, {}, dispatch, float("inf"), runtime_ms,
            None, str(result.message),
        )

    schedule = {
        (gen.id, hour): int(result.x[idx.u(t, g)] >= 0.5)
        for t, hour in enumerate(dataset.hours)
        for g, gen in enumerate(dataset.generators)
    }
    fractional = {
        (gen.id, hour): float(result.x[idx.u(t, g)])
        for t, hour in enumerate(dataset.hours)
        for g, gen in enumerate(dataset.generators)
    }
    dispatch = solve_economic_dispatch(dataset, schedule)
    mip_gap_value = getattr(result, "mip_gap", None)
    return FullUCResult(
        success=bool(result.success and dispatch.feasible),
        schedule=schedule,
        fractional_commitment=fractional,
        dispatch=dispatch.model_copy(update={
            "solver": "scipy.optimize.milp/highs",
            "runtime_ms": runtime_ms,
            "mip_gap": float(mip_gap_value) if mip_gap_value is not None else None,
        }),
        objective=float(result.fun),
        runtime_ms=runtime_ms,
        mip_gap=float(mip_gap_value) if mip_gap_value is not None else None,
        message=str(result.message),
    )
