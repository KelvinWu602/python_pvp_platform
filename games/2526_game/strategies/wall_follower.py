"""
Sample strategy: head toward the finish (to the right) while dodging obstacles.

Contract:
    update(sensors, telemetry) -> (alpha1, alpha2)
    sensors = [F, FR, R, BR, B, BL, L, FL]  distances in pixels (capped at maxSight)
    telemetry has theta, spin1, spin2, omega, vx, vy

Heading geometry (matches the engine): the car's forward direction is
(cos(theta + 3pi/2), sin(theta + 3pi/2)). So theta = pi/2 points right (+x),
which is where the finish zone is. Making the LEFT wheel faster increases theta
(rotates the heading clockwise on screen: up -> right).

alpha1/alpha2 are angular ACCELERATIONS, so we steer by pushing the wheels
toward a target spin (cruise) plus a steering bias.
"""

import math

TARGET_HEADING = math.pi / 2   # theta that points right, toward the finish
CRUISE = 9.0                   # desired forward wheel speed
SPIN_GAIN = 6.0                # accelerate toward cruise speed
STEER_GAIN = 14.0              # how hard we correct heading error
AVOID = 45.0                   # extra steering when something is close ahead


def _ang_err(target, current):
    """Shortest signed angle from current to target, in [-pi, pi]."""
    return (target - current + math.pi) % (2 * math.pi) - math.pi


def update(sensors, telemetry):
    front, fr, right, br, back, bl, left, fl = sensors

    # Base: bring both wheels up to cruising speed.
    a1 = (CRUISE - telemetry['spin1']) * SPIN_GAIN
    a2 = (CRUISE - telemetry['spin2']) * SPIN_GAIN

    # Steer toward the finish heading. Positive error -> need larger theta ->
    # left wheel faster (a1 up, a2 down).
    err = _ang_err(TARGET_HEADING, telemetry['theta'])
    a1 += err * STEER_GAIN
    a2 -= err * STEER_GAIN

    # Obstacle avoidance: if blocked ahead, turn toward the side with more room.
    if front < 110 or fr < 80 or fl < 80:
        if (left + fl) > (right + fr):
            a1 -= AVOID   # more room on the left -> decrease theta -> veer left
            a2 += AVOID
        else:
            a1 += AVOID
            a2 -= AVOID

    return a1, a2
