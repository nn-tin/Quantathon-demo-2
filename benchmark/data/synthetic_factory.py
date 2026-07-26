from __future__ import annotations

import math

from app.models.schemas import DatasetModel, GeneratorSpec

from benchmark.data.validation import validate_benchmark_dataset


_TECHNOLOGIES = (
    # name, pmin ratio, variable cost, no-load ratio, startup ratio,
    # ramp ratio, min-up, min-down
    ("Baseload", 0.36, 22.0, 1.45, 3.2, 0.25, 4, 3),
    ("Coal", 0.32, 26.0, 1.25, 2.8, 0.28, 4, 3),
    ("CCGT", 0.25, 32.0, 0.95, 2.1, 0.45, 2, 2),
    ("Hydro", 0.12, 18.0, 0.35, 0.7, 1.00, 1, 1),
    ("Gas", 0.20, 43.0, 0.50, 1.1, 0.90, 1, 1),
    ("Peaker", 0.08, 60.0, 0.22, 0.5, 1.50, 1, 1),
    ("Biomass", 0.22, 29.0, 0.65, 1.2, 0.50, 2, 2),
)


def build_generator_fleet(generator_count: int) -> list[GeneratorSpec]:
    if not 1 <= generator_count <= 20:
        raise ValueError("Synthetic benchmark supports 1–20 generators.")

    generators: list[GeneratorSpec] = []
    for index in range(generator_count):
        technology = _TECHNOLOGIES[index % len(_TECHNOLOGIES)]
        name, pmin_ratio, variable, no_load_ratio, startup_ratio, ramp_ratio, min_up, min_down = technology
        # Mild deterministic capacity variation avoids a fleet of identical units.
        p_max = 34.0 + 5.5 * (index % 5) + 2.5 * (index // 5)
        p_min = max(2.0, pmin_ratio * p_max)
        initial_status = 1 if index < max(1, math.ceil(0.35 * generator_count)) else 0
        initial_output = p_min if initial_status else 0.0
        generators.append(
            GeneratorSpec(
                id=f"G{index + 1}",
                name=f"{name}-{index + 1}",
                p_min=round(p_min, 3),
                p_max=round(p_max, 3),
                variable_cost=round(variable + 0.35 * (index % 4), 3),
                no_load_cost=round(no_load_ratio * p_max, 3),
                startup_cost=round(startup_ratio * p_max, 3),
                shutdown_cost=0.0,
                ramp_up=round(max(p_min, ramp_ratio * p_max), 3),
                ramp_down=round(max(p_min, ramp_ratio * p_max), 3),
                min_up_time=min_up,
                min_down_time=min_down,
                initial_status=initial_status,
                initial_output=round(initial_output, 3),
            )
        )
    return generators


def _daily_shapes(seed: int = 0) -> tuple[list[float], list[float], list[float]]:
    demand: list[float] = []
    solar: list[float] = []
    wind: list[float] = []
    phase = 0.13 * seed
    for hour in range(24):
        morning = math.exp(-((hour - 8.0) / 3.2) ** 2)
        evening = math.exp(-((hour - 19.0) / 3.0) ** 2)
        demand.append(0.55 + 0.13 * morning + 0.27 * evening)
        solar.append(max(0.0, math.sin((hour - 6) * math.pi / 12.0)))
        wind.append(0.58 + 0.18 * math.sin((hour + phase) * math.pi / 7.0))
    return demand, solar, wind


def build_synthetic_dataset(
    generator_count: int,
    *,
    scenario_id: str = "balanced",
    profile_seed: int = 0,
) -> DatasetModel:
    generators = build_generator_fleet(generator_count)
    total_capacity = sum(generator.p_max for generator in generators)
    demand_shape, solar_shape, wind_shape = _daily_shapes(profile_seed)

    demand_peak = 0.72 * total_capacity
    solar_peak = 0.12 * total_capacity
    wind_peak = 0.09 * total_capacity
    demand = [round(demand_peak * value / max(demand_shape), 3) for value in demand_shape]
    solar = [round(solar_peak * value, 3) for value in solar_shape]
    wind = [round(wind_peak * max(0.0, value), 3) for value in wind_shape]
    renewable = [round(left + right, 3) for left, right in zip(solar, wind)]
    reserve = [round(0.08 * value, 3) for value in demand]

    dataset = DatasetModel(
        id=f"synthetic_{generator_count}g_{scenario_id}",
        name=f"Synthetic {generator_count}-Generator 24-Hour UC",
        description=(
            "Capacity-normalized synthetic UC system for controlled qubit and "
            "generator scaling experiments."
        ),
        hours=list(range(24)),
        demand=demand,
        renewable=renewable,
        reserve=reserve,
        generators=generators,
        solar_available=solar,
        wind_available=wind,
        grid_import_limit_mw=round(0.08 * total_capacity, 3),
        initial_battery_soc_mwh=round(0.06 * total_capacity, 3),
        battery_capacity_mwh=round(0.12 * total_capacity, 3),
        battery_charge_limit_mw=round(0.04 * total_capacity, 3),
        battery_discharge_limit_mw=round(0.04 * total_capacity, 3),
    )
    validate_benchmark_dataset(dataset)
    return dataset
