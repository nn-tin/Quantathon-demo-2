from __future__ import annotations

import math
from dataclasses import dataclass

from app.models.schemas import DatasetModel, GeneratorSpec
from benchmark.data.validation import validate_benchmark_dataset


# Source: MATPOWER data/case30.m (30 buses, 6 generators). The prototype is a
# single-bus Unit Commitment model, so the 30 bus loads are aggregated. The
# six MATPOWER generators are deterministically split into ten virtual units
# to create meaningful binary commitment decisions while preserving total
# installed capacity and the source generator cost ordering.
IEEE30_SOURCE_URL = "https://github.com/MATPOWER/matpower/blob/master/data/case30.m"
IEEE30_BASE_LOAD_MW = 189.2
IEEE30_SOURCE_TOTAL_CAPACITY_MW = 335.0
IEEE30_BASE_GENERATOR_COUNT = 10


@dataclass(frozen=True)
class SourceGenerator:
    bus: int
    pg: float
    p_max: float
    quadratic_cost: float
    linear_cost: float
    split_count: int
    p_min_ratio: float
    ramp_ratio: float
    min_up: int
    min_down: int


# bus, Pg, Pmax and quadratic/linear costs match MATPOWER case30.m.
_SOURCE_GENERATORS = (
    SourceGenerator(1, 23.54, 80.0, 0.02000, 2.00, 2, 0.30, 0.45, 4, 3),
    SourceGenerator(2, 60.97, 80.0, 0.01750, 1.75, 2, 0.30, 0.45, 4, 3),
    SourceGenerator(22, 21.59, 50.0, 0.06250, 1.00, 2, 0.20, 0.65, 2, 2),
    SourceGenerator(27, 26.91, 55.0, 0.00834, 3.25, 2, 0.18, 0.80, 2, 2),
    SourceGenerator(23, 19.20, 30.0, 0.02500, 3.00, 1, 0.10, 1.00, 1, 1),
    SourceGenerator(13, 37.00, 40.0, 0.02500, 3.00, 1, 0.12, 0.90, 1, 1),
)

_BASE_DEMAND_SHAPE = (
    126, 122, 118, 117, 120, 132,
    153, 180, 204, 219, 213, 195,
    177, 168, 165, 171, 180, 189,
    198, 204, 195, 180, 159, 141,
)


def _normalise(values: list[float] | tuple[float, ...]) -> list[float]:
    peak = max(values)
    if peak <= 0:
        return [0.0 for _ in values]
    return [float(value) / peak for value in values]


def _gaussian(hour: int, centre: float, width: float) -> float:
    return math.exp(-((hour - centre) / width) ** 2)


def _solar_shape() -> list[float]:
    return [max(0.0, math.sin((hour - 6.0) * math.pi / 12.0)) for hour in range(24)]


def _wind_shape(*, night_weight: float = 0.0) -> list[float]:
    values: list[float] = []
    for hour in range(24):
        periodic = 0.56 + 0.19 * math.sin((hour + 2.0) * math.pi / 7.0)
        night = night_weight * (_gaussian(hour, 2.0, 4.0) + _gaussian(hour, 23.0, 3.0))
        values.append(max(0.05, periodic + night))
    return _normalise(values)


def _demand_shape(scenario_id: str) -> list[float]:
    base = _normalise(_BASE_DEMAND_SHAPE)
    if scenario_id in {"base-day", "cloudy-solar", "windy-night", "renewable-drop"}:
        return base
    if scenario_id == "double-peak":
        values = [
            0.50 + 0.31 * _gaussian(hour, 8.0, 2.8) + 0.40 * _gaussian(hour, 19.0, 3.0)
            for hour in range(24)
        ]
        return _normalise(values)
    if scenario_id == "summer-solar":
        values = [
            0.52 + 0.18 * _gaussian(hour, 9.0, 3.5) + 0.46 * _gaussian(hour, 17.0, 4.0)
            for hour in range(24)
        ]
        return _normalise(values)
    if scenario_id == "evening-ramp":
        values = []
        for hour in range(24):
            ramp = 0.34 / (1.0 + math.exp(-(hour - 17.0) * 1.4))
            values.append(0.52 + 0.12 * _gaussian(hour, 8.0, 3.2) + ramp - 0.10 * _gaussian(hour, 13.0, 3.0))
        return _normalise(values)
    if scenario_id == "high-demand":
        values = [0.95 * value + 0.05 for value in base]
        return _normalise(values)
    raise ValueError(f"Unknown IEEE30 scenario: {scenario_id}")


def _scenario_parameters(scenario_id: str) -> tuple[float, float, float, float]:
    # demand peak as a multiple of the static IEEE30 189.2 MW load,
    # solar/wind peaks as fractions of installed dispatchable capacity,
    # and reserve ratio.
    parameters = {
        "base-day": (1.08, 0.13, 0.055, 0.08),
        "cloudy-solar": (1.10, 0.060, 0.060, 0.08),
        "double-peak": (1.14, 0.115, 0.050, 0.09),
        "summer-solar": (1.18, 0.220, 0.040, 0.09),
        "windy-night": (1.08, 0.090, 0.145, 0.08),
        "evening-ramp": (1.17, 0.185, 0.035, 0.10),
        "high-demand": (1.26, 0.070, 0.035, 0.10),
        "renewable-drop": (1.15, 0.180, 0.085, 0.09),
    }
    try:
        return parameters[scenario_id]
    except KeyError as exc:
        raise ValueError(f"Unknown IEEE30 scenario: {scenario_id}") from exc


def _build_base_virtual_units() -> list[GeneratorSpec]:
    raw: list[dict[str, float | int | str]] = []
    for source in _SOURCE_GENERATORS:
        unit_capacity = source.p_max / source.split_count
        # The original case has quadratic production costs. The current UC
        # model is linear, so use the source marginal cost at 50% loading:
        # d(aP^2+bP)/dP at P=Pmax/2 = a*Pmax+b.
        variable_cost = source.quadratic_cost * source.p_max + source.linear_cost
        for split_index in range(source.split_count):
            suffix = chr(ord("A") + split_index)
            p_min = max(1.0, source.p_min_ratio * unit_capacity)
            raw.append({
                "source_bus": source.bus,
                "suffix": suffix,
                "p_max": unit_capacity,
                "p_min": p_min,
                "variable_cost": variable_cost,
                "ramp": max(p_min, source.ramp_ratio * unit_capacity),
                "min_up": source.min_up,
                "min_down": source.min_down,
            })

    # Start the least-cost units until there is enough online capacity for the
    # first-hour base-day operating point. This is a UC adaptation parameter,
    # not data claimed to be present in MATPOWER case30.
    initial_target = 0.72 * IEEE30_BASE_LOAD_MW
    selected: set[int] = set()
    accumulated = 0.0
    for index in sorted(range(len(raw)), key=lambda i: (float(raw[i]["variable_cost"]), -float(raw[i]["p_max"]))):
        selected.add(index)
        accumulated += float(raw[index]["p_max"])
        if accumulated >= 1.12 * initial_target:
            break

    selected_capacity = sum(float(raw[index]["p_max"]) for index in selected)
    generators: list[GeneratorSpec] = []
    for index, item in enumerate(raw):
        p_max = float(item["p_max"])
        p_min = float(item["p_min"])
        is_on = index in selected
        initial_output = max(p_min, initial_target * p_max / selected_capacity) if is_on else 0.0
        # Deterministic no-load/startup proxies are needed because case30 is an
        # OPF case, not a multi-period UC data set.
        no_load_cost = 0.90 * p_max + 4.0 * float(item["variable_cost"])
        startup_cost = 2.40 * p_max + 8.0 * float(item["variable_cost"])
        bus = int(item["source_bus"])
        suffix = str(item["suffix"])
        generators.append(
            GeneratorSpec(
                id=f"IEEE30-B{bus}-{suffix}",
                name=f"IEEE30 Bus {bus} Unit {suffix}",
                p_min=round(p_min, 4),
                p_max=round(p_max, 4),
                variable_cost=round(float(item["variable_cost"]), 5),
                no_load_cost=round(no_load_cost, 4),
                startup_cost=round(startup_cost, 4),
                shutdown_cost=0.0,
                ramp_up=round(float(item["ramp"]), 4),
                ramp_down=round(float(item["ramp"]), 4),
                min_up_time=int(item["min_up"]),
                min_down_time=int(item["min_down"]),
                initial_status=1 if is_on else 0,
                initial_output=round(min(initial_output, p_max), 4),
            )
        )
    if len(generators) != IEEE30_BASE_GENERATOR_COUNT:
        raise AssertionError("IEEE30 virtual-unit split must create exactly 10 units.")
    return generators


def build_ieee30_generator_fleet(generator_count: int = IEEE30_BASE_GENERATOR_COUNT) -> list[GeneratorSpec]:
    if generator_count not in {10, 20, 30, 40, 50}:
        raise ValueError("IEEE30-derived scaling supports 10, 20, 30, 40 or 50 generators.")
    base = _build_base_virtual_units()
    replicas = generator_count // IEEE30_BASE_GENERATOR_COUNT
    fleet: list[GeneratorSpec] = []
    for replica in range(replicas):
        for unit in base:
            payload = unit.model_dump()
            payload["id"] = f"R{replica + 1}-{unit.id}"
            payload["name"] = f"Replica {replica + 1} · {unit.name}"
            # A tiny deterministic cost offset breaks exact symmetry without
            # changing the IEEE30-derived technology ordering.
            payload["variable_cost"] = round(float(unit.variable_cost) + 0.015 * replica, 5)
            fleet.append(GeneratorSpec(**payload))
    return fleet


def build_ieee30_dataset(
    scenario_id: str,
    *,
    generator_count: int = IEEE30_BASE_GENERATOR_COUNT,
) -> DatasetModel:
    generators = build_ieee30_generator_fleet(generator_count)
    capacity = sum(generator.p_max for generator in generators)
    capacity_scale = capacity / IEEE30_SOURCE_TOTAL_CAPACITY_MW

    demand_multiplier, solar_fraction, wind_fraction, reserve_ratio = _scenario_parameters(scenario_id)
    demand_shape = _demand_shape(scenario_id)
    solar_shape = _solar_shape()
    wind_shape = _wind_shape(night_weight=0.38 if scenario_id == "windy-night" else 0.0)

    if scenario_id == "cloudy-solar":
        solar_shape = [value * (0.42 + 0.20 * _gaussian(hour, 10.0, 2.0)) for hour, value in enumerate(solar_shape)]
    elif scenario_id == "renewable-drop":
        solar_shape = [value * (1.0 if hour <= 13 else max(0.12, 1.0 - 0.22 * (hour - 13))) for hour, value in enumerate(solar_shape)]
        wind_shape = [value * (1.0 if hour <= 15 else 0.28) for hour, value in enumerate(wind_shape)]

    demand_peak = IEEE30_BASE_LOAD_MW * demand_multiplier * capacity_scale
    demand = [round(demand_peak * value, 4) for value in demand_shape]
    solar = [round(solar_fraction * capacity * value, 4) for value in solar_shape]
    wind = [round(wind_fraction * capacity * value, 4) for value in wind_shape]
    renewable = [round(left + right, 4) for left, right in zip(solar, wind)]
    reserve = [round(reserve_ratio * value, 4) for value in demand]

    dataset = DatasetModel(
        id=f"ieee30_{scenario_id}_{generator_count}g",
        name=f"IEEE30 Copper-Plate UC · {scenario_id} · {generator_count} generators",
        description=(
            "MATPOWER case30-derived 24-hour single-bus UC adaptation. The 30-bus "
            "loads are aggregated; network-flow constraints are intentionally outside "
            "the current prototype. Generator scaling replicates the same ten-unit "
            "IEEE30-derived fleet and scales demand/renewables/reserve proportionally."
        ),
        hours=list(range(24)),
        demand=demand,
        renewable=renewable,
        reserve=reserve,
        generators=generators,
        solar_available=solar,
        wind_available=wind,
        grid_import_limit_mw=0.0,
        initial_battery_soc_mwh=0.0,
        battery_capacity_mwh=0.0,
        battery_charge_limit_mw=0.0,
        battery_discharge_limit_mw=0.0,
    )
    validate_benchmark_dataset(dataset)
    return dataset
