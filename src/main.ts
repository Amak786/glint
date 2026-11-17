import {
  createSystem,
  Hovered,
  InputSystem,
  PokeInteractable,
  RayInteractable,
  SessionMode,
  VisibilityState,
  World,
  type Entity,
} from '@iwsdk/core';
import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OctahedronGeometry,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Quaternion,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
} from 'three';
import { sfx, wakeAudio } from './audio';
import {
  CAMPAIGN,
  campaignLevel,
  dailyLevel,
  dayNumber,
  DX,
  DY,
  hint,
  isOffBoard,
  MIXED,
  starsFor,
  trace,
  type Level,
  type Piece,
} from './puzzle';

// ---------------------------------------------------------------------------
// Tunables. Everything sits inside a two-foot reach of a seated player.
// ---------------------------------------------------------------------------
const BOARD = 0.36; // playable square, metres
const TILT = 0.5; // lectern tilt toward the player, radians
const BEAM_Y = 0.026;
const COLORS = [0xffb648, 0x4fd6ff, 0xffffff]; // gold, blue, mixed
const BEAM_SPEED = 2.2; // metres per second the light front travels
const TABLE_TILT = 0.12; // a gentle lean when the board rests on a real table

const TIPS: Record<number, string> = {
  0: 'Touch the mirror to turn it',
  1: 'Bounce the light into the crystal',
  2: 'Light every crystal at once',
  4: 'Glass splits a beam in two',
  6: 'Gold lights diamonds, blue lights cubes',
  9: 'Dark-framed mirrors are fixed',
  5: 'Send light off the far edge to the crystal',
  10: 'White crystals need both colours',
};

// ---------------------------------------------------------------------------
// Save data (progress survives between sessions).
// ---------------------------------------------------------------------------
interface Save {
  stars: number[];
  dailyDay: number;
  dailyStreak: number;
  dailyStars: number;
}

function loadSave(): Save {
  const empty: Save = { stars: [], dailyDay: -1, dailyStreak: 0, dailyStars: 0 };
  try {
    const raw = localStorage.getItem('glint-save-v1');
    if (raw) return { ...empty, ...JSON.parse(raw) };
  } catch {
    // Private mode or blocked storage: play without saving.
  }
  return empty;
}

function storeSave(save: Save) {
  try {
    localStorage.setItem('glint-save-v1', JSON.stringify(save));
  } catch {
    // Ignore: progress simply will not persist.
  }
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------
class TextPanel {
  readonly mesh: Mesh;
  private canvas = document.createElement('canvas');
  private texture: CanvasTexture;
  private last = '';

  constructor(width: number, height: number, private px = 1024) {
    this.canvas.width = px;
    this.canvas.height = Math.round((px * height) / width);
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.mesh = new Mesh(
      new PlaneGeometry(width, height),
      new MeshBasicMaterial({ map: this.texture, transparent: true }),
    );
  }

  /** Each line is [text, size as a fraction of panel height, colour]. */
  set(lines: [string, number, string][]) {
    const key = JSON.stringify(lines);
    if (key === this.last) return;
    this.last = key;
    const g = this.canvas.getContext('2d')!;
    const { width: w, height: h } = this.canvas;
    g.clearRect(0, 0, w, h);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const total = lines.reduce((sum, l) => sum + l[1] * 1.25, 0);
    let y = (h * (1 - total)) / 2;
    for (const [text, size, color] of lines) {
      const fontPx = h * size;
      g.font = `600 ${fontPx}px system-ui, "Segoe UI", Roboto, sans-serif`;
      g.fillStyle = color;
      y += fontPx * 0.625;
      g.fillText(text, w / 2, y, w * 0.96);
      y += fontPx * 0.625;
    }
    this.texture.needsUpdate = true;
  }
}

function glow(color: number, intensity = 1) {
  return new MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.4,
    metalness: 0.1,
  });
}

interface PieceView {
  piece: Piece;
  entity?: Entity;
  root: Object3D;
  visual: Object3D;
  rot: number;
  rotTarget: number;
  lit: number;
  wasLit: boolean;
  lastTap: number;
  material?: MeshStandardMaterial;
}

interface Button {
  entity: Entity;
  mesh: Mesh;
  material: MeshStandardMaterial;
  press: number;
  pulse: boolean;
  enabled: boolean;
  onPress: () => void;
  lastTap: number;
}

// ---------------------------------------------------------------------------
// The player's real room, from WebXR plane detection (mixed reality only).
// ---------------------------------------------------------------------------
interface RoomPlane {
  vertical: boolean;
  label: string;
  toWorld: Matrix4;
  toLocal: Matrix4;
  poly: [number, number][];
}

function insidePoly(x: number, z: number, poly: [number, number][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

class Room {
  planes: RoomPlane[] = [];
  private lastSample = -1;

  constructor(private readonly world: World) {
    world.onXRFrame((frame, _dt, time) => {
      if (time - this.lastSample < 0.25) return;
      this.lastSample = time;
      this.sample(frame);
    });
  }

  clear() {
    this.planes = [];
  }

  private sample(frame: XRFrame) {
    const detected = (frame as XRFrame & { detectedPlanes?: Set<XRPlane> }).detectedPlanes;
    const space = this.world.xrReferenceSpace;
    if (!detected || !space) return;
    this.world.player.updateMatrixWorld();
    const rig = this.world.player.matrixWorld;
    const planes: RoomPlane[] = [];
    detected.forEach((plane) => {
      const pose = frame.getPose(plane.planeSpace, space);
      if (!pose) return;
      const toWorld = rig.clone().multiply(new Matrix4().fromArray(pose.transform.matrix));
      planes.push({
        vertical: plane.orientation === 'vertical',
        label: ((plane as XRPlane & { semanticLabel?: string }).semanticLabel ?? '').toLowerCase(),
        toWorld,
        toLocal: toWorld.clone().invert(),
        poly: plane.polygon.map((pt) => [pt.x, pt.z] as [number, number]),
      });
    });
    this.planes = planes;
  }

  /** A spot on a real table or desk in front of the player, if there is one. */
  findTable(head: Vector3, fwd: Vector3): Vector3 | undefined {
    const reaches = [0.45, 0.4, 0.5, 0.35, 0.55, 0.6, 0.3, 0.65, 0.7];
    let best: { point: Vector3; score: number } | undefined;
    for (const plane of this.planes) {
      if (plane.vertical || plane.label === 'floor' || plane.label === 'ceiling') continue;
      const height = plane.toWorld.elements[13];
      if (height < 0.35 || head.y - height < 0.15 || head.y - height > 0.95) continue;
      for (let i = 0; i < reaches.length; i++) {
        const point = head.clone().addScaledVector(fwd, reaches[i]);
        point.y = height;
        const local = point.clone().applyMatrix4(plane.toLocal);
        if (!insidePoly(local.x, local.z, plane.poly)) continue;
        const score = i + (plane.label === 'table' || plane.label === 'desk' ? 0 : 3);
        if (!best || score < best.score) best = { point, score };
        break;
      }
    }
    return best?.point;
  }

  /** The nearest real wall along a ray, with its normal turned toward the ray's origin. */
  castWall(origin: Vector3, dir: Vector3, max = 4.5) {
    let best: { point: Vector3; normal: Vector3; dist: number } | undefined;
    for (const plane of this.planes) {
      if (!plane.vertical) continue;
      const o = origin.clone().applyMatrix4(plane.toLocal);
      const d = dir.clone().transformDirection(plane.toLocal);
      if (Math.abs(d.y) < 1e-4) continue;
      const t = -o.y / d.y;
      if (t < 0.2 || t > max || (best && t > best.dist)) continue;
      const hit = o.addScaledVector(d, t);
      if (!insidePoly(hit.x, hit.z, plane.poly)) continue;
      const normal = new Vector3(0, 1, 0).transformDirection(plane.toWorld);
      if (normal.dot(dir) > 0) normal.negate();
      best = { point: origin.clone().addScaledVector(dir, t), normal, dist: t };
    }
    return best;
  }
}

// ---------------------------------------------------------------------------
// The game.
// ---------------------------------------------------------------------------
class Game {
  readonly board = new Group();
  private boardEntity: Entity;
  private levelGroup = new Group();
  private beamGroup = new Group();
  private views: PieceView[] = [];
  private buttons: Record<string, Button> = {};
  private label = new TextPanel(BOARD + 0.06, 0.1);
  private hintRing: Mesh;
  private pips: MeshStandardMaterial[] = [];
  /** Small glowing beads on both index fingertips, so the touch point is obvious. */
  private tips: Mesh[] = [];
  private sparks: Points;
  private sparkVel: Float32Array;
  private sparkLife = 0;

  level!: Level;
  mode: 'campaign' | 'daily' = 'campaign';
  index = 0;
  taps = 0;
  solved = false;
  private solvedAt = 0;
  private hintUsed = false;
  private hintTarget?: Piece;
  private now = 0;
  private beamBorn = 0;
  private placed = false;
  /** True once the board rests on a real table in mixed reality. */
  private onTable = false;
  private lastTableTry = -1;
  /** True while the player's real room is visible behind the game. */
  passthrough = false;
  /** Whether the room crystal currently sits on a real wall. */
  private onWall = false;
  private notice?: string;
  private noticeUntil = 0;
  private roomView?: PieceView;
  private port = new Vector3();
  save = loadSave();

  constructor(private world: World, private room: Room) {
    this.board.rotation.order = 'YXZ';
    this.restPose();
    this.boardEntity = world.createTransformEntity(this.board);

    // Slab the puzzle sits on.
    const slab = new Mesh(
      new BoxGeometry(BOARD + 0.07, 0.014, BOARD + 0.19),
      new MeshStandardMaterial({ color: 0x0c1226, roughness: 0.5, metalness: 0.2 }),
    );
    slab.position.set(0, -0.008, 0.02);
    this.board.add(slab);
    const rim = new Mesh(
      new BoxGeometry(BOARD + 0.012, 0.004, BOARD + 0.012),
      glow(0x2b3f8f, 0.9),
    );
    rim.position.y = -0.0015;
    this.board.add(rim);
    this.board.add(this.levelGroup, this.beamGroup);

    // Status panel stands along the far edge, facing the player.
    // Raised so light leaving the far edge passes underneath it.
    this.label.mesh.position.set(0, 0.125, -BOARD / 2 - 0.035);
    this.label.mesh.rotation.x = -0.25;
    this.board.add(this.label.mesh);

    this.hintRing = new Mesh(
      new TorusGeometry(1, 0.07, 8, 40),
      new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }),
    );
    this.hintRing.rotation.x = Math.PI / 2;
    this.hintRing.visible = false;
    this.board.add(this.hintRing);

    // Celebration sparks.
    const count = 140;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3));
    this.sparkVel = new Float32Array(count * 3);
    this.sparks = new Points(
      geo,
      new PointsMaterial({
        color: 0xfff2c8,
        size: 0.006,
        map: dotTexture(),
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.sparks.visible = false;
    this.sparks.frustumCulled = false;
    this.board.add(this.sparks);

    // Progress map: one pip per level, so growth between sessions is visible at a glance.
    const pitch = BOARD / CAMPAIGN.length;
    for (let i = 0; i < CAMPAIGN.length; i++) {
      const material = new MeshStandardMaterial({ color: 0x1b2550, emissive: 0x000000, roughness: 0.5 });
      const pip = new Mesh(new BoxGeometry(pitch * 0.7, 0.004, 0.012), material);
      pip.position.set((i - (CAMPAIGN.length - 1) / 2) * pitch, 0.002, -BOARD / 2 - 0.016);
      this.board.add(pip);
      this.pips.push(material);
    }

    for (const side of ['left', 'right'] as const) {
      const bead = new Mesh(
        new SphereGeometry(0.0045, 12, 8),
        new MeshBasicMaterial({ color: 0xfff2c8, transparent: true, opacity: 0.85 }),
      );
      bead.visible = false;
      world.player.indexTipSpaces[side].add(bead);
      this.tips.push(bead);
    }

    this.buildButtons();

    // Resume where the player left off.
    const firstOpen = CAMPAIGN.findIndex((_, i) => !this.save.stars[i]);
    this.loadCampaign(firstOpen === -1 ? CAMPAIGN.length - 1 : firstOpen);
  }

  // ---- layout -------------------------------------------------------------

  /** Where the board sits on a flat screen, before any headset pose exists. */
  private restPose() {
    this.board.position.set(0, 0.86, -0.46);
    this.board.rotation.set(TILT, 0, 0);
  }

  /** Bring the board to the seated player: in front of the chest, turned to face them. */
  recenter() {
    const head = this.world.player.head;
    const pos = head.getWorldPosition(new Vector3());
    if (pos.y < 0.3) return false; // no head pose yet
    const fwd = head.getWorldDirection(new Vector3()).negate(); // camera looks down -Z
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
    fwd.normalize();
    this.onTable = false;
    if (this.passthrough && this.placeOnTable(pos, fwd)) return true;
    this.board.position.copy(pos).addScaledVector(fwd, 0.46);
    this.board.position.y = pos.y - 0.37;
    this.board.rotation.set(TILT, Math.atan2(-fwd.x, -fwd.z), 0);
    return true;
  }

  /** Rest the board on a real table in front of the player, if the headset found one. */
  private placeOnTable(head: Vector3, fwd: Vector3) {
    const spot = this.room.findTable(head, fwd);
    if (!spot) return false;
    // Lift so the near edge clears the tabletop despite the lean.
    this.board.position.copy(spot);
    this.board.position.y += 0.016 + 0.3 * Math.sin(TABLE_TILT);
    this.board.rotation.set(TABLE_TILT, Math.atan2(-fwd.x, -fwd.z), 0);
    this.onTable = true;
    this.say('Placed on your table');
    return true;
  }

  private say(text: string, seconds = 3) {
    this.notice = text;
    this.noticeUntil = this.now + seconds;
    if (this.level) this.updateLabel();
  }

  private cell() {
    return BOARD / this.level.size;
  }

  private cellPos(x: number, y: number, out = new Vector3()) {
    const c = this.cell();
    const half = (this.level.size - 1) / 2;
    return out.set((x - half) * c, 0, -(y - half) * c);
  }

  // ---- buttons ------------------------------------------------------------

  private buildButtons() {
    const defs: [string, string, () => void][] = [
      ['prev', '‹', () => this.step(-1)],
      ['reset', 'Reset', () => this.reset()],
      ['hint', 'Hint', () => this.showHint()],
      ['daily', 'Daily', () => this.toggleDaily()],
      ['center', 'Center', () => this.recenter()],
      ['next', '›', () => this.step(1)],
    ];
    const w = (BOARD + 0.04) / defs.length;
    defs.forEach(([id, text, onPress], i) => {
      const material = new MeshStandardMaterial({
        color: 0x1b2550,
        emissive: 0x2a3c9a,
        emissiveIntensity: 0.5,
        roughness: 0.5,
      });
      const mesh = new Mesh(new BoxGeometry(w - 0.008, 0.016, 0.05), material);
      mesh.position.set((i - (defs.length - 1) / 2) * w, 0.008, BOARD / 2 + 0.052);
      const cap = new TextPanel(w - 0.012, 0.044, 256);
      cap.set([[text, text.length === 1 ? 0.95 : 0.5, '#e8eeff']]);
      cap.mesh.rotation.x = -Math.PI / 2;
      cap.mesh.position.y = 0.0085;
      mesh.add(cap.mesh);

      const entity = this.world.createTransformEntity(mesh, this.boardEntity);
      entity.addComponent(RayInteractable);
      entity.addComponent(PokeInteractable);
      const button: Button = {
        entity, mesh, material, press: 0, pulse: false, enabled: true, onPress, lastTap: -1,
      };
      (mesh as Object3D).addEventListener('pointerdown' as never, (() => {
        wakeAudio();
        if (!button.enabled || this.now - button.lastTap < 0.35) return;
        button.lastTap = this.now;
        button.press = 1;
        sfx.button();
        onPress();
      }) as never);
      this.buttons[id] = button;
    });
  }

  // ---- level lifecycle ----------------------------------------------------

  loadCampaign(index: number) {
    this.mode = 'campaign';
    this.index = Math.max(0, Math.min(CAMPAIGN.length - 1, index));
    this.start(campaignLevel(this.index));
  }

  loadDaily() {
    this.mode = 'daily';
    this.start(dailyLevel());
  }

  private toggleDaily() {
    if (this.mode === 'daily') this.loadCampaign(this.index);
    else this.loadDaily();
  }

  private unlocked() {
    let n = 0;
    while (n < CAMPAIGN.length && this.save.stars[n]) n++;
    return Math.min(n, CAMPAIGN.length - 1);
  }

  private step(delta: number) {
    if (this.mode === 'daily') return this.loadCampaign(this.index);
    const next = this.index + delta;
    if (next < 0 || next > this.unlocked()) return;
    this.loadCampaign(next);
  }

  reset() {
    if (this.mode === 'daily') this.loadDaily();
    else this.loadCampaign(this.index);
  }

  private start(level: Level) {
    this.level = level;
    this.taps = 0;
    this.solved = false;
    this.hintUsed = false;
    this.hintTarget = undefined;
    this.sparks.visible = false;
    this.buildLevel();
    this.refresh(true);
    // The very first puzzle points at its one mirror so nobody has to read.
    if (this.mode === 'campaign' && this.index === 0) this.hintTarget = hint(level);
  }

  private clearLevel() {
    for (const v of this.views) {
      if (v.entity) v.entity.dispose();
      v.root.removeFromParent();
    }
    this.views = [];
    for (const child of [...this.levelGroup.children]) {
      child.removeFromParent();
      disposeTree(child);
    }
  }

  private buildLevel() {
    this.clearLevel();
    this.roomView = undefined;
    const n = this.level.size;
    const c = this.cell();

    // Floor tiles, lightly chequered so cells are easy to read.
    const tileGeo = new PlaneGeometry(c * 0.94, c * 0.94);
    const tileA = new MeshStandardMaterial({ color: 0x18214a, roughness: 0.7 });
    const tileB = new MeshStandardMaterial({ color: 0x131b3d, roughness: 0.7 });
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const tile = new Mesh(tileGeo, (x + y) % 2 ? tileA : tileB);
        tile.rotation.x = -Math.PI / 2;
        this.cellPos(x, y, tile.position).y = 0.001;
        this.levelGroup.add(tile);
      }
    }

    for (const piece of this.level.pieces) this.views.push(this.buildPiece(piece, c));
  }

  private buildPiece(piece: Piece, c: number): PieceView {
    const visual = new Group();
    let root: Object3D = visual;
    let material: MeshStandardMaterial | undefined;
    let rot = 0;
    const interactive = piece.kind === 'mirror' || piece.kind === 'splitter';

    if (piece.kind === 'mirror' || piece.kind === 'splitter') {
      const glass = piece.kind === 'splitter';
      material = new MeshStandardMaterial({
        color: glass ? 0x9ff3ff : 0xd5e0ff,
        emissive: glass ? 0x3fb9d6 : 0x5a6cc0,
        emissiveIntensity: 0.7,
        roughness: 0.25,
        metalness: 0.3,
        transparent: glass,
        opacity: glass ? 0.5 : 1,
      });
      const slab = new Mesh(new BoxGeometry(c * 0.86, 0.042, glass ? 0.012 : 0.007), material);
      slab.position.y = 0.024;
      visual.add(slab);
      const frameMat = new MeshStandardMaterial({
        color: piece.locked ? 0x2a1c14 : 0x39457c,
        roughness: 0.6,
      });
      const foot = new Mesh(new CylinderGeometry(c * 0.16, c * 0.2, 0.006, 20), frameMat);
      foot.position.y = 0.003;
      visual.add(foot);
      if (piece.locked) {
        const cap = new Mesh(new BoxGeometry(c * 0.9, 0.006, 0.014), frameMat);
        cap.position.y = 0.047;
        visual.add(cap);
      }
      rot = piece.slash ? Math.PI / 4 : -Math.PI / 4;
      visual.rotation.y = rot;

      // An invisible, generous touch target owns the interaction.
      const hit = new Mesh(
        new BoxGeometry(c * 0.92, 0.055, c * 0.92),
        new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
      );
      hit.position.y = 0.0275;
      visual.position.y = -0.0275;
      hit.add(visual);
      root = hit;
    } else if (piece.kind === 'wall') {
      const block = new Mesh(
        new BoxGeometry(c * 0.8, 0.046, c * 0.8),
        new MeshStandardMaterial({ color: 0x2b3350, roughness: 0.85 }),
      );
      block.position.y = 0.023;
      visual.add(block);
    } else if (piece.kind === 'emitter') {
      const color = COLORS[piece.color];
      const body = new Mesh(
        new CylinderGeometry(c * 0.26, c * 0.3, 0.03, 24),
        new MeshStandardMaterial({ color: 0x20294f, roughness: 0.5 }),
      );
      body.position.y = 0.015;
      visual.add(body);
      const nozzle = new Mesh(new ConeGeometry(c * 0.16, c * 0.3, 16), glow(color, 1.6));
      nozzle.rotation.z = -Math.PI / 2; // tip along +X
      nozzle.position.set(c * 0.12, BEAM_Y, 0);
      visual.add(nozzle);
      visual.add(shapeFor(piece.color, c * 0.12, glow(color, 1.4), 0.046));
      // Grid +Y runs away from the player, which is local -Z.
      visual.rotation.y = Math.atan2(DY[piece.dir], DX[piece.dir]);
    } else {
      const color = COLORS[piece.color];
      material = new MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.12,
        roughness: 0.2,
        metalness: 0.1,
        transparent: true,
        opacity: 0.85,
      });
      const gem = shapeFor(piece.color, c * 0.24, material, 0.034);
      gem.name = 'gem';
      visual.add(gem);
      const halo = new Sprite(
        new SpriteMaterial({
          map: dotTexture(), color, transparent: true, opacity: 0,
          blending: AdditiveBlending, depthWrite: false,
        }),
      );
      halo.name = 'halo';
      halo.position.y = 0.034;
      visual.add(halo);
      const ring = new Mesh(new TorusGeometry(c * 0.32, c * 0.02, 6, 28), glow(color, 0.5));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.003;
      visual.add(ring);
    }

    this.cellPos(piece.x, piece.y, root.position).y += root === visual ? 0 : 0.0275;
    const view: PieceView = {
      piece, root, visual, rot, rotTarget: rot, lit: 0, wasLit: false, lastTap: -1, material,
    };

    if (piece.kind === 'target' && isOffBoard(piece, this.level.size)) {
      // The room crystal: a glowing port on the far edge, and the crystal out in the room.
      const port = new Mesh(new BoxGeometry(c * 0.62, 0.006, 0.01), glow(COLORS[piece.color], 1.2));
      this.cellPos(piece.x, piece.y - 0.5, port.position).y = 0.004;
      port.name = 'port';
      this.levelGroup.add(port);
      this.port.copy(port.position).setY(BEAM_Y);
      this.roomView = view;
      this.placeRoomCrystal(1);
    }

    if (interactive) {
      const entity = this.world.createTransformEntity(root, this.boardEntity);
      entity.addComponent(RayInteractable);
      entity.addComponent(PokeInteractable);
      view.entity = entity;
      root.addEventListener('pointerdown' as never, (() => this.tap(view)) as never);
    } else {
      this.levelGroup.add(root);
    }
    return view;
  }

  /**
   * Put the room crystal where light leaving the port would land: on a real wall in
   * mixed reality, or floating ahead of the board otherwise.
   */
  private placeRoomCrystal(ease: number) {
    const view = this.roomView;
    if (!view) return;
    this.board.updateMatrixWorld();
    const origin = this.board.localToWorld(this.port.clone());
    const dir = new Vector3(0, 0, -1).transformDirection(this.board.matrixWorld);
    const hit = this.passthrough ? this.room.castWall(origin, dir) : undefined;
    const wasOnWall = this.onWall;
    this.onWall = !!hit;
    const world = hit
      ? hit.point.clone().addScaledVector(hit.normal, 0.04)
      : origin.clone().addScaledVector(dir, 0.9);
    const local = this.board.worldToLocal(world);
    view.root.position.lerp(local, ease);
    // Larger with distance so it reads clearly across the room.
    const dist = view.root.position.distanceTo(this.port);
    view.root.scale.setScalar(Math.min(5, Math.max(1.8, dist * 2.4)));
    // Its ring faces back along the beam toward the board.
    const back = this.port.clone().sub(view.root.position).normalize();
    view.root.quaternion.setFromUnitVectors(UP, back);
    if (this.onWall !== wasOnWall) this.updateLabel();
  }

  // ---- play ---------------------------------------------------------------

  private tap(view: PieceView) {
    wakeAudio();
    const piece = view.piece;
    if (piece.kind !== 'mirror' && piece.kind !== 'splitter') return;
    // A poke and a pinch can land on the same frame; count them once.
    if (this.solved || this.now - view.lastTap < 0.3) return;
    view.lastTap = this.now;
    if (piece.locked) {
      sfx.locked();
      view.rot += 0.25; // a little shake that settles back
      return;
    }
    piece.slash = !piece.slash;
    view.rotTarget += Math.PI / 2;
    this.taps++;
    this.hintTarget = undefined;
    sfx.turn(piece.slash);
    this.refresh(false);
  }

  private showHint() {
    if (this.solved) return;
    this.hintUsed = true;
    this.hintTarget = hint(this.level);
  }

  /** Re-trace the light and update everything that depends on it. */
  private refresh(fresh: boolean) {
    const result = trace(this.level);
    this.beamBorn = this.now;

    for (const child of [...this.beamGroup.children]) child.removeFromParent();
    for (const s of result.segments) {
      const a = this.cellPos(s.x0, s.y0);
      const b = this.cellPos(s.x1, s.y1);
      a.y = b.y = BEAM_Y;
      const length = a.distanceTo(b);
      if (length < 1e-5) continue;
      const dir = b.clone().sub(a).normalize();
      const quat = new Quaternion().setFromUnitVectors(UP, dir);
      for (const [geo, mats] of [[CORE_GEO, CORE_MATS], [HALO_GEO, HALO_MATS]] as const) {
        const beam = new Mesh(geo, mats[s.color]);
        beam.quaternion.copy(quat);
        beam.visible = false;
        // The light front sweeps along the path; update() grows each piece in turn.
        beam.userData = { from: a.clone(), dir, length, t0: s.t0 * this.cell() };
        this.beamGroup.add(beam);
      }
      // Light leaving through the port carries on across the room to its crystal.
      const rp = this.roomView?.piece;
      if (rp && s.x1 === rp.x && s.y1 === rp.y - 0.5 && s.x0 === s.x1) {
        const cells = Math.abs(s.y1 - s.y0);
        for (const [geo, mats] of [[CORE_GEO, CORE_MATS], [HALO_GEO, HALO_MATS]] as const) {
          const beam = new Mesh(geo, mats[s.color]);
          beam.visible = false;
          beam.userData = {
            from: this.port.clone(), dir: new Vector3(0, 0, -1), length: 0,
            t0: (s.t0 + cells) * this.cell(), room: true,
          };
          this.beamGroup.add(beam);
        }
      }
    }

    let targetIndex = 0;
    for (const v of this.views) {
      if (v.piece.kind !== 'target') continue;
      const lit = result.lit[targetIndex++];
      if (lit && !v.wasLit && !fresh) sfx.crystal(targetIndex);
      v.wasLit = lit;
    }

    if (result.solved && !this.solved && !fresh) this.win();
    this.updateLabel();
  }

  private win() {
    this.solved = true;
    this.solvedAt = this.now;
    let stars = starsFor(this.taps, this.level.par);
    if (this.hintUsed) stars = Math.min(stars, 2);
    sfx.win(stars);

    if (this.mode === 'campaign') {
      this.save.stars[this.index] = Math.max(this.save.stars[this.index] ?? 0, stars);
    } else {
      const today = dayNumber();
      if (this.save.dailyDay !== today) {
        this.save.dailyStreak = this.save.dailyDay === today - 1 ? this.save.dailyStreak + 1 : 1;
        this.save.dailyDay = today;
        this.save.dailyStars = stars;
      } else {
        this.save.dailyStars = Math.max(this.save.dailyStars, stars);
      }
    }
    storeSave(this.save);
    this.lastStars = stars;
    this.burst();
  }
  private lastStars = 0;

  private burst() {
    const pos = this.sparks.geometry.getAttribute('position') as BufferAttribute;
    const gems = this.views.filter((v) => v.piece.kind === 'target');
    for (let i = 0; i < pos.count; i++) {
      const from = gems[i % gems.length].root.position;
      pos.setXYZ(i, from.x, from.y + 0.04, from.z);
      const a = Math.random() * Math.PI * 2;
      const r = 0.02 + Math.random() * 0.07;
      this.sparkVel[i * 3] = Math.cos(a) * r;
      this.sparkVel[i * 3 + 1] = 0.08 + Math.random() * 0.16;
      this.sparkVel[i * 3 + 2] = Math.sin(a) * r;
    }
    pos.needsUpdate = true;
    this.sparkLife = 1.6;
    this.sparks.visible = true;
  }

  private updateLabel() {
    const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(3 - n);
    const daily = this.mode === 'daily';
    const streakToday = this.save.dailyDay === dayNumber();
    const title = daily
      ? `Daily Glint${this.save.dailyStreak && (streakToday || this.save.dailyDay === dayNumber() - 1) ? `  ·  ${this.save.dailyStreak}-day streak` : ''}`
      : `Level ${this.index + 1} of ${CAMPAIGN.length}`;
    const best = daily ? (streakToday ? this.save.dailyStars : 0) : (this.save.stars[this.index] ?? 0);

    let tip: string;
    let tipColor = '#9fb0e8';
    if (this.solved) {
      tipColor = '#ffe9a8';
      if (daily) tip = `Solved ${stars(this.lastStars)}  New puzzle tomorrow`;
      else if (this.index === CAMPAIGN.length - 1) tip = `All clear ${stars(this.lastStars)}  Try the Daily`;
      else tip = `Solved ${stars(this.lastStars)}`;
    } else if (this.notice && this.now < this.noticeUntil) {
      tip = this.notice;
      tipColor = '#bff0ff';
    } else if (this.roomView && this.taps === 0 && this.onWall) {
      tip = 'Aim the light at the crystal on your wall';
    } else {
      tip =
        (!daily && this.taps === 0 && TIPS[this.index]) ||
        `Taps ${this.taps}  ·  Par ${this.level.par}${best ? `  ·  Best ${stars(best)}` : ''}`;
    }
    this.label.set([
      [title, 0.34, '#ffffff'],
      [tip, 0.3, tipColor],
    ]);

    // Pips: dark = locked, dim = open, gold = solved (brighter with more stars), white = current.
    this.pips.forEach((m, i) => {
      const got = this.save.stars[i] ?? 0;
      const current = !daily && i === this.index;
      m.color.set(current ? 0xffffff : got ? 0xffb648 : i <= this.unlocked() ? 0x39457c : 0x141a33);
      m.emissive.set(current ? 0xffffff : got ? 0xffb648 : 0x000000);
      m.emissiveIntensity = current ? 0.9 : got * 0.3;
    });

    const b = this.buttons;
    const setEnabled = (button: Button, on: boolean) => {
      button.enabled = on;
      button.material.opacity = on ? 1 : 0.35;
      button.material.transparent = !on;
    };
    setEnabled(b.prev, daily || this.index > 0);
    setEnabled(b.next, daily || this.index < this.unlocked());
    setEnabled(b.hint, !this.solved);
    b.next.pulse = this.solved && !daily && this.index < CAMPAIGN.length - 1;
    b.daily.pulse = this.solved && !daily && this.index === CAMPAIGN.length - 1;
  }

  // ---- per-frame ----------------------------------------------------------

  update(dt: number, time: number, inXR: boolean) {
    this.now = time;
    this.tips.forEach((t) => (t.visible = inXR));

    // Seat the board once the headset reports a pose; restore it on exit.
    if (inXR && !this.placed) this.placed = this.recenter();
    if (!inXR && this.placed) {
      this.placed = false;
      this.onTable = false;
      this.room.clear();
      this.restPose();
    }
    // Planes arrive a moment after mixed reality starts: move onto the table once seen.
    if (this.placed && this.passthrough && !this.onTable && time - this.lastTableTry > 0.5) {
      this.lastTableTry = time;
      const head = this.world.player.head.getWorldPosition(new Vector3());
      const fwd = this.world.player.head.getWorldDirection(new Vector3()).negate().setY(0);
      if (fwd.lengthSq() > 1e-4) this.placeOnTable(head, fwd.normalize());
    }
    if (this.notice && time >= this.noticeUntil) {
      this.notice = undefined;
      this.updateLabel();
    }
    this.placeRoomCrystal(Math.min(1, dt * 6));

    const ease = Math.min(1, dt * 14);
    for (const v of this.views) {
      const p = v.piece;
      if (p.kind === 'mirror' || p.kind === 'splitter') {
        v.rot += (v.rotTarget - v.rot) * ease;
        v.visual.rotation.y = v.rot;
        const hovered = !this.solved && !!v.entity?.hasComponent(Hovered);
        const scale = v.visual.scale.x + ((hovered ? 1.1 : 1) - v.visual.scale.x) * ease;
        v.visual.scale.setScalar(scale);
        if (v.material) v.material.emissiveIntensity = hovered ? 1.3 : 0.7;
      } else if (p.kind === 'target') {
        v.lit += ((v.wasLit ? 1 : 0) - v.lit) * Math.min(1, dt * 6);
        const gem = v.visual.getObjectByName('gem')!;
        gem.rotation.y += dt * (0.4 + v.lit * 2.4);
        gem.position.y = 0.034 + Math.sin(time * 2 + p.x) * 0.003 * (0.3 + v.lit);
        gem.scale.setScalar(1 + v.lit * 0.25);
        if (v.material) {
          v.material.emissiveIntensity = 0.12 + v.lit * 2.2;
          v.material.opacity = 0.7 + v.lit * 0.3;
        }
        const halo = v.visual.getObjectByName('halo') as Sprite;
        halo.material.opacity = v.lit * (0.55 + Math.sin(time * 4 + p.y) * 0.12);
        halo.scale.setScalar(this.cell() * (0.9 + v.lit * 0.9));
      }
    }

    // Light sweeps out from each emitter, then shimmers.
    const reach = (time - this.beamBorn) * BEAM_SPEED;
    for (const beam of this.beamGroup.children) {
      const d = beam.userData as {
        from: Vector3; dir: Vector3; length: number; t0: number; room?: boolean;
      };
      if (d.room && this.roomView) {
        // Follow the crystal wherever the room puts it.
        const span = this.roomView.root.position.clone().sub(d.from);
        d.length = span.length();
        d.dir.copy(span.normalize());
        beam.quaternion.setFromUnitVectors(UP, d.dir);
      }
      const grown = Math.max(0, Math.min(d.length, reach - d.t0));
      beam.visible = grown > 1e-4;
      beam.scale.set(1, Math.max(grown, 1e-4), 1);
      beam.position.copy(d.from).addScaledVector(d.dir, grown / 2);
    }
    const shimmer = 0.85 + Math.sin(time * 9) * 0.08;
    for (const m of HALO_MATS) m.opacity = 0.28 * shimmer;

    // Hint ring.
    if (this.hintTarget && !this.solved) {
      const c = this.cell();
      this.hintRing.visible = true;
      this.cellPos(this.hintTarget.x, this.hintTarget.y, this.hintRing.position).y = 0.004;
      this.hintRing.scale.setScalar(c * (0.44 + Math.sin(time * 5) * 0.05));
      (this.hintRing.material as MeshBasicMaterial).opacity = 0.6 + Math.sin(time * 5) * 0.3;
    } else {
      this.hintRing.visible = false;
    }

    // Buttons: press dip, attention pulse.
    for (const b of Object.values(this.buttons)) {
      b.press = Math.max(0, b.press - dt * 5);
      b.mesh.position.y = 0.008 - b.press * 0.005;
      const hovered = b.enabled && b.entity.hasComponent(Hovered);
      const pulse = b.pulse ? 0.9 + Math.sin(time * 6) * 0.6 : 0;
      b.material.emissiveIntensity = (b.enabled ? 0.5 : 0.15) + (hovered ? 0.6 : 0) + pulse;
    }

    // Sparks.
    if (this.sparkLife > 0) {
      this.sparkLife -= dt;
      const pos = this.sparks.geometry.getAttribute('position') as BufferAttribute;
      const arr = pos.array as Float32Array;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i] += this.sparkVel[i] * dt;
        arr[i + 1] += this.sparkVel[i + 1] * dt;
        arr[i + 2] += this.sparkVel[i + 2] * dt;
        this.sparkVel[i + 1] -= 0.25 * dt;
      }
      pos.needsUpdate = true;
      (this.sparks.material as PointsMaterial).opacity = Math.max(0, this.sparkLife / 1.6);
      if (this.sparkLife <= 0) this.sparks.visible = false;
    }

    // Move on by itself so a solved puzzle never needs a button press.
    if (
      this.solved && this.mode === 'campaign' &&
      this.index < CAMPAIGN.length - 1 && time - this.solvedAt > 3.2
    ) {
      this.loadCampaign(this.index + 1);
    }
  }
}

// Shared beam resources.
const UP = new Vector3(0, 1, 0);
const CORE_GEO = new CylinderGeometry(0.0022, 0.0022, 1, 8, 1, true);
const HALO_GEO = new CylinderGeometry(0.008, 0.008, 1, 10, 1, true);
const CORE_MATS = COLORS.map(
  (c) => new MeshBasicMaterial({ color: new Color(c).lerp(new Color(0xffffff), 0.55), transparent: true }),
);
const HALO_MATS = COLORS.map(
  (c) =>
    new MeshBasicMaterial({
      color: c, transparent: true, opacity: 0.28, blending: AdditiveBlending, depthWrite: false,
    }),
);

/** Gold is a diamond, blue a cube, mixed a faceted ball, so colour is never the only cue. */
function shapeFor(color: number, size: number, material: MeshStandardMaterial, y: number) {
  const geo =
    color === 0
      ? new OctahedronGeometry(size)
      : color === MIXED
        ? new IcosahedronGeometry(size * 0.95)
        : new BoxGeometry(size * 1.3, size * 1.3, size * 1.3);
  const mesh = new Mesh(geo, material);
  mesh.position.y = y;
  if (color === 1) mesh.rotation.set(0.6, 0.6, 0);
  return mesh;
}

/** A soft round dot so sparks are not hard squares. */
function dotTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const g = canvas.getContext('2d')!;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new CanvasTexture(canvas);
}

function disposeTree(root: Object3D) {
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mats.forEach((m) => m.dispose());
  });
}

// ---------------------------------------------------------------------------
// A quiet night-sky room: nothing to look at but the puzzle.
// ---------------------------------------------------------------------------
function buildRoom(world: World) {
  const scene = new Group();
  world.scene.add(scene);
  world.scene.background = new Color(0x05070f);

  const skyGeo = new SphereGeometry(60, 32, 16);
  const colors = new Float32Array(skyGeo.attributes.position.count * 3);
  const top = new Color(0x04060d);
  const horizon = new Color(0x182457);
  const tmp = new Color();
  for (let i = 0; i < skyGeo.attributes.position.count; i++) {
    const t = Math.min(1, Math.abs(skyGeo.attributes.position.getY(i)) / 60);
    tmp.copy(horizon).lerp(top, Math.pow(t, 0.55));
    colors.set([tmp.r, tmp.g, tmp.b], i * 3);
  }
  skyGeo.setAttribute('color', new BufferAttribute(colors, 3));
  scene.add(new Mesh(skyGeo, new MeshBasicMaterial({ vertexColors: true, side: BackSide, fog: false })));

  const starCount = 500;
  const starPos = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const v = new Vector3().randomDirection();
    v.y = Math.abs(v.y) * 0.9 + 0.05;
    v.normalize().multiplyScalar(45);
    starPos.set([v.x, v.y, v.z], i * 3);
  }
  const starGeo = new BufferGeometry();
  starGeo.setAttribute('position', new BufferAttribute(starPos, 3));
  scene.add(new Points(starGeo, new PointsMaterial({ color: 0xcfd8ff, size: 0.18, sizeAttenuation: true })));

  const floor = new Mesh(
    new CircleGeometry(6, 48),
    new MeshStandardMaterial({ color: 0x0a0f22, roughness: 0.95 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  world.scene.add(new HemisphereLight(0x8fa4ff, 0x10142a, 1.3));
  const key = new DirectionalLight(0xfff1dd, 1.6);
  key.position.set(0.6, 2.2, 0.8);
  world.scene.add(key);
  return scene;
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------
let game: Game | undefined;
let room: Group | undefined;
let sky: Color | undefined;

class GlintSystem extends createSystem({}) {
  update(delta: number, time: number) {
    const inXR = this.visibilityState.value !== VisibilityState.NonImmersive;
    // In mixed reality the player's own room replaces the night sky.
    const mode = this.world.session?.environmentBlendMode;
    const passthrough = inXR && !!mode && mode !== 'opaque';
    if (room) room.visible = !passthrough;
    if (game) game.passthrough = passthrough;
    this.scene.background = passthrough ? null : (sky ?? null);
    game?.update(Math.min(delta, 0.05), time, inXR);
  }
}

async function boot() {
  const container = document.getElementById('scene') as HTMLDivElement;
  const world = await World.create(container, {
    xr: {
      sessionMode: SessionMode.ImmersiveVR,
      // Hands are the only required input; gaze-and-pinch is used where the device offers it.
      // Plane detection lets the board find your table and the light find your walls.
      features: { handTracking: true, gazeTracking: true, planeDetection: true },
      offer: 'always',
    },
    render: {
      fov: 50,
      near: 0.02,
      camera: { position: [0, 1.52, 0.14], lookAt: [0, 0.85, -0.43] },
    },
    features: { locomotion: false, grabbing: false, spatialUI: false },
  });

  // Keep ray targets live on a flat screen so the mouse can play too.
  const input = world.getSystem(InputSystem);
  if (input) input.config.maintainScenePointers.value = true;

  room = buildRoom(world);
  sky = world.scene.background as Color;
  game = new Game(world, new Room(world));
  world.registerSystem(GlintSystem);
  (window as unknown as { glint: Game }).glint = game;

  const enter = document.getElementById('enter') as HTMLButtonElement;
  const note = document.getElementById('note') as HTMLParagraphElement;
  const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
  const supported = xr ? await xr.isSessionSupported('immersive-vr').catch(() => false) : false;
  if (supported) {
    enter.hidden = false;
    enter.addEventListener('click', () => {
      wakeAudio();
      world.launchXR();
    });
    const mixed = document.getElementById('enter-mr') as HTMLButtonElement;
    if (await xr!.isSessionSupported('immersive-ar').catch(() => false)) {
      mixed.hidden = false;
      mixed.addEventListener('click', () => {
        wakeAudio();
        world.launchXR({ sessionMode: SessionMode.ImmersiveAR });
      });
    }
  } else {
    note.textContent = 'Open this page on a Meta Quest to play with your hands. Mouse and touch work here.';
  }
  container.addEventListener('pointerdown', wakeAudio);
  document.getElementById('loading')?.remove();
}

boot().catch((err) => {
  console.error(err);
  const note = document.getElementById('note');
  if (note) note.textContent = 'Glint could not start: ' + (err?.message ?? err);
});
