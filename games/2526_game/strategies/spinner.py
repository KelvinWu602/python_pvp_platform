"""
Sample strategy: a simple forward-biased driver that slows and turns when the
front sensor sees something close. Deliberately less effective than the wall
follower, so matches have a clear winner.

    update(sensors, telemetry) -> (alpha1, alpha2)
"""

TARGET_SPIN = 7.0
GAIN = 5.0


def update(sensors, telemetry):
    front = sensors[0]
    fr = sensors[1]
    fl = sensors[7]

    a1 = (TARGET_SPIN - telemetry['spin1']) * GAIN
    a2 = (TARGET_SPIN - telemetry['spin2']) * GAIN

    # Turn away from the closer front-diagonal.
    if front < 100 or fr < 80 or fl < 80:
        if fr < fl:
            a1 -= 25   # obstacle on front-right -> turn left
            a2 += 25
        else:
            a1 += 25
            a2 -= 25

    return a1, a2
