from __future__ import annotations

from scipy.optimize import linprog

from app.models.schemas import DatasetModel, DispatchResult


_EPS = 1e-6


def _profile_value(values: list[float], index: int, fallback: float = 0.0) -> float:
    if index < len(values):
        return max(0.0, float(values[index]))
    return max(0.0, float(fallback))


def solve_economic_dispatch(
    dataset: DatasetModel,
    schedule: dict[tuple[str, int], int],
) -> DispatchResult:
    """Solve the 24-hour dispatch for a fixed commitment schedule.

    The LP consumes the runtime inputs written by ``apply_scenario_input``:
    renewable availability, grid limit, battery energy and battery capacity.
    Renewable power may be curtailed, so high-renewable profiles do not make
    the model infeasible merely because committed units have minimum output.
    """

    generators = dataset.generators
    hours = dataset.hours
    num_g = len(generators)
    num_t = len(hours)

    # Variables for every hour:
    #   generator outputs (num_g)
    #   renewable_used, grid_import, battery_charge,
    #   battery_discharge, battery_soc
    block_size = num_g + 5
    total_variables = num_t * block_size

    def gen_index(t_idx: int, g_idx: int) -> int:
        return t_idx * block_size + g_idx

    def renewable_index(t_idx: int) -> int:
        return t_idx * block_size + num_g

    def grid_index(t_idx: int) -> int:
        return t_idx * block_size + num_g + 1

    def charge_index(t_idx: int) -> int:
        return t_idx * block_size + num_g + 2

    def discharge_index(t_idx: int) -> int:
        return t_idx * block_size + num_g + 3

    def soc_index(t_idx: int) -> int:
        return t_idx * block_size + num_g + 4

    grid_limit = max(0.0, float(dataset.grid_import_limit_mw))
    battery_capacity = max(0.0, float(dataset.battery_capacity_mwh))
    initial_soc = min(
        max(0.0, float(dataset.initial_battery_soc_mwh)),
        battery_capacity,
    )
    charge_limit = min(
        max(0.0, float(dataset.battery_charge_limit_mw)),
        battery_capacity,
    )
    discharge_limit = min(
        max(0.0, float(dataset.battery_discharge_limit_mw)),
        battery_capacity,
    )
    eta_charge = min(max(float(dataset.battery_charge_efficiency), 1e-6), 1.0)
    eta_discharge = min(max(float(dataset.battery_discharge_efficiency), 1e-6), 1.0)
    grid_cost = max(0.0, float(dataset.grid_import_cost_per_mwh))
    battery_cost = max(0.0, float(dataset.battery_throughput_cost_per_mwh))

    violations: list[str] = []
    structured: list[dict[str, object]] = []

    def add_violation(
        kind: str,
        hour: int,
        message: str,
        generator_id: str | None = None,
        **extra: object,
    ) -> None:
        if message in violations:
            return
        violations.append(message)
        row: dict[str, object] = {
            "kind": kind,
            "hour": hour,
            "message": message,
        }
        if generator_id is not None:
            row["generator_id"] = generator_id
        row.update(extra)
        structured.append(row)

    # Fast, interpretable checks before calling HiGHS.
    for t_idx, hour in enumerate(hours):
        demand = max(0.0, float(dataset.demand[t_idx]))
        renewable_available = max(0.0, float(dataset.renewable[t_idx]))
        reserve_requirement = max(0.0, float(dataset.reserve[t_idx]))
        committed = [
            gen for gen in generators if int(schedule.get((gen.id, hour), 0)) == 1
        ]
        min_thermal = sum(gen.p_min for gen in committed)
        max_thermal = sum(gen.p_max for gen in committed)

        # Renewable and grid can always be reduced to zero. Excess minimum
        # thermal output can only be absorbed by battery charging.
        if min_thermal > demand + charge_limit + _EPS:
            add_violation(
                "minimum_output_exceeds_demand",
                hour,
                f"Hour {hour}: committed minimum output exceeds demand plus battery charging capability.",
                minimum_generation=min_thermal,
                demand=demand,
                battery_charge_limit=charge_limit,
            )

        maximum_supply = (
            max_thermal
            + renewable_available
            + grid_limit
            + discharge_limit
        )
        if maximum_supply < demand + reserve_requirement - _EPS:
            add_violation(
                "reserve_shortfall",
                hour,
                f"Hour {hour}: insufficient thermal, renewable, grid and battery capacity.",
                committed_capacity=max_thermal,
                renewable_available=renewable_available,
                grid_limit=grid_limit,
                battery_discharge_limit=discharge_limit,
                required_capacity=demand + reserve_requirement,
            )

    objective = [0.0] * total_variables
    bounds: list[tuple[float, float]] = [(0.0, 0.0)] * total_variables

    for t_idx, hour in enumerate(hours):
        for g_idx, gen in enumerate(generators):
            idx = gen_index(t_idx, g_idx)
            objective[idx] = float(gen.variable_cost)
            if int(schedule.get((gen.id, hour), 0)) == 1:
                bounds[idx] = (float(gen.p_min), float(gen.p_max))
            else:
                bounds[idx] = (0.0, 0.0)

        renewable_available = max(0.0, float(dataset.renewable[t_idx]))
        objective[renewable_index(t_idx)] = 0.0
        bounds[renewable_index(t_idx)] = (0.0, renewable_available)

        objective[grid_index(t_idx)] = grid_cost
        bounds[grid_index(t_idx)] = (0.0, grid_limit)

        objective[charge_index(t_idx)] = battery_cost
        objective[discharge_index(t_idx)] = battery_cost
        bounds[charge_index(t_idx)] = (0.0, charge_limit)
        bounds[discharge_index(t_idx)] = (0.0, discharge_limit)
        bounds[soc_index(t_idx)] = (0.0, battery_capacity)

    a_eq: list[list[float]] = []
    b_eq: list[float] = []

    # Hourly power balance.
    for t_idx, _hour in enumerate(hours):
        row = [0.0] * total_variables
        for g_idx in range(num_g):
            row[gen_index(t_idx, g_idx)] = 1.0
        row[renewable_index(t_idx)] = 1.0
        row[grid_index(t_idx)] = 1.0
        row[charge_index(t_idx)] = -1.0
        row[discharge_index(t_idx)] = 1.0
        a_eq.append(row)
        b_eq.append(max(0.0, float(dataset.demand[t_idx])))

    # Battery state transition.
    for t_idx, _hour in enumerate(hours):
        row = [0.0] * total_variables
        row[soc_index(t_idx)] = 1.0
        row[charge_index(t_idx)] = -eta_charge
        row[discharge_index(t_idx)] = 1.0 / eta_discharge
        if t_idx == 0:
            rhs = initial_soc
        else:
            row[soc_index(t_idx - 1)] = -1.0
            rhs = 0.0
        a_eq.append(row)
        b_eq.append(rhs)

    a_ub: list[list[float]] = []
    b_ub: list[float] = []

    # Normal ramp limits apply only while a generator stays online. Start-up
    # and shutdown transitions are intentionally not treated as normal ramps.
    for t_idx, hour in enumerate(hours):
        for g_idx, gen in enumerate(generators):
            current_on = int(schedule.get((gen.id, hour), 0)) == 1
            previous_on = (
                int(gen.initial_status) == 1
                if t_idx == 0
                else int(schedule.get((gen.id, hours[t_idx - 1]), 0)) == 1
            )
            if not (previous_on and current_on):
                continue

            row_up = [0.0] * total_variables
            row_down = [0.0] * total_variables
            row_up[gen_index(t_idx, g_idx)] = 1.0
            row_down[gen_index(t_idx, g_idx)] = -1.0

            if t_idx == 0:
                b_up = float(gen.ramp_up) + float(gen.initial_output)
                b_down = float(gen.ramp_down) - float(gen.initial_output)
            else:
                previous_idx = gen_index(t_idx - 1, g_idx)
                row_up[previous_idx] = -1.0
                row_down[previous_idx] = 1.0
                b_up = float(gen.ramp_up)
                b_down = float(gen.ramp_down)

            a_ub.extend([row_up, row_down])
            b_ub.extend([b_up, b_down])

    # Spinning-capacity proxy. Available thermal, grid and battery headroom
    # after dispatch must cover the reserve requirement.
    for t_idx, hour in enumerate(hours):
        committed_capacity = sum(
            gen.p_max
            for gen in generators
            if int(schedule.get((gen.id, hour), 0)) == 1
        )
        reserve_requirement = max(0.0, float(dataset.reserve[t_idx]))
        row = [0.0] * total_variables
        for g_idx in range(num_g):
            row[gen_index(t_idx, g_idx)] = 1.0
        row[grid_index(t_idx)] = 1.0
        row[discharge_index(t_idx)] = 1.0
        a_ub.append(row)
        b_ub.append(
            committed_capacity
            + grid_limit
            + discharge_limit
            - reserve_requirement
        )

    # Permit use of the initial battery energy, but avoid ending the day with a
    # completely empty battery whenever one was available at the beginning.
    if num_t > 0 and battery_capacity > 0:
        terminal_min_soc = min(initial_soc, 0.10 * battery_capacity)
        row = [0.0] * total_variables
        row[soc_index(num_t - 1)] = -1.0
        a_ub.append(row)
        b_ub.append(-terminal_min_soc)

    result = linprog(
        c=objective,
        A_ub=a_ub or None,
        b_ub=b_ub or None,
        A_eq=a_eq,
        b_eq=b_eq,
        bounds=bounds,
        method="highs",
    )

    hourly_dispatch: list[dict[str, object]] = []
    total_variable = 0.0
    total_grid_cost = 0.0
    total_battery_cost = 0.0
    total_grid_mwh = 0.0
    total_charge_mwh = 0.0
    total_discharge_mwh = 0.0
    total_curtailment_mwh = 0.0

    if result.success:
        solution = result.x
        for t_idx, hour in enumerate(hours):
            demand = max(0.0, float(dataset.demand[t_idx]))
            renewable_available = max(0.0, float(dataset.renewable[t_idx]))
            solar_available = _profile_value(
                dataset.solar_available,
                t_idx,
                renewable_available,
            )
            wind_available = _profile_value(
                dataset.wind_available,
                t_idx,
                max(0.0, renewable_available - solar_available),
            )
            available_sum = solar_available + wind_available

            renewable_used = float(solution[renewable_index(t_idx)])
            grid_import = float(solution[grid_index(t_idx)])
            battery_charge = float(solution[charge_index(t_idx)])
            battery_discharge = float(solution[discharge_index(t_idx)])
            battery_soc = float(solution[soc_index(t_idx)])

            if available_sum > _EPS:
                solar_used = renewable_used * solar_available / available_sum
                wind_used = renewable_used - solar_used
            else:
                solar_used = 0.0
                wind_used = 0.0

            dispatch_rows: list[dict[str, object]] = []
            generator_output: dict[str, float] = {}
            committed_capacity = 0.0
            dispatchable_generation = 0.0

            for g_idx, gen in enumerate(generators):
                value = float(solution[gen_index(t_idx, g_idx)])
                is_committed = int(schedule.get((gen.id, hour), 0)) == 1
                if is_committed:
                    committed_capacity += float(gen.p_max)
                if value > _EPS or is_committed:
                    rounded_value = round(value, 3)
                    generator_output[gen.id] = rounded_value
                    dispatch_rows.append(
                        {
                            "generator_id": gen.id,
                            "output": rounded_value,
                            "p_min": gen.p_min,
                            "p_max": gen.p_max,
                        }
                    )
                dispatchable_generation += value
                total_variable += value * float(gen.variable_cost)

            renewable_curtailment = max(
                0.0,
                renewable_available - renewable_used,
            )
            total_supply = (
                dispatchable_generation
                + renewable_used
                + grid_import
                + battery_discharge
                - battery_charge
            )
            balance_residual = total_supply - demand
            reserve_available = max(
                0.0,
                committed_capacity
                - dispatchable_generation
                + grid_limit
                - grid_import
                + discharge_limit
                - battery_discharge,
            )

            total_grid_mwh += grid_import
            total_charge_mwh += battery_charge
            total_discharge_mwh += battery_discharge
            total_curtailment_mwh += renewable_curtailment
            total_grid_cost += grid_import * grid_cost
            total_battery_cost += (
                battery_charge + battery_discharge
            ) * battery_cost

            hourly_dispatch.append(
                {
                    "hour": hour,
                    "demand_mw": round(demand, 3),
                    "solar_available_mw": round(solar_available, 3),
                    "solar_used_mw": round(solar_used, 3),
                    "wind_available_mw": round(wind_available, 3),
                    "wind_used_mw": round(wind_used, 3),
                    "renewable_available_mw": round(renewable_available, 3),
                    "renewable_used_mw": round(renewable_used, 3),
                    "renewable_curtailment_mw": round(renewable_curtailment, 3),
                    "grid_import_mw": round(grid_import, 3),
                    "grid_limit_mw": round(grid_limit, 3),
                    "battery_charge_mw": round(battery_charge, 3),
                    "battery_discharge_mw": round(battery_discharge, 3),
                    "battery_net_mw": round(
                        battery_discharge - battery_charge,
                        3,
                    ),
                    "battery_soc_mwh": round(battery_soc, 3),
                    "battery_capacity_mwh": round(battery_capacity, 3),
                    "dispatchable_generation_mw": round(
                        dispatchable_generation,
                        3,
                    ),
                    "total_dispatchable_generation_mw": round(
                        dispatchable_generation,
                        3,
                    ),
                    "generator_output_mw": generator_output,
                    "total_supply_mw": round(total_supply, 3),
                    "total_actual_supply_mw": round(total_supply, 3),
                    "balance_residual_mw": round(balance_residual, 6),
                    "net_demand": round(dispatchable_generation, 3),
                    "reserve": round(float(dataset.reserve[t_idx]), 3),
                    "reserve_requirement_mw": round(
                        float(dataset.reserve[t_idx]),
                        3,
                    ),
                    "reserve_available_mw": round(reserve_available, 3),
                    "committed_capacity": round(committed_capacity, 3),
                    "dispatch": dispatch_rows,
                }
            )
    else:
        message = result.message or "Dispatch solver failure."
        add_violation(
            "dispatch_solver_failure",
            -1,
            f"Dispatch solver failure: {message}",
        )
        for t_idx, hour in enumerate(hours):
            renewable_available = max(0.0, float(dataset.renewable[t_idx]))
            hourly_dispatch.append(
                {
                    "hour": hour,
                    "demand_mw": round(float(dataset.demand[t_idx]), 3),
                    "renewable_available_mw": round(renewable_available, 3),
                    "renewable_used_mw": 0.0,
                    "renewable_curtailment_mw": round(renewable_available, 3),
                    "grid_import_mw": 0.0,
                    "grid_limit_mw": round(grid_limit, 3),
                    "battery_charge_mw": 0.0,
                    "battery_discharge_mw": 0.0,
                    "battery_soc_mwh": round(initial_soc, 3),
                    "battery_capacity_mwh": round(battery_capacity, 3),
                    "dispatchable_generation_mw": 0.0,
                    "total_supply_mw": 0.0,
                    "balance_residual_mw": round(-float(dataset.demand[t_idx]), 3),
                    "net_demand": round(
                        max(
                            float(dataset.demand[t_idx])
                            - renewable_available,
                            0.0,
                        ),
                        3,
                    ),
                    "reserve": round(float(dataset.reserve[t_idx]), 3),
                    "reserve_requirement_mw": round(
                        float(dataset.reserve[t_idx]),
                        3,
                    ),
                    "reserve_available_mw": 0.0,
                    "committed_capacity": round(
                        sum(
                            gen.p_max
                            for gen in generators
                            if int(schedule.get((gen.id, hour), 0)) == 1
                        ),
                        3,
                    ),
                    "dispatch": [],
                }
            )

    total_no_load = 0.0
    total_startup = 0.0
    for gen in generators:
        previous_status = int(gen.initial_status)
        for hour in hours:
            status = int(schedule.get((gen.id, hour), 0))
            if status == 1:
                total_no_load += float(gen.no_load_cost)
            if previous_status == 0 and status == 1:
                total_startup += float(gen.startup_cost)
            previous_status = status

    feasible = len(violations) == 0 and bool(result.success)
    total_cost = (
        total_variable
        + total_no_load
        + total_startup
        + total_grid_cost
        + total_battery_cost
    )

    return DispatchResult(
        feasible=feasible,
        total_cost=round(total_cost, 3),
        total_variable_cost=round(total_variable, 3),
        total_no_load_cost=round(total_no_load, 3),
        total_startup_cost=round(total_startup, 3),
        total_grid_import_cost=round(total_grid_cost, 3),
        total_battery_cost=round(total_battery_cost, 3),
        total_curtailment_cost=0.0,
        total_grid_import_mwh=round(total_grid_mwh, 3),
        total_battery_discharge_mwh=round(total_discharge_mwh, 3),
        total_battery_charge_mwh=round(total_charge_mwh, 3),
        total_renewable_curtailment_mwh=round(
            total_curtailment_mwh,
            3,
        ),
        hourly_dispatch=hourly_dispatch,
        violations=violations,
        structured_violations=structured,
        solver="scipy.linprog/highs",
    )


def solve_relaxed_economic_dispatch(
    dataset: DatasetModel,
    schedule: dict[tuple[str, int], int],
    *,
    shortage_penalty: float = 10000.0,
    surplus_penalty: float = 1000.0,
) -> DispatchResult:
    """Dispatch a fixed commitment with shortage/surplus slacks.

    Balance convention:
        supply + shortage - surplus = demand
    Therefore residual = shortage - surplus is positive for shortage and
    negative for excess supply. The model remains solvable and provides the
    physical feedback used by the ADMM-guided active-block loop.
    """
    import math
    import time

    start = time.perf_counter()
    generators, hours = dataset.generators, dataset.hours
    ng, nt = len(generators), len(hours)
    # p_g, renewable, grid, charge, discharge, soc, shortage, surplus
    block = ng + 7
    n = nt * block

    def p(t: int, g: int) -> int: return t * block + g
    def renewable(t: int) -> int: return t * block + ng
    def grid(t: int) -> int: return t * block + ng + 1
    def charge(t: int) -> int: return t * block + ng + 2
    def discharge(t: int) -> int: return t * block + ng + 3
    def soc(t: int) -> int: return t * block + ng + 4
    def shortage(t: int) -> int: return t * block + ng + 5
    def surplus(t: int) -> int: return t * block + ng + 6

    grid_limit = max(0.0, dataset.grid_import_limit_mw)
    cap = max(0.0, dataset.battery_capacity_mwh)
    initial_soc = min(max(0.0, dataset.initial_battery_soc_mwh), cap)
    charge_limit = min(max(0.0, dataset.battery_charge_limit_mw), cap)
    discharge_limit = min(max(0.0, dataset.battery_discharge_limit_mw), cap)
    eta_c = min(max(dataset.battery_charge_efficiency, 1e-6), 1.0)
    eta_d = min(max(dataset.battery_discharge_efficiency, 1e-6), 1.0)

    objective = [0.0] * n
    bounds: list[tuple[float | None, float | None]] = [(0.0, None)] * n
    for t, hour in enumerate(hours):
        for g, gen in enumerate(generators):
            objective[p(t, g)] = float(gen.variable_cost)
            bounds[p(t, g)] = (
                (float(gen.p_min), float(gen.p_max))
                if schedule.get((gen.id, hour), 0)
                else (0.0, 0.0)
            )
        objective[grid(t)] = dataset.grid_import_cost_per_mwh
        objective[charge(t)] = dataset.battery_throughput_cost_per_mwh
        objective[discharge(t)] = dataset.battery_throughput_cost_per_mwh
        objective[shortage(t)] = shortage_penalty
        objective[surplus(t)] = surplus_penalty
        bounds[renewable(t)] = (0.0, max(0.0, dataset.renewable[t]))
        bounds[grid(t)] = (0.0, grid_limit)
        bounds[charge(t)] = (0.0, charge_limit)
        bounds[discharge(t)] = (0.0, discharge_limit)
        bounds[soc(t)] = (0.0, cap)
        bounds[shortage(t)] = (0.0, None)
        bounds[surplus(t)] = (0.0, None)

    a_eq: list[list[float]] = []
    b_eq: list[float] = []
    for t, _hour in enumerate(hours):
        row = [0.0] * n
        for g in range(ng): row[p(t, g)] = 1.0
        row[renewable(t)] = 1.0
        row[grid(t)] = 1.0
        row[charge(t)] = -1.0
        row[discharge(t)] = 1.0
        row[shortage(t)] = 1.0
        row[surplus(t)] = -1.0
        a_eq.append(row); b_eq.append(max(0.0, dataset.demand[t]))

        row = [0.0] * n
        row[soc(t)] = 1.0
        row[charge(t)] = -eta_c
        row[discharge(t)] = 1.0 / eta_d
        if t == 0:
            rhs = initial_soc
        else:
            row[soc(t - 1)] = -1.0
            rhs = 0.0
        a_eq.append(row); b_eq.append(rhs)

    a_ub: list[list[float]] = []
    b_ub: list[float] = []
    for t, hour in enumerate(hours):
        for g, gen in enumerate(generators):
            current = int(schedule.get((gen.id, hour), 0))
            previous = gen.initial_status if t == 0 else int(schedule.get((gen.id, hours[t - 1]), 0))
            if not (current and previous):
                continue
            up = [0.0] * n; down = [0.0] * n
            up[p(t, g)] = 1.0; down[p(t, g)] = -1.0
            if t == 0:
                a_ub.extend([up, down])
                b_ub.extend([gen.initial_output + gen.ramp_up, gen.ramp_down - gen.initial_output])
            else:
                up[p(t - 1, g)] = -1.0
                down[p(t - 1, g)] = 1.0
                a_ub.extend([up, down]); b_ub.extend([gen.ramp_up, gen.ramp_down])

    if nt and cap > 0:
        row = [0.0] * n; row[soc(nt - 1)] = -1.0
        a_ub.append(row); b_ub.append(-min(initial_soc, 0.10 * cap))

    result = linprog(
        c=objective,
        A_ub=a_ub or None,
        b_ub=b_ub or None,
        A_eq=a_eq,
        b_eq=b_eq,
        bounds=bounds,
        method="highs",
    )

    if not result.success or result.x is None:
        failure = solve_economic_dispatch(dataset, schedule)
        shortage_values = [max(0.0, dataset.demand[t]) for t in range(nt)]
        return failure.model_copy(update={
            "feasible": False,
            "shortage": shortage_values,
            "surplus": [0.0] * nt,
            "residual": shortage_values,
            "residual_l2_mw": math.sqrt(sum(x * x for x in shortage_values)),
            "total_shortage_mwh": sum(shortage_values),
            "solver": "scipy.linprog/highs-relaxed-failed",
            "runtime_ms": (time.perf_counter() - start) * 1000.0,
        })

    x = result.x
    total_variable = total_grid_cost = total_battery_cost = 0.0
    total_grid = total_charge = total_discharge = total_curtail = 0.0
    shortage_values: list[float] = []
    surplus_values: list[float] = []
    residual_values: list[float] = []
    hourly: list[dict[str, object]] = []

    for t, hour in enumerate(hours):
        outputs: dict[str, float] = {}
        dispatch_rows: list[dict[str, object]] = []
        thermal = 0.0
        committed_capacity = 0.0
        for g, gen in enumerate(generators):
            value = max(0.0, float(x[p(t, g)]))
            thermal += value
            total_variable += value * gen.variable_cost
            if schedule.get((gen.id, hour), 0): committed_capacity += gen.p_max
            if value > _EPS or schedule.get((gen.id, hour), 0):
                outputs[gen.id] = round(value, 3)
                dispatch_rows.append({"generator_id": gen.id, "output": round(value, 3), "p_min": gen.p_min, "p_max": gen.p_max})

        ren = max(0.0, float(x[renewable(t)]))
        grd = max(0.0, float(x[grid(t)]))
        chg = max(0.0, float(x[charge(t)]))
        dis = max(0.0, float(x[discharge(t)]))
        state = max(0.0, float(x[soc(t)]))
        s_minus = max(0.0, float(x[shortage(t)]))
        s_plus = max(0.0, float(x[surplus(t)]))
        residual = s_minus - s_plus
        shortage_values.append(s_minus); surplus_values.append(s_plus); residual_values.append(residual)

        available = max(0.0, dataset.renewable[t])
        solar_available = _profile_value(dataset.solar_available, t, available)
        wind_available = _profile_value(dataset.wind_available, t, max(0.0, available - solar_available))
        denom = solar_available + wind_available
        solar_used = ren * solar_available / denom if denom > _EPS else 0.0
        wind_used = ren - solar_used
        total_supply = thermal + ren + grd + dis - chg
        reserve_available = max(0.0, committed_capacity - thermal + grid_limit - grd + discharge_limit - dis)
        curtail = max(0.0, available - ren)

        total_grid += grd; total_charge += chg; total_discharge += dis; total_curtail += curtail
        total_grid_cost += grd * dataset.grid_import_cost_per_mwh
        total_battery_cost += (chg + dis) * dataset.battery_throughput_cost_per_mwh
        hourly.append({
            "hour": hour,
            "demand_mw": round(dataset.demand[t], 3),
            "solar_available_mw": round(solar_available, 3),
            "solar_used_mw": round(solar_used, 3),
            "wind_available_mw": round(wind_available, 3),
            "wind_used_mw": round(wind_used, 3),
            "renewable_available_mw": round(available, 3),
            "renewable_used_mw": round(ren, 3),
            "renewable_curtailment_mw": round(curtail, 3),
            "grid_import_mw": round(grd, 3),
            "grid_limit_mw": round(grid_limit, 3),
            "battery_charge_mw": round(chg, 3),
            "battery_discharge_mw": round(dis, 3),
            "battery_net_mw": round(dis - chg, 3),
            "battery_soc_mwh": round(state, 3),
            "battery_capacity_mwh": round(cap, 3),
            "dispatchable_generation_mw": round(thermal, 3),
            "total_dispatchable_generation_mw": round(thermal, 3),
            "generator_output_mw": outputs,
            "total_supply_mw": round(total_supply, 3),
            "total_actual_supply_mw": round(total_supply, 3),
            "shortage_slack_mw": round(s_minus, 6),
            "surplus_slack_mw": round(s_plus, 6),
            "residual_mw": round(residual, 6),
            "balance_residual_mw": round(total_supply + s_minus - s_plus - dataset.demand[t], 6),
            "net_demand": round(thermal, 3),
            "reserve": round(dataset.reserve[t], 3),
            "reserve_requirement_mw": round(dataset.reserve[t], 3),
            "reserve_available_mw": round(reserve_available, 3),
            "committed_capacity": round(committed_capacity, 3),
            "dispatch": dispatch_rows,
        })

    total_no_load = total_startup = 0.0
    for gen in generators:
        prev = gen.initial_status
        for hour in hours:
            value = int(schedule.get((gen.id, hour), 0))
            if value: total_no_load += gen.no_load_cost
            if not prev and value: total_startup += gen.startup_cost
            prev = value

    true_cost = total_variable + total_no_load + total_startup + total_grid_cost + total_battery_cost
    residual_norm = math.sqrt(sum(v * v for v in residual_values))
    return DispatchResult(
        feasible=residual_norm <= 1e-5,
        total_cost=round(true_cost, 3),
        total_variable_cost=round(total_variable, 3),
        total_no_load_cost=round(total_no_load, 3),
        total_startup_cost=round(total_startup, 3),
        total_grid_import_cost=round(total_grid_cost, 3),
        total_battery_cost=round(total_battery_cost, 3),
        total_grid_import_mwh=round(total_grid, 3),
        total_battery_discharge_mwh=round(total_discharge, 3),
        total_battery_charge_mwh=round(total_charge, 3),
        total_renewable_curtailment_mwh=round(total_curtail, 3),
        total_shortage_mwh=round(sum(shortage_values), 6),
        total_surplus_mwh=round(sum(surplus_values), 6),
        residual_l2_mw=round(residual_norm, 6),
        residual=[round(v, 6) for v in residual_values],
        shortage=[round(v, 6) for v in shortage_values],
        surplus=[round(v, 6) for v in surplus_values],
        hourly_dispatch=hourly,
        violations=[] if residual_norm <= 1e-5 else [f"Relaxed dispatch residual norm is {residual_norm:.3f} MW."],
        structured_violations=[],
        solver="scipy.linprog/highs-relaxed-slack",
        runtime_ms=(time.perf_counter() - start) * 1000.0,
    )
