/*
  Sonic Cognition v3
  ==================
  A drop-in high-level navigation / curiosity / learning agent for Sonic 1.

  DESIGN GOALS
  - Navigation first. Right is not the default answer.
  - Curiosity is deliberate information-seeking, not random jumping.
  - Death / damage / stalls change the next attempt.
  - Rings, useful monitors, checkpoints and giant rings are strategic goals.
  - Momentum is treated as a resource. The planner avoids needless braking.
  - Execution is separated from goal selection. The native controller remains
    responsible for exact frame-level collision response.
  - No gameplay state is edited by this module. It only returns intentions.

  INPUT (best-effort; missing fields are tolerated)
  {
    active, mode, locked, stage, physics,
    x, y, vx, vy, inertia, angle, status, routine,
    rings, emeralds, shield, invincible, shoes, lives, checkpoint,
    grounded, onPlatform, platformId, mechanic,
    objects: [{ id, x, y, subtype, routine, collision, render }],
    sensors: {
      floorAhead, floorFarAhead, floorBehind,
      wallAhead, wallBehind, ceiling,
      gapAhead, gapBehind,
      platformAbove: [{x,y,id}], platformBelow: [{x,y,id}]
    }
  }

  OUTPUT
  null, or:
  {
    goalType,
    skill,
    targetX, targetY,
    desiredSpeed,
    direction,          // -1 left, +1 right, 0 neutral
    jump, jumpHold,
    waitFrames,
    commitmentFrames,
    allowBacktrack,
    reason,
    debug
  }
*/

(function (root) {
  "use strict";

  const VERSION = 3;
  const MAX_MAPS = 32;
  const MAX_NODES = 1800;
  const MAX_EPISODES = 2600;
  const CELL_X = 56;
  const CELL_Y = 44;
  const DEFAULT_REACTION = 4;

  const OBJECT = {
    RING: 0x25,
    LOST_RING: 0x37,
    MONITOR: 0x26,
    SPRING: 0x41,
    GIANT_RING: 0x4b,
    PLATFORM: 0x18,
    CHECKPOINT: 0x79,
    SPIKES: 0x36,
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const abs = Math.abs;
  const dist = (a, b) => abs(a.x - b.x) + abs(a.y - b.y);
  const sign = v => (v > 0 ? 1 : v < 0 ? -1 : 0);
  const bucket = (v, size) => Math.floor(v / size);

  function groundedOf(s) {
    return s.grounded != null ? !!s.grounded : !(s.status & 2);
  }

  function stageKey(s) {
    return `${s.stage}:${typeof s.physics === "string" ? s.physics : JSON.stringify(s.physics || "normal")}`;
  }

  function nodeId(x, y) {
    return `${bucket(x, CELL_X)},${bucket(y, CELL_Y)}`;
  }

  function safeArray(x) {
    return Array.isArray(x) ? x : [];
  }

  function speedBucket(v) {
    const a = abs(v || 0);
    if (a < 0x180) return "slow";
    if (a < 0x380) return "medium";
    if (a < 0x600) return "fast";
    return "veryfast";
  }

  function directionBucket(v) {
    return v < -40 ? "left" : v > 40 ? "right" : "still";
  }

  function localFingerprint(s) {
    const sensors = s.sensors || {};
    const nearby = safeArray(s.objects)
      .filter(o => abs((o.x || 0) - s.x) < 140 && abs((o.y || 0) - s.y) < 100)
      .map(o => `${o.id}:${bucket((o.x || 0) - s.x, 28)}:${bucket((o.y || 0) - s.y, 28)}`)
      .sort()
      .slice(0, 8)
      .join("|");
    return [
      bucket(s.x || 0, 96),
      bucket(s.y || 0, 72),
      speedBucket(s.inertia || s.vx || 0),
      bucket(s.angle || 0, 32),
      bucket(Number.isFinite(sensors.wallAhead) ? sensors.wallAhead : 255, 16),
      bucket(Number.isFinite(sensors.floorAhead) ? sensors.floorAhead : 0, 16),
      nearby,
    ].join("/");
  }

  class EpisodicMemory {
    constructor(saved) {
      this.data = {};
      if (saved && typeof saved === "object") {
        for (const [k, v] of Object.entries(saved).slice(-MAX_EPISODES)) {
          if (!v || typeof v !== "object") continue;
          this.data[k] = {
            tries: clamp(Number(v.tries) || 0, 0, 9999),
            score: clamp(Number(v.score) || 0, -30, 30),
            deaths: clamp(Number(v.deaths) || 0, 0, 99),
            stalls: clamp(Number(v.stalls) || 0, 0, 99),
            damage: clamp(Number(v.damage) || 0, 0, 99),
            successes: clamp(Number(v.successes) || 0, 0, 999),
          };
        }
      }
    }

    get(key) {
      return this.data[key] || { tries: 0, score: 0, deaths: 0, stalls: 0, damage: 0, successes: 0 };
    }

    update(key, reward, kind = "result") {
      if (!key) return;
      if (!this.data[key]) {
        if (Object.keys(this.data).length >= MAX_EPISODES) delete this.data[Object.keys(this.data)[0]];
        this.data[key] = { tries: 0, score: 0, deaths: 0, stalls: 0, damage: 0, successes: 0 };
      }
      const e = this.data[key];
      e.tries++;
      e.score += (clamp(reward, -20, 20) - e.score) / Math.min(e.tries, 8);
      if (kind === "death") e.deaths++;
      if (kind === "stall") e.stalls++;
      if (kind === "damage") e.damage++;
      if (kind === "success") e.successes++;
    }
  }

  class WorldModel {
    constructor(saved) {
      this.maps = {};
      if (saved && typeof saved === "object") {
        for (const [key, val] of Object.entries(saved).slice(-MAX_MAPS)) {
          if (!val?.nodes) continue;
          this.maps[key] = val;
        }
      }
    }

    map(key) {
      if (!this.maps[key]) {
        if (Object.keys(this.maps).length >= MAX_MAPS) delete this.maps[Object.keys(this.maps)[0]];
        this.maps[key] = { nodes: {}, visits: 0 };
      }
      return this.maps[key];
    }

    node(map, x, y, kind = "ground") {
      const id = nodeId(x, y);
      let n = map.nodes[id];
      if (!n) {
        if (Object.keys(map.nodes).length >= MAX_NODES) delete map.nodes[Object.keys(map.nodes)[0]];
        n = map.nodes[id] = {
          id, x, y, kind,
          visits: 0,
          deaths: 0,
          discoveries: 0,
          edges: {},
          frontiers: { left: 0, right: 0, up: 0, down: 0 },
        };
      }
      n.x = Math.round((n.x * 3 + x) / 4);
      n.y = Math.round((n.y * 3 + y) / 4);
      n.kind = kind || n.kind;
      return n;
    }

    addEdge(from, to, method, meta = {}) {
      if (!from || !to || from.id === to.id) return;
      const prev = from.edges[to.id] || {};
      from.edges[to.id] = {
        to: to.id,
        method,
        traversals: (prev.traversals || 0) + 1,
        successes: (prev.successes || 0) + (meta.success ? 1 : 0),
        failures: (prev.failures || 0),
        avgTime: prev.avgTime == null ? (meta.time || 1) : prev.avgTime * 0.8 + (meta.time || prev.avgTime) * 0.2,
        avgSpeed: prev.avgSpeed == null ? abs(meta.speed || 0) : prev.avgSpeed * 0.8 + abs(meta.speed || 0) * 0.2,
        risk: clamp(prev.risk == null ? 0 : prev.risk, 0, 20),
      };
      // walking and rides are generally reversible because they were physically traversed.
      if (method === "walk" || method === "ride") {
        const back = to.edges[from.id] || {};
        to.edges[from.id] = {
          to: from.id,
          method,
          traversals: (back.traversals || 0) + 1,
          successes: (back.successes || 0) + (meta.success ? 1 : 0),
          failures: back.failures || 0,
          avgTime: back.avgTime == null ? (meta.time || 1) : back.avgTime * 0.8 + (meta.time || back.avgTime) * 0.2,
          avgSpeed: back.avgSpeed == null ? abs(meta.speed || 0) : back.avgSpeed * 0.8 + abs(meta.speed || 0) * 0.2,
          risk: clamp(back.risk == null ? 0 : back.risk, 0, 20),
        };
      }
    }

    penalizeEdge(map, fromId, toId, severity = 1) {
      const edge = map.nodes[fromId]?.edges?.[toId];
      if (!edge) return;
      edge.failures = (edge.failures || 0) + severity;
      edge.risk = clamp((edge.risk || 0) + severity * 2, 0, 20);
    }

    path(map, startId, goalId, curiosity = false) {
      if (!map.nodes[startId] || !map.nodes[goalId]) return null;
      const q = [{ id: startId, cost: 0 }];
      const best = { [startId]: 0 };
      const prev = {};
      while (q.length) {
        q.sort((a, b) => a.cost - b.cost);
        const cur = q.shift();
        if (cur.id === goalId) break;
        if (cur.cost !== best[cur.id]) continue;
        const node = map.nodes[cur.id];
        for (const e of Object.values(node.edges || {})) {
          const dest = map.nodes[e.to];
          if (!dest) continue;
          const novelty = curiosity ? -(1 / (1 + (dest.visits || 0))) * 1.5 : 0;
          const c = cur.cost + 1 + (e.risk || 0) * 3 + (e.failures || 0) * 5 + novelty;
          if (c < (best[e.to] ?? Infinity)) {
            best[e.to] = c;
            prev[e.to] = cur.id;
            q.push({ id: e.to, cost: c });
          }
        }
      }
      if (!(goalId in best)) return null;
      const out = [];
      let at = goalId;
      while (at !== startId) {
        out.unshift(at);
        at = prev[at];
        if (at == null) return null;
      }
      return out;
    }
  }

  class SonicCognitionV3 {
    constructor(saved, logger = null) {
      this.logger = logger;
      this.world = new WorldModel(saved?.world);
      this.episodes = new EpisodicMemory(saved?.episodes);
      this.clock = 0;
      this.dirty = false;
      this.message = "Observing";
      this.resetEpisode();
    }

    resetEpisode() {
      this.last = null;
      this.lastNode = null;
      this.airStart = null;
      this.goal = null;
      this.route = [];
      this.activeAttempt = null;
      this.visible = {};
      this.stallWindow = [];
      this.commitUntil = 0;
      this.reactionUntil = 0;
      this.lastIntent = null;
      this.lastCheckpoint = null;
      this.lastStageKey = null;
    }

    export() {
      return {
        version: VERSION,
        world: this.world.maps,
        episodes: this.episodes.data,
      };
    }

    attemptKey(s, goal, profile) {
      return `${stageKey(s)}|${localFingerprint(s)}|${goal?.type || "none"}|${goal?.direction || "none"}|${profile}`;
    }

    observeMap(s, map) {
      const grounded = groundedOf(s);
      if (!grounded) {
        if (!this.airStart && this.lastNode) {
          this.airStart = {
            nodeId: this.lastNode.id,
            x: this.last?.x ?? s.x,
            y: this.last?.y ?? s.y,
            speed: this.last?.inertia ?? this.last?.vx ?? 0,
            tick: this.clock,
            method: s.onPlatform ? "ride" : "jump",
          };
        }
        return;
      }

      const n = this.world.node(map, s.x, s.y, s.onPlatform ? "platform" : "ground");
      n.visits++;

      if (this.airStart) {
        const from = map.nodes[this.airStart.nodeId];
        this.world.addEdge(from, n, this.airStart.method, {
          success: true,
          time: this.clock - this.airStart.tick,
          speed: this.airStart.speed,
        });
        this.airStart = null;
        this.dirty = true;
      } else if (this.lastNode && this.lastNode.id !== n.id) {
        const dx = abs(n.x - this.lastNode.x);
        const dy = abs(n.y - this.lastNode.y);
        if (dx <= 130 && dy <= 28) {
          this.world.addEdge(this.lastNode, n, "walk", {
            success: true,
            time: 1,
            speed: s.inertia || s.vx || 0,
          });
          this.dirty = true;
        }
      }
      this.lastNode = n;
    }

    inferFrontiers(s, map) {
      if (!this.lastNode || !groundedOf(s)) return;
      const n = this.lastNode;
      const q = s.sensors || {};

      const front = (dir, plausible, blocked) => {
        if (blocked) n.frontiers[dir] = -1;
        else if (plausible && n.frontiers[dir] === 0) n.frontiers[dir] = 1;
      };

      front("right",
        (!Number.isFinite(q.wallAhead) || q.wallAhead > 24) && (!Number.isFinite(q.floorAhead) || abs(q.floorAhead) < 34),
        Number.isFinite(q.wallAhead) && q.wallAhead < 8);

      front("left",
        (!Number.isFinite(q.wallBehind) || q.wallBehind > 24) && (!Number.isFinite(q.floorBehind) || abs(q.floorBehind) < 34),
        Number.isFinite(q.wallBehind) && q.wallBehind < 8);

      if (safeArray(q.platformAbove).some(p => abs(p.x - s.x) < 210 && p.y < s.y - 28)) n.frontiers.up = 1;
      if (safeArray(q.platformBelow).some(p => abs(p.x - s.x) < 210 && p.y > s.y + 28)) n.frontiers.down = 1;

      // Consume a frontier once a real edge demonstrates that direction was explored.
      for (const e of Object.values(n.edges || {})) {
        const o = map.nodes[e.to];
        if (!o) continue;
        const dx = o.x - n.x, dy = o.y - n.y;
        if (abs(dx) >= abs(dy)) n.frontiers[dx >= 0 ? "right" : "left"] = 0;
        else n.frontiers[dy >= 0 ? "down" : "up"] = 0;
      }
    }

    perceiveItems(s) {
      for (const o of safeArray(s.objects)) {
        let kind = null;
        if ((o.id === OBJECT.RING || o.id === OBJECT.LOST_RING) && o.routine === 2) kind = "ring";
        else if (o.id === OBJECT.MONITOR && o.routine <= 2 && o.subtype >= 2 && o.subtype <= 6) kind = "monitor";
        else if (o.id === OBJECT.CHECKPOINT && o.routine <= 2) kind = "checkpoint";
        else if (o.id === OBJECT.GIANT_RING && o.routine <= 2) kind = "portal";
        if (!kind) continue;
        const key = `${kind}:${o.x}:${o.y}:${o.subtype || 0}`;
        this.visible[key] = { ...o, kind, key, seen: this.clock };
      }
      for (const [k, o] of Object.entries(this.visible)) {
        const ttl = o.id === OBJECT.LOST_RING ? 3 : 20;
        if (this.clock - o.seen > ttl) delete this.visible[k];
      }
    }

    itemUtility(item, s) {
      if (item.kind === "ring") {
        if (item.id === OBJECT.LOST_RING && (s.rings || 0) === 0) return 1800;
        if ((s.rings || 0) === 0) return 1300;
        if ((s.rings || 0) < 10) return 420;
        if ((s.rings || 0) < 25) return 190;
        if ((s.rings || 0) < 50 && (s.emeralds || 0) < 6) return 135;
        return 20;
      }
      if (item.kind === "checkpoint") return 390;
      if (item.kind === "portal") return (s.rings || 0) >= 50 && (s.emeralds || 0) < 6 ? 2200 : 0;
      if (item.kind === "monitor") {
        if (item.subtype === 2) return 340; // life
        if (item.subtype === 3) return s.shoes ? 0 : 85;
        if (item.subtype === 4) return s.shield ? 0 : 520;
        if (item.subtype === 5) return s.invincible ? 0 : 390;
        if (item.subtype === 6) return (s.rings || 0) < 50 ? 360 : 90;
      }
      return 0;
    }

    ringClusters(s) {
      const rings = Object.values(this.visible).filter(o => o.kind === "ring");
      const clusters = [];
      for (const r of rings) {
        let c = clusters.find(c => abs(c.x - r.x) < 100 && abs(c.y - r.y) < 70);
        if (!c) clusters.push(c = { kind: "ringCluster", x: r.x, y: r.y, count: 0, members: [] });
        c.count++;
        c.members.push(r);
        c.x = c.members.reduce((a, b) => a + b.x, 0) / c.count;
        c.y = c.members.reduce((a, b) => a + b.y, 0) / c.count;
      }
      return clusters;
    }

    chooseResourceGoal(s, map) {
      if (!this.lastNode) return null;
      const candidates = [];

      for (const item of Object.values(this.visible)) {
        const utility = this.itemUtility(item, s);
        if (!utility) continue;
        candidates.push({ type: "resource", item, x: item.x, y: item.y, utility, label: item.kind });
      }

      // Prefer a useful cluster instead of zig-zagging between individual rings.
      // Enter from the nearest edge of the trail instead of steering at its centroid.
      for (const c of this.ringClusters(s)) {
        const survival = (s.rings || 0) === 0 ? 1200 : (s.rings || 0) < 10 ? 350 : 90;
        const ordered = c.members.slice().sort((a,b)=>Math.hypot(a.x-s.x,a.y-s.y)-Math.hypot(b.x-s.x,b.y-s.y));
        const entry = ordered[0] || c;
        candidates.push({
          type: "resource", item: c, x: entry.x, y: entry.y,
          sweepX: c.x, sweepY: c.y,
          utility: survival + c.count * 35, label: "ring cluster"
        });
      }

      let best = null, bestScore = -Infinity;
      for (const c of candidates) {
        const dx = c.x - s.x, dy = c.y - s.y;
        if (abs(dx) > 760 || dy < -220 || dy > 160) continue;

        const targetId = nodeId(c.x, c.y);
        let path = null;
        if (abs(dx) > 180) path = this.world.path(map, this.lastNode.id, targetId);
        if (abs(dx) > 180 && !path) continue;

        const riskyObjects = safeArray(s.objects).filter(o =>
          (o.id === OBJECT.SPIKES || ((o.collision || 0) & 0xc0) === 0x80) &&
          o.x > Math.min(s.x, c.x) - 20 && o.x < Math.max(s.x, c.x) + 20 &&
          abs(o.y - c.y) < 60
        );
        if (riskyObjects.length && c.utility < 700) continue;

        const key = this.attemptKey(s, c, "resource");
        const mem = this.episodes.get(key);
        const score = c.utility - abs(dx) * 0.22 - abs(dy) * 0.6 - (path?.length || 0) * 8 + mem.score * 18 - mem.deaths * 180;
        if (score > bestScore) {
          bestScore = score;
          best = { ...c, path, score, attemptKey: key, started: this.clock, bestDist: abs(dx) + abs(dy) };
        }
      }
      return best;
    }

    frontierGoals(s, map) {
      if (!this.lastNode) return [];
      const goals = [];
      for (const n of Object.values(map.nodes)) {
        for (const dir of ["left", "right", "up", "down"]) {
          if (n.frontiers?.[dir] !== 1) continue;
          const route = n.id === this.lastNode.id ? [] : this.world.path(map, this.lastNode.id, n.id, true);
          if (n.id !== this.lastNode.id && !route) continue;

          const keyBase = `${stageKey(s)}:${n.id}:${dir}`;
          const profiles = this.profilesFor(dir);
          const learned = profiles
            .map(p => ({ p, m: this.episodes.get(`${keyBase}:${p.name}`) }))
            .sort((a, b) => this.profileValue(b.m) - this.profileValue(a.m));
          const bestProfile = learned[0];

          const novelty = 320 / (1 + (n.visits || 0));
          const vertical = (dir === "up" || dir === "down") ? 120 : 0;
          const backtrack = dir === "left" || n.x < s.x - 100 ? 75 : 0;
          const antiRightBias = dir === "right" ? -35 : 0;
          const routeCost = (route?.length || 0) * 9;
          const memory = bestProfile ? this.profileValue(bestProfile.m) * 22 : 0;

          goals.push({
            type: "frontier", node: n, direction: dir, route,
            profile: bestProfile?.p || profiles[0],
            score: novelty + vertical + backtrack + antiRightBias - routeCost + memory,
            keyBase,
            started: this.clock,
          });
        }
      }
      goals.sort((a, b) => b.score - a.score);
      return goals;
    }

    profilesFor(dir) {
      if (dir === "up") return [
        { name: "runup-full-jump", runup: 110, speed: 0x430, jumpHold: 24, wait: 0 },
        { name: "short-jump", runup: 45, speed: 0x300, jumpHold: 13, wait: 0 },
        { name: "patient-jump", runup: 80, speed: 0x360, jumpHold: 20, wait: 12 },
      ];
      if (dir === "down") return [
        { name: "controlled-drop", runup: 0, speed: 0x180, jumpHold: 0, wait: 8 },
        { name: "small-forward-drop", runup: 20, speed: 0x240, jumpHold: 5, wait: 0 },
      ];
      return [
        { name: "momentum-run", runup: 0, speed: 0x500, jumpHold: 0, wait: 0 },
        { name: "cautious-run", runup: 0, speed: 0x300, jumpHold: 0, wait: 4 },
        { name: "probe-jump", runup: 55, speed: 0x380, jumpHold: 14, wait: 0 },
      ];
    }

    profileValue(mem) {
      if (!mem) return 0;
      return mem.score + mem.successes * 0.3 - mem.deaths * 1.8 - mem.stalls * 0.7 - mem.damage * 0.5;
    }

    chooseFrontierGoal(s, map, stalled) {
      const goals = this.frontierGoals(s, map);
      if (!goals.length) return null;

      // Deliberate curiosity: near-equal choices alternate based on experience,
      // not random input. Repeated rightward travel makes old left/up branches rise.
      const top = goals[0];
      if (goals[1] && goals[1].score > top.score - 25) {
        const a = this.episodes.get(`${top.keyBase}:${top.profile.name}`);
        const b = this.episodes.get(`${goals[1].keyBase}:${goals[1].profile.name}`);
        if (b.tries < a.tries) return goals[1];
      }

      if (stalled) return top;
      return top.score > 85 ? top : null;
    }

    updateGoalOutcome(s, map, stalled) {
      if (!this.goal) return;
      const g = this.goal;
      const hurt = s.routine >= 4 && (this.last?.routine ?? 2) < 4;
      const dead = s.routine >= 6 && (this.last?.routine ?? 2) < 6;

      if (hurt || dead) {
        const severity = dead ? -12 : -6;
        const key = g.attemptKey || (g.keyBase && `${g.keyBase}:${g.profile?.name}`);
        this.episodes.update(key, severity, dead ? "death" : "damage");
        if (this.activeAttempt?.from && this.activeAttempt?.to) {
          this.world.penalizeEdge(map, this.activeAttempt.from, this.activeAttempt.to, dead ? 3 : 1);
        }
        if (this.lastNode) this.lastNode.deaths = (this.lastNode.deaths || 0) + (dead ? 1 : 0);
        this.message = dead ? "That route killed me. Changing the next attempt." : "That approach hurt. Lowering its confidence.";
        this.logger?.add(dead ? "death" : "damage", s, {tick:this.clock, goal:g, intent:this.lastIntent, attemptKey:key, profile:g.profile?.name, reason:this.message, context:{from:this.activeAttempt?.from||null,to:this.activeAttempt?.to||null}});
        this.goal = null;
        this.route = [];
        this.activeAttempt = null;
        this.commitUntil = 0;
        this.dirty = true;
        return;
      }

      if (g.type === "resource") {
        const d = abs(g.x - s.x) + abs(g.y - s.y);
        const gained =
          (s.rings || 0) > (this.last?.rings || 0) ||
          !!s.shield > !!this.last?.shield ||
          !!s.invincible > !!this.last?.invincible ||
          !!s.shoes > !!this.last?.shoes ||
          (s.lives || 0) > (this.last?.lives || 0) ||
          s.checkpoint !== this.last?.checkpoint ||
          s.mode === 16;

        if (gained && d < 180) {
          this.episodes.update(g.attemptKey, 8, "success");
          this.message = "Resource detour worked.";
          this.logger?.add("success", s, {tick:this.clock, goal:g, intent:this.lastIntent, attemptKey:g.attemptKey, profile:g.profile?.name, reason:this.message});
          this.goal = null;
          this.route = [];
          this.dirty = true;
          return;
        }
        if (d < g.bestDist - 10) {
          g.bestDist = d;
          g.started = this.clock;
        } else if (this.clock - g.started > 70 || stalled) {
          this.episodes.update(g.attemptKey, -5, "stall");
          this.message = "That pickup approach stalled. Abandoning it.";
          this.logger?.add("failed_resource", s, {tick:this.clock, goal:g, intent:this.lastIntent, attemptKey:g.attemptKey, profile:g.profile?.name, reason:this.message});
          this.goal = null;
          this.route = [];
          this.dirty = true;
        }
      }

      if (g.type === "frontier") {
        if (g.route?.length) {
          const next = map.nodes[g.route[0]];
          if (next && dist(next, s) < 46) g.route.shift();
        }

        const atJunction = abs(s.x - g.node.x) < 58 && abs(s.y - g.node.y) < 58;
        if (atJunction && !g.arrived) {
          g.arrived = this.clock;
          this.activeAttempt = {
            from: g.node.id,
            to: null,
            startX: s.x,
            startY: s.y,
            profile: g.profile.name,
          };
        }

        // Discovery means a new map node appeared beyond the chosen frontier.
        if (g.arrived && this.lastNode && this.lastNode.id !== g.node.id) {
          const dx = this.lastNode.x - g.node.x;
          const dy = this.lastNode.y - g.node.y;
          const matches =
            (g.direction === "left" && dx < -45) ||
            (g.direction === "right" && dx > 45) ||
            (g.direction === "up" && dy < -35) ||
            (g.direction === "down" && dy > 35);
          if (matches) {
            g.node.frontiers[g.direction] = 0;
            g.node.discoveries = (g.node.discoveries || 0) + 1;
            this.episodes.update(`${g.keyBase}:${g.profile.name}`, 10, "success");
            this.message = `Discovered a real ${g.direction} route.`;
            this.logger?.add("discovery", s, {tick:this.clock, goal:g, intent:this.lastIntent, attemptKey:`${g.keyBase}:${g.profile.name}`, profile:g.profile.name, reason:this.message});
            this.goal = null;
            this.route = [];
            this.activeAttempt = null;
            this.dirty = true;
            return;
          }
        }

        if (g.arrived && (this.clock - g.arrived > 85 || stalled)) {
          this.episodes.update(`${g.keyBase}:${g.profile.name}`, -6, "stall");
          // Keep the frontier alive so a DIFFERENT profile can try it later.
          this.message = `The ${g.profile.name} attempt failed. Trying another technique later.`;
          this.logger?.add("failed_frontier", s, {tick:this.clock, goal:g, intent:this.lastIntent, attemptKey:`${g.keyBase}:${g.profile.name}`, profile:g.profile.name, reason:this.message});
          this.goal = null;
          this.route = [];
          this.activeAttempt = null;
          this.dirty = true;
        }
      }
    }

    jumpPlan(s, target, profile) {
      const dx = target.x - s.x;
      const dy = target.y - s.y;
      const dir = sign(dx) || 1;
      const horizontal = abs(dx);
      const verticalUp = Math.max(0, -dy);

      // Coarse model predictive controller. It does not pretend to know exact
      // Sonic physics; it chooses a conservative execution profile and lets the
      // native collision controller verify the maneuver.
      let desiredSpeed = profile?.speed || 0x380;
      let hold = profile?.jumpHold || 0;
      let jump = false;

      if (verticalUp > 24 || horizontal > 105) {
        jump = true;
        if (!hold) hold = verticalUp > 80 ? 24 : horizontal > 180 ? 22 : 14;
        if (horizontal > 220) desiredSpeed = Math.max(desiredSpeed, 0x500);
      }

      if ((s.sensors?.ceiling ?? 999) < 24) {
        jump = false;
        hold = 0;
      }

      return { direction: dir, desiredSpeed, jump, jumpHold: hold };
    }

    intentForGoal(s, map) {
      const g = this.goal;
      if (!g) return null;

      if (g.route?.length) {
        const n = map.nodes[g.route[0]];
        if (n) {
          const jp = this.jumpPlan(s, n, { speed: 0x380, jumpHold: 0 });
          return {
            goalType: g.type === "frontier" ? "explore" : g.type,
            skill: "follow-known-route",
            targetX: n.x,
            targetY: n.y,
            ...jp,
            waitFrames: 0,
            commitmentFrames: 18,
            allowBacktrack: true,
            reason: `Backtracking through ${g.route.length} learned route node(s)`,
          };
        }
      }

      if (g.type === "resource") {
        const jp = this.jumpPlan(s, g, { speed: abs(g.x - s.x) < 100 ? 0x260 : 0x3c0, jumpHold: g.item.kind === "monitor" ? 18 : 0 });
        return {
          goalType: "resource",
          skill: g.item.kind === "monitor" ? "attack-monitor" : "collect-resource",
          targetX: g.x,
          targetY: g.y,
          ...jp,
          jump: jp.jump || g.item.kind === "monitor",
          jumpHold: g.item.kind === "monitor" ? Math.max(16, jp.jumpHold) : jp.jumpHold,
          waitFrames: 0,
          commitmentFrames: 22,
          allowBacktrack: true,
          reason: g.label === "ring cluster"
            ? `Entering the nearest edge of a ring trail (${s.rings || 0} rings now)`
            : `Pursuing ${g.label}${g.x < s.x - 30 ? " behind us" : ""}`,
        };
      }

      // First reach the old junction, then deliberately enter its unseen branch.
      const profile = g.profile || this.profilesFor(g.direction)[0];
      const offsets = {
        left: { x: -170, y: 0 },
        right: { x: 170, y: 0 },
        up: { x: 85, y: -130 },
        down: { x: 70, y: 130 },
      };
      const o = offsets[g.direction];
      const target = { x: g.node.x + o.x, y: g.node.y + o.y };
      const jp = this.jumpPlan(s, target, profile);

      return {
        goalType: "explore",
        skill: profile.name,
        targetX: target.x,
        targetY: target.y,
        direction: g.direction === "left" ? -1 : g.direction === "right" ? 1 : jp.direction,
        desiredSpeed: profile.speed,
        jump: g.direction === "up" ? true : jp.jump,
        jumpHold: g.direction === "up" ? profile.jumpHold : jp.jumpHold,
        waitFrames: profile.wait || 0,
        commitmentFrames: 34,
        allowBacktrack: true,
        reason: g.direction === "left"
          ? `Curiosity: returning left to test an unexplored branch with ${profile.name}`
          : `Curiosity: testing an unexplored ${g.direction} branch with ${profile.name}`,
      };
    }

    shouldPreserveMomentum(s) {
      const grounded = groundedOf(s);
      if (!grounded) return true;
      if (((s.angle || 0) + 16 & 255) > 32) return true;
      if (abs(s.inertia || s.vx || 0) > 0x600) return true;
      if (s.mechanic && ![7, 10].includes(s.mechanic)) return true;
      return false;
    }

    observe(s) {
      this.clock++;
      if (!s || !s.active) {
        this.resetEpisode();
        return null;
      }
      if (s.mode !== 12 || s.locked) {
        this.goal = null;
        this.route = [];
        this.last = s;
        return null;
      }

      const key = stageKey(s);
      if (this.lastStageKey && this.lastStageKey !== key) this.resetEpisode();
      this.lastStageKey = key;
      const map = this.world.map(key);
      map.visits = (map.visits || 0) + 1;

      this.observeMap(s, map);
      this.inferFrontiers(s, map);
      this.perceiveItems(s);

      this.stallWindow.push({ x: s.x, y: s.y });
      if (this.stallWindow.length > 55) this.stallWindow.shift();
      const stalled = this.stallWindow.length === 55 && this.stallWindow.every(p => abs(p.x - s.x) < 34 && abs(p.y - s.y) < 34);

      this.updateGoalOutcome(s, map, stalled);

      // Keep a human-like commitment. Do not change goal every observation.
      if (this.clock < this.commitUntil && this.lastIntent && !stalled && s.routine < 4) {
        this.last = { ...s };
        return this.lastIntent;
      }

      // Momentum is valuable. We only interrupt it for survival or an already
      // committed route; optional curiosity waits for a controllable moment.
      const preserveMomentum = this.shouldPreserveMomentum(s);
      if (!this.goal && !preserveMomentum) {
        const resource = this.chooseResourceGoal(s, map);
        const frontier = this.chooseFrontierGoal(s, map, stalled);
        const resourceUrgent = resource && resource.score > 500;

        if (resourceUrgent) this.goal = resource;
        else if (frontier && frontier.score > (resource?.score ?? -Infinity) + 20) this.goal = frontier;
        else if (resource) this.goal = resource;
        else if (frontier) this.goal = frontier;
      }

      if (preserveMomentum && !this.goal) {
        this.message = "Keeping momentum through committed terrain";
        this.last = { ...s };
        this.lastIntent = null;
        return null;
      }

      const intent = this.intentForGoal(s, map);
      if (intent) {
        this.message = intent.reason;
        this.commitUntil = this.clock + (intent.commitmentFrames || DEFAULT_REACTION);
        this.lastIntent = intent;
      } else {
        this.message = stalled ? "Stalled: searching remembered branches instead of jumping randomly" : "Mapping routes and waiting for a meaningful decision";
        this.lastIntent = null;
      }

      this.last = { ...s };
      this.dirty = true;
      return intent;
    }
  }

  if (typeof module === "object" && module.exports) module.exports = SonicCognitionV3;
  else root.SonicCognitionV3 = SonicCognitionV3;
})(typeof window === "object" ? window : globalThis);
