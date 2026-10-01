import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from './game.js';

// ~0.00009° lat ≈ 10 m
const at = (m) => ({ lat: 42 + (m / 10) * 0.00009, lng: -93.6 });

function v2Game() {
  const game = new Game(() => {});
  const host = game.addPlayer({ name: 'Host', isHost: true });
  const seeker = game.addPlayer({ name: 'Sam', teamName: 'Seekers' });
  const hider = game.addPlayer({ name: 'Hana', teamName: 'Owls' });
  game.setTeamRole(seeker.teamId, 'seeker');
  game.configure({ mode: 'hideseek2', boundary: { center: at(0), radiusM: 300 } });
  game.startPhase('seek');
  return { game, host, seeker, hider };
}

test('V2 mode is lobby-only and V2 state is absent in classic mode', () => {
  const { game, seeker } = v2Game();
  game.configure({ mode: 'hideseek' }); // ignored: not in lobby
  assert.equal(game.mode, 'hideseek2');
  const classic = new Game(() => {});
  classic.addPlayer({ name: 'x' });
  assert.equal(classic.playerState(classic.players.keys().next().value).v2, undefined);
  assert.ok(game.playerState(seeker.id).v2);
});

test('hider drops a decoy: charges, cooldown, seeker sees it without owner', () => {
  const { game, seeker, hider } = v2Game();
  game.updatePosition(hider.id, at(100));
  const r = game.dropDecoy(hider.id, Date.now());
  assert.ok(r.decoy);
  assert.equal(game.dropDecoy(hider.id).error?.includes('recharging'), true);
  const s = game.playerState(seeker.id).v2;
  assert.equal(s.decoys.length, 1);
  assert.equal(s.decoys[0].playerId, undefined);
  assert.equal(s.decoys[0].teamId, undefined);
  assert.equal(game.playerState(hider.id).v2.charges, 2);
});

test('decoys rejected for seekers, outside seek phase, and without GPS', () => {
  const { game, seeker, hider } = v2Game();
  game.updatePosition(seeker.id, at(0));
  assert.ok(game.dropDecoy(seeker.id).error);
  assert.ok(game.dropDecoy(hider.id).error); // no fix yet
  game.phase = 'hide';
  game.updatePosition(hider.id, at(0));
  assert.ok(game.dropDecoy(hider.id).error);
});

test('decoys expire and are cleared when the team is caught', () => {
  const { game, hider } = v2Game();
  game.updatePosition(hider.id, at(100));
  const t0 = Date.now();
  game.dropDecoy(hider.id, t0);
  assert.equal(game.expireDecoys(t0 + 1000), false);
  assert.equal(game.expireDecoys(t0 + 151_000), true);
  game.dropDecoy(hider.id, t0 + 200_000);
  game.tagPlayer(hider.id, hider.id);
  assert.equal(game.decoys.length, 0);
});

test('heat counts decoys and never exposes distance or target type', () => {
  const { game, seeker, hider } = v2Game();
  game.updatePosition(seeker.id, at(0));
  game.updatePosition(hider.id, at(500)); // real hider far away
  assert.deepEqual(game.heatFor(seeker.id), { level: 0, close: false });
  // a decoy 10 m away makes the seeker burn even though the hider is far
  game.decoys.push({ id: 'dx', teamId: 'x', lat: at(10).lat, lng: at(10).lng, expiresAt: Date.now() + 9e4 });
  assert.deepEqual(game.heatFor(seeker.id), { level: 4, close: true });
  game.decoys = [];
  game.updatePosition(hider.id, at(30));
  assert.equal(game.heatFor(seeker.id).level, 2); // 30 m: ≤0.6×60 m, >0.35×60 m → warm
  assert.equal(game.heatFor(hider.id), null); // hiders get no heat
});
