/** The Office: a pixel-art studio on a 280 x 156 canvas (an exact 3x on a Retina screen).
 *  Observer, Builder and Reviewer work at their desks and pass a glowing baton. Real time of day shows in the
 *  windows. When Relay needs you, the Observer carries the baton to the door and its sign turns amber.
 *  Extra one-shot effects (pulse): retry, decision, approved, start. Music keeps its headphones, notes and meter. */
const W = 280;
const H = 156;
const ROLES = ['observer', 'builder', 'reviewer'];
const WALL = 56; // where the wall meets the floor
const DESK_W = 52;
const DESK_X = { observer: 14, builder: 141, reviewer: 210 };
const HOME = { observer: 54, builder: 181, reviewer: 250 };
const GATE_X = 103;
const SEAT_Y = 62;
const WALK_Y = 84;
const DESK_TOP = 90;
const COLORS = {
  observer: { body: '#2a7f92', dark: '#1e5f6f', glow: '#4db6c9', hair: '#2b1d14' },
  builder: { body: '#d3822a', dark: '#a8631a', glow: '#f0a63f', hair: '#4a2f1a' },
  reviewer: { body: '#6a58c9', dark: '#4f3fa6', glow: '#a18bf0', hair: '#1c1c2a' }
};
const SKIN = '#f1c9a5';
const SKIN_DARK = '#d9a982';
const AMBER = '#f2b24c';
const GREEN = '#4fb594';
const RED = '#ef6b6b';
const PURPLE = '#a18bf0';

const GLYPHS = {
  Z: ['111', '001', '010', '100', '111'],
  CHECK: ['0001', '0010', '1100', '0100'],
  NOTE: ['0011', '0010', '0010', '1110', '1110'],
  A: ['010', '101', '111', '101', '101'],
  U: ['101', '101', '101', '101', '111'],
  T: ['111', '010', '010', '010', '010'],
  O: ['111', '101', '101', '101', '111'],
  Q: ['111', '001', '011', '000', '010']
};

// Sky colours through the day: [hour, top, bottom, stars]
const SKY = [
  [0, '#070d1d', '#14223a', 1], [5, '#0b1530', '#1f2f52', 0.8], [6.5, '#3a3f6a', '#d98d6b', 0.25], [8, '#2f5f96', '#7fb4d6', 0],
  [13, '#2c5d96', '#78aed6', 0], [17, '#3a4f86', '#c98a74', 0.05], [19, '#2a2d5c', '#d9805c', 0.3], [20.5, '#101a36', '#2b3a66', 0.8], [24, '#070d1d', '#14223a', 1]
];

function hash(n) {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const hex = c => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
function mix(a, b, k) {
  const x = hex(a), y = hex(b);
  return '#' + [0, 1, 2].map(i => Math.round(x[i] + (y[i] - x[i]) * k).toString(16).padStart(2, '0')).join('');
}

function skyAt(hour) {
  for (let i = 1; i < SKY.length; i++) {
    if (hour <= SKY[i][0]) {
      const [h0, t0, b0, s0] = SKY[i - 1];
      const [h1, t1, b1, s1] = SKY[i];
      const k = (hour - h0) / (h1 - h0);
      return { top: mix(t0, t1, k), bottom: mix(b0, b1, k), stars: s0 + (s1 - s0) * k };
    }
  }
  return { top: SKY[0][1], bottom: SKY[0][2], stars: 1 };
}

export function createRoom(canvas, { reducedMotion = false, now = () => performance.now(), clock = () => new Date() } = {}) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const agents = Object.fromEntries(ROLES.map(role => [role, { x: HOME[role], y: SEAT_Y }]));
  const baton = { x: HOME.observer + 8, y: SEAT_Y + 26, trail: [] };
  const particles = [];
  let scene = { actor: null, terminal: null, auto: false, steps: [] };
  let music = false;
  let previousTerminal = null;
  let holder = 'observer';
  let timer = null;
  let last = 0;
  let transitionAt = -10;
  let transitionFrom = { x: baton.x, y: baton.y };
  let sceneKey = '';
  let effect = { type: null, at: -10 };
  let lampsOn = 1;
  const focus = Object.fromEntries(ROLES.map(role => [role, 1]));

  const rect = (x, y, w, h, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), w, h);
  };
  const alpha = (a, draw) => {
    const before = ctx.globalAlpha;
    ctx.globalAlpha = before * a;
    draw();
    ctx.globalAlpha = before;
  };
  const glyph = (rows, x, y, color, size = 1) => {
    rows.forEach((row, j) => [...row].forEach((bit, i) => bit === '1' && rect(x + i * size, y + j * size, size, size, color)));
  };
  const text = (word, x, y, color, size = 1) => {
    let cx = x;
    for (const letter of word) {
      const rows = GLYPHS[letter];
      glyph(rows, cx, y, color, size);
      cx += (rows[0].length + 1) * size;
    }
  };
  const glow = (x, y, r, color, a, additive = true) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'transparent');
    ctx.save();
    if (additive) ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = ctx.globalAlpha * a;
    ctx.fillStyle = g;
    ctx.fillRect(Math.floor(x - r), Math.floor(y - r), Math.ceil(r * 2), Math.ceil(r * 2));
    ctx.restore();
  };
  const ring = (x, y, rx, ry, color, a, width = 0.8) => {
    ctx.save();
    ctx.globalAlpha = ctx.globalAlpha * a;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  };
  const stateColor = () => scene.actor === 'you' ? AMBER : scene.terminal === 'done' ? GREEN : scene.terminal === 'failed' ? RED : null;
  const activeRole = () => ROLES.includes(scene.actor) ? scene.actor : null;

  function setScene(next) {
    const key = [next.id || '', next.actor || '', next.terminal || ''].join(':');
    if (key !== sceneKey) {
      transitionAt = now() / 1000;
      transitionFrom = { x: baton.x, y: baton.y };
      sceneKey = key;
    }
    scene = { actor: next.actor || null, terminal: next.terminal || null, auto: !!next.auto, steps: Array.isArray(next.steps) ? next.steps : [] };
    if (ROLES.includes(scene.actor)) holder = scene.actor;
    else if (scene.actor === 'you') holder = ROLES.includes(next.attentionRole) ? next.attentionRole : 'observer';
    if (scene.terminal === 'done' && previousTerminal !== 'done' && !reducedMotion) celebrate();
    if (scene.terminal === 'failed' && previousTerminal !== 'failed' && !reducedMotion) sparks(GATE_X, 60, 14, RED);
    previousTerminal = scene.terminal;
    if (reducedMotion) {
      for (let i = 0; i < 60; i++) step(i / 10);
      render(0);
    }
  }

  // A short, one-off effect: 'retry' | 'decision' | 'approved' | 'start'
  function pulse(type) {
    if (reducedMotion) return;
    effect = { type, at: now() / 1000 };
    if (type === 'retry') sparks(HOME.builder, SEAT_Y + 6, 10, AMBER);
    if (type === 'decision') for (const role of ROLES) sparks(HOME[role], SEAT_Y + 4, 6, PURPLE);
    if (type === 'approved') sparks(GATE_X, 80, 12, GREEN);
    if (type === 'start') lampsOn = 0;
  }

  // Music playing: the agents wear headphones, nod along, and little notes float up in their colours.
  function setMusic(playing) {
    music = !!playing;
    if (reducedMotion) render(0);
  }

  function sparks(x, y, count, color) {
    for (let i = 0; i < count; i++) {
      const angle = hash(i * 3 + x) * Math.PI * 2;
      const speed = 0.5 + hash(i + y) * 1.1;
      particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 0.2, life: 1, decay: 0.03, color, gravity: 0.03, spark: true });
    }
  }

  function celebrate() {
    for (let i = 0; i < 34; i++) {
      const color = [GREEN, '#f0a63f', PURPLE, '#4db6c9', '#fff6c2'][i % 5];
      particles.push({ x: GATE_X, y: 60, vx: (hash(i) - 0.5) * 3.2, vy: -1.2 - hash(i + 40) * 2.2, life: 1, decay: 0.012, color, gravity: 0.05 });
    }
    // Fireworks in the two windows.
    for (const [cx, cy, color] of [[38, 24, '#fff6c2'], [178, 22, GREEN], [60, 18, '#f0a63f']]) sparks(cx, cy, 12, color);
  }

  function spawn(role, t) {
    if (reducedMotion) return;
    const a = agents[role];
    const c = COLORS[role].glow;
    if (hash(t * 7 + role.length) > 0.8) {
      particles.push({ x: DESK_X[role] + 8 + hash(t) * 16, y: 72, vx: (hash(t + 3) - 0.5) * 0.3, vy: -0.4 - hash(t + 9) * 0.3, life: 1, decay: 0.03, color: c, gravity: 0 });
    }
    if (role === 'reviewer' && hash(t * 3 + 1) > 0.95) {
      particles.push({ x: a.x - 3, y: a.y - 6, vx: 0, vy: -0.28, life: 1, decay: 0.02, color: '#7dd9a8', gravity: 0, check: true });
    }
  }

  function step(t) {
    const away = scene.actor === 'you';
    for (const role of ROLES) {
      const a = agents[role];
      const targetX = role === 'observer' && away ? GATE_X - 21 : HOME[role];
      const targetY = role === 'observer' && away ? WALK_Y : SEAT_Y;
      a.x += Math.max(-1.3, Math.min(1.3, targetX - a.x));
      a.y += Math.max(-1.1, Math.min(1.1, targetY - a.y));
      a.moving = Math.abs(targetX - a.x) > 0.5 || Math.abs(targetY - a.y) > 0.5;
      const targetFocus = ROLES.includes(scene.actor) && scene.actor !== role ? 0.5 : 1;
      focus[role] += (targetFocus - focus[role]) * 0.13;
    }
    lampsOn += (1 - lampsOn) * 0.06;
    // The baton eases to the holder's hand, or rests above the door when the task is finished.
    const h = agents[holder];
    const tx = scene.terminal === 'done' ? GATE_X : h.x + 9;
    const ty = scene.terminal === 'done' ? 44 : h.y + 26;
    const progress = reducedMotion ? 1 : Math.min(1, Math.max(0, (t - transitionAt) / 0.85));
    const eased = 1 - Math.pow(1 - progress, 3);
    const arc = Math.sin(progress * Math.PI) * Math.min(26, Math.abs(tx - transitionFrom.x) * 0.22);
    baton.x = transitionFrom.x + (tx - transitionFrom.x) * eased;
    baton.y = transitionFrom.y + (ty - transitionFrom.y) * eased - arc;
    baton.trail.push([baton.x, baton.y]);
    if (baton.trail.length > 9) baton.trail.shift();
    for (const role of ROLES) if (scene.actor === role) spawn(role, t);
    if (music && !reducedMotion && hash(t * 5 + 1) > 0.93) {
      const role = ROLES[Math.floor(hash(t * 11) * 3)];
      const a = agents[role];
      particles.push({ x: a.x + 4, y: a.y - 4, vx: 0, vy: -0.6 - hash(t + 4) * 0.35, life: 1, decay: 0.015, color: COLORS[role].glow, gravity: 0, note: true, sway: hash(t * 3) * 6.28 });
    }
    // Steam from the mugs, and an alarm's sparks when a task has failed.
    if (!reducedMotion) {
      for (const role of ROLES) if (hash(t * 9 + role.length * 3) > 0.93) particles.push({ x: DESK_X[role] + 48, y: 83, vx: (hash(t + 7) - 0.5) * 0.12, vy: -0.22, life: 1, decay: 0.035, color: '#cdd6e0', gravity: 0, steam: true });
      if (scene.terminal === 'failed' && hash(t * 4 + 2) > 0.9) sparks(DESK_X[ROLES[Math.floor(hash(t) * 3)]] + 14, 78, 3, RED);
    }
    for (const p of particles) {
      p.x += p.vx + (p.note ? Math.sin(p.life * 9 + p.sway) * 0.35 : 0);
      p.y += p.vy;
      p.vy += p.gravity || 0;
      p.life -= p.decay;
    }
    for (let i = particles.length - 1; i >= 0; i--) if (particles[i].life <= 0) particles.splice(i, 1);
  }

  // ---------------------------------------------------------------- scenery

  function drawWindow(x, y, w, h, t, seed) {
    const date = clock();
    const hour = date.getHours() + date.getMinutes() / 60;
    const sky = skyAt(hour);
    rect(x - 2, y - 2, w + 4, h + 4, '#2a3441');
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, sky.top);
    g.addColorStop(1, sky.bottom);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    // Stars (night) twinkle; a moon or sun sits in the corner.
    if (sky.stars > 0.05) {
      for (let i = 0; i < 14; i++) {
        const tw = reducedMotion ? 1 : 0.55 + 0.45 * Math.sin(t * 1.6 + i * 2.3 + seed);
        alpha(sky.stars * tw * 0.9, () => rect(x + 2 + hash(i + seed) * (w - 4), y + 2 + hash(i * 3 + seed) * (h * 0.5), 1, 1, '#e8f0ff'));
      }
    }
    const night = hour < 6.3 || hour > 19.5;
    const cx = x + w - 11, cy = y + 9;
    if (night) {
      rect(cx - 3, cy - 3, 7, 7, '#e8eef8');
      rect(cx - 1, cy - 3, 5, 6, sky.top);
      alpha(0.2, () => rect(cx - 5, cy - 5, 11, 11, '#cfe0ff'));
    } else {
      glow(cx, cy, 10, '#ffe9a8', 0.7, false);
      rect(cx - 2, cy - 2, 5, 5, '#fff2c4');
    }
    // Drifting clouds.
    if (hour > 6 && hour < 20) alpha(0.35, () => { const drift = reducedMotion ? 0 : (t * 1.5 + seed * 10) % (w + 20); rect(x + ((drift + 8) % (w + 12)) - 12, y + 8, 12, 2, '#ffffff'); });
    // The skyline: two layers of buildings with lit windows.
    const base = y + h;
    for (let layer = 0; layer < 2; layer++) {
      const shade = layer === 0 ? mix(sky.bottom, '#0a1019', 0.55) : mix(sky.bottom, '#06090f', 0.8);
      for (let i = 0; i < 9; i++) {
        const bw = 5 + Math.floor(hash(i + seed + layer * 20) * 5);
        const bh = 6 + Math.floor(hash(i * 2 + seed + layer * 7) * (layer === 0 ? 10 : 14));
        const bx = x + i * (w / 9) + layer * 3;
        if (bx + bw > x + w) continue;
        rect(bx, base - bh, bw, bh, shade);
        if (layer === 1) {
          for (let j = 0; j < 4; j++) {
            const lit = hash(i * 9 + j + seed) > 0.55;
            const flick = reducedMotion ? 1 : (hash(Math.floor(t * 0.4) + i * 5 + j) > 0.93 ? 0 : 1);
            if (lit && flick) rect(bx + 1 + (j % 2) * 2, base - bh + 2 + Math.floor(j / 2) * 3, 1, 1, night ? '#ffd98a' : '#9fc4e8');
          }
        }
      }
    }
    // Panes and sill.
    rect(x + Math.floor(w / 2), y, 1, h, '#2a3441');
    rect(x, y + Math.floor(h / 2), w, 1, '#2a3441');
    rect(x - 3, y + h + 2, w + 6, 2, '#3a4655');
    alpha(0.12, () => rect(x, y, w, 5, '#ffffff'));
  }

  function drawWall(t) {
    const wall = ctx.createLinearGradient(0, 0, 0, WALL);
    wall.addColorStop(0, '#0f1620');
    wall.addColorStop(1, '#162030');
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, W, WALL);
    // Panelled lower wall and a crisp baseboard.
    rect(0, 40, W, 14, '#0f1620');
    for (let x = 0; x < W; x += 28) rect(x + 27, 40, 1, 14, '#18222f');
    rect(0, 40, W, 1, '#202c3b');
    rect(0, 54, W, 2, '#26313f');
    rect(0, 0, W, 6, '#0a0f16');
    rect(0, 6, W, 1, '#1c2836');
    drawWindow(12, 11, 52, 29, t, 1);
    drawWindow(152, 11, 52, 29, t, 7);
  }

  function drawClock() {
    const date = clock();
    const cx = 79, cy = 24;
    ring(cx, cy, 9.5, 9.5, '#3a4655', 1, 1.4);
    ctx.save();
    ctx.fillStyle = '#e7ecf3';
    ctx.globalAlpha = ctx.globalAlpha * 0.92;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 8.5, 8.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ring(cx, cy, 8.5, 8.5, '#5c6a7c', 1, 1);
    for (let i = 0; i < 12; i++) rect(cx + Math.round(Math.sin(i * Math.PI / 6) * 7), cy - Math.round(Math.cos(i * Math.PI / 6) * 7), 1, 1, '#667487');
    const minute = date.getMinutes() + date.getSeconds() / 60;
    const hour = (date.getHours() % 12) + minute / 60;
    const hand = (angle, len, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.sin(angle) * len, cy - Math.cos(angle) * len);
      ctx.stroke();
    };
    hand(hour / 12 * Math.PI * 2, 4.5, '#1b2230');
    hand(minute / 60 * Math.PI * 2, 6.8, '#1b2230');
    rect(cx, cy, 1, 1, '#ef6b6b');
  }

  function drawPicture(t) {
    const x = 122, y = 11;
    rect(x - 1, y - 1, 26, 22, '#2a3441');
    rect(x, y, 24, 20, '#0a1019');
    if (music) {
      // The picture on the wall becomes a level meter.
      const tick = reducedMotion ? 0 : Math.floor(t * 8);
      for (let i = 0; i < 6; i++) {
        const level = 2 + Math.floor((reducedMotion ? 0.6 : hash(tick * 5 + i)) * 13);
        rect(x + 2 + i * 3.6, y + 18 - level, 2, level, COLORS[ROLES[i % 3]].glow);
      }
    } else {
      // A little night-city print.
      rect(x + 1, y + 1, 22, 18, '#141f31');
      rect(x + 1, y + 12, 22, 7, '#0e1522');
      for (let i = 0; i < 6; i++) rect(x + 2 + i * 3.6, y + 18 - (3 + (i * 7) % 9), 3, 3 + (i * 7) % 9, '#1c2a40');
      rect(x + 16, y + 4, 4, 4, '#f0c876');
    }
  }

  function drawBoard(t) {
    const x = 222, y = 11, w = 44, h = 29;
    rect(x - 1, y - 1, w + 2, h + 2, '#2a3441');
    rect(x, y, w, h, '#cfd6df');
    alpha(0.45, () => rect(x, y, w, h, '#101826'));
    const done = scene.terminal === 'done';
    const reviewing = scene.actor === 'reviewer';
    const ticks = done ? 3 : reviewing && !reducedMotion ? Math.floor(t * 0.7) % 4 : 0;
    for (let i = 0; i < 3; i++) {
      const row = y + 4 + i * 8;
      rect(x + 4, row, 5, 5, '#8a96a6');
      rect(x + 5, row + 1, 3, 3, '#1a2433');
      if (i < ticks) glyph(GLYPHS.CHECK, x + 4, row + 1, GREEN);
      rect(x + 12, row + 2, 14 + (i * 7) % 11, 1, '#6f7b8c');
      rect(x + 12, row + 4, 8 + (i * 5) % 9, 1, '#4d5868');
    }
    rect(x + 3, y + h - 3, 38, 1, '#7a8696');
  }

  function drawNeon(t) {
    if (!scene.auto) return;
    const y = 8;
    const dip = hash(Math.floor(t * 3)) > 0.93 ? 0.55 : 1; // the odd stutter of a neon tube
    const flicker = reducedMotion ? 1 : (0.92 + 0.08 * Math.sin(t * 7)) * dip;
    glow(GATE_X, y + 4, 22, PURPLE, 0.55 * flicker);
    alpha(flicker, () => {
      ring(GATE_X, y + 4, 11.5, 4.6, PURPLE, 0.9, 1);
      text('AUTO', GATE_X - 8, y + 2, '#e3d8ff');
    });
  }

  function drawFloor(t) {
    const floor = ctx.createLinearGradient(0, WALL, 0, H);
    floor.addColorStop(0, '#0f151d');
    floor.addColorStop(1, '#080b10');
    ctx.fillStyle = floor;
    ctx.fillRect(0, WALL, W, H - WALL);
    for (let y = WALL + 14, row = 0; y < H; y += 14, row++) {
      rect(0, y, W, 1, '#121a24');
      for (let x = (row % 2) * 20; x < W; x += 40) rect(x, y - 14, 1, 14, '#10171f');
    }
    // A rug under each desk, tinted by its agent.
    for (const role of ROLES) {
      const x = DESK_X[role] - 4;
      alpha(0.5, () => rect(x, 112, DESK_W + 8, 28, mix('#0b1017', COLORS[role].dark, 0.28)));
      alpha(0.5, () => rect(x + 2, 114, DESK_W + 4, 24, mix('#0b1017', COLORS[role].dark, 0.12)));
    }
  }

  function drawLamps(t) {
    for (const role of ROLES) {
      const x = DESK_X[role] + 26;
      const active = scene.actor === role;
      const idle = !scene.actor && !scene.terminal;
      const level = (idle ? 0.35 : active ? 1 : 0.6) * lampsOn;
      rect(x - 8, 6, 16, 2, '#1c2836');
      rect(x - 6, 8, 12, 1, mix('#2a3441', COLORS[role].glow, 0.4 * level));
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const cone = ctx.createLinearGradient(0, 9, 0, 118);
      cone.addColorStop(0, mix('#000000', COLORS[role].glow, 0.34 * level));
      cone.addColorStop(1, 'transparent');
      ctx.fillStyle = cone;
      ctx.beginPath();
      ctx.moveTo(x - 6, 9);
      ctx.lineTo(x + 6, 9);
      ctx.lineTo(x + 34, 118);
      ctx.lineTo(x - 34, 118);
      ctx.closePath();
      ctx.globalAlpha = ctx.globalAlpha * (active && !reducedMotion ? 0.55 + 0.1 * Math.sin(t * 2) : 0.4);
      ctx.fill();
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------- the door

  function drawGate(t, front) {
    const x = GATE_X;
    const you = scene.actor === 'you';
    if (!front) {
      // The door itself, set into the wall.
      rect(x - 14, 68, 28, 3, '#303b4a');
      rect(x - 14, 71, 3, 46, '#26303d');
      rect(x + 11, 71, 3, 46, '#26303d');
      rect(x - 11, 71, 22, 45, you ? '#241c10' : '#0d121a');
      rect(x, 71, 1, 45, '#18222d');
      rect(x + 4, 92, 2, 5, you ? AMBER : '#33404f');
      rect(x - 11, 71, 22, 2, '#151d28');
      if (you || scene.terminal === 'done') glow(x, 116, 26, you ? AMBER : GREEN, you && !reducedMotion ? 0.18 + 0.08 * Math.sin(t * 5) : 0.18);
      return;
    }
    // Status lights across the lintel: the run's steps.
    const steps = scene.steps;
    for (let i = 0; i < Math.min(7, steps.length); i++) {
      const state = steps[i] && steps[i].state;
      const color = state === 'done' ? GREEN : state === 'current' ? (activeRole() ? COLORS[activeRole()].glow : you ? AMBER : GREEN) : '#2a3441';
      const beat = state === 'current' && !reducedMotion ? 0.7 + 0.3 * Math.sin(t * 6) : 1;
      alpha(beat, () => rect(x - 11 + i * 3.4, 69, 2, 1, color));
    }
    // Lamp above the door.
    const beat = reducedMotion ? 1 : 0.55 + 0.45 * Math.sin(t * 5);
    let lamp = '#303a47';
    if (you) { lamp = AMBER; glow(x, 64, 20, AMBER, beat * 0.55); }
    else if (scene.terminal === 'done') { lamp = GREEN; glow(x, 64, 20, GREEN, 0.5); }
    else if (scene.terminal === 'failed') { lamp = RED; glow(x, 64, 20, RED, 0.5); }
    else if (scene.actor === 'relay') lamp = beat > 0.8 ? AMBER : '#4a4030';
    if (you || scene.terminal || scene.actor === 'relay') { rect(x - 3, 62, 6, 5, lamp); rect(x - 2, 62, 2, 1, '#ffffff'); }
    // Rings that call you over.
    if (you && !reducedMotion) {
      for (let i = 0; i < 2; i++) {
        const p = ((t * 0.6) + i * 0.5) % 1;
        ring(x, 64, 4 + p * 26, 2 + p * 8, AMBER, (1 - p) * 0.55);
      }
    }
  }

  function drawSign(t) {
    const color = stateColor();
    if (!color && scene.actor !== 'relay') return;
    const c = color || AMBER;
    const lift = reducedMotion ? 0 : Math.round(Math.sin(t * 2) * 1.2);
    const x = GATE_X, y = 20 + lift;
    glow(x, y + 8, 22, c, 0.35);
    rect(x - 13, y - 2, 27, 25, '#101822');
    rect(x - 13, y - 2, 27, 1, c);
    rect(x - 13, y + 22, 27, 1, c);
    rect(x - 13, y - 2, 1, 25, mix('#101822', c, 0.5));
    rect(x + 13, y - 2, 1, 25, mix('#101822', c, 0.5));
    if (!reducedMotion) for (let sy = 0; sy < 23; sy += 3) alpha(0.07, () => rect(x - 12, y - 1 + ((sy + Math.floor(t * 8)) % 23), 25, 1, '#ffffff'));
    if (scene.terminal === 'done') glyph(GLYPHS.CHECK, x - 8, y + 4, c, 4);
    else if (scene.terminal === 'failed') {
      for (let i = 0; i < 12; i++) { rect(x - 6 + i, y + 5 + i, 2, 2, c); rect(x + 5 - i, y + 5 + i, 2, 2, c); }
    } else if (scene.actor === 'you') {
      glyph(GLYPHS.Q, x - 6, y + 3, c, 4);
    } else {
      rect(x - 1, y + 5, 3, 8, c);
      rect(x - 1, y + 15, 3, 3, c);
    }
  }

  // ---------------------------------------------------------------- desks and monitors

  function drawMonitor(role, t) {
    const x = DESK_X[role] + 5;
    const y = 66;
    const c = COLORS[role].glow;
    const working = scene.actor === role;
    const done = scene.terminal === 'done';
    const failed = scene.terminal === 'failed';
    rect(x - 1, y - 1, 28, 22, '#2b3340');
    rect(x, y, 26, 20, working ? '#070b11' : '#0a0e14');
    rect(x + 10, y + 20, 6, 4, '#2b3340');
    rect(x + 6, y + 23, 14, 1, '#38424f');
    const tick = reducedMotion ? 0 : Math.floor(t * 5);
    if (done) {
      glyph(GLYPHS.CHECK, x + 9, y + 6, GREEN, 2);
    } else if (failed) {
      for (let i = 0; i < 7; i++) { rect(x + 9 + i, y + 5 + i, 2, 2, RED); rect(x + 15 - i, y + 5 + i, 2, 2, RED); }
      if (!reducedMotion && hash(tick) > 0.6) rect(x + 1, y + 3 + Math.floor(hash(tick * 3) * 14), 24, 1, 'rgba(239,107,107,0.45)');
    } else if (scene.actor === 'you' && role === 'observer') {
      glyph(GLYPHS.Q, x + 9, y + 5, AMBER, 3);
    } else if (working) {
      alpha(0.2, () => rect(x - 6, y + 22, 38, 8, c));
      if (role === 'observer') {
        for (let row = 0; row < 6; row++) rect(x + 2, y + 2 + row * 3, 3 + Math.floor(hash(tick + row * 3) * 17), 1, c);
        const scan = reducedMotion ? 6 : Math.floor((t * 9) % 18);
        alpha(0.35, () => rect(x + 1, y + 1 + scan, 24, 2, '#ffffff'));
      } else if (role === 'builder') {
        const tokens = ['#f0a63f', '#e8eef5', '#7cc4ff', '#9ee37d'];
        for (let row = 0; row < 5; row++) {
          let cx = x + 2 + (row % 3) * 2;
          for (let k = 0; k < 3; k++) {
            const wdt = 2 + Math.floor(hash(tick * 0.5 + row * 7 + k * 13) * 6);
            if (cx + wdt > x + 24) break;
            rect(cx, y + 2 + row * 3, wdt, 1, tokens[(row + k) % 4]);
            cx += wdt + 1;
          }
        }
        if (!reducedMotion && Math.floor(t * 2.5) % 2 === 0) rect(x + 20, y + 14, 2, 2, '#ffffff');
        const fill = reducedMotion ? 12 : Math.floor(((t * 0.35) % 1) * 22);
        rect(x + 2, y + 17, 22, 1, '#1d2633');
        rect(x + 2, y + 17, fill, 1, c);
      } else {
        for (let row = 0; row < 4; row++) {
          const add = row % 2 === 0;
          rect(x + 2, y + 2 + row * 4, 2, 1, add ? '#9ee37d' : '#ef8b8b');
          rect(x + 5, y + 2 + row * 4, 4 + Math.floor(hash(tick * 0.4 + row * 5) * 12), 2, add ? 'rgba(158,227,125,0.55)' : 'rgba(239,139,139,0.55)');
        }
        const ticks = reducedMotion ? 2 : Math.floor(t * 0.7) % 4;
        for (let row = 0; row < ticks; row++) glyph(GLYPHS.CHECK, x + 20, y + 2 + row * 4, '#7dd9a8');
      }
    } else {
      rect(x + 10, y + 9, 6, 1, '#1f2833');
      alpha(0.08, () => rect(x + 1, y + 1, 10, 18, '#ffffff'));
    }
    alpha(0.07, () => rect(x, y, 26, 4, '#ffffff'));
  }

  function drawDesk(role) {
    const x = DESK_X[role];
    rect(x, DESK_TOP, DESK_W, 5, '#5a4636');
    rect(x, DESK_TOP, DESK_W, 1, '#7a6048');
    rect(x + 1, DESK_TOP + 5, DESK_W - 2, 15, '#2e241b');
    rect(x + 3, DESK_TOP + 8, 22, 10, '#271e16');
    rect(x + 13, DESK_TOP + 12, 3, 1, '#4a3b2e');
    rect(x + 28, DESK_TOP + 8, 20, 10, '#271e16');
    rect(x + 36, DESK_TOP + 12, 3, 1, '#4a3b2e');
    rect(x + 2, DESK_TOP + 20, 4, 7, '#241b14');
    rect(x + DESK_W - 6, DESK_TOP + 20, 4, 7, '#241b14');
    alpha(0.4, () => rect(x - 2, DESK_TOP + 27, DESK_W + 4, 2, '#000000'));
    if (scene.actor === role) rect(x, DESK_TOP + 5, DESK_W, 1, COLORS[role].glow);
    if (scene.terminal === 'failed') rect(x + 3, DESK_TOP - 2, 22, 1, RED);
    // Things on the desk: keyboard, mug, and one prop for each role.
    rect(x + 30, DESK_TOP - 2, 16, 2, '#2b3340');
    rect(x + 31, DESK_TOP - 2, 14, 1, '#3a4554');
    rect(x + 47, DESK_TOP - 8, 4, 6, '#d8dde5');
    rect(x + 48, DESK_TOP - 7, 2, 1, '#6b4a2f');
    rect(x + 51, DESK_TOP - 6, 1, 3, '#d8dde5');
    if (role === 'observer') {
      rect(x + 2, DESK_TOP - 3, 9, 3, '#d9d2bf');
      rect(x + 3, DESK_TOP - 4, 8, 1, '#efe7d2');
    } else if (role === 'builder') {
      rect(x + 31, DESK_TOP - 6, 7, 4, '#d3822a');
      rect(x + 31, DESK_TOP - 7, 3, 1, '#a8631a');
    } else {
      rect(x + 2, DESK_TOP - 4, 8, 4, '#8b6b3e');
      rect(x + 4, DESK_TOP - 5, 4, 1, '#c9a24f');
    }
  }

  // ---------------------------------------------------------------- the agents

  function drawAgent(role, t) {
    const a = agents[role];
    const c = COLORS[role];
    const x = Math.round(a.x);
    const y = Math.round(a.y);
    const working = scene.actor === role;
    const phase = ROLES.indexOf(role) * 1.3;
    let bob = 0;
    if (!reducedMotion) {
      if (working) bob = Math.round(Math.sin(t * 9) * 0.7 + 0.4);
      else if (music) bob = Math.round(Math.sin(t * 6.5 + phase) * 0.7 + 0.7);
      else bob = Math.sin(t * 1.4 + phase) > 0.6 ? 1 : 0;
      if (scene.terminal === 'done') {
        const age = t - transitionAt - ROLES.indexOf(role) * 0.12;
        if (age > 0 && age < 0.7) bob -= Math.round(Math.sin(age / 0.7 * Math.PI) * 5);
      }
      if (scene.terminal === 'failed') bob = 2;
    }
    if (working && !reducedMotion) glow(x, y + 16, 22, c.glow, 0.18);
    const blink = !reducedMotion && Math.floor(t * 2.2) % 9 === 0;
    // legs (only visible when walking in front of the desks)
    if (a.moving || a.y > SEAT_Y + 3) {
      const swing = Math.floor(t * 8) % 2;
      rect(x - 4, y + 28 + bob, 4, 8 - swing, '#1b2230');
      rect(x, y + 28 + bob, 4, 7 + swing, '#1b2230');
      rect(x - 5, y + 35 + bob - swing, 5, 2, '#10151d');
      rect(x, y + 34 + bob + swing, 5, 2, '#10151d');
    }
    // body
    rect(x - 5, y + 9 + bob, 10, 19, c.body);
    rect(x - 5, y + 9 + bob, 1, 19, c.dark);
    rect(x - 5, y + 9 + bob, 10, 1, 'rgba(255,255,255,0.18)');
    if (role === 'observer') { rect(x - 1, y + 9 + bob, 2, 19, '#e8eef2'); rect(x - 5, y + 9 + bob, 3, 2, '#e8eef2'); rect(x + 2, y + 9 + bob, 3, 2, '#e8eef2'); }
    if (role === 'builder') { rect(x - 5, y + 17 + bob, 10, 2, '#f5c542'); rect(x - 5, y + 22 + bob, 10, 1, '#f5c542'); }
    if (role === 'reviewer') { rect(x - 1, y + 10 + bob, 2, 8, '#c9bfff'); rect(x - 5, y + 24 + bob, 10, 1, c.dark); }
    // head
    rect(x - 4, y + bob, 8, 9, SKIN);
    rect(x - 4, y + 8 + bob, 8, 1, SKIN_DARK);
    rect(x - 4, y + bob, 8, 3, c.hair);
    if (role === 'reviewer') rect(x + 3, y + 2 + bob, 1, 5, c.hair);
    if (role === 'builder') {
      rect(x - 5, y - 2 + bob, 10, 4, '#f5c542');
      rect(x - 3, y - 4 + bob, 6, 2, '#f5c542');
      rect(x - 6, y + 1 + bob, 12, 1, '#d9a92c');
      rect(x - 3, y - 4 + bob, 6, 1, '#ffe08a');
    }
    if (!blink) {
      rect(x - 2, y + 5 + bob, 1, 2, '#1a1a22');
      rect(x + 1, y + 5 + bob, 1, 2, '#1a1a22');
    } else {
      rect(x - 2, y + 6 + bob, 1, 1, '#1a1a22');
      rect(x + 1, y + 6 + bob, 1, 1, '#1a1a22');
    }
    rect(x - 1, y + 8 + bob, 2, 1, '#b98462');
    if (scene.terminal === 'done') rect(x - 2, y + 8 + bob, 4, 1, '#b95f57');
    if (role === 'observer') {
      rect(x - 4, y + 4 + bob, 4, 4, 'rgba(191,231,239,0.35)');
      rect(x, y + 4 + bob, 4, 4, 'rgba(191,231,239,0.35)');
      rect(x - 4, y + 4 + bob, 4, 1, '#cfe9ef');
      rect(x, y + 4 + bob, 4, 1, '#cfe9ef');
      rect(x - 1, y + 5 + bob, 2, 1, '#cfe9ef');
    }
    if (music) {
      // Headphones: a band over the head and a glowing cup on each ear.
      if (role !== 'builder') rect(x - 4, y - 1 + bob, 8, 1, '#2b3340');
      rect(x - 5, y + 2 + bob, 1, 6, '#2b3340');
      rect(x + 4, y + 2 + bob, 1, 6, '#2b3340');
      ctx.globalAlpha = reducedMotion ? 0.8 : 0.55 + 0.45 * Math.sin(t * 6.5 + phase);
      rect(x - 6, y + 3 + bob, 1, 3, c.glow);
      rect(x + 5, y + 3 + bob, 1, 3, c.glow);
      ctx.globalAlpha = focus[role];
    }
    // arms: forward while typing, down otherwise
    const typing = working ? Math.floor(t * 8) % 2 : 0;
    const left = working ? y + 18 + bob + typing : y + 14 + bob;
    const right = working ? y + 19 + bob - typing : y + 14 + bob;
    const length = working ? 8 : 12;
    rect(x - 8, left, 3, length, c.body);
    rect(x + 5, right, 3, length, c.body);
    rect(x - 8, left + length, 3, 2, SKIN);
    rect(x + 5, right + length, 3, 2, SKIN);
    if (role === 'reviewer') rect(x + 8, y + 18 + bob, 3, 8, '#e8e0c8');
    // a thought bubble now and then while someone is working
    if (working && !reducedMotion && Math.floor(t * 0.5) % 5 === 0) {
      const dots = Math.floor((t * 4) % 4);
      for (let i = 0; i < dots; i++) rect(x + 7 + i * 3, y - 6 - i, 2, 2, c.glow);
    }
  }

  function drawBaton() {
    if (!scene.actor && !scene.terminal) return;
    for (let i = 0; i < baton.trail.length; i++) {
      ctx.globalAlpha = (i / baton.trail.length) * 0.4;
      rect(baton.trail[i][0], baton.trail[i][1], 3, 8, '#fff6c2');
    }
    ctx.globalAlpha = 1;
    glow(baton.x + 1, baton.y + 4, 11, '#ffe38a', 0.5);
    rect(baton.x, baton.y, 3, 9, '#fff6c2');
    rect(baton.x, baton.y, 3, 2, '#ffd45e');
    rect(baton.x + 1, baton.y + 3, 1, 4, '#ffffff');
  }

  function drawParticles() {
    for (const p of particles) {
      ctx.globalAlpha = clamp(p.life);
      if (p.check) glyph(GLYPHS.CHECK, Math.round(p.x), Math.round(p.y), p.color);
      else if (p.note) glyph(GLYPHS.NOTE, Math.round(p.x), Math.round(p.y), p.color);
      else if (p.spark || p.steam) rect(p.x, p.y, p.steam ? 2 : 1, p.steam ? 2 : 1, p.color);
      else rect(p.x, p.y, 2, 2, p.color);
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- light and mood

  function drawAtmosphere(t) {
    const active = activeRole();
    const color = active ? COLORS[active].glow : stateColor();
    if (!color) return;
    const x = active ? DESK_X[active] + 26 : GATE_X;
    glow(x, 88, 82, color, reducedMotion ? 0.14 : 0.14 + Math.sin(t * 1.7) * 0.03);
    const p = reducedMotion ? 1 : Math.min(1, Math.max(0, (t - transitionAt) / 1.1));
    if (p < 1) ring(x, 112, 6 + p * 52, 3 + p * 16, color, (1 - p) * 0.6);
  }

  function drawMood(t) {
    // Shafts of window light with drifting dust.
    const date = clock();
    const sky = skyAt(date.getHours() + date.getMinutes() / 60);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const wx of [38, 178]) {
      const g = ctx.createLinearGradient(0, 40, 0, 130);
      g.addColorStop(0, mix('#000000', sky.bottom, 0.5));
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.globalAlpha = 0.08;
      ctx.beginPath();
      ctx.moveTo(wx - 18, 40);
      ctx.lineTo(wx + 18, 40);
      ctx.lineTo(wx + 52, 130);
      ctx.lineTo(wx + 8, 130);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    if (!reducedMotion) {
      for (let i = 0; i < 16; i++) {
        const px = (hash(i) * W + Math.sin(t * 0.3 + i) * 6) % W;
        const py = 20 + ((hash(i + 9) * 110 + t * (2 + hash(i + 3) * 3)) % 110);
        alpha(0.18 + 0.16 * Math.sin(t * 2 + i), () => rect(px, py, 1, 1, '#dfe9f5'));
      }
    }
    // Reflections of the lamps on the floor.
    for (const role of ROLES) alpha(0.05, () => rect(DESK_X[role] + 4, 122, DESK_W - 8, 2, COLORS[role].glow));
    if (music) {
      // A slow colour wash over the floor, in the three agents' colours in turn.
      const wash = COLORS[ROLES[Math.floor(t / 1.6) % 3]].glow;
      alpha(reducedMotion ? 0.05 : 0.04 + 0.04 * Math.sin(t * 6.5), () => rect(0, WALL, W, H - WALL, wash));
    }
    if (scene.terminal === 'failed' && !reducedMotion) {
      // A slow alarm beam sweeping from the door lamp.
      const angle = t * 2.4;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = RED;
      ctx.globalAlpha = 0.07 + 0.04 * Math.sin(t * 5);
      ctx.beginPath();
      ctx.moveTo(GATE_X, 64);
      ctx.lineTo(GATE_X + Math.cos(angle - 0.22) * 170, 64 + Math.sin(angle - 0.22) * 90);
      ctx.lineTo(GATE_X + Math.cos(angle + 0.22) * 170, 64 + Math.sin(angle + 0.22) * 90);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    // One-shot effects.
    const age = t - effect.at;
    if (effect.type && age >= 0 && age < 1.6) {
      const k = age / 1.6;
      if (effect.type === 'retry') {
        const bx = HOME.builder, by = SEAT_Y - 10;
        ctx.save();
        ctx.strokeStyle = AMBER;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 1 - k;
        ctx.beginPath();
        ctx.arc(bx, by, 5, age * 9, age * 9 + Math.PI * 1.5);
        ctx.stroke();
        ctx.restore();
      } else if (effect.type === 'decision') {
        ring(GATE_X, 70, 6 + k * 90, 3 + k * 30, PURPLE, (1 - k) * 0.7, 1.4);
        alpha((1 - k) * 0.12, () => rect(0, 0, W, H, PURPLE));
      } else if (effect.type === 'approved') {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const sweepX = -30 + k * (W + 60);
        const g = ctx.createLinearGradient(sweepX - 28, 0, sweepX + 28, 0);
        g.addColorStop(0, 'transparent');
        g.addColorStop(0.5, GREEN);
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.globalAlpha = 0.35 * (1 - k * 0.6);
        ctx.fillRect(0, WALL, W, H - WALL);
        ctx.restore();
      } else if (effect.type === 'start') {
        ring(GATE_X, 100, 4 + k * 70, 2 + k * 20, '#fff6c2', (1 - k) * 0.5);
      }
    }
    // Vignette.
    const v = ctx.createRadialGradient(W / 2, H * 0.55, 60, W / 2, H * 0.55, 200);
    v.addColorStop(0, 'transparent');
    v.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }

  function render(t) {
    drawWall(t);
    drawClock();
    drawPicture(t);
    drawBoard(t);
    drawNeon(t);
    drawFloor(t);
    drawLamps(t);
    drawGate(t, false);
    const seated = role => !agents[role].moving && Math.abs(agents[role].y - SEAT_Y) < 1;
    drawAtmosphere(t);
    for (const role of ROLES) if (seated(role)) {
      ctx.save();
      ctx.globalAlpha = focus[role];
      drawAgent(role, t);
      ctx.restore();
    }
    for (const role of ROLES) {
      drawMonitor(role, t);
      drawDesk(role);
    }
    drawGate(t, true);
    drawSign(t);
    for (const role of ROLES) if (!seated(role)) drawAgent(role, t);
    if (!scene.actor && !scene.terminal && !reducedMotion) {
      const phase = (t * 0.8) % 3;
      if (phase < 2) glyph(GLYPHS.Z, HOME.observer + 6 + Math.round(phase * 3), SEAT_Y - 4 - Math.round(phase * 5), '#566274');
    }
    drawBaton();
    drawParticles();
    drawMood(t);
  }

  function loop(timestamp) {
    timer = requestAnimationFrame(loop);
    if (timestamp - last < 33) return;
    last = timestamp;
    const t = now() / 1000;
    step(t);
    render(t);
  }

  function start() {
    if (reducedMotion) {
      for (let i = 0; i < 60; i++) step(i / 10);
      render(0);
      return;
    }
    if (timer === null) timer = requestAnimationFrame(loop);
  }
  function stop() {
    if (timer !== null) cancelAnimationFrame(timer);
    timer = null;
  }

  return { setScene, setMusic, pulse, start, stop, step, render, agents };
}
