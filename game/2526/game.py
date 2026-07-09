"""
2526 Maze Racing Game (simulator build).

This is the game.py the simulator downloads from S3 (key: game/<game_id>/game.py)
and imports dynamically. The physics, sensing and rendering are ported verbatim
from the prototype in games/2526_game/game.py:
  - differential-drive kinematics (see physics.md)
  - SAT collision detection + positional push-out
  - 8-direction raycast distance sensors

Differences from the prototype:
  - no external BaseGame import (a minimal one is inlined so the file is
    self-contained when loaded standalone from S3)
  - module-level entry points the handler calls:
        init()
        result = simulate(player_a_strategy, player_b_strategy)
        export_video(output_path)
  - simulate() passes a single game_states dict (sandbox PlayerWorker protocol)
    instead of separate (sensors, telemetry) args
  - simulate() returns a result dict:
        {"winner": "a" | "b" | None,
         "winner_score_gain": float,
         "loser_score_loss": float,
         "log": str}

Coordinate system (matches the prototype / demo.html):
  - +x right, +y down (screen coordinates)
  - theta is a clockwise angle measured from the negative-y axis to the car
    front; the car's forward direction is (cos(theta + 3pi/2), sin(theta + 3pi/2))
"""

import math

import cv2
import numpy as np

CONTROLS_SCHEMA = {
    "type": "array",
    "prefixItems": [
        {"type": "number"},
        {"type": "number"},
    ],
    "items": False,
}


class BaseGame:
    """Minimal game base class. Inlined (instead of importing from a sibling
    base_game module) so this file works standalone after being downloaded
    from S3 and imported in isolation."""

    def __init__(self):
        pass

    def init(self):
        pass

    def simulate(self, player_a_strategy, player_b_strategy):
        pass

    def export(self):
        pass


# --- World / arena configuration ------------------------------------------
# The world is 1200x720; the output video is 1080x720 (uniform scale, letterboxed).
WORLD_W = 1200
WORLD_H = 720

# Sensor directions as (label, angle offset from heading), clockwise from front.
SENSOR_DIRS = [
    ('F', 0.0),
    ('FR', math.pi / 4),
    ('R', math.pi / 2),
    ('BR', 3 * math.pi / 4),
    ('B', math.pi),
    ('BL', 5 * math.pi / 4),
    ('L', 3 * math.pi / 2),
    ('FL', 7 * math.pi / 4),
]


class Box:
    """An axis-aligned box obstacle (immovable, infinite mass)."""

    def __init__(self, x, y, w, h):
        self.x = x
        self.y = y
        self.w = w
        self.h = h

    def corners(self):
        return (
            (self.x, self.y),
            (self.x + self.w, self.y),
            (self.x + self.w, self.y + self.h),
            (self.x, self.y + self.h),
        )


class Car:
    """A player's car: a W x W square body driven by two wheels."""

    def __init__(self, x, y, theta=0.0):
        # Dynamic state
        self.x = x
        self.y = y
        self.vx = 0.0
        self.vy = 0.0
        self.theta = theta
        self.omega = 0.0
        self.spin1 = 0.0   # left wheel angular velocity  (positive = forward)
        self.spin2 = 0.0   # right wheel angular velocity (positive = forward)

        # Constants
        self.W = 40        # body is a W x W square
        self.R = 10        # wheel radius
        self.maxSight = 250  # raycast range in pixels

        # Per-frame readouts
        self.colliding = False
        self.sensors = [self.maxSight] * len(SENSOR_DIRS)

        # Race bookkeeping
        self.finish_time = None

    # -- geometry -----------------------------------------------------------
    def get_corners(self):
        """Four corners of the rotated body, in world coordinates."""
        hw = self.W / 2
        c = math.cos(self.theta)
        sn = math.sin(self.theta)
        local = [(-hw, -hw), (hw, -hw), (hw, hw), (-hw, hw)]
        return [
            (self.x + lx * c - ly * sn, self.y + lx * sn + ly * c)
            for lx, ly in local
        ]

    # -- raycasting (ported from demo.html) ---------------------------------
    def _ray_box(self, dx, dy, b):
        """Slab method: distance from car center to first hit on box b along
        the unit ray (dx, dy), or None if it misses."""
        ox, oy = self.x, self.y
        t_enter = float('-inf')
        t_exit = float('inf')

        # X slab
        if abs(dx) < 1e-9:
            if ox < b.x or ox > b.x + b.w:
                return None
        else:
            t1 = (b.x - ox) / dx
            t2 = (b.x + b.w - ox) / dx
            if t1 > t2:
                t1, t2 = t2, t1
            t_enter = max(t_enter, t1)
            t_exit = min(t_exit, t2)

        # Y slab
        if abs(dy) < 1e-9:
            if oy < b.y or oy > b.y + b.h:
                return None
        else:
            t1 = (b.y - oy) / dy
            t2 = (b.y + b.h - oy) / dy
            if t1 > t2:
                t1, t2 = t2, t1
            t_enter = max(t_enter, t1)
            t_exit = min(t_exit, t2)

        if t_enter > t_exit:
            return None
        if t_exit < 0:
            return None
        return t_enter if t_enter >= 0 else 0.0

    def raycast(self, blocks):
        """Measure distance to the nearest block in 8 directions. Stores the
        distances in self.sensors and returns the ray endpoints (for drawing)."""
        distances = []
        endpoints = []
        for _label, off in SENSOR_DIRS:
            ang = self.theta + math.pi * 3 / 2 + off
            dx = math.cos(ang)
            dy = math.sin(ang)
            best = self.maxSight
            for b in blocks:
                d = self._ray_box(dx, dy, b)
                if d is not None and d < best:
                    best = d
            distances.append(best)
            endpoints.append((self.x + dx * best, self.y + dy * best, best < self.maxSight))
        self.sensors = distances
        return endpoints

    # -- kinematics (ported from demo.html) ---------------------------------
    def step(self, alpha1, alpha2, dt, blocks):
        """Advance one frame: integrate wheel accelerations, move, then resolve
        collisions by positional push-out (exactly as demo.html does)."""
        # Integrate wheel angular accelerations into angular velocities.
        self.spin1 += alpha1 * dt
        self.spin2 += alpha2 * dt

        # Differential-drive kinematics (physics.md).
        self.omega = self.R * (self.spin1 - self.spin2) / self.W
        self.theta += self.omega * dt

        speed = self.R * (self.spin1 + self.spin2) / 2
        self.vx = speed * math.cos(self.theta + 3 * math.pi / 2)
        self.vy = speed * math.sin(self.theta + 3 * math.pi / 2)

        # Predicted next position (no obstacles yet).
        self.x += self.vx * dt
        self.y += self.vy * dt

        # Detect & resolve against the boxes.
        self._resolve_collisions(blocks)

    def _resolve_collisions(self, blocks):
        """Push the car out of any box it overlaps, along the min-penetration
        axis. Position-only correction (physics2.md Step 3a); velocity is left
        alone because it is recomputed from the wheels each frame."""
        hit_any = False
        for _ in range(3):  # a few passes so the car settles between two boxes
            hit_this_pass = False
            for b in blocks:
                hit = _collide(self.get_corners(), (self.x, self.y), self.theta, b)
                if hit is None:
                    continue
                hit_this_pass = True
                hit_any = True
                (nx, ny), depth = hit
                self.x += nx * depth
                self.y += ny * depth
            if not hit_this_pass:
                break
        self.colliding = hit_any


# --- SAT collision (ported from demo.html) ---------------------------------
def _project(corners, axis):
    """Project points onto a unit axis, return (min, max)."""
    lo = float('inf')
    hi = float('-inf')
    for px, py in corners:
        p = px * axis[0] + py * axis[1]
        lo = min(lo, p)
        hi = max(hi, p)
    return lo, hi


def _collide(car_corners, car_center, theta, block):
    """Separating Axis Theorem test between the rotated car and AABB block.
    Returns ((nx, ny), depth) with the normal pointing out of the block toward
    the car, or None if they are separated."""
    block_corners = block.corners()
    c = math.cos(theta)
    sn = math.sin(theta)
    # Candidate axes: car's two edge normals + the box's two axes. All unit.
    axes = [(c, sn), (-sn, c), (1.0, 0.0), (0.0, 1.0)]

    min_overlap = float('inf')
    best_axis = None
    for axis in axes:
        min_a, max_a = _project(car_corners, axis)
        min_b, max_b = _project(block_corners, axis)
        if max_a < min_b or max_b < min_a:
            return None  # separating axis found -> no collision
        overlap = min(max_a, max_b) - max(min_a, min_b)
        if overlap < min_overlap:
            min_overlap = overlap
            best_axis = axis

    # Orient the normal from block center toward car center.
    bcx = block.x + block.w / 2
    bcy = block.y + block.h / 2
    nx, ny = best_axis
    if (car_center[0] - bcx) * nx + (car_center[1] - bcy) * ny < 0:
        nx, ny = -nx, -ny
    return (nx, ny), min_overlap


def _ang_diff(target, current):
    """Shortest signed angle from current to target, in [-pi, pi]."""
    return (target - current + math.pi) % (2 * math.pi) - math.pi


class Game(BaseGame):
    """2526 Maze Racing Game."""

    # Scoring constants. The winner gains a base reward plus a speed bonus for
    # finishing quickly; the loser loses the base reward. A draw scores nothing.
    BASE_SCORE = 100.0
    SPEED_BONUS = 50.0   # full bonus for an instant finish, decaying to 0 at max_time

    def __init__(self):
        super().__init__()
        self.dt = 1 / 60
        self.max_time = 30.0
        self.fps = 60           # physics fps
        self.render_fps = 30    # video render fps (decoupled from physics)

        self.blocks = []
        self.finish_zone = None  # (x, y, w, h)
        self.car_a = None
        self.car_b = None
        self.time = 0.0
        self.winner = None       # 'a', 'b', or None
        self.frames = []

    # -- setup --------------------------------------------------------------
    def init(self):
        """Build the arena and place the two cars at the start."""
        wall = 20  # boundary thickness
        self.blocks = [
            # Boundary walls keep the cars inside the world.
            Box(0, 0, WORLD_W, wall),                       # top
            Box(0, WORLD_H - wall, WORLD_W, wall),          # bottom
            Box(0, 0, wall, WORLD_H),                       # left
            Box(WORLD_W - wall, 0, wall, WORLD_H),          # right
            # Internal slalom obstacles.
            Box(380, 0, 40, 520),                           # wall down from top, gap at bottom
            Box(720, 200, 40, 520),                         # wall up from bottom, gap at top
            Box(960, 300, 140, 60),                         # block near the finish
        ]
        # Finish zone on the right edge.
        self.finish_zone = (1100, 300, 80, 120)

        # Both cars start stacked on the left.
        self.car_a = Car(x=110, y=300, theta=0.0)
        self.car_b = Car(x=110, y=440, theta=0.0)

        self.time = 0.0
        self.winner = None
        self.frames = []

    # -- helpers ------------------------------------------------------------
    def _target_bearing(self, car):
        """Signed angle from the car's heading to the finish zone center, in
        [-pi, pi].  Positive = goal is clockwise of heading.  Returns 0.0 if
        the car is exactly at the finish center."""
        fx, fy, fw, fh = self.finish_zone
        target_x = fx + fw / 2
        target_y = fy + fh / 2
        dx = target_x - car.x
        dy = target_y - car.y
        if abs(dx) < 1e-9 and abs(dy) < 1e-9:
            return 0.0
        target_angle = math.atan2(dy, dx)
        heading = car.theta + 3 * math.pi / 2
        return _ang_diff(target_angle, heading)

    # -- simulation ---------------------------------------------------------
    def _in_finish(self, car):
        fx, fy, fw, fh = self.finish_zone
        return fx <= car.x <= fx + fw and fy <= car.y <= fy + fh

    def simulate(self, player_a_strategy, player_b_strategy):
        """Run the race until someone wins or time runs out, then return a
        result dict for the handler.

        Both strategies are called as strategy(game_states) and must return
        (alpha1, alpha2) — the angular accelerations of the left and right
        wheels for this frame.

        game_states dict:
          sensors         — list of 8 distances [F, FR, R, BR, B, BL, L, FL]
          telemetry       — dict with spin1, spin2, theta, omega, vx, vy
          dt              — frame delta in seconds (1/60)
          target_bearing  — signed angle from heading → finish center, [-pi, pi]
        """
        while self.time < self.max_time:
            for tag, car, strat in (('a', self.car_a, player_a_strategy),
                                    ('b', self.car_b, player_b_strategy)):
                car.raycast(self.blocks)

                game_states = {
                    'sensors': list(car.sensors),
                    'telemetry': {
                        'spin1': car.spin1,
                        'spin2': car.spin2,
                        'theta': car.theta,
                        'omega': car.omega,
                        'vx': car.vx,
                        'vy': car.vy,
                    },
                    'dt': self.dt,
                    'target_bearing': self._target_bearing(car),
                }

                try:
                    controls = strat(game_states, CONTROLS_SCHEMA)
                except Exception as e:
                    raise Exception(f'Strategy {tag} error: {e}')

                alpha1, alpha2 = controls
                car.step(alpha1, alpha2, self.dt, self.blocks)

                if car.finish_time is None and self._in_finish(car):
                    car.finish_time = self.time
                    if self.winner is None:
                        self.winner = tag

            self._record_frame()
            self.time += self.dt

            # End as soon as both cars have finished.
            if self.car_a.finish_time is not None and self.car_b.finish_time is not None:
                break
            # End as soon as we have a winner (the race is decided on first finish).
            if self.winner is not None:
                break

        return self._build_result()

    def _build_result(self):
        """Turn the final race state into the handler's result dict.

        Winner is whoever reached the finish first (self.winner). The winner's
        score gain is a base reward plus a speed bonus that scales with how
        quickly they finished; the loser loses the same base reward. If nobody
        finished in time it is a draw (no winner, no score change)."""
        a_finish = self.car_a.finish_time
        b_finish = self.car_b.finish_time

        if self.winner is None:
            return {
                'winner': None,
                'winner_score_gain': 0.0,
                'loser_score_loss': 0.0,
                'log': (
                    f'Draw: neither car finished within {self.max_time:.0f}s '
                    f'(sim ran {self.time:.2f}s, {len(self.frames)} frames).'
                ),
            }

        finish_time = a_finish if self.winner == 'a' else b_finish
        # Speed bonus: full at t=0, linearly down to 0 at max_time.
        fraction_remaining = max(0.0, 1.0 - (finish_time / self.max_time))
        score_gain = self.BASE_SCORE + self.SPEED_BONUS * fraction_remaining

        return {
            'winner': self.winner,
            'winner_score_gain': round(score_gain, 2),
            'loser_score_loss': round(self.BASE_SCORE, 2),
            'log': (
                f'Car {self.winner.upper()} won, finishing at {finish_time:.2f}s. '
                f'A finish={a_finish}, B finish={b_finish}, '
                f'sim duration={self.time:.2f}s, frames={len(self.frames)}.'
            ),
        }

    def _record_frame(self):
        """Snapshot everything draw() needs for this frame."""
        def snap(car):
            return {
                'x': car.x, 'y': car.y, 'theta': car.theta,
                'corners': car.get_corners(),
                'rays': car.raycast(self.blocks),
                'colliding': car.colliding,
            }
        self.frames.append({
            'time': self.time,
            'winner': self.winner,
            'car_a': snap(self.car_a),
            'car_b': snap(self.car_b),
        })

    # -- rendering ----------------------------------------------------------
    def export(self, output_path='/tmp/game.webm'):
        """Render recorded frames to a 1080x720 webm (VP8) at render_fps and return the path."""
        if not self.frames:
            raise Exception('No frames to export; run simulate() first')

        out_w, out_h = 1080, 720
        # Uniform scale so the 1200x720 world fits inside 1080x720, letterboxed.
        scale = min(out_w / WORLD_W, out_h / WORLD_H)
        off_x = (out_w - WORLD_W * scale) / 2
        off_y = (out_h - WORLD_H * scale) / 2

        def to_px(x, y):
            return (int(x * scale + off_x), int(y * scale + off_y))

        fourcc = cv2.VideoWriter_fourcc(*'VP80')
        video = cv2.VideoWriter(output_path, fourcc, self.render_fps, (out_w, out_h))
        if not video.isOpened():
            raise Exception(f'Failed to open video writer for {output_path}')

        # BGR colors
        COL_BG = (0, 0, 0)
        COL_PLAY = (30, 30, 30)
        COL_BLOCK = (130, 130, 130)
        COL_FINISH = (0, 200, 0)
        COL_RAY = (0, 0, 255)
        COL_A = (255, 80, 0)      # blue-ish
        COL_B = (0, 80, 255)      # red-ish
        COL_WHEEL = (40, 40, 40)

        step = max(1, round(self.fps / self.render_fps))   # 60/30 = 2 -> every 2nd frame
        try:
            for fr in self.frames[::step]:
                img = np.zeros((out_h, out_w, 3), dtype=np.uint8)
                img[:] = COL_BG

                # Play area
                p0 = to_px(0, 0)
                p1 = to_px(WORLD_W, WORLD_H)
                cv2.rectangle(img, p0, p1, COL_PLAY, -1)

                # Obstacles
                for b in self.blocks:
                    cv2.rectangle(img, to_px(b.x, b.y), to_px(b.x + b.w, b.y + b.h),
                                  COL_BLOCK, -1)

                # Finish zone
                fx, fy, fw, fh = self.finish_zone
                cv2.rectangle(img, to_px(fx, fy), to_px(fx + fw, fy + fh), COL_FINISH, 2)

                # Cars
                self._draw_car(img, fr['car_a'], COL_A, COL_WHEEL, COL_RAY, to_px, scale)
                self._draw_car(img, fr['car_b'], COL_B, COL_WHEEL, COL_RAY, to_px, scale)

                # HUD
                remaining = max(0.0, self.max_time - fr['time'])
                cv2.putText(img, f'Time left: {remaining:4.1f}s', (12, 28),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
                if fr['winner']:
                    cv2.putText(img, f'Winner: Car {fr["winner"].upper()}', (12, 60),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)

                video.write(img)
        finally:
            video.release()

        return output_path

    def _draw_car(self, img, car, body_col, wheel_col, ray_col, to_px, scale):
        # Sensor rays (drawn first so the body sits on top).
        cx, cy = to_px(car['x'], car['y'])
        for ex, ey, hit in car['rays']:
            cv2.line(img, (cx, cy), to_px(ex, ey), ray_col, 1)
            if hit:
                hx, hy = to_px(ex, ey)
                cv2.rectangle(img, (hx - 3, hy - 3), (hx + 3, hy + 3), ray_col, -1)

        # Body
        pts = np.array([to_px(px, py) for px, py in car['corners']], dtype=np.int32)
        outline = (0, 255, 255) if car['colliding'] else body_col
        cv2.fillPoly(img, [pts], body_col)
        cv2.polylines(img, [pts], True, outline, 2)

        # Wheels (local rectangles rotated into world space).
        theta = car['theta']
        c = math.cos(theta)
        sn = math.sin(theta)
        # half-size of body; wheels sit just outside the left/right faces
        hw = 20  # W/2
        R = 10
        wheels = [
            # left wheel: x in [-hw-R, -hw], y in [-hw, hw]
            [(-hw - R, -hw), (-hw, -hw), (-hw, hw), (-hw - R, hw)],
            # right wheel: x in [hw, hw+R], y in [-hw, hw]
            [(hw, -hw), (hw + R, -hw), (hw + R, hw), (hw, hw)],
        ]
        for w in wheels:
            world = [(car['x'] + lx * c - ly * sn, car['y'] + lx * sn + ly * c)
                     for lx, ly in w]
            wp = np.array([to_px(px, py) for px, py in world], dtype=np.int32)
            cv2.fillPoly(img, [wp], wheel_col)


# --- Module-level entry points (handler.py calling pattern) ----------------
# The handler imports this module and calls init() / simulate() / export_video()
# at module scope (not on a Game instance), so we keep a single module-level
# Game instance and expose thin wrappers over it.
_GAME = Game()


def init():
    """Build the arena and reset state. Mirrors Game.init()."""
    _GAME.init()


def simulate(player_a_strategy, player_b_strategy):
    """Run the match and return the result dict. Mirrors Game.simulate()."""
    return _GAME.simulate(player_a_strategy, player_b_strategy)


def export_video(output_path):
    """Render the recorded frames to output_path. Wraps Game.export()."""
    return _GAME.export(output_path)
