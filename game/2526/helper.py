"""
2526 Racing Game — Helper module.

Utility functions available to player code via `import helper`.
"""

import math


def ang_diff(target, current):
    """Shortest signed angle from *current* to *target*, in [-pi, pi].

    Positive result means *target* is clockwise from *current*.
    """
    return (target - current + math.pi) % (2 * math.pi) - math.pi


def clamp(v, lo, hi):
    """Clamp *v* to the inclusive range [*lo*, *hi*]."""
    if v < lo:
        return lo
    if v > hi:
        return hi
    return v


def lerp(a, b, t):
    """Linear interpolation: ``a + (b - a) * t``.  *t* is typically in [0, 1]."""
    return a + (b - a) * t


def pid(error, kp, ki, kd, integral, prev_error):
    """Single PID controller step.

    Parameters
    ----------
    error : float
        Current error (target - current).
    kp, ki, kd : float
        Proportional, integral, derivative gains.
    integral : float
        Accumulated integral from previous step (pass 0.0 on first call).
    prev_error : float
        Error from previous step (pass 0.0 on first call).

    Returns
    -------
    (output, integral, prev_error)
        *output* — controller output = kp*error + ki*integral + kd*derivative
        *integral* — updated accumulated integral (clamped to [-1000, 1000])
        *prev_error* — this frame's error (pass back on next call)
    """
    integral += error
    integral = clamp(integral, -1000.0, 1000.0)
    derivative = error - prev_error
    output = kp * error + ki * integral + kd * derivative
    return output, integral, error
