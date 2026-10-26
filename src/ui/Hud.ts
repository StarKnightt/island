/**
 * A quiet HUD: the name of the place you walk into, a time-of-day line, a one-time controls hint, and the photo
 * mode badge. Hidden in photo mode, with ?hud=0, or through the harness.
 */
import { SPOTS } from '../world/layout';

const PLACES: { name: string; label: string; r: number }[] = [
  { name: 'beach', label: 'Sunrise Beach', r: 120 },
  { name: 'jungle', label: 'The Jungle', r: 160 },
  { name: 'waterfall', label: 'The Falls', r: 60 },
  { name: 'village', label: 'Fishing Village', r: 110 },
  { name: 'cliffs', label: 'North Cliffs', r: 140 },
  { name: 'lighthouse', label: 'The Lighthouse', r: 45 },
];

export class Hud {
  private root: HTMLDivElement;
  private place: HTMLDivElement;
  private clock: HTMLDivElement;
  private hint: HTMLDivElement;
  private badge: HTMLDivElement;
  private current = '';
  private shown = true;
  private placeT = 0;

  constructor(visible: boolean) {
    const css = document.createElement('style');
    css.textContent = `
      #hud { position: fixed; inset: 0; pointer-events: none; z-index: 20; font: 500 13px/1.4 ui-sans-serif, system-ui, "Segoe UI", sans-serif; color: #f4efe3; text-shadow: 0 1px 6px rgba(0,0,0,0.45); }
      #hud .place { position: absolute; left: 50%; top: 12%; transform: translateX(-50%); font: 400 30px/1 "Island Title", ui-serif, Georgia, serif; letter-spacing: 0.3em; opacity: 0; transition: opacity 1.2s ease; text-transform: uppercase; }
      #hud .clock { position: absolute; right: 26px; bottom: 22px; font-size: 12px; letter-spacing: 0.08em; opacity: 0.75; }
      #hud .hint { position: absolute; left: 26px; bottom: 22px; font-size: 12px; opacity: 0.8; transition: opacity 1.5s ease; max-width: 60ch; }
      #hud .badge { position: absolute; left: 50%; top: 22px; transform: translateX(-50%); font-size: 11px; letter-spacing: 0.25em; opacity: 0; transition: opacity 0.4s; }
    `;
    document.head.appendChild(css);
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.place = document.createElement('div');
    this.place.className = 'place';
    this.clock = document.createElement('div');
    this.clock.className = 'clock';
    this.hint = document.createElement('div');
    this.hint.className = 'hint';
    this.hint.textContent = 'Click to look around · WASD move · Shift sprint · Ctrl walk · Space jump · P photo mode · M mute';
    this.badge = document.createElement('div');
    this.badge.className = 'badge';
    this.badge.textContent = 'PHOTO MODE · WASD/QE fly · Shift fast · [ ] lens · P exit';
    this.root.append(this.place, this.clock, this.hint, this.badge);
    document.body.appendChild(this.root);
    this.show(visible);
    setTimeout(() => (this.hint.style.opacity = '0'), 14000);
  }

  show(v: boolean) {
    this.shown = v;
    this.root.style.display = v ? 'block' : 'none';
  }

  photo(on: boolean) {
    this.badge.style.opacity = on ? '0.85' : '0';
    this.place.style.display = this.clock.style.display = this.hint.style.display = on ? 'none' : 'block';
  }

  update(dt: number, x: number, z: number, hour: number, weather: string) {
    if (!this.shown) return;
    let best = '';
    let bd = 1e9;
    for (const p of PLACES) {
      const s = SPOTS.find((q) => q.name === p.name)!;
      const d = Math.hypot(x - s.player[0], z - s.player[1]);
      if (d < p.r && d < bd) {
        bd = d;
        best = p.label;
      }
    }
    if (best && best !== this.current) {
      this.current = best;
      this.place.textContent = best;
      this.place.style.opacity = '1';
      this.placeT = 4;
    } else if (!best) this.current = '';
    if (this.placeT > 0) {
      this.placeT -= dt;
      if (this.placeT <= 0) this.place.style.opacity = '0';
    }
    const h = Math.floor(hour), m = Math.floor((hour - h) * 60);
    this.clock.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} · ${weather}`;
  }
}
