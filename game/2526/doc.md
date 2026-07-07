# 2526 Maze Racing

A two-player head-to-head car racing game. Each player writes a strategy
function that controls a car's two wheels. The first car to reach the finish
zone wins.

---

## Update contract

Every player's code must define a top-level function:

```python
def update(game_states):
    """Return (alpha1, alpha2) — wheel angular accelerations."""
    # sensors  = game_states['sensors']
    # telemetry = game_states['telemetry']
    # bearing  = game_states['target_bearing']
    return a1, a2
```

Where **alpha1** is the left wheel's angular acceleration and **alpha2** is the
right wheel's (positive = forward). The function is called 60 times per second.

### The game_states dict

| Field | Type | Description |
|---|---|---|
| `sensors` | `list[8] of float` | Raycast distances in 8 directions, 0–250 px |
| `telemetry` | `dict` | Car's own state (see below) |
| `dt` | `float` | Frame delta in seconds (`1/60`) |
| `target_bearing` | `float` | Signed angle from car heading to finish zone center, in [-pi, pi]. **0 = car is pointing at the goal.** Positive = goal is clockwise of heading. |

### Sensors

The car has 8 raycast sensors that measure distance to the nearest obstacle:

```
          F
     FL       FR
   L             R
     BL       BR
          B
```

Index into `sensors`:

| Index | Label | Direction from heading |
|---|---|---|
| 0 | F | Front |
| 1 | FR | Front-right (45°) |
| 2 | R | Right (90°) |
| 3 | BR | Back-right (135°) |
| 4 | B | Back (180°) |
| 5 | BL | Back-left (225°) |
| 6 | L | Left (270°) |
| 7 | FL | Front-left (315°) |

Each value is the distance in pixels to the nearest wall/obstacle, capped at
250 px. A value of 250 means "nothing detected within range."

### Telemetry

| Field | Type | Description |
|---|---|---|
| `spin1` | float | Left wheel angular velocity (rad/s) |
| `spin2` | float | Right wheel angular velocity (rad/s) |
| `theta` | float | Heading angle (radians). 0 = up, pi/2 = right. |
| `omega` | float | Angular velocity (rad/s). Positive = clockwise. |
| `vx` | float | Velocity along world x-axis (px/s) |
| `vy` | float | Velocity along world y-axis (px/s) |

### Return value

`(alpha1, alpha2)` — two floats:

- **alpha1** = left wheel angular acceleration (rad/s²)
- **alpha2** = right wheel angular acceleration (rad/s²)

Positive values accelerate the wheel forward; negative values reverse it.

---

## Helper module

Players can `import helper` in their code. The helper provides:

### ang_diff(target, current)

Shortest signed angle from *current* to *target* in [-pi, pi].

```python
err = helper.ang_diff(target_theta, car_theta)  # positive = turn clockwise
```

### clamp(v, lo, hi)

Clamp *v* to the inclusive range [*lo*, *hi*].

```python
a1 = helper.clamp(a1, -100.0, 100.0)
```

### lerp(a, b, t)

Linear interpolation: `a + (b - a) * t`.

```python
target_speed = helper.lerp(CRUISE_SLOW, CRUISE_FAST, distance_to_goal / MAX_DIST)
```

### pid(error, kp, ki, kd, integral, prev_error)

One step of a PID controller. Returns `(output, integral, prev_error)`.

```python
output, integral, prev = helper.pid(
    error=target_bearing,
    kp=8.0, ki=0.0, kd=2.0,
    integral=integral,
    prev_error=prev_error,
)
```

---

## Map

The arena is 1200 × 720 pixels.

```
 0 ────────────────────────────────────────────────────────── 1200
 │                                                            │
 │  Car A (110, 300)         ████████                         │
 │  ───────────►             ████████  (wall 380,0, 40,520)   │
 │                           ████████                         │
 │                           ████████                         │
 │                                    ████████                │
 │  Car B (110, 440)                  ████████  (wall         │
 │  ───────────►                      ████████   720,200,     │
 │                                    ████████   40,520)      │
 │                                           ┌──────────────┐ │
 │                                           │  ████████    │ │
 │                                           │  FINISH      │ │
 │                                           │  (1100,300,  │ │
 │                                           │   80,120)    │ │
 │                                           └──────────────┘ │
720 ──────────────────────────────────────────────────────────
```

Cars start on the left, the finish zone is on the right. The obstacles force
cars to slalom through gaps. There is no direct straight line to the goal.

---

## Differential drive model

The car is a square body with two independently-driven wheels on each side:

```
         ┌──┐
    left │  │ right   alpha1 = left wheel acceleration
    wheel│  │ wheel   alpha2 = right wheel acceleration
         └──┘
```

- **Both wheels same speed** → car goes straight (in direction of heading)
- **Left faster than right** → car turns clockwise
- **Right faster than left** → car turns counter-clockwise
- **Wheels in opposite directions** → car spins in place

The `target_bearing` field tells you which way to turn. Use it as a compass:

```python
steer = helper.ang_diff(0.0, game_states['target_bearing'])
a1 = (CRUISE - telemetry['spin1']) * GAIN + steer * STEER_GAIN
a2 = (CRUISE - telemetry['spin2']) * GAIN - steer * STEER_GAIN
```

This accelerates both wheels toward cruising speed, then biases the difference
to correct the heading.

---

## Scoring

| Outcome | Winner gets | Loser gets |
|---|---|---|
| Win (finish first) | 100 + speed bonus (up to 50) | −100 |
| Draw (time runs out) | 0 | 0 |

Speed bonus = `50 × (1 - finish_time / 30)`. Finishing in 5 seconds gives the
winner `100 + 41.7 = 141.7`; the loser loses 100.

---

## Tips for beginners

1. **Start simple** — just drive forward with a basic steer toward
   `target_bearing`. You'll be surprised how far this gets you.

2. **Add obstacle avoidance** — check the front sensor. If something is too
   close, steer toward the side with more space.

3. **Use the helper** — `helper.ang_diff` and `helper.clamp` save you from
   writing angle-wrapping logic.

4. **Use a PID** — the `helper.pid` function can give smoother steering than
   raw proportional control.

5. **Watch your speed** — going too fast into corners makes you crash and get
   stuck. Consider slowing down when sensors show obstacles ahead.

6. **Car body is 40×40**, wheels have radius 10. The car's body protrudes
   beyond its center — the sensor distances are measured from center, so
   account for the car's half-size (~20 px) when deciding if you're about to
   hit something.
