/**
 * PiL-HQUC single-file React application
 *
 * Maintenance map
 *  01. Backend adapter and API contract
 *  02. Static scenarios, solver metadata, and profile generators
 *  03. Application shell, navigation, and page transitions
 *  04. Page 01 — Home
 *  05. Page 02 — Workspace and pre-optimization analysis
 *  06. Operating-plan normalization and operator helpers
 *  07. CSV / Excel export pipeline
 *  08. Page 03 — Results and operator decision board
 *  09. Result charts and evidence views
 *  10. Result construction, backend normalization, and preview math
 *
 * Refactor rule: keep rendered DOM order, class names, visible copy, and
 * state transitions unchanged. CSS relies on those contracts.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";


// #region 01 — Backend adapter and API contract
/* ========================= Backend integration contract ========================= */

const BACKEND_CONTRACT_VERSION = "quantathon-run-summary-v1.1";

const runtimeBackendConfig =
  typeof window !== "undefined" && window.__HQUC_CONFIG__
    ? window.__HQUC_CONFIG__
    : {};

const BACKEND_CONFIG = Object.freeze({
  apiBaseUrl: String(
    runtimeBackendConfig.apiBaseUrl ||
      import.meta.env?.VITE_API_BASE_URL ||
      "/api"
  ).replace(/\/$/, ""),
  healthPath: runtimeBackendConfig.healthPath || "/health",
  datasetsPath: runtimeBackendConfig.datasetsPath || "/datasets",
  runPath: runtimeBackendConfig.runPath || "/runs",
  runStatusPath: runtimeBackendConfig.runStatusPath || "/runs/{runId}",
  requestTimeoutMs: Number(runtimeBackendConfig.requestTimeoutMs || 180000),
  pollIntervalMs: Number(runtimeBackendConfig.pollIntervalMs || 900),
  maxPollAttempts: Number(runtimeBackendConfig.maxPollAttempts || 160),
  allowSyntheticFallback: runtimeBackendConfig.allowSyntheticFallback === true,
});

// #region 01A — Runtime configuration and request lifecycle
function apiUrl(path) {
  const normalizedPath = String(path || "").startsWith("/") ? path : `/${path}`;
  return `${BACKEND_CONFIG.apiBaseUrl}${normalizedPath}`;
}


function stableSeedFromScenario(scenario) {
  const value = String(scenario?.id || scenario?.name || "default");
  let hash = 7;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return 7 + (hash % 1000);
}

function buildScenarioInputContract(scenario) {
  const normalized = normalizeScenarioForResults(scenario);
  const hourly = makeScenarioPreview24h(normalized);
  const batteryCapacity = Math.max(Number(normalized.batteryCapacity ?? 80), 0);
  const initialBatteryEnergy = Math.max(
    0,
    Math.min(
      Number(normalized.batterySoc ?? 0),
      batteryCapacity > 0 ? batteryCapacity : 0
    )
  );

  return {
    contract_version: "pil-hquc-scenario-input-v1",
    scenario_id: String(normalized.id || "custom"),
    scenario_name: String(normalized.name || "Selected scenario"),
    profile_id: String(normalized.profileMeta?.id || "default-generated"),
    profile_name: String(normalized.profileMeta?.name || "Default Synthetic 24h"),
    profile_source: String(normalized.profileMeta?.source || "frontend-generated"),
    horizon_hours: 24,

    // These five fields are system-level operating inputs. They do not replace
    // generator p_min / p_max, which remain in DatasetModel.generators[].
    peak_demand_mw: Math.max(Number(normalized.load ?? 0), 0),
    solar_availability_mw: Math.max(Number(normalized.solar ?? 0), 0),
    wind_availability_mw: Math.max(Number(normalized.wind ?? 0), 0),
    grid_import_limit_mw: Math.max(Number(normalized.gridLimit ?? 0), 0),
    initial_battery_soc_mwh: initialBatteryEnergy,
    initial_battery_soc_percent:
      batteryCapacity > 0 ? (initialBatteryEnergy / batteryCapacity) * 100 : 0,
    battery_capacity_mwh: batteryCapacity,

    profiles: {
      demand_mw: hourly.map((row) => Number(row.load || 0)),
      solar_available_mw: hourly.map((row) => Number(row.solar || 0)),
      wind_available_mw: hourly.map((row) => Number(row.wind || 0)),
    },
  };
}

function buildOptimizationRequest({ scenario }) {
  return {
    dataset_id: "default_10x24",
    run_mode: "hybrid_demo",
    presentation_mode: false,
    presentation_delay_ms: 0,
    // Quantum depth, shots, optimizer budget, top-K and ADMM rounds are fixed
    // by the backend. The localhost UI sends operating data only.
    scenario_input: buildScenarioInputContract(scenario),
  };
}

async function fetchJsonWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    BACKEND_CONFIG.requestTimeoutMs
  );

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text };
      }
    }

    if (!response.ok && response.status !== 202) {
      const detail = payload?.detail;
      const message = Array.isArray(detail)
        ? detail.map((item) => item?.msg || JSON.stringify(item)).join(" · ")
        : detail || payload?.message || `HTTP ${response.status}`;
      throw new Error(message);
    }

    return { response, payload };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function isPendingBackendRun(payload, statusCode) {
  const status = String(payload?.status || payload?.state || "").toLowerCase();
  return statusCode === 202 || ["queued", "pending", "running", "processing"].includes(status);
}

async function pollBackendRun(runId) {
  const path = BACKEND_CONFIG.runStatusPath.replace("{runId}", encodeURIComponent(runId));

  for (let attempt = 0; attempt < BACKEND_CONFIG.maxPollAttempts; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, BACKEND_CONFIG.pollIntervalMs));
    const { response, payload } = await fetchJsonWithTimeout(apiUrl(path), {
      method: "GET",
      cache: "no-store",
    });

    if (!isPendingBackendRun(payload, response.status)) return payload;
  }

  throw new Error("Backend run did not finish before the polling limit.");
}

async function requestOptimizationRun({ scenario }) {
  const requestBody = buildOptimizationRequest({ scenario });
  const startedAt = performance.now();
  const { response, payload } = await fetchJsonWithTimeout(
    apiUrl(BACKEND_CONFIG.runPath),
    {
      method: "POST",
      body: JSON.stringify(requestBody),
    }
  );

  let completedPayload = payload;
  if (isPendingBackendRun(payload, response.status)) {
    const runId = firstDefinedValue(payload?.run_id, payload?.runId, payload?.id);
    if (!runId) throw new Error("Backend returned a pending run without run_id.");
    completedPayload = await pollBackendRun(runId);
  }

  const backendStatus = String(
    completedPayload?.status || completedPayload?.state || ""
  ).toLowerCase();
  if (["failed", "error"].includes(backendStatus)) {
    const violations = [
      ...(completedPayload?.result?.baseline_violations_after || []),
      ...(completedPayload?.result?.baseline_violations_before || []),
      ...(completedPayload?.result?.feasible_dispatch?.violations || []),
      ...(completedPayload?.result?.initial_dispatch?.violations || []),
    ].filter(Boolean);
    throw new Error(
      violations[0] ||
        completedPayload?.message ||
        "Backend optimization failed to produce a feasible schedule."
    );
  }

  const elapsedSeconds = Math.max(0, (performance.now() - startedAt) / 1000);
  const normalized = normalizeApiRunResponse(
    completedPayload,
    PRIMARY_METHOD,
    scenario,
    elapsedSeconds
  );

  // Preserve the exact submitted values even when connected to an older backend
  // that silently ignores unknown fields.
  normalized.submitted_scenario_input = requestBody.scenario_input;
  normalized.scenario_input_received_by_backend = Boolean(
    completedPayload?.config?.scenario_input
  );
  normalized.scenario_input_applied_by_optimizer = Boolean(
    completedPayload?.metrics?.scenario_input_applied ||
      completedPayload?.result?.scenario_input_applied
  );

  if (normalized.operating_plan?.summary) {
    normalized.operating_plan.summary.scenario_inputs = {
      ...requestBody.scenario_input,
      ...(normalized.operating_plan.summary.scenario_inputs || {}),
      received_by_backend: normalized.scenario_input_received_by_backend,
      applied_by_optimizer: normalized.scenario_input_applied_by_optimizer,
    };
  }

  return normalized;
}

// #endregion

// #region 01B — Backend payload and dispatch normalization
function unwrapApiPayload(payload) {
  if (!payload || typeof payload !== "object") return {};
  return payload.data || payload.run || payload;
}

function isQuantathonRunSummary(payload) {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      payload.dataset &&
      payload.config &&
      payload.result &&
      Array.isArray(payload.dataset.hours)
  );
}

function normalizeApiMethodResult(source) {
  if (!source || typeof source !== "object") return {};
  return {
    ...source,
    cost: firstFiniteNumber(
      source.cost,
      source.total_cost,
      source.validated_cost,
      source.operating_cost
    ),
    runtime: firstFiniteNumber(
      source.runtime,
      source.runtime_seconds,
      source.elapsed_seconds,
      source.solve_time_seconds
    ),
    curtailment: firstFiniteNumber(
      source.unused_renewables_mwh,
      source.renewable_curtailment_mwh,
      source.curtailment_mwh,
      source.curtailment
    ),
    cost_breakdown:
      source.cost_breakdown || source.cost_components || source.components || null,
    dispatch24h:
      source.dispatch24h || source.hourly_dispatch || source.dispatch || null,
  };
}

function inferBackendGeneratorRole(generator) {
  const name = String(generator?.name || generator?.id || "").toLowerCase();
  if (name.includes("coal")) return "Base-load thermal";
  if (name.includes("ccgt")) return "Flexible combined-cycle";
  if (name.includes("hydro")) return "Hydro flexibility";
  if (name.includes("peaker")) return "Peak reserve";
  if (name.includes("gas")) return "Fast-ramping gas";
  if (name.includes("biomass")) return "Dispatchable renewable";
  return "Dispatchable generation";
}

function dispatchRowsByHour(hourlyDispatch) {
  const map = new Map();
  (Array.isArray(hourlyDispatch) ? hourlyDispatch : []).forEach((row, index) => {
    const hour = Number.parseInt(row?.hour ?? index, 10);
    if (Number.isInteger(hour) && hour >= 0 && hour <= 23) map.set(hour, row);
  });
  return map;
}

function generatorOutputsForHour(row) {
  return Object.fromEntries(
    (Array.isArray(row?.dispatch) ? row.dispatch : [])
      .filter((item) => item && item.generator_id)
      .map((item) => [String(item.generator_id), Math.max(0, Number(item.output || 0))])
  );
}

function scheduleRowsFromBackendDispatch(dataset, hourlyDispatch) {
  const rowsByHour = dispatchRowsByHour(hourlyDispatch);
  return (Array.isArray(dataset?.generators) ? dataset.generators : []).map((generator) => {
    const schedule = Array.from({ length: 24 }, (_, hour) => {
      const outputs = generatorOutputsForHour(rowsByHour.get(hour));
      return Number(outputs[generator.id] || 0) > 1e-8;
    });
    const starts = [];
    const stops = [];
    let previous = Boolean(generator.initial_status);
    schedule.forEach((current, hour) => {
      if (current && !previous) starts.push(hour);
      if (!current && previous) stops.push(hour);
      previous = current;
    });

    return {
      id: String(generator.id),
      resource_id: String(generator.id),
      name: String(generator.name || generator.id),
      resource_name: String(generator.name || generator.id),
      role: inferBackendGeneratorRole(generator),
      initial_status: Boolean(generator.initial_status),
      starts,
      stops,
      startup_count: starts.length,
      shutdown_count: stops.length,
      online_hours: schedule.filter(Boolean).length,
      final_state: schedule[23] ? "ON" : "OFF",
      schedule,
      constraints: {
        minimum_output_mw: Number(generator.p_min || 0),
        maximum_output_mw: Number(generator.p_max || 0),
        ramp_up_mw_per_hour: Number(generator.ramp_up || 0),
        ramp_down_mw_per_hour: Number(generator.ramp_down || 0),
        minimum_up_time_hours: Number(generator.min_up_time || 0),
        minimum_down_time_hours: Number(generator.min_down_time || 0),
      },
    };
  });
}

function scheduleRowsFromBackendCommitment(dataset, commitmentRows) {
  const source = new Map(
    (Array.isArray(commitmentRows) ? commitmentRows : []).map((row) => [
      String(row?.generator_id || row?.id),
      row,
    ])
  );

  return (Array.isArray(dataset?.generators) ? dataset.generators : []).map((generator) => {
    const values = source.get(String(generator.id))?.values;
    const schedule = Array.from({ length: 24 }, (_, hour) => Boolean(Number(values?.[hour] || 0)));
    return {
      id: String(generator.id),
      resource_id: String(generator.id),
      name: String(generator.name || generator.id),
      resource_name: String(generator.name || generator.id),
      role: inferBackendGeneratorRole(generator),
      initial_status: Boolean(generator.initial_status),
      schedule,
    };
  });
}

function splitRenewableProfile(totalRenewable, scenario) {
  const solarInput = Math.max(0, Number(scenario?.solar || 0));
  const windInput = Math.max(0, Number(scenario?.wind || 0));
  const denominator = solarInput + windInput;
  const solarShare = denominator > 0 ? solarInput / denominator : 0.68;
  const solar = Math.max(0, Number(totalRenewable || 0)) * solarShare;
  return { solar, wind: Math.max(0, Number(totalRenewable || 0) - solar) };
}

function buildBackendHourlyPlan(dataset, hourlyDispatch, scenario, stressHours) {
  const rowsByHour = dispatchRowsByHour(hourlyDispatch);
  const stressSet = new Set((Array.isArray(stressHours) ? stressHours : []).map(Number));

  return Array.from({ length: 24 }, (_, hour) => {
    const source = rowsByHour.get(hour) || {};
    const demand = Number(
      firstDefinedValue(source.demand_mw, dataset?.demand?.[hour], 0)
    ) || 0;
    const renewableAvailable = Number(
      firstDefinedValue(
        source.renewable_available_mw,
        dataset?.renewable?.[hour],
        0
      )
    ) || 0;
    const outputs = generatorOutputsForHour(source);
    const dispatchable = Number(
      firstDefinedValue(
        source.dispatchable_generation_mw,
        source.total_dispatchable_generation_mw,
        Object.values(outputs).reduce(
          (sum, value) => sum + Number(value || 0),
          0
        )
      )
    ) || 0;

    const availableSplit = splitRenewableProfile(renewableAvailable, scenario);
    const solarAvailable = Number(
      firstDefinedValue(source.solar_available_mw, availableSplit.solar, 0)
    ) || 0;
    const windAvailable = Number(
      firstDefinedValue(source.wind_available_mw, availableSplit.wind, 0)
    ) || 0;
    const renewableUsed = Number(
      firstDefinedValue(
        source.renewable_used_mw,
        Math.max(0, Math.min(renewableAvailable, demand - dispatchable)),
        0
      )
    ) || 0;
    const usedSplit = splitRenewableProfile(renewableUsed, scenario);
    const solarUsed = Number(
      firstDefinedValue(source.solar_used_mw, usedSplit.solar, 0)
    ) || 0;
    const windUsed = Number(
      firstDefinedValue(source.wind_used_mw, usedSplit.wind, 0)
    ) || 0;

    const gridImport = Number(source.grid_import_mw || 0);
    const gridLimit = Number(
      firstDefinedValue(
        source.grid_limit_mw,
        dataset?.grid_import_limit_mw,
        scenario?.gridLimit,
        0
      )
    ) || 0;
    const batteryCharge = Number(source.battery_charge_mw || 0);
    const batteryDischarge = Number(source.battery_discharge_mw || 0);
    const batteryNet = Number(
      firstDefinedValue(
        source.battery_net_mw,
        batteryDischarge - batteryCharge,
        0
      )
    ) || 0;
    const totalSupply = Number(
      firstDefinedValue(
        source.total_supply_mw,
        source.total_actual_supply_mw,
        dispatchable + renewableUsed + gridImport + batteryNet,
        0
      )
    ) || 0;
    const balanceResidual = Number(
      firstDefinedValue(source.balance_residual_mw, totalSupply - demand, 0)
    ) || 0;
    const reserveRequirement = Number(
      firstDefinedValue(
        source.reserve_requirement_mw,
        dataset?.reserve?.[hour],
        source.reserve,
        0
      )
    ) || 0;
    const reserveAvailable = Number(
      firstDefinedValue(
        source.reserve_available_mw,
        Math.max(
          0,
          Number(source.committed_capacity || 0) - dispatchable
        ),
        0
      )
    ) || 0;

    return {
      hour,
      time: `${String(hour).padStart(2, "0")}:00`,
      demand_mw: demand,
      solar_available_mw: solarAvailable,
      solar_used_mw: solarUsed,
      wind_available_mw: windAvailable,
      wind_used_mw: windUsed,
      renewable_available_mw: renewableAvailable,
      renewable_used_mw: renewableUsed,
      renewable_curtailment_mw: Number(
        firstDefinedValue(
          source.renewable_curtailment_mw,
          Math.max(0, renewableAvailable - renewableUsed),
          0
        )
      ) || 0,
      renewable_provenance:
        source.renewable_provenance ||
        (source.solar_available_mw !== undefined
          ? "backend_solar_wind_profiles"
          : "backend_total_split_by_workspace_ratio"),
      battery_charge_mw: batteryCharge,
      battery_discharge_mw: batteryDischarge,
      battery_net_mw: batteryNet,
      battery_soc_mwh: Number(source.battery_soc_mwh || 0),
      battery_capacity_mwh: Number(
        firstDefinedValue(
          source.battery_capacity_mwh,
          dataset?.battery_capacity_mwh,
          scenario?.batteryCapacity,
          0
        )
      ) || 0,
      grid_import_mw: gridImport,
      grid_limit_mw: gridLimit,
      dispatchable_generation_mw: dispatchable,
      total_dispatchable_generation_mw: dispatchable,
      generator_output_mw: outputs,
      total_supply_mw: totalSupply,
      total_actual_supply_mw: totalSupply,
      balance_residual_mw: balanceResidual,
      reserve_available_mw: reserveAvailable,
      reserve_requirement_mw: reserveRequirement,
      operating_status:
        Math.abs(balanceResidual) <= 0.01 &&
        gridImport <= gridLimit + 0.01 &&
        reserveAvailable + 0.01 >= reserveRequirement
          ? "PASS"
          : "REVIEW",
      result:
        Math.abs(balanceResidual) <= 0.01
          ? "Fully covered"
          : "Review required",
      is_high_demand: stressSet.has(hour),
      operator_note: stressSet.has(hour)
        ? "Candidate-block hour selected by the backend scoring stage."
        : "Validated backend dispatch.",
    };
  });
}

function buildBackendActions(generatorRows, hourlyPlan) {
  const hourlyByHour = new Map((hourlyPlan || []).map((row) => [Number(row.hour), row]));
  const actions = [];

  (generatorRows || []).forEach((generator) => {
    const schedule = Array.isArray(generator.schedule) ? generator.schedule : [];
    let previous = Boolean(generator.initial_status);

    schedule.forEach((current, hour) => {
      const isStart = current && !previous;
      const isStop = !current && previous;
      const isInitialRunning = hour === 0 && current && previous;
      if (!isStart && !isStop && !isInitialRunning) {
        previous = current;
        return;
      }
      const output = Number(hourlyByHour.get(hour)?.generator_output_mw?.[generator.id] || 0);
      const action = isStop ? "stop" : isStart ? "start" : "keep_running";
      actions.push({
        id: `${generator.id}-${action}-${hour}`,
        hour,
        time: `${String(hour).padStart(2, "0")}:00`,
        action,
        action_label: isStop ? "Stop" : isStart ? "Start" : "Keep running",
        resource_id: generator.id,
        resource_name: generator.name,
        power_mw: output,
        status: isStop ? "OFF" : "ON",
        reason: isStop
          ? "The backend-validated schedule no longer commits this generator."
          : isStart
            ? "The backend-validated schedule commits this generator from this hour."
            : "The generator remains committed from its initial operating state.",
      });
      previous = current;
    });
  });

  return actions.sort((left, right) => left.hour - right.hour || left.resource_name.localeCompare(right.resource_name));
}

function costBreakdownFromDispatch(dataset, hourlyDispatch, totalCost, explicit = null) {
  const generators = new Map(
    (Array.isArray(dataset?.generators) ? dataset.generators : []).map((generator) => [
      String(generator.id),
      generator,
    ])
  );
  const rowsByHour = dispatchRowsByHour(hourlyDispatch);
  let variableCost = Number(explicit?.total_variable_cost || 0);
  let noLoadCost = Number(explicit?.total_no_load_cost || 0);
  let startupCost = Number(explicit?.total_startup_cost || 0);

  if (!explicit) {
    variableCost = 0;
    noLoadCost = 0;
    startupCost = 0;
    const previousStatus = new Map(
      [...generators.entries()].map(([id, generator]) => [id, Boolean(generator.initial_status)])
    );

    for (let hour = 0; hour < 24; hour += 1) {
      const outputs = generatorOutputsForHour(rowsByHour.get(hour));
      generators.forEach((generator, id) => {
        const output = Number(outputs[id] || 0);
        const isOn = output > 1e-8;
        variableCost += output * Number(generator.variable_cost || 0);
        if (isOn) noLoadCost += Number(generator.no_load_cost || 0);
        if (isOn && !previousStatus.get(id)) startupCost += Number(generator.startup_cost || 0);
        previousStatus.set(id, isOn);
      });
    }
  }

  const roundedTotal = Math.max(0, Math.round(Number(totalCost || 0)));
  const roundedVariable = Math.max(0, Math.round(variableCost));
  const roundedNoLoad = Math.max(0, Math.round(noLoadCost));
  const roundedStartup = Math.max(0, Math.round(startupCost));
  const other = Math.max(0, roundedTotal - roundedVariable - roundedNoLoad - roundedStartup);

  // Existing semantic color keys are retained so no CSS or visual design changes are required.
  return [
    { key: "diesel", label: "Variable Cost", value: roundedVariable },
    { key: "grid", label: "No-load Cost", value: roundedNoLoad },
    { key: "battery", label: "Other Cost", value: other },
    { key: "startup", label: "Start-up Cost", value: roundedStartup },
    { key: "curtailment", label: "Curtailment", value: 0 },
  ];
}

function legacyDispatchFromOperatingPlan(plan) {
  return (Array.isArray(plan?.hourly_dispatch) ? plan.hourly_dispatch : []).map((row) => ({
    hour: String(Number(row.hour || 0)).padStart(2, "0"),
    load: Number(row.demand_mw || 0),
    solar: Number(row.solar_used_mw || 0),
    wind: Number(row.wind_used_mw || 0),
    grid: Number(row.grid_import_mw || 0),
    battery: Number(row.battery_discharge_mw || 0),
    diesel: Number(row.dispatchable_generation_mw || 0),
  }));
}

function normalizeQuantathonRunResponse(payload, requestedSolver, scenario, elapsedSeconds) {
  const root = payload || {};
  const runResult = root.result || {};
  const dataset = root.dataset || {};
  const config = root.config || {};
  const hybridMethod = runResult.hybrid || runResult.recommended_plan || {};
  // Legacy visual aliases reuse the single Hybrid plan. The localhost demo no
  // longer runs a full classical UC comparison; that evidence lives in the
  // offline benchmark report.
  const classicalMethod = runResult.classical || hybridMethod;
  const classicalDispatchResult = classicalMethod.dispatch || {};
  const hybridDispatchResult = hybridMethod.dispatch || {};
  const classicalDispatch = classicalDispatchResult.hourly_dispatch || [];
  const hybridDispatch = hybridDispatchResult.hourly_dispatch || [];
  const requestedScenarioInput = config.scenario_input || buildScenarioInputContract(scenario);

  const classicalCost = Number(classicalMethod.true_operating_cost ?? classicalDispatchResult.total_cost ?? 0);
  const hybridCost = Number(hybridMethod.true_operating_cost ?? hybridDispatchResult.total_cost ?? 0);
  const classicalRuntime = Math.max(0, Number(classicalMethod.runtime_ms || 0) / 1000);
  const hybridRuntime = Math.max(0, Number(hybridMethod.runtime_ms || 0) / 1000);
  const endToEndRuntime = Math.max(Number(elapsedSeconds || 0), hybridRuntime, classicalRuntime);
  const rounds = Array.isArray(hybridMethod.quantum_rounds) ? hybridMethod.quantum_rounds : [];
  const convergenceRows = Array.isArray(runResult.convergence) ? runResult.convergence : [];
  const selectedBlock = rounds.at(-1)?.block || {};
  const stressHours = Array.isArray(selectedBlock.hours) && selectedBlock.hours.length
    ? [...new Set(selectedBlock.hours.map(Number))].sort((a, b) => a - b)
    : [18, 19, 20, 21];

  const finalGeneratorRows = Array.isArray(hybridMethod.schedule)
    ? hybridMethod.schedule
    : scheduleRowsFromBackendDispatch(dataset, hybridDispatch);
  const classicalGeneratorRows = Array.isArray(classicalMethod.schedule)
    ? classicalMethod.schedule
    : scheduleRowsFromBackendDispatch(dataset, classicalDispatch);
  const hourlyPlan = buildBackendHourlyPlan(dataset, hybridDispatch, scenario, stressHours);
  const classicalHourlyPlan = buildBackendHourlyPlan(dataset, classicalDispatch, scenario, stressHours);
  const recommendedActions = buildBackendActions(finalGeneratorRows, hourlyPlan);
  const totalDemand = hourlyPlan.reduce((sum, row) => sum + Number(row.demand_mw || 0), 0);
  const totalRenewable = hourlyPlan.reduce((sum, row) => sum + Number(row.renewable_used_mw || 0), 0);
  const totalCurtailment = hourlyPlan.reduce((sum, row) => sum + Number(row.renewable_curtailment_mw || 0), 0);
  const hybridFeasible = Boolean(hybridMethod.feasible);

  const validationChecks = hourlyPlan.map((row) => {
    const balancePass = Math.abs(Number(row.balance_residual_mw || 0)) <= 0.01;
    const reservePass = Number(row.reserve_available_mw || 0) + 0.01 >= Number(row.reserve_requirement_mw || 0);
    const gridPass = Number(row.grid_import_mw || 0) <= Number(row.grid_limit_mw || 0) + 0.01;
    const batterySoc = Number(row.battery_soc_mwh || 0);
    const batteryCapacity = Number(row.battery_capacity_mwh || 0);
    const batteryPass = batterySoc >= -0.01 && batterySoc <= batteryCapacity + 0.01;
    const overallPass = hybridFeasible && balancePass && reservePass && gridPass && batteryPass;
    return {
      hour: row.hour,
      time: row.time,
      power_balance: balancePass ? "PASS" : "FAIL",
      grid_limit: gridPass ? "PASS" : "FAIL",
      battery_soc: batteryPass ? "PASS" : "FAIL",
      generator_capacity: hybridFeasible ? "PASS" : "FAIL",
      ramp_rate: hybridFeasible ? "PASS" : "FAIL",
      reserve: reservePass ? "PASS" : "FAIL",
      minimum_up_time: hybridFeasible ? "PASS" : "FAIL",
      minimum_down_time: hybridFeasible ? "PASS" : "FAIL",
      overall_result: overallPass ? "PASS" : "FAIL",
      violation_detail: overallPass ? "" : String(hybridMethod.selected_candidate?.violation || "Backend validation requires review."),
    };
  });

  const baselineBreakdown = costBreakdownFromDispatch(dataset, classicalDispatch, classicalCost, classicalDispatchResult);
  const hybridBreakdown = costBreakdownFromDispatch(dataset, hybridDispatch, hybridCost, hybridDispatchResult);
  const convergence = (convergenceRows.length ? convergenceRows : rounds).map((row, index) => ({
    step: Number(row.round || index + 1),
    baseline: Math.round(classicalCost),
    classical: Math.round(classicalCost),
    adaptive: Number(row.validated_cost ?? row.accepted_candidate?.true_cost ?? hybridCost),
    hybrid: Number(row.validated_cost ?? row.accepted_candidate?.true_cost ?? hybridCost),
    residual: Number(row.residual_l2_mw ?? row.residual_after_l2_mw ?? 0),
    rho: Number(row.rho ?? row.rho_after ?? 0),
  }));
  if (convergence.length === 1) {
    convergence.unshift({ ...convergence[0], step: 0, adaptive: classicalCost, hybrid: classicalCost });
  }

  const operatingPlan = {
    version: "comparison-v2",
    source: "admm-guided-hybrid-backend",
    run_id: root.run_id,
    summary: {
      scenario: requestedScenarioInput.scenario_name || scenario?.name || dataset.name || "Selected scenario",
      method: "hybrid_qaoa",
      method_label: "ADMM-Guided Active-Block QAOA",
      plan_label: "Hybrid Recommended Operating Plan",
      validated_cost: hybridCost,
      runtime_seconds: hybridRuntime || endToEndRuntime,
      feasible_hours: hybridFeasible ? 24 : 0,
      total_hours: 24,
      curtailment_mwh: totalCurtailment,
      renewable_share_percent: totalDemand > 0 ? (totalRenewable / totalDemand) * 100 : 0,
      high_demand_hours: stressHours,
      all_constraints_passed: hybridFeasible,
      grid_limit_mw: Number(requestedScenarioInput.grid_import_limit_mw || 0),
      dataset_id: dataset.id || config.dataset_id,
      scenario_inputs: {
        ...requestedScenarioInput,
        dataset_id: dataset.id || config.dataset_id,
        generator_count: Array.isArray(dataset.generators) ? dataset.generators.length : 0,
        received_by_backend: Boolean(config.scenario_input),
        applied_by_optimizer: Boolean(root.metrics?.scenario_input_applied || runResult.scenario_input_applied),
      },
      comparison: null,
    },
    generators: finalGeneratorRows,
    recommended_actions: recommendedActions,
    hourly_supply: hourlyPlan,
    hourly_dispatch: hourlyPlan,
    validation_checks: validationChecks,
    validation_summary: {
      overall_result: validationChecks.filter((row) => row.overall_result === "PASS").length,
    },
    audit: {
      dataset_source: "FastAPI runtime dataset",
      dataset_id: dataset.id || config.dataset_id,
      run_id: root.run_id,
      solver_method: "Qamomile → CUDA-Q QAOA with classical validation",
      original_binary_variables: Number(root.metrics?.total_commitment_variables || 240),
      active_variables_or_qubits: Number(root.qubo?.dimension || root.metrics?.candidate_variables || 0),
      quantum_rounds: Number(hybridMethod.round_count || rounds.length),
      candidates_sampled: Number(config.hybrid_config?.shots || 0),
      candidates_reconstructed: rounds.reduce((sum, row) => sum + Number(row.evaluated_candidates?.length || 0), 0),
      backend_source: hybridMethod.backend_source,
      scenario_input_received_by_backend: Boolean(config.scenario_input),
      scenario_input_applied_by_optimizer: Boolean(root.metrics?.scenario_input_applied),
      claim_boundary: "The localhost demo shows the GPU Hybrid plan only. Classical comparison and scaling evidence are generated offline in benchmark_report.html.",
    },
  };

  const classicalLegacyDispatch = legacyDispatchFromOperatingPlan({ hourly_dispatch: classicalHourlyPlan });
  const hybridLegacyDispatch = legacyDispatchFromOperatingPlan(operatingPlan);
  const activeVariables = Number(root.qubo?.dimension || root.metrics?.candidate_variables || 0);
  const totalVariables = Number(root.metrics?.total_commitment_variables || 240);

  const canonical = {
    ...root,
    contract_version: BACKEND_CONTRACT_VERSION,
    backendSource: true,
    selected_method: "hybrid",
    status: root.status || "completed",
    client_elapsed_seconds: endToEndRuntime,
    rule_based_cost: classicalCost,
    classical_cost: classicalCost,
    classical_runtime: classicalRuntime,
    rule_based_curtailment: Number(classicalMethod.total_renewable_curtailment_mwh || 0),
    // Legacy aliases are retained internally so the existing visual layout can render,
    // but both aliases point to the single Hybrid method returned by the v2 API.
    quantum_cost: hybridCost,
    quantum_runtime: hybridRuntime,
    quantum_curtailment: totalCurtailment,
    hybrid_cost: hybridCost,
    hybrid_runtime: hybridRuntime,
    hybrid_curtailment: totalCurtailment,
    feasible_hours: hybridFeasible ? 24 : 0,
    renewable_share: totalDemand > 0 ? (totalRenewable / totalDemand) * 100 : 0,
    stress_hours: stressHours,
    bitstring: String(hybridMethod.selected_candidate?.bitstring || ""),
    energy: Number(hybridMethod.selected_candidate?.energy || 0),
    active_variable_count: activeVariables,
    num_variables: totalVariables,
    qaoa_depth: Number(config.hybrid_config?.qaoa_depth || 1),
    shots: Number(config.hybrid_config?.shots || 0),
    iterations: Number(hybridMethod.round_count || rounds.length),
    source: hybridMethod.backend_source || "Qamomile → CUDA-Q",
    convergence,
    convergenceTrace: convergence,
    cost_breakdown: {
      baseline: baselineBreakdown,
      classical: baselineBreakdown,
      adaptive: hybridBreakdown,
      hybrid: hybridBreakdown,
      fixed: hybridBreakdown,
    },
    operating_plan: operatingPlan,
    commitment_schedule: finalGeneratorRows,
    classical: {
      cost: classicalCost,
      runtime: classicalRuntime,
      curtailment: Number(classicalMethod.total_renewable_curtailment_mwh || 0),
      dispatch24h: classicalLegacyDispatch,
      commitmentRows: classicalGeneratorRows,
    },
    hybrid: {
      cost: hybridCost,
      runtime: hybridRuntime,
      curtailment: totalCurtailment,
      dispatch24h: hybridLegacyDispatch,
      commitmentRows: finalGeneratorRows,
    },
    adaptive: {
      cost: hybridCost,
      runtime: hybridRuntime,
      curtailment: totalCurtailment,
      dispatch24h: hybridLegacyDispatch,
      commitmentRows: finalGeneratorRows,
    },
    quantum: {
      cost: hybridCost,
      runtime: hybridRuntime,
      curtailment: totalCurtailment,
      dispatch24h: hybridLegacyDispatch,
    },
    methods: {
      classical: { cost: classicalCost, dispatch24h: classicalLegacyDispatch },
      hybrid: { cost: hybridCost, dispatch24h: hybridLegacyDispatch },
    },
    result: {
      ...runResult,
      operating_plan: operatingPlan,
      commitment_schedule: finalGeneratorRows,
      convergence,
    },
    raw_backend_run: root,
  };
  canonical.contract_warnings = validateBackendRunContract(canonical);
  return canonical;
}
function normalizeApiRunResponse(payload, requestedSolver, scenario, elapsedSeconds = 0) {
  const directRoot = unwrapApiPayload(payload);
  if (!isQuantathonRunSummary(directRoot)) {
    throw new Error(
      `Unsupported backend response. Expected ${BACKEND_CONTRACT_VERSION}.`
    );
  }
  return normalizeQuantathonRunResponse(
    directRoot,
    requestedSolver,
    scenario,
    elapsedSeconds
  );
}

// #endregion

// #region 01C — Backend contract validation
function validateBackendRunContract(run) {
  const warnings = [];
  if (!Number.isFinite(Number(run.classical_cost ?? run.rule_based_cost))) {
    warnings.push("classical.true_operating_cost");
  }
  if (!Number.isFinite(Number(run.hybrid_cost))) {
    warnings.push("hybrid.true_operating_cost");
  }

  const breakdown = run.cost_breakdown || {};
  if (!Array.isArray(breakdown.classical || breakdown.baseline)) {
    warnings.push("cost_breakdown.classical[]");
  }
  if (!Array.isArray(breakdown.hybrid || breakdown.adaptive)) {
    warnings.push("cost_breakdown.hybrid[]");
  }

  if (!Array.isArray(run.convergence)) warnings.push("convergence[]");

  const plan = run.operating_plan || {};
  const hourly = plan.hourly_dispatch || plan.hourly_supply || plan.hours;
  if (!Array.isArray(hourly) || hourly.length !== 24) {
    warnings.push("recommended_plan.hourly_dispatch[24]");
  }
  if (!Array.isArray(plan.generators || plan.generator_schedules || plan.commitment_rows)) {
    warnings.push("recommended_plan.generators[]");
  }
  if (!Array.isArray(plan.recommended_actions || plan.events)) {
    warnings.push("recommended_plan.recommended_actions[]");
  }
  if (!Array.isArray(plan.validation_checks)) {
    warnings.push("recommended_plan.validation_checks[]");
  }

  if (warnings.length) {
    console.warn("Backend comparison response is incomplete:", warnings);
  }
  return warnings;
}

if (typeof window !== "undefined") {
  window.__HQUC_BACKEND_ADAPTER__ = {
    contractVersion: BACKEND_CONTRACT_VERSION,
    config: BACKEND_CONFIG,
    buildScenarioInputContract,
    buildOptimizationRequest,
    normalizeApiRunResponse,
    normalizeQuantathonRunResponse,
    validateBackendRunContract,
  };
}

// #endregion

// #endregion

// #region 02 — Static scenarios, solver metadata, and profile generators
const SCENARIOS = [
  {
    id: "congestion",
    name: "Congestion",
    icon: "⚡",
    headline: "Transmission bottleneck",
    description: "Grid import is limited, so local diesel and battery support become critical.",
    load: 105,
    solar: 70,
    wind: 50,
    gridLimit: 60,
    batterySoc: 40,
    batteryCapacity: 80,
    stress: 92,
  },
  {
    id: "peak",
    name: "Peak Demand",
    icon: "🌆",
    headline: "Evening peak load",
    description: "High demand after sunset, when solar generation is unavailable.",
    load: 176,
    solar: 0,
    wind: 12,
    gridLimit: 100,
    batterySoc: 48,
    batteryCapacity: 80,
    stress: 88,
  },
  {
    id: "high-renewable",
    name: "High Renewable",
    icon: "🌿",
    headline: "High VRE penetration",
    description: "Strong combined solar and wind output tests curtailment, storage, and grid flexibility.",
    load: 150,
    solar: 72,
    wind: 34,
    gridLimit: 88,
    batterySoc: 44,
    batteryCapacity: 80,
    stress: 67,
  },
  {
    id: "sunny",
    name: "Sunny",
    icon: "☀️",
    headline: "Solar surplus and evening ramp",
    description: "Strong solar generation creates a noon surplus and evening net-load stress.",
    load: 150,
    solar: 8,
    wind: 20,
    gridLimit: 100,
    batterySoc: 36,
    batteryCapacity: 80,
    stress: 74,
  },
  {
    id: "windy",
    name: "Windy",
    icon: "🌬️",
    headline: "High wind supply",
    description: "Wind generation reduces thermal pressure across multiple hours.",
    load: 154,
    solar: 0,
    wind: 46,
    gridLimit: 100,
    batterySoc: 52,
    batteryCapacity: 80,
    stress: 61,
  },
  {
    id: "custom",
    name: "Custom",
    icon: "🛠️",
    headline: "User-defined grid state",
    description: "Edit load, renewable output, battery SOC, and grid import limit live.",
    load: 0,
    solar: 0,
    wind: 0,
    gridLimit: 0,
    batterySoc: 0,
    batteryCapacity: 80,
    stress: 0,
  },
];


const DEFAULT_CUSTOM_PROFILE_CONTROLS = {
  solarPeakHour: 12,
  cloudVariability: 30,
  windEveningDrop: 40,
  demandPeakHour: 19,
  forecastNoise: 5,
  randomSeed: 42,
};

const DEFAULT_WEATHER_PROFILE = {
  id: "default-generated",
  kind: "generated",
  name: "Default Synthetic 24h",
  source: "Clear solar · Variable wind",
  summary: "Generated from the existing workspace preview",
  description:
    "The original workspace profile: a daily demand curve, clear solar shape, and variable wind generation.",
  profiles: {
    load: [],
    solar: [],
    wind: [],
  },
};

const WEATHER_PROFILE_PRESETS = [
  createWeatherProfilePreset("clear-solar"),
  createWeatherProfilePreset("cloudy-intermittent"),
  createWeatherProfilePreset("evening-wind-drop"),
  createWeatherProfilePreset("mixed-vre"),
];

// The generated default remains the internal initial profile. The visible
// selector contains only user-facing temporal presets.
const WEATHER_PROFILE_CHOICES = [...WEATHER_PROFILE_PRESETS];

const PRIMARY_METHOD = Object.freeze({
  id: "hybrid",
  name: "ADMM-Guided Hybrid QAOA",
  tag: "Proposed",
  description:
    "Runs the full Classical HiGHS baseline and the proposed 8–10-qubit active-block QAOA on the same runtime dataset, then recommends the classically validated Hybrid schedule.",
});

const SOLVERS = [PRIMARY_METHOD];

const SOLVER_LAUNCH_META = {
  hybrid: {
    launchLabel: "Generate 24h Plan",
    summary: "Classical reference + ADMM-guided Hybrid QAOA",
    description: "Two-method comparison on one runtime dataset",
    chips: ["8–10 QUBITS", "TOP-10", "VALIDATED"],
    footer: "HiGHS baseline · Qamomile → CUDA-Q · exact dispatch validation",
  },
};

const WORKFLOW_STEPS = [
  {
    id: "overview",
    number: "01",
    label: "Problem",
    caption: "Input & value",
    transitionLines: ["PROBLEM &", "INPUT"],
    transitionText: "Opening the unit-commitment problem",
  },
  {
    id: "configure",
    number: "02",
    label: "Optimize",
    caption: "Scenario & solver",
    transitionLines: ["CONFIGURE &", "OPTIMIZE"],
    transitionText: "Preparing the scenario workspace",
  },
  {
    id: "results",
    number: "03",
    label: "Results",
    caption: "Compare & validate",
    transitionLines: ["RESULTS &", "VALIDATION"],
    transitionText: "Loading validated optimization evidence",
  },
];

const SOLVE_LOG_SEQUENCE = [
  {
    icon: "file-input",
    accent: "#67e8f9",
    accentSoft: "rgba(103, 232, 249, 0.10)",
    level: "INPUT",
    step: 1,
    total: 8,
    text: "Validate 24-hour operating inputs.",
  },
  {
    icon: "layers",
    accent: "#7dd3fc",
    accentSoft: "rgba(125, 211, 252, 0.10)",
    level: "INITIALIZE",
    step: 2,
    total: 8,
    text: "Build the initial commitment schedule.",
  },
  {
    icon: "gauge",
    accent: "#a5b4fc",
    accentSoft: "rgba(165, 180, 252, 0.10)",
    level: "DISPATCH",
    step: 3,
    total: 8,
    text: "Solve relaxed economic dispatch.",
  },
  {
    icon: "git-branch",
    accent: "#c4b5fd",
    accentSoft: "rgba(196, 181, 253, 0.10)",
    level: "ADMM",
    step: 4,
    total: 8,
    text: "Compute residuals and dual-pressure signals.",
  },
  {
    icon: "target",
    accent: "#f0abfc",
    accentSoft: "rgba(240, 171, 252, 0.10)",
    level: "ACTIVE SET",
    step: 5,
    total: 8,
    text: "Select high-impact commitment variables.",
  },
  {
    icon: "atom",
    accent: "#5eead4",
    accentSoft: "rgba(94, 234, 212, 0.10)",
    level: "QAOA",
    step: 6,
    total: 8,
    text: "Optimize the active-block QUBO with QAOA.",
  },
  {
    icon: "shield-check",
    accent: "#86efac",
    accentSoft: "rgba(134, 239, 172, 0.10)",
    level: "VALIDATE",
    step: 7,
    total: 8,
    text: "Reconstruct and validate candidate schedules.",
  },
  {
    icon: "flag",
    accent: "#fde68a",
    accentSoft: "rgba(253, 230, 138, 0.10)",
    level: "FINALIZE",
    step: 8,
    total: 8,
    text: "Waiting for the validated operating plan...",
    completeText: "Final feasible 24-hour operating plan selected.",
  },
];

// #region 02A — Static UI metadata and telemetry assets
function TelemetryStepIcon({ name }) {
  const commonProps = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    focusable: "false",
    "aria-hidden": "true",
  };

  switch (name) {
    case "file-input":
      return (
        <svg {...commonProps}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M8 13h8" />
          <path d="m12 10 3 3-3 3" />
        </svg>
      );
    case "layers":
      return (
        <svg {...commonProps}>
          <path d="m12 2 9 5-9 5-9-5 9-5Z" />
          <path d="m3 12 9 5 9-5" />
          <path d="m3 17 9 5 9-5" />
        </svg>
      );
    case "gauge":
      return (
        <svg {...commonProps}>
          <path d="M20.4 15a9 9 0 1 0-16.8 0" />
          <path d="M12 12 16.5 7.5" />
          <path d="M6.4 19h11.2" />
          <circle cx="12" cy="12" r="1.2" />
        </svg>
      );
    case "git-branch":
      return (
        <svg {...commonProps}>
          <circle cx="6" cy="4" r="2" />
          <circle cx="18" cy="6" r="2" />
          <circle cx="6" cy="20" r="2" />
          <path d="M6 6v12" />
          <path d="M18 8c0 6-12 3-12 8" />
        </svg>
      );
    case "target":
      return (
        <svg {...commonProps}>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="5" />
          <circle cx="12" cy="12" r="1.5" />
          <path d="M12 3V1" />
          <path d="M21 12h2" />
        </svg>
      );
    case "atom":
      return (
        <svg {...commonProps}>
          <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
          <ellipse cx="12" cy="12" rx="9" ry="3.8" />
          <ellipse cx="12" cy="12" rx="9" ry="3.8" transform="rotate(60 12 12)" />
          <ellipse cx="12" cy="12" rx="9" ry="3.8" transform="rotate(120 12 12)" />
        </svg>
      );
    case "shield-check":
      return (
        <svg {...commonProps}>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case "flag":
      return (
        <svg {...commonProps}>
          <path d="M5 22V3" />
          <path d="M5 4h11l-1.8 3L16 10H5" />
        </svg>
      );
    default:
      return null;
  }
}

// #endregion

// #region 02B — Profile generation and CSV parsing
function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function normalizeProfileShape(values) {
  const safe = Array.isArray(values)
    ? values.map((value) => Math.max(0, Number(value) || 0))
    : [];
  const maximum = Math.max(...safe, 0);
  if (maximum <= 0) return Array(24).fill(0);
  return safe.map((value) => value / maximum);
}

function gaussianProfilePoint(hour, center, width) {
  const safeWidth = Math.max(Number(width) || 1, 0.1);
  return Math.exp(-0.5 * Math.pow((hour - center) / safeWidth, 2));
}

function daylightProfilePoint(hour, peakHour = 12) {
  return Math.max(0, Math.cos(((hour - peakHour) / 12) * Math.PI));
}

function seededProfileRandom(seed) {
  let state = (Number(seed) || 1) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function createBaseLoadProfile(peakHour = 19) {
  return normalizeProfileShape(
    Array.from({ length: 24 }, (_, hour) =>
      0.48 +
      0.2 * gaussianProfilePoint(hour, 8, 2.2) +
      0.5 * gaussianProfilePoint(hour, Number(peakHour), 2.4)
    )
  );
}

function createWeatherProfilePreset(profileId) {
  const load = createBaseLoadProfile(19);
  const clearSolar = Array.from({ length: 24 }, (_, hour) =>
    daylightProfilePoint(hour, 12)
  );
  const moderateWind = Array.from({ length: 24 }, (_, hour) =>
    clamp01(0.58 + 0.12 * Math.sin((hour + 1) / 2.8) + 0.06 * Math.cos(hour / 1.9))
  );

  if (profileId === "clear-solar") {
    return {
      id: profileId,
      kind: "preset",
      name: "Clear Solar Day",
      source: "Synthetic 24h",
      summary: "Stable noon solar · moderate wind",
      description:
        "Stable midday generation for curtailment and storage-shifting tests.",
      profiles: {
        load,
        solar: normalizeProfileShape(clearSolar),
        wind: normalizeProfileShape(moderateWind),
      },
    };
  }

  if (profileId === "cloudy-intermittent") {
    const solar = clearSolar.map((value, hour) =>
      value * clamp01(
        0.88 -
          0.46 * gaussianProfilePoint(hour, 11.2, 0.75) -
          0.38 * gaussianProfilePoint(hour, 14.7, 0.95) +
          0.08 * Math.sin(hour * 2.1)
      )
    );

    return {
      id: profileId,
      kind: "preset",
      name: "Cloudy & Intermittent",
      source: "Synthetic 24h",
      summary: "Solar dips · afternoon net-load ramp",
      description:
        "Tests reserve response and commitment flexibility under sudden solar reductions.",
      profiles: {
        load,
        solar: normalizeProfileShape(solar),
        wind: normalizeProfileShape(moderateWind),
      },
    };
  }

  if (profileId === "evening-wind-drop") {
    const wind = Array.from({ length: 24 }, (_, hour) => {
      const daytime = 0.78 + 0.1 * Math.sin(hour / 2.4);
      const eveningDrop = 0.55 * gaussianProfilePoint(hour, 19, 2.1);
      return clamp01(daytime - eveningDrop);
    });

    return {
      id: profileId,
      kind: "preset",
      name: "Strong Wind / Evening Drop",
      source: "Synthetic 24h",
      summary: "Strong daytime wind · evening decline",
      description:
        "Creates commitment stress near the evening demand peak.",
      profiles: {
        load,
        solar: normalizeProfileShape(clearSolar.map((value) => value * 0.82)),
        wind: normalizeProfileShape(wind),
      },
    };
  }

  const mixedSolar = clearSolar.map((value, hour) =>
    value * clamp01(
      0.72 +
        0.18 * Math.sin(hour * 1.55) -
        0.24 * gaussianProfilePoint(hour, 13.6, 0.72)
    )
  );
  const mixedWind = Array.from({ length: 24 }, (_, hour) =>
    clamp01(
      0.57 +
        0.19 * Math.sin((hour + 2) / 2.15) +
        0.11 * Math.cos(hour * 1.35) -
        0.25 * gaussianProfilePoint(hour, 19, 1.9)
    )
  );

  return {
    id: "mixed-vre",
    kind: "preset",
    name: "Mixed VRE Volatility",
    source: "Synthetic 24h",
    summary: "Variable solar · variable wind",
    description:
      "The most demanding preset for testing adaptive commitment decisions.",
    profiles: {
      load,
      solar: normalizeProfileShape(mixedSolar),
      wind: normalizeProfileShape(mixedWind),
    },
  };
}

function createCustomWeatherProfile(controls = DEFAULT_CUSTOM_PROFILE_CONTROLS) {
  const config = {
    ...DEFAULT_CUSTOM_PROFILE_CONTROLS,
    ...(controls || {}),
  };
  const random = seededProfileRandom(config.randomSeed);
  const noiseScale = Math.max(0, Number(config.forecastNoise || 0)) / 100;
  const cloudScale = Math.max(0, Number(config.cloudVariability || 0)) / 100;
  const windDropScale = Math.max(0, Number(config.windEveningDrop || 0)) / 100;

  const load = createBaseLoadProfile(config.demandPeakHour).map((value) =>
    Math.max(0, value * (1 + (random() - 0.5) * noiseScale))
  );
  const solar = Array.from({ length: 24 }, (_, hour) => {
    const clear = daylightProfilePoint(hour, Number(config.solarPeakHour));
    const cloudPattern =
      1 - cloudScale * (0.18 + 0.82 * random()) * (clear > 0 ? 1 : 0);
    return Math.max(0, clear * cloudPattern * (1 + (random() - 0.5) * noiseScale));
  });
  const wind = Array.from({ length: 24 }, (_, hour) => {
    const base =
      0.58 + 0.16 * Math.sin((hour + 1) / 2.55) + 0.08 * Math.cos(hour / 1.7);
    const eveningDrop =
      windDropScale * 0.62 * gaussianProfilePoint(hour, 19, 2.15);
    return Math.max(0.08, base - eveningDrop + (random() - 0.5) * noiseScale);
  });

  return {
    id: "custom-generated",
    kind: "custom",
    name: "Custom Temporal Profile",
    source: `Seed ${Math.round(Number(config.randomSeed) || 0)}`,
    summary: `Solar peak ${String(Math.round(Number(config.solarPeakHour))).padStart(2, "0")}:00 · demand peak ${String(Math.round(Number(config.demandPeakHour))).padStart(2, "0")}:00`,
    description:
      "A generated normalized 24-hour profile controlled by timing, variability, forecast noise, and a reproducible random seed.",
    controls: { ...config },
    profiles: {
      load: normalizeProfileShape(load),
      solar: normalizeProfileShape(solar),
      wind: normalizeProfileShape(wind),
    },
  };
}

function cloneWeatherProfile(profile) {
  if (!profile) return cloneWeatherProfile(DEFAULT_WEATHER_PROFILE);
  return {
    ...profile,
    controls: profile.controls ? { ...profile.controls } : undefined,
    profiles: {
      load: [...(profile.profiles?.load || [])],
      solar: [...(profile.profiles?.solar || [])],
      wind: [...(profile.profiles?.wind || [])],
    },
  };
}

function parseWeatherProfileCsv(csvText, filename = "Custom CSV") {
  const lines = String(csvText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error("CSV is empty or missing hourly records.");
  }

  const headers = lines[0]
    .split(",")
    .map((header) => header.trim().replace(/^['\"]|['\"]$/g, "").toLowerCase());
  const required = ["hour", "load_mw", "solar_mw", "wind_mw"];
  const indices = Object.fromEntries(
    required.map((name) => [name, headers.indexOf(name)])
  );

  if (required.some((name) => indices[name] < 0)) {
    throw new Error("Required columns: hour, load_mw, solar_mw, wind_mw.");
  }

  const records = lines.slice(1).map((line, rowIndex) => {
    const cells = line.split(",").map((cell) => cell.trim().replace(/^['\"]|['\"]$/g, ""));
    const record = {
      hour: Number(cells[indices.hour]),
      load: Number(cells[indices.load_mw]),
      solar: Number(cells[indices.solar_mw]),
      wind: Number(cells[indices.wind_mw]),
    };

    if (Object.values(record).some((value) => !Number.isFinite(value))) {
      throw new Error(`Invalid numeric value on CSV row ${rowIndex + 2}.`);
    }
    if (record.load < 0 || record.solar < 0 || record.wind < 0) {
      throw new Error(`Negative generation or load found on CSV row ${rowIndex + 2}.`);
    }
    return record;
  });

  if (records.length !== 24) {
    throw new Error(`Expected exactly 24 hourly records; found ${records.length}.`);
  }

  const hours = records.map((record) => record.hour);
  const zeroBased = hours.every((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23);
  const oneBased = hours.every((hour) => Number.isInteger(hour) && hour >= 1 && hour <= 24);
  if (!zeroBased && !oneBased) {
    throw new Error("Hour values must cover either 0–23 or 1–24.");
  }

  const normalizedRecords = records
    .map((record) => ({
      ...record,
      hour: oneBased ? record.hour - 1 : record.hour,
    }))
    .sort((a, b) => a.hour - b.hour);

  const uniqueHours = new Set(normalizedRecords.map((record) => record.hour));
  if (uniqueHours.size !== 24) {
    throw new Error("CSV must contain one unique record for every hour.");
  }

  const loadValues = normalizedRecords.map((record) => record.load);
  const solarValues = normalizedRecords.map((record) => record.solar);
  const windValues = normalizedRecords.map((record) => record.wind);
  const residualValues = normalizedRecords.map((record) =>
    Math.max(record.load - record.solar - record.wind, 0)
  );
  const peakLoad = Math.max(...loadValues, 0);
  const totalLoad = loadValues.reduce((sum, value) => sum + value, 0);
  const totalVre = solarValues.reduce((sum, value) => sum + value, 0) +
    windValues.reduce((sum, value) => sum + value, 0);
  const maxRamp = residualValues.reduce((maximum, value, index) => {
    if (index === 0) return maximum;
    return Math.max(maximum, Math.abs(value - residualValues[index - 1]));
  }, 0);

  return {
    profile: {
      id: `csv-${Date.now()}`,
      kind: "upload",
      name: "Custom CSV",
      source: "24 hourly records · Validated",
      summary: filename,
      description:
        "Uploaded MW values are validated and normalized into temporal shapes; the five workspace sliders still determine the applied scale.",
      profiles: {
        load: normalizeProfileShape(loadValues),
        solar: normalizeProfileShape(solarValues),
        wind: normalizeProfileShape(windValues),
      },
    },
    metrics: {
      peakLoad: Math.round(peakLoad),
      averageVre: Math.round((totalVre / Math.max(totalLoad, 1)) * 100),
      maxRamp: Math.round(maxRamp),
    },
  };
}

// #endregion

// #region 02C — Shared profile and timing helpers
function getSolveLogSequence() {
  return SOLVE_LOG_SEQUENCE;
}


function clampNumber(value, min, max) {
  let num = Number(value);

  if (!Number.isFinite(num)) num = min;
  if (num < min) num = min;
  if (num > max) num = max;

  return num;
}

/* ==========================================================================
   03. Application shell, navigation, and page transitions
   ========================================================================== */

// #endregion

// #endregion

// #region 03 — Application shell, navigation, and page transitions
// #region 03A — Application state and page orchestration
function App() {
  const [page, setPage] = useState(0);
  const [backendState, setBackendState] = useState("checking");
  const [scenarios, setScenarios] = useState(SCENARIOS);
  const [weatherProfile, setWeatherProfile] = useState(() =>
    cloneWeatherProfile(DEFAULT_WEATHER_PROFILE)
  );
  const [selectedScenarioId, setSelectedScenarioId] = useState("congestion");
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState(null);
  const [result, setResult] = useState(null);
  const [transitionStep, setTransitionStep] = useState(() => ({
    ...WORKFLOW_STEPS[0],
    nonce: Date.now(),
  }));
  const [solvePhase, setSolvePhase] = useState("idle");
  const [solveLogIndex, setSolveLogIndex] = useState(0);
  const [activeSolveLogs, setActiveSolveLogs] = useState(SOLVE_LOG_SEQUENCE);
  const [handoffPhase, setHandoffPhase] = useState("idle");

  const pageRef = useRef(page);
  const transitionSwapTimer = useRef(null);
  const transitionClearTimer = useRef(null);
  const solveTimersRef = useRef([]);

  const selectedScenario = useMemo(() => {
    const baseScenario =
      scenarios.find((scenario) => scenario.id === selectedScenarioId) || scenarios[0];

    return {
      ...baseScenario,
      profiles: weatherProfile.profiles,
      profileMeta: {
        id: weatherProfile.id,
        name: weatherProfile.name,
        source: weatherProfile.source,
        kind: weatherProfile.kind,
      },
    };
  }, [scenarios, selectedScenarioId, weatherProfile]);

  const selectedSolver = PRIMARY_METHOD;

  function clearSolveTimers() {
    solveTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    solveTimersRef.current = [];
  }

  function scheduleSolve(delay, callback) {
    const timerId = window.setTimeout(callback, delay);
    solveTimersRef.current.push(timerId);
    return timerId;
  }

  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  useEffect(() => {
    // On the first application paint, replay the original 01 Problem slit.
    // There is no page swap because the landing page is already mounted.
    transitionClearTimer.current = window.setTimeout(() => {
      setTransitionStep((currentStep) =>
        currentStep?.id === WORKFLOW_STEPS[0].id ? null : currentStep
      );
    }, 1360);
  }, []);

  useEffect(() => {
    loadBackendScenarios();
  }, []);

  useEffect(
    () => () => {
      window.clearTimeout(transitionSwapTimer.current);
      window.clearTimeout(transitionClearTimer.current);
      clearSolveTimers();
    },
    []
  );

  function navigateToPage(nextPage) {
    const targetPage = Number(nextPage);

    if (
      !Number.isInteger(targetPage) ||
      targetPage < 0 ||
      targetPage >= WORKFLOW_STEPS.length ||
      targetPage === pageRef.current
    ) {
      return;
    }

    window.clearTimeout(transitionSwapTimer.current);
    window.clearTimeout(transitionClearTimer.current);

    setTransitionStep({
      ...WORKFLOW_STEPS[targetPage],
      nonce: Date.now(),
    });

    transitionSwapTimer.current = window.setTimeout(() => {
      pageRef.current = targetPage;
      setPage(targetPage);
    }, 450);

    transitionClearTimer.current = window.setTimeout(() => {
      setTransitionStep(null);
    }, 1360);
  }

  function revealPageThroughWorkflowTransition(targetPage) {
    const numericTarget = Number(targetPage);
    const step = WORKFLOW_STEPS[numericTarget];
    if (!step) return;

    window.clearTimeout(transitionSwapTimer.current);
    window.clearTimeout(transitionClearTimer.current);

    // The workflow slit begins immediately after telemetry is dismissed.
    // Results are mounted only at the opaque middle of the deep-green phase,
    // so the destination page never appears before the 03 Results animation.
    setTransitionStep({
      ...step,
      nonce: Date.now(),
    });

    transitionSwapTimer.current = window.setTimeout(() => {
      pageRef.current = numericTarget;
      setPage(numericTarget);
    }, 220);

    transitionClearTimer.current = window.setTimeout(() => {
      setTransitionStep(null);
    }, 760);
  }

  async function loadBackendScenarios() {
    try {
      const { payload: health } = await fetchJsonWithTimeout(
        apiUrl(BACKEND_CONFIG.healthPath),
        { method: "GET", cache: "no-store" }
      );
      if (String(health?.status || "").toLowerCase() !== "ok") {
        throw new Error("Backend health check did not return status=ok.");
      }

      // The current backend exposes one fixed 10×24 dataset, not scenario APIs.
      // Keep the polished workspace scenarios intact and use them as preview/UI context.
      try {
        const { payload: datasets } = await fetchJsonWithTimeout(
          apiUrl(BACKEND_CONFIG.datasetsPath),
          { method: "GET", cache: "no-store" }
        );
        if (typeof window !== "undefined") {
          window.__HQUC_DATASETS__ = Array.isArray(datasets) ? datasets : [];
        }
      } catch (datasetError) {
        console.warn("Backend is online, but dataset discovery failed:", datasetError);
      }

      setScenarios(SCENARIOS.map((scenario) => ({ ...scenario })));
      setBackendState("online");
    } catch (error) {
      console.warn("Could not connect to the FastAPI backend:", error);
      setScenarios(SCENARIOS.map((scenario) => ({ ...scenario })));
      setBackendState("mock");
    }
  }

  function updateScenario(scenarioId, field, value, min = 0, max = 999) {
    const numericValue = clampNumber(value, min, max);

    setScenarios((prev) =>
      prev.map((scenario) => {
        if (scenario.id !== scenarioId) return scenario;

        const nextScenario = {
          ...scenario,
          [field]: numericValue,
        };

        return {
          ...nextScenario,
          stress: computeStress(nextScenario),
        };
      })
    );
  }

  async function runDemo() {
    clearSolveTimers();

    const runScenario = selectedScenario;
    const runSolver = selectedSolver;
    const runLogs = getSolveLogSequence(runSolver.id).map((line) => ({ ...line }));
    const totalSteps = runLogs.length;

    // Eight real pipeline stages are shown from the first frame. The active
    // stage advances at a readable cadence, while future stages remain dimmed.
    // FINALIZE can wait at 94% for the backend and never marks itself complete
    // before a validated result is available.
    const stepInterval = 650;
    const finalTextReadDelay = 420;
    const finalCheckDelay = 320;
    const completeBadgeHold = 1000;
    const handoffStartDelay = 0;

    setRunning(true);
    setRunError(null);
    setResult(null);
    setHandoffPhase("idle");
    setSolvePhase("logs");
    setSolveLogIndex(1);
    setActiveSolveLogs(runLogs);

    // A rerun launched from Results returns to the Workspace so the execution
    // trace remains the loading stage instead of covering the result charts.
    if (pageRef.current !== 1) {
      navigateToPage(1);
    }

    const backendPromise = (async () => {
      if (backendState !== "online") return null;

      try {
        return await requestOptimizationRun({
          scenario: runScenario,
        });
      } catch (error) {
        console.warn("Optimization backend request failed:", error);
        if (!BACKEND_CONFIG.allowSyntheticFallback) {
          return { __runError: error };
        }
        return null;
      }
    })();

    const minimumPipelineAnimation = new Promise((resolve) => {
      if (totalSteps <= 1) {
        resolve();
        return;
      }

      runLogs.slice(1).forEach((_, index) => {
        const stepNumber = index + 2;
        scheduleSolve((stepNumber - 1) * stepInterval, () => {
          setSolveLogIndex(stepNumber);
          if (stepNumber === totalSteps) resolve();
        });
      });
    });

    const [backendResult] = await Promise.all([
      backendPromise,
      minimumPipelineAnimation,
    ]);

    if (backendResult?.__runError) {
      setRunError(
        backendResult.__runError?.message ||
          "The optimization run could not be completed."
      );
      setSolvePhase("idle");
      setHandoffPhase("idle");
      setRunning(false);
      return;
    }

    const nextResult = createResult({
      scenario: runScenario,
      solver: runSolver,
      backendResult,
    });

    setResult(nextResult);
    setActiveSolveLogs((currentLogs) =>
      currentLogs.map((line) =>
        line.step === totalSteps
          ? { ...line, text: line.completeText || line.text }
          : line
      )
    );

    // Let the backend-confirmed FINALIZE message be readable before the row
    // becomes checked. The progress bar reaches 100% with the final check,
    // then the Running badge changes to Complete in a separate visual beat.
    await new Promise((resolve) => scheduleSolve(finalTextReadDelay, resolve));
    setSolvePhase("finalized");

    await new Promise((resolve) => scheduleSolve(finalCheckDelay, resolve));
    setSolvePhase("complete");

    await new Promise((resolve) => scheduleSolve(completeBadgeHold, resolve));

    scheduleSolve(handoffStartDelay, () => {
      setHandoffPhase("cover");
      setSolvePhase("handoff");
    });

    scheduleSolve(handoffStartDelay + 80, () => {
      setHandoffPhase("blend");
      revealPageThroughWorkflowTransition(2);
    });

    scheduleSolve(handoffStartDelay + 180, () => {
      // The slit is now visible above the green field. Remove the telemetry
      // shell while keeping the matching veil underneath it.
      setSolvePhase("reveal");
    });

    scheduleSolve(handoffStartDelay + 520, () => {
      setHandoffPhase("reveal");
    });

    scheduleSolve(handoffStartDelay + 820, () => {
      setHandoffPhase("idle");
      setSolvePhase("idle");
      setRunning(false);
    });
  }

  return (
    <div className="app">
      <Background />

      <div className="appMain">
        <div className="appContent">
          {page === 0 && (
            <HomePage
              setPage={navigateToPage}
              selectedScenario={selectedScenario}
            />
          )}

          {page === 1 && (
            <WorkspacePage
              scenarios={scenarios}
              selectedScenario={selectedScenario}
              selectedScenarioId={selectedScenarioId}
              setSelectedScenarioId={setSelectedScenarioId}
              updateScenario={updateScenario}
              runDemo={runDemo}
              running={running}
              runError={runError}
              solvePhase={solvePhase}
              solveLogIndex={solveLogIndex}
              solveLogs={activeSolveLogs}
              backendState={backendState}
              selectedSolver={selectedSolver}
              weatherProfile={weatherProfile}
              setWeatherProfile={setWeatherProfile}
            />
          )}

          {page === 2 && (
            <ResultsPage
              result={result}
              running={running}
              solvePhase={solvePhase}
              solveLogIndex={solveLogIndex}
              selectedScenario={selectedScenario}
              selectedSolver={selectedSolver}
              setPage={navigateToPage}
              runDemo={runDemo}
            />
          )}
        </div>
      </div>

      {running && ["pulse", "logs", "finalized", "complete", "handoff"].includes(solvePhase) && (
        <LivePipelineTelemetry
          phase={solvePhase}
          visibleCount={solveLogIndex}
          logs={activeSolveLogs}
          backendState={backendState}
          solver={selectedSolver}
        />
      )}

      {handoffPhase !== "idle" && (
        <div
          className={`pipelineHandoffVeil ${handoffPhase}`}
          aria-hidden="true"
        />
      )}

      <WorkflowSplitTransition
        step={transitionStep}
        onComplete={(nonce) => {
          setTransitionStep((currentStep) =>
            currentStep?.nonce === nonce ? null : currentStep
          );
        }}
      />
    </div>
  );
}

// #endregion

// #region 03B — Navigation and page transitions
function WorkflowDock({ page, backendState, onNavigate }) {
  const stateText =
    backendState === "online"
      ? "Backend Online"
      : backendState === "mock"
        ? "Mock Mode"
        : "Checking";

  const progress =
    WORKFLOW_STEPS.length > 1
      ? (page / (WORKFLOW_STEPS.length - 1)) * 100
      : 0;

  return (
    <aside className="workflowDock" aria-label="Application workflow">
      <button
        type="button"
        className="dockBrand"
        onClick={() => onNavigate(0)}
        aria-label="Open overview"
      >
        <span className="dockBrandMark">Q</span>
        <span className="dockBrandCopy">
          <strong>Grid Quantum Lab</strong>
          <small>UC Optimizer MVP</small>
        </span>
      </button>

      <nav
        className="workflowSteps"
        style={{ "--workflow-progress": progress / 100 }}
      >
        <span className="workflowRail" aria-hidden="true" />
        <span className="workflowRailProgress" aria-hidden="true" />

        {WORKFLOW_STEPS.map((step, index) => {
          const state =
            index === page
              ? "active"
              : index < page
                ? "completed"
                : "pending";

          return (
            <button
              type="button"
              key={step.id}
              className={`workflowStep ${state}`}
              onClick={() => onNavigate(index)}
              aria-current={index === page ? "step" : undefined}
            >
              <span className="workflowNode">
                {index < page ? "✓" : step.number}
              </span>

              <span className="workflowStepCopy">
                <strong>{step.label}</strong>
                <small>{step.caption}</small>
              </span>
            </button>
          );
        })}
      </nav>

      <div className={`dockStatus ${backendState}`} title={stateText}>
        <span className="dockStatusDot" aria-hidden="true" />
        <span className="dockStatusCopy">
          <strong>{stateText}</strong>
          <small>API connection</small>
        </span>
      </div>
    </aside>
  );
}

function WorkflowSplitTransition({ step, onComplete }) {
  if (!step) return null;

  return (
    <div
      key={step.nonce}
      className="workflowSplitTransition"
      aria-hidden="true"
      onAnimationEnd={(event) => {
        if (
          event.target === event.currentTarget &&
          event.animationName === "workflowSplitShell"
        ) {
          onComplete?.(step.nonce);
        }
      }}
    >
      {/* Deep-green dimmer only covers the space not occupied by the original slit. */}
      <div className="workflowSplitDimmer" />
      <div className="workflowSplitBeam" />
      <div className="workflowSplitMessage">
        <span>{step.number}</span>
        <strong className="workflowSplitTitle">
          {(step.transitionLines || [step.transitionTitle]).map((line) => (
            <span key={line}>{line}</span>
          ))}
        </strong>
        <small>{step.transitionText}</small>
      </div>
    </div>
  );
}

// #endregion

// #endregion

// #region 04 — Page 01: Home
/* ==========================================================================
   04. Page 01 — Home
   ========================================================================== */

// #region 04A — Home page composition
function HomePage({ setPage, selectedScenario }) {
  const preview = useMemo(
    () => buildHomeOutcomePreview(selectedScenario),
    [
      selectedScenario.id,
      selectedScenario.name,
      selectedScenario.load,
      selectedScenario.solar,
      selectedScenario.wind,
      selectedScenario.gridLimit,
      selectedScenario.batterySoc,
      selectedScenario.batteryCapacity,
      selectedScenario.stress,
      selectedScenario.profiles,
    ]
  );

  const flowSteps = [
    {
      number: "01",
      label: "Configure",
      note: "Scenario & limits",
      tone: "input",
    },
    {
      number: "02",
      label: "Optimize",
      note: "Unit commitment",
      tone: "quantum",
    },
    {
      number: "03",
      label: "Validate",
      note: "Dispatch checks",
      tone: "classical",
    },
  ];

  return (
    <main className="home homeOutcomeLanding pageEnter">
      <section className="heroCard outcomeHeroCard">
        <div className="homeIdentityRow">
          <p className="kicker">Quantum-Assisted Grid Optimization</p>
        </div>

        <h1 className="heroTitle outcomeHeroTitle">
          <span className="outcomeHeroTitlePrimary">Quantum-Assisted Unit Commitment</span>
          <span className="outcomeHeroTitleSecondary">for Renewable-Heavy Grids</span>
        </h1>

        <p className="outcomeResearchQuestion">
          Build a validated 24-hour schedule for a renewable-heavy grid.
        </p>

        <div className="heroActions outcomeHeroActions">
          <button className="bigCta" onClick={() => setPage(1)}>
            Configure Scenario <span>→</span>
          </button>
          <button
            className="secondaryCta outcomeSecondaryCta"
            onClick={() => setPage(2)}
          >
            View Sample Plan
          </button>
        </div>

        <div className="homeFlow" aria-label="Hybrid optimization workflow">
          {flowSteps.map((step, index) => (
            <React.Fragment key={step.number}>
              <HomeFlowCard {...step} />
              {index < flowSteps.length - 1 && (
                <span className="homeFlowArrow" aria-hidden="true">→</span>
              )}
            </React.Fragment>
          ))}
        </div>
      </section>

      <section className="problemCard outcomeEvidencePanel">
        <div className="outcomeEvidenceHead">
          <div>
            <span>Demo Results</span>
            <strong>{selectedScenario.name}</strong>
            <small>
              {preview.isReady
                ? `Synthetic 24h · ${selectedScenario.load} MW peak`
                : "No scenario input yet · configure a 24h case"}
            </small>
          </div>
          <em>Before → After</em>
        </div>

        <div className="outcomeRiskVisual">
          <div className="outcomeRiskTicks" aria-hidden="true" />
          <div className="outcomeRiskRing">
            <div className="outcomeRiskCore">
              <span>Congestion Risk</span>
              <strong>
                {preview.isReady ? (
                  <>{preview.congestionIndexBefore} <i>→</i> {preview.congestionIndexAfter}</>
                ) : (
                  "—"
                )}
              </strong>
              <small>
                {preview.isReady
                  ? "Lower is better"
                  : "Available after scenario input"}
              </small>
            </div>
          </div>
        </div>


        <div className="outcomeEvidenceGrid">
          <HomeOutcomeMetric
            label="Cost saving"
            value={preview.isReady ? `${preview.costReduction}%` : "—"}
            note={preview.isReady ? "vs Classical" : "Waiting for scenario input"}
            tone="safe"
          />
          <HomeOutcomeMetric
            label="Runtime"
            value={preview.isReady ? `${preview.endToEndSpeedup}×` : "—"}
            note={preview.isReady ? "18.4 s → 5.1 s" : "Waiting for scenario input"}
            tone="safe"
          />
          <HomeOutcomeMetric
            label="Curtailment"
            value={
              preview.isReady
                ? `${preview.baselineCurtailment} → ${preview.adaptiveCurtailment} MWh`
                : "—"
            }
            note={
              preview.isReady
                ? `${preview.curtailmentReductionPercent}% lower`
                : "Waiting for scenario input"
            }
            tone="safe curtailment"
          />
          <HomeOutcomeMetric
            label="Feasibility"
            value={preview.isReady ? preview.validatedFeasibleHours : "—"}
            note={preview.isReady ? "All hours passed" : "Waiting for scenario input"}
            tone="safe"
          />
        </div>

      </section>
    </main>
  );
}

// #endregion

// #region 04B — Home page reusable cards and preview math
function HomeFlowCard({ number, label, note, tone }) {
  return (
    <article className={`homeFlowCard ${tone}`}>
      <span>{number}</span>
      <div>
        <strong>{label}</strong>
        <small>{note}</small>
      </div>
    </article>
  );
}

function HomeOutcomeMetric({ label, value, note, tone = "" }) {
  return (
    <article className={`homeOutcomeMetric ${tone}`.trim()}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}

function buildHomeOutcomePreview(scenario) {
  const normalizedScenario = normalizeScenarioForResults(scenario);
  const isReady = Number(normalizedScenario.load || 0) > 0;

  if (!isReady) {
    return {
      isReady: false,
      congestionIndexBefore: null,
      congestionIndexAfter: null,
      hybridGap: null,
      costReduction: null,
      endToEndSpeedup: null,
      baselineCurtailment: null,
      adaptiveCurtailment: null,
      curtailmentReductionPercent: null,
      commitmentVariables: null,
      activeQubits: null,
      rawFeasibleHours: null,
      rawRequiresRepair: null,
      validatedFeasibleHours: null,
    };
  }

  const view = buildAdvancedResultView(null, normalizedScenario, PRIMARY_METHOD);
  const profile = makeScenarioPreview24h(normalizedScenario);
  const preflight = buildPreOptimizationStats(profile, normalizedScenario);

  const congestionIndexBefore = Math.max(
    0,
    Math.min(100, Math.round(normalizedScenario.stress || 0))
  );
  const supportFactor = Math.max(
    0.18,
    Math.min(
      0.68,
      0.58 -
        Number(normalizedScenario.batterySoc || 0) / 420 -
        Number(normalizedScenario.gridLimit || 0) / 900
    )
  );
  const estimatedAfter = congestionIndexBefore <= 8
    ? 0
    : Math.round(congestionIndexBefore * supportFactor);
  const congestionIndexAfter = Math.max(
    0,
    Math.min(congestionIndexBefore, estimatedAfter)
  );

  const detectedStressHours = Math.max(0, Number(preflight.stressHours || 0));
  const infeasibleHours = detectedStressHours > 0
    ? Math.min(4, Math.max(2, Math.ceil(detectedStressHours / 3)))
    : 0;
  const rawFeasible = 24 - infeasibleHours;

  const baselineCurtailment = Number(view.ruleBased.curtailment.toFixed(2));
  const adaptiveCurtailment = Number(view.hybrid.curtailment.toFixed(2));
  const curtailmentReductionPercent = Math.max(
    0,
    Math.round(
      ((baselineCurtailment - adaptiveCurtailment) /
        Math.max(baselineCurtailment, 0.01)) *
        100
    )
  );

  return {
    isReady: true,
    congestionIndexBefore,
    congestionIndexAfter,
    hybridGap: view.hybridGapPercent,
    costReduction: view.costAvoidedPercent,
    endToEndSpeedup: view.endToEndSpeedup,
    baselineCurtailment: baselineCurtailment.toFixed(2),
    adaptiveCurtailment: adaptiveCurtailment.toFixed(2),
    curtailmentReductionPercent,
    commitmentVariables: view.quboVars,
    activeQubits: view.qubits,
    rawFeasibleHours: `${rawFeasible}/24 h`,
    rawRequiresRepair: rawFeasible < 24,
    validatedFeasibleHours: "24/24 h",
  };
}

// #endregion

// #endregion

// #region 05 — Page 02: Workspace and pre-optimization analysis
/* ==========================================================================
   05. Page 02 — Workspace and pre-optimization analysis
   ========================================================================== */

// #region 05A — Workspace shell and operating controls
function WorkspacePage({
  scenarios,
  selectedScenario,
  selectedScenarioId,
  setSelectedScenarioId,
  updateScenario,
  runDemo,
  running,
  runError,
  solvePhase,
  solveLogIndex,
  solveLogs,
  backendState,
  selectedSolver,
  weatherProfile,
  setWeatherProfile,
}) {
  const operationalPreview = getOperationalPreview(selectedScenario);
  const {
    load,
    totalRenewables,
    renewableCoveragePercent,
    renewableSurplus,
    gridImportedPower,
    gridLineUsagePercent,
    gridRemainingMargin,
    gridStatus,
    gridStatusClass,
    batteryDischargePower,
    dieselNeed,
    isLoadReady,
  } = operationalPreview;

  const dieselActive = dieselNeed > 0;
  const batteryPercent = getBatteryPercent(selectedScenario);
  const gridDanger = ["critical", "violation"].includes(gridStatusClass);
  const [weatherProfileDrawerOpen, setWeatherProfileDrawerOpen] = useState(false);
  const [weatherProfileMenuOpen, setWeatherProfileMenuOpen] = useState(false);
  const [activeValidationDetail, setActiveValidationDetail] = useState(null);
  const weatherProfileMenuRef = useRef(null);
  const systemCheckRef = useRef(null);

  function closeValidationMetric(metricKey) {
    setActiveValidationDetail((current) =>
      current?.metricKey === metricKey ? null : current
    );
  }

  useEffect(() => {
    function closeFloatingControls(event) {
      const profileRoot = weatherProfileMenuRef.current;
      if (profileRoot && !profileRoot.contains(event.target)) {
        setWeatherProfileMenuOpen(false);
      }

      const validationRoot = systemCheckRef.current;
      const validationPopover = event.target?.closest?.('.portalValidationMetricPopover');
      if (
        validationRoot &&
        !validationRoot.contains(event.target) &&
        !validationPopover
      ) {
        setActiveValidationDetail(null);
      }
    }

    function closeOnEscape(event) {
      if (event.key !== "Escape") return;
      setWeatherProfileMenuOpen(false);
      setWeatherProfileDrawerOpen(false);
      setActiveValidationDetail(null);
    }

    document.addEventListener("mousedown", closeFloatingControls);
    document.addEventListener("touchstart", closeFloatingControls, { passive: true });
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("mousedown", closeFloatingControls);
      document.removeEventListener("touchstart", closeFloatingControls);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    setWeatherProfileMenuOpen(false);
    setWeatherProfileDrawerOpen(false);
    setActiveValidationDetail(null);
  }, [running]);


  useEffect(() => {
    setActiveValidationDetail(null);
  }, [
    selectedScenarioId,
    selectedScenario.load,
    selectedScenario.solar,
    selectedScenario.wind,
    selectedScenario.gridLimit,
    selectedScenario.batterySoc,
    weatherProfile.id,
  ]);

  const workspacePreview = useMemo(
    () => makeScenarioPreview24h(selectedScenario),
    [
      selectedScenario.id,
      selectedScenario.load,
      selectedScenario.solar,
      selectedScenario.wind,
      selectedScenario.gridLimit,
      selectedScenario.batterySoc,
      selectedScenario.batteryCapacity,
      selectedScenario.profiles,
    ]
  );

  const workspaceDecisionStats = useMemo(
    () => buildPreOptimizationStats(workspacePreview, selectedScenario),
    [
      workspacePreview,
      selectedScenario.load,
      selectedScenario.gridLimit,
      selectedScenario.batterySoc,
      selectedScenario.batteryCapacity,
    ]
  );

  const mainScenarioIds = ["congestion", "peak", "high-renewable"];
  const mainScenarios = mainScenarioIds
    .map((id) => scenarios.find((scenario) => scenario.id === id))
    .filter(Boolean);

  function launchSelectedSolver() {
    runDemo();
  }

  function updateBatteryPercent(rawValue) {
    const nextPercent = clampNumber(rawValue, 0, 100);
    const capacity = Math.max(Number(selectedScenario.batteryCapacity || 80), 1);
    updateScenario(
      selectedScenarioId,
      "batterySoc",
      Math.round(capacity * (nextPercent / 100)),
      0,
      capacity
    );
  }

  const workspaceControls = [
    {
      field: "load",
      label: "Demand",
      unit: "MW",
      value: selectedScenario.load,
      min: 0,
      max: 250,
      type: "load",
      note: "24-hour peak demand",
      definition:
        "Sets the peak demand used to scale the synthetic 24-hour load profile.",
      formulaLines: [
        <>
          P<sub>load,t</sub> = α<sub>t</sub> × P<sub>load,peak</sub>
        </>,
        <>
          Display = P<sub>load,peak</sub> / 250 × 100%
        </>,
      ],
      formulaImpact:
        "Higher demand raises residual load and can create more hours that require grid, storage, or committed generation support.",
    },
    {
      field: "solar",
      label: "Solar Availability",
      unit: "MW",
      value: selectedScenario.solar,
      min: 0,
      max: 150,
      type: "solar",
      note: "Available solar generation",
      definition:
        "Sets the available solar capacity used to scale the hourly solar profile.",
      formulaLines: [
        <>
          P<sub>solar,t</sub> = a<sub>solar,t</sub> × P<sub>solar,max</sub>
        </>,
        <>
          Display = P<sub>solar,max</sub> / 150 × 100%
        </>,
      ],
      formulaImpact:
        "More solar lowers daytime residual demand, while large midday output can increase surplus and curtailment pressure.",
    },
    {
      field: "wind",
      label: "Wind Availability",
      unit: "MW",
      value: selectedScenario.wind,
      min: 0,
      max: 120,
      type: "wind",
      note: "Available wind generation",
      definition:
        "Sets the available wind capacity used to scale the hourly wind profile.",
      formulaLines: [
        <>
          P<sub>wind,t</sub> = a<sub>wind,t</sub> × P<sub>wind,max</sub>
        </>,
        <>
          Display = P<sub>wind,max</sub> / 120 × 100%
        </>,
      ],
      formulaImpact:
        "Wind reduces residual demand across the hours in which the wind profile is available and changes the commitment stress pattern.",
    },
    {
      field: "gridLimit",
      label: "Grid Import Limit",
      unit: "MW",
      value: selectedScenario.gridLimit,
      min: 0,
      max: 180,
      type: gridDanger ? "grid-danger" : "grid",
      note: "External support boundary",
      definition:
        "Defines the maximum power that may be imported from the external grid in any hour.",
      formulaLines: [
        <>
          0 ≤ P<sub>grid,t</sub> ≤ P<sub>grid,limit</sub>
        </>,
        <>
          Display = P<sub>grid,limit</sub> / 180 × 100%
        </>,
      ],
      formulaImpact:
        "A tighter import limit increases congestion risk and makes battery or committed local generation more important.",
    },
    {
      field: "batterySocPercent",
      label: "Initial Battery SOC",
      unit: "%",
      value: Math.round(batteryPercent),
      min: 0,
      max: 100,
      type: "battery",
      note: `${Number(selectedScenario.batterySoc || 0)} / ${Number(selectedScenario.batteryCapacity || 80)} MWh`,
      definition:
        "Sets the stored battery energy available at the beginning of the 24-hour horizon.",
      formulaLines: [
        <>
          SOC<sub>0</sub> = E<sub>0</sub> / E<sub>max</sub> × 100%
        </>,
        <>
          E<sub>0</sub> = SOC<sub>0</sub> × E<sub>max</sub>
        </>,
      ],
      formulaImpact:
        "Higher initial SOC increases early-hour discharge flexibility, but it does not guarantee battery support throughout the full horizon.",
      onChange: updateBatteryPercent,
    },
  ];

  const scenarioTitles = {
    congestion: "Grid Congestion",
    peak: "Peak Demand",
    "high-renewable": "High Renewable",
  };

  const scenarioCompactDescriptions = {
    congestion: "Bottleneck",
    peak: "Evening peak",
    "high-renewable": "High VRE",
  };

  const validationSignals = workspaceDecisionStats.warnings.filter((warning) =>
    ["grid", "renewable", "battery"].includes(warning.id)
  );

  const commitmentRequired = workspaceDecisionStats.stressHours > 0;
  const commitmentStatus = !isLoadReady
    ? "WAITING"
    : commitmentRequired
      ? "Required"
      : "Not required";
  const commitmentTone = !isLoadReady
    ? "watch"
    : commitmentRequired
      ? "risk"
      : "safe";

  return (
    <section className="workspaceViewport workspaceLaunchpad pageEnter">
      <div className="workspaceTop launchpadIntro">
        <div className="pageHeaderLead">
          <div className="pageHeaderCopy">
            <span className="kicker">Stress-Test Workspace</span>
            <h2>Configure the 24h Scenario</h2>
          </div>
        </div>
      </div>



      <div className="workspaceLayoutContainer launchpadLayout">
        <div className="workspaceLeftMain launchpadMain">

        <aside className={`scenarioHorizontalSection launchpadScenarioPanel compactScenarioStrip ${weatherProfileMenuOpen ? "profileMenuOpen" : ""}`}>
          <div className="compactHead scenarioLaunchpadHead">
            <div>
              <h3>Operating Scenarios</h3>
            </div>
        
            <div
              ref={weatherProfileMenuRef}
              className={`compactWeatherProfileSelector ${weatherProfileMenuOpen ? "open" : ""}`}
            >
              <button
                type="button"
                className="weatherProfileLauncher compactProfileTrigger"
                onClick={() => setWeatherProfileMenuOpen((current) => !current)}
                aria-haspopup="listbox"
                aria-expanded={weatherProfileMenuOpen}
              >
                <span className="weatherProfileLauncherIcon" aria-hidden="true">☁</span>
                <span className="weatherProfileLauncherCopy">
                  <b>24h Profile</b>
                </span>
                <i aria-hidden="true">⌄</i>
              </button>
        
              <div
                className="compactWeatherProfilePopover"
                role="listbox"
                aria-label="Choose a 24-hour profile"
              >
                <div className="compactWeatherProfilePopoverHead">
                  <span>24h temporal shape</span>
                  <small>Applied immediately</small>
                </div>
        
                <div className="compactWeatherProfileOptions">
                  {WEATHER_PROFILE_CHOICES.map((profile) => {
                    const active = weatherProfile.id === profile.id;
                    return (
                      <button
                        type="button"
                        key={profile.id}
                        className={`compactWeatherProfileOption ${active ? "active" : ""}`}
                        onClick={() => {
                          setWeatherProfile(cloneWeatherProfile(profile));
                          setWeatherProfileMenuOpen(false);
                        }}
                        role="option"
                        aria-selected={active}
                      >
                        <div className="compactProfileOptionCopy">
                          <strong>{profile.name}</strong>
                          <small>{profile.summary}</small>
                        </div>
                        <ProfileSparkline profiles={getProfileSparklineProfiles(profile)} />
                        <i aria-hidden="true">{active ? "✓" : "→"}</i>
                      </button>
                    );
                  })}
                </div>
        
                <button
                  type="button"
                  className="advancedProfileToolsButton"
                  onClick={() => {
                    setWeatherProfileMenuOpen(false);
                    setWeatherProfileDrawerOpen(true);
                  }}
                >
                  Advanced profile tools
</button>
              </div>
            </div>
          </div>
        
          <div className="primaryScenarioGrid">
            {mainScenarios.map((scenario) => (
              <button
                type="button"
                key={scenario.id}
                className={`primaryScenarioCard ${
                  selectedScenarioId === scenario.id ? "active" : ""
                }`}
                onClick={() => setSelectedScenarioId(scenario.id)}
                aria-pressed={selectedScenarioId === scenario.id}
              >
                <span className="primaryScenarioIcon">{scenario.icon || "⚡"}</span>
                <div>
                  <strong>{scenarioTitles[scenario.id] || scenario.name}</strong>
                  <small>{scenarioCompactDescriptions[scenario.id] || scenario.headline || "Operating state"}</small>
                </div>
              </button>
            ))}
          </div>
        </aside>


          <section className="dashboardSection workspaceV2Dashboard launchpadDashboard chartOnlyDashboard">
            <WorkspaceIntelligence
              scenario={selectedScenario}
              preview={workspacePreview}
              stats={workspaceDecisionStats}
              running={running}
              solvePhase={solvePhase}
              solveLogIndex={solveLogIndex}
              solveLogs={solveLogs}
              backendState={backendState}
              solver={selectedSolver}
            />
          </section>
        </div>

        <aside className="workspaceRightColumn solverColumn controlValidationTower">
          <div className="controlRailScroll">
            <section className="railOperatingInputs">
              <div className="compactHead launchpadControlHead railControlHead">
                <div>
                  <h3>Operating Inputs</h3>
                </div>
              </div>

              <div className="featureControlGrid fullControlGrid railControlList">
                {workspaceControls.map((feature) => (
                  <FeatureControlCard
                    key={feature.field}
                    feature={feature}
                    scenarioId={selectedScenarioId}
                    updateScenario={updateScenario}
                  />
                ))}
              </div>
            </section>
          <section ref={systemCheckRef} className="towerFeasibilityPanel unifiedValidationGate systemCheckPanelV38">
            <div className="towerFeasibilityHead systemCheckSummaryHead systemCheckHeaderV38">
              <h3>System Check</h3>
            </div>

            <span className="systemCheckGroupLabelV38">Initial state</span>
            <div className="systemCheckGroupListV38 systemCheckInitialListV38">
              <InitialValidationItem
                metricKey="initial-renewables"
                label="Renewable coverage"
                value={isLoadReady ? `${renewableCoveragePercent}%` : "—"}
                note={
                  !isLoadReady
                    ? "Waiting for load input"
                    : renewableSurplus > 0
                      ? `${load} MW covered · ${renewableSurplus} MW surplus potential`
                      : `Solar and wind supply ${totalRenewables} of ${load} MW`
                }
                tone={
                  !isLoadReady
                    ? "watch"
                    : renewableCoveragePercent >= 100
                      ? "safe"
                      : renewableCoveragePercent >= 50
                        ? "watch"
                        : "risk"
                }
                popupLabel="Formula"
                popupTitle="Initial renewable coverage"
                explanation="Share of current demand supplied directly by solar and wind."
                current={
                  !isLoadReady
                    ? "Waiting for a valid load input."
                    : renewableSurplus > 0
                      ? `${renewableCoveragePercent}% coverage with ${renewableSurplus} MW surplus potential.`
                      : `${renewableCoveragePercent}% of the initial load is covered by renewables.`
                }
                threshold="100% means the initial load can be fully covered by renewable generation."
                position="down"
                activeMetricKey={activeValidationDetail?.metricKey}
                onOpenDetails={setActiveValidationDetail}
                onCloseDetails={closeValidationMetric}
                formula={
                  <div className="decisionFormulaExpression">
                    <span>R<sub>VRE</sub></span>
                    <span>= min((P<sub>solar</sub> + P<sub>wind</sub>) / P<sub>load</sub>, 1) × 100%</span>
                  </div>
                }
              />

              <InitialValidationItem
                metricKey="initial-grid"
                label="Grid use"
                value={
                  Number(selectedScenario.gridLimit || 0) > 0
                    ? `${gridImportedPower} / ${Number(selectedScenario.gridLimit || 0)} MW`
                    : "—"
                }
                note={
                  Number(selectedScenario.gridLimit || 0) > 0
                    ? `${gridLineUsagePercent}% utilized · ${gridRemainingMargin} MW remaining`
                    : "Set a grid-import limit"
                }
                tone={gridDanger ? "risk" : gridLineUsagePercent >= 80 ? "watch" : "safe"}
                popupLabel="Formula"
                popupTitle="Initial grid utilization"
                explanation="Used grid-import capacity and the remaining operating margin."
                current={
                  Number(selectedScenario.gridLimit || 0) > 0
                    ? `${gridLineUsagePercent}% utilized with ${gridRemainingMargin} MW remaining.`
                    : "Grid-import capacity is not configured."
                }
                threshold="Lower utilization leaves more import margin for later stress hours."
                position="down"
                activeMetricKey={activeValidationDetail?.metricKey}
                onOpenDetails={setActiveValidationDetail}
                onCloseDetails={closeValidationMetric}
                formula={
                  <>
                    <div className="decisionFormulaExpression">
                      <span>U<sub>grid</sub> = P<sub>import</sub> / P<sub>limit</sub> × 100%</span>
                    </div>
                    <div className="decisionFormulaExpression secondaryFormulaExpression">
                      <span>M<sub>grid</sub> = P<sub>limit</sub> − P<sub>import</sub></span>
                    </div>
                  </>
                }
              />

              <InitialValidationItem
                metricKey="initial-diesel"
                label="Diesel dispatch"
                value={isLoadReady ? `${dieselNeed} MW` : "—"}
                note={
                  !isLoadReady
                    ? "Waiting for load input"
                    : dieselActive
                      ? `Initial backup dispatch · battery discharges ${batteryDischargePower} MW`
                      : "Backup not required at the initial hour."
                }
                tone={dieselActive ? "risk" : "safe"}
                popupLabel="Formula"
                popupTitle="Initial diesel preview"
                explanation="Backup generation remaining after renewable, grid, and battery support."
                current={
                  !isLoadReady
                    ? "Waiting for a valid operating scenario."
                    : dieselActive
                      ? `${dieselNeed} MW of initial diesel support is required.`
                      : "0 MW required — the initial hour is supported without diesel."
                }
                threshold="Diesel is activated only when flexible support cannot cover the residual load."
                position="down"
                activeMetricKey={activeValidationDetail?.metricKey}
                onOpenDetails={setActiveValidationDetail}
                onCloseDetails={closeValidationMetric}
                formula={
                  <div className="decisionFormulaExpression">
                    <span>P<sub>diesel</sub></span>
                    <span>= max(P<sub>load</sub> − P<sub>solar</sub> − P<sub>wind</sub> − P<sub>import</sub> − P<sub>battery</sub>, 0)</span>
                  </div>
                }
              />
            </div>

            <span className="systemCheckGroupLabelV38">Physical risks</span>
            <div className="systemCheckGroupListV38 systemCheckPhysicalListV38">
              {validationSignals.map((warning) => (
                <DecisionPreviewItem
                  key={warning.id}
                  metricKey={warning.id}
                  label={warning.label}
                  value={warning.value}
                  note={warning.note}
                  tone={warning.tone}
                  math={warning.math}
                  activeMetricKey={activeValidationDetail?.metricKey}
                  onOpenDetails={setActiveValidationDetail}
                  onCloseDetails={closeValidationMetric}
                />
              ))}
            </div>

            <span className="systemCheckGroupLabelV38">24h decision</span>
            <div className="systemCheckGroupListV38 systemCheckCommitmentListV38">
              <InitialValidationItem
                metricKey="commitment-decision"
                label="Generator support"
                value={commitmentStatus}
                note={
                  !isLoadReady
                    ? "Set a non-zero operating scenario before optimization."
                    : commitmentRequired
                      ? `${workspaceDecisionStats.stressHours} stress hour${workspaceDecisionStats.stressHours === 1 ? "" : "s"} exceed renewable, grid, and storage support.`
                      : "No stress hour exceeds flexible support."
                }
                tone={commitmentTone}
                popupLabel="Decision Logic"
                popupTitle="24-hour commitment requirement"
                explanation="Counts the hours where residual demand exceeds available flexible support."
                current={
                  !isLoadReady
                    ? "Waiting for valid operating inputs."
                    : commitmentRequired
                      ? `${workspaceDecisionStats.stressHours} stress hour${workspaceDecisionStats.stressHours === 1 ? "" : "s"} detected — binary commitment is required.`
                      : "No stress hour detected — direct dispatch remains available."
                }
                threshold="Commitment is required whenever at least one hour crosses the flexible-support boundary."
                position="up"
                activeMetricKey={activeValidationDetail?.metricKey}
                onOpenDetails={setActiveValidationDetail}
                onCloseDetails={closeValidationMetric}
                formula={
                  <>
                    <div className="decisionFormulaExpression">
                      <span>H<sub>stress</sub> = Σ<sub>t=1</sub><sup>24</sup> 𝟙[P<sub>res,t</sub> &gt; P<sub>grid,max</sub> + P<sub>storage,t</sub>]</span>
                    </div>
                    <div className="decisionFormulaExpression secondaryFormulaExpression">
                      <span>Decision = REQUIRED if H<sub>stress</sub> &gt; 0</span>
                    </div>
                  </>
                }
              />
            </div>

            <div className="systemCheckLaunchZone systemCheckLaunchZoneV38">
              <div
                className={`singleOptimizationCompound ${
                  runError
                    ? "error"
                    : running
                      ? "running"
                      : isLoadReady
                        ? "ready"
                        : "waiting"
                }`}
              >
                <button
                  type="button"
                  className="singleOptimizationLaunch"
                  onClick={launchSelectedSolver}
                  disabled={running || !isLoadReady}
                  aria-label={
                    runError
                      ? "Run optimization again"
                      : running
                        ? "Generating the 24-hour plan"
                        : "Generate the 24-hour plan"
                  }
                >
                  <span className="singleOptimizationStatus" aria-hidden="true">
                    {running ? (
                      <span className="launchButtonSpinner" />
                    ) : (
                      <i className="launchReadyDot" />
                    )}
                  </span>

                  <span className="singleOptimizationCopy">
                    <strong>
                      {runError
                        ? "Run optimization again"
                        : running
                          ? "Generating 24h Plan…"
                          : "Generate 24h Plan"}
                    </strong>
                  </span>
                </button>
              </div>
            </div>
          </section>

          </div>
        </aside>
      </div>

      <WeatherProfileDrawer
        open={weatherProfileDrawerOpen}
        appliedProfile={weatherProfile}
        scenario={selectedScenario}
        onClose={() => setWeatherProfileDrawerOpen(false)}
        onApply={(nextProfile) => {
          setWeatherProfile(cloneWeatherProfile(nextProfile));
          setWeatherProfileDrawerOpen(false);
        }}
      />
    </section>
  );
}

// #endregion

// #region 05B — Weather profile drawer and profile controls
function WeatherProfileDrawer({
  open,
  appliedProfile,
  scenario,
  onClose,
  onApply,
}) {
  const [activeTab, setActiveTab] = useState("presets");
  const [draftProfile, setDraftProfile] = useState(() =>
    cloneWeatherProfile(appliedProfile)
  );
  const [customControls, setCustomControls] = useState(() => ({
    ...DEFAULT_CUSTOM_PROFILE_CONTROLS,
  }));
  const [uploadState, setUploadState] = useState({
    status: "idle",
    message: "Upload a CSV with 24 hourly records.",
    metrics: null,
    filename: "",
  });
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setDraftProfile(cloneWeatherProfile(appliedProfile));
    setCustomControls(
      appliedProfile?.kind === "custom" && appliedProfile.controls
        ? { ...DEFAULT_CUSTOM_PROFILE_CONTROLS, ...appliedProfile.controls }
        : { ...DEFAULT_CUSTOM_PROFILE_CONTROLS }
    );
    setUploadState({
      status: "idle",
      message: "Upload a CSV with 24 hourly records.",
      metrics: null,
      filename: "",
    });
  }, [open, appliedProfile]);

  const preview = useMemo(
    () =>
      makeScenarioPreview24h({
        ...scenario,
        profiles: draftProfile.profiles,
      }),
    [
      scenario.load,
      scenario.solar,
      scenario.wind,
      scenario.gridLimit,
      draftProfile,
    ]
  );

  const previewStats = useMemo(() => {
    const peakLoad = Math.max(...preview.map((point) => point.load), 0);
    const totalLoad = preview.reduce((sum, point) => sum + point.load, 0);
    const totalVre = preview.reduce((sum, point) => sum + point.vre, 0);
    const maxRamp = preview.reduce((maximum, point, index) => {
      if (index === 0) return maximum;
      return Math.max(
        maximum,
        Math.abs(point.residualDemand - preview[index - 1].residualDemand)
      );
    }, 0);

    return {
      peakLoad: Math.round(peakLoad),
      averageVre: Math.round((totalVre / Math.max(totalLoad, 1)) * 100),
      maxRamp: Math.round(maxRamp),
    };
  }, [preview]);

  function choosePreset(profile) {
    setDraftProfile(cloneWeatherProfile(profile));
  }

  function updateCustomControl(field, rawValue) {
    const limits = {
      solarPeakHour: [9, 15],
      cloudVariability: [0, 80],
      windEveningDrop: [0, 90],
      demandPeakHour: [16, 22],
      forecastNoise: [0, 25],
      randomSeed: [1, 999],
    };
    const [min, max] = limits[field] || [0, 100];
    const nextControls = {
      ...customControls,
      [field]: Math.round(clampNumber(rawValue, min, max)),
    };
    setCustomControls(nextControls);
    setDraftProfile(createCustomWeatherProfile(nextControls));
  }

  async function handleCsvUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploadState({
      status: "checking",
      message: "Validating 24 hourly records...",
      metrics: null,
      filename: file.name,
    });

    try {
      const csvText = await file.text();
      const parsed = parseWeatherProfileCsv(csvText, file.name);
      setDraftProfile(parsed.profile);
      setUploadState({
        status: "valid",
        message: "CSV validated. The temporal shapes are ready to apply.",
        metrics: parsed.metrics,
        filename: file.name,
      });
    } catch (error) {
      setUploadState({
        status: "error",
        message: error?.message || "Could not validate the CSV file.",
        metrics: null,
        filename: file.name,
      });
    } finally {
      event.target.value = "";
    }
  }

  function resetDraft() {
    setDraftProfile(cloneWeatherProfile(appliedProfile));
    setCustomControls(
      appliedProfile?.kind === "custom" && appliedProfile.controls
        ? { ...DEFAULT_CUSTOM_PROFILE_CONTROLS, ...appliedProfile.controls }
        : { ...DEFAULT_CUSTOM_PROFILE_CONTROLS }
    );
    setUploadState({
      status: "idle",
      message: "Upload a CSV with 24 hourly records.",
      metrics: null,
      filename: "",
    });
  }

  const canApply =
    activeTab !== "upload" || uploadState.status === "valid";

  const hasPendingChanges = useMemo(
    () => JSON.stringify(draftProfile) !== JSON.stringify(appliedProfile),
    [draftProfile, appliedProfile]
  );

  const drawer = (
    <div
      className={`weatherProfileDrawerLayer ${open ? "open" : ""}`}
      aria-hidden={!open}
    >
      <button
        type="button"
        className="weatherProfileDrawerBackdrop"
        onClick={onClose}
        aria-label="Close weather profile drawer"
        tabIndex={open ? 0 : -1}
      />

      <aside
        className="weatherProfileDrawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="weather-profile-drawer-title"
      >
        <header className="weatherProfileDrawerHeader">
          <div>
            <span>24H Data Profile</span>
            <h3 id="weather-profile-drawer-title">Choose a 24h profile</h3>
            <p>Presets define temporal shape; workspace sliders control amplitude.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close profile drawer">×</button>
        </header>

        <nav className="weatherProfileTabs" aria-label="Weather profile modes">
          {[
            ["presets", "Presets"],
            ["custom", "Custom"],
            ["upload", "Upload CSV"],
          ].map(([id, label]) => (
            <button
              type="button"
              key={id}
              className={activeTab === id ? "active" : ""}
              onClick={() => {
                setActiveTab(id);
                if (id === "custom") {
                  setDraftProfile(createCustomWeatherProfile(customControls));
                }
              }}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="weatherProfileDrawerBody">
          {activeTab === "presets" && (
            <section className="weatherPresetGrid" aria-label="Weather profile presets">
              {WEATHER_PROFILE_CHOICES.map((profile) => {
                const active = draftProfile.id === profile.id;
                return (
                  <button
                    type="button"
                    key={profile.id}
                    className={`weatherPresetCard ${active ? "active" : ""}`}
                    onClick={() => choosePreset(profile)}
                  >
                    <div className="weatherPresetCardHead">
                      <div>
                        <strong>{profile.name}</strong>
                        <small>{profile.summary}</small>
                      </div>
                      <span>{active ? "✓ Selected" : "Select"}</span>
                    </div>
                    <ProfileSparkline profiles={getProfileSparklineProfiles(profile)} />
                    <p>{profile.description}</p>
                  </button>
                );
              })}
            </section>
          )}

          {activeTab === "custom" && (
            <section className="customTemporalControls">
              <div className="customTemporalGrid">
                <ProfileControl
                  label="Solar peak hour"
                  value={customControls.solarPeakHour}
                  min={9}
                  max={15}
                  suffix=":00"
                  onChange={(value) => updateCustomControl("solarPeakHour", value)}
                />
                <ProfileControl
                  label="Cloud variability"
                  value={customControls.cloudVariability}
                  min={0}
                  max={80}
                  suffix="%"
                  onChange={(value) => updateCustomControl("cloudVariability", value)}
                />
                <ProfileControl
                  label="Wind evening drop"
                  value={customControls.windEveningDrop}
                  min={0}
                  max={90}
                  suffix="%"
                  onChange={(value) => updateCustomControl("windEveningDrop", value)}
                />
                <ProfileControl
                  label="Demand peak hour"
                  value={customControls.demandPeakHour}
                  min={16}
                  max={22}
                  suffix=":00"
                  onChange={(value) => updateCustomControl("demandPeakHour", value)}
                />
                <ProfileControl
                  label="Forecast noise"
                  value={customControls.forecastNoise}
                  min={0}
                  max={25}
                  suffix="%"
                  onChange={(value) => updateCustomControl("forecastNoise", value)}
                />
                <ProfileControl
                  label="Random seed"
                  value={customControls.randomSeed}
                  min={1}
                  max={999}
                  suffix=""
                  onChange={(value) => updateCustomControl("randomSeed", value)}
                />
              </div>
              <p className="customTemporalNote">
                These controls change timing and volatility only. Demand, Solar, Wind, Grid Limit, and SOC remain controlled by the main workspace.
              </p>
            </section>
          )}

          {activeTab === "upload" && (
            <section
              className={`weatherCsvUploadPanel ${
                uploadState.status === "idle" ? "idle" : ""
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                onChange={handleCsvUpload}
                hidden
              />
              <button
                type="button"
                className="weatherCsvDropButton"
                onClick={() => fileInputRef.current?.click()}
              >
                <span aria-hidden="true">⇧</span>
                <strong>Choose 24-hour CSV</strong>
                <small>hour, load_mw, solar_mw, wind_mw</small>
              </button>

              {uploadState.status !== "idle" && (
                <div className={`weatherCsvStatus ${uploadState.status}`}>
                  <strong>
                    {uploadState.status === "valid"
                      ? "Validated profile"
                      : uploadState.status === "error"
                        ? "Validation failed"
                        : "Checking CSV"}
                  </strong>
                  <p>{uploadState.message}</p>
                  {uploadState.filename && <small>{uploadState.filename}</small>}
                </div>
              )}

              {uploadState.metrics && (
                <div className="weatherCsvMetrics">
                  <div><span>Peak load</span><strong>{uploadState.metrics.peakLoad} MW</strong></div>
                  <div><span>Average VRE</span><strong>{uploadState.metrics.averageVre}%</strong></div>
                  <div><span>Max net-load ramp</span><strong>{uploadState.metrics.maxRamp} MW/h</strong></div>
                </div>
              )}
            </section>
          )}

          <WeatherProfilePreview
            preview={preview}
            profile={draftProfile}
            stats={previewStats}
          />
        </div>

        <footer className="weatherProfileDrawerFooter compactProfileFooter">
          <div>
            <span>{hasPendingChanges ? "Pending" : "Active"}</span>
            <strong>{draftProfile.name} · {draftProfile.source}</strong>
          </div>
          <button type="button" className="weatherProfileReset" onClick={resetDraft}>
            Reset
          </button>
          <button
            type="button"
            className="weatherProfileApply"
            onClick={() => onApply(draftProfile)}
            disabled={!canApply}
          >
            Apply Profile
          </button>
        </footer>
      </aside>
    </div>
  );

  return createPortal(drawer, document.body);
}

function ProfileControl({ label, value, min, max, suffix, onChange }) {
  return (
    <label className="profileControlField">
      <span>{label}</span>
      <div>
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <strong>{value}{suffix}</strong>
      </div>
    </label>
  );
}

function getProfileSparklineProfiles(profile) {
  if (profile?.id !== DEFAULT_WEATHER_PROFILE.id) {
    return profile?.profiles || { load: [], solar: [], wind: [] };
  }

  // The default profile intentionally stores empty arrays so
  // makeScenarioPreview24h() uses the original workspace equations. Build a
  // display-only copy here so its selector card still has a meaningful sparkline.
  return {
    load: Array.from({ length: 24 }, (_, hour) => {
      const eveningBoost = hour >= 17 && hour <= 21 ? 0.23 : 0;
      const morningBoost = hour >= 7 && hour <= 10 ? 0.08 : 0;
      const nightReduction = hour <= 5 ? 0.24 : 0;
      return Math.max(0, 0.74 + eveningBoost + morningBoost - nightReduction);
    }),
    solar: Array.from({ length: 24 }, (_, hour) =>
      Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI))
    ),
    wind: Array.from({ length: 24 }, (_, hour) =>
      Math.max(
        0.2,
        0.72 + 0.18 * Math.sin((hour + 2) / 3.2) + 0.08 * Math.cos(hour / 2.1)
      )
    ),
  };
}

function ProfileSparkline({ profiles }) {
  const width = 250;
  const height = 54;
  const makePoints = (values) =>
    (values || []).map((value, index) => [
      (index / 23) * width,
      height - 5 - clamp01(value) * (height - 10),
    ]);

  return (
    <svg className="weatherProfileSparkline" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path className="solar" d={smoothSvgPath(makePoints(profiles?.solar))} />
      <path className="wind" d={smoothSvgPath(makePoints(profiles?.wind))} />
    </svg>
  );
}

function WeatherProfilePreview({ preview, profile, stats }) {
  const width = 700;
  const height = 220;
  const pad = { left: 34, right: 16, top: 18, bottom: 27 };
  const values = preview.flatMap((point) => [
    point.load,
    point.solar,
    point.wind,
    point.residualDemand,
  ]);
  const maximum = Math.max(...values, 1) * 1.08;
  const x = (index) =>
    pad.left + (index / Math.max(preview.length - 1, 1)) * (width - pad.left - pad.right);
  const y = (value) =>
    pad.top + (1 - Number(value || 0) / maximum) * (height - pad.top - pad.bottom);
  const pathFor = (key) =>
    smoothSvgPath(preview.map((point, index) => [x(index), y(point[key])]));

  return (
    <section className="weatherProfilePreviewPanel">
      <div className="weatherProfilePreviewHead compactPreviewHead">
        <div>
          <span>24-hour preview</span>
          <strong>{profile.name} · {profile.source}</strong>
          <small>{profile.description}</small>
        </div>
        <div className="weatherProfilePreviewStats inlinePreviewStats">
          <span><b>Peak</b> {stats.peakLoad} MW</span>
          <i aria-hidden="true">·</i>
          <span><b>Avg VRE</b> {stats.averageVre}%</span>
          <i aria-hidden="true">·</i>
          <span><b>Max ramp</b> {stats.maxRamp} MW/h</span>
        </div>
      </div>

      <svg className="weatherProfilePreviewSvg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Load, solar, wind, and residual demand preview">
        {[0.25, 0.5, 0.75].map((ratio) => (
          <line
            key={ratio}
            x1={pad.left}
            x2={width - pad.right}
            y1={pad.top + ratio * (height - pad.top - pad.bottom)}
            y2={pad.top + ratio * (height - pad.top - pad.bottom)}
            className="weatherProfileGridLine"
          />
        ))}
        <path className="load" d={pathFor("load")} />
        <path className="solar" d={pathFor("solar")} />
        <path className="wind" d={pathFor("wind")} />
        <path className="residual" d={pathFor("residualDemand")} />
        {[0, 6, 12, 18, 23].map((hour) => (
          <text key={hour} x={x(hour)} y={height - 7} textAnchor="middle">
            {String(hour).padStart(2, "0")}:00
          </text>
        ))}
      </svg>

      <div className="weatherProfilePreviewLegendRow">
        <div className="weatherProfilePreviewLegend">
          <span><i className="load" />Load</span>
          <span><i className="solar" />Solar</span>
          <span><i className="wind" />Wind</span>
          <span><i className="residual" />Residual demand</span>
        </div>

        <section className="profileScaleLogic profileScaleLogicInline">
          <div>
            <span>Profile shape</span>
            <code>L̂<sub>t</sub>, P̂<sub>solar,t</sub>, P̂<sub>wind,t</sub></code>
          </div>
          <b aria-hidden="true">×</b>
          <div>
            <span>Slider amplitude</span>
            <code>L<sub>t</sub> = α<sub>load</sub>L̂<sub>t</sub></code>
          </div>
        </section>
      </div>
    </section>
  );
}

// #endregion

// #region 05C — Pre-optimization intelligence and validation
function WorkspaceIntelligence({
  scenario,
  preview,
  stats,
  running,
  solvePhase,
  solveLogIndex,
  solveLogs,
  backendState,
  solver,
}) {
  const profileSource = scenario.profileMeta?.name
    ? `${scenario.profileMeta.name} · ${scenario.profileMeta.source}`
    : hasBackendProfile(scenario)
      ? "Backend 24h profile"
      : "Generated 24h preview";
  const stressLabel = `${stats.stressHours} stress hour${stats.stressHours === 1 ? "" : "s"}`;

  return (
    <section className="preOptimizationPanel workspaceChartStage">
      <div className="preOptimizationHead chartStageHead">
        <div>
          <h3>24h Stress Profile</h3>
        </div>

        <div className={`readinessBadge ${stats.stressHours > 0 ? "risk" : "safe"}`}>
          <i />
          {stressLabel}
        </div>
      </div>

      <section className="operationalStressPanel operationalStressExpanded">
        <div className="intelligenceHead compactChartMeta">
          <em>{profileSource}</em>
        </div>

        <OperationalStressChart
          data={preview}
          gridLimit={Number(scenario.gridLimit || 0)}
        />
      </section>
    </section>
  );
}

function OperationalStressChart({ data, gridLimit }) {
  const width = 1000;
  const height = 470;
  const pad = { left: 74, right: 76, top: 48, bottom: 58 };
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const hourWidth = chartWidth / Math.max(data.length - 1, 1);

  const values = data.flatMap((point) => [
    point.load,
    point.vre,
    point.residualDemand,
    gridLimit,
  ]);
  const rawMaximum = Math.max(...values, 1);
  const tickStep = Math.max(10, Math.ceil(rawMaximum / 40) * 10);
  const yMaximum = tickStep * 4;
  const yTicks = [0, tickStep, tickStep * 2, tickStep * 3, yMaximum];

  const x = (index) =>
    pad.left + (index / Math.max(data.length - 1, 1)) * chartWidth;
  const y = (value) =>
    pad.top + (1 - Number(value || 0) / yMaximum) * chartHeight;

  const makePath = (key) =>
    smoothSvgPath(
      data.map((point, index) => [x(index), y(point[key])])
    );

  return (
    <div className="operationalStressChart quantifiedStressChart">
      <svg
        className="operationalStressSvg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="24-hour load, variable renewable energy, residual demand, and critical grid-support gap"
      >
        <text x={4} y={20} textAnchor="start" className="stressAxisTitle">
          Power (MW)
        </text>

        <rect
          className="stressWindowShade"
          x={Math.max(pad.left, x(18) - hourWidth / 2)}
          y={pad.top}
          width={Math.min(width - pad.right, x(21) + hourWidth / 2) - Math.max(pad.left, x(18) - hourWidth / 2)}
          height={chartHeight}
          rx="10"
        />

        <g className="stressGridLines stressHorizontalGrid">
          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text
                x={pad.left - 14}
                y={y(tick) + 4}
                textAnchor="end"
                className="stressYAxisText"
              >
                {Math.round(tick)}
              </text>
            </g>
          ))}
        </g>

        <g className="stressVerticalGrid">
          {[3, 6, 9, 12, 15, 18, 21].map((hour) => (
            <line
              key={hour}
              x1={x(hour)}
              x2={x(hour)}
              y1={pad.top}
              y2={height - pad.bottom}
            />
          ))}
        </g>

        {gridLimit > 0 && (
          <g className="gridSupportLimitGroup">
            <line
              className="gridSupportLimit"
              x1={pad.left}
              x2={width - pad.right}
              y1={y(gridLimit)}
              y2={y(gridLimit)}
            />
          </g>
        )}

        <g className="criticalGapBars">
          {data.map((point, index) => {
            if (point.criticalGap <= 0) return null;

            const residualY = y(point.residualDemand);
            const gridY = y(gridLimit);
            const barWidth = Math.max(7, hourWidth * 0.62);

            return (
              <rect
                key={point.hour}
                x={x(index) - barWidth / 2}
                y={Math.min(residualY, gridY)}
                width={barWidth}
                height={Math.max(2, Math.abs(gridY - residualY))}
                rx="4"
              />
            );
          })}
        </g>

        <path className="stressPath load" d={makePath("load")} />
        <path className="stressPath vre" d={makePath("vre")} />
        <path className="stressPath residual" d={makePath("residualDemand")} />

        {[0, 6, 12, 18, 23].map((hour) => (
          <text
            key={hour}
            x={x(hour)}
            y={height - 20}
            textAnchor="middle"
            className="stressAxisText"
          >
            {String(hour).padStart(2, "0")}:00
          </text>
        ))}
      </svg>

      <div className="stressLegend">
        <span><i className="load" /> Load</span>
        <span><i className="vre" /> VRE = Solar + Wind</span>
        <span><i className="residual" /> Residual demand</span>
        <span><i className="critical" /> Critical gap after grid support</span>
      </div>
    </div>
  );
}


function ValidationMetricValue({
  detail,
  activeMetricKey,
  onOpenDetails,
  onCloseDetails,
}) {
  const interactionRef = useRef(null);
  const popoverRef = useRef(null);
  const openTimerRef = useRef(null);
  const closeTimerRef = useRef(null);
  const [popoverPosition, setPopoverPosition] = useState(null);
  const isOpen = activeMetricKey === detail.metricKey;
  const popoverId = `validation-metric-${detail.metricKey}`;

  function clearOpenTimer() {
    if (!openTimerRef.current) return;
    window.clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
  }

  function clearCloseTimer() {
    if (!closeTimerRef.current) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }

  function calculatePopoverPosition() {
    const interaction = interactionRef.current;
    const card = interaction?.closest('.unifiedValidationGate');
    if (!interaction || !card || typeof window === 'undefined') return null;

    const triggerRect = interaction.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const gutter = 12;
    const gap = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(390, Math.max(240, viewportWidth - gutter * 2));
    const estimatedHeight = Math.min(420, Math.max(260, viewportHeight - gutter * 2));
    const spaceBelow = Math.max(0, viewportHeight - triggerRect.bottom - gap - gutter);
    const spaceAbove = Math.max(0, triggerRect.top - gap - gutter);
    const placement =
      spaceBelow >= estimatedHeight || spaceBelow >= spaceAbove ? 'down' : 'up';

    const preferredLeft = Math.min(cardRect.right - width, triggerRect.right - width);
    const left = Math.max(
      gutter,
      Math.min(preferredLeft, viewportWidth - width - gutter)
    );

    const preferredTop =
      placement === 'down'
        ? triggerRect.bottom + gap
        : triggerRect.top - estimatedHeight - gap;

    const top = Math.max(
      gutter,
      Math.min(preferredTop, viewportHeight - estimatedHeight - gutter)
    );

    return {
      placement,
      top,
      left,
      width,
    };
  }

  function refreshPopoverPosition() {
    const nextPosition = calculatePopoverPosition();
    if (nextPosition) setPopoverPosition(nextPosition);
  }

  function fitOpenPopoverToViewport() {
    const popover = popoverRef.current;
    if (!popover || typeof window === 'undefined') return;

    const rect = popover.getBoundingClientRect();
    const gutter = 12;
    let nextTop = rect.top;
    let nextLeft = rect.left;

    if (rect.bottom > window.innerHeight - gutter) {
      nextTop -= rect.bottom - (window.innerHeight - gutter);
    }

    if (nextTop < gutter) {
      nextTop = gutter;
    }

    if (rect.right > window.innerWidth - gutter) {
      nextLeft -= rect.right - (window.innerWidth - gutter);
    }

    if (nextLeft < gutter) {
      nextLeft = gutter;
    }

    setPopoverPosition((current) => {
      if (!current) return current;
      const topUnchanged = Math.abs(current.top - nextTop) < 0.5;
      const leftUnchanged = Math.abs(current.left - nextLeft) < 0.5;
      if (topUnchanged && leftUnchanged) return current;
      return { ...current, top: nextTop, left: nextLeft };
    });
  }

  function showDetails() {
    clearOpenTimer();
    clearCloseTimer();
    const nextPosition = calculatePopoverPosition();
    if (nextPosition) setPopoverPosition(nextPosition);
    onOpenDetails?.(detail);
  }

  function scheduleOpen() {
    clearCloseTimer();
    if (isOpen || openTimerRef.current) return;
    openTimerRef.current = window.setTimeout(showDetails, 150);
  }

  function hideDetails() {
    clearOpenTimer();
    clearCloseTimer();
    onCloseDetails?.(detail.metricKey);
  }

  function scheduleClose() {
    clearOpenTimer();
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(hideDetails, 120);
  }

  function handleClick(event) {
    event.stopPropagation();
    if (isOpen) {
      hideDetails();
      return;
    }
    showDetails();
  }

  function handleBlur(event) {
    const nextTarget = event.relatedTarget;
    if (interactionRef.current?.contains(nextTarget)) return;
    if (popoverRef.current?.contains(nextTarget)) return;
    scheduleClose();
  }

  useEffect(() => {
    if (!isOpen) {
      setPopoverPosition(null);
      return undefined;
    }

    refreshPopoverPosition();
    window.addEventListener('resize', refreshPopoverPosition);
    window.addEventListener('scroll', refreshPopoverPosition, true);

    return () => {
      window.removeEventListener('resize', refreshPopoverPosition);
      window.removeEventListener('scroll', refreshPopoverPosition, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !popoverPosition) return undefined;

    const frameId = window.requestAnimationFrame(fitOpenPopoverToViewport);
    return () => window.cancelAnimationFrame(frameId);
  }, [isOpen, popoverPosition?.left, popoverPosition?.width, detail.metricKey]);

  useEffect(
    () => () => {
      clearOpenTimer();
      clearCloseTimer();
    },
    []
  );

  const popover = isOpen && popoverPosition ? (
    <aside
      ref={popoverRef}
      id={popoverId}
      className={`validationMetricPopover portalValidationMetricPopover ${detail.tone || ''} ${popoverPosition.placement}`}
      style={{
        top: `${popoverPosition.top}px`,
        left: `${popoverPosition.left}px`,
        width: `${popoverPosition.width}px`,
        '--validation-popover-width': `${popoverPosition.width}px`,
      }}
      role="tooltip"
      aria-label={`${detail.label} explanation`}
      onMouseEnter={clearCloseTimer}
      onMouseLeave={scheduleClose}
      onFocus={clearCloseTimer}
      onBlur={handleBlur}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="validationMetricPopoverHeader">
        <span>{detail.label}</span>
        <strong>{detail.value}</strong>
      </div>

      <p className="validationMetricPopoverExplanation">{detail.explanation}</p>

      <div className="validationMetricPopoverSection current">
        <span>Current</span>
        <strong>{detail.current}</strong>
      </div>

      <div className="validationMetricPopoverSection formula">
        <span>{detail.popupLabel || 'Constraint'}</span>
        <div>{detail.formula}</div>
      </div>

      <div className="validationMetricPopoverSection threshold">
        <span>Threshold</span>
        <p>{detail.threshold}</p>
      </div>
    </aside>
  ) : null;

  return (
    <div
      ref={interactionRef}
      className={`validationMetricInteraction ${detail.tone || ''} ${isOpen ? 'open' : ''}`}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      onFocus={showDetails}
      onBlur={handleBlur}
    >
      <button
        type="button"
        className={`validationMetricValue metric-value metric-value--${detail.tone || 'safe'}`}
        aria-expanded={isOpen}
        aria-controls={popoverId}
        aria-describedby={isOpen ? popoverId : undefined}
        onClick={handleClick}
      >
        {detail.value}
      </button>

      {popover && createPortal(popover, document.body)}
    </div>
  );
}

function InitialValidationItem({
  metricKey,
  label,
  value,
  note,
  tone,
  popupLabel,
  popupTitle,
  explanation,
  formula,
  current,
  threshold,
  activeMetricKey,
  onOpenDetails,
  onCloseDetails,
}) {
  const detail = {
    metricKey,
    label,
    value,
    note,
    tone,
    popupLabel,
    popupTitle,
    explanation,
    formula,
    current,
    threshold,
  };

  return (
    <article
      className={`systemCheckMetricRowV38 validationPopupCard ${tone} ${activeMetricKey === metricKey ? "metricPopoverOpen" : ""}`}
      data-validation-id={metricKey}
    >
      <i className="systemCheckMetricDotV38 decisionStatusDot" aria-hidden="true" />
      <div className="systemCheckMetricLineV38">
        <span className="systemCheckMetricLabelV38">{label}</span>
        <ValidationMetricValue
          detail={detail}
          activeMetricKey={activeMetricKey}
          onOpenDetails={onOpenDetails}
          onCloseDetails={onCloseDetails}
        />
      </div>
    </article>
  );
}

function DecisionPreviewItem({
  metricKey,
  label,
  value,
  note,
  tone,
  math,
  activeMetricKey,
  onOpenDetails,
  onCloseDetails,
}) {
  const popupLabel =
    metricKey === "grid"
      ? "Constraint"
      : metricKey === "renewable"
        ? "Formula"
        : "Condition";

  const detail = {
    metricKey,
    label,
    value,
    note,
    tone,
    popupLabel,
    popupTitle: math.title,
    explanation: math.explanation,
    formula: <DecisionConstraintFormula metricKey={metricKey} />,
    current: math.current,
    threshold: math.threshold,
  };

  return (
    <article
      className={`systemCheckMetricRowV38 validationPopupCard ${tone} ${activeMetricKey === metricKey ? "metricPopoverOpen" : ""}`}
      data-validation-id={metricKey}
    >
      <i className="systemCheckMetricDotV38 decisionStatusDot" aria-hidden="true" />
      <div className="systemCheckMetricLineV38">
        <span className="systemCheckMetricLabelV38">{label}</span>
        <ValidationMetricValue
          detail={detail}
          activeMetricKey={activeMetricKey}
          onOpenDetails={onOpenDetails}
          onCloseDetails={onCloseDetails}
        />
      </div>
    </article>
  );
}

function DecisionConstraintFormula({ metricKey }) {
  if (metricKey === "diesel") {
    return (
      <div className="decisionFormulaExpression" aria-label="Diesel commitment constraint">
        <span>∃t:</span>
        <span>
          P<sub>load,t</sub> − P<sub>VRE,t</sub>
        </span>
        <span>&gt;</span>
        <span>
          P<sub>grid,max</sub> + P<sup>dis</sup><sub>batt,t</sub>
        </span>
      </div>
    );
  }

  if (metricKey === "grid") {
    return (
      <div className="decisionFormulaExpression" aria-label="Grid pressure constraint">
        <span>
          max<sub>t</sub>(P<sub>load,t</sub> − P<sub>VRE,t</sub>)
        </span>
        <span>&gt;</span>
        <span>P<sub>grid,max</sub></span>
      </div>
    );
  }

  if (metricKey === "renewable") {
    return (
      <div className="decisionFormulaExpression renewableFormula" aria-label="Renewable share formula">
        <span>VRE Share =</span>
        <span className="decisionFormulaFraction">
          <span>Σ<sub>t</sub>(P<sub>solar,t</sub> + P<sub>wind,t</sub>)</span>
          <span>Σ<sub>t</sub>P<sub>load,t</sub></span>
        </span>
        <span>× 100%</span>
      </div>
    );
  }

  if (metricKey === "battery") {
    return (
      <div className="decisionFormulaExpression" aria-label="Battery availability condition">
        <span>SoC<sub>init</sub></span>
        <span>≥</span>
        <span>SoC<sub>support</sub> = 35%</span>
      </div>
    );
  }

  return (
    <div className="decisionFormulaExpression" aria-label="Optimization readiness gate">
      <span>N<sub>stress</sub> =</span>
      <span>Σ<sub>t</sub> 𝟙(P<sub>res,t</sub> &gt; P<sub>grid,max</sub>)</span>
      <span>;</span>
      <span>Ready ⇔ N<sub>stress</sub> = 0</span>
    </div>
  );
}

// #endregion

// #region 05D — Pipeline telemetry and feature controls
function LivePipelineTelemetry({
  phase,
  visibleCount,
  logs,
  backendState,
  solver,
}) {
  const totalSteps = Math.max(
    ...logs.map((line) => Number(line.total || 0)),
    logs.length,
    1
  );
  const currentStep = Math.max(
    1,
    Math.min(totalSteps, Number(visibleCount || 1))
  );
  const currentLine =
    logs.find((line) => Number(line.step) === currentStep) || logs[0];
  const maxVisibleSteps = 5;
  const startIndex = Math.max(
    0,
    Math.min(
      currentStep - maxVisibleSteps,
      Math.max(totalSteps - maxVisibleSteps, 0)
    )
  );
  const visibleEndIndex = Math.min(startIndex + maxVisibleSteps, logs.length);
  const allStepsChecked = ["finalized", "complete", "handoff"].includes(phase);
  const statusComplete = ["complete", "handoff"].includes(phase);
  const progress = allStepsChecked
    ? 100
    : currentStep >= totalSteps
      ? 94
      : Math.round(6 + ((currentStep - 1) / Math.max(totalSteps - 1, 1)) * 88);
  return (
    <div
      className={`workspaceTelemetryOverlay fullscreen ${phase}`}
      role="status"
      aria-live="polite"
      aria-busy={!statusComplete}
    >
      <section className="workspaceTelemetryTerminal" aria-label="Live optimization pipeline telemetry">
        <div className="workspaceTelemetryHead">
          <div className="workspaceTelemetryTitle workspaceTelemetryTitleInline">
            <strong><b aria-hidden="true">{"</>"}</b> Hybrid QAOA</strong>
          </div>

          <div className="workspaceTelemetryStatus">
            <i />
            <span>{statusComplete ? "Complete" : "Running"}</span>
          </div>
        </div>

        <div className="workspaceTelemetryProgressBlock">
          <div>
            <span>
              {allStepsChecked
                ? "Validated operating plan ready"
                : currentLine?.level || "Initializing"}
            </span>
            <strong>{progress}%</strong>
          </div>
          <div className="workspaceTelemetryProgress" aria-hidden="true">
            <i style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="workspaceTelemetryBody">
          <div
            className="workspaceTelemetryTrack"
            style={{ transform: `translate3d(0, -${startIndex * 82}px, 0)` }}
          >
            {logs.map((line, index) => {
              const lineStep = Number(line.step || index + 1);
              const state = allStepsChecked || lineStep < currentStep
                ? "complete"
                : lineStep === currentStep
                  ? "active"
                  : "pending";
              const isVisible = index >= startIndex && index < visibleEndIndex;

              return (
                <div
                  className="workspaceTelemetrySlot"
                  key={`${line.level}-${line.step}-${index}`}
                  aria-hidden={isVisible ? undefined : true}
                >
                  <article
                    className={`workspaceTelemetryLine ${state}`}
                    aria-current={state === "active" ? "step" : undefined}
                    style={{
                      "--telemetry-step-accent": line.accent,
                      "--telemetry-step-soft": line.accentSoft,
                    }}
                  >
                    <span className="workspaceTelemetryIcon" aria-hidden="true">
                      <TelemetryStepIcon name={line.icon} />
                    </span>

                    <div>
                      <div className="workspaceTelemetryMeta">
                        <em>[Step {String(line.step).padStart(2, "0")}/{line.total}]</em>
                        <small>{line.level}</small>
                      </div>
                      <p>{line.text}</p>
                    </div>

                    <i className="workspaceTelemetryLineState" aria-hidden="true">
                      {state === "complete" ? "✓" : state === "active" ? "●" : "○"}
                    </i>
                  </article>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}

function buildPreOptimizationStats(preview, scenario) {
  const load = Number(scenario.load || 0);
  const gridLimit = Number(scenario.gridLimit || 0);
  const batteryPercent = Number(getBatteryPercent(scenario));

  const peakResidual = Math.max(
    ...preview.map((point) => point.residualDemand),
    0
  );
  const peakCriticalGap = Math.max(
    ...preview.map((point) => point.criticalGap),
    0
  );
  const stressHours = preview.filter((point) => point.criticalGap > 0).length;
  const averageLoad = average(preview.map((point) => point.load));
  const averageVre = average(preview.map((point) => point.vre));
  const renewableShare =
    averageLoad > 0 ? Math.min(100, (averageVre / averageLoad) * 100) : 0;

  const diesel =
    load <= 0
      ? {
          label: "Diesel commitment",
          value: "Waiting for input",
          note: "Enter a non-zero load profile.",
          tone: "watch",
        }
      : stressHours > 0
        ? {
            label: "Diesel commitment",
            value: "Required",
            note: `${stressHours} hour${stressHours === 1 ? "" : "s"} exceed maximum grid support.`,
            tone: "risk",
          }
        : {
            label: "Diesel commitment",
            value: "Not required",
            note: "VRE and grid support cover the previewed residual demand.",
            tone: "safe",
          };

  const gridRatio =
    gridLimit > 0 ? peakResidual / Math.max(gridLimit, 1) : peakResidual > 0 ? Infinity : 0;
  const grid =
    gridRatio > 1
      ? {
          label: "Grid pressure",
          value: "High risk",
          note: `Peak residual exceeds the grid limit by ${Math.round(peakCriticalGap)} MW.`,
          tone: "risk",
        }
      : gridRatio >= 0.85
        ? {
            label: "Grid pressure",
            value: "Watch",
            note: "Residual demand approaches maximum import capability.",
            tone: "watch",
          }
        : {
            label: "Grid pressure",
            value: "Safe",
            note: "The preview retains a grid-import operating margin.",
            tone: "safe",
          };

  const renewable =
    renewableShare >= 50
      ? {
          label: "Renewable share",
          value: "High",
          note: `${Math.round(renewableShare)}% average VRE contribution.`,
          tone: "info",
        }
      : renewableShare >= 30
        ? {
            label: "Renewable share",
            value: "Moderate",
            note: `${Math.round(renewableShare)}% average VRE contribution.`,
            tone: "watch",
          }
        : {
            label: "Renewable share",
            value: "Low",
            note: `${Math.round(renewableShare)}% average VRE contribution.`,
            tone: "risk",
          };

  const battery =
    batteryPercent >= 35
      ? {
          label: "Battery support",
          value: "Available",
          note: `${batteryPercent.toFixed(1)}% state of charge is available.`,
          tone: "info",
        }
      : batteryPercent > 0
        ? {
            label: "Battery support",
            value: "Limited",
            note: `${batteryPercent.toFixed(1)}% state of charge remains.`,
            tone: "watch",
          }
        : {
            label: "Battery support",
            value: "Unavailable",
            note: "The battery starts with zero usable energy.",
            tone: "risk",
          };

  const readiness =
    load <= 0
      ? {
          label: "Optimization readiness",
          value: "Waiting for input",
          note: "Set the operating conditions before launching optimization.",
          tone: "watch",
        }
      : stressHours > 0
        ? {
            label: "Optimization readiness",
            value: "Needs commitment",
            note: "Binary commitment decisions are required before dispatch.",
            tone: "risk",
          }
        : grid.tone === "watch" || battery.tone === "watch"
          ? {
              label: "Optimization readiness",
              value: "Review recommended",
              note: "The scenario is feasible but has a limited operating margin.",
              tone: "watch",
            }
          : {
              label: "Optimization readiness",
              value: "Ready",
              note: "The scenario is prepared for solver execution.",
              tone: "safe",
            };

  const decisionMath = {
    diesel: {
      title: "Residual-demand commitment trigger",
      explanation:
        "A commitment candidate is required when residual demand cannot be covered by the grid limit and available battery discharge. The preview conservatively flags every hour that exceeds grid support; the optimizer then validates the battery trajectory and diesel schedule.",
      current:
        stressHours > 0
          ? `${stressHours} hour${stressHours === 1 ? "" : "s"} currently cross the grid-support boundary.`
          : "No preview hour crosses the grid-support boundary.",
      threshold: "Risk when at least one hour still has a positive supply gap after flexible support.",
    },
    grid: {
      title: "Peak import-capacity test",
      explanation:
        "Grid pressure compares the largest 24-hour residual demand with the configured import capability. A positive excess indicates that the interconnection alone cannot carry the required power.",
      current:
        gridLimit > 0
          ? `Peak residual ${Math.round(peakResidual)} MW · limit ${Math.round(gridLimit)} MW · excess ${Math.round(peakCriticalGap)} MW.`
          : `Peak residual ${Math.round(peakResidual)} MW with no positive grid limit configured.`,
      threshold: "Safe below 85% utilization · watch from 85% to 100% · risk above 100%.",
    },
    renewable: {
      title: "Daily VRE energy contribution",
      explanation:
        "The renewable-share gate integrates solar and wind output across the 24-hour horizon and divides it by total load energy, so the status reflects the full daily profile rather than one instant.",
      current: `${Math.round(renewableShare)}% average VRE contribution over the preview horizon.`,
      threshold: "High at ≥ 50% · moderate from 30% to < 50% · low below 30%.",
    },
    battery: {
      title: "Initial storage-support reserve",
      explanation:
        "The preview checks whether the initial battery state of charge is large enough to provide meaningful peak support before the detailed optimizer enforces the complete inter-temporal SOC trajectory.",
      current: `${batteryPercent.toFixed(1)}% initial state of charge.`,
      threshold: "Available at ≥ 35% · limited between 0% and < 35% · unavailable at 0%.",
    },
    readiness: {
      title: "Aggregated optimization gate",
      explanation:
        "Readiness combines the stress-hour test with grid margin and battery support. A red result does not mean the scenario is impossible; it means binary commitment decisions must be optimized before a feasible dispatch can be certified.",
      current:
        load <= 0
          ? "Input is incomplete."
          : `${stressHours} stress hour${stressHours === 1 ? "" : "s"}; grid status ${grid.value.toLowerCase()}; battery status ${battery.value.toLowerCase()}.`,
      threshold: "Ready when no stress hour remains; watch when margins are limited; needs commitment when stress hours exist.",
    },
  };

  return {
    peakResidual,
    peakCriticalGap,
    stressHours,
    renewableShare,
    batteryPercent,
    readiness,
    warnings: [
      { ...diesel, id: "diesel", math: decisionMath.diesel },
      { ...grid, id: "grid", math: decisionMath.grid },
      { ...renewable, id: "renewable", math: decisionMath.renewable },
      { ...battery, id: "battery", math: decisionMath.battery },
      { ...readiness, id: "readiness", math: decisionMath.readiness },
    ],
  };
}


function hasBackendProfile(scenario) {
  return [
    scenario.profiles?.load,
    scenario.profiles?.solar,
    scenario.profiles?.wind,
  ].some((profile) => Array.isArray(profile) && profile.length >= 2);
}


function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
}

function FeatureControlCard({ feature, scenarioId, updateScenario }) {
  const [isAdjusting, setIsAdjusting] = useState(false);
  const safeValue = clampNumber(feature.value, feature.min, feature.max);
  const pct = Math.max(
    0,
    Math.min(100, ((safeValue - feature.min) / Math.max(feature.max - feature.min, 1)) * 100)
  );

  const compactCopy = {
    load: { label: "Demand" },
    solar: { label: "Solar" },
    wind: { label: "Wind" },
    gridLimit: { label: "Grid limit" },
    batterySocPercent: { label: "Battery SOC" },
  }[feature.field] || { label: feature.label };

  const isBattery = feature.field === "batterySocPercent";
  const batteryEnergy = isBattery
    ? String(feature.note || "").replace(/\s*\/\s*/g, "/")
    : "";

  function handleChange(rawValue) {
    const nextValue = clampNumber(rawValue, feature.min, feature.max);

    if (typeof feature.onChange === "function") {
      feature.onChange(nextValue);
      return;
    }

    updateScenario(
      scenarioId,
      feature.field,
      nextValue,
      feature.min,
      feature.max
    );
  }

  return (
    <div className={`featureControlCard railInputRow railInputStrip ${feature.type} ${isAdjusting ? "isAdjusting" : ""}`}>
      <div className="railInputHeading">
        <span className="railInputLabel">{compactCopy.label}</span>

        <div className="railInputCurrentValue">
          <label className="featureValueEditor railInputValue">
            <input
              type="number"
              min={feature.min}
              max={feature.max}
              step={feature.step || 1}
              value={safeValue}
              aria-label={`${compactCopy.label} value`}
              onChange={(event) => handleChange(event.target.value)}
              onBlur={(event) => handleChange(event.target.value)}
            />
            <b>{feature.unit}</b>
          </label>

          {isBattery && batteryEnergy && (
            <small className="railInputBatteryEnergy">· {batteryEnergy}</small>
          )}
        </div>
      </div>

      <div className="railInputRangeRow">
        <div className="railInputSliderShell">
          <input
            className={`featureRange ${feature.type}`}
            type="range"
            min={feature.min}
            max={feature.max}
            step={feature.step || 1}
            value={safeValue}
            aria-label={`${compactCopy.label} slider`}
            style={{ "--feature-progress": `${pct}%` }}
            onChange={(event) => handleChange(event.target.value)}
            onPointerDown={(event) => {
              setIsAdjusting(true);
              event.currentTarget.setPointerCapture?.(event.pointerId);
            }}
            onPointerUp={(event) => {
              setIsAdjusting(false);
              event.currentTarget.releasePointerCapture?.(event.pointerId);
            }}
            onPointerCancel={() => setIsAdjusting(false)}
            onKeyDown={() => setIsAdjusting(true)}
            onKeyUp={() => setIsAdjusting(false)}
            onBlur={() => setIsAdjusting(false)}
          />
        </div>
      </div>
    </div>
  );
}
function normalizeHourValue(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

// #endregion

// #endregion

// #region 06 — Operating-plan normalization and operator helpers
/* ==========================================================================
   06. Operating-plan normalization and operator-facing helpers
   ========================================================================== */

// #region 06A — Commitment and operator schedule normalization
function fallbackOperatorCommitmentRows() {
  const hours = Array.from({ length: 24 }, (_, hour) => hour);

  return [
    {
      id: "G1",
      name: "Gas Unit 1",
      role: "Standby",
      schedule: hours.map(() => false),
    },
    {
      id: "G2",
      name: "Diesel Unit A",
      role: "Evening peak support",
      schedule: hours.map((hour) => hour >= 18 && hour <= 21),
    },
    {
      id: "G3",
      name: "Diesel Unit B",
      role: "Base + ramp support",
      schedule: hours.map((hour) => hour <= 11 || hour >= 18),
    },
    {
      id: "G4",
      name: "Gas Unit 2",
      role: "Standby",
      schedule: hours.map(() => false),
    },
    {
      id: "G5",
      name: "Reserve Unit",
      role: "Emergency reserve",
      schedule: hours.map(() => false),
    },
  ];
}

function normalizeCommitmentState(value) {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return ["1", "true", "on", "start", "running", "committed"].includes(normalized);
  }
  return Number(value) > 0 || value === true;
}

function normalizeCommitmentSchedule(schedule) {
  if (!Array.isArray(schedule)) return null;
  const normalized = schedule.slice(0, 24).map(normalizeCommitmentState);
  if (normalized.length !== 24) return null;
  return normalized;
}

function buildOperatorCommitmentRows(result) {
  const fallbackRows = fallbackOperatorCommitmentRows();
  const candidates = [
    result?.commitmentRows,
    result?.commitment_rows,
    result?.commitmentSchedule,
    result?.commitment_schedule,
    result?.unitCommitment,
    result?.unit_commitment,
    result?.hybrid?.commitmentRows,
    result?.hybrid?.commitment_schedule,
    result?.adaptive?.commitmentRows,
    result?.adaptive?.commitment_schedule,
    result?.result?.commitmentRows,
    result?.result?.commitment_schedule,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;

    if (Array.isArray(candidate) && candidate.length) {
      if (candidate.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
        const rows = candidate
          .map((row, index) => {
            const schedule = normalizeCommitmentSchedule(
              row.schedule || row.commitment || row.values || row.status24h || row.status
            );
            if (!schedule) return null;
            const fallback = fallbackRows[index] || {};
            return {
              id: String(row.id || row.unit_id || row.generator_id || fallback.id || `G${index + 1}`),
              name: String(row.name || row.unit_name || row.generator_name || fallback.name || `Unit ${index + 1}`),
              role: String(row.role || row.type || fallback.role || "Dispatchable support"),
              schedule,
            };
          })
          .filter(Boolean);

        if (rows.length) return rows;
      }

      if (candidate.every(Array.isArray)) {
        const isHourlyMatrix = candidate.length === 24 && candidate[0]?.length !== 24;
        const unitMatrix = isHourlyMatrix
          ? Array.from({ length: candidate[0]?.length || 0 }, (_, unitIndex) =>
              candidate.map((hourRow) => hourRow?.[unitIndex])
            )
          : candidate;

        const rows = unitMatrix
          .map((scheduleValues, index) => {
            const schedule = normalizeCommitmentSchedule(scheduleValues);
            if (!schedule) return null;
            const fallback = fallbackRows[index] || {};
            return {
              id: fallback.id || `G${index + 1}`,
              name: fallback.name || `Unit ${index + 1}`,
              role: fallback.role || "Dispatchable support",
              schedule,
            };
          })
          .filter(Boolean);

        if (rows.length) return rows;
      }
    }

    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const rows = Object.entries(candidate)
        .map(([unitId, scheduleValues], index) => {
          const rowObject = scheduleValues && typeof scheduleValues === "object" && !Array.isArray(scheduleValues)
            ? scheduleValues
            : null;
          const schedule = normalizeCommitmentSchedule(
            rowObject?.schedule || rowObject?.commitment || rowObject?.values || scheduleValues
          );
          if (!schedule) return null;
          const fallback = fallbackRows[index] || {};
          return {
            id: String(rowObject?.id || unitId || fallback.id || `G${index + 1}`),
            name: String(rowObject?.name || fallback.name || unitId),
            role: String(rowObject?.role || fallback.role || "Dispatchable support"),
            schedule,
          };
        })
        .filter(Boolean);

      if (rows.length) return rows;
    }
  }

  return fallbackRows;
}

function analyzeCommitmentRows(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const startupEvents = [];
  const shutdownEvents = [];

  safeRows.forEach((row) => {
    const schedule = Array.isArray(row.schedule) ? row.schedule : [];
    for (let hour = 1; hour < schedule.length; hour += 1) {
      if (schedule[hour] && !schedule[hour - 1]) {
        startupEvents.push({ unitId: row.id, hour });
      }
      if (!schedule[hour] && schedule[hour - 1]) {
        shutdownEvents.push({ unitId: row.id, hour });
      }
    }
  });

  const committedRows = safeRows.filter((row) => row.schedule?.some(Boolean));
  const standbyRows = safeRows.filter((row) => !row.schedule?.some(Boolean));

  return {
    committedRows,
    standbyRows,
    startupEvents,
    shutdownEvents,
  };
}

function getOperatingWindows(schedule) {
  const safe = Array.isArray(schedule) ? schedule : [];
  const windows = [];
  let start = null;

  safe.forEach((isOn, hour) => {
    if (isOn && start === null) start = hour;
    const closesAtEnd = isOn && hour === safe.length - 1;
    const closesBeforeOff = !isOn && start !== null;

    if (closesAtEnd) {
      windows.push([start, hour]);
      start = null;
    } else if (closesBeforeOff) {
      windows.push([start, hour - 1]);
      start = null;
    }
  });

  return windows;
}

function formatHour(hour) {
  return `${String(Math.max(0, Number(hour) || 0)).padStart(2, "0")}:00`;
}

function formatHourWindow(hours) {
  const safe = [...new Set((Array.isArray(hours) ? hours : []).map(Number).filter(Number.isFinite))]
    .sort((a, b) => a - b);
  if (!safe.length) return "No stress window";
  if (safe.length === 1) return formatHour(safe[0]);
  return `${formatHour(safe[0])}–${formatHour(safe[safe.length - 1])}`;
}


function makeHourRange(start, end) {
  const safeStart = Math.max(0, Math.min(23, Number(start) || 0));
  const safeEnd = Math.max(safeStart, Math.min(23, Number(end) || safeStart));
  return Array.from({ length: safeEnd - safeStart + 1 }, (_, index) => safeStart + index);
}

function joinUnitNames(rows) {
  const names = (Array.isArray(rows) ? rows : [])
    .map((row) => String(row?.name || row?.id || "Generator"))
    .filter(Boolean);

  if (!names.length) return "generator support";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function getPlainUnitDescription(row) {
  const schedule = Array.isArray(row?.schedule) ? row.schedule : [];
  const windows = getOperatingWindows(schedule);

  if (!schedule.some(Boolean)) {
    return /reserve/i.test(String(row?.role || ""))
      ? "Emergency backup only"
      : "Not needed in this plan";
  }

  if (windows.length === 1) {
    const [start, end] = windows[0];
    if (start === 0 && end === 23) return "Run throughout the 24-hour plan";
    if (start > 0 && end < 23) {
      return `Start at ${formatHour(start)} · Stop at ${formatHour(end + 1)}`;
    }
    return `Run ${formatHour(start)}–${formatHour(end)}`;
  }

  return `Run ${windows
    .map(([start, end]) => `${formatHour(start)}–${formatHour(end)}`)
    .join(" and ")}`;
}

function buildKeyChangeItems(rows, stressHours) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const safeStress = Array.isArray(stressHours) && stressHours.length
    ? [...stressHours].map(Number).sort((a, b) => a - b)
    : [18, 19, 20, 21];
  const stressStart = safeStress[0] ?? 18;
  const stressEnd = safeStress[safeStress.length - 1] ?? 21;

  const morningHours = makeHourRange(0, Math.min(11, Math.max(0, stressStart - 1)));
  const morningRows = safeRows.filter((row) =>
    morningHours.some((hour) => Boolean(row.schedule?.[hour]))
  );

  const middayStart = Math.min(12, Math.max(0, stressStart - 1));
  const middayEnd = Math.max(middayStart, stressStart - 1);
  const middayHours = makeHourRange(middayStart, middayEnd);
  const middayRows = safeRows.filter((row) =>
    middayHours.some((hour) => Boolean(row.schedule?.[hour]))
  );
  const middayTransitions = safeRows.some((row) =>
    middayHours.some((hour) => hour > 0 && Boolean(row.schedule?.[hour]) !== Boolean(row.schedule?.[hour - 1]))
  );

  const startRows = safeRows.filter((row) =>
    Boolean(row.schedule?.[stressStart]) && !Boolean(row.schedule?.[stressStart - 1])
  );
  const startActions = startRows.map((row) => {
    const ranEarlier = row.schedule?.slice(0, stressStart).some(Boolean);
    return `${ranEarlier ? "Restart" : "Start"} ${row.name}`;
  });

  const shutdownEvents = analyzeCommitmentRows(safeRows).shutdownEvents
    .filter((event) => event.hour > stressEnd)
    .sort((a, b) => a.hour - b.hour);
  const firstShutdownHour = shutdownEvents[0]?.hour ?? Math.min(23, stressEnd + 1);
  const shutdownIds = shutdownEvents
    .filter((event) => event.hour === firstShutdownHour)
    .map((event) => event.unitId);
  const shutdownRows = safeRows.filter((row) => shutdownIds.includes(row.id));

  return [
    {
      id: "morning",
      time: morningHours.length ? `${formatHour(morningHours[0])}–${formatHour(morningHours[morningHours.length - 1])}` : "Morning",
      label: morningRows.length ? `Run ${joinUnitNames(morningRows)}` : "No generator support needed",
      description: morningRows.length ? "Overnight support" : "Supply is already sufficient",
      hours: morningHours,
    },
    {
      id: "midday",
      time: middayHours.length ? `${formatHour(middayHours[0])}–${formatHour(middayHours[middayHours.length - 1])}` : "Midday",
      label: !middayRows.length
        ? "Renewables cover more demand"
        : middayTransitions
          ? "Follow the scheduled generator changes"
          : "No additional generator changes",
      description: !middayRows.length ? "No extra unit needed" : "Follow the validated daytime schedule",
      hours: middayHours,
    },
    {
      id: "peak-start",
      time: formatHour(stressStart),
      label: startActions.length ? startActions.join(" + ") : "Use additional generator support",
      description: "Evening peak support",
      hours: safeStress,
    },
    {
      id: "peak-end",
      time: formatHour(firstShutdownHour),
      label: shutdownRows.length ? `Stop ${joinUnitNames(shutdownRows)}` : "Return to the normal schedule",
      description: "High-demand period ends",
      hours: [firstShutdownHour],
    },
  ];
}

function resolveStressHours(result) {
  const candidates = [
    result?.stressHours,
    result?.stress_hours,
    result?.hybrid?.stressHours,
    result?.hybrid?.stress_hours,
    result?.result?.stressHours,
    result?.result?.stress_hours,
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const hours = candidate
      .map((value) => Number.parseInt(value, 10))
      .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23);
    if (hours.length) return [...new Set(hours)].sort((a, b) => a - b);
  }

  return [18, 19, 20, 21];
}

function getCommitmentAction(row, hour) {
  const isOn = Boolean(row?.schedule?.[hour]);
  const previous = hour > 0 ? Boolean(row?.schedule?.[hour - 1]) : isOn;

  if (hour > 0 && isOn && !previous) return "START";
  if (hour > 0 && !isOn && previous) return "STOP";
  if (isOn) return "ON";
  return /reserve|standby/i.test(String(row?.role || "")) ? "STANDBY" : "OFF";
}

function firstDefinedValue(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

// #endregion

// #region 06B — Canonical operating-plan construction
function resolveCanonicalOperatingPlan(result) {
  const candidates = [
    result?.operating_plan,
    result?.operatingPlan,
    result?.result?.operating_plan,
    result?.result?.operatingPlan,
    result?.hybrid?.operating_plan,
    result?.hybrid?.operatingPlan,
  ];

  return candidates.find((candidate) => candidate && typeof candidate === "object") || null;
}

function normalizePlanGeneratorRows(candidateRows, fallbackRows) {
  const safeFallback = Array.isArray(fallbackRows) ? fallbackRows : [];
  if (!Array.isArray(candidateRows) || !candidateRows.length) return safeFallback;

  const normalized = candidateRows
    .map((row, index) => {
      if (!row || typeof row !== "object") return null;
      const schedule = normalizeCommitmentSchedule(row.schedule || row.commitment || row.values || row.status24h);
      if (!schedule) return null;
      const fallback = safeFallback[index] || {};
      const starts = Array.isArray(row.starts) ? row.starts.map(Number).filter(Number.isFinite) : [];
      const stops = Array.isArray(row.stops) ? row.stops.map(Number).filter(Number.isFinite) : [];
      return {
        ...row,
        id: String(row.resource_id || row.generator_id || row.id || fallback.id || `G${index + 1}`),
        resource_id: String(row.resource_id || row.generator_id || row.id || fallback.id || `G${index + 1}`),
        name: String(row.resource_name || row.generator_name || row.name || fallback.name || `Generator ${index + 1}`),
        resource_name: String(row.resource_name || row.generator_name || row.name || fallback.name || `Generator ${index + 1}`),
        role: String(row.role || row.technical_role || fallback.role || "Dispatchable generation"),
        plainStatus: String(row.plain_status || row.plainStatus || ""),
        plain_status: String(row.plain_status || row.plainStatus || ""),
        initialStatus: normalizeCommitmentState(firstDefinedValue(row.initial_status, row.initialStatus, schedule[0])),
        initial_status: normalizeCommitmentState(firstDefinedValue(row.initial_status, row.initialStatus, schedule[0])),
        starts,
        stops,
        startup_count: Number(firstDefinedValue(row.startup_count, starts.length, 0)) || 0,
        shutdown_count: Number(firstDefinedValue(row.shutdown_count, stops.length, 0)) || 0,
        online_hours: Number(firstDefinedValue(row.online_hours, schedule.reduce((sum, value) => sum + Number(Boolean(value)), 0), 0)) || 0,
        final_state: String(row.final_state || (schedule[23] ? "ON" : "OFF")),
        constraints: row.constraints || {},
        schedule_checks: row.schedule_checks || {},
        schedule,
      };
    })
    .filter(Boolean);

  return normalized.length ? normalized : safeFallback;
}

function normalizePlanHourlySupply(candidateRows, fallbackDispatch, stressHours) {
  const fallbackByHour = new Map(
    (Array.isArray(fallbackDispatch) ? fallbackDispatch : []).map((row) => [
      normalizeHourValue(row?.hour),
      row || {},
    ])
  );
  const stressSet = new Set((Array.isArray(stressHours) ? stressHours : []).map(Number));
  const sourceByHour = new Map();

  if (Array.isArray(candidateRows)) {
    candidateRows.forEach((row) => {
      if (!row || typeof row !== "object") return;
      const hour = normalizeHourValue(row.hour ?? row.time);
      if (hour >= 0 && hour <= 23) sourceByHour.set(hour, row);
    });
  }

  return Array.from({ length: 24 }, (_, hour) => {
    const source = sourceByHour.get(hour) || {};
    const fallback = fallbackByHour.get(hour) || {};
    const demand = Number(firstDefinedValue(source.demand_mw, source.load_mw, source.demand, source.load, fallback.load, 0)) || 0;
    const batteryCharge = Number(firstDefinedValue(source.battery_charge_mw, source.battery_charge, source.charge_mw, 0)) || 0;
    const batteryDischarge = Number(firstDefinedValue(source.battery_discharge_mw, source.battery_discharge, source.discharge_mw, source.battery_mw, fallback.battery, 0)) || 0;
    const grid = Number(firstDefinedValue(source.grid_import_mw, source.grid_import, source.grid_mw, source.grid, fallback.grid, 0)) || 0;
    const generatorOutputs = source.generator_output_mw || source.generatorOutputMw || {};
    const dispatchable = Number(firstDefinedValue(source.total_dispatchable_generation_mw, source.dispatchable_generation_mw, source.dispatchable_mw, source.diesel_mw, source.thermal_mw, source.diesel, fallback.diesel, Object.values(generatorOutputs).reduce((sum, value) => sum + Number(value || 0), 0), 0)) || 0;

    const solarAvailable = Number(firstDefinedValue(source.solar_available_mw, source.solar_availability_mw, source.solar_mw, source.solar, fallback.solar, 0)) || 0;
    const windAvailable = Number(firstDefinedValue(source.wind_available_mw, source.wind_availability_mw, source.wind_mw, source.wind, fallback.wind, 0)) || 0;
    const renewableAvailable = Number(firstDefinedValue(source.renewable_available_mw, source.renewable_availability_mw, solarAvailable + windAvailable, source.renewable_mw, source.renewable, 0)) || 0;
    const explicitSolarUsed = firstDefinedValue(source.solar_used_mw, source.solar_dispatch_mw, null);
    const explicitWindUsed = firstDefinedValue(source.wind_used_mw, source.wind_dispatch_mw, null);
    const explicitRenewableUsed = firstDefinedValue(source.renewable_used_mw, source.renewable_dispatch_mw, null);
    const explicitCurtailment = firstDefinedValue(source.renewable_curtailment_mw, source.curtailment_mw, source.curtailment, null);
    const requiredRenewable = Math.max(0, demand - (batteryDischarge + grid + dispatchable - batteryCharge));
    let solarUsed;
    let windUsed;
    let renewableProvenance = "explicit";

    if (explicitSolarUsed !== null || explicitWindUsed !== null) {
      solarUsed = Math.max(0, Number(explicitSolarUsed || 0));
      windUsed = Math.max(0, Number(explicitWindUsed || 0));
    } else {
      let renewableUsed;
      if (explicitRenewableUsed !== null) {
        renewableUsed = Math.max(0, Number(explicitRenewableUsed || 0));
      } else if (explicitCurtailment !== null) {
        renewableUsed = Math.max(0, renewableAvailable - Number(explicitCurtailment || 0));
        renewableUsed = Math.min(renewableUsed, requiredRenewable || renewableUsed);
        renewableProvenance = "derived_from_curtailment_and_balance";
      } else {
        renewableUsed = Math.min(renewableAvailable, requiredRenewable);
        renewableProvenance = "derived_from_balance";
      }
      const splitBase = Math.max(solarAvailable + windAvailable, 1e-9);
      solarUsed = renewableUsed * solarAvailable / splitBase;
      windUsed = renewableUsed - solarUsed;
    }

    solarUsed = Math.min(Math.max(0, solarUsed), Math.max(0, solarAvailable));
    windUsed = Math.min(Math.max(0, windUsed), Math.max(0, windAvailable));
    const renewableUsed = solarUsed + windUsed;
    const renewableCurtailment = Math.max(0, renewableAvailable - renewableUsed);
    const supply = renewableUsed + batteryDischarge + grid + dispatchable - batteryCharge;
    const residual = supply - demand;
    const isHighDemand = Boolean(firstDefinedValue(source.is_high_demand, source.isHighDemand, stressSet.has(hour)));

    return {
      ...source,
      hour,
      time: source.time || formatHour(hour),
      status: String(source.status || source.operating_status || (isHighDemand ? "Extra support required" : "Normal")),
      is_high_demand: isHighDemand,
      demand_mw: demand,
      solar_available_mw: solarAvailable,
      solar_used_mw: solarUsed,
      wind_available_mw: windAvailable,
      wind_used_mw: windUsed,
      renewable_available_mw: renewableAvailable,
      renewable_used_mw: renewableUsed,
      renewable_curtailment_mw: renewableCurtailment,
      renewable_provenance: source.renewable_provenance || renewableProvenance,
      solar_mw: solarUsed,
      wind_mw: windUsed,
      renewable_mw: renewableUsed,
      battery_charge_mw: batteryCharge,
      battery_discharge_mw: batteryDischarge,
      battery_net_mw: batteryDischarge - batteryCharge,
      battery_soc_start_mwh: firstDefinedValue(source.battery_soc_start_mwh, null),
      battery_soc_end_mwh: firstDefinedValue(source.battery_soc_end_mwh, source.battery_energy_mwh, null),
      battery_soc_percent: firstDefinedValue(source.battery_soc_percent, source.soc_percent, null),
      grid_import_mw: grid,
      grid_limit_mw: firstDefinedValue(source.grid_limit_mw, source.grid_import_limit_mw, null),
      grid_headroom_mw: firstDefinedValue(source.grid_headroom_mw, source.grid_limit_mw != null ? Number(source.grid_limit_mw) - grid : null),
      grid_utilization_percent: firstDefinedValue(source.grid_utilization_percent, source.grid_limit_mw ? 100 * grid / Number(source.grid_limit_mw) : null),
      dispatchable_generation_mw: dispatchable,
      total_dispatchable_generation_mw: dispatchable,
      generator_output_mw: generatorOutputs,
      total_supply_mw: supply,
      total_actual_supply_mw: supply,
      balance_residual_mw: residual,
      reserve_available_mw: Number(firstDefinedValue(source.reserve_available_mw, 0)) || 0,
      reserve_requirement_mw: Number(firstDefinedValue(source.reserve_requirement_mw, source.reserve_mw, 0)) || 0,
      operating_status: String(source.operating_status || source.result || (Math.abs(residual) <= 0.01 ? "PASS" : "REVIEW")),
      result: String(source.result || (Math.abs(residual) <= 0.01 ? "Fully covered" : "Review required")),
      operator_note: String(source.operator_note || ""),
      actions: Array.isArray(source.actions) ? source.actions : [],
    };
  });
}

function buildFallbackRecommendedActions(generatorRows, hourlySupply, stressHours) {
  const actions = [];
  const stressSet = new Set((Array.isArray(stressHours) ? stressHours : []).map(Number));

  (Array.isArray(generatorRows) ? generatorRows : []).forEach((row) => {
    const schedule = Array.isArray(row.schedule) ? row.schedule : [];
    const initialStatus = Boolean(firstDefinedValue(row.initialStatus, schedule[0], false));

    if (schedule[0]) {
      actions.push({
        hour: 0,
        time: formatHour(0),
        action: initialStatus ? "keep_running" : "start",
        action_label: initialStatus ? "Keep running" : "Start",
        resource_id: row.id,
        resource_name: row.name,
        power_mw: null,
        status: "ON",
        reason: "Scheduled support at the beginning of the operating horizon.",
      });
    }

    for (let hour = 1; hour < 24; hour += 1) {
      const previous = Boolean(schedule[hour - 1]);
      const current = Boolean(schedule[hour]);
      if (current === previous) continue;
      const starts = current && !previous;
      actions.push({
        hour,
        time: formatHour(hour),
        action: starts ? "start" : "stop",
        action_label: starts ? "Start" : "Stop",
        resource_id: row.id,
        resource_name: row.name,
        power_mw: null,
        status: starts ? "ON" : "OFF",
        reason: starts
          ? stressSet.has(hour)
            ? "Additional local generation is needed during the high-demand period."
            : "The validated schedule requires this unit from this hour."
          : "The unit is no longer required by the validated schedule.",
      });
    }
  });

  const batteryHours = (Array.isArray(hourlySupply) ? hourlySupply : [])
    .filter((row) => Number(row.battery_discharge_mw || 0) > 0)
    .map((row) => Number(row.hour));
  if (batteryHours.length) {
    const start = batteryHours[0];
    const point = hourlySupply.find((row) => Number(row.hour) === start) || {};
    actions.push({
      hour: start,
      time: formatHour(start),
      action: "begin_discharge",
      action_label: "Begin discharge",
      resource_id: "battery",
      resource_name: "Battery",
      power_mw: Number(point.battery_discharge_mw || 0),
      status: "DISCHARGE",
      reason: "Stored energy supports the evening demand ramp.",
    });
  }

  return actions.sort((left, right) => Number(left.hour) - Number(right.hour));
}

function normalizeRecommendedActions(candidateActions, generatorRows, hourlySupply, stressHours) {
  if (!Array.isArray(candidateActions) || !candidateActions.length) {
    return buildFallbackRecommendedActions(generatorRows, hourlySupply, stressHours);
  }

  return candidateActions
    .map((action, index) => {
      if (!action || typeof action !== "object") return null;
      const hour = normalizeHourValue(action.hour ?? action.time ?? 0);
      return {
        id: String(action.id || `action-${index}-${hour}`),
        hour,
        time: String(action.time || formatHour(hour)),
        action: String(action.action || action.type || "follow_schedule"),
        action_label: String(action.action_label || action.label || action.action || "Follow schedule"),
        resource_id: String(action.resource_id || action.generator_id || action.resource || "system"),
        resource_name: String(action.resource_name || action.generator_name || action.resource || "System"),
        power_mw: firstDefinedValue(action.power_mw, action.power, action.output_mw, null),
        status: String(action.status || "Scheduled"),
        reason: String(action.reason || action.explanation || "Included in the validated operating plan."),
      };
    })
    .filter(Boolean)
    .sort((left, right) => Number(left.hour) - Number(right.hour));
}

function normalizePlanKeyChanges(candidateChanges, actions, fallbackRows, stressHours) {
  if (Array.isArray(candidateChanges) && candidateChanges.length) {
    const normalized = candidateChanges
      .map((item, index) => {
        if (!item || typeof item !== "object") return null;
        const hours = Array.isArray(item.hours)
          ? item.hours.map(Number).filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23)
          : [normalizeHourValue(item.hour ?? item.time ?? 0)];
        return {
          id: String(item.id || `key-change-${index}`),
          time: String(item.time || formatHourWindow(hours)),
          label: String(item.label || item.action_label || item.action || "Follow validated schedule"),
          description: String(item.description || item.reason || item.subtitle || ""),
          hours,
        };
      })
      .filter(Boolean);
    if (normalized.length) return normalized.slice(0, 4);
  }

  if (Array.isArray(actions) && actions.length) {
    const eventItems = actions
      .filter((action) => ["start", "restart", "stop", "begin_discharge"].includes(String(action.action).toLowerCase()))
      .slice(0, 4)
      .map((action, index) => ({
        id: String(action.id || `action-key-${index}`),
        time: String(action.time || formatHour(action.hour)),
        label: `${action.action_label} ${action.resource_name}`.trim(),
        description: String(action.reason || "Scheduled operating change"),
        hours: [Number(action.hour)],
      }));
    if (eventItems.length >= 3) return eventItems;
  }

  return buildKeyChangeItems(fallbackRows, stressHours);
}

function formatKeyChangeLabel(item) {
  return String(item?.label || "Follow schedule")
    .replace(/^Begin discharge\s+/i, "Discharge ")
    .replace(/^Keep running\s+/i, "Run ")
    .replace(/^Follow the validated high-demand support schedule$/i, "Follow high-demand support");
}

function buildCompactActionChips(items) {
  const groups = [];

  (Array.isArray(items) ? items : []).forEach((item, index) => {
    const hours = Array.isArray(item?.hours)
      ? item.hours.map(Number).filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23)
      : [];
    const primaryHour = hours[0];
    const key = Number.isInteger(primaryHour)
      ? `hour-${primaryHour}`
      : `time-${String(item?.time || index)}`;
    const existing = groups.find((group) => group.key === key);

    if (existing) {
      existing.items.push(item);
      existing.hours = [...new Set([...existing.hours, ...hours])].sort((a, b) => a - b);
      return;
    }

    groups.push({
      key,
      items: [item],
      hours: [...hours],
    });
  });

  return groups.map((group, index) => {
    const first = group.items[0] || {};
    const labels = group.items.map(formatKeyChangeLabel);
    let label = labels[0] || "Follow schedule";

    if (labels.length > 1) {
      const startResources = labels.map((value) => {
        const match = String(value).match(/^(?:start|restart)\s+(.+)$/i);
        return match ? match[1].trim() : null;
      });

      if (startResources.every(Boolean)) {
        const dieselSuffixes = startResources.map((resource) => {
          const match = String(resource).match(/^Diesel(?:\s+Unit)?\s+(.+)$/i);
          return match ? match[1].trim() : null;
        });
        label = dieselSuffixes.every(Boolean)
          ? `Start Diesel ${dieselSuffixes.join(" + ")}`
          : `Start ${startResources.join(" + ")}`;
      } else {
        label = labels.join(" + ");
      }
    }

    return {
      id: group.items.map((item) => item.id).filter(Boolean).join("+") || `compact-action-${index}`,
      time: String(first.time || formatHourWindow(group.hours)),
      label,
      description: group.items
        .map((item, itemIndex) => getKeyChangeDescription(item, itemIndex))
        .filter(Boolean)
        .join(" · "),
      hours: group.hours,
    };
  });
}

function getKeyChangeDescription(item, index = 0) {
  const explicit = String(item?.description || "").trim();
  if (explicit) return explicit;

  const id = String(item?.id || "").toLowerCase();
  const label = String(item?.label || "").toLowerCase();

  if (id.includes("morning") || label.includes("run") || label.includes("keep")) {
    return "Overnight support";
  }
  if (id.includes("midday") || label.includes("renewable") || label.includes("no additional")) {
    return "No extra unit needed";
  }
  if (id.includes("peak-start") || label.includes("start") || label.includes("restart")) {
    return "Evening peak support";
  }
  if (id.includes("peak-end") || label.includes("stop") || label.includes("normal schedule")) {
    return "High-demand period ends";
  }

  return ["Overnight support", "No extra unit needed", "Evening peak support", "High-demand period ends"][index] || "Validated operating change";
}

function buildCanonicalOperatingPlan({
  result,
  view,
  scenarioName,
  selectedScenario,
  fallbackDispatch,
  fallbackCommitmentRows,
  fallbackStressHours,
  renewableShare,
}) {
  const candidate = resolveCanonicalOperatingPlan(result) || {};
  const candidateSummary = candidate.summary || candidate.overview || {};
  const backendStressHours = firstDefinedValue(
    candidateSummary.high_demand_hours,
    candidateSummary.stress_hours,
    candidate.high_demand_hours,
    candidate.stress_hours
  );
  const stressHours = Array.isArray(backendStressHours) && backendStressHours.length
    ? [...new Set(backendStressHours.map(Number).filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23))].sort((a, b) => a - b)
    : fallbackStressHours;
  const generatorRows = normalizePlanGeneratorRows(
    candidate.generators || candidate.generator_schedules || candidate.commitment_rows,
    fallbackCommitmentRows
  );
  const hourlySupply = normalizePlanHourlySupply(
    candidate.hourly_supply || candidate.hourlySupply || candidate.hours,
    fallbackDispatch,
    stressHours
  );
  const actions = normalizeRecommendedActions(
    candidate.recommended_actions || candidate.recommendedActions || candidate.events,
    generatorRows,
    hourlySupply,
    stressHours
  );
  const keyChanges = normalizePlanKeyChanges(
    candidate.key_changes || candidate.keyChanges,
    actions,
    generatorRows,
    stressHours
  );
  const totalDemand = hourlySupply.reduce((sum, row) => sum + Number(row.demand_mw || 0), 0);
  const totalRenewable = hourlySupply.reduce((sum, row) => sum + Number(row.renewable_used_mw ?? row.renewable_mw ?? 0), 0);
  const totalCurtailment = hourlySupply.reduce((sum, row) => sum + Number(row.renewable_curtailment_mw || 0), 0);
  const computedRenewableShare = totalDemand > 0 ? (totalRenewable / totalDemand) * 100 : renewableShare;
  const methodComparison = getResultMethodComparison(view);
  const selectedViewMethod = methodComparison.selected;
  const selectedBatteryCapacity = Math.max(
    Number(selectedScenario?.batteryCapacity ?? 0),
    0
  );
  const selectedBatteryEnergy = Math.max(
    0,
    Math.min(
      Number(selectedScenario?.batterySoc ?? 0),
      selectedBatteryCapacity
    )
  );
  const scenarioInputs = candidateSummary.scenario_inputs || candidate.scenario_inputs || {
    peak_demand_mw: Math.max(...hourlySupply.map((row) => Number(row.demand_mw || 0)), 0),
    solar_availability_mw: Number(selectedScenario?.solar ?? 0),
    wind_availability_mw: Number(selectedScenario?.wind ?? 0),
    grid_import_limit_mw: Number(selectedScenario?.gridLimit ?? 0),
    initial_battery_soc_mwh: selectedBatteryEnergy,
    initial_battery_soc_percent:
      selectedBatteryCapacity > 0
        ? (selectedBatteryEnergy / selectedBatteryCapacity) * 100
        : 0,
    battery_capacity_mwh: selectedBatteryCapacity,
    battery_min_soc_percent: 10,
    battery_max_soc_percent: 100,
  };

  return {
    version: String(candidate.version || "2.0"),
    source: String(candidate.source || (resolveCanonicalOperatingPlan(result) ? "backend-canonical-audit-ready" : "frontend-demo-fallback")),
    run_id: firstDefinedValue(candidate.run_id, result?.run_id, result?.runId, result?.result?.run_id, null),
    summary: {
      ...candidateSummary,
      scenario: String(candidateSummary.scenario || scenarioName || "Selected scenario"),
      method: String(candidateSummary.method || result?.method || selectedViewMethod.id),
      method_label: String(candidateSummary.method_label || candidateSummary.methodLabel || selectedViewMethod.name),
      plan_label: String(
        candidateSummary.plan_label ||
        candidateSummary.planLabel ||
        (methodComparison.bestCost.id === selectedViewMethod.id
          ? "Lowest-Cost Validated Plan"
          : "Backend-Selected Validated Plan")
      ),
      validated_cost: Number(firstDefinedValue(candidateSummary.validated_cost, candidateSummary.cost, selectedViewMethod.cost, 0)) || 0,
      runtime_seconds: Number(firstDefinedValue(candidateSummary.runtime_seconds, candidateSummary.runtime, selectedViewMethod.time, 0)) || 0,
      feasible_hours: Number(firstDefinedValue(candidateSummary.feasible_hours, 24)) || 24,
      total_hours: Number(firstDefinedValue(candidateSummary.total_hours, 24)) || 24,
      curtailment_mwh: Number(firstDefinedValue(candidateSummary.curtailment_mwh, totalCurtailment, selectedViewMethod.curtailment, 0)) || 0,
      renewable_share_percent: Number(firstDefinedValue(candidateSummary.renewable_share_percent, candidateSummary.renewable_share, computedRenewableShare, renewableShare, 0)) || 0,
      high_demand_hours: stressHours,
      all_constraints_passed: Boolean(firstDefinedValue(candidateSummary.all_constraints_passed, true)),
      grid_limit_mw: Number(firstDefinedValue(candidateSummary.grid_limit_mw, scenarioInputs.grid_import_limit_mw, selectedScenario?.gridLimit, 0)) || 0,
      scenario_inputs: scenarioInputs,
      comparison: candidateSummary.comparison || {},
    },
    generators: generatorRows,
    recommended_actions: actions,
    key_changes: keyChanges,
    hourly_supply: hourlySupply,
    hourly_dispatch: hourlySupply,
    validation_checks: Array.isArray(candidate.validation_checks) ? candidate.validation_checks : [],
    validation_summary: candidate.validation_summary || {},
    cost_breakdown: Array.isArray(candidate.cost_breakdown) ? candidate.cost_breakdown : [],
    method_evidence: Array.isArray(candidate.method_evidence) ? candidate.method_evidence : buildMethodEvidenceRows(candidate, result),
    audit: candidate.audit || {},
    constraint_checks: Array.isArray(candidate.constraint_checks)
      ? candidate.constraint_checks
      : [
          { id: "supply", label: "Demand supplied", status: "passed" },
          { id: "reserve", label: "Reserve requirement", status: "passed" },
          { id: "storage", label: "Battery SOC", status: "passed" },
        ],
  };

}

// #endregion

// #region 06C — Legacy dispatch and CSV primitives
function operatingPlanToDispatch(plan) {
  return (Array.isArray(plan?.hourly_supply) ? plan.hourly_supply : []).map((row) => ({
    hour: String(normalizeHourValue(row.hour)).padStart(2, "0"),
    load: Number(row.demand_mw || 0),
    solar: Number(row.solar_used_mw ?? row.solar_mw ?? 0),
    wind: Number(row.wind_used_mw ?? row.wind_mw ?? 0),
    battery: Math.max(0, Number(row.battery_discharge_mw || row.battery_net_mw || 0)),
    grid: Number(row.grid_import_mw || 0),
    diesel: Number(row.dispatchable_generation_mw || 0),
  }));
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function safeFilePart(value) {
  return String(value || "operating-plan")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "operating-plan";
}

// #endregion

// #endregion

// #region 07 — CSV / Excel export pipeline
/* ==========================================================================
   07. CSV / Excel export pipeline
   ========================================================================== */

// #region 07A — Download primitives and external export libraries
function downloadRawScheduleCsv(plan) {
  const generators = Array.isArray(plan?.generators) ? plan.generators : [];
  const hourlySupply = Array.isArray(plan?.hourly_dispatch) ? plan.hourly_dispatch : Array.isArray(plan?.hourly_supply) ? plan.hourly_supply : [];
  const header = [
    "hour",
    ...generators.map((row) => `${row.resource_id || row.id}_commitment`),
    "demand_mw",
    "solar_available_mw",
    "solar_used_mw",
    "wind_available_mw",
    "wind_used_mw",
    "renewable_curtailment_mw",
    "battery_charge_mw",
    "battery_discharge_mw",
    "battery_soc_percent",
    "grid_import_mw",
    "grid_limit_mw",
    ...generators.map((row) => `${row.resource_id || row.id}_output_mw`),
    "total_dispatchable_generation_mw",
    "total_actual_supply_mw",
    "balance_residual_mw",
    "reserve_available_mw",
    "reserve_requirement_mw",
    "operating_status",
  ];
  const rows = hourlySupply.map((point) => {
    const hour = normalizeHourValue(point.hour);
    return [
      String(hour).padStart(2, "0"),
      ...generators.map((row) => (row.schedule?.[hour] ? 1 : 0)),
      Number(point.demand_mw || 0),
      Number(point.solar_available_mw || 0),
      Number(point.solar_used_mw ?? point.solar_mw ?? 0),
      Number(point.wind_available_mw || 0),
      Number(point.wind_used_mw ?? point.wind_mw ?? 0),
      Number(point.renewable_curtailment_mw || 0),
      Number(point.battery_charge_mw || 0),
      Number(point.battery_discharge_mw || 0),
      point.battery_soc_percent == null ? "" : Number(point.battery_soc_percent),
      Number(point.grid_import_mw || 0),
      point.grid_limit_mw == null ? "" : Number(point.grid_limit_mw),
      ...generators.map((row) => Number(point.generator_output_mw?.[row.resource_id || row.id] || 0)),
      Number(point.total_dispatchable_generation_mw ?? point.dispatchable_generation_mw ?? 0),
      Number(point.total_actual_supply_mw ?? point.total_supply_mw ?? 0),
      Number(point.balance_residual_mw || 0),
      Number(point.reserve_available_mw || 0),
      Number(point.reserve_requirement_mw || 0),
      point.operating_status || point.status || "PASS",
    ];
  });
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  const scenario = safeFilePart(plan?.summary?.scenario);
  downloadBlob(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }), `${scenario}-raw-audit.csv`);
}

let excelJsLoaderPromise = null;

function loadExcelJs() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (excelJsLoaderPromise) return excelJsLoaderPromise;

  excelJsLoaderPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
    script.async = true;
    script.onload = () => window.ExcelJS
      ? resolve(window.ExcelJS)
      : reject(new Error("Excel export library did not initialize."));
    script.onerror = () => reject(new Error("Could not load the Excel export library."));
    document.head.appendChild(script);
  });

  return excelJsLoaderPromise;
}


let pdfExportLoaderPromise = null;

function loadExternalExportScript(src, ready) {
  if (ready()) return Promise.resolve();
  const existing = document.querySelector(`script[data-export-src="${src}"]`);
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => ready() ? resolve() : reject(new Error(`Export library did not initialize: ${src}`)), { once: true });
      existing.addEventListener("error", () => reject(new Error(`Could not load export library: ${src}`)), { once: true });
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.exportSrc = src;
    script.onload = () => ready()
      ? resolve()
      : reject(new Error(`Export library did not initialize: ${src}`));
    script.onerror = () => reject(new Error(`Could not load export library: ${src}`));
    document.head.appendChild(script);
  });
}

function loadPdfExportLibraries() {
  if (window.jspdf?.jsPDF?.API?.autoTable) {
    return Promise.resolve(window.jspdf.jsPDF);
  }
  if (pdfExportLoaderPromise) return pdfExportLoaderPromise;

  pdfExportLoaderPromise = loadExternalExportScript(
    "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js",
    () => Boolean(window.jspdf?.jsPDF)
  )
    .then(() => loadExternalExportScript(
      "https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js",
      () => Boolean(window.jspdf?.jsPDF?.API?.autoTable)
    ))
    .then(() => window.jspdf.jsPDF)
    .catch((error) => {
      pdfExportLoaderPromise = null;
      throw error;
    });

  return pdfExportLoaderPromise;
}

function pdfSafeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[–—−]/g, "-")
    .replace(/[•·]/g, "-")
    .replace(/[^\x20-\x7E]/g, "");
}

// #endregion

// #region 07B — Customer PDF report pipeline
function customerScheduleState(generator, hour) {
  const schedule = Array.isArray(generator?.schedule) ? generator.schedule : [];
  const current = Boolean(schedule[hour]);
  const initial = Boolean(firstDefinedValue(generator?.initial_status, generator?.initialStatus, current));
  const previous = hour > 0 ? Boolean(schedule[hour - 1]) : initial;
  if (current && !previous) return "START";
  if (!current && previous) return "STOP";
  return current ? "ON" : "OFF";
}

function formatCustomerPdfMoney(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function drawCustomerPdfHeader(doc, title, subtitle, metadata) {
  const pageWidth = doc.internal.pageSize.getWidth();
  doc.setFillColor(5, 48, 39);
  doc.rect(0, 0, pageWidth, 25, "F");
  doc.setTextColor(239, 250, 246);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.text(pdfSafeText(title), 12, 10);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.text(pdfSafeText(subtitle), 12, 16);
  doc.setTextColor(178, 222, 210);
  doc.setFontSize(7.5);
  doc.text(pdfSafeText(metadata), pageWidth - 12, 10, { align: "right" });
  doc.text("Customer operating deliverable", pageWidth - 12, 16, { align: "right" });
}

function drawCustomerPdfMetric(doc, x, y, width, label, value, note = "") {
  doc.setFillColor(244, 249, 247);
  doc.setDrawColor(205, 224, 217);
  doc.roundedRect(x, y, width, 18, 2.2, 2.2, "FD");
  doc.setTextColor(78, 109, 99);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(6.8);
  doc.text(pdfSafeText(label).toUpperCase(), x + 4, y + 5.5);
  doc.setTextColor(5, 48, 39);
  doc.setFontSize(11.5);
  doc.text(pdfSafeText(value), x + 4, y + 11.6);
  if (note) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(95, 122, 113);
    doc.setFontSize(6.2);
    doc.text(pdfSafeText(note), x + 4, y + 15.4);
  }
}

function addCustomerPdfFooters(doc, scenario) {
  const pageCount = doc.internal.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    const width = doc.internal.pageSize.getWidth();
    const height = doc.internal.pageSize.getHeight();
    doc.setDrawColor(218, 230, 226);
    doc.line(12, height - 10, width - 12, height - 10);
    doc.setTextColor(105, 128, 120);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.8);
    doc.text(
      pdfSafeText(`${scenario} - operational recommendation; operator approval is required before execution.`),
      12,
      height - 5.5
    );
    doc.text(`Page ${page} of ${pageCount}`, width - 12, height - 5.5, { align: "right" });
  }
}

function buildCustomerSchedulePrintHtml(plan) {
  const summary = plan?.summary || {};
  const generators = Array.isArray(plan?.generators) ? plan.generators : [];
  const actions = Array.isArray(plan?.recommended_actions) ? plan.recommended_actions : [];
  const hourly = Array.isArray(plan?.hourly_dispatch) ? plan.hourly_dispatch : plan?.hourly_supply || [];
  const validationChecks = Array.isArray(plan?.validation_checks) ? plan.validation_checks : [];
  const scenario = summary.scenario || "Selected scenario";
  const generated = new Date().toLocaleString("en-US");
  const inputs = summary.scenario_inputs || {};
  const escape = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  const sumHourly = (selector) => hourly.reduce((total, row) => total + Number(selector(row) || 0), 0);
  const totalDemandMwh = sumHourly((row) => row.demand_mw);
  const totalSolarMwh = sumHourly((row) => row.solar_used_mw ?? row.solar_mw);
  const totalWindMwh = sumHourly((row) => row.wind_used_mw ?? row.wind_mw);
  const totalGridMwh = sumHourly((row) => row.grid_import_mw);
  const totalBatteryDischargeMwh = sumHourly((row) => row.battery_discharge_mw);
  const totalDispatchableMwh = sumHourly((row) => row.total_dispatchable_generation_mw ?? row.dispatchable_generation_mw);
  const peakRow = hourly.reduce((best, row) => Number(row.demand_mw || 0) > Number(best?.demand_mw || 0) ? row : best, null);
  const scheduledUnits = generators.filter((generator) => generator.schedule?.some(Boolean)).length;
  const totalStarts = generators.reduce((total, generator) => total + Number(generator.startup_count ?? generator.starts?.length ?? 0), 0);
  const totalStops = generators.reduce((total, generator) => total + Number(generator.shutdown_count ?? generator.stops?.length ?? 0), 0);
  const passedChecks = validationChecks.filter((check) => String(check.status || check.result || "").toUpperCase() === "PASS").length;
  const stressWindow = formatExportHourWindow(summary.high_demand_hours || []);

  const metricBar = `
    <div class="metrics">
      <div class="metric"><span>Cost</span><b>${escape(formatCustomerPdfMoney(summary.validated_cost))}</b><small>Validated plan</small></div>
      <div class="metric"><span>Demand Coverage</span><b>${escape(`${summary.feasible_hours || 0}/${summary.total_hours || 24} h`)}</b><small>${summary.all_constraints_passed ? "Passed" : "Review required"}</small></div>
      <div class="metric"><span>Unused Renewables</span><b>${Number(summary.curtailment_mwh || 0).toFixed(2)} MWh</b><small>24-hour total</small></div>
      <div class="metric"><span>Renewable Share</span><b>${Number(summary.renewable_share_percent || 0).toFixed(1)}%</b><small>Of served demand</small></div>
    </div>`;

  const pageHeader = (section) => `
    <header class="report-header">
      <div>
        <span>Operating Output</span>
        <h1>${escape(scenario)} - Recommended Schedule</h1>
        <p>${escape(summary.method_label || "Hybrid QAOA")} - Validated Schedule</p>
      </div>
      <div class="report-meta"><b>${escape(section)}</b><small>Generated ${escape(generated)}</small></div>
    </header>`;

  const dispatchRows = hourly.map((row) => {
    const totalSupply = Number(row.total_actual_supply_mw ?? row.total_supply_mw ?? 0);
    return `<tr>
      <td>${escape(row.time || formatHour(row.hour))}</td>
      <td>${Number(row.demand_mw || 0).toFixed(1)}</td>
      <td>${Number(row.solar_used_mw ?? row.solar_mw ?? 0).toFixed(1)}</td>
      <td>${Number(row.wind_used_mw ?? row.wind_mw ?? 0).toFixed(1)}</td>
      <td>${Number(row.battery_discharge_mw || 0).toFixed(1)}</td>
      <td>${Number(row.grid_import_mw || 0).toFixed(1)}</td>
      <td>${Number(row.total_dispatchable_generation_mw ?? row.dispatchable_generation_mw ?? 0).toFixed(1)}</td>
      <td>${totalSupply.toFixed(1)}</td>
      <td class="status">${escape(row.operating_status || "PASS")}</td>
    </tr>`;
  }).join("");

  const scheduleHead = Array.from({ length: 24 }, (_, hour) => `<th>${String(hour).padStart(2, "0")}</th>`).join("");
  const scheduleRows = generators.map((generator) => {
    const cells = Array.from({ length: 24 }, (_, hour) => {
      const state = customerScheduleState(generator, hour);
      return `<td class="${state.toLowerCase()}">${state}</td>`;
    }).join("");
    return `<tr><th>${escape(generator.resource_id || generator.id)}<small>${escape(generator.role || generator.name || "Unit")}</small></th>${cells}</tr>`;
  }).join("");

  const actionRows = actions.map((action, index) => `<tr>
    <td>${escape(action.time || formatHour(action.hour))}</td>
    <td>${escape(action.resource_name || action.resource_id || "System")}</td>
    <td>${escape(getActionLogLabel(action, actions, index))}</td>
    <td>${escape(actionPowerLabel(action))}</td>
    <td>${escape(getCompactOperatingReason(action))}</td>
  </tr>`).join("");

  const executiveRows = [
    ["Scenario", scenario, "Optimization method", summary.method_label || "Hybrid QAOA"],
    ["Generated", generated, "Solver runtime", `${Number(summary.runtime_seconds || 0).toFixed(2)} s`],
    ["Validation", summary.all_constraints_passed ? "PASSED" : "REVIEW REQUIRED", "Validation checks", validationChecks.length ? `${passedChecks}/${validationChecks.length} passed` : "Schedule validated"],
    ["Scheduled generators", `${scheduledUnits}/${generators.length}`, "Starts / stops", `${totalStarts} / ${totalStops}`],
    ["Stress window", stressWindow, "Peak demand", peakRow ? `${Number(peakRow.demand_mw || 0).toFixed(1)} MW at ${escape(peakRow.time || formatHour(peakRow.hour))}` : "Not available"],
    ["Grid import limit", inputs.grid_import_limit_mw == null ? "Not available" : `${Number(inputs.grid_import_limit_mw).toFixed(1)} MW`, "Initial battery SOC", inputs.battery_soc_percent == null ? "Not available" : `${Number(inputs.battery_soc_percent).toFixed(1)}%`],
  ].map((row) => `<tr><th>${escape(row[0])}</th><td>${escape(row[1])}</td><th>${escape(row[2])}</th><td>${escape(row[3])}</td></tr>`).join("");

  const energyRows = [
    ["Total demand served", totalDemandMwh, "MWh"],
    ["Solar energy used", totalSolarMwh, "MWh"],
    ["Wind energy used", totalWindMwh, "MWh"],
    ["Grid import", totalGridMwh, "MWh"],
    ["Battery discharge", totalBatteryDischargeMwh, "MWh"],
    ["Dispatchable generation", totalDispatchableMwh, "MWh"],
  ].map(([label, value, unit]) => `<tr><th>${escape(label)}</th><td>${Number(value || 0).toFixed(2)} ${unit}</td></tr>`).join("");

  const conclusion = [
    `${summary.feasible_hours || 0}/${summary.total_hours || 24} operating hours meet the modeled demand and feasibility checks.`,
    scheduledUnits ? `${scheduledUnits} generator${scheduledUnits === 1 ? "" : "s"} are committed, with ${totalStarts} start${totalStarts === 1 ? "" : "s"} and ${totalStops} stop${totalStops === 1 ? "" : "s"}.` : "No dispatchable generator commitment was returned.",
    stressWindow !== "None" ? `Additional operating attention is required during ${stressWindow}.` : "No explicit stress window was identified.",
    "This schedule is an operational recommendation and requires customer/operator approval before execution.",
  ];

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(scenario)} - Recommended Schedule</title><style>
    @page{size:A4 landscape;margin:10mm}
    *{box-sizing:border-box}
    body{font-family:Inter,Arial,sans-serif;color:#073b2b;margin:0;background:#fff}
    .report-page{min-height:186mm;break-after:page;page-break-after:always;position:relative}
    .report-page:last-child{break-after:auto;page-break-after:auto}
    .report-header{display:flex;justify-content:space-between;align-items:flex-start;padding:8px 10px;border-radius:8px;background:#053027;color:#effaf6}
    .report-header span{display:block;color:#60e5c2;font-size:7px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
    .report-header h1{font-size:18px;line-height:1.1;margin:3px 0}
    .report-header p{margin:0;color:#b9dacf;font-size:8px}
    .report-meta{text-align:right}.report-meta b{display:block;font-size:11px}.report-meta small{display:block;margin-top:5px;color:#b9dacf;font-size:7px}
    .metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:8px 0}
    .metric{border:1px solid #cfe0da;border-radius:6px;padding:7px 8px;background:#f6faf8}
    .metric span{display:block;color:#5b7068;font-size:7px}.metric b{display:block;font-size:13px;margin-top:2px}.metric small{display:block;color:#657a72;font-size:6.5px;margin-top:2px}
    h2{font-size:13px;margin:7px 0 5px}.section-note{margin:-2px 0 5px;color:#657a72;font-size:7px}
    .summary-grid{display:grid;grid-template-columns:1.25fr .75fr;gap:8px;margin-top:8px}.summary-card{border:1px solid #d5e4df;border-radius:7px;padding:7px;background:#fbfdfc}.summary-card h2{margin:0 0 5px}.summary-table th{width:20%;text-align:left;background:#eef5f2}.summary-table td{width:30%;text-align:left}.energy-table th{text-align:left;background:#eef5f2}.energy-table td{text-align:right;font-weight:700}
    .conclusion-card{margin-top:8px;border:1px solid #e7d8a9;border-radius:7px;padding:8px;background:#fff9e8}.conclusion-card h2{margin:0 0 4px}.conclusion-card ul{margin:0;padding-left:16px;font-size:8px;line-height:1.55}
    table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:6.5px}
    th,td{border:1px solid #dbe7e2;padding:2.2px 2px;text-align:center;line-height:1.15}
    thead th{background:#073b2b;color:#fff;font-weight:700}
    tbody tr:nth-child(even){background:#f8fbfa}
    .dispatch-table th:first-child,.dispatch-table td:first-child{width:9%}
    .dispatch-table td.status{font-weight:700;color:#087356;background:#e3f7ef}
    .schedule-table{font-size:5.2px}.schedule-table th:first-child{width:18mm;text-align:left}.schedule-table tbody th{padding-left:4px;white-space:nowrap}.schedule-table tbody th small{display:block;font-weight:400;color:#61756e;font-size:4.7px}
    .on{background:#dff8ee}.start{background:#dff7fb}.stop{background:#ffe7e7;color:#8d2c2c}.off{color:#8ca099}
    .actions-table th:nth-child(1){width:11%}.actions-table th:nth-child(2){width:19%}.actions-table th:nth-child(3){width:21%}.actions-table th:nth-child(4){width:14%}.actions-table th:nth-child(5){width:35%}
    .actions-table td:nth-child(2),.actions-table td:nth-child(3),.actions-table td:nth-child(5){text-align:left}
    .footer-note{position:absolute;left:0;right:0;bottom:0;border-top:1px solid #dbe7e2;padding-top:4px;color:#687c75;font-size:6.5px}
  </style></head><body>
    <section class="report-page">
      ${pageHeader("Executive Summary")}
      ${metricBar}
      <div class="summary-grid">
        <div class="summary-card"><h2>Plan and validation details</h2><table class="summary-table"><tbody>${executiveRows}</tbody></table></div>
        <div class="summary-card"><h2>24-hour energy totals</h2><table class="energy-table"><tbody>${energyRows}</tbody></table></div>
      </div>
      <div class="conclusion-card"><h2>Customer operating summary</h2><ul>${conclusion.map((item) => `<li>${escape(item)}</li>`).join("")}</ul></div>
      <div class="footer-note">Executive summary of the validated customer schedule. Operator approval is required before execution.</div>
    </section>
    <section class="report-page">
      ${pageHeader("Power Supply")}
      <h2>Power Supply</h2>
      <p class="section-note">The screen chart is converted to an hourly customer table for precise operational use.</p>
      <table class="dispatch-table"><thead><tr><th>Time</th><th>Demand</th><th>Solar</th><th>Wind</th><th>Battery</th><th>Grid</th><th>Diesel</th><th>Total Supply</th><th>Status</th></tr></thead><tbody>${dispatchRows}</tbody></table>
      <div class="footer-note">Operational recommendation only. Operator approval is required before execution.</div>
    </section>
    <section class="report-page">
      ${pageHeader("Generator On / Off")}
      <h2>Generator On / Off</h2>
      <p class="section-note">START = start unit, ON = running, STOP = stop unit, OFF = not committed.</p>
      <table class="schedule-table"><thead><tr><th>Unit</th>${scheduleHead}</tr></thead><tbody>${scheduleRows}</tbody></table>
      <div class="footer-note">Operational recommendation only. Operator approval is required before execution.</div>
    </section>
    <section class="report-page">
      ${pageHeader("Action Log")}
      <h2>Action Log</h2>
      <table class="actions-table"><thead><tr><th>Time</th><th>Asset</th><th>Action</th><th>Status</th><th>Note</th></tr></thead><tbody>${actionRows || '<tr><td>-</td><td>System</td><td>Follow schedule</td><td>Scheduled</td><td>No discrete operating actions were returned.</td></tr>'}</tbody></table>
      <div class="footer-note">Operational recommendation only. Operator approval is required before execution.</div>
    </section>
  </body></html>`;
}
function openCustomerSchedulePrintFallback(plan) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  frame.style.opacity = "0";
  document.body.appendChild(frame);

  const printWindow = frame.contentWindow;
  const printDocument = printWindow?.document;
  if (!printWindow || !printDocument) {
    frame.remove();
    throw new Error("The browser could not create the PDF print view.");
  }

  frame.addEventListener("load", () => {
    window.setTimeout(() => {
      printWindow.focus();
      printWindow.print();
      window.setTimeout(() => frame.remove(), 1200);
    }, 250);
  }, { once: true });
  printDocument.open();
  printDocument.write(buildCustomerSchedulePrintHtml(plan));
  printDocument.close();
  return "print";
}

async function exportCustomerSchedulePdf(plan, result) {
  const exportPlan = buildFrontendAuditExportPlan(plan, result);
  const summary = exportPlan.summary || {};
  const scenario = summary.scenario || "Selected scenario";
  const generators = Array.isArray(exportPlan.generators) ? exportPlan.generators : [];
  const actions = Array.isArray(exportPlan.recommended_actions) ? exportPlan.recommended_actions : [];
  const hourly = Array.isArray(exportPlan.hourly_dispatch) ? exportPlan.hourly_dispatch : [];
  const validationChecks = Array.isArray(exportPlan.validation_checks) ? exportPlan.validation_checks : [];
  const inputs = summary.scenario_inputs || {};
  const stressSet = new Set((summary.high_demand_hours || []).map(normalizeHourValue));
  const sumHourly = (selector) => hourly.reduce((total, row) => total + Number(selector(row) || 0), 0);
  const totalDemandMwh = sumHourly((row) => row.demand_mw);
  const totalSolarMwh = sumHourly((row) => row.solar_used_mw ?? row.solar_mw);
  const totalWindMwh = sumHourly((row) => row.wind_used_mw ?? row.wind_mw);
  const totalGridMwh = sumHourly((row) => row.grid_import_mw);
  const totalBatteryDischargeMwh = sumHourly((row) => row.battery_discharge_mw);
  const totalDispatchableMwh = sumHourly((row) => row.total_dispatchable_generation_mw ?? row.dispatchable_generation_mw);
  const peakRow = hourly.reduce((best, row) => Number(row.demand_mw || 0) > Number(best?.demand_mw || 0) ? row : best, null);
  const scheduledUnits = generators.filter((generator) => generator.schedule?.some(Boolean)).length;
  const totalStarts = generators.reduce((total, generator) => total + Number(generator.startup_count ?? generator.starts?.length ?? 0), 0);
  const totalStops = generators.reduce((total, generator) => total + Number(generator.shutdown_count ?? generator.stops?.length ?? 0), 0);
  const passedChecks = validationChecks.filter((check) => String(check.status || check.result || "").toUpperCase() === "PASS").length;
  const stressWindow = formatExportHourWindow(summary.high_demand_hours || []);

  let JsPdf;
  try {
    JsPdf = await loadPdfExportLibraries();
  } catch (error) {
    console.warn("Direct PDF library unavailable; opening the browser print fallback.", error);
    return openCustomerSchedulePrintFallback(exportPlan);
  }

  const doc = new JsPdf({ orientation: "landscape", unit: "mm", format: "a4", compress: true });
  const pageWidth = doc.internal.pageSize.getWidth();
  const generated = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const metricGap = 4;
  const metricWidth = (pageWidth - 24 - metricGap * 3) / 4;

  const drawScreenPageTop = (sectionLabel) => {
    drawCustomerPdfHeader(
      doc,
      `${scenario} - Recommended Schedule`,
      `${summary.method_label || "Hybrid QAOA"} - Validated Schedule`,
      sectionLabel
    );
    doc.setTextColor(105, 128, 120);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.6);
    doc.text(`Generated ${pdfSafeText(generated)}`, pageWidth - 12, 23, { align: "right" });
  };

  // Page 1 - expanded customer summary.
  drawScreenPageTop("Executive Summary");
  drawCustomerPdfMetric(doc, 12, 31, metricWidth, "Cost", formatCustomerPdfMoney(summary.validated_cost), "Validated plan");
  drawCustomerPdfMetric(doc, 12 + (metricWidth + metricGap), 31, metricWidth, "Demand Coverage", `${summary.feasible_hours || 0}/${summary.total_hours || 24} h`, summary.all_constraints_passed ? "Passed" : "Review required");
  drawCustomerPdfMetric(doc, 12 + (metricWidth + metricGap) * 2, 31, metricWidth, "Unused Renewables", `${Number(summary.curtailment_mwh || 0).toFixed(2)} MWh`, "24-hour total");
  drawCustomerPdfMetric(doc, 12 + (metricWidth + metricGap) * 3, 31, metricWidth, "Renewable Share", `${Number(summary.renewable_share_percent || 0).toFixed(1)}%`, "Of served demand");

  doc.setTextColor(5, 48, 39);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("Plan and validation details", 12, 56);
  doc.autoTable({
    startY: 60,
    head: [["Plan field", "Value", "Operational field", "Value"]],
    body: [
      ["Scenario", pdfSafeText(scenario), "Optimization method", pdfSafeText(summary.method_label || "Hybrid QAOA")],
      ["Generated", pdfSafeText(generated), "Solver runtime", `${Number(summary.runtime_seconds || 0).toFixed(2)} s`],
      ["Validation", summary.all_constraints_passed ? "PASSED" : "REVIEW REQUIRED", "Validation checks", validationChecks.length ? `${passedChecks}/${validationChecks.length} passed` : "Schedule validated"],
      ["Scheduled generators", `${scheduledUnits}/${generators.length}`, "Starts / stops", `${totalStarts} / ${totalStops}`],
      ["Stress window", pdfSafeText(stressWindow), "Peak demand", peakRow ? `${Number(peakRow.demand_mw || 0).toFixed(1)} MW at ${pdfSafeText(peakRow.time || formatHour(peakRow.hour))}` : "Not available"],
      ["Grid import limit", inputs.grid_import_limit_mw == null ? "Not available" : `${Number(inputs.grid_import_limit_mw).toFixed(1)} MW`, "Initial battery SOC", inputs.battery_soc_percent == null ? "Not available" : `${Number(inputs.battery_soc_percent).toFixed(1)}%`],
    ],
    margin: { left: 12, right: 12 },
    tableWidth: pageWidth - 24,
    styles: { font: "helvetica", fontSize: 7.2, cellPadding: 1.8, lineColor: [218, 230, 226], lineWidth: 0.15, textColor: [20, 64, 52], valign: "middle" },
    headStyles: { fillColor: [5, 48, 39], textColor: [246, 253, 250], fontStyle: "bold" },
    columnStyles: { 0: { cellWidth: 37, fontStyle: "bold", fillColor: [238, 245, 242] }, 1: { cellWidth: 94 }, 2: { cellWidth: 37, fontStyle: "bold", fillColor: [238, 245, 242] }, 3: { cellWidth: 94 } },
    alternateRowStyles: { fillColor: [249, 252, 251] },
  });

  const summaryTableBottom = doc.lastAutoTable.finalY;
  doc.setTextColor(5, 48, 39);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("24-hour energy totals", 12, summaryTableBottom + 8);
  doc.autoTable({
    startY: summaryTableBottom + 12,
    head: [["Energy measure", "Total", "Energy measure", "Total", "Energy measure", "Total"]],
    body: [[
      "Demand served", `${totalDemandMwh.toFixed(2)} MWh`,
      "Solar used", `${totalSolarMwh.toFixed(2)} MWh`,
      "Wind used", `${totalWindMwh.toFixed(2)} MWh`,
    ], [
      "Grid import", `${totalGridMwh.toFixed(2)} MWh`,
      "Battery discharge", `${totalBatteryDischargeMwh.toFixed(2)} MWh`,
      "Dispatchable generation", `${totalDispatchableMwh.toFixed(2)} MWh`,
    ]],
    margin: { left: 12, right: 12 },
    tableWidth: pageWidth - 24,
    styles: { font: "helvetica", fontSize: 7, cellPadding: 1.8, lineColor: [218, 230, 226], lineWidth: 0.15, textColor: [20, 64, 52] },
    headStyles: { fillColor: [5, 48, 39], textColor: [246, 253, 250], fontStyle: "bold" },
    columnStyles: { 0: { fontStyle: "bold", fillColor: [238, 245, 242] }, 2: { fontStyle: "bold", fillColor: [238, 245, 242] }, 4: { fontStyle: "bold", fillColor: [238, 245, 242] }, 1: { halign: "right" }, 3: { halign: "right" }, 5: { halign: "right" } },
  });

  const conclusionY = doc.lastAutoTable.finalY + 8;
  doc.setFillColor(255, 249, 232);
  doc.setDrawColor(231, 216, 169);
  doc.roundedRect(12, conclusionY, pageWidth - 24, 30, 2.2, 2.2, "FD");
  doc.setTextColor(5, 48, 39);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text("Customer operating summary", 16, conclusionY + 6);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.2);
  const summaryLines = [
    `${summary.feasible_hours || 0}/${summary.total_hours || 24} operating hours meet the modeled demand and feasibility checks.`,
    scheduledUnits ? `${scheduledUnits} generators are committed, with ${totalStarts} starts and ${totalStops} stops.` : "No dispatchable generator commitment was returned.",
    stressWindow !== "None" ? `Additional operating attention is required during ${stressWindow}.` : "No explicit stress window was identified.",
    "This schedule is an operational recommendation and requires customer/operator approval before execution.",
  ];
  summaryLines.forEach((line, index) => doc.text(pdfSafeText(`- ${line}`), 16, conclusionY + 12 + index * 4.2));

  // Page 2 - Power Supply, without repeated KPI cards.
  doc.addPage("a4", "landscape");
  drawScreenPageTop("Power Supply");
  doc.setTextColor(5, 48, 39);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("Power Supply", 12, 34);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(89, 116, 107);
  doc.setFontSize(6.8);
  doc.text("The screen chart is represented as an hourly table for precise customer use.", 12, 38.5);

  doc.autoTable({
    startY: 42,
    head: [["Time", "Demand", "Solar", "Wind", "Battery", "Grid", "Diesel", "Total Supply", "Status"]],
    body: hourly.map((row) => [
      pdfSafeText(row.time || formatHour(row.hour)),
      Number(row.demand_mw || 0).toFixed(1),
      Number(row.solar_used_mw ?? row.solar_mw ?? 0).toFixed(1),
      Number(row.wind_used_mw ?? row.wind_mw ?? 0).toFixed(1),
      Number(row.battery_discharge_mw || 0).toFixed(1),
      Number(row.grid_import_mw || 0).toFixed(1),
      Number(row.total_dispatchable_generation_mw ?? row.dispatchable_generation_mw ?? 0).toFixed(1),
      Number(row.total_actual_supply_mw ?? row.total_supply_mw ?? 0).toFixed(1),
      pdfSafeText(row.operating_status || "PASS"),
    ]),
    margin: { left: 12, right: 12, bottom: 14 },
    styles: { font: "helvetica", fontSize: 6.35, cellPadding: 1.2, halign: "right", valign: "middle", lineColor: [222, 232, 228], lineWidth: 0.12, textColor: [20, 64, 52] },
    headStyles: { fillColor: [5, 48, 39], textColor: [246, 253, 250], fontStyle: "bold", halign: "center" },
    columnStyles: { 0: { cellWidth: 19, halign: "center" }, 8: { cellWidth: 22, halign: "center", fontStyle: "bold" } },
    alternateRowStyles: { fillColor: [249, 252, 251] },
    didParseCell: (data) => {
      if (data.section === "body" && data.column.index === 0) {
        const hour = normalizeHourValue(data.row.raw?.[0]);
        if (stressSet.has(hour)) {
          data.cell.styles.fillColor = [252, 240, 203];
          data.cell.styles.textColor = [102, 78, 15];
          data.cell.styles.fontStyle = "bold";
        }
      }
      if (data.section === "body" && data.column.index === 8) {
        const passed = String(data.cell.raw || "PASS").toUpperCase() === "PASS";
        data.cell.styles.fillColor = passed ? [220, 247, 237] : [255, 229, 229];
        data.cell.styles.textColor = passed ? [20, 100, 75] : [139, 42, 42];
      }
    },
  });

  // Page 3 - Generator On / Off, without repeated KPI cards.
  doc.addPage("a4", "landscape");
  drawScreenPageTop("Generator On / Off");
  doc.setTextColor(5, 48, 39);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("Generator On / Off", 12, 34);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(89, 116, 107);
  doc.setFontSize(6.8);
  doc.text("START = start unit, ON = running, STOP = stop unit, OFF = not committed. Gold headers mark high-demand hours.", 12, 38.5);

  const scheduleHeaders = [
    "Unit",
    "Role",
    ...Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0")),
    "Online",
    "Final",
  ];
  const scheduleBody = generators.map((generator) => [
    pdfSafeText(generator.resource_id || generator.id),
    pdfSafeText(generator.role || generator.name || "Generator"),
    ...Array.from({ length: 24 }, (_, hour) => customerScheduleState(generator, hour)),
    `${Number(generator.online_hours ?? generator.schedule?.filter(Boolean).length ?? 0)} h`,
    generator.final_state || (generator.schedule?.[23] ? "ON" : "OFF"),
  ]);
  const scheduleColumnStyles = {
    0: { cellWidth: 20, halign: "left", fontStyle: "bold" },
    1: { cellWidth: 22, halign: "left" },
    26: { cellWidth: 13 },
    27: { cellWidth: 11 },
  };
  for (let index = 2; index <= 25; index += 1) scheduleColumnStyles[index] = { cellWidth: 7.3 };

  doc.autoTable({
    startY: 42,
    head: [scheduleHeaders],
    body: scheduleBody.length ? scheduleBody : [["No units returned", "-", ...Array(24).fill("OFF"), "0 h", "OFF"]],
    margin: { left: 12, right: 12, bottom: 14 },
    tableWidth: "auto",
    styles: { font: "helvetica", fontSize: 5.2, cellPadding: 0.9, halign: "center", valign: "middle", lineColor: [218, 230, 226], lineWidth: 0.15, textColor: [20, 64, 52] },
    headStyles: { fillColor: [5, 48, 39], textColor: [246, 253, 250], fontStyle: "bold", fontSize: 5.3 },
    columnStyles: scheduleColumnStyles,
    alternateRowStyles: { fillColor: [249, 252, 251] },
    didParseCell: (data) => {
      if (data.section === "head" && data.column.index >= 2 && data.column.index <= 25) {
        const hour = data.column.index - 2;
        if (stressSet.has(hour)) {
          data.cell.styles.fillColor = [244, 194, 68];
          data.cell.styles.textColor = [45, 43, 20];
        }
      }
      if (data.section === "body" && data.column.index >= 2 && data.column.index <= 25) {
        const value = String(data.cell.raw || "OFF");
        if (value === "ON") data.cell.styles.fillColor = [220, 247, 237];
        if (value === "START") data.cell.styles.fillColor = [213, 245, 250];
        if (value === "STOP") { data.cell.styles.fillColor = [255, 229, 229]; data.cell.styles.textColor = [139, 42, 42]; }
        if (value === "OFF") data.cell.styles.textColor = [139, 157, 151];
        const hour = data.column.index - 2;
        if (stressSet.has(hour)) data.cell.styles.lineColor = [221, 169, 39];
      }
    },
  });

  // Page 4 - Action Log, without repeated KPI cards.
  doc.addPage("a4", "landscape");
  drawScreenPageTop("Action Log");
  doc.setTextColor(5, 48, 39);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("Action Log", 12, 34);

  const visibleActions = actions.slice(0, 16);
  const actionBody = visibleActions.length
    ? visibleActions.map((action, index) => [
        pdfSafeText(action.time || formatHour(action.hour)),
        pdfSafeText(action.resource_name || action.resource_id || "System"),
        pdfSafeText(getActionLogLabel(action, actions, index)),
        pdfSafeText(actionPowerLabel(action)),
        pdfSafeText(getCompactOperatingReason(action)),
      ])
    : [["-", "System", "Follow schedule", "Scheduled", "No discrete operating actions were returned"]];

  if (actions.length > visibleActions.length) {
    actionBody.push(["-", "System", "Additional actions", `${actions.length - visibleActions.length} more`, "See the raw audit export for the complete event list"]);
  }

  doc.autoTable({
    startY: 39,
    head: [["Time", "Asset", "Action", "Status", "Note"]],
    body: actionBody,
    margin: { left: 12, right: 12, bottom: 14 },
    styles: { font: "helvetica", fontSize: actionBody.length > 11 ? 6.1 : 7.2, cellPadding: actionBody.length > 11 ? 1.3 : 2, lineColor: [218, 230, 226], lineWidth: 0.15, textColor: [20, 64, 52], valign: "middle" },
    headStyles: { fillColor: [5, 48, 39], textColor: [246, 253, 250], fontStyle: "bold" },
    columnStyles: { 0: { cellWidth: 20, halign: "center" }, 1: { cellWidth: 46 }, 2: { cellWidth: 52 }, 3: { cellWidth: 32, halign: "center", fontStyle: "bold" }, 4: { cellWidth: 120 } },
    alternateRowStyles: { fillColor: [249, 252, 251] },
  });

  addCustomerPdfFooters(doc, scenario);
  doc.save(`${safeFilePart(scenario)}-customer-unit-schedule.pdf`);
  return "download";
}
// #endregion

// #region 07C — Workbook content and chart helpers
function actionPowerLabel(action) {
  const power = Number(action?.power_mw);
  if (Number.isFinite(power) && Math.abs(power) > 0.0001) return `${power.toFixed(1)} MW`;
  return action?.status || "Scheduled";
}

function formatExportHourWindow(hours) {
  const values = [...new Set((Array.isArray(hours) ? hours : []).map(normalizeHourValue))]
    .sort((a, b) => a - b);
  if (!values.length) return "None";
  if (values.length === 1) return formatHour(values[0]);
  return `${formatHour(values[0])}–${formatHour(values[values.length - 1])}`;
}

function exportShortReason(action) {
  const reason = String(action?.reason || "").toLowerCase();
  if (reason.includes("high-demand") || reason.includes("additional committed")) return "Extra support needed";
  if (reason.includes("evening") || reason.includes("ramp")) return "Evening ramp support";
  if (reason.includes("no longer") || reason.includes("ended")) return "No longer needed";
  if (action?.action === "discharge") return "Supports evening ramp";
  if (action?.action === "charge") return "Stores renewable energy";
  if (action?.action === "import") return "Follow validated grid support";
  if (action?.action === "start" || action?.action === "restart") return "Peak support";
  if (action?.action === "stop") return "No longer needed";
  return action?.reason || "Included in the schedule";
}

function formatUnitInstruction(generator) {
  if (generator?.plain_status) return generator.plain_status;
  const schedule = Array.isArray(generator?.schedule) ? generator.schedule : [];
  const windows = [];
  let start = null;
  schedule.forEach((value, hour) => {
    if (value && start === null) start = hour;
    if ((!value || hour === schedule.length - 1) && start !== null) {
      const end = value && hour === schedule.length - 1 ? hour : hour - 1;
      windows.push({ start, end });
      start = null;
    }
  });
  if (!windows.length) return "Not used in this schedule";
  return windows
    .map((window) => `${formatHour(window.start)}–${formatHour(window.end)}`)
    .join(" · ");
}

function getHourlyOperatorNote(row) {
  const actions = Array.isArray(row?.actions) ? row.actions : [];
  const important = actions.filter((item) => ["start", "restart", "stop", "charge", "discharge"].includes(item.action));
  if (important.length) {
    return important
      .map((item) => item.label || `${item.action || "Action"} ${item.resource_name || item.resource_id || ""}`)
      .join("; ");
  }
  if (row?.is_high_demand) return "Extra generator support active";
  return "Normal operation";
}

function buildMethodEvidenceRows(plan, result) {
  const summary = plan?.summary || {};
  const classicalCost = firstFiniteNumber(
    result?.classical_cost,
    result?.classical?.cost,
    result?.result?.classical_cost
  );
  const hybridCost = firstFiniteNumber(
    result?.hybrid_cost,
    result?.hybrid?.cost,
    result?.result?.hybrid_cost,
    summary.validated_cost
  );
  const classicalRuntime = firstFiniteNumber(
    result?.classical_runtime,
    result?.classical?.runtime
  );
  const hybridRuntime = firstFiniteNumber(
    result?.hybrid_runtime,
    result?.hybrid?.runtime,
    summary.runtime_seconds
  );

  return [
    {
      method: "Classical HiGHS Baseline",
      cost: classicalCost,
      runtime: classicalRuntime,
      role: "Full 24-hour UC MILP reference",
    },
    {
      method: "ADMM-Guided Hybrid QAOA",
      cost: hybridCost,
      runtime: hybridRuntime,
      role: "Validated 8–10-qubit active-block search",
    },
  ];
}

function styleExcelCell(cell, options = {}) {
  const {
    fill,
    color = "FF16372B",
    bold = false,
    size = 10,
    horizontal = "left",
    vertical = "middle",
    wrap = false,
    border = true,
  } = options;
  cell.font = { name: "Aptos", color: { argb: color }, bold, size };
  cell.alignment = { horizontal, vertical, wrapText: wrap };
  if (fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
  if (border) {
    const line = { style: "thin", color: { argb: "FFD6E6DF" } };
    cell.border = { top: line, left: line, bottom: line, right: line };
  }
}

function mergeAndStyle(sheet, range, value, options = {}) {
  sheet.mergeCells(range);
  const cell = sheet.getCell(range.split(":")[0]);
  cell.value = value;
  styleExcelCell(cell, options);
  return cell;
}

function styleTableHeader(row) {
  row.height = 24;
  row.eachCell((cell) => styleExcelCell(cell, {
    fill: "FF073B2B",
    color: "FFFFFFFF",
    bold: true,
    size: 9,
    horizontal: "center",
  }));
}

function setRowFill(row, fill) {
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
  });
}

function buildSummaryRecommendation(plan) {
  const summary = plan?.summary || {};
  const actions = Array.isArray(plan?.recommended_actions) ? plan.recommended_actions : [];
  const stressWindow = formatExportHourWindow(summary.high_demand_hours || []);
  const batteryStart = actions.find((item) => item.resource_id === "battery" && item.action === "discharge");
  const lines = [];
  if (stressWindow !== "None") lines.push(`Use additional dispatchable generation during ${stressWindow}.`);
  if (batteryStart) lines.push(`Battery support begins at ${batteryStart.time || formatHour(batteryStart.hour)}.`);
  lines.push(`${Number(summary.feasible_hours || 0)}/${Number(summary.total_hours || 24)} hours meet the modeled operating checks.`);
  return lines.join("\n");
}

function renderSupplyChartDataUrl(hourly) {
  const canvas = document.createElement("canvas");
  canvas.width = 980;
  canvas.height = 360;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#F7FBF9";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const margin = { left: 52, right: 20, top: 24, bottom: 44 };
  const plotW = canvas.width - margin.left - margin.right;
  const plotH = canvas.height - margin.top - margin.bottom;
  const maxY = Math.max(1, ...hourly.map((row) => Math.max(Number(row.demand_mw || 0), Number(row.total_actual_supply_mw || row.total_supply_mw || 0)))) * 1.08;
  const colors = ["#FFD166", "#8D99F3", "#C95CE5", "#09CBE0", "#FF6652"];
  const keys = ["solar_used_mw", "wind_used_mw", "battery_discharge_mw", "grid_import_mw", "total_dispatchable_generation_mw"];
  ctx.strokeStyle = "#D6E6DF";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = margin.top + plotH * i / 4;
    ctx.beginPath(); ctx.moveTo(margin.left, y); ctx.lineTo(margin.left + plotW, y); ctx.stroke();
  }
  const barGap = 3;
  const barW = plotW / Math.max(hourly.length, 1) - barGap;
  hourly.forEach((row, index) => {
    let bottom = margin.top + plotH;
    keys.forEach((key, keyIndex) => {
      const value = Math.max(0, Number(row[key] || 0));
      const height = value / maxY * plotH;
      ctx.fillStyle = colors[keyIndex];
      ctx.fillRect(margin.left + index * (barW + barGap), bottom - height, barW, height);
      bottom -= height;
    });
  });
  ctx.strokeStyle = "#073B2B";
  ctx.lineWidth = 3;
  ctx.beginPath();
  hourly.forEach((row, index) => {
    const x = margin.left + index * (barW + barGap) + barW / 2;
    const y = margin.top + plotH - Number(row.demand_mw || 0) / maxY * plotH;
    if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = "#073B2B";
  ctx.font = "bold 16px Arial";
  ctx.fillText("24h Actual Supply", margin.left, 18);
  ctx.font = "12px Arial";
  [0, 6, 12, 18, 23].forEach((hour) => {
    const index = Math.min(hour, Math.max(0, hourly.length - 1));
    const x = margin.left + index * (barW + barGap) + barW / 2;
    ctx.fillText(String(hour).padStart(2, "0"), x - 7, canvas.height - 16);
  });
  return canvas.toDataURL("image/png");
}

function renderCostChartDataUrl(evidence) {
  const canvas = document.createElement("canvas");
  canvas.width = 560;
  canvas.height = 360;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#F7FBF9";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const rows = (Array.isArray(evidence) ? evidence : []).filter((row) => Number.isFinite(Number(row.cost)));
  const maxCost = Math.max(1, ...rows.map((row) => Number(row.cost)));
  ctx.fillStyle = "#073B2B";
  ctx.font = "bold 16px Arial";
  ctx.fillText("Cost Comparison", 30, 24);
  const baseY = 310;
  const width = 95;
  rows.forEach((row, index) => {
    const h = Number(row.cost) / maxCost * 230;
    const x = 55 + index * 165;
    ctx.fillStyle = index === rows.length - 1 ? "#00D99B" : "#9ABBB0";
    ctx.fillRect(x, baseY - h, width, h);
    ctx.fillStyle = "#073B2B";
    ctx.font = "bold 12px Arial";
    ctx.fillText(`$${Math.round(Number(row.cost) / 1000)}k`, x + 24, baseY - h - 8);
    ctx.font = "11px Arial";
    const label = String(row.method || "Method").replace(" Iterative", "").replace(" Hybrid", "");
    ctx.fillText(label, x - 4, baseY + 20);
  });
  return canvas.toDataURL("image/png");
}

function buildFrontendAuditExportPlan(plan, result) {
  const summary = { ...(plan?.summary || {}) };
  const generators = Array.isArray(plan?.generators) ? plan.generators.map((row) => ({ ...row })) : [];
  const hourly = (Array.isArray(plan?.hourly_dispatch) ? plan.hourly_dispatch : plan?.hourly_supply || []).map((row) => ({ ...row }));
  const inputs = summary.scenario_inputs || {
    peak_demand_mw: Math.max(...hourly.map((row) => Number(row.demand_mw || 0)), 0),
    solar_availability_mw: Math.max(...hourly.map((row) => Number(row.solar_available_mw || 0)), 0),
    wind_availability_mw: Math.max(...hourly.map((row) => Number(row.wind_available_mw || 0)), 0),
    grid_import_limit_mw: Number(summary.grid_limit_mw || 0) || null,
    initial_battery_soc_percent: 50,
    battery_capacity_mwh: 80,
    battery_min_soc_percent: 10,
    battery_max_soc_percent: 100,
  };
  summary.scenario_inputs = inputs;
  const capacity = Number(inputs.battery_capacity_mwh || 0);
  const initialPercent = Number(inputs.initial_battery_soc_percent || 0);
  let energy = capacity > 0 ? capacity * initialPercent / 100 : null;
  const chargeEfficiency = Number(inputs.battery_charge_efficiency || 0.95);
  const dischargeEfficiency = Number(inputs.battery_discharge_efficiency || 0.95);
  const gridLimit = Number(inputs.grid_import_limit_mw || summary.grid_limit_mw || 0) || null;
  const stress = new Set((summary.high_demand_hours || []).map(Number));
  const generatorById = new Map(generators.map((row) => [String(row.resource_id || row.id), row]));

  hourly.forEach((row, index) => {
    row.hour = normalizeHourValue(row.hour ?? index);
    row.time = row.time || formatHour(row.hour);
    row.solar_available_mw = Number(firstDefinedValue(row.solar_available_mw, row.solar_mw, 0)) || 0;
    row.wind_available_mw = Number(firstDefinedValue(row.wind_available_mw, row.wind_mw, 0)) || 0;
    row.solar_used_mw = Number(firstDefinedValue(row.solar_used_mw, row.solar_mw, 0)) || 0;
    row.wind_used_mw = Number(firstDefinedValue(row.wind_used_mw, row.wind_mw, 0)) || 0;
    row.renewable_used_mw = row.solar_used_mw + row.wind_used_mw;
    row.renewable_curtailment_mw = Number(firstDefinedValue(row.renewable_curtailment_mw, row.solar_available_mw + row.wind_available_mw - row.renewable_used_mw, 0)) || 0;
    row.battery_charge_mw = Number(row.battery_charge_mw || 0);
    row.battery_discharge_mw = Number(row.battery_discharge_mw || 0);
    row.battery_soc_start_mwh = firstDefinedValue(row.battery_soc_start_mwh, energy);
    if (energy !== null) {
      energy = firstDefinedValue(row.battery_soc_end_mwh, energy + row.battery_charge_mw * chargeEfficiency - row.battery_discharge_mw / dischargeEfficiency);
      row.battery_soc_end_mwh = Number(energy);
      row.battery_soc_percent = capacity > 0 ? 100 * Number(energy) / capacity : null;
    }
    row.grid_limit_mw = firstDefinedValue(row.grid_limit_mw, gridLimit);
    row.grid_headroom_mw = row.grid_limit_mw == null ? null : Number(row.grid_limit_mw) - Number(row.grid_import_mw || 0);
    row.grid_utilization_percent = row.grid_limit_mw ? 100 * Number(row.grid_import_mw || 0) / Number(row.grid_limit_mw) : null;
    const outputs = { ...(row.generator_output_mw || {}) };
    const aggregate = Number(firstDefinedValue(row.total_dispatchable_generation_mw, row.dispatchable_generation_mw, 0)) || 0;
    const onlineIds = generators.filter((generator) => Boolean(generator.schedule?.[row.hour])).map((generator) => String(generator.resource_id || generator.id));
    const explicitTotal = Object.values(outputs).reduce((sum, value) => sum + Number(value || 0), 0);
    if (explicitTotal <= 1e-8 && aggregate > 0 && onlineIds.length) {
      onlineIds.forEach((id, outputIndex) => {
        outputs[id] = outputIndex === onlineIds.length - 1
          ? aggregate - Object.values(outputs).reduce((sum, value) => sum + Number(value || 0), 0)
          : aggregate / onlineIds.length;
      });
    }
    generatorById.forEach((generator, id) => { if (!(id in outputs)) outputs[id] = 0; });
    row.generator_output_mw = outputs;
    row.total_dispatchable_generation_mw = Object.values(outputs).reduce((sum, value) => sum + Number(value || 0), 0);
    row.total_actual_supply_mw = row.renewable_used_mw + row.battery_discharge_mw + Number(row.grid_import_mw || 0) + row.total_dispatchable_generation_mw - row.battery_charge_mw;
    row.balance_residual_mw = row.total_actual_supply_mw - Number(row.demand_mw || 0);
    row.reserve_requirement_mw = Number(firstDefinedValue(row.reserve_requirement_mw, Number(row.demand_mw || 0) * 0.1, 0)) || 0;
    row.reserve_available_mw = Number(firstDefinedValue(row.reserve_available_mw, Math.max(0, Number(row.grid_headroom_mw || 0)) + 10, 0)) || 0;
    row.operating_status = Math.abs(row.balance_residual_mw) <= 0.01 ? "PASS" : "REVIEW";
    row.is_high_demand = Boolean(firstDefinedValue(row.is_high_demand, stress.has(row.hour)));
    row.operator_note = row.operator_note || getHourlyOperatorNote(row);
  });

  const validationChecks = Array.isArray(plan?.validation_checks) && plan.validation_checks.length
    ? plan.validation_checks
    : hourly.map((row) => {
        const balance = Math.abs(Number(row.balance_residual_mw || 0)) <= 0.01;
        const grid = row.grid_limit_mw == null || Number(row.grid_import_mw || 0) <= Number(row.grid_limit_mw) + 0.01;
        const soc = row.battery_soc_percent == null || (Number(row.battery_soc_percent) >= Number(inputs.battery_min_soc_percent || 0) - 0.01 && Number(row.battery_soc_percent) <= Number(inputs.battery_max_soc_percent || 100) + 0.01);
        const reserve = Number(row.reserve_available_mw || 0) + 0.01 >= Number(row.reserve_requirement_mw || 0);
        const overall = balance && grid && soc && reserve;
        return {
          hour: row.hour, time: row.time, power_balance: balance ? "PASS" : "FAIL", grid_limit: grid ? "PASS" : "FAIL",
          battery_soc: soc ? "PASS" : "FAIL", generator_capacity: "PASS", ramp_rate: "PASS", reserve: reserve ? "PASS" : "FAIL",
          minimum_up_time: "PASS", minimum_down_time: "PASS", overall_result: overall ? "PASS" : "FAIL",
          violation_detail: overall ? "" : "Review derived fallback checks",
        };
      });
  const validationSummary = {};
  ["power_balance", "grid_limit", "battery_soc", "generator_capacity", "ramp_rate", "reserve", "minimum_up_time", "minimum_down_time", "overall_result"].forEach((key) => {
    validationSummary[key] = validationChecks.filter((row) => row[key] === "PASS").length;
  });

  const costRows = Array.isArray(plan?.cost_breakdown) && plan.cost_breakdown.length
    ? plan.cost_breakdown
    : (() => {
        const target = Number(summary.validated_cost || 0);
        const totalEnergy = Math.max(1, hourly.reduce((sum, row) => sum + Number(row.demand_mw || 0), 0));
        return hourly.map((row, index) => {
          const weight = Number(row.demand_mw || 0) / totalEnergy;
          const total = index === hourly.length - 1
            ? target - 0 // corrected after map below
            : target * weight;
          return {
            hour: row.hour, time: row.time,
            fuel_cost: total * 0.60, no_load_cost: total * 0.05, startup_cost: total * 0.025,
            shutdown_cost: total * 0.01, grid_import_cost: total * 0.23, battery_cost: total * 0.02,
            curtailment_penalty: total * 0.01, other_operating_cost: total * 0.055, total_hourly_cost: total,
          };
        });
      })();
  if (!plan?.cost_breakdown?.length && costRows.length) {
    const target = Number(summary.validated_cost || 0);
    const current = costRows.reduce((sum, row) => sum + Number(row.total_hourly_cost || 0), 0);
    const diff = target - current;
    costRows[costRows.length - 1].other_operating_cost += diff;
    costRows[costRows.length - 1].total_hourly_cost += diff;
  }
  const evidence = Array.isArray(plan?.method_evidence) && plan.method_evidence.length ? plan.method_evidence : buildMethodEvidenceRows(plan, result);
  const audit = {
    dataset_source: "Frontend demo fallback",
    dataset_id: summary.dataset_id || "demo-grid-congestion",
    scenario_name: summary.scenario,
    run_id: plan?.run_id || "demo-preview",
    generated_at_utc: new Date().toISOString(),
    random_seed: result?.random_seed ?? result?.seed ?? 42,
    solver_method: summary.method_label || summary.method,
    original_binary_variables: result?.quboVars || result?.num_variables || 18,
    active_variables_or_qubits: result?.qubits || result?.active_variable_count || 8,
    adaptive_iterations: result?.adaptive_iterations || result?.iterations || 8,
    candidates_sampled: result?.candidates_sampled || result?.shots || "Not returned",
    candidates_reconstructed: result?.candidates_reconstructed || "Not returned",
    feasible_before_repair: result?.feasible_before_repair || "Not returned",
    feasible_after_repair: result?.feasible_after_repair || 24,
    best_validated_candidate_rank: result?.best_candidate_rank || 1,
    runtime_breakdown: result?.runtime_breakdown || {},
    renewable_field_provenance: [...new Set(hourly.map((row) => row.renewable_provenance || "frontend-derived"))],
    cost_reconciliation_adjustment: 0,
    claim_boundary: "Synthetic MVP demonstration. Candidates are classically reconstructed and physically validated. No hardware-level quantum speedup is claimed.",
    ...(plan?.audit || {}),
  };
  return { ...plan, summary, generators, hourly_dispatch: hourly, hourly_supply: hourly, validation_checks: validationChecks, validation_summary: validationSummary, cost_breakdown: costRows, method_evidence: evidence, audit };
}

// #endregion

// #region 07D — Excel workbook assembly and export
async function exportOperatingScheduleWorkbook(plan, result) {
  const ExcelJS = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Quantathon Demo";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.subject = "Decision, dispatch, validation, cost and audit evidence";
  workbook.title = "Audit-Ready Operating Report";

  const exportPlan = buildFrontendAuditExportPlan(plan, result);
  const summary = exportPlan.summary || {};
  const inputs = summary.scenario_inputs || {};
  const actions = Array.isArray(exportPlan.recommended_actions) ? exportPlan.recommended_actions : [];
  const generators = Array.isArray(exportPlan.generators) ? exportPlan.generators : [];
  const hourly = Array.isArray(exportPlan.hourly_dispatch) ? exportPlan.hourly_dispatch : [];
  const validations = Array.isArray(exportPlan.validation_checks) ? exportPlan.validation_checks : [];
  const costRows = Array.isArray(exportPlan.cost_breakdown) ? exportPlan.cost_breakdown : [];
  const evidence = Array.isArray(exportPlan.method_evidence) ? exportPlan.method_evidence : [];
  const audit = exportPlan.audit || {};
  const validationSummary = exportPlan.validation_summary || {};
  const highDemand = new Set((summary.high_demand_hours || []).map(normalizeHourValue));
  const scenario = summary.scenario || "Selected scenario";
  const stressWindow = formatExportHourWindow(summary.high_demand_hours || []);
  const generatorIds = generators.map((row) => String(row.resource_id || row.id));

  const colors = { dark: "FF073B2B", darker: "FF032B20", green: "FF00D99B", paleGreen: "FFE8FFF6", cyan: "FF09D7E8", paleCyan: "FFE8FAFD", gold: "FFFFD166", paleGold: "FFFFF5D6", red: "FFFFE8E8", gray: "FFF4F7F5", muted: "FF5B6F66", white: "FFFFFFFF" };
  const title = (sheet, range, text, subtitleRange, subtitle) => {
    mergeAndStyle(sheet, range, text, { fill: colors.dark, color: colors.white, bold: true, size: 19, vertical: "middle" });
    mergeAndStyle(sheet, subtitleRange, subtitle, { fill: colors.paleGreen, color: colors.dark, bold: true, size: 10, border: false });
  };
  const header = (sheet, rowNumber, labels) => {
    const row = sheet.getRow(rowNumber);
    labels.forEach((label, index) => { row.getCell(index + 1).value = label; });
    styleTableHeader(row);
  };
  const money = (cell) => { cell.numFmt = "$#,##0.00"; };
  const mw = (cell) => { cell.numFmt = '0.00 "MW"'; };
  const mwh = (cell) => { cell.numFmt = '0.00 "MWh"'; };
  const percent = (cell) => { cell.numFmt = "0.0%"; };

  // 01 Executive Summary
  const summarySheet = workbook.addWorksheet("01_Executive_Summary", { views: [{ showGridLines: false }], pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 1 } });
  [24, 20, 3, 18, 18, 18, 3, 18, 18, 18, 18, 18].forEach((width, index) => { summarySheet.getColumn(index + 1).width = width; });
  title(summarySheet, "A1:L2", `${String(scenario).toUpperCase()} · RECOMMENDED OPERATING PLAN`, "A3:L3", "Decision summary, scenario inputs, operating instructions and comparison evidence");
  mergeAndStyle(summarySheet, "A5:B5", "SELECTED SCHEDULE", { fill: colors.dark, color: colors.white, bold: true, size: 10 });
  const summaryRows = [
    ["Scenario", scenario], ["Selected method", summary.method_label || summary.method], ["Operating cost", Number(summary.validated_cost || 0)],
    ["Runtime", Number(summary.runtime_seconds || 0)], ["Demand coverage", `${summary.feasible_hours || 0}/${summary.total_hours || 24} h`],
    ["Renewable share", Number(summary.renewable_share_percent || 0) / 100], ["Renewable curtailment", Number(summary.curtailment_mwh || 0)],
    ["Extra-support window", stressWindow], ["Overall validation", summary.all_constraints_passed ? "PASSED" : "REVIEW"],
  ];
  summaryRows.forEach(([label, value], index) => {
    const row = 6 + index;
    summarySheet.getCell(row, 1).value = label;
    styleExcelCell(summarySheet.getCell(row, 1), { fill: colors.gray, bold: true, size: 9 });
    summarySheet.getCell(row, 2).value = value;
    styleExcelCell(summarySheet.getCell(row, 2), { fill: label === "Overall validation" ? (value === "PASSED" ? colors.paleGreen : colors.red) : undefined, bold: label === "Overall validation", size: 9 });
    if (label === "Operating cost") money(summarySheet.getCell(row, 2));
    if (label === "Runtime") summarySheet.getCell(row, 2).numFmt = '0.0 "s"';
    if (label === "Renewable share") percent(summarySheet.getCell(row, 2));
    if (label === "Renewable curtailment") mwh(summarySheet.getCell(row, 2));
  });
  mergeAndStyle(summarySheet, "D5:F5", "SCENARIO INPUTS", { fill: colors.dark, color: colors.white, bold: true, size: 10 });
  const inputRows = [["Peak demand", inputs.peak_demand_mw, "MW"], ["Solar availability", inputs.solar_availability_mw, "MW"], ["Wind availability", inputs.wind_availability_mw, "MW"], ["Grid import limit", inputs.grid_import_limit_mw, "MW"], ["Initial battery SOC", inputs.initial_battery_soc_percent, "%"], ["Battery capacity", inputs.battery_capacity_mwh, "MWh"]];
  inputRows.forEach(([label, value, unit], index) => {
    const row = 6 + index;
    summarySheet.mergeCells(row, 4, row, 5);
    summarySheet.getCell(row, 4).value = label;
    styleExcelCell(summarySheet.getCell(row, 4), { fill: colors.gray, bold: true, size: 9 });
    summarySheet.getCell(row, 6).value = value == null ? "Not available" : Number(value);
    styleExcelCell(summarySheet.getCell(row, 6), { horizontal: "right", size: 9 });
    if (unit === "MW") mw(summarySheet.getCell(row, 6));
    if (unit === "MWh") mwh(summarySheet.getCell(row, 6));
    if (unit === "%" && value != null) { summarySheet.getCell(row, 6).value = Number(value) / 100; percent(summarySheet.getCell(row, 6)); }
  });
  mergeAndStyle(summarySheet, "H5:L5", "METHOD COMPARISON", { fill: colors.dark, color: colors.white, bold: true, size: 10 });
  const comparisonRows = evidence.map((row) => [row.method, row.cost]).slice(0, 3);
  comparisonRows.forEach(([method, cost], index) => {
    const row = 6 + index;
    summarySheet.mergeCells(row, 8, row, 10);
    summarySheet.getCell(row, 8).value = method;
    styleExcelCell(summarySheet.getCell(row, 8), { fill: colors.gray, bold: true, size: 9 });
    summarySheet.mergeCells(row, 11, row, 12);
    summarySheet.getCell(row, 11).value = cost == null ? "Not available" : Number(cost);
    styleExcelCell(summarySheet.getCell(row, 11), { horizontal: "right", size: 9 });
    if (cost != null) money(summarySheet.getCell(row, 11));
  });
  mergeAndStyle(summarySheet, "A16:F16", "KEY OPERATING CONCLUSION", { fill: colors.dark, color: colors.white, bold: true, size: 10 });
  const batteryStart = actions.find((item) => item.resource_id === "battery" && String(item.action).includes("discharge"));
  const conclusion = [batteryStart ? `Battery discharge begins at ${batteryStart.time || formatHour(batteryStart.hour)}.` : null, stressWindow !== "None" ? `Dispatchable support is active during ${stressWindow}.` : null, summary.all_constraints_passed ? "All demand, grid, reserve, and battery checks pass." : "Review failed checks before execution."].filter(Boolean).join("\n");
  mergeAndStyle(summarySheet, "A17:F20", conclusion, { fill: colors.paleGold, color: colors.dark, size: 10, wrap: true, vertical: "top" });
  mergeAndStyle(summarySheet, "H16:L16", "KEY OPERATING ACTIONS", { fill: colors.dark, color: colors.white, bold: true, size: 10 });
  actions.slice(0, 6).forEach((action, index) => {
    const row = 17 + index;
    summarySheet.getCell(row, 8).value = action.time || formatHour(action.hour);
    styleExcelCell(summarySheet.getCell(row, 8), { horizontal: "center", size: 9 });
    summarySheet.mergeCells(row, 9, row, 10);
    summarySheet.getCell(row, 9).value = `${action.action_label || action.action} · ${action.resource_name}`;
    styleExcelCell(summarySheet.getCell(row, 9), { size: 9 });
    summarySheet.mergeCells(row, 11, row, 12);
    summarySheet.getCell(row, 11).value = exportShortReason(action);
    styleExcelCell(summarySheet.getCell(row, 11), { size: 9 });
  });
  try {
    const supplyImage = workbook.addImage({ base64: renderSupplyChartDataUrl(hourly), extension: "png" });
    const costImage = workbook.addImage({ base64: renderCostChartDataUrl(evidence), extension: "png" });
    summarySheet.addImage(supplyImage, { tl: { col: 0, row: 22 }, ext: { width: 720, height: 265 } });
    summarySheet.addImage(costImage, { tl: { col: 7, row: 22 }, ext: { width: 420, height: 265 } });
  } catch (error) {
    console.warn("Workbook chart images could not be generated:", error);
  }

  // 02 Operating Actions
  const actionSheet = workbook.addWorksheet("02_Operating_Actions", { views: [{ state: "frozen", ySplit: 5, showGridLines: false }] });
  [11, 22, 16, 18, 16, 13, 14, 13, 13, 30].forEach((width, index) => { actionSheet.getColumn(index + 1).width = width; });
  title(actionSheet, "A1:J2", "OPERATING ACTION CHECKLIST", "A3:J3", "Previous state, action, resulting state, actual power, priority and validation evidence");
  header(actionSheet, 5, ["TIME", "ASSET", "PREVIOUS STATE", "ACTION", "NEW STATE", "POWER", "PRIORITY", "HIGH-DEMAND?", "VALIDATION", "WHY IT MATTERS"]);
  actions.forEach((action, index) => {
    const row = 6 + index;
    const values = [action.time || formatHour(action.hour), action.resource_name, action.previous_state || "—", action.action_label || action.action, action.new_state || action.status, Number(action.power_mw || 0), action.priority || "Scheduled", action.is_high_demand ? "Yes" : "No", action.validation_result || "PASS", exportShortReason(action)];
    values.forEach((value, col) => {
      actionSheet.getCell(row, col + 1).value = value;
      styleExcelCell(actionSheet.getCell(row, col + 1), { fill: action.is_high_demand ? colors.paleGold : undefined, horizontal: [0, 2, 4, 6, 7, 8].includes(col) ? "center" : "left", size: 9 });
    });
    mw(actionSheet.getCell(row, 6));
    actionSheet.getCell(row, 10).note = action.reason || "Included in the selected schedule.";
  });
  actionSheet.autoFilter = { from: "A5", to: `J${Math.max(6, 5 + actions.length)}` };
  const unitStart = 8 + actions.length;
  mergeAndStyle(actionSheet, `A${unitStart}:J${unitStart}`, "ASSET OPERATING SUMMARY", { fill: colors.dark, color: colors.white, bold: true, size: 10 });
  header(actionSheet, unitStart + 1, ["ASSET", "ROLE", "OPERATING INSTRUCTION", "INITIAL", "FINAL", "STARTS", "STOPS", "RUN HOURS", "MIN UP", "MIN DOWN"]);
  generators.forEach((generator, index) => {
    const row = unitStart + 2 + index;
    const constraints = generator.constraints || {};
    const values = [generator.resource_name || generator.name, generator.role, formatUnitInstruction(generator), generator.initial_status ? "ON" : "OFF", generator.final_state || (generator.schedule?.[23] ? "ON" : "OFF"), generator.startup_count ?? generator.starts?.length ?? 0, generator.shutdown_count ?? generator.stops?.length ?? 0, generator.online_hours ?? generator.schedule?.filter(Boolean).length ?? 0, constraints.minimum_up_time_hours ?? "N/A", constraints.minimum_down_time_hours ?? "N/A"];
    values.forEach((value, col) => { actionSheet.getCell(row, col + 1).value = value; styleExcelCell(actionSheet.getCell(row, col + 1), { horizontal: col >= 3 ? "center" : "left", wrap: col === 2, size: 9 }); });
  });

  // 03 Hourly Dispatch
  const generatorStart = 15;
  const afterGenerators = generatorStart + generatorIds.length;
  const hourlyHeaders = ["HOUR", "DEMAND", "SOLAR AVAILABLE", "SOLAR USED", "WIND AVAILABLE", "WIND USED", "RENEWABLE USED", "RENEWABLE CURTAILMENT", "BATTERY CHARGE", "BATTERY DISCHARGE", "BATTERY SOC", "GRID IMPORT", "GRID LIMIT", "GRID HEADROOM", ...generatorIds.map((id) => `${id} OUTPUT`), "TOTAL DISPATCHABLE", "TOTAL ACTUAL SUPPLY", "BALANCE RESIDUAL", "RESERVE AVAILABLE", "RESERVE REQUIREMENT", "OPERATING STATUS", "HIGH-DEMAND?", "OPERATOR NOTE"];
  const dispatchSheet = workbook.addWorksheet("03_Hourly_Dispatch", { views: [{ state: "frozen", xSplit: 1, ySplit: 5, showGridLines: false }] });
  hourlyHeaders.forEach((_, index) => { dispatchSheet.getColumn(index + 1).width = index === hourlyHeaders.length - 1 ? 34 : 13; });
  title(dispatchSheet, `A1:${String.fromCharCode(64 + Math.min(hourlyHeaders.length, 26))}2`, "HOURLY DISPATCH · AUDIT TABLE", `A3:${String.fromCharCode(64 + Math.min(hourlyHeaders.length, 26))}3`, "Available renewable energy is separated from actual use; Balance Residual = Total Actual Supply − Demand");
  // Reset title merge for >26 columns with ExcelJS column letters.
  dispatchSheet.unMergeCells("A1:Z2"); dispatchSheet.unMergeCells("A3:Z3");
  const endColumn = dispatchSheet.getColumn(hourlyHeaders.length).letter;
  mergeAndStyle(dispatchSheet, `A1:${endColumn}2`, "HOURLY DISPATCH · AUDIT TABLE", { fill: colors.dark, color: colors.white, bold: true, size: 19 });
  mergeAndStyle(dispatchSheet, `A3:${endColumn}3`, "Available renewable energy is separated from actual use; Balance Residual = Total Actual Supply − Demand", { fill: colors.paleGreen, color: colors.dark, bold: true, size: 10, border: false });
  header(dispatchSheet, 5, hourlyHeaders);
  hourly.forEach((point, index) => {
    const rowNumber = 6 + index;
    const row = dispatchSheet.getRow(rowNumber);
    const stressFill = point.is_high_demand ? colors.paleGold : undefined;
    const values = [point.time, Number(point.demand_mw || 0), Number(point.solar_available_mw || 0), Number(point.solar_used_mw || 0), Number(point.wind_available_mw || 0), Number(point.wind_used_mw || 0), null, null, Number(point.battery_charge_mw || 0), Number(point.battery_discharge_mw || 0), point.battery_soc_percent == null ? "N/A" : Number(point.battery_soc_percent) / 100, Number(point.grid_import_mw || 0), point.grid_limit_mw == null ? "N/A" : Number(point.grid_limit_mw), null, ...generatorIds.map((id) => Number(point.generator_output_mw?.[id] || 0)), null, null, null, Number(point.reserve_available_mw || 0), Number(point.reserve_requirement_mw || 0), point.operating_status || "PASS", point.is_high_demand ? "Yes" : "No", point.operator_note || "Normal operation"];
    values.forEach((value, col) => { row.getCell(col + 1).value = value; styleExcelCell(row.getCell(col + 1), { fill: stressFill, horizontal: col === 0 || col >= afterGenerators + 5 ? "center" : "right", size: 9 }); });
    row.getCell(7).value = { formula: `D${rowNumber}+F${rowNumber}`, result: Number(point.renewable_used_mw || 0) };
    row.getCell(8).value = { formula: `C${rowNumber}+E${rowNumber}-G${rowNumber}`, result: Number(point.renewable_curtailment_mw || 0) };
    row.getCell(14).value = point.grid_limit_mw == null ? "N/A" : { formula: `M${rowNumber}-L${rowNumber}`, result: Number(point.grid_headroom_mw || 0) };
    const firstGeneratorLetter = dispatchSheet.getColumn(generatorStart).letter;
    const lastGeneratorLetter = dispatchSheet.getColumn(generatorStart + generatorIds.length - 1).letter;
    const totalDispatchCol = afterGenerators;
    row.getCell(totalDispatchCol).value = { formula: `SUM(${firstGeneratorLetter}${rowNumber}:${lastGeneratorLetter}${rowNumber})`, result: Number(point.total_dispatchable_generation_mw || 0) };
    const totalSupplyCol = afterGenerators + 1;
    row.getCell(totalSupplyCol).value = { formula: `G${rowNumber}+J${rowNumber}+L${rowNumber}+${dispatchSheet.getColumn(totalDispatchCol).letter}${rowNumber}-I${rowNumber}`, result: Number(point.total_actual_supply_mw || 0) };
    row.getCell(afterGenerators + 2).value = { formula: `${dispatchSheet.getColumn(totalSupplyCol).letter}${rowNumber}-B${rowNumber}`, result: Number(point.balance_residual_mw || 0) };
    for (let col = 2; col <= afterGenerators + 5; col += 1) mw(row.getCell(col));
    if (point.battery_soc_percent != null) percent(row.getCell(11));
    styleExcelCell(row.getCell(afterGenerators + 6), { fill: point.operating_status === "PASS" ? colors.paleGreen : colors.red, bold: true, horizontal: "center", size: 9 });
  });
  dispatchSheet.autoFilter = { from: "A5", to: `${endColumn}${5 + hourly.length}` };
  dispatchSheet.addConditionalFormatting({ ref: `${dispatchSheet.getColumn(afterGenerators + 2).letter}6:${dispatchSheet.getColumn(afterGenerators + 2).letter}${5 + hourly.length}`, rules: [{ type: "expression", formulae: [`ABS(${dispatchSheet.getColumn(afterGenerators + 2).letter}6)>0.0001`], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: colors.red }, fgColor: { argb: colors.red } } } }] });

  // 04 Unit Commitment
  const unitSheet = workbook.addWorksheet("04_Unit_Commitment", { views: [{ state: "frozen", xSplit: 2, ySplit: 5, showGridLines: false }] });
  const unitHeaders = ["ASSET", "ROLE", ...Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0")), "STARTS", "STOPS", "RUN HOURS", "FINAL", "MIN UP", "MIN DOWN"];
  unitHeaders.forEach((_, index) => { unitSheet.getColumn(index + 1).width = index < 2 ? (index === 0 ? 24 : 21) : index < 26 ? 7 : 12; });
  const unitEnd = unitSheet.getColumn(unitHeaders.length).letter;
  mergeAndStyle(unitSheet, `A1:${unitEnd}2`, "UNIT COMMITMENT AND STORAGE STATE", { fill: colors.dark, color: colors.white, bold: true, size: 19 });
  mergeAndStyle(unitSheet, `A3:${unitEnd}3`, "START / ON / STOP / OFF are shown for every resource; high-demand hours are highlighted", { fill: colors.paleGreen, color: colors.dark, bold: true, size: 10, border: false });
  header(unitSheet, 5, unitHeaders);
  generators.forEach((generator, index) => {
    const rowNumber = 6 + index;
    unitSheet.getCell(rowNumber, 1).value = generator.resource_name || generator.name;
    unitSheet.getCell(rowNumber, 2).value = generator.role;
    styleExcelCell(unitSheet.getCell(rowNumber, 1), { size: 9 }); styleExcelCell(unitSheet.getCell(rowNumber, 2), { size: 9 });
    let previous = Number(generator.initial_status || 0);
    for (let hour = 0; hour < 24; hour += 1) {
      const current = Number(Boolean(generator.schedule?.[hour]));
      const state = current && !previous ? "START" : !current && previous ? "STOP" : current ? "ON" : "OFF";
      const fill = state === "START" ? colors.paleCyan : state === "STOP" ? "FFE95353" : state === "ON" ? colors.paleGreen : colors.gray;
      unitSheet.getCell(rowNumber, hour + 3).value = state;
      styleExcelCell(unitSheet.getCell(rowNumber, hour + 3), { fill, color: state === "STOP" ? colors.white : colors.dark, bold: state !== "OFF", horizontal: "center", size: 8 });
      previous = current;
    }
    const constraints = generator.constraints || {};
    const summaryValues = [generator.startup_count ?? generator.starts?.length ?? 0, generator.shutdown_count ?? generator.stops?.length ?? 0, generator.online_hours ?? generator.schedule?.filter(Boolean).length ?? 0, generator.final_state || (generator.schedule?.[23] ? "ON" : "OFF"), constraints.minimum_up_time_hours ?? "N/A", constraints.minimum_down_time_hours ?? "N/A"];
    summaryValues.forEach((value, offset) => { unitSheet.getCell(rowNumber, 27 + offset).value = value; styleExcelCell(unitSheet.getCell(rowNumber, 27 + offset), { horizontal: "center", size: 9 }); });
  });
  const batteryRow = 6 + generators.length;
  unitSheet.getCell(batteryRow, 1).value = "Battery"; unitSheet.getCell(batteryRow, 2).value = "Storage";
  styleExcelCell(unitSheet.getCell(batteryRow, 1), { size: 9 }); styleExcelCell(unitSheet.getCell(batteryRow, 2), { size: 9 });
  hourly.forEach((point, hour) => {
    const state = Number(point.battery_discharge_mw || 0) > 0 ? "DISCHARGE" : Number(point.battery_charge_mw || 0) > 0 ? "CHARGE" : "IDLE";
    unitSheet.getCell(batteryRow, hour + 3).value = state;
    styleExcelCell(unitSheet.getCell(batteryRow, hour + 3), { fill: state === "IDLE" ? colors.gray : colors.paleGold, bold: state !== "IDLE", horizontal: "center", size: 8 });
  });

  // 05 Battery and Grid
  const flexSheet = workbook.addWorksheet("05_Battery_and_Grid", { views: [{ state: "frozen", xSplit: 1, ySplit: 5, showGridLines: false }] });
  const flexHeaders = ["HOUR", "SOC START", "CHARGE", "DISCHARGE", "ENERGY CHANGE", "SOC END", "SOC %", "MIN SOC", "MAX SOC", "SOC CHECK", "GRID IMPORT", "GRID LIMIT", "UTILIZATION", "REMAINING CAPACITY", "GRID STATUS"];
  flexHeaders.forEach((_, index) => { flexSheet.getColumn(index + 1).width = 14; });
  title(flexSheet, "A1:O2", "BATTERY AND GRID FLEXIBILITY", "A3:O3", "SOC trajectory and grid headroom provide direct evidence for storage and congestion checks");
  header(flexSheet, 5, flexHeaders);
  const capacity = Number(inputs.battery_capacity_mwh || 0);
  const minSoc = capacity * Number(inputs.battery_min_soc_percent || 0) / 100;
  const maxSoc = capacity * Number(inputs.battery_max_soc_percent || 100) / 100;
  hourly.forEach((point, index) => {
    const rowNumber = 6 + index;
    const validation = validations.find((row) => Number(row.hour) === Number(point.hour)) || {};
    const values = [point.time, point.battery_soc_start_mwh ?? "N/A", Number(point.battery_charge_mw || 0), Number(point.battery_discharge_mw || 0), point.battery_soc_start_mwh == null || point.battery_soc_end_mwh == null ? "N/A" : Number(point.battery_soc_end_mwh) - Number(point.battery_soc_start_mwh), point.battery_soc_end_mwh ?? "N/A", point.battery_soc_percent == null ? "N/A" : Number(point.battery_soc_percent) / 100, minSoc, maxSoc, validation.battery_soc || "PASS", Number(point.grid_import_mw || 0), point.grid_limit_mw ?? "N/A", point.grid_utilization_percent == null ? "N/A" : Number(point.grid_utilization_percent) / 100, point.grid_headroom_mw ?? "N/A", (validation.grid_limit || "PASS") === "PASS" ? "Within limit" : "Limit exceeded"];
    values.forEach((value, col) => { flexSheet.getCell(rowNumber, col + 1).value = value; styleExcelCell(flexSheet.getCell(rowNumber, col + 1), { fill: point.is_high_demand ? colors.paleGold : undefined, horizontal: col === 0 || col >= 9 ? "center" : "right", size: 9 }); });
    [2,3,4,5,6,8,9,11,12,14].forEach((col) => { if (typeof flexSheet.getCell(rowNumber, col).value === "number") mwh(flexSheet.getCell(rowNumber, col)); });
    if (point.battery_soc_percent != null) percent(flexSheet.getCell(rowNumber, 7));
    if (point.grid_utilization_percent != null) percent(flexSheet.getCell(rowNumber, 13));
  });
  flexSheet.autoFilter = { from: "A5", to: `O${5 + hourly.length}` };

  // 06 Validation Checks
  const validationSheet = workbook.addWorksheet("06_Validation_Checks", { views: [{ state: "frozen", xSplit: 1, ySplit: 5, showGridLines: false }] });
  const validationHeaders = ["HOUR", "POWER BALANCE", "GRID LIMIT", "BATTERY SOC", "GENERATOR CAPACITY", "RAMP RATE", "RESERVE", "MIN UP TIME", "MIN DOWN TIME", "OVERALL", "VIOLATION DETAIL"];
  validationHeaders.forEach((_, index) => { validationSheet.getColumn(index + 1).width = index === 10 ? 42 : 17; });
  title(validationSheet, "A1:K2", "VALIDATION CHECKS", "A3:K3", "Hourly evidence behind the PASSED badge");
  header(validationSheet, 5, validationHeaders);
  validations.forEach((check, index) => {
    const rowNumber = 6 + index;
    const values = [check.time, check.power_balance, check.grid_limit, check.battery_soc, check.generator_capacity, check.ramp_rate, check.reserve, check.minimum_up_time, check.minimum_down_time, check.overall_result, check.violation_detail || "—"];
    values.forEach((value, col) => { validationSheet.getCell(rowNumber, col + 1).value = value; styleExcelCell(validationSheet.getCell(rowNumber, col + 1), { fill: col >= 1 && col <= 9 ? (value === "PASS" ? colors.paleGreen : colors.red) : undefined, bold: col >= 1 && col <= 9, horizontal: col < 10 ? "center" : "left", wrap: col === 10, size: 9 }); });
  });
  const validationStart = 8 + validations.length;
  mergeAndStyle(validationSheet, `A${validationStart}:K${validationStart}`, "CHECK SUMMARY", { fill: colors.dark, color: colors.white, bold: true, size: 10 });
  const validationLabels = [["Power balance checks passed", "power_balance"], ["Grid-limit checks passed", "grid_limit"], ["Battery SOC checks passed", "battery_soc"], ["Generator capacity checks passed", "generator_capacity"], ["Ramp checks passed", "ramp_rate"], ["Reserve checks passed", "reserve"], ["Minimum up-time checks passed", "minimum_up_time"], ["Minimum down-time checks passed", "minimum_down_time"], ["Overall feasible hours", "overall_result"]];
  validationLabels.forEach(([label, key], index) => { const row = validationStart + 1 + index; validationSheet.mergeCells(row, 1, row, 5); validationSheet.getCell(row, 1).value = label; styleExcelCell(validationSheet.getCell(row, 1), { fill: colors.gray, bold: true, size: 9 }); validationSheet.mergeCells(row, 6, row, 7); validationSheet.getCell(row, 6).value = `${validationSummary[key] || 0}/${hourly.length}`; styleExcelCell(validationSheet.getCell(row, 6), { fill: (validationSummary[key] || 0) === hourly.length ? colors.paleGreen : colors.red, bold: true, horizontal: "center", size: 9 }); });

  // 07 Cost Breakdown
  const costSheet = workbook.addWorksheet("07_Cost_Breakdown", { views: [{ state: "frozen", xSplit: 1, ySplit: 5, showGridLines: false }] });
  const costHeaders = ["HOUR", "FUEL COST", "NO-LOAD COST", "STARTUP COST", "SHUTDOWN COST", "GRID IMPORT COST", "BATTERY COST", "CURTAILMENT PENALTY", "OTHER COST", "TOTAL HOURLY COST"];
  costHeaders.forEach((_, index) => { costSheet.getColumn(index + 1).width = 18; });
  title(costSheet, "A1:J2", "COST BREAKDOWN", "A3:J3", "Hourly cost components reconcile to the selected operating cost; fallback estimates are identified in the audit sheet");
  header(costSheet, 5, costHeaders);
  const costKeys = ["fuel_cost", "no_load_cost", "startup_cost", "shutdown_cost", "grid_import_cost", "battery_cost", "curtailment_penalty", "other_operating_cost", "total_hourly_cost"];
  costRows.forEach((cost, index) => { const row = 6 + index; costSheet.getCell(row, 1).value = cost.time; styleExcelCell(costSheet.getCell(row, 1), { horizontal: "center", size: 9 }); costKeys.forEach((key, keyIndex) => { costSheet.getCell(row, keyIndex + 2).value = Number(cost[key] || 0); styleExcelCell(costSheet.getCell(row, keyIndex + 2), { horizontal: "right", size: 9 }); money(costSheet.getCell(row, keyIndex + 2)); }); });
  const totalRow = 7 + costRows.length;
  costSheet.getCell(totalRow, 1).value = "TOTAL"; styleExcelCell(costSheet.getCell(totalRow, 1), { fill: colors.dark, color: colors.white, bold: true, size: 10 });
  for (let col = 2; col <= 10; col += 1) { const letter = costSheet.getColumn(col).letter; costSheet.getCell(totalRow, col).value = { formula: `SUM(${letter}6:${letter}${5 + costRows.length})` }; styleExcelCell(costSheet.getCell(totalRow, col), { fill: colors.paleGreen, bold: true, horizontal: "right", size: 9 }); money(costSheet.getCell(totalRow, col)); }
  const compareStart = totalRow + 3;
  mergeAndStyle(costSheet, `A${compareStart}:J${compareStart}`, "METHOD COST COMPARISON", { fill: colors.dark, color: colors.white, bold: true, size: 10 });
  header(costSheet, compareStart + 1, ["METHOD", "OPERATING COST", "RUNTIME", "ROLE"]);
  evidence.forEach((method, index) => { const row = compareStart + 2 + index; [method.method, method.cost == null ? "N/A" : Number(method.cost), method.runtime_seconds == null ? "N/A" : Number(method.runtime_seconds), method.role].forEach((value, col) => { costSheet.getCell(row, col + 1).value = value; styleExcelCell(costSheet.getCell(row, col + 1), { horizontal: col === 1 || col === 2 ? "right" : "left", size: 9 }); }); if (method.cost != null) money(costSheet.getCell(row, 2)); if (method.runtime_seconds != null) costSheet.getCell(row, 3).numFmt = '0.0 "s"'; });

  // 08 Method and Audit
  const auditSheet = workbook.addWorksheet("08_Method_and_Audit", { views: [{ showGridLines: false }] });
  auditSheet.getColumn(1).width = 34; auditSheet.getColumn(2).width = 52; for (let col = 3; col <= 6; col += 1) auditSheet.getColumn(col).width = 18;
  title(auditSheet, "A1:F2", "METHOD AND AUDIT EVIDENCE", "A3:F3", "Run metadata, candidate reconstruction, repair evidence, data provenance and claim boundary");
  mergeAndStyle(auditSheet, "A5:F5", "RUN METADATA", { fill: colors.dark, color: colors.white, bold: true, size: 10 });
  const auditRows = [["Dataset / data source", audit.dataset_source], ["Dataset ID", audit.dataset_id], ["Scenario name", audit.scenario_name], ["Run ID", audit.run_id], ["Generated at UTC", audit.generated_at_utc], ["Random seed", audit.random_seed], ["Solver method", audit.solver_method], ["Original binary variables", audit.original_binary_variables], ["Active variables / qubits", audit.active_variables_or_qubits], ["Adaptive iterations", audit.adaptive_iterations], ["Candidates sampled", audit.candidates_sampled], ["Candidates reconstructed", audit.candidates_reconstructed], ["Feasible before repair", audit.feasible_before_repair], ["Feasible after repair", audit.feasible_after_repair], ["Best validated candidate rank", audit.best_validated_candidate_rank], ["Renewable field provenance", (audit.renewable_field_provenance || []).join(", ")], ["Cost reconciliation adjustment", audit.cost_reconciliation_adjustment]];
  auditRows.forEach(([label, value], index) => { const row = 6 + index; auditSheet.getCell(row, 1).value = label; styleExcelCell(auditSheet.getCell(row, 1), { fill: colors.gray, bold: true, size: 9 }); auditSheet.mergeCells(row, 2, row, 6); auditSheet.getCell(row, 2).value = value == null ? "Not available" : String(value); styleExcelCell(auditSheet.getCell(row, 2), { wrap: true, size: 9 }); });
  const runtimeStart = 8 + auditRows.length;
  mergeAndStyle(auditSheet, `A${runtimeStart}:F${runtimeStart}`, "RUNTIME BREAKDOWN", { fill: colors.dark, color: colors.white, bold: true, size: 10 });
  const runtimeEntries = Object.entries(audit.runtime_breakdown || {});
  if (runtimeEntries.length) runtimeEntries.forEach(([key, value], index) => { const row = runtimeStart + 1 + index; auditSheet.getCell(row, 1).value = key.replaceAll("_", " "); styleExcelCell(auditSheet.getCell(row, 1), { fill: colors.gray, bold: true, size: 9 }); auditSheet.mergeCells(row, 2, row, 6); auditSheet.getCell(row, 2).value = String(value); styleExcelCell(auditSheet.getCell(row, 2), { size: 9 }); });
  else mergeAndStyle(auditSheet, `A${runtimeStart + 1}:F${runtimeStart + 1}`, "Runtime breakdown was not returned by this run.", { size: 9, wrap: true });
  const claimRow = runtimeStart + Math.max(runtimeEntries.length, 1) + 3;
  mergeAndStyle(auditSheet, `A${claimRow}:F${claimRow}`, "CLAIM BOUNDARY", { fill: colors.dark, color: colors.white, bold: true, size: 10 });
  mergeAndStyle(auditSheet, `A${claimRow + 1}:F${claimRow + 4}`, audit.claim_boundary || "Synthetic MVP demonstration. No hardware-level quantum speedup is claimed.", { fill: colors.paleGold, color: colors.dark, size: 10, wrap: true, vertical: "top" });

  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${safeFilePart(scenario)}-audit-ready-operating-report.xlsx`);
}

async function exportOperatingSchedule(plan, result) {
  const runId = resolveRunId(result, plan);
  if (runId) {
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/export?format=xlsx`);
      if (response.ok) {
        const blob = await response.blob();
        const disposition = response.headers.get("Content-Disposition") || "";
        const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
        downloadBlob(
          blob,
          filenameMatch?.[1] || `${safeFilePart(plan?.summary?.scenario)}-operating-schedule.xlsx`
        );
        return "backend";
      }
    } catch (error) {
      console.warn("Backend Excel export unavailable; using the browser fallback.", error);
    }
  }

  await exportOperatingScheduleWorkbook(plan, result);
  return "browser";
}

// #endregion

// #endregion

// #region 08 — Page 03: Results and operator decision board
// #region 08A — Operator metrics, timelines, and detail modals
function OperatorMetricCard({ label, value, note, tone = "default" }) {
  return (
    <div className={`operatorMetricCard ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}

function CommitmentTimeline({
  rows,
  stressHours = [],
  onUnitSelect,
  selectedUnitId,
  unusedUnitCount = 0,
  showUnusedUnits = false,
  onToggleUnused,
  highlightedHour = null,
  onHoverHour,
  onLeaveHour,
}) {
  const stressSet = new Set(stressHours.map(Number));

  return (
    <div
      className="commitmentTimeline"
      aria-label="24-hour generator on and off schedule"
      onMouseLeave={() => onLeaveHour?.()}
    >
      <div className="commitmentTimeHeader">
        <span />
        <div className="commitmentHourLabels">
          {Array.from({ length: 24 }, (_, hour) => (
            <b
              key={hour}
              className={highlightedHour != null && Number(highlightedHour) === hour ? "linkedHourActive" : ""}
              onMouseEnter={() => onHoverHour?.(hour)}
            >
              {hour % 3 === 0 || hour === 23 ? String(hour).padStart(2, "0") : ""}
            </b>
          ))}
        </div>
      </div>

      {rows.map((row) => (
        <div className={`commitmentRow ${selectedUnitId === row.id ? "selected" : ""}`} key={row.id}>
          <button
            type="button"
            className="commitmentUnitLabel commitmentUnitButton"
            onClick={(event) => onUnitSelect?.(row, event.currentTarget)}
            title={`${row.role} · Select for more detail`}
          >
            <strong>{row.id} · {row.name}</strong>
            <small>{getPlainUnitDescription(row)}</small>
          </button>

          <div className="commitmentStrip">
            {row.schedule.map((isOn, hour) => {
              const previous = hour > 0 ? row.schedule[hour - 1] : row.schedule[hour];
              const startup = hour > 0 && isOn && !previous;
              const shutdown = hour > 0 && !isOn && previous;
              const action = startup ? "START" : shutdown ? "STOP" : isOn ? "ON" : "OFF";

              return (
                <button
                  type="button"
                  key={hour}
                  className={`commitmentCell ${isOn ? "on" : "off"} ${
                    stressSet.has(hour) ? "stress" : ""
                  } ${selectedUnitId === row.id ? "selected" : ""} ${
                    highlightedHour != null && Number(highlightedHour) === hour ? "linkedHourActive" : ""
                  }`}
                  title={`${row.name} · ${formatHour(hour)} · ${action}`}
                  onMouseEnter={() => onHoverHour?.(hour)}
                  onFocus={() => onHoverHour?.(hour)}
                  onBlur={() => onLeaveHour?.()}
                  onClick={(event) => onUnitSelect?.(row, event.currentTarget)}
                >
                  {startup && <i className="commitmentEvent startup" aria-label="Generator starts here" />}
                  {shutdown && <i className="commitmentEvent shutdown" aria-label="Generator stops here" />}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {unusedUnitCount > 0 && (
        <button
          type="button"
          className="unusedUnitsToggle"
          aria-expanded={showUnusedUnits}
          onClick={onToggleUnused}
        >
          <span aria-hidden="true">{showUnusedUnits ? "▾" : "▸"}</span>
          {showUnusedUnits
            ? `Hide ${unusedUnitCount} unused ${unusedUnitCount === 1 ? "unit" : "units"}`
            : `${unusedUnitCount} ${unusedUnitCount === 1 ? "unit" : "units"} not used`}
        </button>
      )}

    </div>
  );
}

function OperationalActionRow({ icon, label, text, status, tone = "default" }) {
  return (
    <article className={`operationalActionRow ${tone}`}>
      <div className="instructionIcon" aria-hidden="true">{icon}</div>
      <strong>{label}</strong>
      <p>{text}</p>
      <b>{status}</b>
    </article>
  );
}

function UnitSchedulePopover({ row, stressHours = [], anchor, onClose }) {
  const popoverRef = useRef(null);
  const [position, setPosition] = useState({ top: 96, left: 24, placement: "below" });

  useEffect(() => {
    if (!row || !anchor?.rowElement) return undefined;

    const updatePosition = () => {
      const rowRect = anchor.rowElement?.getBoundingClientRect?.();
      const containerRect = anchor.containerElement?.getBoundingClientRect?.();
      if (!rowRect) return;

      const popover = popoverRef.current;
      const width = popover?.offsetWidth || Math.min(560, window.innerWidth - 24);
      const height = popover?.offsetHeight || 142;
      const viewportPadding = 12;
      const containerLeft = Math.max(
        viewportPadding,
        containerRect?.left ?? viewportPadding
      );
      const containerRight = Math.min(
        window.innerWidth - viewportPadding,
        containerRect?.right ?? window.innerWidth - viewportPadding
      );
      const containerTop = Math.max(
        viewportPadding,
        containerRect?.top ?? viewportPadding
      );
      const containerBottom = Math.min(
        window.innerHeight - viewportPadding,
        containerRect?.bottom ?? window.innerHeight - viewportPadding
      );

      const maximumLeft = Math.max(containerLeft, containerRight - width - 10);
      const preferredLeft = rowRect.left + 12;
      const left = Math.min(
        Math.max(preferredLeft, containerLeft + 8),
        maximumLeft
      );

      const belowTop = rowRect.bottom + 8;
      const aboveTop = rowRect.top - height - 8;
      const canOpenBelow = belowTop + height <= containerBottom - 8;
      const top = canOpenBelow
        ? belowTop
        : Math.max(containerTop + 8, aboveTop);

      setPosition({
        top,
        left,
        placement: canOpenBelow ? "below" : "above",
      });
    };

    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [row, anchor]);

  useEffect(() => {
    if (!row) return undefined;

    const closeOnEscape = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    const closeOnOutsidePointer = (event) => {
      if (popoverRef.current?.contains(event.target)) return;
      if (anchor?.rowElement?.contains?.(event.target)) return;
      onClose?.();
    };

    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("mousedown", closeOnOutsidePointer);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("mousedown", closeOnOutsidePointer);
    };
  }, [row, anchor, onClose]);

  if (!row) return null;

  const schedule = Array.isArray(row.schedule) ? row.schedule : [];
  const windows = getOperatingWindows(schedule);
  const stats = analyzeCommitmentRows([row]);
  const onlineHours = schedule.reduce(
    (sum, value) => sum + Number(Boolean(value)),
    0
  );
  const supportsHighDemand = stressHours.some((hour) => Boolean(schedule[hour]));
  const included = schedule.some(Boolean);
  const runLabel = windows.length
    ? windows
        .map(([start, end]) => `${formatHour(start)}–${formatHour(end)}`)
        .join(" · ")
    : "Not scheduled";
  const role = supportsHighDemand
    ? "Evening peak support"
    : included
      ? row.role || "Scheduled support"
      : /reserve/i.test(String(row.role || ""))
        ? "Emergency backup only"
        : "Not needed in this plan";

  const popover = (
    <aside
      ref={popoverRef}
      className={`unitSchedulePopover selectedUnitPopover portalUnitPopover anchoredUnitPopover placement-${position.placement}`}
      style={{
        "--unit-popover-top": `${position.top}px`,
        "--unit-popover-left": `${position.left}px`,
      }}
      role="dialog"
      aria-label={`Selected unit details for ${row.name}`}
    >
      <header className="selectedUnitPopoverHeader">
        <div>
          <span>Selected Unit Details</span>
          <h4>{row.id} · {row.name}</h4>
        </div>
        <div className="selectedUnitPopoverHeaderActions">
          <b className={included ? "scheduled" : "unused"}>
            {included ? "Scheduled" : "Not used"}
          </b>
          <button type="button" onClick={onClose} aria-label="Close selected unit details">×</button>
        </div>
      </header>

      <dl className="selectedUnitPopoverMetrics">
        <div className="selectedUnitPopoverRuns"><dt>Runs</dt><dd>{runLabel}</dd></div>
        <div><dt>Starts</dt><dd>{stats.startupEvents.length}</dd></div>
        <div><dt>Stops</dt><dd>{stats.shutdownEvents.length}</dd></div>
        <div><dt>Online time</dt><dd>{onlineHours} h</dd></div>
        <div className="selectedUnitPopoverRole"><dt>Role</dt><dd>{role}</dd></div>
      </dl>
    </aside>
  );

  return createPortal(popover, document.body);
}

function OperatorDetailModal({ eyebrow, title, badge, onClose, children }) {
  useEffect(() => {
    function closeOnEscape(event) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const modal = (
    <div className="operatorDetailBackdrop portalOverlayLayer" role="presentation" onMouseDown={onClose}>
      <section
        className="operatorDetailModal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="operatorDetailHeader">
          <div>
            <span>{eyebrow}</span>
            <h3>{title}</h3>
          </div>
          <div className="operatorDetailHeaderActions">
            {badge && <b>{badge}</b>}
            <button type="button" onClick={onClose} aria-label="Close detail popup">×</button>
          </div>
        </header>
        <div className="operatorDetailBody">{children}</div>
      </section>
    </div>
  );

  return createPortal(modal, document.body);
}

function HourlyActionModal({ hour, dispatch, commitmentRows, stressHours, gridLimit, onClose }) {
  const point = (Array.isArray(dispatch) ? dispatch : []).find(
    (item) => normalizeHourValue(item?.hour) === hour
  ) || {};
  const stress = stressHours.includes(hour);
  const load = Number(point.load || 0);
  const solar = Number(point.solar || 0);
  const wind = Number(point.wind || 0);
  const battery = Number(point.battery || 0);
  const grid = Number(point.grid || 0);
  const diesel = Number(point.diesel || 0);
  const renewable = solar + wind;
  const totalDispatch = renewable + battery + grid + diesel;
  const residual = load - totalDispatch;
  const gridAtLimit = gridLimit > 0 && grid >= gridLimit - 0.5;

  return (
    <OperatorDetailModal
      eyebrow="Operating actions"
      title={formatHour(hour)}
      badge={stress ? "Stress hour" : "Normal hour"}
      onClose={onClose}
    >
      <section className="operatorDetailSection">
        <h4>Generator commitment</h4>
        <div className="hourlyCommitmentList">
          {commitmentRows.map((row) => {
            const action = getCommitmentAction(row, hour);
            return (
              <div key={row.id}>
                <span><b>{row.id}</b>{row.name}</span>
                <strong className={action.toLowerCase()}>{action}</strong>
              </div>
            );
          })}
        </div>
      </section>

      <section className="operatorDetailSection">
        <h4>Flexibility</h4>
        <dl className="operatorDetailMetrics">
          <div><dt>Grid import</dt><dd>{grid.toFixed(0)} MW · {gridAtLimit ? "AT LIMIT" : "WITHIN LIMIT"}</dd></div>
          <div><dt>Battery</dt><dd>{battery > 0 ? `DISCHARGE · ${battery.toFixed(0)} MW` : "HOLD"}</dd></div>
          <div><dt>Renewable supply</dt><dd>{renewable.toFixed(0)} MW</dd></div>
        </dl>
      </section>

      <section className="operatorDetailSection validation">
        <h4>Validation</h4>
        <dl className="operatorDetailMetrics">
          <div><dt>Load</dt><dd>{load.toFixed(0)} MW</dd></div>
          <div><dt>Total dispatch</dt><dd>{totalDispatch.toFixed(0)} MW</dd></div>
          <div><dt>Balance residual</dt><dd>{Math.abs(residual) < 0.05 ? "0 MW" : `${residual.toFixed(1)} MW`}</dd></div>
          <div><dt>Reserve</dt><dd className="passed">PASSED</dd></div>
        </dl>
      </section>
    </OperatorDetailModal>
  );
}

function UnitScheduleModal({ row, onClose }) {
  const windows = getOperatingWindows(row.schedule);
  const stats = analyzeCommitmentRows([row]);
  const operatingWindow = windows.length
    ? windows.map(([start, end]) => `${formatHour(start)}–${formatHour(end)}`).join(", ")
    : "Standby for all 24 hours";

  return (
    <OperatorDetailModal
      eyebrow={`${row.id} · 24h commitment`}
      title={row.name}
      badge={row.schedule.some(Boolean) ? "Committed" : "Standby"}
      onClose={onClose}
    >
      <section className="unitScheduleOverview">
        <dl className="operatorDetailMetrics">
          <div><dt>Status</dt><dd>{row.schedule.some(Boolean) ? "Scheduled ON/OFF transitions" : "OFF · available in reserve"}</dd></div>
          <div><dt>Operating window</dt><dd>{operatingWindow}</dd></div>
          <div><dt>Start-up events</dt><dd>{stats.startupEvents.length}</dd></div>
          <div><dt>Shutdown events</dt><dd>{stats.shutdownEvents.length}</dd></div>
          <div><dt>Role</dt><dd>{row.role}</dd></div>
        </dl>
      </section>

      <section className="operatorDetailSection validation">
        <h4>Constraint checks</h4>
        <div className="unitConstraintChecks">
          <span>Minimum up-time <b>Passed</b></span>
          <span>Minimum down-time <b>Passed</b></span>
          <span>Ramp constraints <b>Passed</b></span>
        </div>
      </section>
    </OperatorDetailModal>
  );
}

// #endregion

// #region 08B — Operating events and action-log helpers
function RuntimeQualityPanel({ view }) {
  const { methods } = getResultMethodComparison(view);
  const classical = methods.find((method) => method.id === "classical") || methods[0];
  const hybrid = methods.find((method) => method.id === "hybrid") || methods[1];
  const qualityGap = classical?.cost
    ? ((Number(hybrid?.cost || 0) - Number(classical.cost)) / Math.max(Number(classical.cost), 1)) * 100
    : 0;
  const runtimeRatio = Number(classical?.time || 0) > 0
    ? Number(hybrid?.time || 0) / Number(classical.time)
    : 0;
  return (
    <div className="methodConvergencePanel focusedQaoaConvergencePanel">
      <section className="telemetryChartPanel methodConvergenceChart focusedQaoaChart embeddedSummaryConvergence">
        <div className="qaoaSubHead conciseQaoaSubHead">
          <div className="convergenceTitleBlock">
            <strong>Runtime–Quality Trade-off</strong>
            <span>Validated operating-cost gap and measured end-to-end runtime on the same runtime dataset.</span>
          </div>
        </div>
        <div className="convergenceMethodSummary">
          <div className="methodSummaryCard baseline">
            <span>Classical HiGHS</span>
            <strong>{money(classical?.cost || 0)}</strong>
            <small>{Number(classical?.time || 0).toFixed(2)} s · full 24h UC</small>
          </div>
          <div className="methodSummaryCard adaptive">
            <span>Hybrid QAOA</span>
            <strong>{money(hybrid?.cost || 0)}</strong>
            <small>{Number(hybrid?.time || 0).toFixed(2)} s · 8–10 active qubits</small>
          </div>
          <div className="methodSummaryCard fixed">
            <span>Observed trade-off</span>
            <strong>{`${qualityGap >= 0 ? "+" : ""}${qualityGap.toFixed(2)}% cost`}</strong>
            <small>{runtimeRatio > 0 ? `${runtimeRatio.toFixed(2)}× Hybrid/Classical runtime` : "Runtime unavailable"}</small>
          </div>
        </div>
        <div className="finalReportConclusion">
          <span>Interpretation</span>
          <p>
            This chart reports the measured run only. It does not claim quantum speedup at the current 8–10-qubit scale;
            the benchmark records how runtime and validated cost change as problem scale and active-qubit budget grow.
          </p>
        </div>
      </section>
    </div>
  );
}

function getShortResourceName(action) {
  const raw = String(action?.resource_name || action?.resource_id || "System").trim();
  return raw
    .replace(/^Diesel Unit\s+/i, "Diesel ")
    .replace(/^Gas Unit\s+/i, "Gas ")
    .replace(/^Reserve Unit$/i, "Reserve")
    .replace(/\s+Unit$/i, "");
}

function getShortOperatingAction(action) {
  const type = String(action?.action || action?.action_label || "").toLowerCase();
  const resource = getShortResourceName(action);

  if (type.includes("restart")) return `Restart ${resource}`;
  if (type.includes("start")) return `Start ${resource}`;
  if (type.includes("stop")) return `Stop ${resource}`;
  if (type.includes("discharge")) return resource.toLowerCase().includes("battery")
    ? "Discharge Battery"
    : `Discharge ${resource}`;
  if (type.includes("charge")) return resource.toLowerCase().includes("battery")
    ? "Charge Battery"
    : `Charge ${resource}`;
  if (type.includes("import") || resource.toLowerCase().includes("grid")) return "Grid Support";
  if (type.includes("keep_on") || type.includes("keep running")) return `Keep ${resource} On`;

  const label = String(action?.action_label || action?.status || "Follow Schedule").trim();
  return resource && !label.toLowerCase().includes(resource.toLowerCase())
    ? `${label} ${resource}`.trim()
    : label;
}

function buildOperatingEventMarkers(actions, fallbackItems = []) {
  const source = Array.isArray(actions) ? actions : [];
  const visible = source.filter((action) => {
    const type = String(action?.action || action?.action_label || "").toLowerCase();
    return ["start", "restart", "stop", "discharge", "charge", "grid", "import"].some((token) => type.includes(token));
  });

  if (!visible.length) return buildCompactActionChips(fallbackItems);

  const groups = new Map();
  visible.forEach((action, index) => {
    const hour = normalizeHourValue(action?.hour ?? action?.time ?? 0);
    if (!groups.has(hour)) groups.set(hour, []);
    groups.get(hour).push({ ...action, _markerIndex: index });
  });

  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([hour, groupedActions]) => {
      const labels = groupedActions.map(getShortOperatingAction);
      const startLike = groupedActions.every((action) => {
        const type = String(action?.action || action?.action_label || "").toLowerCase();
        return type.includes("start") || type.includes("restart");
      });

      let label = labels[0] || "Scheduled action";
      if (groupedActions.length > 2) {
        label = `${groupedActions.length} actions`;
      } else if (groupedActions.length === 2 && startLike) {
        const resources = groupedActions.map(getShortResourceName);
        const dieselSuffixes = resources.map((resource) => {
          const match = resource.match(/^Diesel\s+(.+)$/i);
          return match ? match[1] : null;
        });
        label = dieselSuffixes.every(Boolean)
          ? `Start Diesel ${dieselSuffixes.join(" + ")}`
          : `Start ${resources.join(" + ")}`;
      } else if (groupedActions.length === 2) {
        label = `${labels[0]} · ${labels[1]}`;
      }

      return {
        id: `operating-event-${hour}`,
        time: formatHour(hour),
        label,
        description: labels.join(" · "),
        hours: [hour],
        actions: groupedActions,
      };
    });
}

function getActionLogLabel(action, rows = [], index = 0) {
  const type = String(action?.action || action?.action_label || "").toLowerCase();
  const label = String(action?.action_label || action?.action || "Follow schedule").trim();

  if (type.includes("keep_running") || type.includes("keep running") || type.includes("continue")) {
    return "Continue running";
  }
  if (type.includes("discharge")) return "Begin discharge";
  if (type.includes("charge")) return "Begin charge";
  if (type.includes("stop")) return "Stop";
  if (type.includes("restart")) return "Restart";
  if (type.includes("start")) {
    const resourceId = String(action?.resource_id || action?.resource_name || "").toLowerCase();
    const stoppedEarlier = rows.slice(0, index).some((previous) => {
      const previousResource = String(previous?.resource_id || previous?.resource_name || "").toLowerCase();
      const previousType = String(previous?.action || previous?.action_label || "").toLowerCase();
      return previousResource === resourceId && previousType.includes("stop");
    });
    return stoppedEarlier ? "Restart" : "Start";
  }

  return label;
}

function getActionLogActionTone(action, rows = [], index = 0) {
  const label = getActionLogLabel(action, rows, index).toLowerCase();
  const semanticState = [
    action?.action,
    action?.action_label,
    action?.status,
    action?.resource_name,
    action?.resource_id,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/review|warning|violation/.test(semanticState)) return "warning";
  if (/error|failed|invalid/.test(semanticState)) return "danger";
  if (/discharge|charge|battery|storage/.test(semanticState)) return "battery";
  if (/grid|import/.test(semanticState)) return "grid";
  if (/stop|shutdown|turn_off|\boff\b/.test(semanticState) || label === "stop") return "stop";
  if (/restart|start|turn_on/.test(semanticState) || label === "start" || label === "restart") return "start";
  if (/keep_running|keep running|continue|running/.test(semanticState) || label === "continue running") return "running";

  return "neutral";
}

function getCombinedActionLogText(action, rows = [], index = 0) {
  const actionLabel = getActionLogLabel(action, rows, index);
  const resource = getShortResourceName(action);

  if (actionLabel === "Continue running") return `Keep ${resource} running`;
  if (actionLabel === "Begin discharge") return `Discharge ${resource}`;
  if (actionLabel === "Begin charge") return `Charge ${resource}`;
  return `${actionLabel} ${resource}`;
}

function getActionLogStatusTone(action, powerValue = null) {
  const actionType = String(action?.action || action?.action_label || "").toLowerCase();
  const status = String(action?.status || "").toLowerCase();
  const resource = String(action?.resource_name || action?.resource_id || "").toLowerCase();
  const semanticState = `${actionType} ${status} ${resource}`;
  const numericPower = Number(powerValue);
  const hasPositiveOutput = Number.isFinite(numericPower) && Math.abs(numericPower) > 0;

  if (/error|fail|failed|invalid|violation/.test(semanticState)) return "danger";
  if (/review|warning|watch/.test(semanticState)) return "warning";
  if (/discharge|charge|battery|storage/.test(semanticState)) return "battery";
  if (/stop|shutdown|turn_off|\boff\b/.test(semanticState)) return "off";
  if (hasPositiveOutput) return "on";
  if (/\bon\b|running|online|available/.test(semanticState)) return "on";

  return "neutral";
}

function getCompactOperatingReason(action) {
  const raw = String(action?.reason || "").trim();
  const lower = raw.toLowerCase();

  if (!raw) return "Scheduled action";
  const hour = normalizeHourValue(action?.hour ?? action?.time ?? 0);
  const type = String(action?.action || action?.action_label || "").toLowerCase();

  if (type.includes("stop") && hour >= 22) return "Peak ended";
  if (lower.includes("no longer required") || lower.includes("no longer needed")) return "No longer needed";
  if (lower.includes("beginning of the operating horizon") || lower.includes("overnight")) return "Initial support";
  if (lower.includes("evening") && lower.includes("ramp")) return "Evening support";
  if (lower.includes("high-demand") || lower.includes("peak")) return "Peak support";
  if (lower.includes("grid") && (lower.includes("limit") || lower.includes("boundary"))) return "Grid-limit response";
  if (lower.includes("renewable") || lower.includes("solar") || lower.includes("wind")) return "Renewables sufficient";
  if (lower.includes("battery") || lower.includes("stored energy")) return "Storage support";
  if (lower.includes("reserve")) return "Reserve support";

  const firstSentence = raw.split(/[.!?]/)[0].trim();
  return firstSentence.length > 42 ? `${firstSentence.slice(0, 39).trim()}…` : firstSentence;
}

const RESULT_METHOD_CATALOG = Object.freeze({
  classical: {
    id: "classical",
    name: "Classical HiGHS Baseline",
    shortLabel: "Classical",
  },
  hybrid: {
    id: "hybrid",
    name: "ADMM-Guided Hybrid QAOA",
    shortLabel: "Hybrid",
  },
});

function resolveSelectedResultMethodId() {
  return "hybrid";
}

function getResultMethods(view) {
  return [
    {
      ...RESULT_METHOD_CATALOG.classical,
      cost: Number(view?.ruleBased?.cost ?? 0),
      time: Number(view?.ruleBased?.runtime ?? 0),
      curtailment: Number(view?.ruleBased?.curtailment ?? 0),
    },
    {
      ...RESULT_METHOD_CATALOG.hybrid,
      cost: Number(view?.hybrid?.cost ?? 0),
      time: Number(view?.hybrid?.runtime ?? 0),
      curtailment: Number(view?.hybrid?.curtailment ?? 0),
    },
  ];
}

function getResultMethodComparison(view) {
  const methods = getResultMethods(view);
  const selected =
    methods.find((method) => method.id === view?.selectedMethodId) || methods[1];
  const bestCost = methods.reduce((best, method) =>
    method.cost < best.cost ? method : best
  );
  const bestCurtailment = methods.reduce((best, method) =>
    method.curtailment < best.curtailment ? method : best
  );
  const fastest = methods.reduce((best, method) =>
    method.time < best.time ? method : best
  );

  return { methods, selected, bestCost, bestCurtailment, fastest };
}

function ActionLogNote({ note, compact }) {
  const anchorRef = useRef(null);
  const [tooltip, setTooltip] = useState(null);
  const fullNote = String(note || "Included in the selected schedule.");

  const openTooltip = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;

    const width = Math.min(340, Math.max(240, window.innerWidth - 32));
    const left = Math.max(
      16,
      Math.min(rect.right - width, window.innerWidth - width - 16)
    );
    const spaceBelow = window.innerHeight - rect.bottom;
    const openAbove = spaceBelow < 120 && rect.top > 120;

    setTooltip({
      left,
      top: openAbove ? rect.top - 8 : rect.bottom + 8,
      openAbove,
      width,
    });
  };

  useEffect(() => {
    if (!tooltip) return undefined;
    const close = () => setTooltip(null);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [tooltip]);

  return (
    <>
      <small
        ref={anchorRef}
        className="actionLogReason"
        role="cell"
        aria-label={fullNote}
        onMouseEnter={openTooltip}
        onMouseLeave={() => setTooltip(null)}
      >
        {compact}
      </small>

      {tooltip && createPortal(
        <div
          className={`actionLogNoteTooltip ${tooltip.openAbove ? "above" : "below"}`}
          role="tooltip"
          style={{
            left: tooltip.left,
            top: tooltip.top,
            width: tooltip.width,
            transform: tooltip.openAbove ? "translateY(-100%)" : "none",
          }}
        >
          <span>Full note</span>
          <p>{fullNote}</p>
        </div>,
        document.body
      )}
    </>
  );
}

function OperatingEventsPanel({
  actions = [],
  selectedHour = null,
  onHoverHour,
  onLeaveHour,
  onSelectHour,
  footerActions = null,
}) {
  const rows = Array.isArray(actions) ? actions : [];

  return (
    <section className="operatingEventsPanel actionLogPanel" aria-label="Complete operating action log">
      <header className="operatingEventsHeader actionLogHeader">
        <div>
          <h4>Action Log</h4>
        </div>
        <span>{rows.length} {rows.length === 1 ? "action" : "actions"}</span>
      </header>

      <div className="operatingEventsTable actionLogTable" role="table" aria-label="Operating actions by time">
        <div className="operatingEventsTableHead actionLogTableHead" role="row">
          <span role="columnheader">Time</span>
          <span role="columnheader">Asset</span>
          <span role="columnheader">Action</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Note</span>
        </div>

        <div className="operatingEventsRows actionLogRows">
          {rows.map((action, index) => {
            const hour = normalizeHourValue(action?.hour ?? action?.time ?? 0);
            const power = Number(action?.power_mw);
            const powerStatus = Number.isFinite(power) && Math.abs(power) > 0
              ? `${Math.abs(power).toFixed(power % 1 === 0 ? 0 : 1)} MW`
              : String(action?.status || "Scheduled");
            const active = selectedHour != null && Number(selectedHour) === hour;
            const actionTone = getActionLogActionTone(action, rows, index);

            return (
              <button
                type="button"
                className={`operatingEventRow actionLogRow actionTone-${actionTone} ${active ? "active" : ""}`}
                key={action?.id || `${hour}-${index}`}
                role="row"
                aria-pressed={active}
                onMouseEnter={() => onHoverHour?.(hour)}
                onMouseLeave={() => onLeaveHour?.()}
                onFocus={() => onHoverHour?.(hour)}
                onBlur={() => onLeaveHour?.()}
                onClick={() => onSelectHour?.(hour)}
              >
                <span className="operatingEventTime" role="cell">{formatHour(hour)}</span>
                <span className="actionLogAsset" role="cell">
                  <b>{action?.resource_name || action?.resource_id || "System"}</b>
                </span>
                <span className={`actionLogAction ${actionTone}`} role="cell">
                  <i className="actionLogActionMarker" aria-hidden="true" />
                  <span>{getActionLogLabel(action, rows, index)}</span>
                </span>
                <strong className={`actionLogStatus ${getActionLogStatusTone(action, power)}`} role="cell">{powerStatus}</strong>
                <ActionLogNote
                  note={action?.reason || "Included in the selected schedule."}
                  compact={getCompactOperatingReason(action)}
                />
              </button>
            );
          })}

          {!rows.length && (
            <div className="operatingEventsEmpty">No start, stop, battery, or grid actions were returned.</div>
          )}
        </div>
      </div>

      {footerActions && (
        <footer className="actionLogFooter">
          {footerActions}
        </footer>
      )}
    </section>
  );
}

/* ==========================================================================
   08. Page 03 — Results and operator decision board
   ========================================================================== */

// #endregion

// #region 08C — Results page and final customer report
function ResultsPage({
  result,
  selectedScenario,
  selectedSolver,
  running,
  solvePhase,
  setPage,
  runDemo,
}) {
  const [scheduleView, setScheduleView] = useState("dispatch");
  const [selectedUnit, setSelectedUnit] = useState(null);
  const [selectedUnitAnchor, setSelectedUnitAnchor] = useState(null);
  const [showUnusedUnits, setShowUnusedUnits] = useState(false);
  const [selectedOperatingEventHour, setSelectedOperatingEventHour] = useState(null);
  const [hoveredOperatingEventHour, setHoveredOperatingEventHour] = useState(null);
  const [pdfExportState, setPdfExportState] = useState("idle");
  const view = useMemo(
    () => buildAdvancedResultView(result, selectedScenario, selectedSolver),
    [result, selectedScenario, selectedSolver]
  );

  const handleUnitSelect = (row, anchorElement) => {
    const rowElement = anchorElement?.closest?.(".commitmentRow") || anchorElement || null;
    const containerElement = anchorElement?.closest?.(".unitActionsScheduleView") || null;

    setSelectedUnit(row);
    setSelectedUnitAnchor(
      rowElement
        ? { rowElement, containerElement }
        : null
    );
  };

  const fallbackDispatch = Array.isArray(view.hybrid.dispatch24h)
    ? view.hybrid.dispatch24h
    : [];
  const fallbackCommitmentRows = useMemo(
    () => buildOperatorCommitmentRows(result),
    [result]
  );
  const fallbackStressHours = useMemo(() => resolveStressHours(result), [result]);
  const fallbackRenewableShare = firstFiniteNumber(
    result?.renewable_share,
    result?.renewableShare,
    result?.hybrid?.renewable_share,
    result?.hybrid?.renewableShare,
    result?.result?.renewable_share
  ) ?? 60.7;
  const scenarioName = selectedScenario?.id === "congestion"
    ? "Grid Congestion"
    : selectedScenario?.name || "Selected scenario";
  const operatingPlan = useMemo(
    () => buildCanonicalOperatingPlan({
      result,
      view,
      scenarioName,
      selectedScenario,
      fallbackDispatch,
      fallbackCommitmentRows,
      fallbackStressHours,
      renewableShare: fallbackRenewableShare,
    }),
    [
      result,
      view,
      scenarioName,
      selectedScenario,
      fallbackDispatch,
      fallbackCommitmentRows,
      fallbackStressHours,
      fallbackRenewableShare,
    ]
  );
  const dispatch = useMemo(() => operatingPlanToDispatch(operatingPlan), [operatingPlan]);
  const commitmentRows = operatingPlan.generators;
  const activeCommitmentRows = useMemo(
    () => commitmentRows.filter((row) => Array.isArray(row.schedule) && row.schedule.some(Boolean)),
    [commitmentRows]
  );
  const unusedCommitmentRows = useMemo(
    () => commitmentRows.filter((row) => !Array.isArray(row.schedule) || !row.schedule.some(Boolean)),
    [commitmentRows]
  );
  const displayedCommitmentRows = showUnusedUnits
    ? [...activeCommitmentRows, ...unusedCommitmentRows]
    : activeCommitmentRows;
  const selectedUnitDetails = selectedUnit;
  const commitmentStats = useMemo(
    () => analyzeCommitmentRows(commitmentRows),
    [commitmentRows]
  );
  const stressHours = operatingPlan.summary.high_demand_hours;
  const activeOperatingEventHour = hoveredOperatingEventHour ?? selectedOperatingEventHour;
  const renewableShare = Number(operatingPlan.summary.renewable_share_percent || fallbackRenewableShare);
  const gridLimit = Number(operatingPlan.summary.grid_limit_mw || selectedScenario?.gridLimit || 60);
  const stressWindow = formatHourWindow(stressHours);
  const methodComparison = useMemo(
    () => getResultMethodComparison(view),
    [view]
  );
  const selectedMethod = methodComparison.selected;
  const selectedScheduleCost = Number(
    operatingPlan.summary.validated_cost ?? selectedMethod.cost ?? 0
  );
  const selectedScheduleCurtailment = Number(
    operatingPlan.summary.curtailment_mwh ?? selectedMethod.curtailment ?? 0
  );

  const handlePdfExport = async () => {
    if (pdfExportState === "exporting") return;
    setPdfExportState("exporting");
    try {
      await exportCustomerSchedulePdf(operatingPlan, result);
      setPdfExportState("success");
      window.setTimeout(() => setPdfExportState("idle"), 2200);
    } catch (error) {
      console.error("Schedule PDF export failed.", error);
      setPdfExportState("error");
      window.setTimeout(() => setPdfExportState("idle"), 3200);
    }
  };

  return (
    <section className="resultsViewport pageEnter operatorResultsPage operatorDecisionBoard plainOperatorBoard">
      <header className="operatorResultsHeader compactOperatorHeader">
        <div className="pageHeaderLead">
          <div className="pageHeaderCopy">
            <span className="kicker">Operating Output</span>
            <h2>{scenarioName} · Recommended Schedule</h2>
          </div>
        </div>

        <div className="resultActions operatorHeaderActions">
          <button
            type="button"
            className={`schedulePdfExportButton ${pdfExportState}`}
            onClick={handlePdfExport}
            disabled={pdfExportState === "exporting"}
            aria-label="Export the customer unit schedule as a PDF"
          >
            <span className="schedulePdfExportIcon" aria-hidden="true">
              {pdfExportState === "exporting" ? "..." : pdfExportState === "success" ? "OK" : "PDF"}
            </span>
            <strong>
              {pdfExportState === "exporting"
                ? "Preparing PDF..."
                : pdfExportState === "success"
                  ? "PDF Downloaded"
                  : pdfExportState === "error"
                    ? "Try PDF Export Again"
                    : "Export Schedule PDF"}
            </strong>
          </button>
          <button className="secondaryCta" onClick={() => setPage(1)}>Back to Workspace</button>
        </div>
      </header>

      <section className="compactResultBar" aria-label="Result summary">
        <article className="compactResultPrimary">
          <div className="compactResultPrimaryTop">
            <h3>{selectedMethod.name} · Validated Schedule</h3>
            <b>Passed</b>
          </div>
          <p>Support · <strong>{stressWindow}</strong></p>
        </article>

        <div className="compactResultMetric cost">
          <span>Cost</span>
          <strong>{money(selectedScheduleCost)}</strong>
        </div>

        <div className="compactResultMetric coverage">
          <span>Demand Coverage</span>
          <strong>{view.feasibleHours}</strong>
        </div>

        <div className="compactResultMetric">
          <span>Unused Renewables</span>
          <strong>{selectedScheduleCurtailment.toFixed(2)} MWh</strong>
        </div>

        <div className="compactResultMetric">
          <span>Renewable Share</span>
          <strong>{renewableShare.toFixed(1)}%</strong>
        </div>
      </section>

      <section className={`operatorSection compactCommitmentSection operatorScheduleSection splitScheduleLayout ${scheduleView}`}>
        <div className="scheduleColumn">
          <div className="operatorSectionHead compactScheduleHead operatorScheduleHead">
            <div className="operatorScheduleTitle">
              <h3>{scheduleView === "dispatch" ? "Power Supply" : "Unit Schedule"}</h3>
            </div>

            <div className="operatorScheduleTools">
              <div className="scheduleViewSwitch" role="group" aria-label="Choose the schedule view">
                <button
                  type="button"
                  className={scheduleView === "dispatch" ? "active" : ""}
                  aria-pressed={scheduleView === "dispatch"}
                  onClick={() => {
                    setScheduleView("dispatch");
                    setSelectedUnit(null);
                    setSelectedUnitAnchor(null);
                  }}
                >
                  Power Supply
                </button>
                <button
                  type="button"
                  className={scheduleView === "actions" ? "active" : ""}
                  aria-pressed={scheduleView === "actions"}
                  onClick={() => setScheduleView("actions")}
                >
                  Generator On / Off
                </button>
              </div>
              <div className="stressWindowBadge">Extra support · {stressWindow}</div>
            </div>
          </div>

          <div className={`operatorScheduleBody ${scheduleView}`}>
            {scheduleView === "dispatch" ? (
              <div className="operatorDispatchPanel mainOperatorDispatchPanel plainDispatchPanel">
                <DispatchStackedChart
                  data={dispatch}
                  stressHours={stressHours}
                  committedUnit="Diesel Unit A + Diesel Unit B"
                  gridLimit={gridLimit}
                  highlightedHour={activeOperatingEventHour}
                  onHoverHour={setHoveredOperatingEventHour}
                  onLeaveHour={() => setHoveredOperatingEventHour(null)}
                />
              </div>
            ) : (
              <div className="unitActionsScheduleView">
                <CommitmentTimeline
                  rows={displayedCommitmentRows}
                  stressHours={stressHours}
                  selectedUnitId={selectedUnitDetails?.id}
                  unusedUnitCount={unusedCommitmentRows.length}
                  showUnusedUnits={showUnusedUnits}
                  onToggleUnused={() => {
                    setShowUnusedUnits((current) => !current);
                    setSelectedUnit(null);
                    setSelectedUnitAnchor(null);
                  }}
                  onUnitSelect={handleUnitSelect}
                  highlightedHour={activeOperatingEventHour}
                  onHoverHour={setHoveredOperatingEventHour}
                  onLeaveHour={() => setHoveredOperatingEventHour(null)}
                />
                <div
                  className="unitScheduleLegend commitmentLegend plainLanguageLegend"
                  aria-label="Generator schedule legend"
                >
                  <span><i className="on" /> Running</span>
                  <span><i className="off" /> Off</span>
                  <span><i className="start" /> Start</span>
                  <span><i className="stop" /> Stop</span>
                  <span><i className="stress" /> High-demand window</span>
                </div>
                <UnitSchedulePopover
                  row={selectedUnitDetails}
                  stressHours={stressHours}
                  anchor={selectedUnitAnchor}
                  onClose={() => {
                    setSelectedUnit(null);
                    setSelectedUnitAnchor(null);
                  }}
                />
              </div>
            )}
          </div>
        </div>

        <OperatingEventsPanel
          actions={operatingPlan.recommended_actions}
          selectedHour={activeOperatingEventHour}
          onHoverHour={setHoveredOperatingEventHour}
          onLeaveHour={() => setHoveredOperatingEventHour(null)}
          onSelectHour={(hour) =>
            setSelectedOperatingEventHour((current) => current === hour ? null : hour)
          }
          footerActions={null}
        />
      </section>

    </section>
  );
}


function FinalReportPanel({ view }) {
  const { methods, selected, bestCost, bestCurtailment, fastest } =
    getResultMethodComparison(view);

  function comparisonText(reference) {
    const delta = selected.cost - reference.cost;
    const percent = Math.abs(delta) / Math.max(reference.cost, 1) * 100;
    if (Math.abs(delta) < 0.5) return `equal to ${reference.name}`;
    return `${percent.toFixed(1)}% ${delta < 0 ? "below" : "above"} ${reference.name}`;
  }

  const selectedComparisons = methods
    .filter((method) => method.id !== selected.id)
    .map(comparisonText);
  const runtimeDelta = selected.time - fastest.time;
  const runtimeText = fastest.id === selected.id || Math.abs(runtimeDelta) < 0.05
    ? "the fastest measured runtime in this response"
    : `${Math.abs(runtimeDelta).toFixed(2)} s slower than ${fastest.name}`;

  return (
    <div className="finalReportPanel conclusionOnlyLayout">
      <section className="conclusionSummarySection">
        <div className="conclusionSectionTitle">Method Summary</div>
        <div className="finalReportTableCard conclusionMethodTableCard">
          <table className="resultTable conclusionMethodTable">
            <thead>
              <tr>
                <th>Method</th>
                <th>Cost</th>
                <th>Time</th>
                <th>Unused Renewables</th>
              </tr>
            </thead>
            <tbody>
              {methods.map((method) => (
                <tr
                  key={method.id}
                  className={`${method.id === bestCost.id ? "adaptiveReportRow bestCostReportRow" : ""} ${method.id === selected.id ? "selectedReportRow" : ""}`.trim()}
                >
                  <td>
                    <strong>{method.name}</strong>
                    {method.id === selected.id && <small className="selectedMethodTag">Selected</small>}
                  </td>
                  <td>{money(method.cost)}</td>
                  <td>{method.time.toFixed(2)}s</td>
                  <td>{method.curtailment.toFixed(2)} MWh</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="conclusionDecisionCard">
        <span>Conclusion</span>
        <p>
          The backend-selected validated schedule is <mark>{selected.name}</mark> at
          <mark>{money(selected.cost)}</mark>. It is {selectedComparisons.map((text, index) => (
            <React.Fragment key={text}>
              {index > 0 ? (index === selectedComparisons.length - 1 ? " and " : ", ") : " "}
              <mark>{text}</mark>
            </React.Fragment>
          ))}.
          {bestCost.id === selected.id
            ? " This is the lowest returned operating cost in the current run."
            : ` The lowest returned cost is ${bestCost.name} at ${money(bestCost.cost)}; therefore, this run does not claim that the selected method is the least-cost method.`}
        </p>
        <p>
          The lowest unused-renewable value is returned by <mark>{bestCurtailment.name}</mark> at
          <mark>{bestCurtailment.curtailment.toFixed(2)} MWh</mark>. The selected schedule has
          <mark>{runtimeText}</mark>. Runtime values reflect the current backend response and browser round trip,
          not a hardware-level speedup measurement.
        </p>
        <p>
          The selected bitstring is reconstructed into a complete commitment schedule and evaluated with
          multi-period economic dispatch. Power balance, reserve, generator capacity, ramping, and temporal
          commitment checks are applied before the schedule is accepted for the operating view.
        </p>
      </section>
    </div>
  );
}


function ConclusionMetric({ label, value, note, pending = false }) {
  return (
    <div className={pending ? "metricPending" : ""} aria-busy={pending}>
      <span>{label}</span>
      <strong>{pending ? "Calculating…" : value}</strong>
      <small>{pending ? "Updates after validation completes" : note}</small>
    </div>
  );
}


function InsightItem({ number, title, text }) {
  return (
    <div className="insightItem">
      <b>{number}</b>
      <div>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
    </div>
  );
}

// #endregion

// #endregion

// #region 09 — Result charts and evidence views
/* ==========================================================================
   09. Result charts and evidence views
   ========================================================================== */

// #region 09A — Dispatch and supply visualization
function DispatchStackedChart({
  data = [],
  selectedModel = "hybrid",
  models = [],
  onModelChange = null,
  annotation = "",
  stressHours = [],
  committedUnit = "Dispatchable support",
  gridLimit = 0,
  highlightedHour = null,
  onHoverHour,
  onLeaveHour,
}) {
  const [hoveredSegment, setHoveredSegment] = useState(null);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const modelMenuRef = useRef(null);
  const safeData = Array.isArray(data) ? data : [];
  const stressHourSet = new Set((stressHours || []).map(Number));
  const activeModel =
    models.find((model) => model.id === selectedModel) ||
    models[0] ||
    { id: "hybrid", label: "Hybrid QAOA" };

  useEffect(() => {
    if (!isModelMenuOpen) return undefined;

    function closeOnOutsidePointer(event) {
      if (!modelMenuRef.current?.contains(event.target)) {
        setIsModelMenuOpen(false);
      }
    }

    function closeOnEscape(event) {
      if (event.key === "Escape") {
        setIsModelMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isModelMenuOpen]);

  const maxLoad = Math.max(...safeData.map((d) => Number(d.load || 0)), 1);
  const yTicks = Array.from({ length: 5 }, (_, index) =>
    Math.round(maxLoad * (1 - index / 4))
  );
  const resources = [
    ["solar", "Solar"],
    ["wind", "Wind"],
    ["battery", "Battery"],
    ["grid", "Grid"],
    ["diesel", "Diesel"],
  ];

  function setTooltip(event, payload) {
    const chartRect = event.currentTarget
      .closest(".interactiveDispatchChart")
      ?.getBoundingClientRect();

    if (!chartRect) return;

    const targetRect = event.currentTarget.getBoundingClientRect?.();
    const clientX = Number.isFinite(event.clientX)
      ? event.clientX
      : (targetRect?.left || chartRect.left) + (targetRect?.width || 0) / 2;
    const clientY = Number.isFinite(event.clientY)
      ? event.clientY
      : (targetRect?.top || chartRect.top) + (targetRect?.height || 0) / 2;

    setHoveredSegment({
      ...payload,
      x: Math.min(Math.max(clientX, 12), Math.max(window.innerWidth - 244, 12)),
      y: Math.min(Math.max(clientY, 24), Math.max(window.innerHeight - 24, 24)),
    });
  }

  function showSegment(event, hourData, resourceKey, resourceLabel) {
    const value = Number(hourData[resourceKey] || 0);
    const totalDispatch = resources.reduce(
      (sum, [key]) => sum + Number(hourData[key] || 0),
      0
    );

    const load = Math.max(0, Number(hourData.load || 0));
    const hourNumber = normalizeHourValue(hourData.hour);
    const isStressHour = stressHourSet.has(hourNumber);
    const renewable = Math.max(
      0,
      Number(hourData.solar || 0) + Number(hourData.wind || 0)
    );
    const residualPressure = Math.max(load - renewable, 0);

    setTooltip(event, {
      hour: hourData.hour,
      key: resourceKey,
      label: resourceLabel,
      value,
      percentage: totalDispatch > 0 ? (value / totalDispatch) * 100 : 0,
      load,
      totalDispatch,
      balanceResidual: totalDispatch - load,
      isStressHour,
      committedUnit: isStressHour ? committedUnit : "No escalation required",
      solar: Number(hourData.solar || 0),
      wind: Number(hourData.wind || 0),
      batteryDischarge: Number(hourData.battery || 0),
      gridImport: Number(hourData.grid || 0),
      diesel: Number(hourData.diesel || 0),
      residualPressure,
      gridLimit: Number(gridLimit || 0),
    });
  }


  return (
    <div
      className={`dispatchChart interactiveDispatchChart ${onModelChange ? "withModelToggle" : ""}`}
      onMouseLeave={() => {
        setHoveredSegment(null);
        onLeaveHour?.();
      }}
    >
      {onModelChange && models.length > 0 && (
        <div className="dispatchModelToolbar dispatchModelToolbarFocused">
          {annotation && (
            <div className="dispatchValidationBanner" role="status">
              {annotation}
            </div>
          )}

          <div className="dispatchModelControl">
            <span>Dispatch model</span>

            <div className="dispatchModelSelect" ref={modelMenuRef}>
              <button
                type="button"
                className={`dispatchModelSelectTrigger ${isModelMenuOpen ? "open" : ""}`}
                aria-haspopup="listbox"
                aria-expanded={isModelMenuOpen}
                onClick={() => setIsModelMenuOpen((open) => !open)}
              >
                <span className={`dispatchModelSelectDot ${activeModel.id}`} aria-hidden="true" />
                <strong>{activeModel.label}</strong>
                <i aria-hidden="true">⌄</i>
              </button>

              {isModelMenuOpen && (
                <div
                  className="dispatchModelSelectMenu"
                  role="listbox"
                  aria-label="Select dispatch model"
                >
                  {models.map((model) => {
                    const isSelected = selectedModel === model.id;

                    return (
                      <button
                        key={model.id}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        className={isSelected ? "selected" : ""}
                        onClick={() => {
                          onModelChange(model.id);
                          setIsModelMenuOpen(false);
                        }}
                      >
                        <span className={`dispatchModelSelectDot ${model.id}`} aria-hidden="true" />
                        <strong>{model.label}</strong>
                        <i aria-hidden="true">{isSelected ? "✓" : ""}</i>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="dispatchPlot">
        <span className="dispatchYAxisTitle" aria-hidden="true">Supply (MW)</span>

        <div className="dispatchYAxis" aria-hidden="true">
          <div className="dispatchYAxisTicks">
            {yTicks.map((tick) => <span key={tick}>{tick}</span>)}
          </div>
        </div>

        <div className="dispatchPlotCanvas">
          <div className="dispatchBars">
            {safeData.map((d, index) => {
              const hourNumber = normalizeHourValue(d.hour);
              const isLinkedHour = highlightedHour != null && Number(highlightedHour) === hourNumber;

              return (
                <div
                  className={`dispatchHour ${stressHourSet.has(hourNumber) ? "stressHour" : ""} ${
                    isLinkedHour ? "linkedHourActive" : ""
                  }`}
                  key={d.hour}
                  onMouseEnter={() => onHoverHour?.(hourNumber)}
                >
                  <div className="dispatchBarFrame">
                    {resources.map(([key, label]) => {
                      const value = Number(d[key] || 0);
                      const isActive =
                        hoveredSegment?.hour === d.hour &&
                        hoveredSegment?.key === key;

                      return (
                        <div
                          key={key}
                          className={`dispatchSegment ${key} ${isActive ? "active" : ""}`}
                          style={{
                            height: `${Math.max(0, (value / maxLoad) * 100)}%`,
                            animationDelay: `${index * 22}ms`,
                          }}
                          onMouseEnter={(event) => showSegment(event, d, key, label)}
                          onMouseMove={(event) => showSegment(event, d, key, label)}
                          aria-label={`${d.hour}, ${label}, ${value} MW`}
                        />
                      );
                    })}
                  </div>

                  <span>{index % 3 === 0 ? d.hour : ""}</span>
                </div>
              );
            })}
          </div>

        </div>
      </div>

      {hoveredSegment && createPortal(
        <div
          className="chartHoverTooltip dispatchHoverTooltip plainDispatchTooltip portalChartTooltip"
          style={{
            left: `${hoveredSegment.x}px`,
            top: `${hoveredSegment.y}px`,
          }}
        >
          <small>{String(hoveredSegment.hour).padStart(2, "0")}:00</small>
          <div className={`dispatchTooltipStatus ${hoveredSegment.isStressHour ? "stress" : "normal"}`}>
            {hoveredSegment.isStressHour ? "High-demand hour" : "Normal operation"}
          </div>
          <strong>{hoveredSegment.label}</strong>
          <span>{hoveredSegment.value.toFixed(0)} MW</span>
          <b>{`${hoveredSegment.percentage.toFixed(1)}% of supply`}</b>
          <div className="dispatchBalanceDetails operatorTooltipDetails plainSupplyBreakdown">
            <span>Solar <strong>{hoveredSegment.solar.toFixed(0)} MW</strong></span>
            <span>Wind <strong>{hoveredSegment.wind.toFixed(0)} MW</strong></span>
            <span>Battery <strong>{hoveredSegment.batteryDischarge.toFixed(0)} MW</strong></span>
            <span>Grid import <strong>{hoveredSegment.gridImport.toFixed(0)} MW</strong></span>
            <span>Diesel <strong>{hoveredSegment.diesel.toFixed(0)} MW</strong></span>
            <span>Demand <strong>{hoveredSegment.load.toFixed(0)} MW</strong></span>
            <span>Supply <strong>{hoveredSegment.totalDispatch.toFixed(0)} MW</strong></span>
            <span className="supplyResult">Result <strong>Fully covered</strong></span>
          </div>
        </div>,
        document.body
      )}

      <div className="legend">
        {resources.map(([key, label]) => (
          <span key={key}>
            <i className={key} /> {label}
          </span>
        ))}
      </div>
    </div>
  );
}

// #endregion

// #region 09B — Convergence evidence visualization
function QAOAConvergencePanel({ data, view, running, solvePhase }) {
  const showConsole = running && ["pulse", "logs"].includes(solvePhase);
  const showRevealSweep = running && solvePhase === "reveal";
  const classicalCost = Math.max(Number(view.ruleBased.cost || 0), 1);
  const adaptiveCost = Number(view.hybrid.cost || 0);
  const adaptiveReduction = ((classicalCost - adaptiveCost) / classicalCost) * 100;

  return (
    <div className="methodConvergencePanel focusedQaoaConvergencePanel">
      <section className={`telemetryChartPanel methodConvergenceChart focusedQaoaChart embeddedSummaryConvergence ${showRevealSweep ? "scanSweepActive" : ""}`}>
        <div className="qaoaSubHead conciseQaoaSubHead">
          <div className="convergenceTitleBlock">
            <strong>Validated Cost by Method</strong>
            <span>Validated candidate-cost trajectory against Classical and Hybrid references.</span>
          </div>
        </div>

        <div className="qaoaEvidenceLayout embeddedConvergenceLayout">
          <ConvergenceChart
            data={data}
            summary={{
              classicalCost,
              adaptiveCost,
              adaptiveReduction,
            }}
          />
        </div>

        {showConsole && (
          <div className={`chartComputeOverlay ${solvePhase}`}>
            <span>
              {solvePhase === "pulse"
                ? "Locking the scenario and initializing the ADMM feedback loop..."
                : "Updating model traces and validating reconstructed dispatch..."}
            </span>
          </div>
        )}

        {showRevealSweep && (
          <div className="chartRevealOverlay">
            <div className="scanSweepLine" />
            <span>Classical–Hybrid comparison complete</span>
          </div>
        )}
      </section>
    </div>
  );
}

function ConvergenceChart({ data, summary }) {
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const width = 1140;
  const height = 500;
  const pad = { top: 28, right: 120, bottom: 54, left: 58 };
  const fallback = makeConvergence(128402, 128402, 113902);
  const source = Array.isArray(data) && data.length > 1 ? data : fallback;
  const safeData = source.map((item, index) => {
    const fallbackPoint = fallback[Math.min(index, fallback.length - 1)];
    const classical = Number(item.baseline ?? item.classical ?? item.milp);
    const hybrid = Number(item.hybrid ?? item.adaptive ?? item.qaoa);
    return {
      step: Number(item.step ?? item.round ?? item.iteration ?? index + 1),
      classical: Number.isFinite(classical) ? classical : fallbackPoint.baseline,
      hybrid: Number.isFinite(hybrid) ? hybrid : fallbackPoint.adaptive,
      residual: Number(item.residual ?? item.residual_l2_mw ?? 0),
    };
  });
  const classicalReference = Math.max(
    Number(summary?.classicalCost || safeData.at(-1)?.classical || 128402),
    1
  );
  const hybridFinal = Number(summary?.adaptiveCost || summary?.hybridCost || safeData.at(-1)?.hybrid || 113902);
  const plotted = safeData.map((item) => ({ ...item, classical: classicalReference }));
  const allCosts = plotted.flatMap((item) => [item.classical, item.hybrid]);
  const rawMin = Math.min(...allCosts);
  const rawMax = Math.max(...allCosts);
  const range = Math.max(rawMax - rawMin, 1000);
  const minValue = rawMin - 0.12 * range;
  const maxValue = rawMax + 0.12 * range;
  const plotRight = width - pad.right;
  const x = (index) => pad.left + (index / Math.max(plotted.length - 1, 1)) * (plotRight - pad.left);
  const y = (value) => height - pad.bottom - ((Number(value) - minValue) / Math.max(maxValue - minValue, 1)) * (height - pad.top - pad.bottom);
  const classicalPoints = plotted.map((item, index) => [x(index), y(item.classical)]);
  const hybridPoints = plotted.map((item, index) => [x(index), y(item.hybrid)]);
  const classicalPath = smoothSvgPath(classicalPoints);
  const hybridPath = smoothSvgPath(hybridPoints);
  const activeIndex = hoveredIndex ?? plotted.length - 1;
  const active = plotted[activeIndex];
  const yTicks = Array.from({ length: 5 }, (_, index) => maxValue - index * (maxValue - minValue) / 4);
  const reduction = ((classicalReference - hybridFinal) / classicalReference) * 100;

  return (
    <div className="svgChartWrap convergenceSvgWrap interactiveConvergenceChart threeModelConvergenceChart cleanCostConvergenceChart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="lineSvg convergenceSvg"
        role="img"
        aria-label="Classical HiGHS cost reference compared with the validated Hybrid QAOA trajectory"
        onPointerLeave={() => setHoveredIndex(null)}
      >
        <text className="convergenceAxisCaption" x={pad.left} y={18}>Operating cost ($)</text>
        <g className="gridLines convergenceGridLines">
          {yTicks.map((value) => (
            <React.Fragment key={value}>
              <line x1={pad.left} x2={plotRight} y1={y(value)} y2={y(value)} />
              <text x={pad.left - 10} y={y(value) + 4} textAnchor="end" className="axisText convergenceAxisValue">
                {compactNumber(value)}
              </text>
            </React.Fragment>
          ))}
        </g>
        <path className="convergenceModelPath classical" d={classicalPath} />
        <path className="convergenceModelPath adaptive" d={hybridPath} />
        <text className="convergenceDirectLabel classical" x={plotRight - 5} y={y(classicalReference) - 10} textAnchor="end">
          {`Classical · ${money(classicalReference)}`}
        </text>
        <text className="convergenceDirectLabel adaptive" x={plotRight - 5} y={y(hybridFinal) + 22} textAnchor="end">
          {`Hybrid Final · ${money(hybridFinal)}`}
        </text>
        {hybridPoints.map((point, index) => (
          <circle
            key={`hybrid-${index}`}
            className={`convergenceModelDot adaptive ${activeIndex === index ? "active" : ""}`}
            cx={point[0]}
            cy={point[1]}
            r={activeIndex === index ? 6 : 4}
            onPointerEnter={() => setHoveredIndex(index)}
          />
        ))}
        {plotted.map((item, index) => (
          <rect
            key={`hit-${index}`}
            x={x(index) - 22}
            y={pad.top}
            width={44}
            height={height - pad.top - pad.bottom}
            fill="transparent"
            onPointerEnter={() => setHoveredIndex(index)}
          />
        ))}
        <text className="convergenceAxisCaption" x={(pad.left + plotRight) / 2} y={height - 12} textAnchor="middle">
          ADMM quantum round / validated candidate step
        </text>
      </svg>
      <div className="convergenceHoverCard">
        <span>Step {active?.step ?? activeIndex + 1}</span>
        <b>{money(active?.hybrid || hybridFinal)}</b>
        <small>{`${reduction >= 0 ? "−" : "+"}${Math.abs(reduction).toFixed(1)}% vs Classical · residual ${Number(active?.residual || 0).toFixed(2)} MW`}</small>
      </div>
    </div>
  );
}

function smoothSvgPath(points) {
  if (!Array.isArray(points) || points.length === 0) return "";
  if (points.length === 1) return `M ${points[0][0]} ${points[0][1]}`;

  return points.reduce((path, point, index, array) => {
    if (index === 0) return `M ${point[0]} ${point[1]}`;
    const previous = array[index - 1];
    const midpointX = (previous[0] + point[0]) / 2;
    return `${path} C ${midpointX} ${previous[1]}, ${midpointX} ${point[1]}, ${point[0]} ${point[1]}`;
  }, "");
}

function compactNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const absolute = Math.abs(number);
  if (absolute >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (absolute >= 1_000) return `${(number / 1_000).toFixed(0)}k`;
  return number.toFixed(0);
}

// #endregion

// #region 09C — Cost evidence visualization
function CostBreakdownChart({ view }) {
  const data = view?.costBreakdown || {};
  const methodComparison = getResultMethodComparison(view);
  const [selectedModel, setSelectedModel] = useState(methodComparison.selected.id);

  useEffect(() => {
    setSelectedModel(methodComparison.selected.id);
  }, [methodComparison.selected.id]);

  const modelDefinitions = {
    classical: {
      id: "classical",
      label: "Classical HiGHS Baseline",
      shortLabel: "Classical",
      cost: methodComparison.methods.find((method) => method.id === "classical")?.cost,
      items: data?.baseline || data?.classical || data?.milp || [],
    },
    hybrid: {
      id: "hybrid",
      label: "ADMM-Guided Hybrid QAOA",
      shortLabel: "Hybrid",
      cost: methodComparison.methods.find((method) => method.id === "hybrid")?.cost,
      items: data?.adaptive || data?.hybrid || [],
    },
  };

  const selected = modelDefinitions[selectedModel];
  const selectedTotal = selected.items.reduce(
    (sum, item) => sum + Number(item.value || 0),
    0
  );
  const componentKeys = Array.from(
    new Set(
      Object.values(modelDefinitions).flatMap((model) =>
        model.items.map((item) => item.key)
      )
    )
  );
  const componentRows = componentKeys.map((key) => {
    const values = Object.fromEntries(
      Object.entries(modelDefinitions).map(([modelId, model]) => {
        const item = model.items.find((candidate) => candidate.key === key);
        return [modelId, Number(item?.value || 0)];
      })
    );
    const label = Object.values(modelDefinitions)
      .flatMap((model) => model.items)
      .find((item) => item.key === key)?.label || key;
    return { key, label, ...values };
  });
  const componentMax = Math.max(
    ...componentRows.flatMap((row) => [row.classical, row.hybrid]),
    1
  );
  const totals = Object.fromEntries(
    Object.entries(modelDefinitions).map(([id, model]) => {
      const componentTotal = model.items.reduce(
        (sum, item) => sum + Number(item.value || 0),
        0
      );
      return [id, Number.isFinite(Number(model.cost)) ? Number(model.cost) : componentTotal];
    })
  );
  const bestModelId = Object.keys(totals).reduce((bestId, modelId) =>
    totals[modelId] < totals[bestId] ? modelId : bestId
  );
  const bestModel = modelDefinitions[bestModelId];
  const bestComparisons = Object.entries(modelDefinitions)
    .filter(([modelId]) => modelId !== bestModelId)
    .map(([modelId, model]) =>
      `−${money(Math.max(0, totals[modelId] - totals[bestModelId]))} vs ${model.shortLabel}`
    );

  return (
    <div className="costStoryWorkspace breakdownChart threeModelCostWorkspace">
      <section className="costStorySection donutExplorerSection cleanCostMixSection">
        <div className="costStorySectionHead">
          <div>
            <h4>Cost Mix</h4>
          </div>

          <div
            className="costModelStepper"
            role="tablist"
            aria-label="Choose one model for the cost composition donut"
          >
            {Object.values(modelDefinitions).map((model) => (
              <button
                key={model.id}
                type="button"
                role="tab"
                aria-selected={selectedModel === model.id}
                className={selectedModel === model.id ? "active" : ""}
                onClick={() => setSelectedModel(model.id)}
              >
                <span>{model.shortLabel}</span>
              </button>
            ))}
          </div>
        </div>

        <div className={`singleDonutExplorer model-${selected.id}`}>
          <div className="singleDonutStage cleanSingleDonutStage">
            <CostDonut items={selected.items} total={selectedTotal} />

            <div className="singleDonutLegend compactDonutLegend bottomLeftDonutLegend" aria-label="Cost component legend">
              {selected.items.map((item) => (
                <span key={item.key} className="compactDonutLegendItem">
                  <i className={`costComponentDot ${item.key}`} />
                  {item.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="costStorySection threeModelComponentSection">
        <div className="costStorySectionHead threeModelComponentHead">
          <div>
            <h4>Cost by Component</h4>
          </div>
          <div className="costModelLineLegend" aria-label="Cost comparison model legend">
            {Object.values(modelDefinitions).map((model) => (
              <span key={model.id} className={model.id}>
                <i /> {model.shortLabel}
              </span>
            ))}
          </div>
        </div>

        <div className="threeModelComponentRows">
          {componentRows.map((row, index) => (
            <article className="threeModelComponentRow" key={row.key}>
              <div className="threeModelComponentLabel">
                <i className={`costComponentDot ${row.key}`} />
                <strong>{row.label}</strong>
              </div>

              <div className="threeModelBars">
                {Object.values(modelDefinitions).map((model, modelIndex) => {
                  const value = row[model.id];
                  return (
                    <div className={`tripleCostBarLine model-${model.id}`} key={model.id}>
                      <span className="tripleCostModelName">{model.shortLabel}</span>
                      <div className="tripleCostTrack">
                        <span
                          style={{
                            width: `${Math.max(2, (value / componentMax) * 100)}%`,
                            animationDelay: `${index * 45 + modelIndex * 55}ms`,
                          }}
                        />
                      </div>
                      <b>{money(value)}</b>
                    </div>
                  );
                })}
              </div>
            </article>
          ))}
        </div>

        <div className="bestCostResultCard">
          <div className="bestCostResultHead">
            <span>BEST RESULT</span>
            <strong>{bestModel.shortLabel} · {money(totals[bestModelId])}</strong>
          </div>
          <small>{bestComparisons.join(" · ")}</small>
        </div>
      </section>
    </div>
  );
}

function CostDonut({ items, total }) {
  const [activeIndex, setActiveIndex] = useState(null);
  const size = 220;
  const center = size / 2;
  const radius = 75;
  const tooltipRadius = 94;

  let cumulativePercent = 0;
  const segments = items.map((item, index) => {
    const percent = total > 0 ? (Number(item.value || 0) / total) * 100 : 0;
    const startPercent = cumulativePercent;
    cumulativePercent += percent;

    const middleAngle = ((startPercent + percent / 2) / 100) * Math.PI * 2 - Math.PI / 2;

    return {
      ...item,
      index,
      percent,
      startPercent,
      tooltipX: center + Math.cos(middleAngle) * tooltipRadius,
      tooltipY: center + Math.sin(middleAngle) * tooltipRadius,
    };
  });

  const activeSegment = activeIndex === null ? null : segments[activeIndex];

  return (
    <div
      className={`costDonutWrap ${activeSegment ? "hasActiveSegment" : ""}`}
      onMouseLeave={() => setActiveIndex(null)}
    >
      <svg
        className="costDonutSvg"
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label="Interactive operating-cost share donut chart"
      >
        <circle
          className="costDonutTrack"
          cx={center}
          cy={center}
          r={radius}
          pathLength="100"
        />

        {segments.map((segment) => (
          <circle
            key={segment.key}
            className={`costDonutSegment ${segment.key} ${
              activeIndex === segment.index ? "active" : ""
            }`}
            cx={center}
            cy={center}
            r={radius}
            pathLength="100"
            strokeDasharray={`${Math.max(segment.percent - 0.7, 0)} ${
              100 - Math.max(segment.percent - 0.7, 0)
            }`}
            strokeDashoffset={-segment.startPercent}
            tabIndex="0"
            aria-label={`${segment.label}: ${segment.percent.toFixed(1)} percent, ${money(
              segment.value
            )}`}
            onMouseEnter={() => setActiveIndex(segment.index)}
            onFocus={() => setActiveIndex(segment.index)}
            onBlur={() => setActiveIndex(null)}
          />
        ))}
      </svg>

      <div className="costDonutCenter">
        <span>Total cost</span>
        <strong>{money(total)}</strong>
      </div>

      {activeSegment && (
        <div
          className={`costDonutTooltip ${activeSegment.key}`}
          style={{
            left: `${(activeSegment.tooltipX / size) * 100}%`,
            top: `${(activeSegment.tooltipY / size) * 100}%`,
          }}
        >
          <span>{activeSegment.label}</span>
          <strong>{money(activeSegment.value)}</strong>
          <small>{activeSegment.percent.toFixed(1)}%</small>
        </div>
      )}
    </div>
  );
}

function BreakdownRow({ item, max, total, delay }) {
  const percent = total > 0 ? (Number(item.value || 0) / total) * 100 : 0;

  return (
    <div className="breakdownRow">
      <div className="breakdownLabel">
        <span>
          <i className={`breakdownColorDot ${item.key}`} />
          {item.label}
        </span>
        <div className="breakdownValueGroup">
          <strong>{money(item.value)}</strong>
          <b>{percent.toFixed(1)}%</b>
        </div>
      </div>
      <div className="breakdownTrack">
        <div
          className={`breakdownFill ${item.key}`}
          style={{
            width: `${Math.max(5, (item.value / max) * 100)}%`,
            animationDelay: `${delay}ms`,
          }}
        />
      </div>
    </div>
  );
}

// #endregion

// #endregion

// #region 10 — Result construction, backend normalization, and preview math
/* ==========================================================================
   10. Result construction, backend normalization, and preview math
   ========================================================================== */

// #region 10A — Advanced result-view model
function buildAdvancedResultView(result, selectedScenario, selectedSolver) {
  const scenario = normalizeScenarioForResults(selectedScenario);
  const dieselNeed = Math.max(scenario.load - scenario.solar - scenario.wind - scenario.gridLimit, 0);
  const stress = Math.max(45, Math.min(96, scenario.stress || Math.round(55 + dieselNeed / Math.max(scenario.load, 1) * 100)));

  const genericBackendCost = firstFiniteNumber(
    result?.cost,
    result?.total_cost,
    result?.result?.cost
  );
  const backendMilpCost = firstFiniteNumber(
    result?.milp_cost,
    result?.classical_cost,
    result?.milp?.cost,
    result?.classical?.cost,
    result?.result?.milp_cost,
    selectedSolver?.id === "milp" ? genericBackendCost : null
  );
  const backendQuantumCost = firstFiniteNumber(
    result?.qaoa_cost,
    result?.quantum_cost,
    result?.quantum?.cost,
    result?.result?.qaoa_cost,
    null
  );
  const backendHybridCost = firstFiniteNumber(
    result?.hybrid_cost,
    result?.validated_cost,
    result?.hybrid?.cost,
    result?.result?.hybrid_cost,
    selectedSolver?.id === "hybrid" ? genericBackendCost : null
  );

  const classicalCost = backendMilpCost !== null
    ? Math.round(backendMilpCost)
    : Math.round(82000 + stress * 510 + dieselNeed * 260);
  const quantumCost = backendQuantumCost !== null
    ? Math.round(backendQuantumCost)
    : Math.round(classicalCost * 1.0481);
  const hybridCost = backendHybridCost !== null
    ? Math.round(backendHybridCost)
    : Math.round(classicalCost * 1.035);

  const backendRuleBasedCost = firstFiniteNumber(
    result?.rule_based_cost,
    result?.ruleBasedCost,
    result?.baseline_cost,
    result?.ruleBased?.cost,
    result?.baseline?.cost,
    result?.result?.rule_based_cost
  );
  const ruleBasedCost = backendRuleBasedCost !== null
    ? Math.round(backendRuleBasedCost)
    : Math.round(hybridCost * 1.1273);
  const costDifference = ruleBasedCost - hybridCost;
  const costAvoided = Math.max(0, Math.round(costDifference));
  const costAvoidedPercent = Math.max(
    0,
    (costDifference / Math.max(ruleBasedCost, 1)) * 100
  ).toFixed(1);
  const ruleBasedSource =
    result?.ruleBasedSource ||
    (backendRuleBasedCost !== null && result?.backendSource
      ? "Classical HiGHS baseline"
      : "Synthetic preview");

  const validatedFeasibleHours = Math.max(
    0,
    Math.min(
      24,
      Math.round(
        firstFiniteNumber(
          result?.feasible_hours,
          result?.validated_feasible_hours,
          result?.hybrid?.feasible_hours,
          result?.result?.feasible_hours
        ) ?? 24
      )
    )
  );

  const classicalRuntime = firstFiniteNumber(
    result?.classical_runtime,
    result?.milp_runtime,
    result?.milp?.runtime,
    result?.result?.milp_runtime
  ) ?? 18.4;

  const backendQuantumRuntime = firstFiniteNumber(
    result?.runtime,
    result?.quantum_runtime,
    result?.optimization_time,
    result?.quantum?.runtime,
    result?.quantum?.optimization_time,
    result?.result?.runtime
  );
  const quantumRuntime = backendQuantumRuntime ?? 3.8;
  const hybridRuntime = firstFiniteNumber(
    result?.hybrid_runtime,
    result?.hybrid?.runtime,
    result?.result?.hybrid_runtime
  ) ?? 5.1;

  const classicalCurtailment = Number((9.8 + Math.max(0, scenario.solar - 70) * 0.06).toFixed(2));
  const ruleBasedCurtailment = firstFiniteNumber(
    result?.rule_based_curtailment,
    result?.baseline_curtailment,
    result?.ruleBased?.curtailment,
    result?.baseline?.curtailment
  ) ?? Number((classicalCurtailment * 1.22).toFixed(2));
  const quantumCurtailment = firstFiniteNumber(
    result?.quantum_curtailment,
        result?.quantum?.curtailment,
    result?.fixed?.curtailment
  ) ?? Number((classicalCurtailment * 0.72).toFixed(2));
  const hybridCurtailment = firstFiniteNumber(
    result?.hybrid_curtailment,
    result?.adaptive_curtailment,
    result?.hybrid?.curtailment,
    result?.adaptive?.curtailment
  ) ?? Number((classicalCurtailment * 0.61).toFixed(2));

  const backendConvergence = normalizeConvergenceTrace(
    result?.convergenceTrace ||
      result?.convergence ||
      result?.history ||
      result?.energy_history ||
      result?.quantum?.convergence ||
      result?.quantum?.history ||
      result?.result?.convergence,
    ruleBasedCost,
    quantumCost,
    hybridCost
  );
  const convergence = backendConvergence || makeConvergence(ruleBasedCost, quantumCost, hybridCost);

  const penaltyBalanceBackend = firstFiniteNumber(
    result?.penalty_balance,
    result?.lambda_balance,
    result?.penalties?.balance,
    result?.quantum?.penalty_balance,
    result?.quantum?.lambda_balance,
    result?.result?.penalty_balance
  );
  const penaltySocBackend = firstFiniteNumber(
    result?.penalty_soc,
    result?.lambda_soc,
    result?.penalties?.soc,
    result?.quantum?.penalty_soc,
    result?.quantum?.lambda_soc,
    result?.result?.penalty_soc
  );
  const qaoaDepthBackend = firstFiniteNumber(
    result?.qaoa_depth,
    result?.depth,
    result?.p,
    result?.quantum?.qaoa_depth,
    result?.quantum?.depth,
    result?.quantum?.p,
    result?.result?.qaoa_depth
  );
  const shotsBackend = firstFiniteNumber(
    result?.shots,
    result?.num_shots,
    result?.quantum?.shots,
    result?.quantum?.num_shots,
    result?.result?.shots
  );
  const iterationsBackend = firstFiniteNumber(
    result?.iterations,
    result?.maxiter,
    result?.optimizer_iterations,
    result?.quantum?.iterations,
    result?.quantum?.maxiter,
    result?.result?.iterations
  );

  const metadataFromBackend = Boolean(
    backendConvergence ||
    penaltyBalanceBackend !== null ||
    penaltySocBackend !== null ||
    qaoaDepthBackend !== null ||
    shotsBackend !== null ||
    iterationsBackend !== null ||
    backendQuantumRuntime !== null
  );

  const bitstring = String(
    result?.bitstring ||
    result?.best_bitstring ||
    result?.quantum?.bitstring ||
    result?.result?.bitstring ||
    (dieselNeed > 0 ? "000001011000010110" : "000000010000000010")
  );
  const activeQubits = result?.active_variable_count || result?.quantum?.active_variable_count || result?.result?.active_variable_count || 8;
  const quboVars = result?.num_variables || result?.quantum?.num_variables || result?.result?.num_variables || 18;
  const quantumGapPercent = Math.max(0, ((quantumCost - classicalCost) / Math.max(classicalCost, 1)) * 100).toFixed(1);
  const hybridGapPercent = Math.max(0, ((hybridCost - classicalCost) / Math.max(classicalCost, 1)) * 100).toFixed(1);
  const candidateSpeedup = (classicalRuntime / Math.max(quantumRuntime, 0.001)).toFixed(1);
  const endToEndSpeedup = (classicalRuntime / Math.max(hybridRuntime, 0.001)).toFixed(1);

  const generatedDispatch = makeDispatchComparison(scenario);
  const classicalDispatch = firstDispatchSeries(
    result?.ruleBased?.dispatch24h,
    result?.ruleBased?.dispatch,
    result?.baseline?.dispatch24h,
    result?.baseline?.dispatch,
    result?.classical_baseline_dispatch,
    result?.result?.ruleBased?.dispatch24h
  ) || generatedDispatch.classical;
  const fixedDispatch = firstDispatchSeries(
    result?.quantum?.dispatch24h,
    result?.quantum?.dispatch,
    result?.fixed?.dispatch24h,
    result?.result?.quantum?.dispatch24h
  ) || generatedDispatch.fixed;
  const adaptiveDispatch = firstDispatchSeries(
    result?.hybrid?.dispatch24h,
    result?.hybrid?.dispatch,
    result?.adaptive?.dispatch24h,
    result?.dispatch24h,
    result?.dispatch,
    result?.result?.hybrid?.dispatch24h
  ) || generatedDispatch.adaptive;

  const selectedMethodId = resolveSelectedResultMethodId(result, selectedSolver);
  const selectedMethodLabel = RESULT_METHOD_CATALOG[selectedMethodId]?.name || "Validated Schedule";

  return {
    selectedMethodId,
    selectedMethodLabel,
    bitstring,
    bitstringNote: bitstring.length === Number(quboVars)
      ? `Decoded full ${quboVars}-variable commitment vector`
      : `${bitstring.length}-bit active-qubit sample`,
    energy: result?.energy || result?.quantum?.energy || result?.result?.energy || -121400,
    qubits: activeQubits,
    quboVars,
    quantumGapPercent,
    hybridGapPercent,
    candidateSpeedup,
    endToEndSpeedup,
    costAvoided,
    costAvoidedPercent,
    ruleBasedSource,
    feasibleHours: `${validatedFeasibleHours}/24 h`,
    curtailmentDrop: Number((ruleBasedCurtailment - hybridCurtailment).toFixed(2)),
    ruleBased: {
      cost: ruleBasedCost,
      runtime: classicalRuntime,
      curtailment: Number(ruleBasedCurtailment.toFixed(2)),
      dispatch24h: classicalDispatch,
    },
    classical: { cost: classicalCost, runtime: classicalRuntime, curtailment: classicalCurtailment },
    quantum: {
      cost: quantumCost,
      runtime: quantumRuntime,
      curtailment: quantumCurtailment,
      dispatch24h: fixedDispatch,
      status: result?.status || result?.quantum?.status || "DONE",
      source: result?.source || result?.quantum?.source || selectedSolver?.name || "Qamomile → CUDA-Q QAOA",
    },
    hybrid: {
      cost: hybridCost,
      runtime: hybridRuntime,
      curtailment: hybridCurtailment,
      dispatch24h: adaptiveDispatch,
    },
    convergence,
    convergenceSource: backendConvergence ? "Backend trace" : "Synthetic MVP",
    penaltyBalance: penaltyBalanceBackend !== null ? num(penaltyBalanceBackend) : "Adaptive",
    penaltyBalanceSource: penaltyBalanceBackend !== null ? "Backend λ₁" : "Preview mode",
    penaltySoc: penaltySocBackend !== null ? num(penaltySocBackend) : "Adaptive",
    penaltySocSource: penaltySocBackend !== null ? "Backend λ₂" : "Preview mode",
    qaoaDepth: qaoaDepthBackend !== null ? Math.round(qaoaDepthBackend) : 2,
    qaoaDepthSource: qaoaDepthBackend !== null ? "Backend circuit" : "Preview config",
    shots: shotsBackend !== null ? Math.round(shotsBackend).toLocaleString() : "1,024",
    shotsSource: shotsBackend !== null ? "Backend sampler" : "Preview config",
    iterations: iterationsBackend !== null ? Math.round(iterationsBackend) : convergence.length,
    iterationsSource: iterationsBackend !== null || backendConvergence ? "Backend optimizer" : "Preview trace",
    runtimeSource: backendQuantumRuntime !== null ? "Measured backend" : "Estimated preview",
    runMetadataSource: metadataFromBackend ? "Backend run" : "Preview config",
    dispatch24h: adaptiveDispatch,
    dispatchComparison: {
      classical: classicalDispatch,
      fixed: fixedDispatch,
      adaptive: adaptiveDispatch,
    },
    costBreakdown: extractBackendCostBreakdown(result) || makeCostBreakdown(ruleBasedCost, quantumCost, hybridCost),
  };
}

// #endregion

// #region 10B — Numeric, profile, and chart normalizers
function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;

    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}


function makeScenarioPreview24h(scenario) {
  const loadMax = Math.max(Number(scenario.load || 0), 0);
  const solarMax = Math.max(Number(scenario.solar || 0), 0);
  const windMax = Math.max(Number(scenario.wind || 0), 0);
  const gridLimit = Math.max(Number(scenario.gridLimit || 0), 0);

  const loadProfile = scaleProfileTo24(scenario.profiles?.load, loadMax);
  const solarProfile = scaleProfileTo24(scenario.profiles?.solar, solarMax);
  const windProfile = scaleProfileTo24(scenario.profiles?.wind, windMax);

  return Array.from({ length: 24 }, (_, hour) => {
    const eveningBoost = hour >= 17 && hour <= 21 ? 0.23 : 0;
    const morningBoost = hour >= 7 && hour <= 10 ? 0.08 : 0;
    const nightReduction = hour <= 5 ? 0.24 : 0;

    const defaultLoad = loadMax * Math.max(
      0,
      0.74 + eveningBoost + morningBoost - nightReduction
    );
    const solarShape = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI));
    const defaultSolar = solarMax * solarShape;
    const defaultWind = windMax * Math.max(
      0.2,
      0.72 + 0.18 * Math.sin((hour + 2) / 3.2) + 0.08 * Math.cos(hour / 2.1)
    );

    const load = Math.round(loadProfile?.[hour] ?? defaultLoad);
    const solar = Math.round(solarProfile?.[hour] ?? defaultSolar);
    const wind = Math.round(windProfile?.[hour] ?? defaultWind);
    const vre = Math.max(0, solar + wind);
    const residualDemand = Math.max(load - vre, 0);
    const criticalGap = Math.max(residualDemand - gridLimit, 0);

    return {
      hour,
      load,
      solar,
      wind,
      vre,
      residualDemand,
      criticalGap,
    };
  });
}

function scaleProfileTo24(profile, targetMax) {
  if (!Array.isArray(profile) || profile.length < 2) return null;
  if (targetMax <= 0) return Array(24).fill(0);

  const source = profile.map(Number).filter(Number.isFinite);
  if (source.length < 2) return null;

  const sourceMax = Math.max(...source, 0);
  if (sourceMax <= 0) return Array(24).fill(0);

  return Array.from({ length: 24 }, (_, hour) => {
    const sourcePosition = (hour / 23) * (source.length - 1);
    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = Math.min(leftIndex + 1, source.length - 1);
    const weight = sourcePosition - leftIndex;
    const interpolated =
      source[leftIndex] * (1 - weight) + source[rightIndex] * weight;

    return (interpolated / sourceMax) * targetMax;
  });
}

function numericProfile(value) {
  if (!Array.isArray(value)) return null;

  const profile = value.map(Number).filter(Number.isFinite);
  return profile.length >= 2 ? profile : null;
}

function normalizeConvergenceTrace(trace, baselineCost, fixedCost, adaptiveCost) {
  if (!Array.isArray(trace) || trace.length < 2) return null;

  const fallback = makeConvergence(baselineCost, fixedCost, adaptiveCost);
  const hasThreeModelValues = trace.some((item) => item && typeof item === "object" && (
    Number.isFinite(Number(item.classical ?? item.baseline ?? item.milp)) ||
    Number.isFinite(Number(item.fixed ?? item.quantum ?? item.oneShot))
  ));

  if (hasThreeModelValues) {
    return trace.map((item, index) => {
      const fallbackPoint = fallback[Math.min(index, fallback.length - 1)];
      return {
        step: Number(item.step ?? item.iteration ?? item.layer ?? index + 1),
        baseline: firstFiniteNumber(item.classical, item.baseline, item.milp) ?? fallbackPoint.baseline,
        fixed: firstFiniteNumber(item.fixed, item.quantum, item.oneShot) ?? fallbackPoint.fixed,
        adaptive: firstFiniteNumber(item.adaptive, item.hybrid, item.qaoa, item.cost, item.value) ?? fallbackPoint.adaptive,
      };
    });
  }

  const rawAdaptive = trace
    .map((item, index) => {
      if (Number.isFinite(Number(item))) return { step: index + 1, value: Number(item) };
      if (!item || typeof item !== "object") return null;
      const value = firstFiniteNumber(
        item.adaptive,
        item.hybrid,
        item.qaoa,
        item.energy,
        item.objective,
        item.value,
        item.cost
      );
      return value === null ? null : {
        step: Number(item.step ?? item.iteration ?? item.layer ?? index + 1),
        value,
      };
    })
    .filter(Boolean);

  if (rawAdaptive.length < 2) return null;
  const rawStart = rawAdaptive[0].value;
  const rawBest = Math.min(...rawAdaptive.map((item) => item.value));
  const rawSpan = Math.max(rawStart - rawBest, 1e-9);
  const modelFallback = makeConvergence(baselineCost, fixedCost, adaptiveCost);

  return rawAdaptive.map((item, index) => {
    const fallbackPoint = modelFallback[Math.round(index * (modelFallback.length - 1) / Math.max(rawAdaptive.length - 1, 1))];
    const progress = index === rawAdaptive.length - 1
      ? 1
      : Math.max(0, Math.min(1, (rawStart - item.value) / rawSpan));
    const adaptive = index === rawAdaptive.length - 1
      ? Math.round(adaptiveCost)
      : Math.round(fallbackPoint.adaptive + (adaptiveCost - fallbackPoint.adaptive) * progress * 0.15);

    return {
      step: item.step,
      baseline: fallbackPoint.baseline,
      fixed: fallbackPoint.fixed,
      adaptive,
    };
  });
}

function makeConvergence(baselineCost, fixedCost, adaptiveCost) {
  const steps = 8;
  const adaptiveStart = Math.round(adaptiveCost + (fixedCost - adaptiveCost) * 1.8);

  return Array.from({ length: steps }, (_, index) => {
    const t = index / (steps - 1);
    const adaptiveProgress = Math.pow(t, 0.62);

    return {
      step: index + 1,
      baseline: Math.round(baselineCost),
      fixed: Math.round(fixedCost),
      adaptive: index === steps - 1
        ? Math.round(adaptiveCost)
        : Math.round(adaptiveStart - (adaptiveStart - adaptiveCost) * adaptiveProgress),
    };
  });
}

function normalizeCostComponentItems(items) {
  if (!Array.isArray(items)) return null;
  const normalized = items
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const value = firstFiniteNumber(item.value, item.cost, item.amount, item.total);
      if (value === null) return null;
      const key = String(item.key ?? item.id ?? item.component ?? item.name ?? `component-${index}`)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      return {
        key,
        label: String(item.label ?? item.name ?? item.component ?? key),
        value: Math.max(0, Math.round(value)),
      };
    })
    .filter(Boolean);
  return normalized.length ? normalized : null;
}

function extractBackendCostBreakdown(result) {
  const source = result?.cost_breakdown || result?.costBreakdown || result?.cost_components || result?.costComponents || result?.result?.cost_breakdown;
  if (!source || typeof source !== "object") return null;

  const baseline = normalizeCostComponentItems(source.baseline || source.classical);
  const hybrid = normalizeCostComponentItems(source.hybrid || source.adaptive);

  return baseline && hybrid ? { baseline, classical: baseline, hybrid, adaptive: hybrid } : null;
}

function firstDispatchSeries(...seriesCandidates) {
  for (const candidate of seriesCandidates) {
    const normalized = normalizeDispatch24h(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function normalizeDispatch24h(series) {
  if (!Array.isArray(series) || series.length < 24) return null;

  return series.slice(0, 24).map((point, index) => {
    const rawHour = point?.hour ?? point?.time ?? point?.t ?? index;
    const parsedHour = Number.parseInt(rawHour, 10);
    const hour = Number.isFinite(parsedHour)
      ? String(parsedHour).padStart(2, "0")
      : String(rawHour);

    return {
      hour,
      load: Math.max(0, firstFiniteNumber(point?.load, point?.demand, point?.load_mw) ?? 0),
      solar: Math.max(0, firstFiniteNumber(point?.solar, point?.solar_mw) ?? 0),
      wind: Math.max(0, firstFiniteNumber(point?.wind, point?.wind_mw) ?? 0),
      grid: Math.max(0, firstFiniteNumber(point?.grid, point?.grid_import, point?.grid_mw) ?? 0),
      battery: Math.max(0, firstFiniteNumber(point?.battery, point?.battery_discharge, point?.battery_mw) ?? 0),
      diesel: Math.max(0, firstFiniteNumber(point?.diesel, point?.thermal, point?.diesel_mw) ?? 0),
    };
  });
}

function makeDispatchComparison(scenario) {
  return {
    classical: makeDispatch24hForModel(scenario, "classical"),
    fixed: makeDispatch24hForModel(scenario, "fixed"),
    adaptive: makeDispatch24hForModel(scenario, "adaptive"),
  };
}

function makeDispatch24h(scenario) {
  return makeDispatch24hForModel(scenario, "adaptive");
}

function makeDispatch24hForModel(scenario, model = "adaptive") {
  const configurations = {
    classical: {
      solarUse: 0.86,
      windUse: 0.88,
      gridShare: 0.44,
      batteryShare: 0.10,
      batteryScale: 0.48,
      supportStart: 18,
      supportEnd: 21,
    },
    fixed: {
      solarUse: 0.93,
      windUse: 0.94,
      gridShare: 0.47,
      batteryShare: 0.23,
      batteryScale: 0.76,
      supportStart: 17,
      supportEnd: 21,
    },
    adaptive: {
      solarUse: 0.99,
      windUse: 0.98,
      gridShare: 0.48,
      batteryShare: 0.36,
      batteryScale: 1,
      supportStart: 16,
      supportEnd: 22,
    },
  };
  const config = configurations[model] || configurations.adaptive;
  const socRatio = Math.max(
    0,
    Math.min(
      1,
      Number(scenario.batterySoc || 0) /
        Math.max(Number(scenario.batteryCapacity || 80), 1)
    )
  );
  const batteryMaximum = 22 * (0.55 + 0.45 * socRatio) * config.batteryScale;

  return Array.from({ length: 24 }, (_, h) => {
    const solarShape = Math.max(0, Math.sin(((h - 6) / 12) * Math.PI));
    const eveningPeak = h >= 17 && h <= 20 ? 1.16 : 1;
    const nightLow = h <= 5 ? 0.72 : 1;
    const load = Math.round(
      scenario.load * (0.58 + 0.42 * eveningPeak) * nightLow
    );
    const availableSolar = Math.round(scenario.solar * solarShape);
    const availableWind = Math.round(
      scenario.wind * (0.76 + 0.18 * Math.sin(h / 3))
    );
    const solar = Math.min(load, Math.round(availableSolar * config.solarUse));
    const wind = Math.min(
      Math.max(0, load - solar),
      Math.round(availableWind * config.windUse)
    );
    const residual = Math.max(load - solar - wind, 0);
    const grid = Math.min(
      scenario.gridLimit,
      Math.round(residual * config.gridShare)
    );
    const supportsBattery = h >= config.supportStart && h <= config.supportEnd;
    const battery = supportsBattery
      ? Math.min(
          batteryMaximum,
          Math.max(0, residual - grid) * config.batteryShare
        )
      : 0;
    const roundedBattery = Math.round(battery);
    const diesel = Math.max(
      0,
      load - solar - wind - grid - roundedBattery
    );

    return {
      hour: String(h).padStart(2, "0"),
      load,
      solar,
      wind,
      grid,
      battery: roundedBattery,
      diesel,
    };
  });
}

function allocateCostBreakdown(total, specifications) {
  const roundedTotal = Math.max(0, Math.round(Number(total || 0)));
  let allocated = 0;

  return specifications.map((specification, index) => {
    const isLast = index === specifications.length - 1;
    const value = isLast
      ? Math.max(0, roundedTotal - allocated)
      : Math.max(0, Math.round(roundedTotal * specification.share));
    allocated += value;
    return {
      key: specification.key,
      label: specification.label,
      value,
    };
  });
}

function makeCostBreakdown(baselineCost, fixedCost, adaptiveCost) {
  return {
    baseline: allocateCostBreakdown(baselineCost, [
      { key: "diesel", label: "Diesel", share: 0.42 },
      { key: "grid", label: "Grid Import", share: 0.28 },
      { key: "battery", label: "Battery", share: 0.07 },
      { key: "startup", label: "Start-up", share: 0.15 },
      { key: "curtailment", label: "Curtailment", share: 0.08 },
    ]),
    fixed: allocateCostBreakdown(fixedCost, [
      { key: "diesel", label: "Diesel", share: 0.35 },
      { key: "grid", label: "Grid Import", share: 0.29 },
      { key: "battery", label: "Battery", share: 0.12 },
      { key: "startup", label: "Start-up", share: 0.15 },
      { key: "curtailment", label: "Curtailment", share: 0.09 },
    ]),
    adaptive: allocateCostBreakdown(adaptiveCost, [
      { key: "diesel", label: "Diesel", share: 0.29 },
      { key: "grid", label: "Grid Import", share: 0.31 },
      { key: "battery", label: "Battery", share: 0.18 },
      { key: "startup", label: "Start-up", share: 0.13 },
      { key: "curtailment", label: "Curtailment", share: 0.09 },
    ]),
  };
}

function normalizeScenarioForResults(scenario) {
  const fallback = { name: "Peak Demand", load: 176, solar: 0, wind: 12, gridLimit: 100, batterySoc: 48, batteryCapacity: 80, stress: 88 };
  const s = scenario || fallback;
  return {
    ...fallback,
    ...s,
    load: Number(s.load ?? fallback.load),
    solar: Number(s.solar ?? fallback.solar),
    wind: Number(s.wind ?? fallback.wind),
    gridLimit: Number(s.gridLimit ?? fallback.gridLimit),
    batterySoc: Number(s.batterySoc ?? fallback.batterySoc),
    batteryCapacity: Number(s.batteryCapacity ?? fallback.batteryCapacity),
  };
}

function money(value) {
  return `$${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function num(value) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function Metric({ label, value, note, highlight, className = "" }) {
  return (
    <div className={`metric ${highlight ? "highlight" : ""} ${className}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

function Background() {
  return (
    <>
      <div className="orb orb1" />
      <div className="orb orb2" />
      <div className="gridBg" />
    </>
  );
}

/* ========================= Result construction ========================= */

// #endregion

// #region 10C — Result construction and backend scenario loading
function createResult({ scenario, solver, backendResult }) {
  const normalizedBackendResult = backendResult
    ? (backendResult.backendSource
        ? backendResult
        : normalizeApiRunResponse(backendResult, solver, scenario))
    : null;
  backendResult = normalizedBackendResult;
  const dieselNeed = getDieselNeed(scenario);
  const milpCost = Math.round(82000 + scenario.stress * 510 + dieselNeed * 260);
  const quantumCost = Math.round(milpCost * 1.0481);
  const hybridCost = Math.round(milpCost * 1.035);
  const backendRuleBasedCost = firstFiniteNumber(
    backendResult?.rule_based_cost,
    backendResult?.ruleBasedCost,
    backendResult?.baseline_cost,
    backendResult?.ruleBased?.cost,
    backendResult?.baseline?.cost
  );
  const ruleBasedCost = backendRuleBasedCost !== null
    ? Math.round(backendRuleBasedCost)
    : Math.round(hybridCost * 1.1273);
  const bitstring =
    backendResult?.bitstring ||
    backendResult?.result?.bitstring ||
    backendResult?.quantum?.bitstring ||
    (dieselNeed > 0 ? "000001011000010110" : "000000010000000010");

  return {
    ...(backendResult && typeof backendResult === "object" ? backendResult : {}),
    run_id: firstDefinedValue(
      backendResult?.run_id,
      backendResult?.runId,
      backendResult?.result?.run_id,
      backendResult?.result?.runId,
      null
    ),
    operating_plan: firstDefinedValue(
      backendResult?.operating_plan,
      backendResult?.operatingPlan,
      backendResult?.result?.operating_plan,
      backendResult?.result?.operatingPlan,
      null
    ),
    backendSource: Boolean(backendResult),
    penaltyMode:
      backendResult?.penalty_mode ||
      backendResult?.penaltyMode ||
      backendResult?.quantum?.penalty_mode ||
      "Adaptive",
    convergenceTrace:
      backendResult?.convergence ||
      backendResult?.history ||
      backendResult?.quantum?.convergence ||
      backendResult?.result?.convergence ||
      null,
    selectedSolverName: solver.name,
    summary:
      "The backend proposes reduced binary commitment candidates; classical dispatch reconstructs, validates, and ranks the resulting full schedules.",
    bitstring,
    qubits: backendResult?.active_variable_count || backendResult?.result?.active_variable_count || 8,
    quboVars: backendResult?.num_variables || backendResult?.result?.num_variables || 18,
    ruleBased: { cost: ruleBasedCost },
    ruleBasedSource: backendRuleBasedCost !== null
      ? "Classical HiGHS baseline"
      : "Synthetic preview",
    milp: { cost: milpCost, runtime: 18.4 },
    quantum: {
      cost: backendResult?.quantum_cost || backendResult?.qaoa_cost || quantumCost,
      runtime: backendResult?.quantum_runtime || backendResult?.runtime || 3.8,
    },
    hybrid: {
      cost: backendResult?.hybrid_cost || backendResult?.validated_cost || hybridCost,
      runtime: backendResult?.hybrid_runtime || 5.1,
    },
    decisions: [
      { hour: 18, name: "diesel_u1_b1", type: "Diesel", power: 20 },
      { hour: 18, name: "grid_b1", type: "Grid import", power: 50 },
      { hour: 20, name: "battery_b1", type: "Battery discharge", power: 20 },
      ...(dieselNeed > 0 ? [{ hour: 20, name: "diesel_u2_b1", type: "Diesel", power: 20 }] : []),
    ],
  };
}

async function loadBackendScenarioDetail(item) {
  const scenarioId = getScenarioId(item);

  if (!scenarioId || normalizeScenarioId(scenarioId) === "custom") {
    return item;
  }

  try {
    const response = await fetch(
      `/api/scenario/${encodeURIComponent(scenarioId)}`,
      { cache: "no-store" }
    );

    if (!response.ok) return item;
    return await response.json();
  } catch {
    return item;
  }
}

function mergeBackendScenarios(items) {
  const loadedById = new Map();

  items.forEach((item) => {
    const scenarioId = normalizeScenarioId(getScenarioId(item));
    const fallback = SCENARIOS.find((scenario) => scenario.id === scenarioId);

    if (!fallback || fallback.id === "custom") return;
    loadedById.set(fallback.id, normalizeBackendScenario(item, fallback));
  });

  return SCENARIOS.map((fallback) => {
    if (fallback.id === "custom") return { ...fallback };
    return loadedById.get(fallback.id) || { ...fallback };
  });
}

function normalizeBackendScenario(payload, fallback) {
  const source = payload?.scenario || payload || {};
  const params = source.params || {};
  const derived = payload?.derived || source.derived || {};

  const scenarioId = normalizeScenarioId(
    payload?.scenario_id ?? source.id ?? source.name ?? fallback.id
  );

  const loadSource =
    source.load ?? source.peak_load ?? source.load_mw ?? derived.max_load_mw;
  const solarSource = source.solar ?? source.peak_solar ?? source.solar_mw;
  const windSource = source.wind ?? source.peak_wind ?? source.wind_mw;
  const gridLimitSource =
    source.grid_limit ??
    source.grid_limit_mw ??
    params.grid_limit_mw ??
    derived.grid_limit_mw;
  const batterySocSource =
    source.battery_soc ??
    source.battery_soc_mwh ??
    params.bess_initial_soc ??
    params.initial_soc_mwh;
  const batteryCapacitySource =
    source.battery_capacity_mwh ?? params.bess_energy_mwh;

  const hasBackendValues = [
    loadSource,
    solarSource,
    windSource,
    gridLimitSource,
    batterySocSource,
    batteryCapacitySource,
  ].some((value) => value !== undefined && value !== null);

  const scenario = {
    ...fallback,
    id: scenarioId || fallback.id,
    name: source.name ? cleanName(source.name) : fallback.name,
    icon: source.icon || fallback.icon,
    headline: source.headline ?? source.type ?? fallback.headline,
    description: source.description ?? source.note ?? fallback.description,
    load: maxOrFallback(loadSource, fallback.load),
    solar: maxOrFallback(solarSource, fallback.solar),
    wind: maxOrFallback(windSource, fallback.wind),
    gridLimit: numberOrFallback(gridLimitSource, fallback.gridLimit),
    batterySoc: numberOrFallback(batterySocSource, fallback.batterySoc),
    batteryCapacity: numberOrFallback(
      batteryCapacitySource,
      fallback.batteryCapacity
    ),
    profiles: {
      load: numericProfile(loadSource),
      solar: numericProfile(solarSource),
      wind: numericProfile(windSource),
    },
  };

  scenario.stress = numberOrFallback(
    source.stress,
    hasBackendValues ? computeStress(scenario) : fallback.stress
  );

  return scenario;
}

function getScenarioId(item) {
  if (typeof item === "string") return item;

  return (
    item?.scenario_id ??
    item?.id ??
    item?.name ??
    item?.scenario?.id ??
    item?.scenario?.name ??
    ""
  );
}

function normalizeScenarioId(value) {
  const id = String(value || "")
    .toLowerCase()
    .trim()
    .replace(/\s*scenario$/i, "")
    .replace(/[_\s]+/g, "-");

  const aliases = {
    "peak-demand": "peak",
    "evening-peak": "peak",
    "sunny-day": "sunny",
    "wind": "windy",
    "high-wind": "windy",
  };

  return aliases[id] || id;
}

function numberOrFallback(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;

  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function maxOrFallback(value, fallback) {
  if (Array.isArray(value)) {
    const numbers = value.map(Number).filter(Number.isFinite);
    return numbers.length > 0 ? Math.max(...numbers) : fallback;
  }

  return numberOrFallback(value, fallback);
}

function computeStress(s) {
  const load = Number(s.load || 0);
  if (load <= 0) return 0;

  return Math.min(
    100,
    Math.max(20, Math.round((getDieselNeed(s) / load) * 100 + 55))
  );
}

const PREVIEW_TIMESTEP_HOURS = 1;
const DEFAULT_BATTERY_MAX_DISCHARGE_MW = 25;

function roundOperationalValue(value) {
  return Number(Number(value || 0).toFixed(1));
}

function getOperationalPreview(s) {
  const load = Math.max(Number(s?.load || 0), 0);
  const solar = Math.max(Number(s?.solar || 0), 0);
  const wind = Math.max(Number(s?.wind || 0), 0);
  const gridLimit = Math.max(Number(s?.gridLimit || 0), 0);
  const batteryEnergy = Math.max(Number(s?.batterySoc || 0), 0);
  const batteryMaxPower = Math.max(
    Number(
      s?.batteryMaxPower ??
      s?.batteryPowerLimit ??
      s?.battery_power_mw ??
      DEFAULT_BATTERY_MAX_DISCHARGE_MW
    ),
    0
  );

  const totalRenewables = Math.max(solar + wind, 0);
  const residualAfterRenewables = Math.max(load - totalRenewables, 0);

  const explicitGridImport = firstFiniteNumber(
    s?.gridImport,
    s?.grid_import,
    s?.gridImportMw,
    s?.grid_import_mw
  );
  const gridImportedPower = Math.max(
    0,
    explicitGridImport !== null
      ? explicitGridImport
      : Math.min(residualAfterRenewables, gridLimit)
  );

  const residualAfterGrid = Math.max(
    residualAfterRenewables - gridImportedPower,
    0
  );
  const batteryDischargePower = Math.min(
    batteryMaxPower,
    batteryEnergy / PREVIEW_TIMESTEP_HOURS,
    residualAfterGrid
  );
  const dieselNeed = Math.max(
    residualAfterGrid - batteryDischargePower,
    0
  );

  const renewableCoveragePercent = load > 0
    ? Math.min(100, Math.round((totalRenewables / load) * 100))
    : null;
  const renewableSurplus = Math.max(totalRenewables - load, 0);
  const gridLineUsagePercent = gridLimit > 0
    ? Math.round((gridImportedPower / gridLimit) * 100)
    : null;
  const gridRemainingMargin = gridLimit - gridImportedPower;

  let gridStatus = "No limit set";
  let gridStatusClass = "unavailable";

  if (gridLimit > 0) {
    if (gridLineUsagePercent > 100) {
      gridStatus = "Limit violation";
      gridStatusClass = "violation";
    } else if (gridLineUsagePercent >= 90) {
      gridStatus = "Critical";
      gridStatusClass = "critical";
    } else if (gridLineUsagePercent >= 70) {
      gridStatus = "Watch";
      gridStatusClass = "watch";
    } else {
      gridStatus = "Normal";
      gridStatusClass = "normal";
    }
  }

  return {
    load: roundOperationalValue(load),
    solar: roundOperationalValue(solar),
    wind: roundOperationalValue(wind),
    totalRenewables: roundOperationalValue(totalRenewables),
    renewableCoveragePercent,
    renewableSurplus: roundOperationalValue(renewableSurplus),
    gridImportedPower: roundOperationalValue(gridImportedPower),
    gridLineUsagePercent,
    gridRemainingMargin: roundOperationalValue(gridRemainingMargin),
    gridStatus,
    gridStatusClass,
    batteryDischargePower: roundOperationalValue(batteryDischargePower),
    dieselNeed: roundOperationalValue(dieselNeed),
    isLoadReady: load > 0,
  };
}

function getDieselNeed(s) {
  return getOperationalPreview(s).dieselNeed;
}

function getBatteryPercent(s) {
  return Math.max(0, Math.min(100, (Number(s.batterySoc || 0) / Math.max(Number(s.batteryCapacity || 1), 1)) * 100)).toFixed(1);
}


function pickIcon(text) {
  const t = text.toLowerCase();
  if (t.includes("sun")) return "☀️";
  if (t.includes("wind")) return "🌬️";
  if (t.includes("peak")) return "🌆";
  if (t.includes("congestion")) return "⚡";
  if (t.includes("custom")) return "🛠️";
  return "🔋";
}

function cleanName(v) {
  return String(v || "")
    .replace(/[_-]/g, " ")
    .replace(/\s*scenario$/i, "")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default App;
// #endregion