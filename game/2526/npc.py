"""
2526 NPC — default opponent for test battles.

This code is stored as the NPC's user-code snapshot in the database.
It follows the same contract as any player submission:

    update(game_states) -> (alpha1, alpha2)
"""

import math
import helper


CRUISE = 8.0
SPIN_GAIN = 5.0
STEER_GAIN = 12.0
AVOID_THRESHOLD = 120.0
AVOID_BIAS = 40.0
REVERSE_THRESHOLD = 30.0
REVERSE_BIAS = 20.0

SENSOR_F = 0
SENSOR_FR = 1
SENSOR_R = 2
SENSOR_BR = 3
SENSOR_B = 4
SENSOR_BL = 5
SENSOR_L = 6
SENSOR_FL = 7


def update(game_states):
    sensors = game_states['sensors']
    telemetry = game_states['telemetry']
    bearing = game_states['target_bearing']

    front = sensors[SENSOR_F]
    front_right = sensors[SENSOR_FR]
    front_left = sensors[SENSOR_FL]
    left = sensors[SENSOR_L]
    right = sensors[SENSOR_R]

    a1 = (CRUISE - telemetry['spin1']) * SPIN_GAIN
    a2 = (CRUISE - telemetry['spin2']) * SPIN_GAIN

    steer = helper.ang_diff(0.0, bearing)
    a1 += steer * STEER_GAIN
    a2 -= steer * STEER_GAIN

    if front < REVERSE_THRESHOLD:
        a1 -= REVERSE_BIAS
        a2 -= REVERSE_BIAS
        if left > right:
            a1 += AVOID_BIAS
            a2 -= AVOID_BIAS
        else:
            a1 -= AVOID_BIAS
            a2 += AVOID_BIAS
    elif front < AVOID_THRESHOLD or front_left < AVOID_THRESHOLD or front_right < AVOID_THRESHOLD:
        if left > right:
            a1 -= AVOID_BIAS * 0.7
            a2 += AVOID_BIAS * 0.7
        else:
            a1 += AVOID_BIAS * 0.7
            a2 -= AVOID_BIAS * 0.7

    return helper.clamp(a1, -100.0, 100.0), helper.clamp(a2, -100.0, 100.0)
