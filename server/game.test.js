import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from './game.js';

function makeGame() {
  const events = [];
  const game = new Game((event, payload, scope) => events.push({ event, payload, scope }));
  return { game, events };
}

function setupTwoTeams(game) {
  const host = game.addPlayer({ name: 'Host', teamName: 'Seekers' });
  const h1 = game.addPlayer({ name: 'Alice', teamName: 'Owls' });
  const h2 = game.addPlayer({ name: 'Bob', teamName: 'Foxes' });
  game.setTeamRole(game.teams.get(host.teamId).id, 'seeker');
  return { host, h1, h2 };
}

test('first player becomes host', () => {
  const { game } = makeGame();
  const a = game.addPlayer({ name: 'A' });
  const b = game.addPlayer({ name: 'B' });
  assert.equal(a.isHost, true);
  assert.equal(b.isHost, false);
});

test('joining same team name reuses the team (case-insensitive)', () => {
  const { game } = makeGame();
  const a = game.addPlayer({ name: 'A', teamName: 'Owls' });
  const b = game.addPlayer({ name: 'B', teamName: 'owls' });
  assert.equal(a.teamId, b.teamId);
  assert.equal(game.teams.size, 1);
});

test('tagging converts the whole team to seekers', () => {
  const { game } = makeGame();
  const { h1 } = setupTwoTeams(game);
  game.startPhase('hide');
  game.startPhase('seek');
  game.tagPlayer(h1.id);
  assert.equal(game.teams.get(h1.teamId).role, 'seeker');
});

test('win: last un-caught hider team standing', () => {
  const { game, events } = makeGame();
  const { h1, h2 } = setupTwoTeams(game);
  game.startPhase('seek');
  game.tagPlayer(h1.id);
  assert.equal(game.phase, 'over');
  assert.equal(game.winnerTeamId, h2.teamId);
  const over = events.find((e) => e.event === 'game:over');
  assert.equal(over.payload.winnerTeamName, 'Foxes');
});

test('tagging is a no-op outside seek phase and on seeker teams', () => {
  const { game } = makeGame();
  const { host, h1 } = setupTwoTeams(game);
  assert.equal(game.tagPlayer(h1.id), null); // lobby
  game.startPhase('seek');
  assert.equal(game.tagPlayer(host.id), null); // already a seeker
});

test('shrink event reduces boundary radius by shrinkFactor', () => {
  const { game } = makeGame();
  setupTwoTeams(game);
  game.configure({ boundary: { center: { lat: 51.5, lng: -0.12 }, radiusM: 200 } });
  game.startPhase('seek');
  game.trigger('shrink');
  assert.equal(game.boundary.radiusM, 120); // 200 * 0.6
});

test('hide phase auto-advances to seek when timer expires', () => {
  const { game } = makeGame();
  setupTwoTeams(game);
  game.startPhase('hide');
  game.tick(game.phaseEndsAt + 1);
  assert.equal(game.phase, 'seek');
});

test('seek timer expiry: surviving hiders win on time', () => {
  const { game, events } = makeGame();
  setupTwoTeams(game);
  game.startPhase('seek');
  game.tick(game.phaseEndsAt + 1);
  assert.equal(game.phase, 'over');
  const over = events.find((e) => e.event === 'game:over');
  assert.equal(over.payload.reason, 'time');
});

test('boundary: warning fires, grace expiry force-tags the team', () => {
  const { game, events } = makeGame();
  const { h1 } = setupTwoTeams(game);
  game.configure({
    boundary: { center: { lat: 51.5, lng: -0.12 }, radiusM: 100 },
    settings: { graceSeconds: 30 },
  });
  game.startPhase('seek');
  game.updatePosition(h1.id, { lat: 51.51, lng: -0.12 }); // ~1.1km out
  const t0 = Date.now();
  game.tick(t0);
  assert.ok(events.some((e) => e.event === 'boundary:warning'));
  assert.equal(game.teams.get(h1.teamId).role, 'hider'); // grace not expired
  game.tick(t0 + 31_000);
  assert.equal(game.teams.get(h1.teamId).role, 'seeker'); // forced tag
});

test('returning inside boundary clears the grace clock', () => {
  const { game } = makeGame();
  const { h1 } = setupTwoTeams(game);
  game.configure({
    boundary: { center: { lat: 51.5, lng: -0.12 }, radiusM: 100 },
    settings: { graceSeconds: 30 },
  });
  game.startPhase('seek');
  game.updatePosition(h1.id, { lat: 51.51, lng: -0.12 });
  const t0 = Date.now();
  game.tick(t0);
  game.updatePosition(h1.id, { lat: 51.5, lng: -0.12 }); // back inside
  game.tick(t0 + 10_000);
  game.updatePosition(h1.id, { lat: 51.51, lng: -0.12 }); // out again
  game.tick(t0 + 31_000); // 31s after t0 but grace clock restarted
  assert.equal(game.teams.get(h1.teamId).role, 'hider');
});

test('playerState never contains positions; refereeState does', () => {
  const { game } = makeGame();
  const { host, h1 } = setupTwoTeams(game);
  game.updatePosition(h1.id, { lat: 51.5, lng: -0.12 });
  const ps = game.playerState(host.id);
  assert.equal('positions' in ps, false);
  assert.equal(JSON.stringify(ps).includes('"lat"'), false, 'no raw coords in player view');
  const rs = game.refereeState();
  assert.equal(rs.positions.length, 1);
  assert.equal(rs.positions[0].playerId, h1.id);
});

test('reset to lobby restores caught teams to hiders', () => {
  const { game } = makeGame();
  const { h1 } = setupTwoTeams(game);
  game.startPhase('seek');
  game.tagPlayer(h1.id);
  game.startPhase('lobby');
  assert.equal(game.teams.get(h1.teamId).role, 'hider');
  assert.equal(game.winnerTeamId, null);
});
