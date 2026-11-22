# Sokoban, solved push by push

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Rizaltri13/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Rizaltri13/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A make.fun bounty entry for
[sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121):
a push-optimal Sokoban solver in one Node 22 program, `main.ts`. It reads
every instance of a set from `/input/<id>/level.txt` and writes the player's
moves to `/output/<id>/solution.txt`.

## Why it is optimal

A level in this competition is a hallway with independent rooms off it: a box
pushed out of a room can never be pushed back, so each room is its own puzzle
and the level's push-optimum is the sum of the rooms'. The program splits the
level into rooms, solves every room push-optimally, and joins the answers
with walks through the hallway.

The per-room search is A* over pushes. A state is the sorted box squares
together with the player's square, keyed by the boxes and the lowest square
of the player's reachable region, so every way of standing in one region is
one state. The estimate is the cheapest assignment of boxes to goals under
walking distances: one push moves one box one square, so the estimate can
only drop by one a push, which makes it admissible — the first solved state
the search pops is push-optimal. Dead squares (no pull path back to a goal)
and frozen 2x2 blocks are pruned. Every budget is a count of expanded
states, never the clock, so two runs print the same bytes.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

No dependencies, no network, no build step: plain Node 22 (type stripping
handles the `.ts` file as it is).

## Verification

On the kit's practice set (scored with the kit's own scorer), all five
instances solve in exactly their push-optimal counts — 13, 16, 29, 47 and
60 pushes — for a practice score of **1,000,000**, against the house
baseline plain-astar 1.0.0's 200,000 (it solves only the first instance).
The whole set runs in about 0.4 s on this machine, far inside the 60 s wall
budget. Two runs write byte-identical outputs.

The same solver was also run on 51 freshly drawn sets from the kit's
generator (random seeds): all 51 sets scored 1,000,000, every instance at
its push-optimum, worst set 0.7 s.
