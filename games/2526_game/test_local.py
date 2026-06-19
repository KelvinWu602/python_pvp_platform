"""
Cloud-dependency-free local test harness for the 2526 maze game.

It mirrors what base_game.lambda_handler does (load game -> load two player
strategies -> init -> simulate -> export) but with NO S3 / RDS / boto3: the
game and strategies are imported from local files and the video is written to a
local directory.

Usage:
    python test_local.py
    python test_local.py --a strategies/wall_follower.py --b strategies/greedy.py
    python test_local.py --out out/match.mp4

A strategy file must define:
    def update(sensors, telemetry) -> (alpha1, alpha2)
        sensors:   [F, FR, R, BR, B, BL, L, FL] distances (pixels, capped at maxSight)
        telemetry: dict with spin1, spin2, theta, omega, vx, vy
        returns:   (alpha1, alpha2) angular accelerations for left/right wheels
"""

import argparse
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def load_callable(path, attr='update'):
    """Import `attr` from a local .py file (same trick base_game uses for S3
    downloads, minus the download)."""
    path = os.path.abspath(path)
    if not os.path.exists(path):
        raise FileNotFoundError(f'strategy file not found: {path}')
    name = f'strategy_{abs(hash(path))}'
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    if not hasattr(module, attr):
        raise AttributeError(f'{path} does not define {attr}(sensors, telemetry)')
    return getattr(module, attr)


def main():
    parser = argparse.ArgumentParser(description='Run a local 2526 maze match.')
    parser.add_argument('--a', default=os.path.join(HERE, 'strategies', 'wall_follower.py'),
                        help='player A strategy file')
    parser.add_argument('--b', default=os.path.join(HERE, 'strategies', 'spinner.py'),
                        help='player B strategy file')
    parser.add_argument('--out', default=os.path.join(HERE, 'out', 'match.mp4'),
                        help='output video path')
    args = parser.parse_args()

    # Import the game module from this directory.
    sys.path.insert(0, HERE)
    from game import Game

    player_a = load_callable(args.a)
    player_b = load_callable(args.b)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)

    game = Game()
    game.init()
    print(f'Running match: A={os.path.basename(args.a)}  B={os.path.basename(args.b)}')
    game.simulate(player_a, player_b)

    out_path = game.export(args.out)

    # Report result, mirroring the fields the lambda would write to the DB.
    print('--- result ---')
    print(f'  winner          : {game.winner}')
    print(f'  car A finish    : {game.car_a.finish_time}')
    print(f'  car B finish    : {game.car_b.finish_time}')
    print(f'  sim duration    : {game.time:.2f}s')
    print(f'  frames rendered : {len(game.frames)}')
    print(f'  video written   : {out_path}')


if __name__ == '__main__':
    main()
