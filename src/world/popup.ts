// A small info bubble anchored to a place in the 3D world.

import type { World } from './world';

export class Popup {
  private el: HTMLDivElement;
  private body: HTMLDivElement;
  private at: [number, number] | null = null;

  constructor(private readonly world: World) {
    this.el = document.createElement('div');
    this.el.className = 'tf-popup';
    this.el.hidden = true;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tf-popup-close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.remove());
    this.body = document.createElement('div');
    this.body.className = 'tf-popup-content';
    this.el.append(close, this.body);
    document.body.append(this.el);
    const follow = () => {
      this.place();
      requestAnimationFrame(follow);
    };
    requestAnimationFrame(follow);
  }

  setLngLat(p: [number, number] | { lng: number; lat: number }): this {
    this.at = Array.isArray(p) ? p : [p.lng, p.lat];
    return this;
  }

  setDOMContent(node: Node): this {
    this.body.replaceChildren(node);
    return this;
  }

  addTo(): this {
    this.el.hidden = false;
    this.place();
    return this;
  }

  remove(): void {
    this.el.hidden = true;
    this.at = null;
  }

  private place(): void {
    if (this.el.hidden || !this.at) return;
    const p = this.world.project(this.at);
    this.el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, calc(-100% - 12px))`;
  }
}
