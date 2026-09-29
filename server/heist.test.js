import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from './game.js';

// ~1m in degrees latitude — plenty accurate at game scale.
const M = 1 / 111_320;
const BASE = { lat: 39.9865, lng: -105.9333 };
const at = (northM, eastM = 0) => ({
  lat: BASE.lat + northM * M,
  lng: BASE.lng + (eastM * M) / Math.cos((BASE.lat * Math.PI) / 180),
});

function makeHeist({ stations = 4 } = {}) {
  const events = [];
  const game = new Game((event, payload, scope) => events.push({ event, payload, scope }));
  game.configure({ mode: 'heist', boundary: { center: BASE, radiusM: 500 } });
  const host = game.addPlayer({ name: 'host', isHost: true });
  const cop = game.addPlayer({ name: 'Carl', teamName: 'Cops' });
  const r1 = game.addPlayer({ name: 'Rita', teamName: 'Crew' });
  const r2 = game.addPlayer({ name: 'Rob', teamName: 'Crew' });
  game.setTeamRole(cop.teamId, 'seeker');
  // Stations 100m apart along a line north; prison 200m south.
  for (let i = 0; i < stations; i++) game.addStation({ ...at(100 * (i + 1)), points: 10 });
  game.setPrison(at(-200));
  return { game, events, host, cop, r1, r2 };
}

/** Start the heist and put `player` right on top of a point. */
function standAt(game, player, pt, accuracy = 5) {
  game.updatePosition(player.id, { ...pt, accuracy });
}

function activeStations(game) {
  return [...game.heist.stations.values()].filter((s) => s.active);
}

/** Pretend the task started long enough ago to be completable. */
function ageTask(player, ms = 20_000) {
  player.robber.task.startedAt -= ms;
}

test('heist: scatter lights exactly activeStations stations', () => {
  const { game } = makeHeist({ stations: 5 });
  game.startPhase('hide');
  assert.equal(activeStations(game).length, 3);
});

test('heist: station positions go to robbers only — cops never see them', () => {
  const { game, cop, r1 } = makeHeist();
  game.startPhase('hide');
  const robberView = game.playerState(r1.id).heist;
  const copView = game.playerState(cop.id).heist;
  assert.equal(robberView.stations.length, 3);
  assert.ok(robberView.stations.every((s) => s.active));
  assert.equal(copView.stations, undefined);
  assert.ok(copView.prison, 'cops still see the prison');
  // Inactive stations stay hidden from robbers too (no pre-scouting).
  assert.equal(game.refereeState().heist.stations.length, 4);
});

test('heist: task needs presence — far away or weak GPS is refused', () => {
  const { game, r1 } = makeHeist();
  game.startPhase('seek');
  const s = activeStations(game)[0];
  standAt(game, r1, at(-100));
  assert.match(game.startTask(r1.id, s.id).error, /Too far/);
  standAt(game, r1, s, 60);
  assert.match(game.startTask(r1.id, s.id).error, /Weak GPS/);
  standAt(game, r1, s);
  assert.ok(game.startTask(r1.id, s.id).ok);
});

test('heist: finishing scores, retires the station, and lights a DIFFERENT one', () => {
  const { game, r1 } = makeHeist({ stations: 4 });
  game.startPhase('seek');
  const s = activeStations(game)[0];
  standAt(game, r1, s);
  game.startTask(r1.id, s.id);
  ageTask(r1);
  const res = game.completeTask(r1.id, s.id);
  assert.ok(res.ok);
  assert.equal(game.heist.score, 10);
  assert.equal(r1.robber.points, 10);
  assert.equal(s.active, false, 'finished station goes dark');
  assert.equal(activeStations(game).length, 3, 'another station lit up');
});

test('heist: insta-finish is refused; finishing slightly outside radius is OK (hysteresis)', () => {
  const { game, r1 } = makeHeist();
  game.startPhase('seek');
  const s = activeStations(game)[0];
  standAt(game, r1, s);
  game.startTask(r1.id, s.id);
  assert.match(game.completeTask(r1.id, s.id).error, /Too fast/);
  ageTask(r1);
  // 28m north of the station: outside the 20m start radius, inside 20+15.
  standAt(game, r1, { lat: s.lat + 28 * M, lng: s.lng });
  assert.ok(game.completeTask(r1.id, s.id).ok);
});

test('heist: a station can only be worked by one robber at a time', () => {
  const { game, r1, r2 } = makeHeist();
  game.startPhase('seek');
  const s = activeStations(game)[0];
  standAt(game, r1, s);
  standAt(game, r2, s);
  assert.ok(game.startTask(r1.id, s.id).ok);
  assert.match(game.startTask(r2.id, s.id).error, /Another robber/);
  game.cancelTask(r1.id);
  assert.ok(game.startTask(r2.id, s.id).ok);
});

test('heist: caught → jailed (no tasks) → serves time in prison → immune → free', () => {
  const { game, r1 } = makeHeist();
  game.startPhase('seek');
  const s = activeStations(game)[0];
  standAt(game, r1, s);
  game.startTask(r1.id, s.id);
  game.tagPlayer(r1.id, r1.id); // "I'm caught" routes to catchRobber in heist
  assert.equal(r1.robber.status, 'jailed');
  assert.equal(r1.robber.task, null, 'caught cancels the task');
  assert.equal(s.lockedBy, null, 'and frees the station');
  assert.match(game.startTask(r1.id, s.id).error, /jailed/);

  // Time outside the prison doesn't count.
  let now = Date.now();
  game.heist.lastTickAt = now;
  for (let i = 0; i < 20; i++) {
    now += 2000;
    standAt(game, r1, s);
    r1.pos.at = now;
    game.tick(now);
  }
  assert.equal(r1.robber.status, 'jailed');
  assert.equal(r1.robber.jailServedMs, 0);

  // 30s inside the prison → released with immunity.
  for (let i = 0; i < 16; i++) {
    now += 2000;
    standAt(game, r1, game.heist.prison);
    r1.pos.at = now;
    game.tick(now);
  }
  assert.equal(r1.robber.status, 'immune');
  assert.equal(game.catchRobber(r1.id), null, 'immune robbers cannot be caught');

  now = r1.robber.immuneUntil + 1;
  game.tick(now);
  assert.equal(r1.robber.status, 'free');
});

test('heist: team is NOT converted when a robber is caught', () => {
  const { game, r1 } = makeHeist();
  game.startPhase('seek');
  game.tagPlayer(r1.id, r1.id);
  assert.equal(game.teams.get(r1.teamId).role, 'hider');
  assert.equal(game.phase, 'seek');
});

test('heist: robbers win on reaching the target score', () => {
  const { game, r1, events } = makeHeist({ stations: 6 });
  game.configure({ settings: { targetScore: 20 } });
  game.startPhase('seek');
  for (let i = 0; i < 2; i++) {
    const s = activeStations(game)[0];
    standAt(game, r1, s);
    game.startTask(r1.id, s.id);
    ageTask(r1);
    assert.ok(game.completeTask(r1.id, s.id).ok);
  }
  assert.equal(game.phase, 'over');
  assert.equal(game.heist.winner, 'robbers');
  assert.equal(events.find((e) => e.event === 'game:over').payload.winner, 'robbers');
});

test('heist: timer running out = cops win', () => {
  const { game } = makeHeist();
  game.startPhase('seek');
  game.tick(game.phaseEndsAt + 1);
  assert.equal(game.phase, 'over');
  assert.equal(game.heist.winner, 'cops');
});

test('heist: referee overrides — credit station, release, adjust score', () => {
  const { game, r1, host } = makeHeist();
  game.startPhase('seek');
  game.creditStation(activeStations(game)[0]);
  assert.equal(game.heist.score, 10);
  game.catchRobber(r1.id, host.id);
  game.releaseRobber(r1.id);
  assert.equal(r1.robber.status, 'immune');
  game.adjustScore(-50);
  assert.equal(game.heist.score, 0, 'score never goes negative');
});

test('heist: back to lobby clears statuses and score, keeps stations placed', () => {
  const { game, r1 } = makeHeist();
  game.startPhase('seek');
  game.catchRobber(r1.id);
  game.adjustScore(30);
  game.startPhase('lobby');
  assert.equal(r1.robber.status, 'free');
  assert.equal(game.heist.score, 0);
  assert.equal(game.heist.stations.size, 4);
  assert.equal(activeStations(game).length, 0);
});

test('hide & seek mode is unaffected: no heist block in state', () => {
  const game = new Game();
  const p = game.addPlayer({ name: 'A', teamName: 'Owls' });
  assert.equal(game.playerState(p.id).heist, undefined);
  assert.equal(game.playerState(p.id).mode, 'hideseek');
});
