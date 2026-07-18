import numpy as np


extra_length = 0.005 # m


def length_cond_calc(k, T_h, T_b, q_h):
    """
    k: thermal conductivity of the material
    T_h: hot temperature (graphite temp facing gas)
    T_b: cold temperature (graphite temp facing chamber wall)
    q_h: surface heat flux at the throat
    """
    return k * (T_h - T_b) / q_h

def delta_ablation_calc(r_corrosion, t_burn):
    """
    r_corrosion: recession rate of the material
    t_burn: burn time
    """
    return r_corrosion * t_burn


def length_calc(k, T_h, T_b, q_h, r_corrosion, t_burn, t_lip):
    return length_cond_calc(k, T_h, T_b, q_h) + delta_ablation_calc(r_corrosion, t_burn) + extra_length + t_lip
