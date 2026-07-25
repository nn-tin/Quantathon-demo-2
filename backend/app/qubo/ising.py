from __future__ import annotations

from app.models.schemas import IsingProblem, QUBOProblem


def qubo_to_ising(problem: QUBOProblem) -> IsingProblem:
    # q_i = (1 - z_i)/2, z_i in {-1,+1}.
    h = {str(i): -0.5 * float(problem.linear.get(str(i), 0.0)) for i in range(problem.dimension)}
    j_terms: dict[str, float] = {}
    offset = float(problem.offset) + 0.5 * sum(float(v) for v in problem.linear.values())
    for key, value_raw in problem.quadratic.items():
        i, j = (int(part) for part in key.split(","))
        value = float(value_raw)
        j_terms[f"{i},{j}"] = value / 4.0
        h[str(i)] -= value / 4.0
        h[str(j)] -= value / 4.0
        offset += value / 4.0
    scale = max([abs(v) for v in h.values()] + [abs(v) for v in j_terms.values()] + [1e-12])
    return IsingProblem(
        dimension=problem.dimension,
        offset=offset,
        linear_z=h,
        quadratic_zz=j_terms,
        variable_order=problem.variable_order,
        scale=scale,
    )


def evaluate_ising_energy(problem: IsingProblem, bitstring: str) -> float:
    if len(bitstring) != problem.dimension:
        raise ValueError("Bitstring length does not match Ising dimension.")
    z = [1.0 - 2.0 * int(bit) for bit in bitstring]
    energy = float(problem.offset)
    for key, value in problem.linear_z.items(): energy += float(value) * z[int(key)]
    for key, value in problem.quadratic_zz.items():
        i, j = (int(part) for part in key.split(","))
        energy += float(value) * z[i] * z[j]
    return float(energy)
